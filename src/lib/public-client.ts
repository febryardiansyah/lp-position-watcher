import { createPublicClient, fallback, http, type Chain } from 'viem';

import { env } from '../config/env.js';

const FREE_PUBLIC_RPCS = ['https://robinhood-rpc.publicnode.com'] as const;

const robinhoodChain = {
  id: 4663,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: {
    default: { http: [env.RH_RPC_URL] },
  },
  contracts: {
    multicall3: {
      address: '0xcA11bde05977b3631167028862bE2a173976CA11',
    },
  },
} as const satisfies Chain;

function makeTransport(url: string) {
  return http(url, {
    timeout: 15_000,
    retryCount: 2,
    retryDelay: 500,
  });
}

function effectiveTransports(): ReturnType<typeof makeTransport>[] {
  const primary = makeTransport(env.RH_RPC_URL);
  const backups = FREE_PUBLIC_RPCS.filter((url) => url !== env.RH_RPC_URL).map((url) =>
    makeTransport(url),
  );

  return [primary, ...backups];
}

function buildTransport() {
  const transports = effectiveTransports();
  if (transports.length === 1) return transports[0];
  return fallback(transports, { rank: false });
}

export const publicClient = createPublicClient({
  chain: robinhoodChain,
  transport: buildTransport(),
  batch: { multicall: true },
});
