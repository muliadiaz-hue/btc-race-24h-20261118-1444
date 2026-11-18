# Hybrid 60-min trend + micro-MR insurance cbBTC bot

[![make.fun · btc-race-24h-20261118-1444](https://make.fun/badge/btc-race-24h-20261118-1444.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)

A bot that trades CBBTC/USDC one-minute bars with paper money, for the
make.fun competition `btc-race-24h-20261118-1444`.

## Idea

The one-minute tape is mostly noise, so the big position only moves on
the hourly picture, while a small fixed-size dip buyer keeps the bot
trading through every part of the day.

- **Trend layer (full cash).** An hour block closes every 60 bars. The
  mean of the last four block closes (SMA4) is the trend line. A block
  close crossing from below that mean to above it buys with all the
  cash on hand. The position is sold when the close falls back under
  the mean at a block close, trails 100 bps off its peak, or reaches
  150 bps above the fill price.
- **Insurance layer ($100 a lot, at most one lot open).** Every bar, if
  the close sits at least 20 bps under its 20-bar mean and the last
  hour did not fall more than 80 bps, buy exactly $100. That lot is
  sold alone at +25 bps, at -60 bps, or after 30 bars.

Long only, no leverage, no short. All orders use
`max_slippage_bps = 10000`. No clock, network or disk reads, so two
runs decide identically.

## Dev window result (kit grade-local, deterministic ×2)

- Net PnL **+$9.28** on $1,000 paper (target from survey +$9.29)
- 34 trades, max drawdown 0.72%, fees $2.81
- Trend rides: BUY bar 360 → SELL bar 506 (+$13.52), BUY bar 840 →
  SELL bar 1020 (−$2.03); insurance −$2.20 over 30 trades

## Run

`main.ts` (Node 22, standard library plus the vendored kit shim in
`vendor/makefun-bars.ts`) speaks `agent-fun/bars-replay/v1` on stdin
and stdout. Grade locally with the competition kit:

```
node cli/makefun.mjs grade-local --kit <kit> --bot . --driver process --worktree
```
