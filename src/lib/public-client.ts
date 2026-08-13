import { createPublicClient, fallback, http } from 'viem';

import { env } from '../config/env.js';

function parseFallbackUrls(raw: string | undefined): string[] {
  if (!raw) return [];

  return raw
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

const fallbackUrls = parseFallbackUrls(env.RH_RPC_FALLBACK_URLS);
const transports = [http(env.RH_RPC_URL), ...fallbackUrls.map((url) => http(url))];

export const publicClient = createPublicClient({
  transport: transports.length === 1 ? transports[0] : fallback(transports, { rank: true }),
});
