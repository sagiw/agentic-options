/**
 * SHAP-like Feature Importance for Strategy Recommendations
 *
 * Computes the marginal contribution of each factor to the
 * overall strategy score. This is a simplified SHAP approximation
 * (not exact Shapley values, which require combinatorial computation).
 *
 * Factors analyzed:
 *   - IV Rank / IV Percentile
 *   - Delta / Gamma exposure
 *   - Risk/Reward ratio
 *   - Capital efficiency
 *   - Time decay (Theta)
 *   - News sentiment
 *   - Technical levels (support/resistance proximity)
 */

import type { StrategyFactor } from "../types/agents.js";
import type { OptionsStrategy } from "../types/options.js";
import type { Greeks } from "../types/options.js";

/** Full SHAP-like analysis result */
export interface SHAPAnalysis {
  factors: StrategyFactor[];
  baselineScore: number;
  finalScore: number;
  totalContribution: number;
}

/**
 * Compute SHAP-like factor contributions for a strategy.
 *
 * Uses a leave-one-out approximation:
 *   contribution_i = score_full - score_without_i
 */
export function computeSHAPFactors(
  strategy: OptionsStrategy,
  greeks: Greeks,
  underlyingPrice: number,
  ivRank: number,
  newsSentiment: number = 0,
  technicalScore: number = 50
): SHAPAnalysis {
  // Baseline score (mean of all strategies in the universe)
  const baselineScore = 50;

  const factors: StrategyFactor[] = [];

  // ── 1. IV Rank Factor ─────────────────────────────────────
  const isCreditStrategy = strategy.netDebit < 0;
  const ivFactor = isCreditStrategy ? ivRank / 100 : (100 - ivRank) / 100;
  factors.push({
    name: "IV Rank",
    value: ivRank,
    weight: 0.25,
    contribution: (ivFactor - 0.5) * 25, // centered around 0
  });

  // ── 2. Risk/Reward Ratio ──────────────────────────────────
  const maxProfit =
    strategy.maxProfit === "unlimited"
      ? strategy.maxLoss * 3
      : strategy.maxProfit;
  const riskReward = maxProfit / Math.max(strategy.maxLoss, 1);
  factors.push({
    name: "Risk/Reward",
    value: riskReward,
    weight: 0.20,
    contribution: Math.min((riskReward - 1) * 10, 20),
  });

  // ── 3. Delta Exposure ─────────────────────────────────────
  // Neutral delta strategies score higher for income generation
  const deltaScore = 1 - Math.abs(greeks.delta);
  factors.push({
    name: "Delta Neutrality",
    value: greeks.delta,
    weight: 0.15,
    contribution: (deltaScore - 0.5) * 15,
  });

  // ── 4. Theta (Time Decay) ────────────────────────────────
  // Positive theta (selling premium) is generally favorable
  const thetaContribution = greeks.theta > 0 ? 10 : -5;
  factors.push({
    name: "Theta Decay",
    value: greeks.theta,
    weight: 0.15,
    contribution: thetaContribution,
  });

  // ── 5. Capital Efficiency ─────────────────────────────────
  const capitalEff = maxProfit / Math.max(strategy.requiredCapital, 1);
  factors.push({
    name: "Capital Efficiency",
    value: capitalEff,
    weight: 0.10,
    contribution: Math.min(capitalEff * 10, 10),
  });

  // ── 6. News Sentiment ─────────────────────────────────────
  // Bullish sentiment boosts call strategies, bearish boosts puts
  const hasCalls = strategy.legs.some(
    (l) => l.contract.type === "call" && l.side === "buy"
  );
  const sentimentAlign = hasCalls ? newsSentiment : -newsSentiment;
  factors.push({
    name: "News Sentiment",
    value: newsSentiment,
    weight: 0.08,
    contribution: sentimentAlign * 8,
  });

  // ── 7. Technical Score ────────────────────────────────────
  factors.push({
    name: "Technical Analysis",
    value: technicalScore,
    weight: 0.07,
    contribution: ((technicalScore - 50) / 50) * 7,
  });

  // Calculate final score
  const totalContribution = factors.reduce((sum, f) => sum + f.contribution, 0);
  const finalScore = Math.max(0, Math.min(100, baselineScore + totalContribution));

  return {
    factors,
    baselineScore,
    finalScore,
    totalContribution,
  };
}

/**
 * Format SHAP analysis as a human-readable text block.
 */
export function formatSHAPReport(analysis: SHAPAnalysis): string {
  const lines: string[] = [
    `Strategy Score: ${analysis.finalScore.toFixed(1)} / 100`,
    `(Baseline: ${analysis.baselineScore}, Net contribution: ${analysis.totalContribution > 0 ? "+" : ""}${analysis.totalContribution.toFixed(1)})`,
    "",
    "Factor Contributions:",
  ];

  const sorted = [...analysis.factors].sort(
    (a, b) => Math.abs(b.contribution) - Math.abs(a.contribution)
  );

  for (const f of sorted) {
    const bar =
      f.contribution >= 0
        ? "+" + "█".repeat(Math.round(Math.abs(f.contribution)))
        : "-" + "█".repeat(Math.round(Math.abs(f.contribution)));
    lines.push(
      `  ${f.name.padEnd(20)} ${bar.padEnd(25)} (${f.contribution > 0 ? "+" : ""}${f.contribution.toFixed(1)})`
    );
  }

  return lines.join("\n");
}
