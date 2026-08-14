import { createPublicClient, fallback, http } from 'viem';

import { env } from '../config/env.js';

const FREE_PUBLIC_RPCS = [
  'https://robinhood-rpc.publicnode.com',
  'https://rpc.mainnet.chain.robinhood.com',
] as const;

function makeTransport(url: string) {
  return http(url, {
    timeout: 15_000,
    retryCount: 2,
    retryDelay: 500,
  });
}

function transports(): ReturnType<typeof makeTransport>[] {
  const primary = makeTransport(env.RH_RPC_URL);
  const backups = FREE_PUBLIC_RPCS.filter((url) => url !== env.RH_RPC_URL).map((url) =>
    makeTransport(url),
  );

  return [primary, ...backups];
}

export const publicClient = createPublicClient({
  transport: fallback(transports(), { rank: false }),
});
