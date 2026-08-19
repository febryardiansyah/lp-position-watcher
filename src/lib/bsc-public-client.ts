import { createPublicClient, fallback, http, type Chain, type PublicClient } from 'viem';
import { bsc } from 'viem/chains';

import { env } from '../config/env.js';
import { BSC_CONFIG } from '../constants/chain.js';

function makeTransport(url: string) {
  return http(url, {
    timeout: 15_000,
    retryCount: 2,
    retryDelay: 500,
  });
}

function effectiveTransports(): ReturnType<typeof makeTransport>[] {
  const override = env.BSC_RPC_URL;
  const all = override ? [override, ...BSC_CONFIG.rpcFallbacks] : [...BSC_CONFIG.rpcFallbacks];
  const unique = [...new Set(all)];
  return unique.map((url) => makeTransport(url));
}

function buildTransport() {
  const transports = effectiveTransports();
  if (transports.length === 1) return transports[0];
  return fallback(transports, { rank: false });
}

const bscChain = {
  ...bsc,
  id: BSC_CONFIG.id,
  contracts: {
    ...bsc.contracts,
    multicall3: {
      address: BSC_CONFIG.multicall3 as `0x${string}`,
    },
  },
} as const satisfies Chain;

export const publicClientBsc: PublicClient = createPublicClient({
  chain: bscChain,
  transport: buildTransport(),
  batch: { multicall: true },
});