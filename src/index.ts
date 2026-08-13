import 'dotenv/config';

import { getAddress } from 'viem';

import { env } from './config/env.js';
import { getWalletUniswapPositions } from './services/lp-position.service.js';
import {
  getWalletDiff,
  getWalletHistory,
  summarizeChanges,
  trackWalletPositions,
} from './services/tracker.service.js';
import { formatUsd } from './services/valuation.service.js';

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

const USAGE = `Usage:
  npm run dev -- <walletAddress>            Read current Uniswap LP positions (v2/v3/v4)
  npm run dev -- positions <walletAddress>  Same as above
  npm run dev -- track <walletAddress>      Record a valuation snapshot and report changes since last one
  npm run dev -- history <walletAddress>    List recorded snapshots for a wallet
  npm run dev -- diff <walletAddress>       Diff the two most recent snapshots
  npm run dev -- help                       Show this help

The wallet can also be set with WALLET_ADDRESS in .env.`;

function resolveWallet(walletArg: string | undefined): string {
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

  return getAddress(walletInput);
}

async function main() {
  const args = process.argv.slice(2);
  const first = args[0];

  const isCommand = !!first && !first.startsWith('0x');
  const command = isCommand ? first : 'positions';
  const walletArg = isCommand ? args[1] : first;

  if (command === 'help' || command === '--help' || command === '-h') {
    console.log(USAGE);
    return;
  }

  const wallet = resolveWallet(walletArg);
  const input = {
    protocol: 'all' as const,
    wallet,
    chainId: env.RH_CHAIN_ID,
  };

  switch (command) {
    case 'positions':
    case 'read': {
      console.log(JSON.stringify(await getWalletUniswapPositions(input), null, 2));
      return;
    }

    case 'track': {
      const result = await trackWalletPositions(input);

      console.error(
        [
          `Tracked ${result.read.summary.positionsOpen} positions on chain ${result.chainId}.`,
          `Total value: ${formatUsd(result.valuation.totalUsd)}`,
          result.previous
            ? `Previous snapshot (${result.previous.timestamp}): ${formatUsd(result.previous.totalUsd)}`
            : 'First snapshot for this wallet; all positions marked as opened.',
        ].join('\n'),
      );

      const changeLines = summarizeChanges(result.changes);
      if (changeLines.length > 0) {
        console.error(`Changes since last snapshot:\n${changeLines.join('\n')}`);
      } else {
        console.error('No changes since last snapshot.');
      }

      console.log(
        JSON.stringify(
          {
            wallet: result.wallet,
            chainId: result.chainId,
            trackedAt: result.trackedAt,
            blockNumber: result.blockNumber,
            totalUsd: result.valuation.totalUsd,
            previous: result.previous,
            changes: result.changes,
            changeSummary: changeLines,
            valuation: result.valuation,
            read: result.read,
          },
          null,
          2,
        ),
      );
      return;
    }

    case 'history': {
      console.log(JSON.stringify(await getWalletHistory(input), null, 2));
      return;
    }

    case 'diff': {
      const result = await getWalletDiff(input);
      const lines = summarizeChanges(result.changes);

      if (lines.length > 0) {
        console.error(`Changes between last two snapshots:\n${lines.join('\n')}`);
      } else {
        console.error('No changes between last two snapshots.');
      }

      console.log(
        JSON.stringify(
          {
            wallet: result.wallet,
            chainId: result.chainId,
            previous: result.previous,
            current: result.current,
            changes: result.changes,
            changeSummary: lines,
          },
          null,
          2,
        ),
      );
      return;
    }

    default:
      throw new Error(`Unknown command "${command}".\n\n${USAGE}`);
  }
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
