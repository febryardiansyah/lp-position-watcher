import { createPublicClient, fallback, http, type Chain, type PublicClient } from 'viem';
import { base } from 'viem/chains';

import { env } from '../config/env.js';
import { BASE_CONFIG } from '../constants/chain.js';

function makeTransport(url: string) {
  return http(url, {
    timeout: 15_000,
    retryCount: 2,
    retryDelay: 500,
  });
}

function effectiveTransports(): ReturnType<typeof makeTransport>[] {
  const override = env.BASE_RPC_URL;
  const all = override ? [override, ...BASE_CONFIG.rpcFallbacks] : [...BASE_CONFIG.rpcFallbacks];
  const unique = [...new Set(all)];
  return unique.map((url) => makeTransport(url));
}

function buildTransport() {
  const transports = effectiveTransports();
  if (transports.length === 1) return transports[0];
  return fallback(transports, { rank: false });
}

const baseChain = {
  ...base,
  id: BASE_CONFIG.id,
  contracts: {
    ...base.contracts,
    multicall3: {
      address: BASE_CONFIG.multicall3 as `0x${string}`,
    },
  },
} as const satisfies Chain;

export const publicClientBase: PublicClient = createPublicClient({
  chain: baseChain,
  transport: buildTransport(),
  batch: { multicall: true },
}) as unknown as PublicClient;
