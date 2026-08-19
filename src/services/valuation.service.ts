import { getAddress, type Address } from 'viem';

import { BSC_CONFIG, ROBINHOOD_CHAIN } from '../constants/chain.js';
import { fetchJson } from '../lib/http.js';
import type { AnyPosition, TokenMetadata } from './lp-position.service.js';

const BLOCKSCOUT_API_BASE = 'https://robinhoodchain.blockscout.com/api';
const DEXSCREENER_API_BASE = 'https://api.dexscreener.com/latest/dex';
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const WETH_ADDRESS = '0x0bd7d308f8e1639fab988df18a8011f41eacad73';

type BlockscoutTokenResponse = {
  symbol?: string | null;
  decimals?: string | null;
  exchange_rate?: string | null;
};

type BlockscoutStatsResponse = {
  coin_price?: string | null;
};

type DexScreenerPair = {
  chainId: string;
  priceUsd: string | null;
  liquidity?: {
    usd: number | null;
  } | null;
};

type DexScreenerTokenResponse = {
  pairs?: DexScreenerPair[];
};

type ChainContext = {
  chainId: number;
  dexscreenerChainId: string;
  nativeSymbol: 'ETH' | 'BNB';
  wrappedAddress: string;
};

const CHAIN_CONTEXTS: Record<'robinhood' | 'bsc', ChainContext> = {
  robinhood: {
    chainId: ROBINHOOD_CHAIN.id,
    dexscreenerChainId: 'robinhood',
    nativeSymbol: 'ETH',
    wrappedAddress: WETH_ADDRESS,
  },
  bsc: {
    chainId: BSC_CONFIG.id,
    dexscreenerChainId: BSC_CONFIG.dexscreenerChainId,
    nativeSymbol: 'BNB',
    wrappedAddress: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
  },
};

const priceCache = new Map<string, Promise<number | null>>();
const poolPriceCache = new Map<string, Promise<PairUsdPrices>>();
const ethPricePromiseByChain = new Map<number, Promise<number | null>>();

export function isEthToken(token: string): boolean {
  const normalized = getAddress(token).toLowerCase();
  return normalized === ZERO_ADDRESS || normalized === WETH_ADDRESS;
}

export function isWrappedBnb(token: string): boolean {
  const normalized = getAddress(token).toLowerCase();
  return normalized === CHAIN_CONTEXTS.bsc.wrappedAddress.toLowerCase();
}

export function isNativeTokenForChain(token: string, chainId: number): boolean {
  const normalized = getAddress(token).toLowerCase();
  if (chainId === ROBINHOOD_CHAIN.id) return isEthToken(normalized);
  if (chainId === BSC_CONFIG.id) return normalized === ZERO_ADDRESS || isWrappedBnb(normalized);
  return false;
}

const STABLECOIN_ADDRESSES_BSC = new Set<string>([
  '0x55d398326f99059ff775485246999027b3197955', // USDT
  '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d', // USDC
  '0xe9e7cea3dedca5984780bafc599bd69add087d56', // BUSD
  '0x1af3f329e8be154074d8769d1ffa4ee058b1dbc3', // DAI
  '0x90c97f71e18723b0cf0dfa30ee176ab653e89f40', // FRAX
  '0x4d15a3a2286d883af0aa1b3f21367843fac63e07', // TUSD
  '0x14016e85a25aeb130656ee3f5d597cefcc921692', // EUROC
]);

export function isUsdStablecoin(token: string, chainId: number): boolean {
  const normalized = getAddress(token).toLowerCase();
  if (chainId === ROBINHOOD_CHAIN.id) {
    return normalized === '0x9702230a8ea53601f5cd2dc00fdbc13d4df174a8' // USDC.e on RH
      || normalized === '0x6dcb1d9b6b4d13683dd3ee10b27ae3d6f4b4c4cd'; // USDC on RH
  }
  if (chainId === BSC_CONFIG.id) return STABLECOIN_ADDRESSES_BSC.has(normalized);
  return false;
}

