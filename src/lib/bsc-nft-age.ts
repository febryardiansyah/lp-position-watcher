import { createPublicClient, http, type Address, type PublicClient } from 'viem';
import { bsc } from 'viem/chains';

import { env } from '../config/env.js';

// Reuse the shared NFT-age disk cache (data/cache/nft-age.json). Keys are
// prefixed with the position-manager address, which also keeps Robinhood
// (Blockscout) and BSC (Transfers API) entries distinct.
import { loadNftAgeCache, saveNftAgeCache } from './storage.js';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const MAX_PAGES = 25; // 25 × 1000 most recent mints (~1-2 weeks of PCS v3 mints)

let archiveClient: PublicClient | null = null;

/**
 * Archive-capable BSC client used for NFT mint-time lookups.
 *
 * Free public BSC RPCs can't serve NFT history at all (publicnode hard-403s
 * eth_getLogs beyond ~8k blocks; bsc-dataseed/1rpc don't support it), and
 * Alchemy's free tier caps eth_getLogs at a 10-block range — so this uses
 * Alchemy's `alchemy_getAssetTransfers` (available on the free tier), which
 * returns NFT mint logs with block timestamps directly.
 */
function getArchiveClient(): PublicClient | null {
  if (!env.BSC_ARCHIVE_RPC_URL) return null;
  if (archiveClient) return archiveClient;
  archiveClient = createPublicClient({
    chain: bsc,
    transport: http(env.BSC_ARCHIVE_RPC_URL, { timeout: 30_000, retryCount: 2, retryDelay: 500 }),
  });
  return archiveClient;
}

const ageDiskCache = loadNftAgeCache();
let ageCacheDirty = false;

// npmAddress (lowercase) -> tokenId -> ISO timestamp, built once per run
const mintIndex = new Map<string, Map<string, string>>();
const inflightIndex = new Map<string, Promise<void>>();
const unsupported = new Set<string>(); // endpoints without alchemy_getAssetTransfers

async function ensureMintIndex(client: PublicClient, positionManager: Address): Promise<void> {
  const key = positionManager.toLowerCase();
  const existing = inflightIndex.get(key);
  if (existing) return existing;
  if (mintIndex.has(key) || unsupported.has(key)) return;

  const promise = (async () => {
    const index = new Map<string, string>();
    try {
      let pageKey: string | null = null;
      for (let page = 0; page < MAX_PAGES; page++) {
        const params: Record<string, unknown> = {
          fromBlock: '0x0',
          toBlock: 'latest',
          fromAddress: ZERO_ADDRESS, // mints only
          contractAddresses: [positionManager],
          category: ['erc721'],
          order: 'desc',
          withMetadata: true,
          maxCount: '0x3e8', // 1000
        };
        if (pageKey) params.pageKey = pageKey;

        const res = (await client.request({
          method: 'alchemy_getAssetTransfers' as never, // custom Alchemy method not in viem's typings
          params: [params],
        })) as { transfers?: Array<{ erc721TokenId?: string; metadata?: { blockTimestamp?: string } }>; pageKey?: string | null };

        const transfers = res.transfers ?? [];
        for (const t of transfers) {
          const tokenId = t.erc721TokenId ? BigInt(t.erc721TokenId).toString() : null;
          const ts = t.metadata?.blockTimestamp;
          if (!tokenId || !ts) continue;
          index.set(tokenId, ts);
          const cacheKey = `${key}:${tokenId}`;
          if (ageDiskCache[cacheKey] !== ts) {
            ageDiskCache[cacheKey] = ts;
            ageCacheDirty = true;
          }
        }

        pageKey = res.pageKey ?? null;
        if (!pageKey || transfers.length === 0) break;
      }
      mintIndex.set(key, index);
    } catch {
      // Endpoint doesn't support alchemy_getAssetTransfers (or failed) — don't
      // retry every position; mark unsupported for this run.
      unsupported.add(key);
    }
  })();

  inflightIndex.set(key, promise);
  try {
    await promise;
  } finally {
    inflightIndex.delete(key);
  }
}

/**
 * Resolve an NFT's mint timestamp (ISO string) using the Transfers API on the
 * configured archive RPC (BSC_ARCHIVE_RPC_URL, e.g. a free Alchemy BNB app).
 *
 * Returns null (age shows "—") when:
 *  - no archive RPC is configured
 *  - the endpoint doesn't support alchemy_getAssetTransfers
 *  - the mint is older than the fetched window (MAX_PAGES × 1000 most recent mints)
 */
export function getBscNftMintTimestamp(
  positionManager: Address,
  tokenId: bigint,
): Promise<string | null> {
  const key = positionManager.toLowerCase();
  const cacheKey = `${key}:${tokenId.toString()}`;

  const diskCached = ageDiskCache[cacheKey];
  if (diskCached) return Promise.resolve(diskCached);

  const client = getArchiveClient();
  if (!client) return Promise.resolve(null);

  return ensureMintIndex(client, positionManager).then(() => {
    const index = mintIndex.get(key);
    return index?.get(tokenId.toString()) ?? null;
  });
}

export function flushBscNftAgeCache(): void {
  if (ageCacheDirty) {
    saveNftAgeCache(ageDiskCache);
    ageCacheDirty = false;
  }
}
