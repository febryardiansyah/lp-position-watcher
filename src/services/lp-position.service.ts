import { encodeAbiParameters, getAddress, keccak256, type Address, type PublicClient } from 'viem';
import { z } from 'zod';

import {
  BASE_CONFIG,
  BSC_CONFIG,
  ROBINHOOD_CHAIN,
  UNISWAP_CONTRACTS,
  type ChainName,
} from '../constants/chain.js';
import { env } from '../config/env.js';
import { publicClientBase } from '../lib/base-public-client.js';
import { publicClientBsc } from '../lib/bsc-public-client.js';
import { getNftTransferHistory } from '../lib/bscscan.js';
import { fetchJson } from '../lib/http.js';
import { publicClient } from '../lib/public-client.js';
import { loadNftAgeCache, saveNftAgeCache } from '../lib/storage.js';
import { extractAlchemyKey, fetchAlchemyNftTokenIds } from '../lib/alchemy-nft.js';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const ROBINHOOD_BLOCKSCOUT_API_BASE = 'https://robinhoodchain.blockscout.com/api';
const MAX_UINT128 = (2n ** 128n) - 1n;
const MAX_UINT256 = (2n ** 256n) - 1n;

function blockscoutApiBaseFor(chain: ChainName): string {
  if (chain === 'base') return BASE_CONFIG.blockscoutApiBase;
  return ROBINHOOD_BLOCKSCOUT_API_BASE;
}

export const walletInputSchema = z.object({
  wallet: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/, 'wallet must be a valid EVM address')
    .transform((value) => getAddress(value)),
  chain: z.enum(['robinhood', 'bsc', 'base']).default('robinhood'),
  chainId: z.coerce.number().int().positive().optional(),
  protocol: z.enum(['all', 'v2', 'v3', 'v4']).default('all'),
});

export type ProtocolFilter = z.infer<typeof walletInputSchema>['protocol'];

export type TokenMetadata = {
  address: Address;
  symbol: string;
  decimals: number;
};

export type V2Position = {
  protocol: 'v2';
  pairAddress: Address;
  pairSymbol: string;
  lpBalance: string;
  lpTotalSupply: string;
  poolSharePct: string;
  createdAt: string | null;
  token0: TokenMetadata & { principal: string };
  token1: TokenMetadata & { principal: string };
};

export type V3Position = {
  protocol: 'v3';
  provider: 'uniswap' | 'pancake';
  tokenId: string;
  poolAddress: Address;
  feeTier: number;
  tickLower: number;
  tickUpper: number;
  tickCurrent: number;
  sqrtPriceX96: string;
  inRange: boolean;
  liquidity: string;
  createdAt: string | null;
  token0: TokenMetadata & {
    principal: string;
    uncollectedFees: string;
  };
  token1: TokenMetadata & {
    principal: string;
    uncollectedFees: string;
  };
};

export type V4Position = {
  protocol: 'v4';
  tokenId: string;
  liquidity: string | null;
  tickLower: number | null;
  tickUpper: number | null;
  tickCurrent: number | null;
  sqrtPriceX96: string | null;
  inRange: boolean | null;
  lpFee: number | null;
  hasSubscriber: boolean | null;
  createdAt: string | null;
  poolKey: {
    currency0: Address;
    currency1: Address;
    fee: number;
    tickSpacing: number;
    hooks: Address;
  } | null;
  token0:
    | (TokenMetadata & {
        principal: string;
        uncollectedFees: string;
      })
    | null;
  token1:
    | (TokenMetadata & {
        principal: string;
        uncollectedFees: string;
      })
    | null;
  readError?: string;
};

export type AnyPosition = V2Position | V3Position | V4Position;

export type WalletLpReadResult = {
  wallet: Address;
  chainId: number;
  chainName: ChainName;
  protocol: ProtocolFilter;
  summary: {
    positionsOpen: number;
    byProtocol: {
      v2: number;
      v3: number;
      v4: number;
    };
    byProvider: {
      uniswap: number;
      pancake: number;
    };
  };
  positions: AnyPosition[];
  notes: string[];
};

type BlockscoutTokenItem = {
  balance: string;
  contractAddress: string;
  decimals: string;
  name: string;
  symbol: string;
  type: string;
};

type BlockscoutV2PageParams = Record<string, string | number | boolean | null>;

type BlockscoutV2ListResponse<T> = {
  items: T[];
  next_page_params: BlockscoutV2PageParams | null;
};

type BlockscoutV2TokenBalanceItem = {
  token: {
    address_hash: string;
    symbol: string | null;
    decimals: string | null;
    type: string;
  };
  value: string;
};

type BlockscoutV2NftInstanceItem = {
  id: string;
  token?: {
    address_hash?: string;
  };
};

const erc20MetadataAbi = [
  {
    type: 'function',
    name: 'symbol',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'string' }],
  },
  {
    type: 'function',
    name: 'decimals',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint8' }],
  },
] as const;

const v2PairAbi = [
  {
    type: 'function',
    name: 'factory',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'token0',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'token1',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'getReserves',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { name: '_reserve0', type: 'uint112' },
      { name: '_reserve1', type: 'uint112' },
      { name: '_blockTimestampLast', type: 'uint32' },
    ],
  },
  {
    type: 'function',
    name: 'totalSupply',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

const v3NpmAbi = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'tokenOfOwnerByIndex',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'index', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'positions',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [
      { name: 'nonce', type: 'uint96' },
      { name: 'operator', type: 'address' },
      { name: 'token0', type: 'address' },
      { name: 'token1', type: 'address' },
      { name: 'fee', type: 'uint24' },
      { name: 'tickLower', type: 'int24' },
      { name: 'tickUpper', type: 'int24' },
      { name: 'liquidity', type: 'uint128' },
      { name: 'feeGrowthInside0LastX128', type: 'uint256' },
      { name: 'feeGrowthInside1LastX128', type: 'uint256' },
      { name: 'tokensOwed0', type: 'uint128' },
      { name: 'tokensOwed1', type: 'uint128' },
    ],
  },
  {
    type: 'function',
    name: 'collect',
    stateMutability: 'payable',
    inputs: [
      {
        name: 'params',
        type: 'tuple',
        components: [
          { name: 'tokenId', type: 'uint256' },
          { name: 'recipient', type: 'address' },
          { name: 'amount0Max', type: 'uint128' },
          { name: 'amount1Max', type: 'uint128' },
        ],
      },
    ],
    outputs: [
      { name: 'amount0', type: 'uint256' },
      { name: 'amount1', type: 'uint256' },
    ],
  },
  {
    type: 'function',
    name: 'decreaseLiquidity',
    stateMutability: 'payable',
    inputs: [
      {
        name: 'params',
        type: 'tuple',
        components: [
          { name: 'tokenId', type: 'uint256' },
          { name: 'liquidity', type: 'uint128' },
          { name: 'amount0Min', type: 'uint256' },
          { name: 'amount1Min', type: 'uint256' },
          { name: 'deadline', type: 'uint256' },
        ],
      },
    ],
    outputs: [
      { name: 'amount0', type: 'uint256' },
      { name: 'amount1', type: 'uint256' },
    ],
  },
] as const;

