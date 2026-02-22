/**
 * Options Greeks Calculator
 *
 * Computes all first and second-order Greeks using the Black-Scholes model.
 * All values are per-share (divide by 100 for per-contract if multiplier=100).
 *
 * First-order: Delta, Gamma, Theta, Vega, Rho
 * Second-order: Vanna, Charm, Vomma, Color
 */

import type { OptionType, Greeks } from "../types/options.js";
import {
  normalCDF,
  normalPDF,
  calcD1D2,
  type BSParams,
} from "./black-scholes.js";

/**
 * Calculate all first-order Greeks.
 *
 * Delta (Δ): ∂V/∂S
 *   Call: e^(-qT)·N(d1)
 *   Put:  e^(-qT)·[N(d1) - 1]
 *
 * Gamma (Γ): ∂²V/∂S² = e^(-qT)·N'(d1) / (S·σ·√T)
 *
 * Theta (Θ): ∂V/∂t (per calendar day, negative = decay)
 *   Call: -[S·σ·e^(-qT)·N'(d1)] / (2√T) - r·K·e^(-rT)·N(d2) + q·S·e^(-qT)·N(d1)
 *   Put:  -[S·σ·e^(-qT)·N'(d1)] / (2√T) + r·K·e^(-rT)·N(-d2) - q·S·e^(-qT)·N(-d1)
 *
 * Vega (ν): ∂V/∂σ = S·e^(-qT)·√T·N'(d1) (per 1% move = /100)
 *
 * Rho (ρ): ∂V/∂r
 *   Call: K·T·e^(-rT)·N(d2)
 *   Put:  -K·T·e^(-rT)·N(-d2)
 */
export function calculateGreeks(
  params: BSParams,
  type: OptionType
): Greeks {
  const { S, K, T, r, sigma, q = 0 } = params;

  // Edge case: expired
  if (T <= 0) {
    const intrinsic =
      type === "call" ? Math.max(S - K, 0) : Math.max(K - S, 0);
    return {
      delta: intrinsic > 0 ? (type === "call" ? 1 : -1) : 0,
      gamma: 0,
      theta: 0,
      vega: 0,
      rho: 0,
    };
  }

  const { d1, d2 } = calcD1D2(params);
  const sqrtT = Math.sqrt(T);
  const expMinusQT = Math.exp(-q * T);
  const expMinusRT = Math.exp(-r * T);
  const nd1 = normalPDF(d1);

  // ─── Delta ────────────────────────────────────────────────
  const delta =
    type === "call"
      ? expMinusQT * normalCDF(d1)
      : expMinusQT * (normalCDF(d1) - 1);

  // ─── Gamma (same for calls and puts) ──────────────────────
  const gamma = (expMinusQT * nd1) / (S * sigma * sqrtT);

  // ─── Theta (per calendar day) ─────────────────────────────
  const thetaCommon = -(S * sigma * expMinusQT * nd1) / (2 * sqrtT);
  let theta: number;
  if (type === "call") {
    theta =
      thetaCommon -
      r * K * expMinusRT * normalCDF(d2) +
      q * S * expMinusQT * normalCDF(d1);
  } else {
    theta =
      thetaCommon +
      r * K * expMinusRT * normalCDF(-d2) -
      q * S * expMinusQT * normalCDF(-d1);
  }
  // Convert from per-year to per-calendar-day
  theta = theta / 365;

  // ─── Vega (per 1% IV move) ────────────────────────────────
  const vega = (S * expMinusQT * sqrtT * nd1) / 100;

  // ─── Rho (per 1% rate move) ───────────────────────────────
  const rho =
    type === "call"
      ? (K * T * expMinusRT * normalCDF(d2)) / 100
      : (-K * T * expMinusRT * normalCDF(-d2)) / 100;

  return { delta, gamma, theta, vega, rho };
}

/** Aggregate Greeks across multiple positions */
export function aggregateGreeks(
  positions: Array<{
    greeks: Greeks;
    quantity: number;
    multiplier: number;
  }>
): Greeks {
  const total: Greeks = { delta: 0, gamma: 0, theta: 0, vega: 0, rho: 0 };

  for (const pos of positions) {
    const scale = pos.quantity * pos.multiplier;
    total.delta += pos.greeks.delta * scale;
    total.gamma += pos.greeks.gamma * scale;
    total.theta += pos.greeks.theta * scale;
    total.vega += pos.greeks.vega * scale;
    total.rho += pos.greeks.rho * scale;
  }

  return total;
}

/**
 * Second-order Greeks (extended analytics)
 */
export interface SecondOrderGreeks {
  /** ∂Δ/∂σ = ∂ν/∂S — Delta sensitivity to volatility */
  vanna: number;
  /** ∂Δ/∂t — Delta decay over time */
  charm: number;
  /** ∂ν/∂σ = ∂²V/∂σ² — Vega convexity */
  vomma: number;
  /** ∂Γ/∂t — Gamma decay over time */
  color: number;
}

export function calculateSecondOrderGreeks(
  params: BSParams
): SecondOrderGreeks {
  const { S, T, sigma, q = 0 } = params;

  if (T <= 0) {
    return { vanna: 0, charm: 0, vomma: 0, color: 0 };
  }

  const { d1, d2 } = calcD1D2(params);
  const sqrtT = Math.sqrt(T);
  const expMinusQT = Math.exp(-q * T);
  const nd1 = normalPDF(d1);

  // Vanna: -e^(-qT) · N'(d1) · d2/σ
  const vanna = -expMinusQT * nd1 * (d2 / sigma);

  // Charm: -e^(-qT) · N'(d1) · [2(r-q)T - d2·σ·√T] / (2T·σ·√T)
  const { r } = params;
  const charm =
    -expMinusQT *
    nd1 *
    ((2 * (r - q) * T - d2 * sigma * sqrtT) / (2 * T * sigma * sqrtT));

  // Vomma: S · e^(-qT) · √T · N'(d1) · (d1·d2)/σ
  const vomma = (S * expMinusQT * sqrtT * nd1 * d1 * d2) / sigma;

  // Color: -e^(-qT) · N'(d1) / (2S·T·σ·√T) · [2qT + 1 + d1·(2(r-q)T - d2·σ·√T)/(σ·√T)]
  const color =
    (-expMinusQT * nd1) /
    (2 * S * T * sigma * sqrtT) *
    (2 * q * T +
      1 +
      (d1 * (2 * (r - q) * T - d2 * sigma * sqrtT)) / (sigma * sqrtT));

  return { vanna, charm, vomma, color };
}
