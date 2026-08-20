import boxen from 'boxen';
import chalk from 'chalk';
import Table from 'cli-table3';

import type { AnyPosition, WalletLpReadResult } from './lp-position.service.js';
import { formatUsd, positionKey, type WalletValuation } from './valuation.service.js';

const NO_COLOR = process.env.NO_COLOR === '1' || process.argv.includes('--no-color');

if (NO_COLOR) {
  process.env.FORCE_COLOR = '0';
}

export const theme = {
  brand: chalk.hex('#FF6600').bold,
  brandDim: chalk.hex('#FF6600'),
  heading: chalk.bold.cyan,
  subheading: chalk.bold,
  wallet: chalk.bold.magenta,
  chain: chalk.bold.blue,
  value: chalk.bold.green,
  valueMuted: chalk.gray,
  positive: chalk.green,
  positiveBold: chalk.green.bold,
  negative: chalk.red,
  negativeBold: chalk.red.bold,
  neutral: chalk.yellow,
  muted: chalk.gray,
  dim: chalk.dim,
  inRange: chalk.greenBright,
  outOfRange: chalk.redBright,
  pool: chalk.bold.cyan,
  token: chalk.cyan,
  protocol: chalk.magenta,
  fee: chalk.yellow,
  success: chalk.green,
  warn: chalk.yellow,
  error: chalk.red,
  opened: chalk.green,
  closed: chalk.red,
  modified: chalk.yellow,
};

export type Palette = typeof theme;

export function valueBold(value: number | null): string {
  const text = formatUsd(value);
  if (value === null) return theme.muted(text);
  return theme.value(text);
}

export function shortAddr(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return '—';
  if (ms < 0) return new Date(iso).toLocaleString();
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ${hours % 24}h ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  const years = Math.floor(days / 365);
  return `${years}y ago`;
}

export function changeDelta(current: number | null, previous: number | null): string {
  if (current === null || previous === null) return '';
  const diff = current - previous;
  if (Math.abs(diff) < 0.01) return theme.muted(' (±$0.00)');
  const pct = previous !== 0 ? (diff / previous) * 100 : 0;
  const sign = diff >= 0 ? '+' : '−';
  return theme.muted(
    ` (${sign}${formatUsd(Math.abs(diff))}, ${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%)`,
  );
}

export type PortfolioRow = {
  index: number;
  pool: string;
  protocol: string;
  value: string;
  inRange: string;
  unclaimed: string;
  age: string;
  fee: string;
  range: string;
};

export type PortfolioViewOptions = {
  limit?: number;
  page?: number;
  previousTotalUsd?: number | null;
};

const DEFAULT_PAGE_LIMIT = 15;

export function renderPortfolio(
  read: WalletLpReadResult,
  valuation: WalletValuation,
  options: PortfolioViewOptions = {},
): string {
  const outBuf: string[] = [];

  const open = read.positions.filter((position) => positionOpen(position));
  const closed = read.positions.filter((position) => !positionOpen(position));

  const limit = options.limit ?? DEFAULT_PAGE_LIMIT;
  const page = Math.max(options.page ?? 1, 1);
  const closedOffset = (page - 1) * limit;
  const closedPage = closed.slice(closedOffset, closedOffset + limit);

  const inRangeCount = read.positions.filter(
    (position) => position.protocol !== 'v2' && position.inRange === true,
  ).length;
  const outOfRangeCount = read.positions.filter(
    (position) => position.protocol !== 'v2' && position.inRange === false,
  ).length;

  outBuf.push(
    boxen(
      [
        theme.wallet(shortAddr(read.wallet)),
        theme.dim('full: '),
        theme.muted(read.wallet),
      ].join('\n'),
      {
        title: theme.brand(' LP Portfolio '),
        titleAlignment: 'center',
        padding: { top: 0, bottom: 0, left: 1, right: 1 },
        margin: { top: 0, bottom: 0, left: 0, right: 0 },
        borderStyle: 'round',
        borderColor: 'cyan',
      },
    ),
  );

  outBuf.push(
    theme.dim('  Chain: ') + theme.chain(chainLabel(read)),
    '',
    theme.subheading('  Summary'),
    `    ${theme.muted('Total value  ')} ${valueBold(valuation.totalUsd)}`,
    `    ${theme.muted('Unclaimed    ')} ${theme.neutral(formatUsd(valuation.feesUsd))}`,
    `    ${theme.muted('Positions    ')} ${theme.value(`${open.length}`)}`,
    `    ${theme.muted('In range     ')} ${theme.inRange(`${inRangeCount}`)}`,
    `    ${theme.muted('Out of range ')} ${theme.outOfRange(`${outOfRangeCount}`)}`,
    '',
  );

  if (open.length > 0) {
    outBuf.push(renderPositionsTable('Open positions', open, valuation, 'open'));
  }

  if (closedPage.length > 0) {
    outBuf.push(renderPositionsTable('Empty / closed positions', closedPage, valuation, 'closed'));

    if (closed.length > limit) {
      const from = closedOffset + 1;
      const to = closedOffset + closedPage.length;
      outBuf.push(
        theme.muted(
          `Showing closed positions ${from}-${to} of ${closed.length}. Use --page <n> --limit <n> to navigate.`,
        ),
      );
    }
  }

  if (open.length === 0 && closedPage.length === 0) {
    outBuf.push(theme.muted('  No positions found.'));
  }

  if (read.notes.length > 0) {
    outBuf.push('');
    outBuf.push(theme.subheading('  Notes'));
    for (const note of read.notes) {
      outBuf.push(`    ${theme.muted('•')} ${note}`);
    }
  }

  return outBuf.filter(Boolean).join('\n');
}