const pancakeV3NpmAbi = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'tokenOfOwnerByIndex',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'index', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'positions',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [
      { name: 'nonce', type: 'uint96' },
      { name: 'operator', type: 'address' },
      { name: 'token0', type: 'address' },
      { name: 'token1', type: 'address' },
      { name: 'fee', type: 'uint24' },
      { name: 'tickLower', type: 'int24' },
      { name: 'tickUpper', type: 'int24' },
      { name: 'liquidity', type: 'uint128' },
      { name: 'feeGrowthInside0LastX128', type: 'uint256' },
      { name: 'feeGrowthInside1LastX128', type: 'uint256' },
      { name: 'tokensOwed0', type: 'uint128' },
      { name: 'tokensOwed1', type: 'uint128' },
    ],
  },
  {
    type: 'function',
    name: 'collect',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'params',
        type: 'tuple',
        components: [
          { name: 'tokenId', type: 'uint256' },
          { name: 'recipient', type: 'address' },
          { name: 'amount0Max', type: 'uint128' },
          { name: 'amount1Max', type: 'uint128' },
        ],
      },
    ],
    outputs: [
      { name: 'amount0', type: 'uint256' },
      { name: 'amount1', type: 'uint256' },
    ],
  },
  {
    type: 'function',
    name: 'decreaseLiquidity',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'params',
        type: 'tuple',
        components: [
          { name: 'tokenId', type: 'uint256' },
          { name: 'liquidity', type: 'uint128' },
          { name: 'amount0Min', type: 'uint256' },
          { name: 'amount1Min', type: 'uint256' },
          { name: 'deadline', type: 'uint256' },
        ],
      },
    ],
    outputs: [
      { name: 'amount0', type: 'uint256' },
      { name: 'amount1', type: 'uint256' },
    ],
  },
] as const;

const v3FactoryAbi = [
  {
    type: 'function',
    name: 'getPool',
    stateMutability: 'view',
    inputs: [
      { name: 'tokenA', type: 'address' },
      { name: 'tokenB', type: 'address' },
      { name: 'fee', type: 'uint24' },
    ],
    outputs: [{ name: 'pool', type: 'address' }],
  },
] as const;

const v3PoolAbi = [
  {
    type: 'function',
    name: 'slot0',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { name: 'sqrtPriceX96', type: 'uint160' },
      { name: 'tick', type: 'int24' },
      { name: 'observationIndex', type: 'uint16' },
      { name: 'observationCardinality', type: 'uint16' },
      { name: 'observationCardinalityNext', type: 'uint16' },
      { name: 'feeProtocol', type: 'uint8' },
      { name: 'unlocked', type: 'bool' },
    ],
  },
] as const;

const erc721OwnerOfAbi = [
  {
    type: 'function',
    name: 'ownerOf',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [{ name: '', type: 'address' }],
  },
] as const;

const v4PositionManagerAbi = [
  {
    type: 'function',
    name: 'getPoolAndPositionInfo',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [
      {
        name: 'poolKey',
        type: 'tuple',
        components: [
          { name: 'currency0', type: 'address' },
          { name: 'currency1', type: 'address' },
          { name: 'fee', type: 'uint24' },
          { name: 'tickSpacing', type: 'int24' },
          { name: 'hooks', type: 'address' },
        ],
      },
      { name: 'info', type: 'uint256' },
    ],
  },
  {
    type: 'function',
    name: 'getPositionLiquidity',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [{ name: 'liquidity', type: 'uint128' }],
  },
] as const;

const v4StateViewAbi = [
  {
    type: 'function',
    name: 'getSlot0',
    stateMutability: 'view',
    inputs: [{ name: 'poolId', type: 'bytes32' }],
    outputs: [
      { name: 'sqrtPriceX96', type: 'uint160' },
      { name: 'tick', type: 'int24' },
      { name: 'protocolFee', type: 'uint24' },
      { name: 'lpFee', type: 'uint24' },
    ],
  },
  {
    type: 'function',
    name: 'getPositionInfo',
    stateMutability: 'view',
    inputs: [
      { name: 'poolId', type: 'bytes32' },
      { name: 'owner', type: 'address' },
      { name: 'tickLower', type: 'int24' },
      { name: 'tickUpper', type: 'int24' },
      { name: 'salt', type: 'bytes32' },
    ],
    outputs: [
      { name: 'liquidity', type: 'uint128' },
      { name: 'feeGrowthInside0LastX128', type: 'uint256' },
      { name: 'feeGrowthInside1LastX128', type: 'uint256' },
    ],
  },
  {
    type: 'function',
    name: 'getFeeGrowthInside',
    stateMutability: 'view',
    inputs: [
      { name: 'poolId', type: 'bytes32' },
      { name: 'tickLower', type: 'int24' },
      { name: 'tickUpper', type: 'int24' },
    ],
    outputs: [
      { name: 'feeGrowthInside0X128', type: 'uint256' },
      { name: 'feeGrowthInside1X128', type: 'uint256' },
    ],
  },
] as const;

const tokenMetadataCache = new Map<string, Promise<TokenMetadata>>();

export async function getWalletUniswapPositions(input: unknown): Promise<WalletLpReadResult> {
  const raw = walletInputSchema.parse(input);
  const query = {
    ...raw,
    chain: raw.chain,
    chainId:
      raw.chainId ??
      (raw.chain === 'bsc' ? BSC_CONFIG.id : raw.chain === 'base' ? BASE_CONFIG.id : ROBINHOOD_CHAIN.id),
  };

  if (query.chain === 'robinhood' && query.chainId !== ROBINHOOD_CHAIN.id) {
    throw new Error(
      `Unsupported chainId ${query.chainId}. This script currently supports Robinhood Chain (${ROBINHOOD_CHAIN.id}) only on the robinhood chain.`,
    );
  }

  if (query.chain === 'bsc' && query.chainId !== BSC_CONFIG.id) {
    throw new Error(
      `Unsupported chainId ${query.chainId}. BSC path uses chain ${BSC_CONFIG.id}.`,
    );
  }

  if (query.chain === 'base' && query.chainId !== BASE_CONFIG.id) {
    throw new Error(
      `Unsupported chainId ${query.chainId}. Base path uses chain ${BASE_CONFIG.id}.`,
    );
  }

  const owner = query.wallet as Address;
  const includeV2 = query.protocol === 'all' || query.protocol === 'v2';
  const includeV3 = query.protocol === 'all' || query.protocol === 'v3';
  const includeV4 = query.protocol === 'all' || query.protocol === 'v4';

  let v2Positions: V2Position[] = [];
  let v3Uniswap: V3Position[] = [];
  let v3Pancake: V3Position[] = [];
  let v4Positions: V4Position[] = [];

  if (query.chain === 'robinhood') {
    [v2Positions, v3Uniswap, v4Positions] = await Promise.all([
      includeV2
        ? readV2Positions(owner, publicClient, UNISWAP_CONTRACTS.v2Factory as Address, blockscoutApiBaseFor('robinhood'))
        : Promise.resolve([]),
      includeV3 ? readV3Positions(owner, publicClient, UNISWAP_CONTRACTS, blockscoutApiBaseFor('robinhood')) : Promise.resolve([]),
      includeV4 ? readV4Positions(owner, publicClient, UNISWAP_CONTRACTS, blockscoutApiBaseFor('robinhood')) : Promise.resolve([]),
    ]);
  } else if (query.chain === 'base') {
    [v2Positions, v3Uniswap, v4Positions] = await Promise.all([
      includeV2
        ? readV2Positions(owner, publicClientBase, BASE_CONFIG.uniswap.v2Factory as Address, blockscoutApiBaseFor('base'))
        : Promise.resolve([]),
      includeV3 ? readV3Positions(owner, publicClientBase, BASE_CONFIG.uniswap, blockscoutApiBaseFor('base')) : Promise.resolve([]),
      includeV4 ? readV4Positions(owner, publicClientBase, BASE_CONFIG.uniswap, blockscoutApiBaseFor('base')) : Promise.resolve([]),
    ]);
  } else {
    [v3Pancake] = await Promise.all([
      includeV3 ? readPancakeV3Positions(owner, env.BSCSCAN_API_KEY) : Promise.resolve([]),
    ]);
  }

  const v3Positions: V3Position[] = [...v3Uniswap, ...v3Pancake];
  const positions: AnyPosition[] = [...v2Positions, ...v3Positions, ...v4Positions];

  if (query.chain === 'robinhood' || query.chain === 'base') {
    flushNftAgeCache();
  }

  return {
    wallet: owner,
    chainId: query.chainId,
    chainName: query.chain,
    protocol: query.protocol,
    summary: {
      positionsOpen: positions.length,
      byProtocol: {
        v2: v2Positions.length,
        v3: v3Positions.length,
        v4: v4Positions.length,
      },
      byProvider: {
        uniswap: v3Uniswap.length,
        pancake: v3Pancake.length,
      },
    },
    positions,
    notes: buildReadNotes(query.chain, {
      v2: v2Positions.length,
      v3: v3Positions.length,
      v4: v4Positions.length,
    }),
  };
}

