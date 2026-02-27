/**
 * Portfolio-Aware Strategy Analysis
 *
 * Analyzes existing portfolio to:
 *   - Track net delta exposure per symbol and portfolio-wide
 *   - Calculate sector/symbol concentration
 *   - Suggest delta-hedging strategies
 *   - Filter strategies that would over-concentrate risk
 *   - Compute portfolio correlation risk
 *   - Kelly Criterion position sizing
 */

import type { Portfolio, Position, PortfolioGreeks } from "../types/portfolio.js";
import type { OptionsStrategy, StrategyType } from "../types/options.js";
import { agentLogger } from "../utils/logger.js";

const log = agentLogger("portfolio-analysis");

// ─── Interfaces ─────────────────────────────────────────

export interface PortfolioContext {
  /** Net delta per underlying symbol */
  deltaBySymbol: Map<string, number>;
  /** Total portfolio delta */
  totalDelta: number;
  /** Total portfolio theta (daily) */
  totalTheta: number;
  /** Total portfolio vega */
  totalVega: number;
  /** Beta-weighted delta */
  betaWeightedDelta: number;
  /** Market value exposure per symbol */
  exposureBySymbol: Map<string, number>;
  /** Concentration as pct of net liq per symbol */
  concentrationBySymbol: Map<string, number>;
  /** Symbols where we hold 100+ shares (for covered call candidates) */
  coveredCallCandidates: string[];
  /** Max exposure pct for any single symbol */
  maxConcentration: number;
  /** Number of unique underlyings */
  uniqueUnderlyings: number;
  /** Existing strategy types per symbol */
  existingStrategies: Map<string, string[]>;
}

export interface PortfolioAdjustment {
  type: "delta_hedge" | "reduce_concentration" | "add_diversification" | "harvest_theta";
  priority: "high" | "medium" | "low";
  message: string;
  suggestedStrategy?: StrategyType;
  targetSymbol?: string;
}

export interface KellyCriterionResult {
  /** Optimal fraction of capital to risk (0-1) */
  optimalFraction: number;
  /** Conservative Kelly (half-Kelly) */
  halfKelly: number;
  /** Suggested position size in dollars */
  suggestedSize: number;
  /** Maximum contracts based on Kelly */
  maxContracts: number;
}

// ─── Constants ──────────────────────────────────────────

const MAX_CONCENTRATION_PCT = 20; // Max 20% of portfolio in one symbol
const DELTA_NEUTRAL_THRESHOLD = 50; // Portfolio delta > this triggers hedge suggestion
const SECTOR_MAP: Record<string, string> = {
  // Tech
  AAPL: "tech", MSFT: "tech", GOOG: "tech", GOOGL: "tech", AMZN: "tech",
  META: "tech", NVDA: "tech", TSM: "tech", AVGO: "tech", ORCL: "tech",
  CRM: "tech", ADBE: "tech", AMD: "tech", INTC: "tech", CSCO: "tech",
  IBM: "tech", QCOM: "tech", TXN: "tech", MU: "tech", AMAT: "tech",
  // Finance
  JPM: "finance", BAC: "finance", WFC: "finance", GS: "finance", MS: "finance",
  C: "finance", BLK: "finance", SCHW: "finance", AXP: "finance", V: "finance",
  MA: "finance",
  // Healthcare
  JNJ: "health", UNH: "health", PFE: "health", ABBV: "health", MRK: "health",
  LLY: "health", TMO: "health", ABT: "health", AMGN: "health", BMY: "health",
  // Consumer
  WMT: "consumer", PG: "consumer", KO: "consumer", PEP: "consumer", COST: "consumer",
  HD: "consumer", MCD: "consumer", NKE: "consumer", SBUX: "consumer", TGT: "consumer",
  // Energy
  XOM: "energy", CVX: "energy", COP: "energy", SLB: "energy", EOG: "energy",
  // Industrial
  CAT: "industrial", DE: "industrial", BA: "industrial", HON: "industrial", UPS: "industrial",
  // ETFs
  SPY: "index", QQQ: "tech_index", IWM: "small_cap_index", DIA: "index", TLT: "bonds",
  GLD: "commodity", SLV: "commodity", USO: "commodity",
  // EV / High-vol
  TSLA: "ev", RIVN: "ev", LCID: "ev", NIO: "ev",
};

