import { getAddress, type Address } from 'viem';

import { publicClientBase } from '../lib/base-public-client.js';
import { publicClientBsc } from '../lib/bsc-public-client.js';
import { publicClient } from '../lib/public-client.js';
import {
  appendSnapshot,
  latestSnapshot,
  listSnapshots,
  type PositionSnapshot,
} from '../lib/storage.js';
import {
  getWalletUniswapPositions,
  type AnyPosition,
  type WalletLpReadResult,
  walletInputSchema,
} from './lp-position.service.js';
import { positionKey, valuePositions } from './valuation.service.js';

function chainIdForChain(chain: 'robinhood' | 'bsc' | 'base' | undefined, override: number | undefined): number {
  if (override !== undefined) return override;
  if (chain === 'bsc') return 56;
  if (chain === 'base') return 8453;
  return 4663;
}

function publicClientForChain(chain: 'robinhood' | 'bsc' | 'base') {
  if (chain === 'bsc') return publicClientBsc;
  if (chain === 'base') return publicClientBase;
  return publicClient;
}

export type PositionChangeField = {
  field: string;
  from: string;
  to: string;
};

export type PositionChange =
  | {
      kind: 'opened';
      key: string;
      position: AnyPosition;
    }
  | {
      kind: 'closed';
      key: string;
      position: AnyPosition;
    }
  | {
      kind: 'modified';
      key: string;
      position: AnyPosition;
      fields: PositionChangeField[];
    };

export type TrackResult = {
  wallet: Address;
  chainId: number;
  trackedAt: string;
  blockNumber: string;
  read: WalletLpReadResult;
  valuation: Awaited<ReturnType<typeof valuePositions>>;
  previous: {
    id: string;
    timestamp: string;
    blockNumber: string;
    totalUsd: number | null;
  } | null;
  changes: PositionChange[];
};

export async function trackWalletPositions(input: unknown): Promise<TrackResult> {
  const query = walletInputSchema.parse(input);
  const wallet = getAddress(query.wallet);

  const [read, blockNumber] = await Promise.all([
    getWalletUniswapPositions(query),
    publicClientForChain(query.chain).getBlockNumber(),
  ]);

  const valuation = await valuePositions(read.positions, read.chainId);
  const previous = latestSnapshot(wallet);

  const snapshot: PositionSnapshot = {
    id: `${Date.now()}`,
    timestamp: new Date().toISOString(),
    blockNumber: blockNumber.toString(),
    positionsCount: read.positions.length,
    byProtocol: read.summary.byProtocol,
    totalUsd: valuation.totalUsd,
    positions: read.positions,
  };

  appendSnapshot(wallet, snapshot);

  return {
    wallet,
    chainId: read.chainId,
    trackedAt: snapshot.timestamp,
    blockNumber: snapshot.blockNumber,
    read,
    valuation,
    previous: previous
      ? {
          id: previous.id,
          timestamp: previous.timestamp,
          blockNumber: previous.blockNumber,
          totalUsd: previous.totalUsd,
        }
      : null,
    changes: previous ? diffPositions(previous.positions, read.positions) : markAllOpened(read.positions),
  };
}

export type HistorySnapshot = {
  id: string;
  timestamp: string;
  blockNumber: string;
  positionsCount: number;
  byProtocol: PositionSnapshot['byProtocol'];
  totalUsd: number | null;
};

export type HistoryResult = {
  wallet: Address;
  chainId: number;
  snapshots: HistorySnapshot[];
};

export async function getWalletHistory(input: unknown): Promise<HistoryResult> {
  const query = walletInputSchema.parse(input);
  const wallet = getAddress(query.wallet);

  const snapshots = listSnapshots(wallet).map((snapshot) => ({
    id: snapshot.id,
    timestamp: snapshot.timestamp,
    blockNumber: snapshot.blockNumber,
    positionsCount: snapshot.positionsCount,
    byProtocol: snapshot.byProtocol,
    totalUsd: snapshot.totalUsd,
  }));

  return {
    wallet,
    chainId: chainIdForChain(query.chain, query.chainId),
    snapshots,
  };
}

export type DiffResult = {
  wallet: Address;
  chainId: number;
  previous: PositionSnapshot | null;
  current: PositionSnapshot | null;
  changes: PositionChange[];
  valuation: Awaited<ReturnType<typeof valuePositions>> | null;
};

export async function getWalletDiff(input: unknown): Promise<DiffResult> {
  const query = walletInputSchema.parse(input);
  const wallet = getAddress(query.wallet);

  const snapshots = listSnapshots(wallet);
  if (snapshots.length < 2) {
    throw new Error(`Not enough snapshots recorded for ${wallet}. Run \`track\` twice first.`);
  }

  const previous = snapshots[snapshots.length - 2];
  const current = snapshots[snapshots.length - 1];

  return {
    wallet,
    chainId: chainIdForChain(query.chain, query.chainId),
    previous,
    current,
    changes: diffPositions(previous.positions, current.positions),
    valuation: null,
  };
}

