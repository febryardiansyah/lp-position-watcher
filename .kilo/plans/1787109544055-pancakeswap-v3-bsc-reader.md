# Plan: Smoke-testing the PancakeSwap v3 BSC reader

## Goal

Run the implemented `--chain bsc` path end-to-end against a wallet that holds PancakeSwap v3 LP positions, and verify each layer (RPC discovery, BscScan timestamps, valuation, rendering, snapshot diff) behaves as designed.

## Out of scope

- Multi-wallet runs, programmatic wallet discovery, fixture data.
- BSC v2, BSC Uniswap v3, or any further chain expansion.
- Code changes — this is a pure validation plan.

## Affected files

None. This plan produces commands and observation criteria only.

## Implementation task list

1. **Choose a target wallet**
   - Pick any public BSC address known to hold at least 2–3 PancakeSwap v3 NFTs (e.g. a CAKE/WBNB LP, a USDT/BUSD LP).
   - Sources: BscScan rich-list filters, DexScreener top-volume PancakeSwap v3 pool holders, or any wallet you've previously tracked.
   - Sanity-check the wallet beforehand with `curl` against BscScan's `tokennfttx&contractaddress=0x46A15B0b27311cedF172AB29E4fFF4364fbE7F4364` (Pancake v3 NPM) to confirm it has v3 NFTs.

2. **Set up env for the run**
   - Copy `.env.example` to `.env` if not already present.
   - Optionally set `BSCSCAN_API_KEY` (free at https://bscscan.com/apis) — without it the BSC path is rate-limited to 5 req/s and a wallet with 30+ positions will take a minute or more. For a 2–3 position wallet this is fine.
   - Leave `BSC_RPC_URL` unset so the built-in fallbacks (`bsc-rpc.publicnode.com`, `1rpc.io/bnb`, `bsc-dataseed.binance.org`) are used.

3. **Run the JSON smoke test first** (fastest signal)
   - `npm run dev -- --chain bsc --json <wallet>`
   - Expect: exits 0, prints a JSON object whose top-level `wallet`, `chainId === 56`, `chainName === "bsc"`, `summary.byProtocol.v3 >= 1`, `summary.byProvider.pancake >= 1`, `summary.byProvider.uniswap === 0`.
   - Each position has `protocol === "v3"`, `provider === "pancake"`, and non-empty `sqrtPriceX96`, `tickCurrent`, `tickLower`, `tickUpper`, `liquidity`, `token0`, `token1` (each with `symbol`, `decimals`, `principal`, `uncollectedFees`).
   - `createdAt` is either a valid ISO timestamp or `null` (null is acceptable if BscScan rate-limited without a key).
   - `notes` array contains the BSC-specific bullet lines.

4. **Run the formatted view**
   - `npm run dev -- --chain bsc <wallet>`
   - Expect: `Chain: BNB Smart Chain (56)` in the header.
   - `Providers: uniswap 0, pancake N` line appears under the `Positions:` summary.
   - Every pool cell is prefixed with `[pancake]`.
   - At least one row shows a non-null USD value (`$…`) if DexScreener returned a price for both tokens; otherwise `n/a` is acceptable — log it and continue.

5. **Verify the RH regression is intact**
   - `npm run dev -- 0x144B625e7e20E3869d993A0189B214EC2c8B0F06` (the example wallet from the README).
   - Expect: header still says `Chain: Robinhood Chain (4663)`, no `Providers:` line, no `[pancake]` prefixes, all counts unchanged.
   - `npm run dev -- --chain robinhood <wallet>` should produce byte-identical output to the no-flag invocation.

6. **Validate tracker + diff on BSC**
   - `npm run dev -- --chain bsc track <wallet>` — first run writes a snapshot; second run reports "Changes since last snapshot" (may be empty if nothing moved between the two runs, which is fine).
   - `npm run dev -- --chain bsc diff <wallet>` — returns the most recent two snapshots; expect at minimum the JSON object to include `wallet`, `chainId === 56`, `previous`, `current`, `changes`, `changeSummary`.
   - Inspect `data/<wallet>.json` to confirm the snapshot's `byProtocol.v3` and `byProvider.pancake` counts match what `--json` reported.

7. **Validate pagination + unknown flags**
   - `npm run dev -- --chain bsc --limit 1 <wallet>` — only the first closed position shows; pagination footer appears when closed count > 1.
   - `npm run dev -- --chain ethereum <wallet>` — fails immediately with `Unknown --chain value "ethereum". Use 'robinhood' or 'bsc'.`
   - `npm run dev -- --chain bsc` with no wallet and no `WALLET_ADDRESS` in `.env` — fails with the existing "Missing wallet address" error.

## Failure modes to watch for

- **BSC RPC unreachable** — `publicClientBsc` falls back through `bsc-rpc.publicnode.com` → `1rpc.io/bnb` → `bsc-dataseed.binance.org`. If all fail, the existing `rpcHints` diagnostic appears. Mitigation: set `BSC_RPC_URL` to a known-good provider.
- **BscScan 429 / no API key** — `getNftTransferHistory` swallows errors and returns `null`, so positions still appear but `createdAt` is `null`. Mitigation: set `BSCSCAN_API_KEY`.
- **`stateMutability` mismatch on `collect`** — would surface as `simulateContract` throwing inside `safeSimulateCollect`, which catches and returns `[0n, 0n]`. Result: `uncollectedFees` shows as `0` for that position. If seen, the `pancakeV3NpmAbi` was applied incorrectly.
- **DexScreener returns no BSC pair** — token `priceUsd` is `null`, `totalUsd` reads `n/a`, `feesUsd` still calculates from whichever token has a price. This is expected and acceptable.
- **WBNB / BNB price missing** — affects any position where one side is the native gas token. Same `null` fallback as above.
- **Snapshot file collisions across chains** — currently `data/<wallet>.json` is shared between RH and BSC runs for the same wallet. If a user runs RH first then BSC, the second snapshot's `byProtocol` shape differs but `positionKey` uniqueness keeps individual entries separate. If the user later runs `diff` after mixing chains, the diff still works because it keys by `positionKey`. Note this in the README later if it becomes a real complaint.

## Validation commands (single sequence)

```bash
# 1. JSON shape
npm run dev -- --chain bsc --json <wallet>

# 2. Pretty view
npm run dev -- --chain bsc <wallet>

# 3. RH regression
npm run dev -- 0x144B625e7e20E3869d993A0189B214EC2c8B0F06

# 4. Tracker
npm run dev -- --chain bsc track <wallet>
npm run dev -- --chain bsc track <wallet>     # again to produce a diff-able state
npm run dev -- --chain bsc diff <wallet>

# 5. Bad flag
npm run dev -- --chain ethereum <wallet>

# 6. Pagination
npm run dev -- --chain bsc --limit 1 <wallet>
```

## Open questions

None blocking. If a chosen wallet has zero PancakeSwap v3 positions, the run still exits cleanly with `Positions: 0` and the `Providers:` line — pick a different wallet and re-run.