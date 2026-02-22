/**
 * IBKR Tick Size Utilities
 *
 * Option prices must conform to IBKR's minimum price variation (tick size):
 *
 *   - Options priced under $3.00  → $0.05 increments (penny-pilot: $0.01)
 *   - Options priced $3.00+       → $0.10 increments
 *   - Stocks                      → $0.01 increments
 *
 * Sending a limit price that doesn't conform results in:
 *   "The price does not conform to the minimum price variation for this contract."
 *
 * This module provides helpers to round prices correctly and validate them.
 */

/** Penny pilot symbols that allow $0.01 tick for options under $3.00 */
const PENNY_PILOT_SYMBOLS = new Set([
  "AAPL", "AMD", "AMZN", "BAC", "C", "CSCO", "DIS", "EEM", "EWZ",
  "F", "GE", "GILD", "GLD", "GM", "GOOGL", "GOOG", "IWM", "JPM",
  "META", "MSFT", "MU", "NFLX", "NVDA", "PFE", "QQQ", "SNAP",
  "SPY", "SQ", "T", "TGT", "TSLA", "UBER", "VXX", "WFC", "XLF",
]);

/**
 * Get the tick size for an option on a given underlying at a given price.
 *
 * @param price     - The option price (per share, not per contract)
 * @param underlying - The underlying symbol (for penny pilot check)
 * @param isStock   - If true, always use $0.01 (stock tick size)
 * @returns The minimum tick size increment
 */
export function getTickSize(
  price: number,
  underlying?: string,
  isStock: boolean = false
): number {
  // Stocks always trade in $0.01 increments
  if (isStock) return 0.01;

  // Options priced $3.00+ → $0.10 tick
  if (price >= 3.0) return 0.10;

  // Options priced under $3.00:
  //   Penny pilot → $0.01
  //   Non-penny pilot → $0.05
  if (underlying && PENNY_PILOT_SYMBOLS.has(underlying.toUpperCase())) {
    return 0.01;
  }

  return 0.05;
}

/**
 * Round a price to the nearest valid tick size.
 * Uses Math.round to find the closest valid price.
 *
 * @param price     - The raw price to round
 * @param underlying - The underlying symbol (for penny pilot check)
 * @param isStock   - If true, use stock tick rules ($0.01)
 * @returns The price rounded to the nearest valid tick
 */
export function roundToTickSize(
  price: number,
  underlying?: string,
  isStock: boolean = false
): number {
  if (price <= 0) return 0;

  const tick = getTickSize(price, underlying, isStock);
  const rounded = Math.round(price / tick) * tick;

  // Fix floating-point: round to 2 decimal places
  return Math.round(rounded * 100) / 100;
}

/**
 * Round a price DOWN to the nearest valid tick size.
 * Use for buy orders (more conservative limit).
 */
export function floorToTickSize(
  price: number,
  underlying?: string,
  isStock: boolean = false
): number {
  if (price <= 0) return 0;

  const tick = getTickSize(price, underlying, isStock);
  const floored = Math.floor(price / tick) * tick;
  return Math.round(floored * 100) / 100;
}

/**
 * Round a price UP to the nearest valid tick size.
 * Use for sell orders (more conservative limit).
 */
export function ceilToTickSize(
  price: number,
  underlying?: string,
  isStock: boolean = false
): number {
  if (price <= 0) return 0;

  const tick = getTickSize(price, underlying, isStock);
  const ceiled = Math.ceil(price / tick) * tick;
  return Math.round(ceiled * 100) / 100;
}

/**
 * Check if a price conforms to tick size rules.
 */
export function isValidTickPrice(
  price: number,
  underlying?: string,
  isStock: boolean = false
): boolean {
  if (price <= 0) return false;

  const tick = getTickSize(price, underlying, isStock);
  const remainder = Math.round((price % tick) * 100) / 100;
  return remainder === 0 || remainder === tick;
}

/**
 * Check if a symbol is in the penny pilot program.
 */
export function isPennyPilot(symbol: string): boolean {
  return PENNY_PILOT_SYMBOLS.has(symbol.toUpperCase());
}
