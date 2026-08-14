import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { getAddress, type Address } from 'viem';

import { env } from '../config/env.js';
import type { AnyPosition } from '../services/lp-position.service.js';

export type PositionSnapshot = {
  id: string;
  timestamp: string;
  blockNumber: string;
  positionsCount: number;
  byProtocol: {
    v2: number;
    v3: number;
    v4: number;
  };
  totalUsd: number | null;
  positions: AnyPosition[];
};

export type SnapshotStore = {
  wallet: Address;
  chainId: number;
  createdAt: string;
  updatedAt: string;
  snapshots: PositionSnapshot[];
};

function snapshotFilePath(wallet: Address): string {
  const normalized = getAddress(wallet).toLowerCase();
  return join(env.RH_DATA_DIR, `${normalized}.json`);
}

function defaultStore(wallet: Address): SnapshotStore {
  const normalized = getAddress(wallet);
  const now = new Date().toISOString();

  return {
    wallet: normalized,
    chainId: env.RH_CHAIN_ID,
    createdAt: now,
    updatedAt: now,
    snapshots: [],
  };
}

export function loadSnapshotStore(wallet: Address): SnapshotStore {
  const filePath = snapshotFilePath(wallet);

  if (!existsSync(filePath)) {
    return defaultStore(wallet);
  }

  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as Partial<SnapshotStore>;
    return {
      ...defaultStore(wallet),
      ...parsed,
      wallet: getAddress(parsed.wallet ?? wallet),
      snapshots: Array.isArray(parsed.snapshots) ? parsed.snapshots : [],
    };
  } catch {
    return defaultStore(wallet);
  }
}

export function appendSnapshot(wallet: Address, snapshot: PositionSnapshot): SnapshotStore {
  const store = loadSnapshotStore(wallet);
  store.snapshots.push(snapshot);

  if (store.snapshots.length > env.RH_MAX_SNAPSHOTS) {
    store.snapshots = store.snapshots.slice(-env.RH_MAX_SNAPSHOTS);
  }

  store.updatedAt = new Date().toISOString();

  const filePath = snapshotFilePath(wallet);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(store, null, 2)}\n`, 'utf8');

  return store;
}

export function latestSnapshot(wallet: Address): PositionSnapshot | null {
  const store = loadSnapshotStore(wallet);
  return store.snapshots.length > 0 ? store.snapshots[store.snapshots.length - 1] : null;
}

export function listSnapshots(wallet: Address): PositionSnapshot[] {
  return loadSnapshotStore(wallet).snapshots;
}

type NftAgeCache = Record<string, string>;

function nftAgeCacheFilePath(): string {
  return join(env.RH_DATA_DIR, 'cache', 'nft-age.json');
}

export function loadNftAgeCache(): NftAgeCache {
  const filePath = nftAgeCacheFilePath();

  if (!existsSync(filePath)) return {};

  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as NftAgeCache;
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

export function saveNftAgeCache(cache: NftAgeCache): void {
  const filePath = nftAgeCacheFilePath();
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(cache)}\n`, 'utf8');
}
