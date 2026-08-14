# Robinhood Chain Uniswap LP Position CLI

A CLI tool that reads a wallet's Uniswap LP positions (v2 / v3 / v4) on Robinhood Chain and displays them in a portfolio view — including USD value, in-range status, uncollected fees, position age, and fee tier. It also supports snapshot-based tracking and diffing for PnL-style analysis.

## Features

- **Portfolio view** — total USD value, position counts by protocol, in-range / out-of-range summary, total unclaimed fees, plus a table of open and empty/closed positions (Pool, Value, In range, Unclaimed, Age, Fee, Range)
- **Protocol support**
  - **v2** — LP ERC-20s held by the wallet, verified against the Uniswap v2 factory
  - **v3** — NFTs via `balanceOf` / `tokenOfOwnerByIndex`; principal and uncollected fees via static simulation (`collect` / `decreaseLiquidity`)
  - **v4** — NFTs discovered from Blockscout transfer history; amounts, in-range status and uncollected fees read from the on-chain `StateView` contract (slot0, position info, fee growth)
- **USD valuation** — token prices from Blockscout (`exchange_rate`, chain coin price), with pool-ratio fallback when a price is missing
- **Tracking** — snapshot wallet state locally and diff it over time (opened / closed / modified positions, tick moves, fee accrual)
- **JSON output** — `--json` flag for raw data when you need machine-readable output

## Requirements

- Node.js 18+ (uses native `fetch`)
- npm

## Setup

```bash
npm install
cp .env.example .env
```

Edit `.env`:

| Variable | Description | Default |
| --- | --- | --- |
| `RH_CHAIN_ID` | Robinhood Chain chain ID | `4663` |
| `RH_RPC_URL` | Primary RPC endpoint | `https://rpc.mainnet.chain.robinhood.com` |
| `RH_RPC_FALLBACK_URLS` | Comma-separated backup RPCs (e.g. Alchemy/Chainstack) | empty |
| `RH_DATA_DIR` | Directory for tracking snapshots | `data` |
| `RH_MAX_SNAPSHOTS` | Max snapshots kept per wallet | `200` |
| `WALLET_ADDRESS` | Optional default wallet address | empty |

> The default public RPC can be unstable/rate-limited. For reliable use, set `RH_RPC_URL` to a private endpoint (e.g. Chainstack or Alchemy) and add fallbacks.

## Usage

```bash
npm run dev -- <walletAddress>            Show LP portfolio
npm run dev -- positions <walletAddress>  Same as above
npm run dev -- positions --json <wallet>  Show raw JSON position data
npm run dev -- track <walletAddress>      Record a valuation snapshot and report changes since last one
npm run dev -- history <walletAddress>    List recorded snapshots for a wallet
npm run dev -- diff <walletAddress>       Diff the two most recent snapshots
npm run dev -- help                       Show help
```

If `WALLET_ADDRESS` is set in `.env`, the address argument can be omitted.

### Example

```bash
npm run dev -- 0x144b625e7e20e3869d993a0189b214ec2c8b0f06
```

Output:

```
Wallet: 0x144B625e7e20E3869d993A0189B214EC2c8B0F06
Chain: Robinhood Chain (4663)

Total Value: $693,058,943.83
Positions: 78 (v2: 0, v3: 6, v4: 72)
In range: 26   Out of range: 52   Unclaimed fees: $239,283,445.57

Open positions
#  Pool          Value            In range  Unclaimed ...  Age      Fee     Range
7  USDG/EQUITY   $622,948,152.89  yes       $237,959,682.91 (…) 13h 55m  5.00%  354000 → 360500
```

### Tracking PnL over time

```bash
npm run dev -- track 0x144b625e7e20e3869d993a0189b214ec2c8b0f06   # run periodically
npm run dev -- diff 0x144b625e7e20e3869d993a0189b214ec2c8b0f06
npm run dev -- history 0x144b625e7e20e3869d993a0189b214ec2c8b0f06
```

Snapshots are stored as JSON files under `RH_DATA_DIR` (one file per wallet).

## Scripts

| Command | Description |
| --- | --- |
| `npm run dev` | Run with `tsx` (watch mode) |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Run the compiled build (`node dist/index.js`) |
| `npm run typecheck` | Type-check without emitting |

## Architecture

```
src/
├── index.ts                       CLI entry point (arg parsing, command dispatch)
├── config/env.ts                  Environment validation (zod)
├── constants/chain.ts             Chain + Uniswap contract addresses
├── lib/
│   ├── http.ts                    Fetch with retries/backoff
│   ├── public-client.ts           Viem public client with RPC fallbacks
│   └── storage.ts                 Snapshot persistence (JSON files)
└── services/
    ├── lp-position.service.ts     Position discovery (v2/v3/v4) + on-chain reads
    ├── valuation.service.ts       USD pricing and position/wallet valuation
    ├── portfolio-view.service.ts  portfolio rendering
    └── tracker.service.ts         Snapshots, diffing, change summaries
```

### Data sources

- **RPC** — on-chain contract calls (Uniswap v2/v3/v4 contracts, v4 `StateView`)
- **Blockscout** (`robinhoodchain.blockscout.com`) — wallet token holdings, NFT transfer history (position age), token prices, chain coin price
- Prices for non-ETH tokens come from Blockscout `exchange_rate`; when unavailable, the pool price ratio is used with whichever side has a known USD price

### Notes

- Uniswap v4 positions are keyed by `keccak256(abi.encode(poolKey))`; fees are computed as `(currentFeeGrowthInside − storedFeeGrowthInside) × liquidity / 2^128` via the `StateView` contract
- Large per-position USD values are real pool math — meme-coin pools on Robinhood Chain can price tokens extremely high (e.g. an EQUITY/USDG pool at tick ~358k prices EQUITY at thousands of USDG)
- The full read for a wallet with 70+ positions takes ~2–3 minutes due to per-position RPC + Blockscout calls
