import { encodeAbiParameters, getAddress, keccak256, type Address } from 'viem';
import { z } from 'zod';

import { ROBINHOOD_CHAIN, UNISWAP_CONTRACTS } from '../constants/chain.js';
import { fetchJson } from '../lib/http.js';
import { publicClient } from '../lib/public-client.js';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const BLOCKSCOUT_API_BASE = 'https://robinhoodchain.blockscout.com/api';
const MAX_UINT128 = (2n ** 128n) - 1n;
const MAX_UINT256 = (2n ** 256n) - 1n;

export const walletInputSchema = z.object({
  wallet: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/, 'wallet must be a valid EVM address')
    .transform((value) => getAddress(value)),
  chainId: z.coerce.number().int().positive().default(ROBINHOOD_CHAIN.id),
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
  protocol: ProtocolFilter;
  summary: {
    positionsOpen: number;
    byProtocol: {
      v2: number;
      v3: number;
      v4: number;
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
  const query = walletInputSchema.parse(input);

  if (query.chainId !== ROBINHOOD_CHAIN.id) {
    throw new Error(
      `Unsupported chainId ${query.chainId}. This script currently supports Robinhood Chain (${ROBINHOOD_CHAIN.id}) only.`,
    );
  }

  const owner = query.wallet as Address;
  const includeV2 = query.protocol === 'all' || query.protocol === 'v2';
  const includeV3 = query.protocol === 'all' || query.protocol === 'v3';
  const includeV4 = query.protocol === 'all' || query.protocol === 'v4';

  const [v2Positions, v3Positions, v4Positions] = await Promise.all([
    includeV2 ? readV2Positions(owner) : Promise.resolve([]),
    includeV3 ? readV3Positions(owner) : Promise.resolve([]),
    includeV4 ? readV4Positions(owner) : Promise.resolve([]),
  ]);

  const positions: AnyPosition[] = [...v2Positions, ...v3Positions, ...v4Positions];

  return {
    wallet: owner,
    chainId: query.chainId,
    protocol: query.protocol,
    summary: {
      positionsOpen: positions.length,
      byProtocol: {
        v2: v2Positions.length,
        v3: v3Positions.length,
        v4: v4Positions.length,
      },
    },
    positions,
    notes: [
      'Uniswap v2 positions are identified from wallet-held ERC-20s and verified against Uniswap v2 factory.',
      'Uniswap v3 positions include principal and uncollected fees via static simulation.',
      'Uniswap v4 positions are discovered from Blockscout NFT transfer history, then verified by ownerOf.',
      'v4 amounts, in-range status, and uncollected fees are read from the v4 StateView contract (pool slot0, position info, fee growth).',
      'Run `track` to persist a snapshot and diff it against the previous one for PnL-style tracking.',
    ],
  };
}

async function readV2Positions(owner: Address): Promise<V2Position[]> {
  const tokens = await fetchWalletTokenList(owner);
  const v2Factory = (UNISWAP_CONTRACTS.v2Factory as Address).toLowerCase();

  const candidates = tokens.filter((token) => token.type === 'ERC-20' && parseBigInt(token.balance) > 0n);

  const positions = await mapInBatches(candidates, 20, async (token) => {
    const pairAddress = safeAddress(token.contractAddress);
    if (!pairAddress) return null;

    const lpBalance = parseBigInt(token.balance);
    if (lpBalance === 0n) return null;

    let factoryAddress: string;
    let token0Raw: string;
    let token1Raw: string;
    let reserves: readonly [bigint, bigint, number];
    let totalSupply: bigint;

    try {
      [factoryAddress, token0Raw, token1Raw, reserves, totalSupply] = await Promise.all([
        publicClient.readContract({
          address: pairAddress,
          abi: v2PairAbi,
          functionName: 'factory',
        }),
        publicClient.readContract({
          address: pairAddress,
          abi: v2PairAbi,
          functionName: 'token0',
        }),
        publicClient.readContract({
          address: pairAddress,
          abi: v2PairAbi,
          functionName: 'token1',
        }),
        publicClient.readContract({
          address: pairAddress,
          abi: v2PairAbi,
          functionName: 'getReserves',
        }),
        publicClient.readContract({
          address: pairAddress,
          abi: v2PairAbi,
          functionName: 'totalSupply',
        }),
      ]);
    } catch {
      return null;
    }

    if (factoryAddress.toLowerCase() !== v2Factory) return null;
    if (totalSupply === 0n) return null;

    const token0Address = getAddress(token0Raw);
    const token1Address = getAddress(token1Raw);

    const [token0Meta, token1Meta, createdAt] = await Promise.all([
      getTokenMetadata(token0Address),
      getTokenMetadata(token1Address),
      fetchV2PairCreatedAt(pairAddress),
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

async function readV3Positions(owner: Address): Promise<V3Position[]> {
  const positionManager = UNISWAP_CONTRACTS.v3NonfungiblePositionManager as Address;
  const v3Factory = UNISWAP_CONTRACTS.v3Factory as Address;

  const balance = await publicClient.readContract({
    address: positionManager,
    abi: v3NpmAbi,
    functionName: 'balanceOf',
    args: [owner],
  });

  const tokenIds = await Promise.all(
    Array.from({ length: Number(balance) }, async (_, index) =>
      publicClient.readContract({
        address: positionManager,
        abi: v3NpmAbi,
        functionName: 'tokenOfOwnerByIndex',
        args: [owner, BigInt(index)],
      }),
    ),
  );

  const positions = await mapInBatches(tokenIds, 25, async (tokenId) => {
    const positionData = await publicClient.readContract({
      address: positionManager,
      abi: v3NpmAbi,
      functionName: 'positions',
      args: [tokenId],
    });

    const token0Address = getAddress(positionData[2]);
    const token1Address = getAddress(positionData[3]);
    const feeTier = Number(positionData[4]);
    const tickLower = Number(positionData[5]);
    const tickUpper = Number(positionData[6]);
    const positionLiquidity = positionData[7];

    const poolAddress = await publicClient.readContract({
      address: v3Factory,
      abi: v3FactoryAbi,
      functionName: 'getPool',
      args: [token0Address, token1Address, feeTier],
    });

    if (poolAddress === ZERO_ADDRESS) return null;

    const [token0Meta, token1Meta, slot0, createdAt] = await Promise.all([
      getTokenMetadata(token0Address),
      getTokenMetadata(token1Address),
      publicClient.readContract({
        address: poolAddress,
        abi: v3PoolAbi,
        functionName: 'slot0',
      }),
      fetchNftCreatedAt(positionManager, tokenId),
    ]);

    const simulatedCollect = await safeSimulateCollect(positionManager, owner, tokenId);
    const simulatedDecrease =
      positionLiquidity === 0n
        ? [0n, 0n]
        : await safeSimulateDecrease(positionManager, owner, tokenId, positionLiquidity);

    const tickCurrent = Number(slot0[1]);
    const sqrtPriceX96 = slot0[0];

    return {
      protocol: 'v3',
      tokenId: tokenId.toString(),
      poolAddress: getAddress(poolAddress),
      feeTier,
      tickLower,
      tickUpper,
      tickCurrent,
      sqrtPriceX96: sqrtPriceX96.toString(),
      inRange: tickCurrent >= tickLower && tickCurrent < tickUpper,
      liquidity: positionLiquidity.toString(),
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

async function readV4Positions(owner: Address): Promise<V4Position[]> {
  const positionManager = UNISWAP_CONTRACTS.v4PositionManager as Address;
  const stateView = UNISWAP_CONTRACTS.v4StateView as Address;

  const tokenIds = await fetchWalletNftTokenIds(owner, positionManager);
  if (tokenIds.length === 0) return [];

  const currentlyOwnedTokenIds = await mapInBatches(tokenIds, 4, async (tokenId) => {
    try {
      const ownerNow = await withRetries(() =>
        publicClient.readContract({
          address: positionManager,
          abi: erc721OwnerOfAbi,
          functionName: 'ownerOf',
          args: [tokenId],
        }),
      );

      return ownerNow.toLowerCase() === owner.toLowerCase() ? tokenId : null;
    } catch {
      return null;
    }
  });

  const ownedTokenIds = currentlyOwnedTokenIds.filter((id): id is bigint => id !== null);

  const positions = await mapInBatches(ownedTokenIds, 4, async (tokenId) => {
    try {
      const poolAndInfo = await withRetries(() =>
        publicClient.readContract({
          address: positionManager,
          abi: v4PositionManagerAbi,
          functionName: 'getPoolAndPositionInfo',
          args: [tokenId],
        }),
      );

      const poolKey = poolAndInfo[0];
      const packedInfo = poolAndInfo[1];
      const decoded = decodeV4Info(packedInfo);

      const currency0 = getAddress(poolKey.currency0);
      const currency1 = getAddress(poolKey.currency1);

      const poolId = computeV4PoolId({
        currency0: poolKey.currency0,
        currency1: poolKey.currency1,
        fee: poolKey.fee,
        tickSpacing: poolKey.tickSpacing,
        hooks: poolKey.hooks,
      });
      const salt = toBytes32(tokenId);

      const [slot0, posInfo, feeGrowthInside, createdAt] = await Promise.all([
        withRetries(() =>
          publicClient.readContract({
            address: stateView,
            abi: v4StateViewAbi,
            functionName: 'getSlot0',
            args: [poolId],
          }),
        ),
        withRetries(() =>
          publicClient.readContract({
            address: stateView,
            abi: v4StateViewAbi,
            functionName: 'getPositionInfo',
            args: [poolId, positionManager, decoded.tickLower, decoded.tickUpper, salt],
          }),
        ),
        withRetries(() =>
          publicClient.readContract({
            address: stateView,
            abi: v4StateViewAbi,
            functionName: 'getFeeGrowthInside',
            args: [poolId, decoded.tickLower, decoded.tickUpper],
          }),
        ),
        fetchNftCreatedAt(positionManager, tokenId),
      ]);

      const liquidity = posInfo[0];
      const tickCurrent = Number(slot0[1]);
      const sqrtPriceX96 = slot0[0];
      const inRange = tickCurrent >= decoded.tickLower && tickCurrent < decoded.tickUpper;

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
        decoded.tickLower,
        decoded.tickUpper,
        tickCurrent,
        liquidity,
      );

      const [token0Meta, token1Meta] = await Promise.all([
        getTokenMetadata(currency0),
        getTokenMetadata(currency1),
      ]);

      return {
        protocol: 'v4',
        tokenId: tokenId.toString(),
        liquidity: liquidity.toString(),
        tickLower: decoded.tickLower,
        tickUpper: decoded.tickUpper,
        tickCurrent,
        sqrtPriceX96: sqrtPriceX96.toString(),
        inRange,
        lpFee: Number(slot0[3]),
        hasSubscriber: decoded.hasSubscriber,
        createdAt,
        poolKey: {
          currency0,
          currency1,
          fee: Number(poolKey.fee),
          tickSpacing: Number(poolKey.tickSpacing),
          hooks: getAddress(poolKey.hooks),
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
    } catch (error) {
      return {
        protocol: 'v4',
        tokenId: tokenId.toString(),
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
        readError: error instanceof Error ? error.message : String(error),
      } satisfies V4Position;
    }
  });

  return positions;
}

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
  positionManager: Address,
  owner: Address,
  tokenId: bigint,
): Promise<[bigint, bigint]> {
  try {
    const simulated = await publicClient.simulateContract({
      address: positionManager,
      abi: v3NpmAbi,
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
  positionManager: Address,
  owner: Address,
  tokenId: bigint,
  liquidity: bigint,
): Promise<[bigint, bigint]> {
  try {
    const simulated = await publicClient.simulateContract({
      address: positionManager,
      abi: v3NpmAbi,
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

async function fetchWalletTokenList(owner: Address): Promise<BlockscoutTokenItem[]> {
  const items: BlockscoutTokenItem[] = [];
  let pageParams: BlockscoutV2PageParams | null = { type: 'ERC-20' };

  while (pageParams) {
    const url = new URL(`${BLOCKSCOUT_API_BASE}/v2/addresses/${owner.toLowerCase()}/tokens`);
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

async function fetchWalletNftTokenIds(owner: Address, contractAddress: Address): Promise<bigint[]> {
  const collected = new Set<bigint>();
  let pageParams: BlockscoutV2PageParams | null = { holder_address_hash: owner };

  while (pageParams) {
    const url = new URL(
      `${BLOCKSCOUT_API_BASE}/v2/tokens/${contractAddress.toLowerCase()}/instances`,
    );
    for (const [key, value] of Object.entries(pageParams)) {
      if (value !== null && value !== '') url.searchParams.set(key, String(value));
    }

    const data = await fetchJson<BlockscoutV2ListResponse<BlockscoutV2NftInstanceItem>>(
      url.toString(),
    );

    for (const item of data.items) {
      const tokenId = parseBigInt(item.id);
      if (tokenId > 0n) collected.add(tokenId);
    }

    pageParams = data.next_page_params;
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

async function fetchNftCreatedAt(contractAddress: Address, tokenId: bigint): Promise<string | null> {
  const cacheKey = `${contractAddress.toLowerCase()}:${tokenId.toString()}`;
  const cached = nftCreatedAtCache.get(cacheKey);
  if (cached) return cached;

  const promise = (async () => {
    let pageParams: BlockscoutV2PageParams | null = null;
    let earliest: string | null = null;

    try {
      for (let page = 0; page < 50 && (page === 0 || pageParams); page++) {
        const url = new URL(
          `${BLOCKSCOUT_API_BASE}/v2/tokens/${contractAddress.toLowerCase()}/instances/${tokenId.toString()}/transfers`,
        );
        for (const [key, value] of Object.entries(pageParams ?? {})) {
          if (value !== null && value !== '') url.searchParams.set(key, String(value));
        }

        const data = await fetchJson<BlockscoutV2ListResponse<BlockscoutNftTransferItem>>(
          url.toString(),
        );

        for (const item of data.items) {
          const from = (item.from?.hash ?? '').toLowerCase();
          if (from === ZERO_ADDRESS) return item.timestamp;
          if (!earliest || item.timestamp < earliest) earliest = item.timestamp;
        }

        pageParams = data.next_page_params;
      }
    } catch {
      return null;
    }

    return earliest;
  })();

  nftCreatedAtCache.set(cacheKey, promise);
  return promise;
}

const v2CreatedAtCache = new Map<string, Promise<string | null>>();

async function fetchV2PairCreatedAt(pairAddress: Address): Promise<string | null> {
  const cacheKey = pairAddress.toLowerCase();
  const cached = v2CreatedAtCache.get(cacheKey);
  if (cached) return cached;

  const promise = (async () => {
    try {
      const address = await fetchJson<{ creation_transaction_hash?: string | null }>(
        `${BLOCKSCOUT_API_BASE}/v2/addresses/${pairAddress.toLowerCase()}`,
      );

      const creationTx = address.creation_transaction_hash;
      if (!creationTx) return null;

      const tx = await fetchJson<{ timestamp?: string | null }>(
        `${BLOCKSCOUT_API_BASE}/v2/transactions/${creationTx}`,
      );
      return tx.timestamp ?? null;
    } catch {
      return null;
    }
  })();

  v2CreatedAtCache.set(cacheKey, promise);
  return promise;
}

async function getTokenMetadata(address: Address): Promise<TokenMetadata> {
  const normalized = getAddress(address);

  if (normalized.toLowerCase() === ZERO_ADDRESS) {
    return {
      address: normalized,
      symbol: 'ETH',
      decimals: 18,
    };
  }

  const cacheKey = normalized.toLowerCase();
  const cached = tokenMetadataCache.get(cacheKey);
  if (cached) return cached;

  const promise = (async () => {
    const [symbol, decimals] = await Promise.all([
      safeReadSymbol(normalized, `${normalized.slice(0, 6)}...`),
      safeReadDecimals(normalized, 18),
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

async function safeReadSymbol(address: Address, fallback: string): Promise<string> {
  try {
    const symbol = await withRetries(() =>
      publicClient.readContract({
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

async function safeReadDecimals(address: Address, fallback: number): Promise<number> {
  try {
    const decimals = await withRetries(() =>
      publicClient.readContract({
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
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const result: R[] = [];

  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchResult = await Promise.all(batch.map((item) => fn(item)));
    result.push(...batchResult);
  }

  return result;
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