function buildReadNotes(
  chain: ChainName,
  counts: { v2: number; v3: number; v4: number },
): string[] {
  if (chain === 'robinhood') {
    return [
      'Uniswap v2 positions are identified from wallet-held ERC-20s and verified against Uniswap v2 factory.',
      'Uniswap v3 positions include principal and uncollected fees via static simulation.',
      'Uniswap v4 positions are discovered from Blockscout NFT transfer history, then verified by ownerOf.',
      'v4 amounts, in-range status, and uncollected fees are read from the v4 StateView contract (pool slot0, position info, fee growth).',
      'Run `track` to persist a snapshot and diff it against the previous one for PnL-style tracking.',
    ];
  }

  if (chain === 'base') {
    return [
      `Reading Uniswap v2/v3/v4 positions on ${BASE_CONFIG.name} (chain ${BASE_CONFIG.id}).`,
      'Uniswap v2 positions are identified from wallet-held ERC-20s (Base Blockscout) and verified against the Uniswap v2 factory.',
      'Uniswap v3 positions are read via the Uniswap v3 NonfungiblePositionManager; principal and uncollected fees come from static simulation of decreaseLiquidity / collect.',
      'Uniswap v4 positions are discovered from Base Blockscout NFT transfer history, then verified by ownerOf.',
      'v4 amounts, in-range status, and uncollected fees are read from the v4 StateView contract (pool slot0, position info, fee growth).',
    ];
  }

  return [
    `Reading PancakeSwap v3 positions on ${BSC_CONFIG.name} (chain ${BSC_CONFIG.id}).`,
    'Positions are discovered from the PancakeSwap v3 NonfungiblePositionManager (balanceOf / tokenOfOwnerByIndex).',
    'Pool state (sqrtPriceX96, current tick) is read from each PancakeV3Pool via slot0.',
    'Principal and uncollected fees are computed via static simulation of decreaseLiquidity / collect on the position manager.',
    'NFT mint timestamps are fetched from BscScan (set BSCSCAN_API_KEY to lift the 5 req/s free-tier limit).',
    'v2 and v4 positions are not read on BSC in this slice.',
  ];
}

async function readV2Positions(
  owner: Address,
  client: PublicClient,
  v2FactoryAddress: Address,
  blockscoutApiBase: string = ROBINHOOD_BLOCKSCOUT_API_BASE,
): Promise<V2Position[]> {
  const tokens = await fetchWalletTokenList(owner, blockscoutApiBase);
  const v2Factory = v2FactoryAddress.toLowerCase();

  const candidates = tokens
    .filter((token) => token.type === 'ERC-20' && parseBigInt(token.balance) > 0n)
    .map((token) => ({ token, pairAddress: safeAddress(token.contractAddress) }))
    .filter((item): item is { token: (typeof tokens)[number]; pairAddress: Address } =>
      item.pairAddress !== null && parseBigInt(item.token.balance) > 0n,
    );

  if (candidates.length === 0) return [];

  const pairCalls = candidates.flatMap(({ pairAddress }) => [
    { address: pairAddress, abi: v2PairAbi, functionName: 'factory' },
    { address: pairAddress, abi: v2PairAbi, functionName: 'token0' },
    { address: pairAddress, abi: v2PairAbi, functionName: 'token1' },
    { address: pairAddress, abi: v2PairAbi, functionName: 'getReserves' },
    { address: pairAddress, abi: v2PairAbi, functionName: 'totalSupply' },
  ] as MulticallCall[]);

  const pairResults = await multicallReadsOn<unknown>(client, pairCalls);

  const tokenAddresses = candidates.flatMap((_, index) => {
    const token0 = pairResults[index * 5 + 1];
    const token1 = pairResults[index * 5 + 2];
    const result: Address[] = [];
    if (typeof token0 === 'string') result.push(getAddress(token0));
    if (typeof token1 === 'string') result.push(getAddress(token1));
    return result;
  });
  await prefetchTokenMetadataOn(client, tokenAddresses);

  const positions = await mapInBatches(candidates, 16, async ({ token, pairAddress }, index) => {
    const offset = index * 5;
    const factoryAddress = pairResults[offset];
    const token0Raw = pairResults[offset + 1];
    const token1Raw = pairResults[offset + 2];
    const reserves = pairResults[offset + 3];
    const totalSupply = pairResults[offset + 4];

    if (
      typeof factoryAddress !== 'string' ||
      typeof token0Raw !== 'string' ||
      typeof token1Raw !== 'string' ||
      !Array.isArray(reserves) ||
      typeof totalSupply !== 'bigint'
    ) {
      return null;
    }

    if (factoryAddress.toLowerCase() !== v2Factory) return null;
    if (totalSupply === 0n) return null;

    const token0Address = getAddress(token0Raw);
    const token1Address = getAddress(token1Raw);
    const lpBalance = parseBigInt(token.balance);

    const [token0Meta, token1Meta, createdAt] = await Promise.all([
      getTokenMetadataOn(client, token0Address),
      getTokenMetadataOn(client, token1Address),
      fetchV2PairCreatedAt(pairAddress, blockscoutApiBase),
    ]);

    const principal0Raw = (reserves[0] * lpBalance) / totalSupply;
    const principal1Raw = (reserves[1] * lpBalance) / totalSupply;

    return {
      protocol: 'v2',
      pairAddress,
      pairSymbol: token.symbol || 'UNI-V2-LP',
      lpBalance: lpBalance.toString(),
      lpTotalSupply: totalSupply.toString(),
      poolSharePct: formatPercent(lpBalance, totalSupply, 6),
      createdAt,
      token0: {
        ...token0Meta,
        principal: formatUnits(principal0Raw, token0Meta.decimals),
      },
      token1: {
        ...token1Meta,
        principal: formatUnits(principal1Raw, token1Meta.decimals),
      },
    } satisfies V2Position;
  });

  return positions.filter((item): item is V2Position => item !== null);
}

