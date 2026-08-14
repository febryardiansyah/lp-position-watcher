import type { AnyPosition, WalletLpReadResult } from './lp-position.service.js';
import { formatUsd, positionKey, type WalletValuation } from './valuation.service.js';

type PortfolioRow = {
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

export function renderPortfolio(read: WalletLpReadResult, valuation: WalletValuation): string {
  const lines: string[] = [];

  const open = read.positions.filter((position) => positionOpen(position));
  const closed = read.positions.filter((position) => !positionOpen(position));

  const inRangeCount = read.positions.filter(
    (position) => position.protocol !== 'v2' && position.inRange === true,
  ).length;
  const outOfRangeCount = read.positions.filter(
    (position) => position.protocol !== 'v2' && position.inRange === false,
  ).length;

  lines.push(`Wallet: ${read.wallet}`);
  lines.push(`Chain: Robinhood Chain (${read.chainId})`);
  lines.push('');
  lines.push(`Total Value: ${formatUsd(valuation.totalUsd)}`);
  lines.push(
    `Positions: ${read.summary.positionsOpen} (v2: ${read.summary.byProtocol.v2}, v3: ${read.summary.byProtocol.v3}, v4: ${read.summary.byProtocol.v4})`,
  );
  lines.push(
    `In range: ${inRangeCount}   Out of range: ${outOfRangeCount}   Unclaimed fees: ${formatUsd(valuation.feesUsd)}`,
  );
  lines.push('');

  if (open.length > 0) {
    lines.push(renderTable('Open positions', open, valuation));
  }

  if (closed.length > 0) {
    lines.push(renderTable('Empty/closed positions', closed, valuation));
  }

  lines.push('');

  for (const note of read.notes) {
    lines.push(`- ${note}`);
  }

  return lines.join('\n');
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

function renderTable(
  title: string,
  positions: AnyPosition[],
  valuation: WalletValuation,
): string {
  const rows: PortfolioRow[] = positions.map((position, offset) =>
    buildRow(position, offset + 1, valuation),
  );

  const widths = columnWidths(rows);

  const header = ['#', 'Pool', 'Value', 'In range', 'Unclaimed', 'Age', 'Fee', 'Range']
    .map((cell, index) => cell.padEnd(widths[index]))
    .join('  ')
    .trimEnd();

  const separator = '─'.repeat(Math.max(header.length, 20));

  const body = rows.map((row) =>
    [
      row.index.toString().padEnd(widths[0]),
      row.pool.padEnd(widths[1]),
      row.value.padEnd(widths[2]),
      row.inRange.padEnd(widths[3]),
      row.unclaimed.padEnd(widths[4]),
      row.age.padEnd(widths[5]),
      row.fee.padEnd(widths[6]),
      row.range.padEnd(widths[7]),
    ]
      .join('  ')
      .trimEnd(),
  );

  return [title, header, separator, ...body].join('\n');
}

function buildRow(position: AnyPosition, index: number, valuation: WalletValuation): PortfolioRow {
  const v = valuation.perPosition[positionKey(position)];

  let pool = '';
  let inRange = '—';
  let fee = '—';
  let range = '';

  if (position.protocol === 'v2') {
    pool = position.pairSymbol;
  } else {
    const token0 = position.token0;
    const token1 = position.token1;
    pool = token0 && token1 ? `${token0.symbol}/${token1.symbol}` : `#${position.tokenId}`;

    if (position.protocol === 'v3') {
      inRange = position.inRange ? 'yes' : 'no';
      fee = formatFeeBps(position.feeTier);
      range = `${position.tickLower} → ${position.tickUpper}`;
    } else if (position.inRange !== null) {
      inRange = position.inRange ? 'yes' : 'no';
      fee = position.lpFee !== null ? formatFeeBps(position.lpFee) : '—';
      range = `${position.tickLower} → ${position.tickUpper}`;
    }
  }

  const unclaimedUsd = v?.feesUsd ?? null;
  const unclaimedLabel = unclaimedAmounts(position);

  return {
    index,
    pool,
    protocol: position.protocol,
    value: formatUsd(v?.totalUsd ?? null),
    inRange,
    unclaimed: unclaimedUsd !== null ? `${formatUsd(unclaimedUsd)}${unclaimedLabel ? ` (${unclaimedLabel})` : ''}` : unclaimedLabel,
    age: formatAge(position.createdAt),
    fee,
    range,
  };
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

function columnWidths(rows: PortfolioRow[]): number[] {
  const header = ['#', 'Pool', 'Value', 'In range', 'Unclaimed', 'Age', 'Fee', 'Range'];
  const initial = header.map((cell) => cell.length);

  for (const row of rows) {
    initial[0] = Math.max(initial[0], row.index.toString().length);
    initial[1] = Math.max(initial[1], row.pool.length);
    initial[2] = Math.max(initial[2], row.value.length);
    initial[3] = Math.max(initial[3], row.inRange.length);
    initial[4] = Math.max(initial[4], row.unclaimed.length);
    initial[5] = Math.max(initial[5], row.age.length);
    initial[6] = Math.max(initial[6], row.fee.length);
    initial[7] = Math.max(initial[7], row.range.length);
  }

  return initial;
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