export function getNativeUsdPrice(chainId: number): Promise<number | null> {
  const cached = ethPricePromiseByChain.get(chainId);
  if (cached) return cached;

  const promise = (async () => {
    const ctx = chainId === BSC_CONFIG.id ? CHAIN_CONTEXTS.bsc : CHAIN_CONTEXTS.robinhood;
    try {
      if (ctx.chainId === ROBINHOOD_CHAIN.id) {
        const data = await fetchJson<BlockscoutStatsResponse>(`${BLOCKSCOUT_API_BASE}/v2/stats`);
        return parsePrice(data.coin_price);
      }
      const data = await fetchJson<DexScreenerTokenResponse>(
        `${DEXSCREENER_API_BASE}/tokens/${ctx.wrappedAddress}`,
      );
      const pairs = (data.pairs ?? [])
        .filter((pair) => pair.chainId === ctx.dexscreenerChainId)
        .filter((pair) => parsePrice(pair.priceUsd) !== null);
      if (pairs.length === 0) return null;
      pairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
      return parsePrice(pairs[0].priceUsd);
    } catch {
      return null;
    }
  })();

  ethPricePromiseByChain.set(chainId, promise);
  return promise;
}

function getDexScreenerUsdPrice(
  token: string,
  dexscreenerChainId: string,
): Promise<number | null> {
  const cacheKey = `dexscreener:${dexscreenerChainId}:${token.toLowerCase()}`;
  const cached = priceCache.get(cacheKey);
  if (cached) return cached;

  const promise = (async () => {
    try {
      const data = await fetchJson<DexScreenerTokenResponse>(
        `${DEXSCREENER_API_BASE}/tokens/${token.toLowerCase()}`,
      );

      const matching = (data.pairs ?? [])
        .filter((pair) => pair.chainId === dexscreenerChainId)
        .filter((pair) => parsePrice(pair.priceUsd) !== null);

      if (matching.length === 0) return null;

      matching.sort(
        (a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0),
      );

      return parsePrice(matching[0].priceUsd);
    } catch {
      return null;
    }
  })();

  priceCache.set(cacheKey, promise);
  return promise;
}

type DexScreenerPairDetail = {
  chainId?: string;
  priceUsd?: string | null;
  baseToken?: { address?: string };
  quoteToken?: { address?: string };
};

type DexScreenerPairResponse = {
  pair?: DexScreenerPairDetail | null;
};

export function getPoolUsdPrices(
  pairAddress: Address,
  chainId: number = ROBINHOOD_CHAIN.id,
  token0: Address,
  token1: Address,
): Promise<PairUsdPrices> {
  const ctx = chainId === BSC_CONFIG.id ? CHAIN_CONTEXTS.bsc : CHAIN_CONTEXTS.robinhood;
  const cacheKey = `pool:${chainId}:${pairAddress.toLowerCase()}`;
  const cached = poolPriceCache.get(cacheKey);
  if (cached) return cached;

  const promise = (async (): Promise<PairUsdPrices> => {
    try {
      const data = await fetchJson<DexScreenerPairResponse>(
        `${DEXSCREENER_API_BASE}/pairs/${ctx.dexscreenerChainId}/${pairAddress.toLowerCase()}`,
      );
      const pair = data.pair;
      if (!pair || pair.chainId !== ctx.dexscreenerChainId) {
        return { price0: null, price1: null };
      }
      const priceUsd = parsePrice(pair.priceUsd ?? null);
      if (priceUsd === null) {
        return { price0: null, price1: null };
      }
      const baseAddr = (pair.baseToken?.address ?? '').toLowerCase();
      const quoteAddr = (pair.quoteToken?.address ?? '').toLowerCase();
      const t0 = token0.toLowerCase();
      const t1 = token1.toLowerCase();
      const t0IsStable = isUsdStablecoin(t0, chainId);
      const t1IsStable = isUsdStablecoin(t1, chainId);
      const baseIsT0 = baseAddr === t0;
      const baseIsT1 = baseAddr === t1;
      const basePricePerUsd = priceUsd;
      if (t0IsStable && t1IsStable) {
        return { price0: 1, price1: 1 };
      }
      if (t0IsStable && baseIsT1) {
        return { price0: 1, price1: basePricePerUsd };
      }
      if (t1IsStable && baseIsT0) {
        return { price0: basePricePerUsd, price1: 1 };
      }
      if (baseIsT0 && quoteAddr === t1) {
        return { price0: priceUsd, price1: null };
      }
      if (baseIsT1 && quoteAddr === t0) {
        return { price0: null, price1: priceUsd };
      }
      return { price0: null, price1: null };
    } catch {
      return { price0: null, price1: null };
    }
  })();

  poolPriceCache.set(cacheKey, promise);
  return promise;
}

