/**
 * Additional Strategy Builders
 *
 * Extends the base strategy builders with:
 *   - Put Credit Spread (bullish credit strategy)
 *   - Call Credit Spread (bearish credit strategy)
 *   - Iron Butterfly (neutral, max premium collection)
 *   - Long Straddle (volatility play)
 *   - Long Strangle (cheaper volatility play)
 *   - Covered Call (income on existing shares)
 *   - Calendar Spread (time decay play)
 *   - Diagonal Spread (directional + time decay)
 */

import type { OptionChainEntry, OptionsStrategy, StrategyType } from "../types/options.js";
import { roundToTickSize } from "../utils/tick-size.js";

/**
 * Find the option closest to a target delta (absolute value).
 * Returns null if no option has delta close enough (within tolerance).
 *
 * For puts, delta is negative — we compare absolute values.
 * Target delta should be given as positive (e.g., 0.30 for a 30-delta option).
 *
 * @param options - Sorted array of option chain entries
 * @param targetDelta - Target absolute delta (0.01 – 0.99)
 * @param tolerance - Max allowed deviation from target (default: 0.15)
 * @returns Closest matching option or null
 */
export function findByDelta(
  options: OptionChainEntry[],
  targetDelta: number,
  tolerance: number = 0.15
): OptionChainEntry | null {
  if (options.length === 0) return null;

  let best: OptionChainEntry | null = null;
  let bestDiff = Infinity;

  for (const opt of options) {
    const absDelta = Math.abs(opt.greeks?.delta ?? 0);
    const diff = Math.abs(absDelta - targetDelta);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = opt;
    }
  }

  // Reject if too far from target
  if (bestDiff > tolerance) return null;
  return best;
}

/**
 * Build a Put Credit Spread (bullish credit strategy).
 *
 * Sell higher-strike put + Buy lower-strike put (same expiration).
 * Credit received on the spread. Max profit = credit. Max loss = (width - credit) × 100.
 * Breakeven = short strike - credit.
 *
 * @param underlying - Ticker symbol
 * @param underlyingPrice - Current price of the underlying
 * @param chain - Option chain entries
 * @param expiration - Target expiration date
 * @param targetWidth - Desired spread width in strike points (default: 5)
 * @returns OptionsStrategy or null if not enough contracts available
 */
export function buildPutCreditSpread(
  underlying: string,
  underlyingPrice: number,
  chain: OptionChainEntry[],
  expiration: Date,
  targetWidth: number = 5,
  targetDelta: number = 0.30 // Sell the ~30-delta OTM put for better POP
): OptionsStrategy | null {
  const expirationTime = expiration.getTime();
  const puts = chain
    .filter(
      (e) =>
        e.contract.type === "put" &&
        e.contract.expiration.getTime() === expirationTime &&
        e.mid > 0
    )
    .sort((a, b) => a.contract.strike - b.contract.strike);

  if (puts.length < 2) return null;

  // Delta-based strike selection: target ~30-delta OTM put for the short leg.
  // This gives ~70% POP (probability of profit) vs ~50% for ATM.
  // Falls back to ATM if delta data is unavailable.
  const otmPuts = puts.filter((p) => p.contract.strike < underlyingPrice);
  let shortPut = findByDelta(otmPuts, targetDelta);

  // Fallback: if no delta data, use ATM
  if (!shortPut) {
    shortPut = puts.reduce((prev, curr) =>
      Math.abs(curr.contract.strike - underlyingPrice) <
      Math.abs(prev.contract.strike - underlyingPrice)
        ? curr
        : prev
    );
  }

  // Find lower strike put (long leg) — roughly targetWidth below short strike
  const longPut = puts
    .filter((p) => p.contract.strike <= shortPut.contract.strike - targetWidth)
    .pop();

  if (!longPut) return null;

  // Use bid for selling (receiving credit), ask for buying (paying for protection)
  const shortPrice = roundToTickSize(shortPut.bid > 0 ? shortPut.bid : shortPut.mid, underlying);
  const longPrice = roundToTickSize(longPut.ask > 0 ? longPut.ask : longPut.mid, underlying);
  const netCredit = shortPrice - longPrice;
  const width = shortPut.contract.strike - longPut.contract.strike;

  return {
    name: `Put Credit Spread ${underlying} ${longPut.contract.strike}/${shortPut.contract.strike}`,
    type: "bear_put_spread", // Note: put credit spread is the credit version of bear put
    legs: [
      { contract: shortPut.contract, side: "sell", quantity: 1, price: shortPrice },
      { contract: longPut.contract, side: "buy", quantity: 1, price: longPrice },
    ],
    maxProfit: netCredit * 100,
    maxLoss: (width - netCredit) * 100,
    breakeven: [shortPut.contract.strike - netCredit],
    netDebit: -netCredit * 100, // negative = credit
    requiredCapital: (width - netCredit) * 100,
  };
}

