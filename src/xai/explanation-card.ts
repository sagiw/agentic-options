/**
 * Explainable AI (XAI) — Explanation Card Generator
 *
 * Every trade suggestion must be accompanied by an Explanation Card
 * showing WHY the system recommends it. This builds trust and enables
 * informed human-in-the-loop decisions.
 *
 * Components:
 *   1. SHAP-like factor attribution
 *   2. Payoff diagram data
 *   3. IV analysis narrative
 *   4. Risk warnings
 *   5. Confidence score
 */

import type { ExplanationCard, StrategyFactor, PayoffPoint } from "../types/agents.js";
import type { OptionsStrategy } from "../types/options.js";
import type { VaRResult } from "../types/portfolio.js";

/**
 * Generate a complete Explanation Card for a strategy recommendation.
 */
export function generateExplanationCard(
  strategy: OptionsStrategy,
  factors: StrategyFactor[],
  underlyingPrice: number,
  ivRank: number,
  varResult: VaRResult,
  overallScore: number
): ExplanationCard {
  return {
    summary: generateSummary(strategy, factors, ivRank),
    topFactors: getTopFactors(factors, 5),
    payoffDiagram: generatePayoffDiagram(strategy, underlyingPrice),
    ivAnalysis: generateIVAnalysis(ivRank, strategy),
    riskWarnings: generateRiskWarnings(strategy, varResult),
    confidence: overallScore / 100,
  };
}

/**
 * Generate human-readable summary of the recommendation.
 */
function generateSummary(
  strategy: OptionsStrategy,
  factors: StrategyFactor[],
  ivRank: number
): string {
  const topFactor = factors.sort((a, b) => b.contribution - a.contribution)[0];
  const direction =
    strategy.netDebit > 0 ? "debit" : "credit";
  const ivContext =
    ivRank > 70
      ? "elevated implied volatility"
      : ivRank < 30
        ? "depressed implied volatility"
        : "moderate implied volatility";

  return (
    `Recommending ${strategy.name} as a ${direction} strategy. ` +
    `Primary driver: ${topFactor?.name ?? "multiple factors"} ` +
    `(contribution: ${topFactor?.contribution.toFixed(1) ?? "N/A"}%). ` +
    `Current IV environment: ${ivContext} (IV Rank: ${ivRank}).`
  );
}

/**
 * Get top N factors sorted by contribution (SHAP-like).
 */
function getTopFactors(
  factors: StrategyFactor[],
  n: number
): StrategyFactor[] {
  return [...factors]
    .sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution))
    .slice(0, n);
}

/**
 * Generate payoff diagram data points.
 *
 * Creates a T+0 and expiration PnL curve across a range
 * of underlying prices.
 */
function generatePayoffDiagram(
  strategy: OptionsStrategy,
  underlyingPrice: number,
  points: number = 50
): PayoffPoint[] {
  const diagram: PayoffPoint[] = [];
  const range = underlyingPrice * 0.3; // ±30% range
  const step = (2 * range) / points;

  for (let i = 0; i <= points; i++) {
    const price = underlyingPrice - range + i * step;
    const pnl = calculateExpirationPnL(strategy, price);

    let label: string | undefined;
    // Mark breakeven points
    for (const be of strategy.breakeven) {
      if (Math.abs(price - be) < step / 2) {
        label = "breakeven";
      }
    }
    // Mark max profit / max loss regions
    if (
      strategy.maxProfit !== "unlimited" &&
      Math.abs(pnl - strategy.maxProfit) < 1
    ) {
      label = "max profit";
    }
    if (Math.abs(pnl - (-strategy.maxLoss)) < 1) {
      label = "max loss";
    }

    diagram.push({ underlyingPrice: price, pnl, label });
  }

  return diagram;
}

/**
 * Calculate P&L at expiration for a given underlying price.
 * Sums intrinsic values of all legs minus net debit.
 */
function calculateExpirationPnL(
  strategy: OptionsStrategy,
  underlyingPriceAtExp: number
): number {
  let totalPnL = 0;

  for (const leg of strategy.legs) {
    const { contract, side, quantity, price } = leg;
    const direction = side === "buy" ? 1 : -1;

    // Intrinsic value at expiration
    let intrinsic: number;
    if (contract.type === "call") {
      intrinsic = Math.max(underlyingPriceAtExp - contract.strike, 0);
    } else {
      intrinsic = Math.max(contract.strike - underlyingPriceAtExp, 0);
    }

    // PnL = (intrinsic - premium paid) × direction × quantity × multiplier
    const premium = price ?? 0;
    const legPnL = (intrinsic * direction - premium * direction) * quantity * contract.multiplier;
    totalPnL += legPnL;
  }

  return totalPnL;
}

/**
 * Generate IV analysis narrative.
 */
function generateIVAnalysis(
  ivRank: number,
  strategy: OptionsStrategy
): string {
  const isCreditStrategy = strategy.netDebit < 0;

  if (ivRank > 70) {
    return isCreditStrategy
      ? `IV Rank is high at ${ivRank}, which favors credit strategies like this one. ` +
        `Premium collected is elevated, improving the probability of profit.`
      : `IV Rank is high at ${ivRank}. Caution: buying options in high IV environments ` +
        `means paying elevated premiums. Consider waiting for IV contraction or ` +
        `switching to a credit strategy.`;
  }

  if (ivRank < 30) {
    return isCreditStrategy
      ? `IV Rank is low at ${ivRank}. Warning: credit strategies in low IV environments ` +
        `collect less premium, reducing the profit buffer. Consider debit strategies instead.`
      : `IV Rank is low at ${ivRank}, which favors debit strategies like this one. ` +
        `Options are relatively cheap, providing better leverage.`;
  }

  return `IV Rank is neutral at ${ivRank}. No strong IV-directional bias.`;
}

/**
 * Generate risk warnings based on strategy and VaR.
 */
function generateRiskWarnings(
  strategy: OptionsStrategy,
  varResult: VaRResult
): string[] {
  const warnings: string[] = [];

  // Max loss warning
  warnings.push(
    `Maximum loss: $${strategy.maxLoss.toLocaleString()} ` +
    `(${((strategy.maxLoss / strategy.requiredCapital) * 100).toFixed(1)}% of capital required)`
  );

  // VaR warning
  warnings.push(
    `Portfolio VaR (${(varResult.confidenceLevel * 100).toFixed(0)}%): ` +
    `$${varResult.var.toLocaleString(undefined, { maximumFractionDigits: 0 })}`
  );

  // Stress test warnings
  for (const test of varResult.stressTests) {
    if (test.worstCaseLoss < -strategy.maxLoss * 0.5) {
      warnings.push(
        `Stress test "${test.scenario}": ` +
        `portfolio impact $${test.portfolioPnL.toLocaleString(undefined, { maximumFractionDigits: 0 })}`
      );
    }
  }

  // Undefined risk warning
  if (strategy.maxProfit === "unlimited" || strategy.maxLoss > strategy.requiredCapital) {
    warnings.push(
      "This strategy has undefined or outsized risk. " +
      "Ensure position sizing is appropriate."
    );
  }

  return warnings;
}

export { calculateExpirationPnL };