export function getUsdPrice(token: Address, chainId: number = ROBINHOOD_CHAIN.id): Promise<number | null> {
  const ctx = chainId === BSC_CONFIG.id ? CHAIN_CONTEXTS.bsc : CHAIN_CONTEXTS.robinhood;
  const normalized = getAddress(token).toLowerCase();
  const cacheKey = `${chainId}:${normalized}`;
  const cached = priceCache.get(cacheKey);
  if (cached) return cached;

  const promise = (async () => {
    try {
      if (isNativeTokenForChain(normalized, chainId)) {
        return await getNativeUsdPrice(chainId);
      }

      if (isUsdStablecoin(normalized, chainId)) {
        return 1;
      }

      const dexPrice = await getDexScreenerUsdPrice(normalized, ctx.dexscreenerChainId);
      if (dexPrice !== null) return dexPrice;

      if (chainId === ROBINHOOD_CHAIN.id) {
        const data = await fetchJson<BlockscoutTokenResponse>(
          `${BLOCKSCOUT_API_BASE}/v2/tokens/${normalized}`,
        );
        return parsePrice(data.exchange_rate);
      }
      return null;
    } catch {
      return null;
    }
  })();

  priceCache.set(cacheKey, promise);
  return promise;
}

function parsePrice(raw: string | null | undefined): number | null {
  if (!raw) return null;

  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
}

export type PairPoolContext =
  | { kind: 'v3'; sqrtPriceX96: string }
  | { kind: 'v2'; amount0: string; amount1: string };

function priceOfToken1InToken0(
  pool: PairPoolContext,
  decimals0: number,
  decimals1: number,
): number | null {
  if (pool.kind === 'v3') {
    const q96 = 2n ** 96n;
    const sqrt = Number(BigInt(pool.sqrtPriceX96)) / Number(q96);
    return sqrt * sqrt * 10 ** (decimals0 - decimals1);
  }

  const amount0 = Number(pool.amount0);
  const amount1 = Number(pool.amount1);
  if (amount0 === 0) return null;

  return (amount1 / amount0) * 10 ** (decimals0 - decimals1);
}

export type PairUsdPrices = {
  price0: number | null;
  price1: number | null;
};