/**
 * Build a Call Credit Spread (bearish credit strategy).
 *
 * Sell lower-strike call + Buy higher-strike call (same expiration).
 * Credit received on the spread. Max profit = credit. Max loss = (width - credit) × 100.
 * Breakeven = short strike + credit.
 *
 * @param underlying - Ticker symbol
 * @param underlyingPrice - Current price of the underlying
 * @param chain - Option chain entries
 * @param expiration - Target expiration date
 * @param targetWidth - Desired spread width in strike points (default: 5)
 * @returns OptionsStrategy or null if not enough contracts available
 */
export function buildCallCreditSpread(
  underlying: string,
  underlyingPrice: number,
  chain: OptionChainEntry[],
  expiration: Date,
  targetWidth: number = 5,
  targetDelta: number = 0.30 // Sell the ~30-delta OTM call for better POP
): OptionsStrategy | null {
  const expirationTime = expiration.getTime();
  const calls = chain
    .filter(
      (e) =>
        e.contract.type === "call" &&
        e.contract.expiration.getTime() === expirationTime &&
        e.mid > 0
    )
    .sort((a, b) => a.contract.strike - b.contract.strike);

  if (calls.length < 2) return null;

  // Delta-based strike selection: target ~30-delta OTM call for the short leg.
  // This gives ~70% POP (probability of profit) vs ~50% for ATM.
  // Falls back to ATM if delta data is unavailable.
  const otmCalls = calls.filter((c) => c.contract.strike > underlyingPrice);
  let shortCall = findByDelta(otmCalls, targetDelta);

  // Fallback: if no delta data, use ATM
  if (!shortCall) {
    shortCall = calls.reduce((prev, curr) =>
      Math.abs(curr.contract.strike - underlyingPrice) <
      Math.abs(prev.contract.strike - underlyingPrice)
        ? curr
        : prev
    );
  }

  // Find higher strike call (long leg) — roughly targetWidth above short strike
  const longCall = calls.find(
    (c) => c.contract.strike >= shortCall.contract.strike + targetWidth
  );

  if (!longCall) return null;

  // Use bid for selling (receiving credit), ask for buying (paying for protection)
  const shortPrice = roundToTickSize(shortCall.bid > 0 ? shortCall.bid : shortCall.mid, underlying);
  const longPrice = roundToTickSize(longCall.ask > 0 ? longCall.ask : longCall.mid, underlying);
  const netCredit = shortPrice - longPrice;
  const width = longCall.contract.strike - shortCall.contract.strike;

  return {
    name: `Call Credit Spread ${underlying} ${shortCall.contract.strike}/${longCall.contract.strike}`,
    type: "bull_call_spread", // Note: call credit spread is the credit version of bull call
    legs: [
      { contract: shortCall.contract, side: "sell", quantity: 1, price: shortPrice },
      { contract: longCall.contract, side: "buy", quantity: 1, price: longPrice },
    ],
    maxProfit: netCredit * 100,
    maxLoss: (width - netCredit) * 100,
    breakeven: [shortCall.contract.strike + netCredit],
    netDebit: -netCredit * 100, // negative = credit
    requiredCapital: (width - netCredit) * 100,
  };
}

/**
 * Build an Iron Butterfly (neutral, high premium collection).
 *
 * Sell ATM call + Sell ATM put + Buy OTM call + Buy OTM put (wings).
 * Like an iron condor but with short strikes at ATM for maximum premium.
 * Max profit = total credit received. Max loss = (wing width - credit) × 100.
 *
 * @param underlying - Ticker symbol
 * @param underlyingPrice - Current price of the underlying
 * @param chain - Option chain entries
 * @param expiration - Target expiration date
 * @param wingWidth - Width of the protective wings in strike points (default: 5)
 * @returns OptionsStrategy or null if not enough contracts available
 */
