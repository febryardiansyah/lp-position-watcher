import 'dotenv/config';

import { getAddress } from 'viem';

import { env } from './config/env.js';
import { getWalletUniswapPositions } from './services/lp-position.service.js';

function rpcHints(errorMessage: string): string[] {
  const hints: string[] = [];
  const lower = errorMessage.toLowerCase();

  if (lower.includes('certificate') || lower.includes('ssl') || lower.includes('fetch failed')) {
    hints.push(
      'Primary RPC endpoint has TLS/certificate issues from this network. Use an alternate provider URL in RH_RPC_URL.',
    );
    hints.push('Set RH_RPC_FALLBACK_URLS with one or more comma-separated backup RPC endpoints.');
  }

  return hints;
}

async function main() {
  const walletArg = process.argv[2];
  const walletInput = walletArg ?? env.WALLET_ADDRESS;

  if (!walletInput) {
    throw new Error(
      [
        'Missing wallet address.',
        'Usage: npm run dev -- <walletAddress>',
        'Or set WALLET_ADDRESS in .env',
      ].join(' '),
    );
  }

  const wallet = getAddress(walletInput);

  const result = await getWalletUniswapPositions({
    protocol: 'all',
    wallet,
    chainId: env.RH_CHAIN_ID,
  });

  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);

  const hints = rpcHints(message);
  if (hints.length > 0) {
    console.error('\nHints:');
    for (const hint of hints) {
      console.error(`- ${hint}`);
    }
  }

  process.exitCode = 1;
});
