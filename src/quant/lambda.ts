/**
 * Lambda (Leverage) Calculator
 *
 * Lambda (λ) is the true measure of options leverage, representing
 * the percentage change in the option price for a 1% change in the
 * underlying price.
 *
 * Formula: λ = Δ × (S / C)
 *
 * Where:
 *   Δ = Option delta
 *   S = Current underlying (stock) price
 *   C = Current option price
 *
 * Usage: Higher lambda = more leverage. The system prioritizes
 * strategies based on lambda-adjusted returns relative to risk.
 */

import type { LambdaMetric, OptionChainEntry } from "../types/options.js";
import { calculateGreeks } from "./greeks.js";
import { blackScholesPrice, type BSParams } from "./black-scholes.js";
import type { OptionType } from "../types/options.js";

/**
 * Calculate Lambda for a single option.
 *
 * @param delta  - Option delta (from Greeks calculation)
 * @param S      - Current underlying price
 * @param C      - Current option price (mid or last)
 * @returns LambdaMetric object
 */
export function calculateLambda(
  delta: number,
  S: number,
  C: number
): LambdaMetric {
  if (C <= 0) {
    return { lambda: 0, delta, underlyingPrice: S, optionPrice: C };
  }

  const lambda = delta * (S / C);

  return {
    lambda,
    delta,
    underlyingPrice: S,
    optionPrice: C,
  };
}

/**
 * Calculate Lambda for every option in a chain.
 * Returns entries sorted by absolute lambda (highest leverage first).
 */
export function rankByLambda(
  chainEntries: OptionChainEntry[]
): Array<OptionChainEntry & { lambdaRank: number }> {
  const ranked = chainEntries
    .filter((e) => e.mid > 0) // exclude zero-priced options
    .map((entry) => ({
      ...entry,
      lambda: calculateLambda(entry.greeks.delta, entry.lambda.underlyingPrice, entry.mid),
      lambdaRank: 0,
    }))
    .sort((a, b) => Math.abs(b.lambda.lambda) - Math.abs(a.lambda.lambda));

  // Assign ranks
  ranked.forEach((entry, index) => {
    entry.lambdaRank = index + 1;
  });

  return ranked;
}

/**
 * Calculate Lambda across a range of strikes for visualization.
 * Useful for showing the leverage curve.
 */
export function lambdaCurve(
  underlyingPrice: number,
  strikes: number[],
  T: number,
  r: number,
  sigma: number,
  type: OptionType,
  q: number = 0
): Array<{ strike: number; lambda: number; delta: number; price: number }> {
  return strikes.map((K) => {
    const params: BSParams = { S: underlyingPrice, K, T, r, sigma, q };
    const greeks = calculateGreeks(params, type);
    const price = blackScholesPrice(params, type);
    const lambdaMetric = calculateLambda(greeks.delta, underlyingPrice, price);

    return {
      strike: K,
      lambda: lambdaMetric.lambda,
      delta: greeks.delta,
      price,
    };
  });
}

/**
 * Effective leverage ratio for a multi-leg strategy.
 * Weighted average of individual leg lambdas by capital allocation.
 */
export function strategyLambda(
  legs: Array<{
    delta: number;
    optionPrice: number;
    underlyingPrice: number;
    quantity: number;
    side: "buy" | "sell";
  }>
): number {
  let totalCapital = 0;
  let weightedLambda = 0;

  for (const leg of legs) {
    const legLambda = calculateLambda(
      leg.delta,
      leg.underlyingPrice,
      leg.optionPrice
    );
    const capital = Math.abs(leg.optionPrice * leg.quantity * 100);
    const direction = leg.side === "buy" ? 1 : -1;

    weightedLambda += legLambda.lambda * capital * direction;
    totalCapital += capital;
  }

  return totalCapital > 0 ? weightedLambda / totalCapital : 0;
}
