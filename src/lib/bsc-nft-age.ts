import { createPublicClient, http, type Address, type PublicClient, type RpcLog } from 'viem';
import { bsc } from 'viem/chains';

import { env } from '../config/env.js';

const TRANSFER_EVENT_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef' as const;
const ZERO_ADDRESS_TOPIC = '0x0000000000000000000000000000000000000000000000000000000000000000' as const;

// Reuse the shared NFT-age disk cache (data/cache/nft-age.json). Keys are
// prefixed with the position-manager address, which also keeps Robinhood
// (Blockscout) and BSC (RPC) entries distinct.
import { loadNftAgeCache, saveNftAgeCache } from './storage.js';

let archiveClient: PublicClient | null = null;

/**
 * Archive-capable BSC client used for NFT mint-time lookups.
 * Free public BSC RPCs reject the wide eth_getLogs ranges required (they
 * rate-limit to ~8k blocks and often 403 immediately), so this only exists
 * when BSC_ARCHIVE_RPC_URL is configured (e.g. an Alchemy BSC app).
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

const createdAtCache = new Map<string, Promise<string | null>>();
const ageDiskCache = loadNftAgeCache();
let ageCacheDirty = false;

/**
 * Resolve an NFT's mint timestamp (ISO string) by reading the ERC-721
 * `Transfer(from = 0x0, tokenId)` log from an archive-capable BSC RPC.
 *
 * Returns null (age shows "—") when:
 *  - no archive RPC is configured (BSC_ARCHIVE_RPC_URL)
 *  - the mint log cannot be found (burned/transferred positions still have it)
 *  - the RPC errors or times out
 */
export function getBscNftMintTimestamp(
  positionManager: Address,
  tokenId: bigint,
): Promise<string | null> {
  const cacheKey = `${positionManager.toLowerCase()}:${tokenId.toString()}`;
  const cached = createdAtCache.get(cacheKey);
  if (cached) return cached;

  const diskCached = ageDiskCache[cacheKey];
  if (diskCached) {
    const promise = Promise.resolve(diskCached);
    createdAtCache.set(cacheKey, promise);
    return promise;
  }

  const promise = (async (): Promise<string | null> => {
    const client = getArchiveClient();
    if (!client) return null;

    try {
      const tokenIdTopic = `0x${tokenId.toString(16).padStart(64, '0')}` as `0x${string}`;
      const rawLogs = (await client.request({
        method: 'eth_getLogs',
        params: [
          {
            address: positionManager,
            topics: [TRANSFER_EVENT_TOPIC, null, ZERO_ADDRESS_TOPIC, tokenIdTopic],
            fromBlock: '0x0',
            toBlock: 'latest',
          },
        ],
      })) as RpcLog[];

      if (rawLogs.length === 0) return null;

      // Mint logs are unique per tokenId; take the earliest block to be safe
      // (nodes may return logs in either order).
      const withBlock = rawLogs.filter((l): l is RpcLog & { blockNumber: `0x${string}` } => l.blockNumber !== null);
      if (withBlock.length === 0) return null;
      const mintBlock = withBlock.reduce(
        (min, l) => (BigInt(l.blockNumber) < min ? BigInt(l.blockNumber) : min),
        BigInt(withBlock[0].blockNumber),
      );

      const block = await client.getBlock({ blockNumber: mintBlock });
      const iso = new Date(Number(block.timestamp) * 1000).toISOString();
      ageDiskCache[cacheKey] = iso;
      ageCacheDirty = true;
      return iso;
    } catch {
      return null;
    }
  })();

  createdAtCache.set(cacheKey, promise);
  return promise;
}

export function flushBscNftAgeCache(): void {
  if (ageCacheDirty) {
    saveNftAgeCache(ageDiskCache);
    ageCacheDirty = false;
  }
}
