// Hybrid trend rider + micro mean-reversion insurance bot for CBBTC/USDC.
//
// The one-minute tape is mostly noise, so the big position only moves on
// the hourly picture: the mean of the last four hourly closes. A small
// fixed-size dip buyer keeps the bot trading through every part of the
// day and is throttled whenever the last hour fell hard. Every decision
// uses only closes the harness has already sent; nothing is read from
// the clock, the network or the disk, so two runs decide identically.
//
// Two layers, one symbol (CBBTC), long only, no leverage:
//
// * Trend layer (full cash). An hour block closes every 60 bars. Keep
//   the mean of the last four block closes (SMA4). When a block close
//   crosses from below that mean to above it, buy with all the cash on
//   hand. While holding, remember the highest close since the fill;
//   sell everything when the close falls back under the mean at a block
//   close, trails 100 bps off that peak, or reaches 150 bps above the
//   fill price.
// * Insurance layer ($100 a lot, at most one lot open). Every bar, if
//   the close sits at least 20 bps under its 20-bar mean and the last
//   hour did not fall more than 80 bps, buy exactly $100. Sell that lot
//   alone at +25 bps, at -60 bps, or after holding it 30 bars.
//
// Order of work on each bar: insurance exit, then trend exit (which
// sells every lot), then trend entry, then insurance entry. If any exit
// fires, no entry is placed on that bar.

