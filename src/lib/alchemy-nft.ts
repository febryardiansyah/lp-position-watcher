import { fetchJson } from './http.js';

const ALCHEMY_NFT_BASE = 'https://base-mainnet.g.alchemy.com/nft/v3';

type AlchemyOwnedNft = {
  tokenId: string;
  contractAddress: string;
};

type AlchemyNftResponse = {
  ownedNfts: AlchemyOwnedNft[];
  totalCount?: number;
  pageKey?: string | null;
};

type AlchemyOptions = {
  apiKey?: string;
};

export async function fetchAlchemyNftTokenIds(
  owner: string,
  contractAddress: string,
  options: AlchemyOptions = {},
): Promise<bigint[]> {
  const apiKey = options.apiKey;
  if (!apiKey) return [];

  const collected = new Set<bigint>();
  let pageKey: string | null | undefined;

  do {
    const url = new URL(`${ALCHEMY_NFT_BASE}/${apiKey}/getNFTsForOwner`);
    url.searchParams.set('owner', owner.toLowerCase());
    url.searchParams.set('withMetadata', 'false');
    url.searchParams.set('pageSize', '100');
    if (pageKey) url.searchParams.set('pageKey', pageKey);
    url.searchParams.append('contractAddresses', contractAddress.toLowerCase());

    const data = await fetchJson<AlchemyNftResponse>(url.toString());
    for (const nft of data.ownedNfts ?? []) {
      const addr = (nft.contractAddress ?? '').toLowerCase();
      if (addr !== contractAddress.toLowerCase()) continue;
      try {
        collected.add(BigInt(nft.tokenId));
      } catch {
        // ignore malformed token IDs
      }
    }
    pageKey = data.pageKey ?? null;
  } while (pageKey);

  return [...collected];
}

export function extractAlchemyKey(rpcUrl: string | undefined): string | null {
  if (!rpcUrl) return null;
  const match = rpcUrl.match(/\/v2\/([^/?#]+)/);
  return match ? match[1] : null;
}