export function buildIronButterfly(
  underlying: string,
  underlyingPrice: number,
  chain: OptionChainEntry[],
  expiration: Date,
  wingWidth: number = 5
): OptionsStrategy | null {
  const expirationTime = expiration.getTime();
  const calls = chain
    .filter((e) => e.contract.type === "call" && e.contract.expiration.getTime() === expirationTime && e.mid > 0)
    .sort((a, b) => a.contract.strike - b.contract.strike);
  const puts = chain
    .filter((e) => e.contract.type === "put" && e.contract.expiration.getTime() === expirationTime && e.mid > 0)
    .sort((a, b) => a.contract.strike - b.contract.strike);

  if (calls.length < 2 || puts.length < 2) return null;

  // Short call at ATM
  const shortCall = calls.reduce((prev, curr) =>
    Math.abs(curr.contract.strike - underlyingPrice) <
    Math.abs(prev.contract.strike - underlyingPrice)
      ? curr
      : prev
  );

  // Long call (OTM wing)
  const longCall = calls.find(
    (c) => c.contract.strike >= shortCall.contract.strike + wingWidth
  );

  // Short put at ATM
  const shortPut = [...puts].reverse().reduce((prev, curr) =>
    Math.abs(curr.contract.strike - underlyingPrice) <
    Math.abs(prev.contract.strike - underlyingPrice)
      ? curr
      : prev
  );

  // Long put (OTM wing)
  const longPut = puts
    .filter((p) => p.contract.strike <= shortPut.contract.strike - wingWidth)
    .pop();

  if (!longCall || !longPut) return null;

  // Use bid for selling, ask for buying
  const scPrice = roundToTickSize(shortCall.bid > 0 ? shortCall.bid : shortCall.mid, underlying);
  const lcPrice = roundToTickSize(longCall.ask > 0 ? longCall.ask : longCall.mid, underlying);
  const spPrice = roundToTickSize(shortPut.bid > 0 ? shortPut.bid : shortPut.mid, underlying);
  const lpPrice = roundToTickSize(longPut.ask > 0 ? longPut.ask : longPut.mid, underlying);
  const netCredit = (scPrice - lcPrice) + (spPrice - lpPrice);

  const callWidth = longCall.contract.strike - shortCall.contract.strike;
  const putWidth = shortPut.contract.strike - longPut.contract.strike;
  const maxWidth = Math.max(callWidth, putWidth);

  return {
    name: `Iron Butterfly ${underlying} ${longPut.contract.strike}/${shortPut.contract.strike}/${shortCall.contract.strike}/${longCall.contract.strike}`,
    type: "iron_butterfly",
    legs: [
      { contract: longPut.contract, side: "buy", quantity: 1, price: lpPrice },
      { contract: shortPut.contract, side: "sell", quantity: 1, price: spPrice },
      { contract: shortCall.contract, side: "sell", quantity: 1, price: scPrice },
      { contract: longCall.contract, side: "buy", quantity: 1, price: lcPrice },
    ],
    maxProfit: netCredit * 100,
    maxLoss: (maxWidth - netCredit) * 100,
    breakeven: [
      shortPut.contract.strike - netCredit,
      shortCall.contract.strike + netCredit,
    ],
    netDebit: -netCredit * 100, // negative = credit
    requiredCapital: (maxWidth - netCredit) * 100,
  };
}

/**
 * Build a Long Straddle (long volatility play).
 *
 * Buy ATM call + Buy ATM put (same strike, same expiration).
 * Max profit = unlimited. Max loss = total debit paid.
 * Breakeven = strike ± total debit.
 *
 * @param underlying - Ticker symbol
 * @param underlyingPrice - Current price of the underlying
 * @param chain - Option chain entries
 * @param expiration - Target expiration date
 * @returns OptionsStrategy or null if not enough contracts available
 */
