import 'dotenv/config';

import { getAddress } from 'viem';

import { env } from './config/env.js';
import { getWalletUniswapPositions } from './services/lp-position.service.js';
import { renderPortfolio } from './services/portfolio-view.service.js';
import {
  getWalletDiff,
  getWalletHistory,
  summarizeChanges,
  trackWalletPositions,
} from './services/tracker.service.js';
import { formatUsd, valuePositions } from './services/valuation.service.js';

function rpcHints(errorMessage: string, chain: 'robinhood' | 'bsc' | 'base'): string[] {
  const hints: string[] = [];
  const lower = errorMessage.toLowerCase();

  if (lower.includes('certificate') || lower.includes('ssl') || lower.includes('fetch failed')) {
    if (chain === 'bsc') {
      hints.push(
        'The BSC RPC endpoint is unreachable from this network. Point BSC_RPC_URL at another BSC RPC in .env.',
      );
    } else if (chain === 'base') {
      hints.push(
        'The Base RPC endpoint is unreachable from this network. Point BASE_RPC_URL at another Base RPC in .env.',
      );
    } else {
      hints.push(
        'The RPC endpoint is unreachable from this network. Point RH_RPC_URL at another RPC endpoint in .env.',
      );
    }
  }

  return hints;
}

const USAGE = `Usage:
  npm run dev -- <walletAddress>            Show LP portfolio (like lpagent.io) for a wallet
  npm run dev -- positions <walletAddress>  Same as above
  npm run dev -- positions --json <wallet>  Show raw JSON position data
  npm run dev -- track <walletAddress>      Record a valuation snapshot and report changes since last one
  npm run dev -- history <walletAddress>    List recorded snapshots for a wallet
  npm run dev -- diff <walletAddress>       Diff the two most recent snapshots
  npm run dev -- help                       Show this help

Chain selection:
  --chain <robinhood|bsc|base>   Which chain to read (default: robinhood).
                                 'bsc' reads PancakeSwap v3 on BNB Smart Chain.
                                 'base' reads Uniswap v2/v3/v4 on Base (chain 8453).

Pagination options (portfolio view):
  --limit <n>   Max closed positions per page (default 15)
  --page <n>    Page of closed positions to show (default 1)

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

let currentChain: 'robinhood' | 'bsc' | 'base' = 'robinhood';

async function main() {
  const args = process.argv.slice(2);
  const jsonIndex = args.indexOf('--json');
  const jsonOutput = jsonIndex !== -1;
  if (jsonOutput) args.splice(jsonIndex, 1);

  const limitIndex = args.indexOf('--limit');
  const limit = limitIndex !== -1 && args[limitIndex + 1] ? Number(args[limitIndex + 1]) : undefined;
  if (limitIndex !== -1) args.splice(limitIndex, 2);

  const pageIndex = args.indexOf('--page');
  const page = pageIndex !== -1 && args[pageIndex + 1] ? Number(args[pageIndex + 1]) : undefined;
  if (pageIndex !== -1) args.splice(pageIndex, 2);

  const chainIndex = args.indexOf('--chain');
  const chainRaw = chainIndex !== -1 && args[chainIndex + 1] ? args[chainIndex + 1] : undefined;
  if (chainIndex !== -1) args.splice(chainIndex, 2);
  const chain: 'robinhood' | 'bsc' | 'base' =
    chainRaw === 'bsc' || chainRaw === 'base' || chainRaw === 'robinhood' || chainRaw === undefined
      ? (chainRaw ?? 'robinhood')
      : (() => {
          throw new Error(`Unknown --chain value "${chainRaw}". Use 'robinhood', 'bsc', or 'base'.`);
        })();
  currentChain = chain;

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
    chain,
    chainId:
      chain === 'bsc'
        ? env.BSC_CHAIN_ID
        : chain === 'base'
          ? env.BASE_CHAIN_ID
          : env.RH_CHAIN_ID,
  };

  switch (command) {
    case 'positions':
    case 'read': {
      const read = await getWalletUniswapPositions(input);

      if (jsonOutput) {
        console.log(JSON.stringify(read, null, 2));
        return;
      }

      const valuation = await valuePositions(read.positions, read.chainId);
      console.log(renderPortfolio(read, valuation, { limit, page }));
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

  const hints = rpcHints(message, currentChain);
  if (hints.length > 0) {
    console.error('\nHints:');
    for (const hint of hints) {
      console.error(`- ${hint}`);
    }
  }

  process.exitCode = 1;
});