function renderPositionsTable(
  title: string,
  positions: AnyPosition[],
  valuation: WalletValuation,
  kind: 'open' | 'closed',
): string {
  const table = new Table({
    head: [
      theme.muted('#'),
      theme.muted('Pool'),
      theme.muted('Value'),
      theme.muted('Range'),
      theme.muted('Unclaimed'),
      theme.muted('Age'),
      theme.muted('Fee'),
      theme.muted('Tick range'),
    ].map((h) => chalk.reset(h)),
    style: {
      head: [],
      border: [],
      'padding-left': 1,
      'padding-right': 1,
    },
    wordWrap: true,
    colAligns: ['right', 'left', 'right', 'center', 'right', 'right', 'right', 'left'],
  });

  positions.forEach((position, offset) => {
    table.push(buildRow(position, offset + 1, valuation, kind));
  });

  const headerLine =
    kind === 'open'
      ? theme.heading(`  ${title}`) + theme.muted(`  (${positions.length})`)
      : theme.muted(`  ${title}`) + theme.muted(`  (${positions.length})`);

  return `\n${headerLine}\n${table.toString()}`;
}

function buildRow(
  position: AnyPosition,
  index: number,
  valuation: WalletValuation,
  kind: 'open' | 'closed',
): string[] {
  const v = valuation.perPosition[positionKey(position)];

  let pool = '';
  let inRange = '—';
  let fee = '—';
  let range = '';

  if (position.protocol === 'v2') {
    pool = theme.pool(position.pairSymbol);
  } else {
    const token0 = position.token0;
    const token1 = position.token1;
    const basePool = token0 && token1 ? `${token0.symbol}/${token1.symbol}` : `#${position.tokenId}`;
    pool =
      position.protocol === 'v3' && position.provider === 'pancake'
        ? `${theme.muted('[pancake]')} ${theme.pool(basePool)}`
        : theme.pool(basePool);

    if (position.protocol === 'v3') {
      inRange = position.inRange ? theme.inRange('● in') : theme.outOfRange('● out');
      fee = theme.fee(formatFeeBps(position.feeTier));
      range = `${position.tickLower} → ${position.tickUpper}`;
    } else if (position.inRange !== null) {
      inRange = position.inRange ? theme.inRange('● in') : theme.outOfRange('● out');
      fee = position.lpFee !== null ? theme.fee(formatFeeBps(position.lpFee)) : '—';
      range = `${position.tickLower} → ${position.tickUpper}`;
    }
  }

  const unclaimedUsd = v?.feesUsd ?? null;
  const unclaimedLabel = unclaimedAmounts(position);
  const unclaimedFormatted = unclaimedUsd !== null ? formatUsd(unclaimedUsd) : '';
  const unclaimedCombined =
    unclaimedUsd !== null
      ? `${theme.neutral(unclaimedFormatted)}${unclaimedLabel ? theme.muted(` (${unclaimedLabel})`) : ''}`
      : unclaimedLabel;

  const valueFormatted = v?.totalUsd !== undefined && v?.totalUsd !== null
    ? theme.value(formatUsd(v.totalUsd))
    : theme.muted('—');

  return [
    theme.muted(`${index}`),
    pool,
    valueFormatted,
    kind === 'closed' ? theme.muted(inRange) : inRange,
    unclaimedCombined || theme.muted('—'),
    theme.muted(formatAge(position.createdAt)),
    fee,
    theme.muted(range),
  ];
}

function positionOpen(position: AnyPosition): boolean {
  if (position.protocol === 'v2') {
    return BigInt(position.lpBalance) > 0n && BigInt(position.lpTotalSupply) > 0n;
  }

  if (position.protocol === 'v3') {
    return (
      BigInt(position.liquidity) > 0n ||
      BigInt(position.token0.uncollectedFees) > 0n ||
      BigInt(position.token1.uncollectedFees) > 0n
    );
  }

  if (position.liquidity === null || position.token0 === null || position.token1 === null) {
    return false;
  }

  return (
    BigInt(position.liquidity) > 0n ||
    BigInt(position.token0.uncollectedFees) > 0n ||
    BigInt(position.token1.uncollectedFees) > 0n
  );
}

function unclaimedAmounts(position: AnyPosition): string {
  if (position.protocol === 'v2') return '';

  const token0 = position.token0;
  const token1 = position.token1;
  if (!token0 || !token1) return '';

  const fee0 = trimAmount(token0.uncollectedFees);
  const fee1 = trimAmount(token1.uncollectedFees);

  if (fee0 === '0' && fee1 === '0') return '';

  return `${fee0} ${token0.symbol} + ${fee1} ${token1.symbol}`;
}

function formatFeeBps(feeBps: number): string {
  return `${(feeBps / 10_000).toFixed(feeBps % 100 === 0 ? 2 : 3)}%`;
}

function formatAge(createdAt: string | null): string {
  if (!createdAt) return '—';

  const created = Date.parse(createdAt);
  if (!Number.isFinite(created)) return '—';

  const elapsedMs = Date.now() - created;
  if (elapsedMs < 0) return '—';

  const minutes = Math.floor(elapsedMs / 60_000);
  const hours = Math.floor(elapsedMs / 3_600_000);
  const days = Math.floor(elapsedMs / 86_400_000);

  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m`;
  return '<1m';
}

function trimAmount(value: string): string {
  const trimmed = value.replace(/\.?0+$/, '') || '0';
  if (trimmed.length > 14) return `${trimmed.slice(0, 14)}…`;
  return trimmed;
}

function chainLabel(read: WalletLpReadResult): string {
  if (read.chainName === 'bsc') return `BNB Smart Chain (${read.chainId})`;
  if (read.chainName === 'base') return `Base (${read.chainId})`;
  return `Robinhood Chain (${read.chainId})`;
}