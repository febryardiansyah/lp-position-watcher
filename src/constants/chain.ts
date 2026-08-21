export const ROBINHOOD_CHAIN = {
  id: 4663,
  name: 'Robinhood Chain',
  rpcUrl: 'https://rpc.mainnet.chain.robinhood.com',
  explorerUrl: 'https://robinhoodchain.blockscout.com',
} as const;

export const UNISWAP_CONTRACTS = {
  v2Factory: '0x8bceaa40b9acdfaedf85adf4ff01f5ad6517937f',
  v3Factory: '0x1f7d7550b1b028f7571e69a784071f0205fd2efa',
  v3NonfungiblePositionManager: '0x73991a25c818bf1f1128deaab1492d45638de0d3',
  v4PoolManager: '0x8366a39cc670b4001a1121b8f6a443a643e40951',
  v4PositionManager: '0x58daec3116aae6d93017baaea7749052e8a04fa7',
  v4StateView: '0xf3334192d15450cdd385c8b70e03f9a6bd9e673b',
} as const;

export const BSC_CONFIG = {
  id: 56,
  name: 'BNB Smart Chain',
  nativeSymbol: 'BNB',
  wrappedSymbol: 'WBNB',
  rpcFallbacks: [
    'https://bsc-rpc.publicnode.com',
    'https://1rpc.io/bnb',
    'https://bsc-dataseed.binance.org',
  ],
  multicall3: '0xcA11bde05977b3631167028862bE2a173976CA11',
  explorerBscscanBase: 'https://api.bscscan.com/api',
  blockscoutApiBase: null,
  dexscreenerChainId: 'bsc',
  pancake: {
    v3Factory: '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865',
    v3Npm: '0x46A15B0b27311cedF172AB29E4f4766fbE7F4364',
  },
} as const;

export const UNISWAP_BASE_CONTRACTS = {
  v2Factory: '0x8909dc15e40173ff4699343b6eb8132c65e18ec6',
  v3Factory: '0x33128a8fc17869897dce68ed026d694621f6fdfd',
  v3NonfungiblePositionManager: '0x03a520b32c04bf3beef7beb72e919cf822ed34f1',
  v4PoolManager: '0x498581ff718922c3f8e6a244956af099b2652b2b',
  v4PositionManager: '0x7c5f5a4bbd8fd63184577525326123b519429bdc',
  v4StateView: '0xa3c0c9b65bad0b08107aa264b0f3db444b867a71',
} as const;

export const BASE_CONFIG = {
  id: 8453,
  name: 'Base',
  nativeSymbol: 'ETH',
  wrappedSymbol: 'WETH',
  wrappedAddress: '0x4200000000000000000000000000000000000006',
  rpcFallbacks: [
    'https://base-rpc.publicnode.com',
    'https://mainnet.base.org',
    'https://1rpc.io/base',
  ],
  multicall3: '0xcA11bde05977b3631167028862bE2a173976CA11',
  blockscoutApiBase: 'https://base.blockscout.com/api',
  dexscreenerChainId: 'base',
  uniswap: UNISWAP_BASE_CONTRACTS,
} as const;

export type ChainName = 'robinhood' | 'bsc' | 'base';