import { fetchJson } from './http.js';
import { BSC_CONFIG } from '../constants/chain.js';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

type BscScanConfig = {
  base: string;
  apiKey?: string;
};

type BscScanNftTx = {
  hash: string;
  from: string;
  to: string;
  tokenID: string;
  timeStamp: string;
};

type BscScanResponse = {
  status: string;
  message: string;
  result: Array<BscScanNftTx | string>;
};

type BscScanOptions = {
  apiKey?: string;
  base?: string;
};

export async function getNftTransferHistory(
  contractAddress: string,
  tokenId: bigint,
  options: BscScanOptions = {},
): Promise<string | null> {
  const cfg: BscScanConfig = {
    base: options.base ?? BSC_CONFIG.explorerBscscanBase,
    apiKey: options.apiKey,
  };

  const params = new URLSearchParams({
    module: 'account',
    action: 'tokennfttx',
    contractaddress: contractAddress,
    tokenid: tokenId.toString(),
    sort: 'asc',
    page: '1',
    offset: '100',
  });
  if (cfg.apiKey) params.set('apikey', cfg.apiKey);

  const url = `${cfg.base}?${params.toString()}`;

  let data: BscScanResponse;
  try {
    data = await fetchJson<BscScanResponse>(url);
  } catch {
    return null;
  }

  if (data.status !== '1' || !Array.isArray(data.result)) {
    return null;
  }

  let earliest: string | null = null;

  for (const item of data.result) {
    if (typeof item !== 'object' || item === null) continue;

    const from = (item.from ?? '').toLowerCase();
    const timestamp = item.timeStamp;
    if (!timestamp) continue;

    if (from === ZERO_ADDRESS) {
      return timestamp;
    }
    if (!earliest || timestamp < earliest) {
      earliest = timestamp;
    }
  }

  return earliest;
}