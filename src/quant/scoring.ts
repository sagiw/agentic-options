/**
 * Advanced Strategy Scoring Module
 *
 * Provides:
 *   - Probability of Profit (POP) using delta as proxy
 *   - Expected Value (EV) = POP × maxProfit - (1-POP) × maxLoss
 *   - Bid-Ask spread quality scoring
 *   - Volume / Open Interest liquidity filter
 *   - IV Skew analysis for strike selection
 */

import type { OptionsStrategy, OptionChainEntry } from "../types/options.js";
import { agentLogger } from "../utils/logger.js";

const log = agentLogger("scoring");

// ─── Interfaces ─────────────────────────────────────────

export interface POPResult {
  /** Probability of Profit (0-1) */
  pop: number;
  /** Method used to estimate POP */
  method: "delta" | "breakeven" | "estimated";
  /** Confidence in the estimate */
  confidence: number;
}

export interface EVResult {
  /** Expected Value in dollars */
  expectedValue: number;
  /** POP used in calculation */
  pop: number;
  /** EV per dollar risked */
  evPerDollarRisked: number;
  /** Is this a positive EV trade? */
  isPositiveEV: boolean;
}

export interface LiquidityScore {
  /** Overall liquidity score 0-100 */
  score: number;
  /** Average bid-ask spread as % of mid price */
  avgSpreadPct: number;
  /** Minimum open interest across legs */
  minOpenInterest: number;
  /** Minimum volume across legs */
  minVolume: number;
  /** Issues found */
  warnings: string[];
}

export interface IVSkewAnalysis {
  /** Skew direction: puts more expensive = "put_skew", calls = "call_skew" */
  direction: "put_skew" | "call_skew" | "neutral";
  /** Magnitude of skew (0-100) */
  magnitude: number;
  /** ATM IV */
  atmIV: number;
  /** 25-delta put IV */
  otmPutIV: number;
  /** 25-delta call IV */
  otmCallIV: number;
  /** Skew ratio (OTM put IV / OTM call IV) */
  skewRatio: number;
  /** Suggested strategy adjustment based on skew */
  suggestion: string;
}

// ─── POP Calculation ────────────────────────────────────

/**
 * Calculate Probability of Profit for a strategy.
 *
 * For credit strategies: POP ≈ 1 - |delta of short strike|
 * For debit strategies: POP ≈ |delta of long strike|
 * For multi-leg: composite from breakeven proximity
 */
export function calculatePOP(
  strategy: OptionsStrategy,
  underlyingPrice: number,
  iv: number = 0.3,
  daysToExpiry: number = 30
): POPResult {
  // Method 1: Use delta from short legs for credit strategies
  const isCredit = strategy.netDebit < 0;

  if (strategy.legs.length === 1) {
    // Single leg strategies
    const leg = strategy.legs[0];
    if (leg.side === "sell") {
      // Selling premium: POP = 1 - |delta|
      // Short puts profit if stock stays above strike
      // Short calls profit if stock stays below strike
      const distance = Math.abs(leg.contract.strike - underlyingPrice) / underlyingPrice;
      const timeAdjust = Math.sqrt(daysToExpiry / 365);
      const pop = Math.min(0.95, 0.5 + distance / (iv * timeAdjust));
      return { pop: Math.max(0.05, Math.min(0.95, pop)), method: "breakeven", confidence: 0.7 };
    } else {
      // Buying premium: POP typically < 50% for OTM
      const distance = Math.abs(leg.contract.strike - underlyingPrice) / underlyingPrice;
      const timeAdjust = Math.sqrt(daysToExpiry / 365);
      const pop = Math.max(0.05, 0.5 - distance / (iv * timeAdjust));
      return { pop: Math.max(0.05, Math.min(0.95, pop)), method: "breakeven", confidence: 0.7 };
    }
  }

  // Multi-leg strategies: estimate from breakeven distance
  if (strategy.breakeven.length > 0) {
    if (strategy.breakeven.length === 1) {
      // Single breakeven (spreads)
      const be = strategy.breakeven[0];
      const distancePct = (be - underlyingPrice) / underlyingPrice;
      const timeAdjust = Math.sqrt(daysToExpiry / 365);
      const moveRequired = Math.abs(distancePct);

      if (isCredit) {
        // Credit spread: profit if price stays on the right side of breakeven
        const pop = normalCDF(moveRequired / (iv * timeAdjust));
        return { pop: Math.max(0.05, Math.min(0.95, pop)), method: "breakeven", confidence: 0.7 };
      } else {
        // Debit spread: need price to move past breakeven
        const pop = 1 - normalCDF(moveRequired / (iv * timeAdjust));
        return { pop: Math.max(0.05, Math.min(0.95, pop)), method: "breakeven", confidence: 0.6 };
      }
    }

    if (strategy.breakeven.length === 2) {
      // Two breakevens (iron condor, straddle, etc.)
      const [beLow, beHigh] = strategy.breakeven.sort((a, b) => a - b);
      const lowDist = (underlyingPrice - beLow) / underlyingPrice;
      const highDist = (beHigh - underlyingPrice) / underlyingPrice;
      const timeAdjust = Math.sqrt(daysToExpiry / 365);

      if (isCredit) {
        // Credit: profit if price stays between breakevens
        const popLow = normalCDF(lowDist / (iv * timeAdjust));
        const popHigh = normalCDF(highDist / (iv * timeAdjust));
        const pop = popLow + popHigh - 1;
        return { pop: Math.max(0.05, Math.min(0.95, pop)), method: "breakeven", confidence: 0.65 };
      } else {
        // Debit: profit if price moves outside breakevens
        const popLow = 1 - normalCDF(lowDist / (iv * timeAdjust));
        const popHigh = 1 - normalCDF(highDist / (iv * timeAdjust));
        const pop = popLow + popHigh;
        return { pop: Math.max(0.05, Math.min(0.95, pop)), method: "breakeven", confidence: 0.6 };
      }
    }
  }

  // Fallback: estimate based on strategy type
  const typeEstimates: Record<string, number> = {
    iron_condor: 0.68,
    iron_butterfly: 0.55,
    bull_call_spread: 0.45,
    bear_put_spread: 0.45,
    put_credit_spread: 0.65,
    call_credit_spread: 0.65,
    cash_secured_put: 0.70,
    covered_call: 0.72,
    long_call: 0.35,
    long_put: 0.35,
    straddle: 0.40,
    strangle: 0.35,
    calendar_spread: 0.55,
    diagonal_spread: 0.50,
  };

  const pop = typeEstimates[strategy.type] ?? (isCredit ? 0.60 : 0.40);
  return { pop, method: "estimated", confidence: 0.4 };
}

