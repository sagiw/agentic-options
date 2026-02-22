/**
 * IBKR Margin Estimation
 *
 * Estimates the Initial Margin requirement for option strategies.
 * IBKR uses complex margin calculations — this provides conservative estimates
 * to prevent submitting orders that exceed available funds.
 *
 * Reg-T Margin Rules (simplified):
 *   - Vertical Spreads (debit): max(spread width × 100, net debit × 100)
 *   - Vertical Spreads (credit): spread width × 100
 *   - Iron Condor: max(call spread margin, put spread margin) — only one side at risk
 *   - Cash-Secured Put: strike × 100
 *   - Naked Options: 20% of underlying + premium - OTM amount (min 10% of underlying)
 *   - Long Options: premium paid (no additional margin)
 *
 * IMPORTANT: These are estimates. Actual IBKR margin may differ based on:
 *   - Portfolio margin vs Reg-T
 *   - Concentration risk adjustments
 *   - Special margin requirements for certain underlyings
 *
 * We add a 15% safety buffer to all estimates.
 */

import type { OptionsStrategy, StrategyType } from "../types/options.js";

const SAFETY_BUFFER = 1.25; // 25% safety margin above estimated requirement
// Bumped from 15% → 25% because IBKR adds surcharges for concentration risk,
// special margin requirements on certain underlyings, and rounding differences
// between Reg-T and their actual risk engine.

/**
 * Estimate the IBKR Initial Margin requirement for a strategy.
 * Returns a conservative estimate with safety buffer.
 */
export function estimateMargin(
  strategy: OptionsStrategy,
  underlyingPrice: number = 0
): number {
  const type = strategy.type;

  switch (type) {
    case "bull_call_spread":
    case "bear_put_spread":
      return estimateDebitSpreadMargin(strategy);

    case "iron_condor":
    case "iron_butterfly":
      return estimateIronCondorMargin(strategy);

    case "cash_secured_put":
      return estimateCashSecuredPutMargin(strategy);

    case "covered_call":
      return estimateCoveredCallMargin(strategy, underlyingPrice);

    case "long_call":
    case "long_put":
      return estimateLongOptionMargin(strategy);

    case "straddle":
    case "strangle":
      return estimateStraddleMargin(strategy, underlyingPrice);

    default:
      // Conservative fallback: use requiredCapital × safety buffer
      return strategy.requiredCapital * SAFETY_BUFFER;
  }
}

/**
 * Debit spread: margin = net debit paid (cost of the spread).
 * But IBKR sometimes requires the spread width as margin for credit spreads
 * that got assigned. Use max of both to be safe.
 */
function estimateDebitSpreadMargin(strategy: OptionsStrategy): number {
  const strikes = strategy.legs
    .filter(l => l.contract.type === "call" || l.contract.type === "put")
    .map(l => l.contract.strike);

  if (strikes.length < 2) return strategy.requiredCapital * SAFETY_BUFFER;

  const width = Math.abs(Math.max(...strikes) - Math.min(...strikes));
  const spreadMargin = width * 100; // per contract
  const netDebit = Math.abs(strategy.netDebit);

  // Max of spread width and net debit, with safety buffer
  return Math.max(spreadMargin, netDebit) * SAFETY_BUFFER;
}

/**
 * Iron Condor: margin = max of call spread margin or put spread margin.
 * Only one side can be at risk at expiration.
 */
function estimateIronCondorMargin(strategy: OptionsStrategy): number {
  const calls = strategy.legs.filter(l => l.contract.type === "call");
  const puts = strategy.legs.filter(l => l.contract.type === "put");

  const callStrikes = calls.map(l => l.contract.strike);
  const putStrikes = puts.map(l => l.contract.strike);

  const callWidth = callStrikes.length >= 2
    ? Math.abs(Math.max(...callStrikes) - Math.min(...callStrikes))
    : 0;
  const putWidth = putStrikes.length >= 2
    ? Math.abs(Math.max(...putStrikes) - Math.min(...putStrikes))
    : 0;

  // IBKR margin = wider side × 100, but apply safety buffer
  const maxWidth = Math.max(callWidth, putWidth);
  return maxWidth * 100 * SAFETY_BUFFER;
}

/**
 * Cash-Secured Put: margin = strike price × 100 (full assignment value).
 */
function estimateCashSecuredPutMargin(strategy: OptionsStrategy): number {
  const putLeg = strategy.legs.find(l => l.contract.type === "put" && l.side === "sell");
  if (!putLeg) return strategy.requiredCapital * SAFETY_BUFFER;

  return putLeg.contract.strike * 100 * SAFETY_BUFFER;
}

/**
 * Covered Call: margin = stock purchase price (already holds shares).
 */
function estimateCoveredCallMargin(
  strategy: OptionsStrategy,
  underlyingPrice: number
): number {
  // If already holding stock, margin for covered call is minimal
  // But if buying stock + selling call, need full stock purchase value
  return underlyingPrice * 100 * SAFETY_BUFFER;
}

/**
 * Long option: margin = premium paid (no additional margin requirement).
 */
function estimateLongOptionMargin(strategy: OptionsStrategy): number {
  return Math.abs(strategy.netDebit) * SAFETY_BUFFER;
}

/**
 * Straddle/Strangle: naked margin on the non-covered side.
 * Conservative: assume naked margin on the larger side.
 */
function estimateStraddleMargin(
  strategy: OptionsStrategy,
  underlyingPrice: number
): number {
  const isShort = strategy.legs.some(l => l.side === "sell");

  if (!isShort) {
    // Long straddle: just the premium
    return Math.abs(strategy.netDebit) * SAFETY_BUFFER;
  }

  // Short straddle: naked margin
  // IBKR naked margin ≈ 20% of underlying + premium received
  const premium = Math.abs(strategy.netDebit) / 100; // per share
  const nakedMargin = (underlyingPrice * 0.20 + premium) * 100;
  return nakedMargin * SAFETY_BUFFER;
}

/**
 * Check if a strategy can be executed with the given available funds.
 *
 * Returns { canExecute, estimatedMargin, availableFunds, shortfall, message }
 */
export function checkMarginAvailability(
  strategy: OptionsStrategy,
  availableFunds: number,
  underlyingPrice: number = 0
): {
  canExecute: boolean;
  estimatedMargin: number;
  availableFunds: number;
  shortfall: number;
  message: string;
} {
  const estimatedMargin = estimateMargin(strategy, underlyingPrice);
  const canExecute = estimatedMargin <= availableFunds;
  const shortfall = canExecute ? 0 : estimatedMargin - availableFunds;

  return {
    canExecute,
    estimatedMargin,
    availableFunds,
    shortfall,
    message: canExecute
      ? `Margin OK: $${estimatedMargin.toFixed(0)} required, $${availableFunds.toFixed(0)} available`
      : `INSUFFICIENT MARGIN: Need $${estimatedMargin.toFixed(0)} but only $${availableFunds.toFixed(0)} available (short $${shortfall.toFixed(0)})`,
  };
}