export function diffPositions(previous: AnyPosition[], current: AnyPosition[]): PositionChange[] {
  const previousByKey = new Map(previous.map((position) => [positionKey(position), position]));
  const currentByKey = new Map(current.map((position) => [positionKey(position), position]));

  const changes: PositionChange[] = [];

  for (const [key, position] of currentByKey) {
    const before = previousByKey.get(key);
    if (!before) {
      changes.push({ kind: 'opened', key, position });
    }
  }

  for (const [key, position] of previousByKey) {
    if (!currentByKey.has(key)) {
      changes.push({ kind: 'closed', key, position });
    }
  }

  for (const [key, position] of currentByKey) {
    const before = previousByKey.get(key);
    if (!before) continue;

    const fields = diffPositionFields(before, position);
    if (fields.length > 0) {
      changes.push({ kind: 'modified', key, position, fields });
    }
  }

  return changes;
}

function diffPositionFields(previous: AnyPosition, current: AnyPosition): PositionChangeField[] {
  const fields: PositionChangeField[] = [];

  const pushIfChanged = (field: string, before: string | number | boolean, after: string | number | boolean) => {
    if (String(before) !== String(after)) {
      fields.push({ field, from: String(before), to: String(after) });
    }
  };

  if (previous.protocol === 'v2' && current.protocol === 'v2') {
    pushIfChanged('lpBalance', previous.lpBalance, current.lpBalance);
    pushIfChanged('principal0', previous.token0.principal, current.token0.principal);
    pushIfChanged('principal1', previous.token1.principal, current.token1.principal);
  }

  if (previous.protocol === 'v3' && current.protocol === 'v3') {
    pushIfChanged('liquidity', previous.liquidity, current.liquidity);
    pushIfChanged('principal0', previous.token0.principal, current.token0.principal);
    pushIfChanged('principal1', previous.token1.principal, current.token1.principal);
    pushIfChanged('uncollectedFees0', previous.token0.uncollectedFees, current.token0.uncollectedFees);
    pushIfChanged('uncollectedFees1', previous.token1.uncollectedFees, current.token1.uncollectedFees);
    pushIfChanged('tickCurrent', previous.tickCurrent, current.tickCurrent);
    pushIfChanged('inRange', previous.inRange, current.inRange);
  }

  if (previous.protocol === 'v4' && current.protocol === 'v4') {
    pushIfChanged('liquidity', previous.liquidity ?? '', current.liquidity ?? '');
    pushIfChanged('tickLower', previous.tickLower ?? '', current.tickLower ?? '');
    pushIfChanged('tickUpper', previous.tickUpper ?? '', current.tickUpper ?? '');
    pushIfChanged('tickCurrent', previous.tickCurrent ?? '', current.tickCurrent ?? '');
    pushIfChanged('inRange', previous.inRange ?? '', current.inRange ?? '');

    if (previous.token0 && current.token0) {
      pushIfChanged('principal0', previous.token0.principal, current.token0.principal);
      pushIfChanged('uncollectedFees0', previous.token0.uncollectedFees, current.token0.uncollectedFees);
    }
    if (previous.token1 && current.token1) {
      pushIfChanged('principal1', previous.token1.principal, current.token1.principal);
      pushIfChanged('uncollectedFees1', previous.token1.uncollectedFees, current.token1.uncollectedFees);
    }
  }

  return fields;
}

function markAllOpened(positions: AnyPosition[]): PositionChange[] {
  return positions.map((position) => ({ kind: 'opened' as const, key: positionKey(position), position }));
}

export function summarizeChanges(changes: PositionChange[]): string[] {
  const lines: string[] = [];

  for (const change of changes) {
    if (change.kind === 'opened') {
      lines.push(`  opened ${positionLabel(change.position)}`);
      continue;
    }

    if (change.kind === 'closed') {
      lines.push(`  closed ${positionLabel(change.position)}`);
      continue;
    }

    lines.push(`  updated ${positionLabel(change.position)}`);
    for (const field of change.fields) {
      lines.push(`    ${field.field}: ${field.from} -> ${field.to}`);
    }
  }

  return lines;
}

function positionLabel(position: AnyPosition): string {
  if (position.protocol === 'v2') return `v2 ${position.pairSymbol}`;
  if (position.protocol === 'v3') {
    return `v3 #${position.tokenId} ${position.token0.symbol}/${position.token1.symbol}`;
  }
  if (position.token0 && position.token1) {
    return `v4 #${position.tokenId} ${position.token0.symbol}/${position.token1.symbol}`;
  }
  return `v4 #${position.tokenId}`;
}
