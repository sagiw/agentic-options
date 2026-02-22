/**
 * Black-Scholes Option Pricing Model
 *
 * Implements the analytical Black-Scholes formula for European options,
 * plus Newton-Raphson IV solver for implied volatility extraction.
 *
 * Reference: Black, F. & Scholes, M. (1973)
 */

import type { OptionType } from "../types/options.js";

/**
 * Standard normal CDF (cumulative distribution function).
 * Uses Abramowitz & Stegun erf approximation (equation 7.1.26)
 * with relation: Φ(x) = (1 + erf(x/√2)) / 2
 */
export function normalCDF(x: number): number {
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  const sign = x < 0 ? -1 : 1;
  // These coefficients approximate erf(z), and Φ(x) = (1 + erf(x/√2))/2
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1.0 / (1.0 + p * z);
  const y =
    1.0 -
    ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-z * z);

  return 0.5 * (1.0 + sign * y);
}

/** Standard normal PDF (probability density function) */
export function normalPDF(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

/** Black-Scholes input parameters */
export interface BSParams {
  /** Current underlying price */
  S: number;
  /** Strike price */
  K: number;
  /** Time to expiration in years */
  T: number;
  /** Risk-free interest rate (annualized, e.g. 0.05 for 5%) */
  r: number;
  /** Volatility (annualized, e.g. 0.25 for 25%) */
  sigma: number;
  /** Dividend yield (annualized, e.g. 0.02 for 2%) */
  q?: number;
}

/** Calculate d1 and d2 intermediate values */
export function calcD1D2(params: BSParams): { d1: number; d2: number } {
  const { S, K, T, r, sigma, q = 0 } = params;

  if (T <= 0 || sigma <= 0) {
    throw new Error("T and sigma must be positive");
  }

  const d1 =
    (Math.log(S / K) + (r - q + 0.5 * sigma * sigma) * T) /
    (sigma * Math.sqrt(T));
  const d2 = d1 - sigma * Math.sqrt(T);

  return { d1, d2 };
}

/**
 * Black-Scholes European option price.
 *
 * Call: C = S·e^(-qT)·N(d1) - K·e^(-rT)·N(d2)
 * Put:  P = K·e^(-rT)·N(-d2) - S·e^(-qT)·N(-d1)
 */
export function blackScholesPrice(
  params: BSParams,
  type: OptionType
): number {
  const { S, K, T, r, q = 0 } = params;

  // Edge case: at or past expiration
  if (T <= 0) {
    if (type === "call") return Math.max(S - K, 0);
    return Math.max(K - S, 0);
  }

  const { d1, d2 } = calcD1D2(params);
  const discountFactor = Math.exp(-r * T);
  const dividendFactor = Math.exp(-q * T);

  if (type === "call") {
    return S * dividendFactor * normalCDF(d1) - K * discountFactor * normalCDF(d2);
  } else {
    return K * discountFactor * normalCDF(-d2) - S * dividendFactor * normalCDF(-d1);
  }
}

/**
 * Implied Volatility solver using Newton-Raphson method.
 *
 * Given a market price, finds the sigma that makes BS price == market price.
 * Converges in ~5-8 iterations for typical inputs.
 */
export function impliedVolatility(
  marketPrice: number,
  S: number,
  K: number,
  T: number,
  r: number,
  type: OptionType,
  q: number = 0,
  maxIterations: number = 100,
  tolerance: number = 1e-8
): number {
  // Initial guess using Brenner-Subrahmanyam approximation
  let sigma = Math.sqrt((2 * Math.PI) / T) * (marketPrice / S);
  if (sigma <= 0 || !isFinite(sigma)) sigma = 0.3; // fallback

  for (let i = 0; i < maxIterations; i++) {
    const params: BSParams = { S, K, T, r, sigma, q };
    const price = blackScholesPrice(params, type);
    const diff = price - marketPrice;

    if (Math.abs(diff) < tolerance) {
      return sigma;
    }

    // Vega = ∂C/∂σ = S·√T·N'(d1)·e^(-qT)
    const { d1 } = calcD1D2(params);
    const vega = S * Math.exp(-q * T) * normalPDF(d1) * Math.sqrt(T);

    if (vega < 1e-12) {
      // Vega too small, can't converge further
      return sigma;
    }

    sigma = sigma - diff / vega;

    // Clamp to reasonable bounds
    if (sigma < 0.001) sigma = 0.001;
    if (sigma > 10) sigma = 10;
  }

  throw new Error(
    `IV solver failed to converge after ${maxIterations} iterations. ` +
    `Last sigma: ${sigma.toFixed(6)}, Market price: ${marketPrice}`
  );
}

/**
 * Calculate theoretical price for a range of underlying prices.
 * Used for generating payoff diagrams.
 */
export function priceRange(
  params: BSParams,
  type: OptionType,
  pricePoints: number[]
): Array<{ underlyingPrice: number; optionPrice: number }> {
  return pricePoints.map((price) => ({
    underlyingPrice: price,
    optionPrice: blackScholesPrice({ ...params, S: price }, type),
  }));
}