type UniswapContractSet = {
  v3Factory: string;
  v3NonfungiblePositionManager: string;
  v4PoolManager: string;
  v4PositionManager: string;
  v4StateView: string;
};

async function readV3Positions(
  owner: Address,
  client: PublicClient,
  contracts: UniswapContractSet,
  blockscoutApiBase: string = ROBINHOOD_BLOCKSCOUT_API_BASE,
): Promise<V3Position[]> {
  const positionManager = contracts.v3NonfungiblePositionManager as Address;
  const v3Factory = contracts.v3Factory as Address;

  return readV3LikePositions({
    owner,
    client,
    positionManager,
    factory: v3Factory,
    npmAbi: v3NpmAbi,
    provider: 'uniswap',
    fetchCreatedAt: (tokenId) => fetchNftCreatedAt(positionManager, tokenId, blockscoutApiBase),
  });
}

async function readPancakeV3Positions(
  owner: Address,
  bscscanApiKey?: string,
): Promise<V3Position[]> {
  const positionManager = BSC_CONFIG.pancake.v3Npm as Address;
  const pancakeV3Factory = BSC_CONFIG.pancake.v3Factory as Address;

  return readV3LikePositions({
    owner,
    client: publicClientBsc,
    positionManager,
    factory: pancakeV3Factory,
    npmAbi: pancakeV3NpmAbi,
    provider: 'pancake',
    fetchCreatedAt: (tokenId) =>
      getNftTransferHistory(positionManager, tokenId, { apiKey: bscscanApiKey }).then((ts) =>
        ts ? new Date(Number(ts) * 1000).toISOString() : null,
      ),
  });
}

async function readV3LikePositions(args: {
  owner: Address;
  client: PublicClient;
  positionManager: Address;
  factory: Address;
  npmAbi: typeof v3NpmAbi | typeof pancakeV3NpmAbi;
  provider: 'uniswap' | 'pancake';
  fetchCreatedAt: (tokenId: bigint) => Promise<string | null>;
}): Promise<V3Position[]> {
  const { owner, client, positionManager, factory, npmAbi, provider, fetchCreatedAt } = args;

  const balance = await client.readContract({
    address: positionManager,
    abi: npmAbi,
    functionName: 'balanceOf',
    args: [owner],
  });

  const tokenIds = (await multicallReadsOn<bigint>(
    client,
    Array.from({ length: Number(balance) }, (_, index) => ({
      address: positionManager,
      abi: npmAbi,
      functionName: 'tokenOfOwnerByIndex',
      args: [owner, BigInt(index)],
    })),
  )).filter((id): id is bigint => id !== null);

  if (tokenIds.length === 0) return [];

  const positionDataResults = await multicallReadsOn<
    readonly [bigint, Address, Address, Address, number, number, number, bigint, bigint, bigint, bigint, bigint]
  >(
    client,
    tokenIds.map((tokenId) => ({
      address: positionManager,
      abi: npmAbi,
      functionName: 'positions',
      args: [tokenId],
    })),
  );

  const validPositions = tokenIds
    .map((tokenId, index) => ({ tokenId, data: positionDataResults[index] }))
    .filter(
      (item): item is { tokenId: bigint; data: readonly [bigint, Address, Address, Address, number, number, number, bigint, bigint, bigint, bigint, bigint] } =>
        item.data !== null,
    )
    .map(({ tokenId, data }) => ({
      tokenId,
      token0Address: getAddress(data[2]),
      token1Address: getAddress(data[3]),
      feeTier: Number(data[4]),
      tickLower: Number(data[5]),
      tickUpper: Number(data[6]),
      positionLiquidity: data[7],
    }));

  const poolAddressResults = await multicallReadsOn<Address>(
    client,
    validPositions.map((position) => ({
      address: factory,
      abi: v3FactoryAbi,
      functionName: 'getPool',
      args: [position.token0Address, position.token1Address, position.feeTier],
    })),
  );

  const withPools = validPositions
    .map((position, index) => ({ position, poolAddress: poolAddressResults[index] }))
    .filter(
      (item): item is { position: (typeof validPositions)[number]; poolAddress: Address } =>
        item.poolAddress !== null && item.poolAddress.toLowerCase() !== ZERO_ADDRESS,
    );

  const slot0Results = await multicallReadsOn<V3Slot0>(
    client,
    withPools.map(({ poolAddress }) => ({
      address: poolAddress,
      abi: v3PoolAbi,
      functionName: 'slot0',
    })),
  );

  const tokenAddresses = withPools.flatMap(({ position }) => [position.token0Address, position.token1Address]);
  await prefetchTokenMetadataOn(client, tokenAddresses);

  const positions = await mapInBatches(withPools, 16, async ({ position, poolAddress }, index) => {
    const slot0 = slot0Results[index];
    if (!slot0) return null;

    const token0Meta = await getTokenMetadataOn(client, position.token0Address);
    const token1Meta = await getTokenMetadataOn(client, position.token1Address);
    const createdAt = await fetchCreatedAt(position.tokenId);
    const simulatedCollect = await safeSimulateCollect(client, positionManager, owner, position.tokenId, npmAbi);
    const simulatedDecrease =
      position.positionLiquidity === 0n
        ? [0n, 0n]
        : await safeSimulateDecrease(client, positionManager, owner, position.tokenId, position.positionLiquidity, npmAbi);

    const tickCurrent = Number(slot0[1]);
    const sqrtPriceX96 = slot0[0];

    return {
      protocol: 'v3',
      provider,
      tokenId: position.tokenId.toString(),
      poolAddress: getAddress(poolAddress),
      feeTier: position.feeTier,
      tickLower: position.tickLower,
      tickUpper: position.tickUpper,
      tickCurrent,
      sqrtPriceX96: sqrtPriceX96.toString(),
      inRange: tickCurrent >= position.tickLower && tickCurrent < position.tickUpper,
      liquidity: position.positionLiquidity.toString(),
      createdAt,
      token0: {
        ...token0Meta,
        principal: formatUnits(simulatedDecrease[0], token0Meta.decimals),
        uncollectedFees: formatUnits(simulatedCollect[0], token0Meta.decimals),
      },
      token1: {
        ...token1Meta,
        principal: formatUnits(simulatedDecrease[1], token1Meta.decimals),
        uncollectedFees: formatUnits(simulatedCollect[1], token1Meta.decimals),
      },
    } satisfies V3Position;
  });

  return positions.filter((item): item is V3Position => item !== null);
}

type V3Slot0 = readonly [bigint, number, number, number, number, number, boolean];

