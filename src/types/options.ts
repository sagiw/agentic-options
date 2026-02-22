/**
 * Core options trading type definitions.
 * Covers option contracts, Greeks, chains, and strategy structures.
 */

export type OptionType = "call" | "put";
export type OptionStyle = "american" | "european";
export type OrderSide = "buy" | "sell";
export type OrderType = "market" | "limit" | "stop" | "stop_limit";
export type TimeInForce = "DAY" | "GTC" | "IOC" | "FOK";

/** Single option contract */
export interface OptionContract {
  symbol: string;
  underlying: string;
  type: OptionType;
  style: OptionStyle;
  strike: number;
  expiration: Date;
  multiplier: number; // typically 100
  exchange: string;
  conId?: number; // IBKR Contract ID
}

/** Real-time Greeks for a single contract */
export interface Greeks {
  delta: number;   // ∂V/∂S  — price sensitivity
  gamma: number;   // ∂²V/∂S² — delta acceleration
  theta: number;   // ∂V/∂t  — time decay (per day)
  vega: number;    // ∂V/∂σ  — IV sensitivity
  rho: number;     // ∂V/∂r  — interest rate sensitivity
}

/** Lambda (leverage ratio): λ = Δ × (S / C) */
export interface LambdaMetric {
  lambda: number;
  delta: number;
  underlyingPrice: number;
  optionPrice: number;
}

/** Implied Volatility surface point */
export interface IVPoint {
  strike: number;
  expiration: Date;
  iv: number;
  ivRank: number;     // IV Rank (0-100)
  ivPercentile: number; // IV Percentile (0-100)
}

/** Single entry in an option chain */
export interface OptionChainEntry {
  contract: OptionContract;
  bid: number;
  ask: number;
  mid: number;
  last: number;
  volume: number;
  openInterest: number;
  iv: number;
  greeks: Greeks;
  lambda: LambdaMetric;
}

/** Full option chain for an underlying */
export interface OptionChain {
  underlying: string;
  underlyingPrice: number;
  timestamp: Date;
  expirations: Date[];
  calls: OptionChainEntry[];
  puts: OptionChainEntry[];
}

/** A single leg in a multi-leg strategy */
export interface StrategyLeg {
  contract: OptionContract;
  side: OrderSide;
  quantity: number;
  price?: number;
}

/** Named options strategy with all legs */
export interface OptionsStrategy {
  name: string;
  type: StrategyType;
  legs: StrategyLeg[];
  maxProfit: number | "unlimited";
  maxLoss: number;
  breakeven: number[];
  netDebit: number; // negative = net credit
  requiredCapital: number;
}

export type StrategyType =
  | "long_call"
  | "long_put"
  | "covered_call"
  | "cash_secured_put"
  | "bull_call_spread"
  | "bear_put_spread"
  | "iron_condor"
  | "iron_butterfly"
  | "straddle"
  | "strangle"
  | "calendar_spread"
  | "diagonal_spread"
  | "wheel";

/** Order to be submitted to brokerage */
export interface OptionsOrder {
  id?: string;
  strategy: OptionsStrategy;
  orderType: OrderType;
  limitPrice?: number;
  timeInForce: TimeInForce;
  status: OrderStatus;
  submittedAt?: Date;
  filledAt?: Date;
  fillPrice?: number;
}

export type OrderStatus =
  | "pending_approval"  // awaiting human-in-the-loop
  | "submitted"
  | "partial_fill"
  | "filled"
  | "cancelled"
  | "rejected"
  | "error";
