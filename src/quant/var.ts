/**
 * Value at Risk (VaR) Calculator
 *
 * Implements three VaR methods:
 *   1. Historical Simulation (HS-VaR) — primary method per spec
 *   2. Parametric (Variance-Covariance)
 *   3. Monte Carlo Simulation
 *
 * Also includes stress testing with ±15% underlying movement.
 */

import type {
  VaRResult,
  StressTestResult,
} from "../types/portfolio.js";
import type { HistoricalReturn } from "../types/market.js";

/**
 * Historical Simulation VaR (HS-VaR).
 *
 * Sorts historical returns and picks the loss at the given percentile.
 * No distributional assumptions — uses actual observed returns.
 *
 * @param returns     - Array of historical daily returns (as decimals)
 * @param portfolioValue - Current portfolio value
 * @param confidence  - Confidence level (0.95 or 0.99)
 * @param horizon     - Time horizon in days (default 1)
 */
export function historicalVaR(
  returns: number[],
  portfolioValue: number,
  confidence: number = 0.95,
  horizon: number = 1
): { var: number; cvar: number } {
  if (returns.length === 0) {
    throw new Error("Cannot calculate VaR with empty returns array");
  }

  // Sort returns ascending (worst to best)
  const sorted = [...returns].sort((a, b) => a - b);

  // VaR index: for 95% confidence with 250 observations, index = 12 (5th percentile)
  const index = Math.floor(sorted.length * (1 - confidence));
  const varReturn = sorted[Math.max(index, 0)];

  // Scale to multi-day horizon: VaR_T = VaR_1 × √T
  const scaledVaR = Math.abs(varReturn) * Math.sqrt(horizon) * portfolioValue;

  // Conditional VaR (CVaR / Expected Shortfall):
  // Average of all returns worse than VaR
  const tailReturns = sorted.slice(0, Math.max(index, 1));
  const avgTailReturn =
    tailReturns.reduce((sum, r) => sum + r, 0) / tailReturns.length;
  const scaledCVaR =
    Math.abs(avgTailReturn) * Math.sqrt(horizon) * portfolioValue;

  return { var: scaledVaR, cvar: scaledCVaR };
}

/**
 * Parametric VaR (Variance-Covariance method).
 *
 * Assumes returns are normally distributed.
 * VaR = μ - z_α × σ
 */
export function parametricVaR(
  returns: number[],
  portfolioValue: number,
  confidence: number = 0.95,
  horizon: number = 1
): { var: number; cvar: number } {
  const n = returns.length;
  if (n === 0) throw new Error("Cannot calculate VaR with empty returns");

  const mean = returns.reduce((s, r) => s + r, 0) / n;
  const variance =
    returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (n - 1);
  const stdDev = Math.sqrt(variance);

  // Z-scores for common confidence levels
  const zScores: Record<string, number> = {
    "0.9": 1.282,
    "0.95": 1.645,
    "0.99": 2.326,
  };
  const z = zScores[confidence.toString()] ?? 1.645;

  const dailyVaR = (mean - z * stdDev) * portfolioValue;
  const scaledVaR = Math.abs(dailyVaR) * Math.sqrt(horizon);

  // CVaR for normal distribution: CVaR = μ + σ × φ(z)/α
  const phi = Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI);
  const alpha = 1 - confidence;
  const dailyCVaR = Math.abs((mean - stdDev * (phi / alpha)) * portfolioValue);
  const scaledCVaR = dailyCVaR * Math.sqrt(horizon);

  return { var: scaledVaR, cvar: scaledCVaR };
}

/**
 * Monte Carlo VaR simulation.
 *
 * Generates random scenarios using geometric Brownian motion.
 * More flexible than parametric — can handle fat tails via distribution choice.
 */