async function readV4Positions(
  owner: Address,
  client: PublicClient,
  contracts: UniswapContractSet,
  blockscoutApiBase: string,
): Promise<V4Position[]> {
  const positionManager = contracts.v4PositionManager as Address;
  const stateView = contracts.v4StateView as Address;

  const tokenIds = await fetchWalletNftTokenIds(owner, positionManager, blockscoutApiBase);
  if (tokenIds.length === 0) return [];

  const ownerResults = await multicallReadsOn<Address>(
    client,
    tokenIds.map((tokenId) => ({
      address: positionManager,
      abi: erc721OwnerOfAbi,
      functionName: 'ownerOf',
      args: [tokenId],
    })),
  );

  const ownedTokenIds = tokenIds.filter(
    (tokenId, index) => ownerResults[index]?.toLowerCase() === owner.toLowerCase(),
  );
  if (ownedTokenIds.length === 0) return [];

  const poolInfoResults = await multicallReadsOn<
    readonly [V4PoolKeyResult, bigint]
  >(
    client,
    ownedTokenIds.map((tokenId) => ({
      address: positionManager,
      abi: v4PositionManagerAbi,
      functionName: 'getPoolAndPositionInfo',
      args: [tokenId],
    })),
  );

  type PreparedV4 = {
    tokenId: bigint;
    poolKey: V4PoolKeyResult | null;
    tickLower: number | null;
    tickUpper: number | null;
    hasSubscriber: boolean | null;
    poolId: `0x${string}` | null;
    salt: `0x${string}` | null;
  };

  const prepared: PreparedV4[] = ownedTokenIds.map((tokenId, index) => {
    const poolAndInfo = poolInfoResults[index];
    if (!poolAndInfo) {
      return { tokenId, poolKey: null, tickLower: null, tickUpper: null, hasSubscriber: null, poolId: null, salt: null };
    }

    const poolKey = poolAndInfo[0];
    const decoded = decodeV4Info(poolAndInfo[1]);

    return {
      tokenId,
      poolKey,
      tickLower: decoded.tickLower,
      tickUpper: decoded.tickUpper,
      hasSubscriber: decoded.hasSubscriber,
      poolId: computeV4PoolId({
        currency0: poolKey.currency0,
        currency1: poolKey.currency1,
        fee: poolKey.fee,
        tickSpacing: poolKey.tickSpacing,
        hooks: poolKey.hooks,
      }),
      salt: toBytes32(tokenId),
    };
  });

  const valid = prepared.filter(
    (item): item is PreparedV4 & { poolKey: V4PoolKeyResult; poolId: `0x${string}`; salt: `0x${string}`; tickLower: number; tickUpper: number } =>
      item.poolKey !== null && item.poolId !== null && item.salt !== null && item.tickLower !== null && item.tickUpper !== null,
  );

  const [slot0Results, posInfoResults, feeGrowthResults, createdAts] = await Promise.all([
    multicallReadsOn<V4Slot0>(
      client,
      valid.map((item) => ({
        address: stateView,
        abi: v4StateViewAbi,
        functionName: 'getSlot0',
        args: [item.poolId],
      })),
    ),
    multicallReadsOn<V4PositionInfo>(
      client,
      valid.map((item) => ({
        address: stateView,
        abi: v4StateViewAbi,
        functionName: 'getPositionInfo',
        args: [item.poolId, positionManager, item.tickLower, item.tickUpper, item.salt],
      })),
    ),
    multicallReadsOn<V4FeeGrowthInside>(
      client,
      valid.map((item) => ({
        address: stateView,
        abi: v4StateViewAbi,
        functionName: 'getFeeGrowthInside',
        args: [item.poolId, item.tickLower, item.tickUpper],
      })),
    ),
    mapInBatches(ownedTokenIds, 40, (tokenId) =>
      fetchNftCreatedAt(positionManager, tokenId, blockscoutApiBase),
    ),
  ]);

  const tokenAddresses = valid.flatMap((item) => [item.poolKey.currency0, item.poolKey.currency1]);
  await prefetchTokenMetadataOn(client, tokenAddresses);

  const validPositions = await mapInBatches(valid, 16, async (item, index) => {
    const slot0 = slot0Results[index];
    const posInfo = posInfoResults[index];
    const feeGrowthInside = feeGrowthResults[index];
    const createdAt = createdAts[index];

    if (!slot0 || !posInfo || !feeGrowthInside) {
      return {
        protocol: 'v4',
        tokenId: item.tokenId.toString(),
        liquidity: null,
        tickLower: null,
        tickUpper: null,
        tickCurrent: null,
        sqrtPriceX96: null,
        inRange: null,
        lpFee: null,
        hasSubscriber: null,
        createdAt: null,
        poolKey: null,
        token0: null,
        token1: null,
        readError: 'StateView read failed',
      } satisfies V4Position;
    }

    const liquidity = posInfo[0];
    const tickCurrent = Number(slot0[1]);
    const sqrtPriceX96 = slot0[0];
    const inRange = tickCurrent >= item.tickLower && tickCurrent < item.tickUpper;

    const uncollectedFees0 = calculateUncollectedFees(
      feeGrowthInside[0],
      posInfo[1],
      liquidity,
    );
    const uncollectedFees1 = calculateUncollectedFees(
      feeGrowthInside[1],
      posInfo[2],
      liquidity,
    );

    const [amount0, amount1] = liquidityAmounts(
      sqrtPriceX96,
      item.tickLower,
      item.tickUpper,
      tickCurrent,
      liquidity,
    );

    const token0Meta = await getTokenMetadataOn(client, item.poolKey.currency0);
    const token1Meta = await getTokenMetadataOn(client, item.poolKey.currency1);

    return {
      protocol: 'v4',
      tokenId: item.tokenId.toString(),
      liquidity: liquidity.toString(),
      tickLower: item.tickLower,
      tickUpper: item.tickUpper,
      tickCurrent,
      sqrtPriceX96: sqrtPriceX96.toString(),
      inRange,
      lpFee: Number(slot0[3]),
      hasSubscriber: item.hasSubscriber,
      createdAt,
      poolKey: {
        currency0: getAddress(item.poolKey.currency0),
        currency1: getAddress(item.poolKey.currency1),
        fee: Number(item.poolKey.fee),
        tickSpacing: Number(item.poolKey.tickSpacing),
        hooks: getAddress(item.poolKey.hooks),
      },
      token0: {
        ...token0Meta,
        principal: formatUnits(amount0, token0Meta.decimals),
        uncollectedFees: formatUnits(uncollectedFees0, token0Meta.decimals),
      },
      token1: {
        ...token1Meta,
        principal: formatUnits(amount1, token1Meta.decimals),
        uncollectedFees: formatUnits(uncollectedFees1, token1Meta.decimals),
      },
    } satisfies V4Position;
  });

  const validByTokenId = new Map(validPositions.map((position) => [position.tokenId, position]));

  return prepared.map((item) => {
    const position = validByTokenId.get(item.tokenId.toString());
    if (position) return position;

    return {
      protocol: 'v4',
      tokenId: item.tokenId.toString(),
      liquidity: null,
      tickLower: null,
      tickUpper: null,
      tickCurrent: null,
      sqrtPriceX96: null,
      inRange: null,
      lpFee: null,
      hasSubscriber: null,
      createdAt: null,
      poolKey: null,
      token0: null,
      token1: null,
      readError: 'position read failed',
    } satisfies V4Position;
  });
}

type V4PoolKeyResult = {
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
};

type V4Slot0 = readonly [bigint, number, number, number];
type V4PositionInfo = readonly [bigint, bigint, bigint];
type V4FeeGrowthInside = readonly [bigint, bigint];

function computeV4PoolId(poolKey: {
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
}): `0x${string}` {
  return keccak256(
    encodeAbiParameters(
      [
        { type: 'address' },
        { type: 'address' },
        { type: 'uint24' },
        { type: 'int24' },
        { type: 'address' },
      ],
      [
        poolKey.currency0,
        poolKey.currency1,
        poolKey.fee,
        poolKey.tickSpacing,
        poolKey.hooks,
      ],
    ),
  );
}

function toBytes32(value: bigint): `0x${string}` {
  return `0x${value.toString(16).padStart(64, '0')}`;
}