export async function resolvePairPrices(args: {
  token0: Address;
  token1: Address;
  decimals0: number;
  decimals1: number;
  pool: PairPoolContext;
  chainId?: number;
  poolAddress?: Address;
}): Promise<PairUsdPrices> {
  const chainId = args.chainId ?? ROBINHOOD_CHAIN.id;

  if (args.poolAddress) {
    const poolPrices = await getPoolUsdPrices(args.poolAddress, chainId, args.token0, args.token1);
    if (poolPrices.price0 !== null && poolPrices.price1 !== null) {
      return poolPrices;
    }
    const [perToken0, perToken1] = await Promise.all([
      poolPrices.price0 !== null ? Promise.resolve(poolPrices.price0) : getUsdPrice(args.token0, chainId),
      poolPrices.price1 !== null ? Promise.resolve(poolPrices.price1) : getUsdPrice(args.token1, chainId),
    ]);
    const price0 = perToken0;
    const price1 = perToken1;
    if (price0 !== null && price1 !== null) {
      return { price0, price1 };
    }
    const ratio = priceOfToken1InToken0(args.pool, args.decimals0, args.decimals1);
    if (ratio === null || ratio <= 0) {
      return { price0, price1 };
    }
    return {
      price0: price0 ?? (price1 !== null ? price1 / ratio : null),
      price1: price1 ?? (price0 !== null ? price0 * ratio : null),
    };
  }

  const [price0, price1] = await Promise.all([
    getUsdPrice(args.token0, chainId),
    getUsdPrice(args.token1, chainId),
  ]);

  if (price0 !== null && price1 !== null) {
    return { price0, price1 };
  }

  const ratio = priceOfToken1InToken0(args.pool, args.decimals0, args.decimals1);

  if (ratio === null || ratio <= 0) {
    return { price0, price1 };
  }

  return {
    price0: price0 ?? (price1 !== null ? price1 / ratio : null),
    price1: price1 ?? (price0 !== null ? price0 * ratio : null),
  };
}

export type TokenUsdValue = {
  priceUsd: number | null;
  valueUsd: number | null;
};

export type PositionValuation = {
  totalUsd: number | null;
  principalUsd: number | null;
  feesUsd: number | null;
  token0: TokenUsdValue;
  token1: TokenUsdValue;
};

export function positionKey(position: AnyPosition): string {
  switch (position.protocol) {
    case 'v2':
      return `v2:${position.pairAddress.toLowerCase()}`;
    case 'v3':
      return `v3:${position.tokenId}`;
    case 'v4':
      return `v4:${position.tokenId}`;
  }
}

export async function valuePosition(
  position: AnyPosition,
  chainId: number = ROBINHOOD_CHAIN.id,
): Promise<PositionValuation> {
  if (position.protocol === 'v2') {
    const prices = await resolvePairPrices({
      token0: position.token0.address,
      token1: position.token1.address,
      decimals0: position.token0.decimals,
      decimals1: position.token1.decimals,
      pool: {
        kind: 'v2',
        amount0: position.token0.principal,
        amount1: position.token1.principal,
      },
      chainId,
    });

    const amount0 = Number(position.token0.principal);
    const amount1 = Number(position.token1.principal);

    const token0Value = valueToken(amount0, prices.price0);
    const token1Value = valueToken(amount1, prices.price1);
    const principalUsd = sumOrNull([token0Value.valueUsd, token1Value.valueUsd]);

    return {
      totalUsd: principalUsd,
      principalUsd,
      feesUsd: null,
      token0: token0Value,
      token1: token1Value,
    };
  }

  if (position.protocol === 'v3') {
    return valueConcentrated({
      sqrtPriceX96: position.sqrtPriceX96,
      token0: position.token0,
      token1: position.token1,
      chainId,
      poolAddress: position.poolAddress,
    });
  }

  if (position.sqrtPriceX96 === null || position.token0 === null || position.token1 === null) {
    return {
      totalUsd: null,
      principalUsd: null,
      feesUsd: null,
      token0: { priceUsd: null, valueUsd: null },
      token1: { priceUsd: null, valueUsd: null },
    };
  }

  return valueConcentrated({
    sqrtPriceX96: position.sqrtPriceX96,
    token0: position.token0,
    token1: position.token1,
    chainId,
  });
}