export function buildLongStraddle(
  underlying: string,
  underlyingPrice: number,
  chain: OptionChainEntry[],
  expiration: Date
): OptionsStrategy | null {
  const expirationTime = expiration.getTime();
  const calls = chain
    .filter((e) => e.contract.type === "call" && e.contract.expiration.getTime() === expirationTime && e.mid > 0)
    .sort((a, b) => a.contract.strike - b.contract.strike);
  const puts = chain
    .filter((e) => e.contract.type === "put" && e.contract.expiration.getTime() === expirationTime && e.mid > 0)
    .sort((a, b) => a.contract.strike - b.contract.strike);

  if (calls.length === 0 || puts.length === 0) return null;

  // Find ATM call
  const atmCall = calls.reduce((prev, curr) =>
    Math.abs(curr.contract.strike - underlyingPrice) <
    Math.abs(prev.contract.strike - underlyingPrice)
      ? curr
      : prev
  );

  // Find put with same strike if available, otherwise closest ATM put
  let atmPut = puts.find((p) => p.contract.strike === atmCall.contract.strike);
  if (!atmPut) {
    atmPut = puts.reduce((prev, curr) =>
      Math.abs(curr.contract.strike - underlyingPrice) <
      Math.abs(prev.contract.strike - underlyingPrice)
        ? curr
        : prev
    );
  }

  // Use ask for buying
  const callPrice = roundToTickSize(atmCall.ask > 0 ? atmCall.ask : atmCall.mid, underlying);
  const putPrice = roundToTickSize(atmPut.ask > 0 ? atmPut.ask : atmPut.mid, underlying);
  const totalDebit = callPrice + putPrice;

  return {
    name: `Long Straddle ${underlying} ${atmCall.contract.strike}`,
    type: "straddle",
    legs: [
      { contract: atmCall.contract, side: "buy", quantity: 1, price: callPrice },
      { contract: atmPut.contract, side: "buy", quantity: 1, price: putPrice },
    ],
    maxProfit: "unlimited",
    maxLoss: totalDebit * 100,
    breakeven: [
      atmCall.contract.strike - totalDebit,
      atmCall.contract.strike + totalDebit,
    ],
    netDebit: totalDebit * 100,
    requiredCapital: totalDebit * 100,
  };
}

/**
 * Build a Long Strangle (cheaper long volatility play).
 *
 * Buy OTM call + Buy OTM put (different strikes, same expiration).
 * Lower cost than straddle, wider breakevens.
 * Max profit = unlimited. Max loss = total debit paid.
 * Breakeven = call strike + debit / put strike - debit.
 *
 * @param underlying - Ticker symbol
 * @param underlyingPrice - Current price of the underlying
 * @param chain - Option chain entries
 * @param expiration - Target expiration date
 * @param distanceFromATM - How far OTM to buy (default: 5 strike points)
 * @returns OptionsStrategy or null if not enough contracts available
 */
export function buildLongStrangle(
  underlying: string,
  underlyingPrice: number,
  chain: OptionChainEntry[],
  expiration: Date,
  distanceFromATM: number = 5
): OptionsStrategy | null {
  const expirationTime = expiration.getTime();
  const calls = chain
    .filter((e) => e.contract.type === "call" && e.contract.expiration.getTime() === expirationTime && e.mid > 0)
    .sort((a, b) => a.contract.strike - b.contract.strike);
  const puts = chain
    .filter((e) => e.contract.type === "put" && e.contract.expiration.getTime() === expirationTime && e.mid > 0)
    .sort((a, b) => a.contract.strike - b.contract.strike);

  if (calls.length === 0 || puts.length === 0) return null;

  // Buy OTM call (at or above current price + distance)
  const callLeg = calls.find((c) => c.contract.strike >= underlyingPrice + distanceFromATM);
  if (!callLeg) return null;

  // Buy OTM put (at or below current price - distance)
  const putLeg = [...puts].reverse().find((p) => p.contract.strike <= underlyingPrice - distanceFromATM);
  if (!putLeg) return null;

  // Use ask for buying
  const callPrice = roundToTickSize(callLeg.ask > 0 ? callLeg.ask : callLeg.mid, underlying);
  const putPrice = roundToTickSize(putLeg.ask > 0 ? putLeg.ask : putLeg.mid, underlying);
  const totalDebit = callPrice + putPrice;

  return {
    name: `Long Strangle ${underlying} ${putLeg.contract.strike}/${callLeg.contract.strike}`,
    type: "strangle",
    legs: [
      { contract: callLeg.contract, side: "buy", quantity: 1, price: callPrice },
      { contract: putLeg.contract, side: "buy", quantity: 1, price: putPrice },
    ],
    maxProfit: "unlimited",
    maxLoss: totalDebit * 100,
    breakeven: [
      putLeg.contract.strike - totalDebit,
      callLeg.contract.strike + totalDebit,
    ],
    netDebit: totalDebit * 100,
    requiredCapital: totalDebit * 100,
  };
}