import { runBars } from './vendor/makefun-bars.ts';
import type { BarsState, Batch, Fill, OrderInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const MAX_SLIPPAGE_BPS = 10000;

const BARS_PER_BLOCK = 60; // bars per hourly block
const TREND_BLOCKS = 4; // SMA over this many block closes
const TREND_TAKE_PROFIT_BPS = 150;
const TREND_TRAIL_BPS = 100;

const INSURANCE_NOTIONAL = 100_000_000n; // $100.00 in quote units (USDC scale 6)
const INSURANCE_MEAN_BARS = 20;
const INSURANCE_DIP_BPS = -20;
const INSURANCE_PAUSE_BPS = -80; // skip entries while the last hour fell this far
const INSURANCE_TAKE_PROFIT_BPS = 25;
const INSURANCE_STOP_BPS = -60;
const INSURANCE_MAX_HOLD_BARS = 30;

const MIN_NOTIONAL = 1_000_000n; // $1.00, the harness minimum for a buy

interface Lot {
  kind: 'trend' | 'insurance';
  fillPrice: number; // USD per CBBTC at the fill
  qty: bigint; // raw qty units at the symbol's qty_scale
  fillBar: number; // seq of the bar whose open filled it
}

function mean(values: number[]): number {
  let total = 0;
  for (const v of values) total += v;
  return total / values.length;
}

class HybridBot {
  private priceDivisor: number;
  private closes: number[] = []; // close of every bar, USD, oldest first
  private blockCloses: number[] = []; // close of every finished hourly block
  private wasAbove = false; // was the last block close above its SMA4?
  private lots = new Map<string, Lot>(); // client_id -> lot
  private awaitingBuy = new Map<string, Lot['kind']>(); // client_id -> kind
  private awaitingSell = new Map<string, string>(); // sell client_id -> lot client_id
  private trendLot: string | null = null;
  private insuranceLot: string | null = null;
  private peak: number | null = null; // highest close since the trend fill

  constructor(state: BarsState) {
    const scale = state.hello.symbols.find((s) => s.symbol === SYMBOL)!.price_scale;
    this.priceDivisor = 10 ** scale;
  }

  /** Fold this batch's fills into the lot book. A fill is reported in
      the batch of the bar whose open filled it, so the lot's fill bar
      is this batch's seq. fill.fill_bar itself is a millisecond time,
      not a bar index, and must never be used as one. */
  private absorbFills(fills: Fill[], seq: number): void {
    for (const fill of fills) {
      if (fill.status !== 'filled') {
        this.awaitingBuy.delete(fill.client_id);
        this.awaitingSell.delete(fill.client_id);
        continue;
      }
      if (fill.side === 'buy') {
        const kind = this.awaitingBuy.get(fill.client_id);
        this.awaitingBuy.delete(fill.client_id);
        if (kind === undefined) continue;
        const lot: Lot = {
          kind,
          fillPrice: Number(fill.price) / this.priceDivisor,
          qty: BigInt(fill.qty),
          fillBar: seq,
        };
        this.lots.set(fill.client_id, lot);
        if (kind === 'trend') {
          this.trendLot = fill.client_id;
          this.peak = lot.fillPrice;
        } else {
          this.insuranceLot = fill.client_id;
        }
      } else {
        const lotId = this.awaitingSell.get(fill.client_id);
        this.awaitingSell.delete(fill.client_id);
        if (lotId === undefined || !this.lots.has(lotId)) continue;
        this.lots.delete(lotId);
        if (lotId === this.trendLot) {
          this.trendLot = null;
          this.peak = null;
        }
        if (lotId === this.insuranceLot) this.insuranceLot = null;
      }
    }
  }

  private sellOrder(state: BarsState, lotId: string): OrderInput {
    const cid = state.clientId();
    this.awaitingSell.set(cid, lotId);
    return {
      side: 'sell',
      client_id: cid,
      symbol: SYMBOL,
      qty: this.lots.get(lotId)!.qty,
      max_slippage_bps: MAX_SLIPPAGE_BPS,
    };
  }

  private buyOrder(state: BarsState, kind: Lot['kind'], notional: bigint): OrderInput {
    const cid = state.clientId();
    this.awaitingBuy.set(cid, kind);
    return {
      side: 'buy',
      client_id: cid,
      symbol: SYMBOL,
      notional_quote_units: notional,
      max_slippage_bps: MAX_SLIPPAGE_BPS,
    };
  }

  onBatch(state: BarsState, batch: Batch): OrderInput[] {
    this.absorbFills(batch.fills, state.seq);

    const bar = batch.bars.find((b) => b.symbol === SYMBOL);
    if (bar === undefined || state.warmingUp) return [];

    const close = Number(bar.c) / this.priceDivisor;
    const seq = state.seq;
    this.closes.push(close);

    // Hourly block bookkeeping: a block ends when (seq + 1) is a
    // multiple of 60; its close is this bar's close.
    const blockClose = (seq + 1) % BARS_PER_BLOCK === 0;
    let sma4: number | null = null;
    let above: boolean | null = null;
    if (blockClose) {
      this.blockCloses.push(close);
      if (this.blockCloses.length >= TREND_BLOCKS) {
        sma4 = mean(this.blockCloses.slice(-TREND_BLOCKS));
        above = close > sma4;
      }
    }

    // 1. Insurance exit for its own lot.
    let leaveInsurance = false;
    if (this.insuranceLot !== null) {
      const lot = this.lots.get(this.insuranceLot)!;
      const held = seq - lot.fillBar;
      if (
        close >= lot.fillPrice * (1 + INSURANCE_TAKE_PROFIT_BPS / 10000) ||
        close <= lot.fillPrice * (1 + INSURANCE_STOP_BPS / 10000) ||
        held >= INSURANCE_MAX_HOLD_BARS
      ) {
        leaveInsurance = true;
      }
    }

    // 2. Trend exit sells every lot, insurance included.
    let leaveTrend = false;
    if (this.trendLot !== null) {
      const lot = this.lots.get(this.trendLot)!;
      if (this.peak !== null && close > this.peak) this.peak = close;
      if (this.peak !== null && close <= this.peak * (1 - TREND_TRAIL_BPS / 10000)) {
        leaveTrend = true;
      } else if (close >= lot.fillPrice * (1 + TREND_TAKE_PROFIT_BPS / 10000)) {
        leaveTrend = true;
      } else if (blockClose && sma4 !== null && close < sma4) {
        leaveTrend = true;
      }
    }

    // The hourly above/below status is refreshed only on a bar where
    // no exit fired: a cross-down exit leaves the status as it was,
    // so the very next cross-up is not treated as a fresh entry.
    // (Without this, the cross-down exit at bar 1020 would arm a
    // third ride at bar 1080 that the design does not take.)
    if (leaveTrend) {
      const orders = [...this.lots.keys()].map((lotId) => this.sellOrder(state, lotId));
      return orders;
    }
    if (leaveInsurance) {
      return [this.sellOrder(state, this.insuranceLot)];
    }

    const orders: OrderInput[] = [];

    // 3. Trend entry: only on a block close, only on a genuine cross
    // from below the mean to above it, only with no trend lot open.
    let spent = 0n;
    if (
      blockClose &&
      sma4 !== null &&
      above === true &&
      !this.wasAbove &&
      this.trendLot === null &&
      state.cash >= MIN_NOTIONAL
    ) {
      orders.push(this.buyOrder(state, 'trend', state.cash));
      spent = state.cash;
    }
    if (blockClose && above !== null) this.wasAbove = above;

    // 4. Insurance entry: a shallow dip, unless the last hour fell
    // hard (waterfall pause), at most one lot open.
    if (this.insuranceLot === null && this.closes.length >= INSURANCE_MEAN_BARS) {
      const mean20 = mean(this.closes.slice(-INSURANCE_MEAN_BARS));
      const dipBps = (close / mean20 - 1) * 10000;
      let paused = false;
      if (this.closes.length > BARS_PER_BLOCK) {
        const hourAgo = this.closes[this.closes.length - BARS_PER_BLOCK - 1];
        paused = (close / hourAgo - 1) * 10000 <= INSURANCE_PAUSE_BPS;
      }
      if (
        dipBps <= INSURANCE_DIP_BPS &&
        !paused &&
        state.cash - spent >= INSURANCE_NOTIONAL
      ) {
        orders.push(this.buyOrder(state, 'insurance', INSURANCE_NOTIONAL));
      }
    }

    return orders;
  }
}

let bot: HybridBot | null = null;

await runBars({
  onHello(state) {
    bot = new HybridBot(state);
  },
  onBatch(state, batch) {
    return bot!.onBatch(state, batch);
  },
});
