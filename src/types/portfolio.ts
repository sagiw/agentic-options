/**
 * Portfolio and account type definitions.
 * Covers positions, account balances, and risk metrics.
 */

import type { OptionContract, Greeks, OptionsStrategy } from "./options.js";

/** Account size tier for strategy selection */
export type AccountTier = "small" | "medium" | "large";

/** Margin type */
export type MarginType = "reg_t" | "portfolio_margin";

/** Brokerage account summary */
export interface AccountSummary {
  accountId: string;
  currency: string;
  netLiquidation: number;
  totalCash: number;
  buyingPower: number;
  availableFunds: number;
  marginUsed: number;
  marginType: MarginType;
  unrealizedPnL: number;
  realizedPnL: number;
  tier: AccountTier;
}

/** Single position in portfolio */
export interface Position {
  contract: OptionContract | StockPosition;
  quantity: number;
  averageCost: number;
  marketValue: number;
  unrealizedPnL: number;
  realizedPnL: number;
  greeks?: Greeks;
}

/** Stock/equity position */
export interface StockPosition {
  symbol: string;
  exchange: string;
  type: "stock";
}

/** Aggregate portfolio Greeks */
export interface PortfolioGreeks {
  totalDelta: number;
  totalGamma: number;
  totalTheta: number;
  totalVega: number;
  betaWeightedDelta: number; // delta relative to SPY
}

/** Value at Risk result */
export interface VaRResult {
  /** VaR amount at the given confidence level */
  var: number;
  /** Confidence level (e.g. 0.95 or 0.99) */
  confidenceLevel: number;
  /** Time horizon in days */
  horizon: number;
  /** Conditional VaR (Expected Shortfall) */
  cvar: number;
  /** Method used */
  method: "historical" | "parametric" | "monte_carlo";
  /** Stress test results */
  stressTests: StressTestResult[];
}

/** Stress test scenario */
export interface StressTestResult {
  scenario: string;
  underlyingMove: number; // percentage
  portfolioPnL: number;
  worstCaseLoss: number;
}

/** Full portfolio snapshot */
export interface Portfolio {
  account: AccountSummary;
  positions: Position[];
  greeks: PortfolioGreeks;
  var: VaRResult;
  lastUpdated: Date;
}

/** Risk limits enforced by the Risk Sentinel */
export interface RiskLimits {
  maxRiskPerTradePct: number;     // 1-2% of portfolio
  maxPortfolioRiskPct: number;    // total portfolio risk cap
  maxPositionSizePct: number;     // single position size cap
  maxCorrelatedExposure: number;  // limit correlated risk
  varLimit: number;               // max VaR as % of portfolio
}

/** Bank account data (from Open Banking scraping) */
export interface BankAccount {
  bankName: string;
  accountNumber: string; // masked: ****1234
  balance: number;
  currency: string;
  lastUpdated: Date;
  source: "api" | "browser_scrape";
}

/** Aggregated net worth view */
export interface NetWorthSnapshot {
  brokerageAccounts: AccountSummary[];
  bankAccounts: BankAccount[];
  totalNetWorth: number;
  availableForTrading: number;
  timestamp: Date;
}