/**
 * Build a Covered Call (sell OTM call against existing shares).
 *
 * Requires ownership of 100 shares (or params to indicate this).
 * Sell OTM call. Stock acts as long call hedge.
 * Max profit = (strike - currentPrice + premium) × 100.
 * Max loss = (currentPrice - premium) × 100 (shares going to zero).
 * Required capital = currentPrice × 100 (or 0 if shares already owned).
 *
 * @param underlying - Ticker symbol
 * @param underlyingPrice - Current price of the underlying
 * @param chain - Option chain entries
 * @param expiration - Target expiration date
 * @param hasShares - Whether the position already owns shares (default: false)
 * @param strikeSelector - Function to select which call to use (default: first OTM call)
 * @returns OptionsStrategy or null if not enough contracts available
 */
export function buildCoveredCall(
  underlying: string,
  underlyingPrice: number,
  chain: OptionChainEntry[],
  expiration: Date,
  hasShares: boolean = false,
  strikeSelector?: (calls: OptionChainEntry[]) => OptionChainEntry | undefined
): OptionsStrategy | null {
  const expirationTime = expiration.getTime();
  const calls = chain
    .filter((e) => e.contract.type === "call" && e.contract.expiration.getTime() === expirationTime && e.mid > 0)
    .sort((a, b) => a.contract.strike - b.contract.strike);

  if (calls.length === 0) return null;

  // Default: select first OTM call (above current price)
  let shortCall: OptionChainEntry | undefined;
  if (strikeSelector) {
    shortCall = strikeSelector(calls);
  } else {
    shortCall = calls.find((c) => c.contract.strike >= underlyingPrice);
  }

  if (!shortCall) {
    // If no OTM calls, use the closest ATM call
    shortCall = calls.reduce((prev, curr) =>
      Math.abs(curr.contract.strike - underlyingPrice) <
      Math.abs(prev.contract.strike - underlyingPrice)
        ? curr
        : prev
    );
  }

  // Use bid for selling
  const premium = roundToTickSize(shortCall.bid > 0 ? shortCall.bid : shortCall.mid, underlying);
  const strikeDifference = shortCall.contract.strike - underlyingPrice;
  const maxProfit = (strikeDifference + premium) * 100;
  const maxLoss = (underlyingPrice - premium) * 100;

  return {
    name: `Covered Call ${underlying} ${shortCall.contract.strike}`,
    type: "covered_call",
    legs: [
      { contract: shortCall.contract, side: "sell", quantity: 1, price: premium },
    ],
    maxProfit,
    maxLoss,
    breakeven: [underlyingPrice - premium],
    netDebit: -premium * 100, // negative = credit
    // If shares are already owned, no additional capital needed. Otherwise, need to buy the stock.
    requiredCapital: hasShares ? 0 : underlyingPrice * 100,
  };
}

/**
 * Build a Calendar Spread (time decay play).
 *
 * Buy longer-dated call + Sell shorter-dated call (same strike).
 * Benefits from time decay of the front month while holding time value in back month.
 * Max profit ≈ premium difference at front month expiry. Max loss = net debit.
 *
 * @param underlying - Ticker symbol
 * @param underlyingPrice - Current price of the underlying
 * @param chain - Option chain entries (should contain multiple expirations)
 * @param nearExpiration - Front month expiration (short leg)
 * @param farExpiration - Back month expiration (long leg)
 * @param strike - Strike price (default: ATM)
 * @returns OptionsStrategy or null if not enough contracts available
 */
export function buildCalendarSpread(
  underlying: string,
  underlyingPrice: number,
  chain: OptionChainEntry[],
  nearExpiration: Date,
  farExpiration: Date,
  strike?: number
): OptionsStrategy | null {
  const nearTime = nearExpiration.getTime();
  const farTime = farExpiration.getTime();

  if (nearTime >= farTime) return null; // Near must be before far

  const nearCalls = chain
    .filter((e) => e.contract.type === "call" && e.contract.expiration.getTime() === nearTime && e.mid > 0)
    .sort((a, b) => a.contract.strike - b.contract.strike);

  const farCalls = chain
    .filter((e) => e.contract.type === "call" && e.contract.expiration.getTime() === farTime && e.mid > 0)
    .sort((a, b) => a.contract.strike - b.contract.strike);

  if (nearCalls.length === 0 || farCalls.length === 0) return null;

  // Select strike
  let selectedStrike = strike;
  if (!selectedStrike) {
    // Use ATM
    const atmNear = nearCalls.reduce((prev, curr) =>
      Math.abs(curr.contract.strike - underlyingPrice) <
      Math.abs(prev.contract.strike - underlyingPrice)
        ? curr
        : prev
    );
    selectedStrike = atmNear.contract.strike;
  }

  // Find matching strikes in both expirations
  const shortCall = nearCalls.find((c) => c.contract.strike === selectedStrike);
  const longCall = farCalls.find((c) => c.contract.strike === selectedStrike);

  if (!shortCall || !longCall) return null;

  // Use ask for buying (long), bid for selling (short)
  const longPrice = roundToTickSize(longCall.ask > 0 ? longCall.ask : longCall.mid, underlying);
  const shortPrice = roundToTickSize(shortCall.bid > 0 ? shortCall.bid : shortCall.mid, underlying);
  const netDebit = longPrice - shortPrice;

  return {
    name: `Calendar Spread ${underlying} ${selectedStrike}`,
    type: "calendar_spread",
    legs: [
      { contract: longCall.contract, side: "buy", quantity: 1, price: longPrice },
      { contract: shortCall.contract, side: "sell", quantity: 1, price: shortPrice },
    ],
    maxProfit: shortPrice * 100, // Approx: profit if front expires worthless
    maxLoss: netDebit * 100,
    breakeven: [selectedStrike - netDebit, selectedStrike + netDebit],
    netDebit: netDebit * 100,
    requiredCapital: netDebit * 100,
  };
}