/**
 * Calculate Expected Value of a strategy.
 */
export function calculateEV(
  strategy: OptionsStrategy,
  pop: number
): EVResult {
  const maxProfit = strategy.maxProfit === "unlimited"
    ? Math.abs(strategy.maxLoss) * 2 // Conservative estimate for unlimited profit
    : strategy.maxProfit;
  const maxLoss = Math.abs(strategy.maxLoss);

  const expectedValue = pop * maxProfit - (1 - pop) * maxLoss;
  const evPerDollarRisked = maxLoss > 0 ? expectedValue / maxLoss : 0;

  return {
    expectedValue: Math.round(expectedValue * 100) / 100,
    pop,
    evPerDollarRisked: Math.round(evPerDollarRisked * 1000) / 1000,
    isPositiveEV: expectedValue > 0,
  };
}

// ─── Liquidity Scoring ──────────────────────────────────

/**
 * Score the liquidity/quality of a strategy's contracts.
 *
 * Checks:
 * - Bid-ask spread < 10% of mid
 * - Open Interest > 100
 * - Volume > 10
 */
export function scoreLiquidity(
  strategy: OptionsStrategy,
  chainEntries: OptionChainEntry[]
): LiquidityScore {
  const warnings: string[] = [];
  let totalSpreadPct = 0;
  let minOI = Infinity;
  let minVolume = Infinity;
  let legsFound = 0;

  for (const leg of strategy.legs) {
    // Find matching chain entry
    const entry = chainEntries.find(
      (e) =>
        e.contract.strike === leg.contract.strike &&
        e.contract.type === leg.contract.type &&
        e.contract.expiration.getTime() === leg.contract.expiration.getTime()
    );

    if (!entry) continue;
    legsFound++;

    // Bid-ask spread
    const mid = entry.mid || (entry.bid + entry.ask) / 2;
    if (mid > 0) {
      const spreadPct = ((entry.ask - entry.bid) / mid) * 100;
      totalSpreadPct += spreadPct;
      if (spreadPct > 10) {
        warnings.push(`${leg.contract.type.toUpperCase()} $${leg.contract.strike}: wide spread (${spreadPct.toFixed(1)}%)`);
      }
    }

    // Open Interest
    if (entry.openInterest < minOI) minOI = entry.openInterest;
    if (entry.openInterest < 100) {
      warnings.push(`${leg.contract.type.toUpperCase()} $${leg.contract.strike}: low OI (${entry.openInterest})`);
    }

    // Volume
    if (entry.volume < minVolume) minVolume = entry.volume;
    if (entry.volume < 10) {
      warnings.push(`${leg.contract.type.toUpperCase()} $${leg.contract.strike}: low volume (${entry.volume})`);
    }
  }

  if (legsFound === 0) {
    return { score: 0, avgSpreadPct: 100, minOpenInterest: 0, minVolume: 0, warnings: ["No chain data found for strategy legs"] };
  }

  const avgSpreadPct = totalSpreadPct / legsFound;
  if (minOI === Infinity) minOI = 0;
  if (minVolume === Infinity) minVolume = 0;

  // Score: 100 = excellent liquidity, 0 = terrible
  let score = 100;
  // Penalize wide spreads
  score -= Math.min(40, avgSpreadPct * 4);
  // Penalize low OI
  if (minOI < 100) score -= 20;
  else if (minOI < 500) score -= 10;
  // Penalize low volume
  if (minVolume < 10) score -= 20;
  else if (minVolume < 50) score -= 10;

  return {
    score: Math.max(0, Math.round(score)),
    avgSpreadPct: Math.round(avgSpreadPct * 10) / 10,
    minOpenInterest: minOI,
    minVolume: minVolume,
    warnings,
  };
}