// Correlation pairs (approximate correlation coefficients between sectors)
const SECTOR_CORRELATIONS: Record<string, Record<string, number>> = {
  tech: { tech: 1, finance: 0.6, health: 0.3, consumer: 0.5, energy: 0.2, ev: 0.7, tech_index: 0.95, index: 0.85 },
  finance: { tech: 0.6, finance: 1, health: 0.4, consumer: 0.5, energy: 0.4, ev: 0.3, index: 0.8 },
  health: { tech: 0.3, finance: 0.4, health: 1, consumer: 0.4, energy: 0.2, ev: 0.2, index: 0.6 },
  consumer: { tech: 0.5, finance: 0.5, health: 0.4, consumer: 1, energy: 0.3, ev: 0.3, index: 0.7 },
  energy: { tech: 0.2, finance: 0.4, health: 0.2, consumer: 0.3, energy: 1, ev: 0.1, index: 0.5 },
  ev: { tech: 0.7, finance: 0.3, health: 0.2, consumer: 0.3, energy: 0.1, ev: 1, index: 0.5 },
  index: { tech: 0.85, finance: 0.8, health: 0.6, consumer: 0.7, energy: 0.5, ev: 0.5, index: 1 },
  tech_index: { tech: 0.95, finance: 0.55, health: 0.25, consumer: 0.45, energy: 0.15, ev: 0.7, index: 0.9, tech_index: 1 },
};

/**
 * Analyze the current portfolio to build a context for strategy selection.
 */
export function analyzePortfolio(portfolio: Portfolio): PortfolioContext {
  const deltaBySymbol = new Map<string, number>();
  const exposureBySymbol = new Map<string, number>();
  const concentrationBySymbol = new Map<string, number>();
  const existingStrategies = new Map<string, string[]>();
  const coveredCallCandidates: string[] = [];
  const netLiq = portfolio.account.netLiquidation || 1;

  for (const pos of portfolio.positions) {
    const symbol = pos.contract.type === "stock"
      ? pos.contract.symbol
      : (pos.contract as any).underlying || pos.contract.symbol;

    // Track delta
    const positionDelta = pos.greeks?.delta
      ? pos.greeks.delta * pos.quantity * (pos.contract.type === "stock" ? 1 : 100)
      : pos.contract.type === "stock" ? pos.quantity : 0;
    deltaBySymbol.set(symbol, (deltaBySymbol.get(symbol) || 0) + positionDelta);

    // Track market value exposure
    exposureBySymbol.set(symbol, (exposureBySymbol.get(symbol) || 0) + Math.abs(pos.marketValue));

    // Track existing strategies
    if (pos.contract.type !== "stock") {
      const existing = existingStrategies.get(symbol) || [];
      existing.push(`${(pos.contract as any).type}_${pos.quantity > 0 ? "long" : "short"}`);
      existingStrategies.set(symbol, existing);
    }

    // Covered call candidates: 100+ shares
    if (pos.contract.type === "stock" && pos.quantity >= 100) {
      if (!coveredCallCandidates.includes(symbol)) {
        coveredCallCandidates.push(symbol);
      }
    }
  }

  // Compute concentrations
  let maxConcentration = 0;
  for (const [sym, exposure] of exposureBySymbol) {
    const pct = (exposure / netLiq) * 100;
    concentrationBySymbol.set(sym, pct);
    if (pct > maxConcentration) maxConcentration = pct;
  }

  return {
    deltaBySymbol,
    totalDelta: portfolio.greeks.totalDelta,
    totalTheta: portfolio.greeks.totalTheta,
    totalVega: portfolio.greeks.totalVega,
    betaWeightedDelta: portfolio.greeks.betaWeightedDelta,
    exposureBySymbol,
    concentrationBySymbol,
    coveredCallCandidates,
    maxConcentration,
    uniqueUnderlyings: exposureBySymbol.size,
    existingStrategies,
  };
}

/**
 * Generate portfolio adjustment suggestions based on current state.
 */