/**
 * Build a Diagonal Spread (directional + time decay play).
 *
 * Buy longer-dated call at lower strike + Sell shorter-dated call at higher strike.
 * Like calendar spread but different strikes: benefits from time decay + directional bullishness.
 * Max profit ≈ short strike - long strike + credit received.
 * Max loss = net debit.
 *
 * @param underlying - Ticker symbol
 * @param underlyingPrice - Current price of the underlying
 * @param chain - Option chain entries (should contain multiple expirations)
 * @param nearExpiration - Front month expiration (short leg)
 * @param farExpiration - Back month expiration (long leg)
 * @param strikeWidth - Desired gap between long and short strikes (default: 5)
 * @returns OptionsStrategy or null if not enough contracts available
 */
export function buildDiagonalSpread(
  underlying: string,
  underlyingPrice: number,
  chain: OptionChainEntry[],
  nearExpiration: Date,
  farExpiration: Date,
  strikeWidth: number = 5
): OptionsStrategy | null {
  const nearTime = nearExpiration.getTime();
  const farTime = farExpiration.getTime();

  if (nearTime >= farTime) return null; // Near must be before far

  const nearCalls = chain
    .filter((e) => e.contract.type === "call" && e.contract.expiration.getTime() === nearTime && e.mid > 0)
    .sort((a, b) => a.contract.strike - b.contract.strike);

  const farCalls = chain
    .filter((e) => e.contract.type === "call" && e.contract.expiration.getTime() === farTime && e.mid > 0)
    .sort((a, b) => a.contract.strike - b.contract.strike);

  if (nearCalls.length < 2 || farCalls.length < 2) return null;

  // Find ATM or slightly OTM call to sell in near term
  const shortCall = nearCalls.find((c) => c.contract.strike >= underlyingPrice) ||
    nearCalls.reduce((prev, curr) =>
      Math.abs(curr.contract.strike - underlyingPrice) <
      Math.abs(prev.contract.strike - underlyingPrice)
        ? curr
        : prev
    );

  // Find call to buy in far term at lower strike
  const longCall = farCalls.find(
    (c) => c.contract.strike <= shortCall.contract.strike - strikeWidth
  );

  if (!longCall) return null;

  // Use ask for buying (long), bid for selling (short)
  const longPrice = roundToTickSize(longCall.ask > 0 ? longCall.ask : longCall.mid, underlying);
  const shortPrice = roundToTickSize(shortCall.bid > 0 ? shortCall.bid : shortCall.mid, underlying);
  const netDebit = longPrice - shortPrice;
  const width = shortCall.contract.strike - longCall.contract.strike;

  return {
    name: `Diagonal Spread ${underlying} ${longCall.contract.strike}/${shortCall.contract.strike}`,
    type: "diagonal_spread",
    legs: [
      { contract: longCall.contract, side: "buy", quantity: 1, price: longPrice },
      { contract: shortCall.contract, side: "sell", quantity: 1, price: shortPrice },
    ],
    maxProfit: (width + shortPrice) * 100, // Approx: strike width + credit received
    maxLoss: netDebit * 100,
    breakeven: [longCall.contract.strike + netDebit],
    netDebit: netDebit * 100,
    requiredCapital: netDebit * 100,
  };
}