async function valueConcentrated(args: {
  sqrtPriceX96: string;
  token0: TokenMetadata & { principal: string; uncollectedFees: string };
  token1: TokenMetadata & { principal: string; uncollectedFees: string };
  chainId?: number;
  poolAddress?: Address;
}): Promise<PositionValuation> {
  const chainId = args.chainId ?? ROBINHOOD_CHAIN.id;
  const prices = await resolvePairPrices({
    token0: args.token0.address,
    token1: args.token1.address,
    decimals0: args.token0.decimals,
    decimals1: args.token1.decimals,
    pool: { kind: 'v3', sqrtPriceX96: args.sqrtPriceX96 },
    chainId,
    poolAddress: args.poolAddress,
  });

  const principal0 = Number(args.token0.principal);
  const principal1 = Number(args.token1.principal);
  const fees0 = Number(args.token0.uncollectedFees);
  const fees1 = Number(args.token1.uncollectedFees);

  const principal0Value = valueToken(principal0, prices.price0);
  const principal1Value = valueToken(principal1, prices.price1);
  const fees0Value = valueToken(fees0, prices.price0);
  const fees1Value = valueToken(fees1, prices.price1);

  const principalUsd = sumOrNull([principal0Value.valueUsd, principal1Value.valueUsd]);
  const feesUsd = sumOrNull([fees0Value.valueUsd, fees1Value.valueUsd]);
  const totalUsd = sumOrNull([principalUsd, feesUsd]);

  return {
    totalUsd,
    principalUsd,
    feesUsd,
    token0: {
      priceUsd: prices.price0,
      valueUsd: sumOrNull([principal0Value.valueUsd, fees0Value.valueUsd]),
    },
    token1: {
      priceUsd: prices.price1,
      valueUsd: sumOrNull([principal1Value.valueUsd, fees1Value.valueUsd]),
    },
  };
}

function valueToken(amount: number, priceUsd: number | null): TokenUsdValue {
  if (priceUsd === null) return { priceUsd: null, valueUsd: null };
  return { priceUsd, valueUsd: amount * priceUsd };
}

function sumOrNull(values: (number | null)[]): number | null {
  const defined = values.filter((value): value is number => value !== null);
  if (defined.length !== values.length || defined.length === 0) return null;
  return defined.reduce((total, value) => total + value, 0);
}

export type WalletValuation = {
  totalUsd: number | null;
  principalUsd: number | null;
  feesUsd: number | null;
  byProtocol: {
    v2: number | null;
    v3: number | null;
    v4: number | null;
  };
  perPosition: Record<string, PositionValuation>;
};

export async function valuePositions(
  positions: AnyPosition[],
  chainId: number = ROBINHOOD_CHAIN.id,
): Promise<WalletValuation> {
  const perPosition: Record<string, PositionValuation> = {};

  for (let i = 0; i < positions.length; i += 10) {
    const batch = positions.slice(i, i + 10);
    const valuations = await Promise.all(batch.map((position) => valuePosition(position, chainId)));
    for (let j = 0; j < batch.length; j++) {
      perPosition[positionKey(batch[j])] = valuations[j];
    }
  }

  const byProtocol: WalletValuation['byProtocol'] = { v2: null, v3: null, v4: null };

  for (const position of positions) {
    const valuation = perPosition[positionKey(position)];
    if (!valuation || valuation.totalUsd === null) continue;

    byProtocol[position.protocol] =
      (byProtocol[position.protocol] ?? 0) + valuation.totalUsd;
  }

  return {
    totalUsd: sumNullable([byProtocol.v2, byProtocol.v3, byProtocol.v4]),
    principalUsd: sumNullable(
      positions.map((position) => perPosition[positionKey(position)]?.principalUsd ?? null),
    ),
    feesUsd: sumNullable(
      positions.map((position) => perPosition[positionKey(position)]?.feesUsd ?? null),
    ),
    byProtocol,
    perPosition,
  };
}

function sumNullable(values: (number | null)[]): number | null {
  const defined = values.filter((value): value is number => value !== null);
  if (defined.length === 0) return null;
  return defined.reduce((total, value) => total + value, 0);
}

export function formatUsd(value: number | null): string {
  if (value === null) return 'n/a';

  if (Math.abs(value) >= 1000) {
    return `$${value.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
  }

  if (Math.abs(value) >= 1) {
    return `$${value.toLocaleString('en-US', { maximumFractionDigits: 4 })}`;
  }

  return `$${value.toLocaleString('en-US', { maximumSignificantDigits: 4 })}`;
}
