# Plan: Fix BSC position valuation (wrong token prices)

## Goal

Resolve two real valuation bugs found during live BSC testing against a wallet holding positions in PancakeSwap v3 pools `USDT/牛来` and `犇犇/USDT`:

- **Position `USDT/牛来` (tokenId #7176334, range 31800 → 34000, in-range)**: CLI shows total **$411.58**, UI ground truth **$103.05** (≈ 4× too high). Principal amounts (`51.8248 USDT + 1219.4665 牛来`) match the UI exactly — the math is right, the **price** is wrong.
- **Position `犇犇/USDT` (tokenId #7176365, range -68600 → -66200, out-of-range)**: CLI shows total **$115.04**, UI ground truth **$84.60** (≈ 1.36× too high). Principal `84,527.58 犇犇` matches UI exactly — again, **price** is wrong.

Fee simulation matches the UI's "Rewards" column exactly, so the on-chain principal/fee math is correct. The bug is purely in price resolution.

## Root cause

`resolvePairPrices` (in `src/services/valuation.service.ts`) calls `getUsdPrice` for each token, which fetches **the highest-liquidity BSC pair on DexScreener for that token**. For meme tokens on BSC, DexScreener's "highest-liquidity" pair is frequently a different pool than the one the user's position is in — with a substantially different price (often stale, thin, or manipulated). Two examples:

- 牛来 has its real price implied by the user's actual pool (`USDT/牛来`). DexScreener returns a stale/wrong price from some other low-liquidity pair.
- 犇犇 similar — the actual pool `犇犇/USDT` is not DexScreener's top-liquidity 犇犇 pair.

When one side returns `null` from DexScreener, the existing code falls back to deriving the price from the **pool's `sqrtPriceX96` spot price** — which is correct as a chain-of-truth for that specific pool, but currently only kicks in for the *missing* side. The position's actual pool is known (`poolAddress` is already in the position object), but the valuation code does not fetch its price directly.

## Design

Prefer the price from the **specific pool the position is in**, when that pool is a PancakeSwap v3 pool and DexScreener lists it. Fall back to existing behavior otherwise.

Concretely:

1. **Add a per-pool DexScreener lookup** in `valuation.service.ts` keyed on `${chainId}:${poolAddress}`.
2. **Use it first** in `resolvePairPrices` whenever the caller passes the pool address — which `valueConcentrated` already does via the `sqrtPriceX96` field.
3. **Keep the existing fallback chain** for robustness (token-level DexScreener → pool spot ratio → null).

The implementation is small and additive — no existing behavior changes for Robinhood Chain, no new ABIs, no new dependencies.

## Affected files

- `src/services/valuation.service.ts` — add `getPoolUsdPrice(pairAddress, chainId)`, use it from `resolvePairPrices`.
- No changes to `lp-position.service.ts`, `index.ts`, or any other file.

## Implementation task list

1. **Add `getPoolUsdPrice(pairAddress: Address, chainId: number)`** to `valuation.service.ts`. Implementation:
   - Build `cacheKey = \`pool:${chainId}:${pairAddress.toLowerCase()}\``.
   - Call `GET ${DEXSCREENER_API_BASE}/pairs/${chainId === BSC_CONFIG.id ? 'bsc' : 'robinhood'}/${pairAddress.toLowerCase()}`.
   - Return `pair.priceUsd` (numerically parsed) for both `token0` and `token1`, joined into a `{ price0, price1 } | null`.
   - Filter on `pair.chainId === dexscreenerChainId` for safety.
   - Add to `priceCache` so repeated valuation calls don't re-hit DexScreener.
2. **Update `resolvePairPrices`** to accept an optional `poolAddress: Address` parameter. When present:
   - Try `getPoolUsdPrice(poolAddress, chainId)` first.
   - If both prices come back, return immediately (skip the per-token DexScreener lookups entirely).
   - If only one side comes back, fall back to per-token DexScreener for the missing side.
   - If neither side comes back, existing behavior (per-token → pool ratio fallback).
3. **Update `valueConcentrated`** to pass the pool address into `resolvePairPrices`. It already has `sqrtPriceX96`; add the pool address from the position. The caller in `valuePosition` passes `position.poolAddress` (always present on `V3Position`).
4. **Update `valuePosition`** v2 branch — no pool-address routing needed for v2 (we use reserves); leave unchanged.
5. **Validation**:
   - Run `npm run typecheck` and `npm run build` — must pass.
   - Re-run `npm run start -- --chain bsc --json <wallet-with-known-positions>` against the same wallet and confirm the per-position USD values are within a few percent of the UI ground truth ($103.05 and $84.60 for those two positions).
   - Spot-check the Robinhood Chain path on the existing example wallet (`0x144B625e7e20E3869d993A0189B214EC2c8B0F06`) — output should not regress.

## Data flow

```
valueConcentrated({ pool: { kind: 'v3', sqrtPriceX96, poolAddress } })
  → resolvePairPrices({ ..., pool: { kind: 'v3', sqrtPriceX96 }, poolAddress })
    → getPoolUsdPrice(poolAddress, chainId)        [NEW — hit DexScreener /pairs/{chain}/{pair}]
       ├─ both prices returned → return immediately
       └─ partial / null       → fall through to existing per-token DexScreener + ratio logic
```

## Failure modes

- **DexScreener does not list the pool** (low-liquidity pool, or fresh pool): `getPoolUsdPrice` returns `null`; falls back to per-token DexScreener. Same as current behavior for pools not on DexScreener.
- **DexScreener returns wrong price** (stale, manipulated): the bug we are fixing — but for meme tokens on BSC the position's actual pool is the most reliable price source available. We can never fully eliminate this risk, only minimize it.
- **DexScreener rate-limit**: existing `fetchJson` retries handle this. Add a fresh cache entry on failure so we don't hammer the API.
- **Different chain's pool address accidentally passed**: `getPoolUsdPrice` includes `chainId` in both the cache key and the URL path, so cross-chain pollution is impossible.
- **Pool address is a non-DexScreener-listed contract (e.g. MasterChef)**: returns `null` cleanly.

## Validation

1. `npm run typecheck` clean.
2. `npm run build` clean.
3. Live test against the wallet from the screenshot:
   - `npm run start -- --chain bsc --json <wallet>`
   - Expect position #7176334 totalUsd ≈ $103.05, position #7176365 totalUsd ≈ $84.60 (±10% acceptable given market movement).
4. RH regression: `npm run start -- --json 0x144B625e7e20E3869d993A0189B214EC2c8B0F06` — output should be unchanged (this fix only adds a code path; v3 positions on RH that already had good prices will keep using the existing path, because we only invoke `getPoolUsdPrice` when explicitly requested via `poolAddress`).
5. Spot-check on a high-liquidity BSC pool (e.g. CAKE/WBNB on PancakeSwap v3) where DexScreener's price is accurate — should still match.

## Open questions

None blocking. If a position's pool is listed on DexScreener but DexScreener's reported price is still wildly divergent from the position's spot price (e.g. illiquid pool), the position's `sqrtPriceX96` is the only on-chain truth we have — and the existing ratio fallback already handles this. No further changes needed for that case.

## Notes for the implementing agent

- The function name `getPoolUsdPrice` returns a `{ price0, price1 }` pair shape to mirror `resolvePairPrices`'s contract; do not return a single number.
- `poolAddress` is the v3 pool's deployed address (e.g. `0x56EB1e376B46c874cE32aB0239Da93A15dBAf938`). The Pancake v3 factory's `getPool(token0, token1, fee)` call already returns this in `readV3LikePositions`, so no new RPC work is needed.
- Do not modify the `safeSimulateDecrease` principal computation — it's correct. The bug is purely on the pricing side.
- Do not modify the `liquidityAmounts` hand-rolled TickMath function — it's not on the hot path for BSC PancakeSwap v3 since we use `decreaseLiquidity` simulation for principal. Leave for a future cleanup.
