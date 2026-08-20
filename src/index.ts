import 'dotenv/config';

import boxen from 'boxen';
import chalk from 'chalk';
import ora from 'ora';
import { getAddress } from 'viem';

import { env } from './config/env.js';
import { getWalletUniswapPositions } from './services/lp-position.service.js';
import {
  changeDelta,
  relativeTime,
  renderPortfolio,
  shortAddr,
  theme,
} from './services/portfolio-view.service.js';
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

const USAGE = [
  chalk.cyan.bold('Usage:'),
  `  ${chalk.bold('npm run dev --')} <walletAddress>             ${chalk.gray('Show LP portfolio for a wallet')}`,
  `  ${chalk.bold('npm run dev -- positions')} <walletAddress>   ${chalk.gray('Same as above')}`,
  `  ${chalk.bold('npm run dev -- positions --json <wallet>')}    ${chalk.gray('Show raw JSON position data')}`,
  `  ${chalk.bold('npm run dev -- track')} <walletAddress>       ${chalk.gray('Record a valuation snapshot and report changes')}`,
  `  ${chalk.bold('npm run dev -- history')} <walletAddress>     ${chalk.gray('List recorded snapshots for a wallet')}`,
  `  ${chalk.bold('npm run dev -- diff')} <walletAddress>        ${chalk.gray('Diff the two most recent snapshots')}`,
  `  ${chalk.bold('npm run dev -- help')}                        ${chalk.gray('Show this help')}`,
  '',
  chalk.yellow.bold('Chain selection:'),
  `  ${chalk.green('--chain')} <robinhood|bsc|base>   Which chain to read (default: robinhood).`,
  `                          ${chalk.gray("'bsc' reads PancakeSwap v3 on BNB Smart Chain.")}`,
  `                          ${chalk.gray("'base' reads Uniswap v2/v3/v4 on Base (chain 8453).")}`,
  '',
  chalk.yellow.bold('Output options:'),
  `  ${chalk.green('--no-color')}                    Disable ANSI color output`,
  `  ${chalk.green('--json')}                        Emit raw JSON instead of pretty output`,
  '',
  chalk.yellow.bold('Pagination options (portfolio view):'),
  `  ${chalk.green('--limit')} <n>   Max closed positions per page (default 15)`,
  `  ${chalk.green('--page')} <n>    Page of closed positions to show (default 1)`,
  '',
  chalk.gray('The wallet can also be set with WALLET_ADDRESS in .env.'),
].join('\n');

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
      const fetchSpinner = ora({
        text: theme.muted(`Fetching LP positions for ${shortAddr(wallet)}…`),
        color: 'cyan',
      }).start();

      let read;
      try {
        read = await getWalletUniswapPositions(input);
      } catch (err) {
        fetchSpinner.fail(theme.error('Failed to fetch positions'));
        throw err;
      }

      const valSpinner = ora({
        text: theme.muted(`Valuating ${read.positions.length} positions…`),
        color: 'cyan',
      }).start();

      let valuation;
      try {
        valuation = await valuePositions(read.positions, read.chainId);
      } catch (err) {
        valSpinner.fail(theme.error('Valuation failed'));
        throw err;
      }

      valSpinner.succeed(
        theme.success(`Valued ${read.positions.length} positions at ${theme.value(formatUsd(valuation.totalUsd))}`),
      );

      if (jsonOutput) {
        console.log(JSON.stringify(read, null, 2));
        return;
      }

      console.log(renderPortfolio(read, valuation, { limit, page }));
      return;
    }

    case 'track': {
      const spinner = ora({
        text: theme.muted(`Tracking wallet ${shortAddr(wallet)} on chain ${input.chainId}…`),
        color: 'cyan',
      }).start();

      let result;
      try {
        result = await trackWalletPositions(input);
      } catch (err) {
        spinner.fail(theme.error('Tracking failed'));
        throw err;
      }

      spinner.succeed(
        theme.success(
          `Snapshot saved ${theme.muted(`(${relativeTime(result.trackedAt)} · block ${result.blockNumber})`)}`,
        ),
      );

      console.log('');
      console.log(
        boxen(
          [
            `${theme.muted('Wallet  ')} ${theme.wallet(shortAddr(result.wallet))}`,
            `${theme.muted('Chain   ')} ${theme.chain(String(result.chainId))}`,
            `${theme.muted('Total   ')} ${theme.value(formatUsd(result.valuation.totalUsd))}`,
            result.previous
              ? `${theme.muted('Previous')} ${theme.value(formatUsd(result.previous.totalUsd))}${changeDelta(
                  result.valuation.totalUsd,
                  result.previous.totalUsd,
                )}`
              : `${theme.muted('Previous')} ${theme.dim('— (first snapshot)')}`,
            `${theme.muted('Open    ')} ${theme.value(`${result.read.summary.positionsOpen}`)}`,
            `${theme.muted('By protoc')} ${theme.muted(
              `v2:${result.read.summary.byProtocol.v2}  v3:${result.read.summary.byProtocol.v3}  v4:${result.read.summary.byProtocol.v4}`,
            )}`,
          ].join('\n'),
          {
            title: theme.brand(' Snapshot '),
            titleAlignment: 'center',
            padding: { top: 0, bottom: 0, left: 1, right: 1 },
            borderStyle: 'round',
            borderColor: 'green',
          },
        ),
      );

      const changeLines = summarizeChanges(result.changes);
      if (changeLines.length > 0) {
        console.log('');
        console.log(theme.subheading('  Changes since last snapshot'));
        console.log(changeLines.join('\n'));
      } else {
        console.log('');
        console.log(theme.muted('  No changes since last snapshot.'));
      }

      if (!jsonOutput) return;

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
      const spinner = ora({
        text: theme.muted(`Reading snapshot history for ${shortAddr(wallet)}…`),
        color: 'cyan',
      }).start();

      let history;
      try {
        history = await getWalletHistory(input);
      } catch (err) {
        spinner.fail(theme.error('Failed to read history'));
        throw err;
      }

      spinner.succeed(theme.success(`Found ${history.snapshots.length} snapshot(s)`));

      if (history.snapshots.length === 0) {
        console.log(theme.muted('  No snapshots yet. Run `track` to record one.'));
        return;
      }

      const Table = (await import('cli-table3')).default;
      const table = new Table({
        head: [
          theme.muted('#'),
          theme.muted('When'),
          theme.muted('Block'),
          theme.muted('Positions'),
          theme.muted('v2 / v3 / v4'),
          theme.muted('Total USD'),
        ].map((h) => chalk.reset(h)),
        style: { head: [], border: [], 'padding-left': 1, 'padding-right': 1 },
      });

      history.snapshots.forEach((snap, i) => {
        table.push([
          theme.muted(`${i + 1}`),
          `${chalk.cyan(new Date(snap.timestamp).toLocaleString())} ${theme.dim('(' + relativeTime(snap.timestamp) + ')')}`,
          theme.muted(snap.blockNumber),
          theme.value(`${snap.positionsCount}`),
          theme.muted(`v2:${snap.byProtocol.v2}  v3:${snap.byProtocol.v3}  v4:${snap.byProtocol.v4}`),
          theme.value(formatUsd(snap.totalUsd)),
        ]);
      });

      console.log('');
      console.log(theme.heading('  Snapshot history'));
      console.log(table.toString());

      if (jsonOutput) {
        console.log(JSON.stringify(history, null, 2));
      }
      return;
    }

    case 'diff': {
      const spinner = ora({
        text: theme.muted(`Comparing last two snapshots for ${shortAddr(wallet)}…`),
        color: 'cyan',
      }).start();

      let result;
      try {
        result = await getWalletDiff(input);
      } catch (err) {
        spinner.fail(theme.error('Diff failed'));
        throw err;
      }

      spinner.succeed(theme.success('Diff complete'));

      const lines = summarizeChanges(result.changes);

      if (lines.length > 0) {
        console.log('');
        console.log(theme.subheading('  Changes between last two snapshots'));
        console.log(lines.join('\n'));
      } else {
        console.log('');
        console.log(theme.muted('  No changes between last two snapshots.'));
      }

      if (!jsonOutput) return;

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

  console.error(
    boxen(
      [theme.error('✖ Error'), '', message].join('\n'),
      {
        title: chalk.red(' Failed '),
        titleAlignment: 'center',
        padding: { top: 0, bottom: 0, left: 1, right: 1 },
        borderStyle: 'round',
        borderColor: 'red',
      },
    ),
  );

  const hints = rpcHints(message, currentChain);
  if (hints.length > 0) {
    console.error('');
    console.error(theme.warn('  Hints'));
    for (const hint of hints) {
      console.error(`    ${theme.muted('•')} ${hint}`);
    }
  }

  process.exitCode = 1;
});