export function getPortfolioAdjustments(ctx: PortfolioContext): PortfolioAdjustment[] {
  const adjustments: PortfolioAdjustment[] = [];

  // 1. Delta hedge suggestion
  if (Math.abs(ctx.totalDelta) > DELTA_NEUTRAL_THRESHOLD) {
    const direction = ctx.totalDelta > 0 ? "long" : "short";
    const hedgeType: StrategyType = ctx.totalDelta > 0 ? "bear_put_spread" : "bull_call_spread";
    adjustments.push({
      type: "delta_hedge",
      priority: Math.abs(ctx.totalDelta) > DELTA_NEUTRAL_THRESHOLD * 2 ? "high" : "medium",
      message: `Portfolio is net ${direction} with delta ${ctx.totalDelta.toFixed(0)}. Consider ${hedgeType} to reduce directional risk.`,
      suggestedStrategy: hedgeType,
    });
  }

  // 2. Concentration warnings
  for (const [sym, pct] of ctx.concentrationBySymbol) {
    if (pct > MAX_CONCENTRATION_PCT) {
      adjustments.push({
        type: "reduce_concentration",
        priority: pct > MAX_CONCENTRATION_PCT * 1.5 ? "high" : "medium",
        message: `${sym} is ${pct.toFixed(1)}% of portfolio (max ${MAX_CONCENTRATION_PCT}%). Consider reducing exposure.`,
        targetSymbol: sym,
      });
    }
  }

  // 3. Diversification if too few underlyings
  if (ctx.uniqueUnderlyings < 3 && ctx.uniqueUnderlyings > 0) {
    adjustments.push({
      type: "add_diversification",
      priority: "medium",
      message: `Portfolio has only ${ctx.uniqueUnderlyings} underlying(s). Consider adding positions in uncorrelated sectors.`,
    });
  }

  // 4. Theta harvesting opportunity
  if (ctx.totalTheta >= 0 || Math.abs(ctx.totalTheta) < 5) {
    adjustments.push({
      type: "harvest_theta",
      priority: "low",
      message: `Portfolio theta is ${ctx.totalTheta.toFixed(2)}/day. Consider selling premium (credit spreads, iron condors) for income.`,
      suggestedStrategy: "iron_condor",
    });
  }

  return adjustments;
}

/**
 * Check if adding a strategy would violate portfolio constraints.
 */
export function checkStrategyFit(
  strategy: OptionsStrategy,
  ctx: PortfolioContext,
  netLiquidation: number,
): { allowed: boolean; reason?: string; adjustedScore: number } {
  const underlying = strategy.legs[0]?.contract.underlying || strategy.legs[0]?.contract.symbol;
  if (!underlying) return { allowed: true, adjustedScore: 0 };

  let scoreAdjustment = 0;

  // 1. Concentration check
  const currentExposure = ctx.concentrationBySymbol.get(underlying) || 0;
  const additionalExposure = (strategy.requiredCapital / Math.max(netLiquidation, 1)) * 100;
  if (currentExposure + additionalExposure > MAX_CONCENTRATION_PCT * 1.5) {
    return {
      allowed: false,
      reason: `Would bring ${underlying} to ${(currentExposure + additionalExposure).toFixed(1)}% concentration (limit: ${MAX_CONCENTRATION_PCT}%)`,
      adjustedScore: -50,
    };
  }
  // Penalize if approaching concentration limit
  if (currentExposure + additionalExposure > MAX_CONCENTRATION_PCT) {
    scoreAdjustment -= 15;
  }

  // 2. Delta alignment — boost strategies that move portfolio delta toward neutral
  const currentDelta = ctx.deltaBySymbol.get(underlying) || 0;
  const strategyDelta = estimateStrategyDelta(strategy);
  const currentAbsDelta = Math.abs(ctx.totalDelta);
  const newAbsDelta = Math.abs(ctx.totalDelta + strategyDelta);
  if (newAbsDelta < currentAbsDelta) {
    // Strategy reduces portfolio delta — bonus
    scoreAdjustment += 10;
  } else if (newAbsDelta > currentAbsDelta * 1.5) {
    // Strategy significantly increases directional risk — penalty
    scoreAdjustment -= 10;
  }

  // 3. Correlation check — penalize if adding correlated exposure
  const newSector = SECTOR_MAP[underlying] || "other";
  for (const [existingSym] of ctx.exposureBySymbol) {
    const existingSector = SECTOR_MAP[existingSym] || "other";
    const correlation = SECTOR_CORRELATIONS[newSector]?.[existingSector] ?? 0.3;
    if (correlation > 0.7 && existingSym !== underlying) {
      scoreAdjustment -= 5; // Small penalty for correlated additions
    }
  }

  // 4. Covered call bonus — if we own shares, covered calls get a boost
  if (strategy.type === "covered_call" && ctx.coveredCallCandidates.includes(underlying)) {
    scoreAdjustment += 15;
  }

  return { allowed: true, adjustedScore: scoreAdjustment };
}

/**
 * Estimate the net delta of a strategy.
 */