export function monteCarloVaR(
  returns: number[],
  portfolioValue: number,
  confidence: number = 0.95,
  horizon: number = 1,
  simulations: number = 10_000
): { var: number; cvar: number } {
  const n = returns.length;
  if (n === 0) throw new Error("Cannot calculate VaR with empty returns");

  const mean = returns.reduce((s, r) => s + r, 0) / n;
  const variance =
    returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (n - 1);
  const stdDev = Math.sqrt(variance);

  // Generate simulated returns using Box-Muller transform
  const simulatedPnL: number[] = [];
  for (let i = 0; i < simulations; i++) {
    let cumulativeReturn = 0;
    for (let d = 0; d < horizon; d++) {
      // Box-Muller for normal random
      const u1 = Math.random();
      const u2 = Math.random();
      const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      cumulativeReturn += mean + stdDev * z;
    }
    simulatedPnL.push(cumulativeReturn * portfolioValue);
  }

  // Sort and extract VaR
  simulatedPnL.sort((a, b) => a - b);
  const varIndex = Math.floor(simulations * (1 - confidence));
  const varValue = Math.abs(simulatedPnL[varIndex]);

  // CVaR: average of tail losses
  const tailLosses = simulatedPnL.slice(0, varIndex);
  const cvar =
    Math.abs(tailLosses.reduce((s, v) => s + v, 0) / tailLosses.length);

  return { var: varValue, cvar };
}

/**
 * Run stress tests simulating extreme underlying moves.
 * Per spec: simulate ±15% underlying price movement.
 */
export function stressTest(
  portfolioValue: number,
  portfolioDelta: number,
  portfolioGamma: number,
  underlyingPrice: number,
  magnitudePct: number = 15
): StressTestResult[] {
  const scenarios: StressTestResult[] = [];
  const moves = [-magnitudePct, -magnitudePct / 2, magnitudePct / 2, magnitudePct];

  for (const movePct of moves) {
    const priceMove = underlyingPrice * (movePct / 100);

    // Taylor expansion: ΔP ≈ δ·ΔS + ½γ·(ΔS)²
    const pnl =
      portfolioDelta * priceMove +
      0.5 * portfolioGamma * priceMove * priceMove;

    scenarios.push({
      scenario: `${movePct > 0 ? "+" : ""}${movePct}% underlying move`,
      underlyingMove: movePct,
      portfolioPnL: pnl,
      worstCaseLoss: Math.min(pnl, 0),
    });
  }

  return scenarios;
}

/**
 * Full VaR calculation with stress testing.
 * This is the main function called by the Risk Sentinel.
 */
export function calculateFullVaR(
  historicalReturns: number[],
  portfolioValue: number,
  portfolioDelta: number,
  portfolioGamma: number,
  underlyingPrice: number,
  confidence: number = 0.95,
  horizon: number = 1,
  stressMagnitude: number = 15
): VaRResult {
  const { var: varValue, cvar } = historicalVaR(
    historicalReturns,
    portfolioValue,
    confidence,
    horizon
  );

  const stressTests = stressTest(
    portfolioValue,
    portfolioDelta,
    portfolioGamma,
    underlyingPrice,
    stressMagnitude
  );

  return {
    var: varValue,
    confidenceLevel: confidence,
    horizon,
    cvar,
    method: "historical",
    stressTests,
  };
}

/**
 * Check if a proposed trade passes the risk limit.
 * Enforces the 1-2% max risk per trade rule.
 */
export function validateTradeRisk(
  tradeMaxLoss: number,
  portfolioValue: number,
  maxRiskPct: number = 2
): { passes: boolean; riskPct: number; message: string } {
  // Guard against zero/missing portfolio value (e.g. IBKR account summary timed out)
  if (!portfolioValue || portfolioValue <= 0) {
    return {
      passes: false,
      riskPct: 0,
      message: "BLOCKED: Cannot validate risk — portfolio value is $0. Check IBKR connection.",
    };
  }

  const riskPct = (Math.abs(tradeMaxLoss) / portfolioValue) * 100;
  const passes = riskPct <= maxRiskPct;

  return {
    passes,
    riskPct,
    message: passes
      ? `Trade risk ${riskPct.toFixed(2)}% is within ${maxRiskPct}% limit`
      : `BLOCKED: Trade risk ${riskPct.toFixed(2)}% exceeds ${maxRiskPct}% limit`,
  };
}
