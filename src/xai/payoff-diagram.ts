/**
 * Payoff Diagram Generator
 *
 * Generates T+0 (current) and T+expiration PnL curves
 * for visual display in the XAI Dashboard.
 *
 * Output can be consumed by any charting library (Chart.js, Recharts, D3).
 */

import type { OptionsStrategy } from "../types/options.js";
import type { PayoffPoint } from "../types/agents.js";
import { blackScholesPrice, type BSParams } from "../quant/black-scholes.js";

/** Payoff diagram data for a strategy */
export interface PayoffDiagramData {
  /** Current (T+0) PnL curve */
  current: PayoffPoint[];
  /** Expiration PnL curve */
  expiration: PayoffPoint[];
  /** Key price levels */
  markers: Array<{
    price: number;
    label: string;
    type: "breakeven" | "strike" | "current_price" | "max_profit" | "max_loss";
  }>;
  /** Price range for x-axis */
  priceRange: { min: number; max: number };
  /** PnL range for y-axis */
  pnlRange: { min: number; max: number };
}

/**
 * Generate complete payoff diagram data for a strategy.
 */
export function generatePayoffDiagram(
  strategy: OptionsStrategy,
  underlyingPrice: number,
  riskFreeRate: number = 0.05,
  points: number = 100
): PayoffDiagramData {
  // Determine price range: ±25% around current price
  const rangePct = 0.25;
  const minPrice = underlyingPrice * (1 - rangePct);
  const maxPrice = underlyingPrice * (1 + rangePct);
  const step = (maxPrice - minPrice) / points;

  const current: PayoffPoint[] = [];
  const expiration: PayoffPoint[] = [];
  let minPnL = Infinity;
  let maxPnL = -Infinity;

  for (let i = 0; i <= points; i++) {
    const price = minPrice + i * step;

    // ── Expiration PnL ────────────────────────────────────
    const expPnL = calculateExpirationPnL(strategy, price);
    expiration.push({ underlyingPrice: price, pnl: expPnL });

    // ── Current (T+0) PnL ─────────────────────────────────
    const curPnL = calculateCurrentPnL(
      strategy,
      price,
      underlyingPrice,
      riskFreeRate
    );
    current.push({ underlyingPrice: price, pnl: curPnL });

    minPnL = Math.min(minPnL, expPnL, curPnL);
    maxPnL = Math.max(maxPnL, expPnL, curPnL);
  }

  // Build markers
  const markers: PayoffDiagramData["markers"] = [];

  // Current price
  markers.push({
    price: underlyingPrice,
    label: `Current: $${underlyingPrice.toFixed(2)}`,
    type: "current_price",
  });

  // Breakevens
  for (const be of strategy.breakeven) {
    markers.push({
      price: be,
      label: `BE: $${be.toFixed(2)}`,
      type: "breakeven",
    });
  }

  // Strikes
  const strikes = [
    ...new Set(strategy.legs.map((l) => l.contract.strike)),
  ].sort((a, b) => a - b);
  for (const strike of strikes) {
    markers.push({
      price: strike,
      label: `Strike: $${strike.toFixed(0)}`,
      type: "strike",
    });
  }

  return {
    current,
    expiration,
    markers,
    priceRange: { min: minPrice, max: maxPrice },
    pnlRange: { min: minPnL, max: maxPnL },
  };
}

/**
 * Calculate PnL at expiration.
 */
function calculateExpirationPnL(
  strategy: OptionsStrategy,
  priceAtExpiry: number
): number {
  let pnl = 0;
  for (const leg of strategy.legs) {
    const dir = leg.side === "buy" ? 1 : -1;
    const intrinsic =
      leg.contract.type === "call"
        ? Math.max(priceAtExpiry - leg.contract.strike, 0)
        : Math.max(leg.contract.strike - priceAtExpiry, 0);
    const premium = leg.price ?? 0;
    pnl += (intrinsic - premium) * dir * leg.quantity * leg.contract.multiplier;
  }
  return pnl;
}

/**
 * Calculate current (T+0) PnL using Black-Scholes repricing.
 */
function calculateCurrentPnL(
  strategy: OptionsStrategy,
  newUnderlyingPrice: number,
  currentUnderlyingPrice: number,
  riskFreeRate: number
): number {
  let pnl = 0;
  for (const leg of strategy.legs) {
    const dir = leg.side === "buy" ? 1 : -1;
    const T = yearFraction(leg.contract.expiration);

    if (T <= 0) continue;

    const params: BSParams = {
      S: newUnderlyingPrice,
      K: leg.contract.strike,
      T,
      r: riskFreeRate,
      sigma: 0.3, // approximate; in production use actual IV
    };

    const newPrice = blackScholesPrice(params, leg.contract.type);
    const entryPrice = leg.price ?? 0;
    pnl += (newPrice - entryPrice) * dir * leg.quantity * leg.contract.multiplier;
  }
  return pnl;
}

function yearFraction(date: Date): number {
  const msPerYear = 365.25 * 24 * 60 * 60 * 1000;
  return Math.max((date.getTime() - Date.now()) / msPerYear, 0);
}