function estimateStrategyDelta(strategy: OptionsStrategy): number {
  let netDelta = 0;
  for (const leg of strategy.legs) {
    // Approximate delta based on option type and side
    let legDelta = 0;
    if (leg.contract.type === "call") {
      legDelta = 0.5; // ATM call ≈ 0.5 delta
    } else if (leg.contract.type === "put") {
      legDelta = -0.5; // ATM put ≈ -0.5 delta
    } else {
      legDelta = 1; // Stock = 1 delta per share
    }
    const multiplier = leg.side === "sell" ? -1 : 1;
    netDelta += legDelta * multiplier * leg.quantity * 100;
  }
  return netDelta;
}

/**
 * Kelly Criterion position sizing.
 *
 * f* = (p × b - q) / b
 * where:
 *   p = probability of profit
 *   q = 1 - p (probability of loss)
 *   b = reward/risk ratio
 *
 * We use half-Kelly for conservative sizing.
 */
export function kellyPositionSize(
  strategy: OptionsStrategy,
  probabilityOfProfit: number,
  netLiquidation: number,
): KellyCriterionResult {
  const maxProfit = strategy.maxProfit === "unlimited"
    ? strategy.maxLoss * 2
    : strategy.maxProfit;
  const maxLoss = Math.abs(strategy.maxLoss);

  if (maxLoss <= 0 || probabilityOfProfit <= 0 || probabilityOfProfit >= 1) {
    return { optimalFraction: 0, halfKelly: 0, suggestedSize: 0, maxContracts: 0 };
  }

  const b = maxProfit / maxLoss; // reward/risk ratio
  const p = probabilityOfProfit;
  const q = 1 - p;

  // Kelly formula
  const f = (p * b - q) / b;

  // Clamp to [0, 0.25] — never risk more than 25% on one trade
  const optimalFraction = Math.max(0, Math.min(0.25, f));
  const halfKelly = optimalFraction / 2;

  const suggestedSize = halfKelly * netLiquidation;
  const maxContracts = maxLoss > 0
    ? Math.max(1, Math.floor(suggestedSize / maxLoss))
    : 1;

  return {
    optimalFraction,
    halfKelly,
    suggestedSize: Math.round(suggestedSize),
    maxContracts,
  };
}

/**
 * Get the sector for a symbol.
 */
export function getSector(symbol: string): string {
  return SECTOR_MAP[symbol] || "other";
}

/**
 * Compute portfolio correlation risk score (0-100, higher = more correlated = riskier).
 */
export function computeCorrelationRisk(ctx: PortfolioContext): number {
  const symbols = Array.from(ctx.exposureBySymbol.keys());
  if (symbols.length <= 1) return 0;

  let totalCorrelation = 0;
  let pairs = 0;

  for (let i = 0; i < symbols.length; i++) {
    for (let j = i + 1; j < symbols.length; j++) {
      const sectorA = SECTOR_MAP[symbols[i]] || "other";
      const sectorB = SECTOR_MAP[symbols[j]] || "other";
      const corr = SECTOR_CORRELATIONS[sectorA]?.[sectorB] ?? 0.3;
      // Weight by exposure
      const wA = ctx.concentrationBySymbol.get(symbols[i]) || 0;
      const wB = ctx.concentrationBySymbol.get(symbols[j]) || 0;
      totalCorrelation += corr * (wA + wB) / 100;
      pairs++;
    }
  }

  if (pairs === 0) return 0;
  return Math.min(100, (totalCorrelation / pairs) * 100);
}

/**
 * Format portfolio context as a summary string for the API.
 */
export function formatPortfolioSummary(ctx: PortfolioContext): string {
  const lines: string[] = [];
  lines.push(`Portfolio Delta: ${ctx.totalDelta.toFixed(1)} (β-weighted: ${ctx.betaWeightedDelta.toFixed(1)})`);
  lines.push(`Theta: $${ctx.totalTheta.toFixed(2)}/day | Vega: ${ctx.totalVega.toFixed(2)}`);
  lines.push(`Unique Underlyings: ${ctx.uniqueUnderlyings}`);

  if (ctx.coveredCallCandidates.length > 0) {
    lines.push(`Covered Call Candidates: ${ctx.coveredCallCandidates.join(", ")}`);
  }

  const topExposures = Array.from(ctx.concentrationBySymbol.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);
  if (topExposures.length > 0) {
    lines.push("Top Exposures:");
    for (const [sym, pct] of topExposures) {
      const delta = ctx.deltaBySymbol.get(sym) || 0;
      lines.push(`  ${sym}: ${pct.toFixed(1)}% (delta: ${delta.toFixed(1)})`);
    }
  }

  return lines.join("\n");
}