/**
 * Check if a strategy passes minimum liquidity thresholds.
 */
export function passesLiquidityFilter(
  strategy: OptionsStrategy,
  chainEntries: OptionChainEntry[],
  minOI: number = 100,
  minVolume: number = 10,
  maxSpreadPct: number = 15
): boolean {
  for (const leg of strategy.legs) {
    const entry = chainEntries.find(
      (e) =>
        e.contract.strike === leg.contract.strike &&
        e.contract.type === leg.contract.type &&
        e.contract.expiration.getTime() === leg.contract.expiration.getTime()
    );

    if (!entry) continue;

    if (entry.openInterest < minOI) return false;
    if (entry.volume < minVolume) return false;

    const mid = entry.mid || (entry.bid + entry.ask) / 2;
    if (mid > 0) {
      const spreadPct = ((entry.ask - entry.bid) / mid) * 100;
      if (spreadPct > maxSpreadPct) return false;
    }
  }

  return true;
}

// ─── IV Skew Analysis ───────────────────────────────────

/**
 * Analyze IV skew from option chain.
 * Put skew = OTM puts have higher IV than OTM calls (typical)
 * Call skew = OTM calls have higher IV (unusual, often before events)
 */
export function analyzeIVSkew(
  chain: OptionChainEntry[],
  underlyingPrice: number,
  expiration: Date
): IVSkewAnalysis | null {
  const expirationTime = expiration.getTime();
  const relevantEntries = chain.filter(
    (e) => e.contract.expiration.getTime() === expirationTime && e.iv > 0
  );

  if (relevantEntries.length < 4) return null;

  const calls = relevantEntries
    .filter((e) => e.contract.type === "call")
    .sort((a, b) => a.contract.strike - b.contract.strike);
  const puts = relevantEntries
    .filter((e) => e.contract.type === "put")
    .sort((a, b) => a.contract.strike - b.contract.strike);

  // Find ATM IV (closest strike to underlying price)
  const allEntries = [...calls, ...puts];
  const atmEntry = allEntries.reduce((prev, curr) =>
    Math.abs(curr.contract.strike - underlyingPrice) < Math.abs(prev.contract.strike - underlyingPrice)
      ? curr : prev
  );
  const atmIV = atmEntry.iv;

  // Find ~25-delta OTM options (approximately 5-10% OTM)
  const otmPut = puts.find(
    (p) => p.contract.strike <= underlyingPrice * 0.95 && p.contract.strike >= underlyingPrice * 0.85
  );
  const otmCall = calls.find(
    (c) => c.contract.strike >= underlyingPrice * 1.05 && c.contract.strike <= underlyingPrice * 1.15
  );

  const otmPutIV = otmPut?.iv || atmIV;
  const otmCallIV = otmCall?.iv || atmIV;

  const skewRatio = otmCallIV > 0 ? otmPutIV / otmCallIV : 1;

  let direction: "put_skew" | "call_skew" | "neutral";
  let magnitude: number;

  if (skewRatio > 1.15) {
    direction = "put_skew";
    magnitude = Math.min(100, (skewRatio - 1) * 100);
  } else if (skewRatio < 0.85) {
    direction = "call_skew";
    magnitude = Math.min(100, (1 - skewRatio) * 100);
  } else {
    direction = "neutral";
    magnitude = Math.abs(skewRatio - 1) * 100;
  }

  let suggestion = "";
  if (direction === "put_skew" && magnitude > 15) {
    suggestion = "Strong put skew — consider selling OTM puts (credit spreads) for higher premium, or buying call spreads.";
  } else if (direction === "call_skew" && magnitude > 15) {
    suggestion = "Unusual call skew — possible event expected. Consider selling OTM calls or buying put protection.";
  } else {
    suggestion = "IV skew is balanced — standard strategies appropriate.";
  }

  return {
    direction,
    magnitude: Math.round(magnitude),
    atmIV: Math.round(atmIV * 1000) / 10, // as percentage
    otmPutIV: Math.round(otmPutIV * 1000) / 10,
    otmCallIV: Math.round(otmCallIV * 1000) / 10,
    skewRatio: Math.round(skewRatio * 100) / 100,
    suggestion,
  };
}

// ─── Utility ────────────────────────────────────────────

/** Standard normal CDF approximation (Abramowitz & Stegun) */
function normalCDF(x: number): number {
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x) / Math.sqrt(2);

  const t = 1.0 / (1.0 + p * x);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);

  return 0.5 * (1.0 + sign * y);
}