function calculateUncollectedFees(
  feeGrowthInsideNow: bigint,
  feeGrowthInsideLast: bigint,
  liquidity: bigint,
): bigint {
  if (liquidity === 0n) return 0n;
  if (feeGrowthInsideNow < feeGrowthInsideLast) return 0n;
  const delta = feeGrowthInsideNow - feeGrowthInsideLast;
  return (delta * liquidity) / (2n ** 128n);
}

function liquidityAmounts(
  sqrtPriceX96: bigint,
  tickLower: number,
  tickUpper: number,
  tickCurrent: number,
  liquidity: bigint,
): [bigint, bigint] {
  if (liquidity === 0n) return [0n, 0n];

  const sqrtLower = sqrtRatioAtTick(tickLower);
  const sqrtUpper = sqrtRatioAtTick(tickUpper);
  const sqrtCurrent = sqrtPriceX96;

  if (tickCurrent < tickLower) {
    return [getAmount0Delta(sqrtLower, sqrtUpper, liquidity), 0n];
  }

  if (tickCurrent >= tickUpper) {
    return [0n, getAmount1Delta(sqrtLower, sqrtUpper, liquidity)];
  }

  return [
    getAmount0Delta(sqrtCurrent, sqrtUpper, liquidity),
    getAmount1Delta(sqrtLower, sqrtCurrent, liquidity),
  ];
}

function getAmount0Delta(sqrtRatioAX96: bigint, sqrtRatioBX96: bigint, liquidity: bigint): bigint {
  const [min, max] = sqrtRatioAX96 < sqrtRatioBX96
    ? [sqrtRatioAX96, sqrtRatioBX96]
    : [sqrtRatioBX96, sqrtRatioAX96];
  const Q96 = 2n ** 96n;
  return (liquidity * (max - min) * Q96) / (max * min);
}

function getAmount1Delta(sqrtRatioAX96: bigint, sqrtRatioBX96: bigint, liquidity: bigint): bigint {
  const [min, max] = sqrtRatioAX96 < sqrtRatioBX96
    ? [sqrtRatioAX96, sqrtRatioBX96]
    : [sqrtRatioBX96, sqrtRatioAX96];
  const Q96 = 2n ** 96n;
  return (liquidity * (max - min)) / Q96;
}

function sqrtRatioAtTick(tick: number): bigint {
  if (tick <= -887272) return 4295128739n;
  if (tick >= 887272) return 1461446703485210103287273052203988822378723970341n;

  const absTick = Math.abs(tick);
  let ratio = (absTick & 1) !== 0 ? 0xfffcb933bd6fad37aa2d162d1a594001n : 0x100000000000000000000000000000000n;

  if ((absTick & 2) !== 0) ratio = (ratio * 0xfff97272373d413259a46990580e213an) >> 128n;
  if ((absTick & 4) !== 0) ratio = (ratio * 0xfff2e50f5f656932ef12357cf3c7fdccn) >> 128n;
  if ((absTick & 8) !== 0) ratio = (ratio * 0xffe5caca7e10e4e61c3624eaa0941cd0n) >> 128n;
  if ((absTick & 16) !== 0) ratio = (ratio * 0xffcb9843d60f6159c9db58835c926644n) >> 128n;
  if ((absTick & 32) !== 0) ratio = (ratio * 0xff973b41fa98c081472e6896dfb254c0n) >> 128n;
  if ((absTick & 64) !== 0) ratio = (ratio * 0xff2ea16466c96a3843ec78b326b52861n) >> 128n;
  if ((absTick & 128) !== 0) ratio = (ratio * 0xfe5dee046a99a2a811c461f1969c3053n) >> 128n;
  if ((absTick & 256) !== 0) ratio = (ratio * 0xfcbe86c7900a88aedcffc83b479aa3a4n) >> 128n;
  if ((absTick & 512) !== 0) ratio = (ratio * 0xf987a7253ac413176f2b074cf7815e54n) >> 128n;
  if ((absTick & 1024) !== 0) ratio = (ratio * 0xf3392b0822b70005940c7a398e4b70f3n) >> 128n;
  if ((absTick & 2048) !== 0) ratio = (ratio * 0xe7159475a2c29b7443b29c7fa6e889d9n) >> 128n;
  if ((absTick & 4096) !== 0) ratio = (ratio * 0xd097f3bdfd2022b8845ad8f792aa5825n) >> 128n;
  if ((absTick & 8192) !== 0) ratio = (ratio * 0xa9f746462d870fdf8a65dc1f90e061e5n) >> 128n;
  if ((absTick & 16384) !== 0) ratio = (ratio * 0x70d869a156d2a1b890bb3df62baf32f7n) >> 128n;
  if ((absTick & 32768) !== 0) ratio = (ratio * 0x31be135f97d08fd981231505542fcfa6n) >> 128n;
  if ((absTick & 65536) !== 0) ratio = (ratio * 0x9aa508b5b7a84e1c677de54f3e99bc9n) >> 128n;
  if ((absTick & 131072) !== 0) ratio = (ratio * 0x5d6af8dedb81196699c329225ee604n) >> 128n;
  if ((absTick & 262144) !== 0) ratio = (ratio * 0x2216e584f5fa1ea926041bedfe98n) >> 128n;
  if ((absTick & 524288) !== 0) ratio = (ratio * 0x48a170391f7dc42444e8fa2n) >> 128n;

  if (tick > 0) ratio = (2n ** 256n - 1n) / ratio;

  return ratio >> 32n;
}

async function safeSimulateCollect(
  client: PublicClient,
  positionManager: Address,
  owner: Address,
  tokenId: bigint,
  abi: typeof v3NpmAbi | typeof pancakeV3NpmAbi = v3NpmAbi,
): Promise<[bigint, bigint]> {
  try {
    const simulated = await client.simulateContract({
      address: positionManager,
      abi,
      functionName: 'collect',
      args: [
        {
          tokenId,
          recipient: owner,
          amount0Max: MAX_UINT128,
          amount1Max: MAX_UINT128,
        },
      ],
      account: owner,
    });

    return [simulated.result[0], simulated.result[1]];
  } catch {
    return [0n, 0n];
  }
}

async function safeSimulateDecrease(
  client: PublicClient,
  positionManager: Address,
  owner: Address,
  tokenId: bigint,
  liquidity: bigint,
  abi: typeof v3NpmAbi | typeof pancakeV3NpmAbi = v3NpmAbi,
): Promise<[bigint, bigint]> {
  try {
    const simulated = await client.simulateContract({
      address: positionManager,
      abi,
      functionName: 'decreaseLiquidity',
      args: [
        {
          tokenId,
          liquidity,
          amount0Min: 0n,
          amount1Min: 0n,
          deadline: MAX_UINT256,
        },
      ],
      account: owner,
    });

    return [simulated.result[0], simulated.result[1]];
  } catch {
    return [0n, 0n];
  }
}

function decodeV4Info(value: bigint): { tickLower: number; tickUpper: number; hasSubscriber: boolean } {
  const tickUpperRaw = Number((value >> 32n) & 0xffffffn);
  const tickLowerRaw = Number((value >> 8n) & 0xffffffn);

  return {
    tickUpper: signed24(tickUpperRaw),
    tickLower: signed24(tickLowerRaw),
    hasSubscriber: (value & 0xffn) !== 0n,
  };
}

function signed24(raw: number): number {
  return raw >= 0x800000 ? raw - 0x1000000 : raw;
}

async function fetchWalletTokenList(
  owner: Address,
  blockscoutApiBase: string = ROBINHOOD_BLOCKSCOUT_API_BASE,
): Promise<BlockscoutTokenItem[]> {
  try {
    return await fetchWalletTokenListV2(owner, blockscoutApiBase);
  } catch {
    return await fetchWalletTokenListLegacy(owner, blockscoutApiBase);
  }
}

async function fetchWalletTokenListV2(
  owner: Address,
  blockscoutApiBase: string,
): Promise<BlockscoutTokenItem[]> {
  const items: BlockscoutTokenItem[] = [];
  let pageParams: BlockscoutV2PageParams | null = { type: 'ERC-20' };

  while (pageParams) {
    const url = new URL(`${blockscoutApiBase}/v2/addresses/${owner.toLowerCase()}/tokens`);
    for (const [key, value] of Object.entries(pageParams)) {
      if (value !== null && value !== '') url.searchParams.set(key, String(value));
    }

    const data = await fetchJson<BlockscoutV2ListResponse<BlockscoutV2TokenBalanceItem>>(
      url.toString(),
    );

    for (const item of data.items) {
      items.push({
        balance: item.value,
        contractAddress: item.token.address_hash,
        decimals: item.token.decimals ?? '0',
        name: '',
        symbol: item.token.symbol ?? '',
        type: item.token.type,
      });
    }

    pageParams = data.next_page_params;
  }

  return items;
}

async function fetchWalletTokenListLegacy(
  owner: Address,
  blockscoutApiBase: string,
): Promise<BlockscoutTokenItem[]> {
  type LegacyToken = {
    balance: string;
    contractAddress: string;
    decimals: string;
    name: string;
    symbol: string;
    type: string;
  };

  type LegacyResponse = {
    status?: string;
    message?: string;
    result?: LegacyToken[];
  };

  const url = `${blockscoutApiBase}/api?module=account&action=tokenlist&address=${owner.toLowerCase()}`;
  const data = await fetchJson<LegacyResponse>(url);
  if (!Array.isArray(data.result)) return [];

  return data.result.map((item) => ({
    balance: item.balance,
    contractAddress: item.contractAddress,
    decimals: item.decimals ?? '0',
    name: item.name ?? '',
    symbol: item.symbol ?? '',
    type: item.type ?? 'ERC-20',
  }));
}

async function fetchWalletNftTokenIds(
  owner: Address,
  contractAddress: Address,
  blockscoutApiBase: string = ROBINHOOD_BLOCKSCOUT_API_BASE,
): Promise<bigint[]> {
  const alchemyKey = extractAlchemyKey(env.BASE_RPC_URL) ?? extractAlchemyKey(env.RH_RPC_URL);
  if (alchemyKey) {
    try {
      const fromAlchemy = await fetchAlchemyNftTokenIds(owner, contractAddress, { apiKey: alchemyKey });
      if (fromAlchemy.length > 0) return fromAlchemy;
    } catch {
      // fall through to Blockscout
    }
  }

  const collected = new Set<bigint>();
  const target = contractAddress.toLowerCase();
  let pageParams: BlockscoutV2PageParams | null = { type: 'ERC-721' };

  while (pageParams) {
    const url = new URL(
      `${blockscoutApiBase}/v2/addresses/${owner.toLowerCase()}/nft`,
    );
    for (const [key, value] of Object.entries(pageParams)) {
      if (value !== null && value !== '') url.searchParams.set(key, String(value));
    }

    try {
      const data = await fetchJson<BlockscoutV2ListResponse<BlockscoutV2NftInstanceItem>>(
        url.toString(),
      );

      for (const item of data.items) {
        const itemAddress = (item.token?.address_hash ?? '').toLowerCase();
        if (itemAddress !== target) continue;
        const tokenId = parseBigInt(item.id);
        if (tokenId > 0n) collected.add(tokenId);
      }

      pageParams = data.next_page_params;
    } catch {
      // If wallet NFT endpoint 500s (common on Base Blockscout for busy wallets),
      // fall back to paginating every instance of the contract and filtering by owner.
      return await fetchWalletNftTokenIdsByInstanceScan(
        owner,
        contractAddress,
        blockscoutApiBase,
      );
    }
  }

  if (collected.size === 0) {
    return await fetchWalletNftTokenIdsByInstanceScan(
      owner,
      contractAddress,
      blockscoutApiBase,
    );
  }

  return [...collected];
}

async function fetchWalletNftTokenIdsByInstanceScan(
  owner: Address,
  contractAddress: Address,
  blockscoutApiBase: string,
): Promise<bigint[]> {
  const collected = new Set<bigint>();
  const targetOwner = owner.toLowerCase();
  const totalCalls = contractAddress.toLowerCase() === BASE_CONFIG.uniswap.v4PositionManager.toLowerCase() ? 80 : 50;
  let pageParams: BlockscoutV2PageParams | null = null;

  for (let page = 0; page < totalCalls && (page === 0 || pageParams); page++) {
    const url = new URL(
      `${blockscoutApiBase}/v2/tokens/${contractAddress.toLowerCase()}/instances`,
    );
    for (const [key, value] of Object.entries(pageParams ?? {})) {
      if (value !== null && value !== '') url.searchParams.set(key, String(value));
    }

    type InstanceItem = { id: string; owner?: { hash?: string } | null };
    const data = await fetchJson<BlockscoutV2ListResponse<InstanceItem>>(url.toString());

    for (const item of data.items) {
      const ownerHash = (item.owner?.hash ?? '').toLowerCase();
      if (ownerHash !== targetOwner) continue;
      const tokenId = parseBigInt(item.id);
      if (tokenId > 0n) collected.add(tokenId);
    }

    pageParams = data.next_page_params;
    if (collected.size > 0 && page >= 4) break;
  }

  return [...collected];
}

type BlockscoutNftTransferItem = {
  timestamp: string;
  from: { hash: string };
  to: { hash: string };
  method?: string | null;
};

const nftCreatedAtCache = new Map<string, Promise<string | null>>();
const nftAgeDiskCache = loadNftAgeCache();
let nftAgeCacheDirty = false;

function flushNftAgeCache(): void {
  if (nftAgeCacheDirty) {
    saveNftAgeCache(nftAgeDiskCache);
    nftAgeCacheDirty = false;
  }
}

async function fetchNftCreatedAt(
  contractAddress: Address,
  tokenId: bigint,
  blockscoutApiBase: string = ROBINHOOD_BLOCKSCOUT_API_BASE,
): Promise<string | null> {
  const cacheKey = `${contractAddress.toLowerCase()}:${tokenId.toString()}`;
  const cached = nftCreatedAtCache.get(cacheKey);
  if (cached) return cached;

  const diskCached = nftAgeDiskCache[cacheKey];
  if (diskCached) {
    const promise = Promise.resolve(diskCached);
    nftCreatedAtCache.set(cacheKey, promise);
    return promise;
  }

  const promise = (async () => {
    let pageParams: BlockscoutV2PageParams | null = null;
    let earliest: string | null = null;

    try {
      for (let page = 0; page < 50 && (page === 0 || pageParams); page++) {
        const url = new URL(
          `${blockscoutApiBase}/v2/tokens/${contractAddress.toLowerCase()}/instances/${tokenId.toString()}/transfers`,
        );
        for (const [key, value] of Object.entries(pageParams ?? {})) {
          if (value !== null && value !== '') url.searchParams.set(key, String(value));
        }

        const data = await fetchJson<BlockscoutV2ListResponse<BlockscoutNftTransferItem>>(
          url.toString(),
        );

        for (const item of data.items) {
          const from = (item.from?.hash ?? '').toLowerCase();
          if (from === ZERO_ADDRESS) {
            const result = item.timestamp;
            nftAgeDiskCache[cacheKey] = result;
            nftAgeCacheDirty = true;
            return result;
          }
          if (!earliest || item.timestamp < earliest) earliest = item.timestamp;
        }

        pageParams = data.next_page_params;
      }
    } catch {
      return null;
    }

    if (earliest) {
      nftAgeDiskCache[cacheKey] = earliest;
      nftAgeCacheDirty = true;
    }
    return earliest;
  })();

  nftCreatedAtCache.set(cacheKey, promise);
  return promise;
}

const v2CreatedAtCache = new Map<string, Promise<string | null>>();

async function fetchV2PairCreatedAt(
  pairAddress: Address,
  blockscoutApiBase: string = ROBINHOOD_BLOCKSCOUT_API_BASE,
): Promise<string | null> {
  const cacheKey = pairAddress.toLowerCase();
  const cached = v2CreatedAtCache.get(cacheKey);
  if (cached) return cached;

  const promise = (async () => {
    try {
      const address = await fetchJson<{ creation_transaction_hash?: string | null }>(
        `${blockscoutApiBase}/v2/addresses/${pairAddress.toLowerCase()}`,
      );

      const creationTx = address.creation_transaction_hash;
      if (!creationTx) return null;

      const tx = await fetchJson<{ timestamp?: string | null }>(
        `${blockscoutApiBase}/v2/transactions/${creationTx}`,
      );
      return tx.timestamp ?? null;
    } catch {
      return null;
    }
  })();

  v2CreatedAtCache.set(cacheKey, promise);
  return promise;
}

async function getTokenMetadataOn(client: PublicClient, address: Address): Promise<TokenMetadata> {
  const normalized = getAddress(address);
  const chainId = client.chain?.id ?? 0;

  if (normalized.toLowerCase() === ZERO_ADDRESS) {
    return {
      address: normalized,
      symbol: 'ETH',
      decimals: 18,
    };
  }

  const cacheKey = `${chainId}:${normalized.toLowerCase()}`;
  const cached = tokenMetadataCache.get(cacheKey);
  if (cached) return cached;

  const promise = (async () => {
    const [symbol, decimals] = await Promise.all([
      safeReadSymbol(client, normalized, `${normalized.slice(0, 6)}...`),
      safeReadDecimals(client, normalized, 18),
    ]);

    return {
      address: normalized,
      symbol,
      decimals,
    };
  })();

  tokenMetadataCache.set(cacheKey, promise);
  return promise;
}

async function getTokenMetadata(address: Address): Promise<TokenMetadata> {
  return getTokenMetadataOn(publicClient, address);
}

async function safeReadSymbol(
  client: PublicClient,
  address: Address,
  fallback: string,
): Promise<string> {
  try {
    const symbol = await withRetries(() =>
      client.readContract({
        address,
        abi: erc20MetadataAbi,
        functionName: 'symbol',
      }),
    );

    if (!symbol || symbol.trim().length === 0) return fallback;
    return symbol;
  } catch {
    return fallback;
  }
}

async function safeReadDecimals(
  client: PublicClient,
  address: Address,
  fallback: number,
): Promise<number> {
  try {
    const decimals = await withRetries(() =>
      client.readContract({
        address,
        abi: erc20MetadataAbi,
        functionName: 'decimals',
      }),
    );

    return Number(decimals);
  } catch {
    return fallback;
  }
}

function formatUnits(value: bigint, decimals: number): string {
  if (decimals === 0) return value.toString();

  const base = 10n ** BigInt(decimals);
  const whole = value / base;
  const fraction = value % base;

  if (fraction === 0n) return whole.toString();

  const fractionPadded = fraction.toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${whole.toString()}.${fractionPadded}`;
}

function formatPercent(part: bigint, total: bigint, precision: number): string {
  if (total === 0n) return '0';

  const scale = 10n ** BigInt(precision + 2);
  const scaled = (part * scale) / total;
  const whole = scaled / (10n ** BigInt(precision));
  const fraction = scaled % (10n ** BigInt(precision));

  if (fraction === 0n) return whole.toString();

  return `${whole.toString()}.${fraction.toString().padStart(precision, '0').replace(/0+$/, '')}`;
}

function parseBigInt(value: string): bigint {
  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
}

function safeAddress(value: string): Address | null {
  try {
    return getAddress(value);
  } catch {
    return null;
  }
}

async function mapInBatches<T, R>(
  items: readonly T[],
  batchSize: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const result: R[] = [];

  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchResult = await Promise.all(batch.map((item, offset) => fn(item, i + offset)));
    result.push(...batchResult);
  }

  return result;
}

type MulticallCall = {
  address: Address;
  abi: readonly unknown[];
  functionName: string;
  args?: readonly unknown[];
};

type MulticallResult<T> = {
  status: 'success' | 'failure';
  result?: T;
  error?: Error;
};

const MULTICALL_BATCH_SIZE = 64;

async function multicallReads<T>(calls: MulticallCall[]): Promise<(T | null)[]> {
  return multicallReadsOn<T>(publicClient, calls);
}

async function multicallReadsOn<T>(
  client: PublicClient,
  calls: MulticallCall[],
): Promise<(T | null)[]> {
  const results: (T | null)[] = [];

  for (let i = 0; i < calls.length; i += MULTICALL_BATCH_SIZE) {
    const chunk = calls.slice(i, i + MULTICALL_BATCH_SIZE);

    const batch = (await withRetries(() =>
      client.multicall({
        contracts: chunk as never,
        allowFailure: true,
      }),
    )) as unknown as MulticallResult<T>[];

    for (const item of batch) {
      results.push(item.status === 'success' && item.result !== undefined ? item.result : null);
    }
  }

  return results;
}

async function prefetchTokenMetadata(addresses: readonly Address[]): Promise<void> {
  await prefetchTokenMetadataOn(publicClient, addresses);
}

async function prefetchTokenMetadataOn(
  client: PublicClient,
  addresses: readonly Address[],
): Promise<void> {
  const chainId = client.chain?.id ?? 0;
  const unique = [...new Set(addresses.map((address) => getAddress(address).toLowerCase() as Address))];
  const missing = unique.filter((address) => !tokenMetadataCache.has(`${chainId}:${address}`));
  if (missing.length === 0) return;

  const calls: MulticallCall[] = [];
  for (const address of missing) {
    calls.push({ address, abi: erc20MetadataAbi, functionName: 'symbol' });
    calls.push({ address, abi: erc20MetadataAbi, functionName: 'decimals' });
  }

  const results = await multicallReadsOn<string | number>(client, calls);

  for (let i = 0; i < missing.length; i++) {
    const address = missing[i];
    const symbol = results[i * 2];
    const decimals = results[i * 2 + 1];

    tokenMetadataCache.set(
      `${chainId}:${address}`,
      Promise.resolve({
        address,
        symbol: typeof symbol === 'string' && symbol.trim().length > 0 ? symbol : `${address.slice(0, 6)}...`,
        decimals: typeof decimals === 'number' ? decimals : 18,
      }),
    );
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function withRetries<T>(op: () => Promise<T>, attempts = 4): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await op();
    } catch (error) {
      lastError = error;
      await delay(250 * attempt);
    }
  }

  throw lastError;
}
