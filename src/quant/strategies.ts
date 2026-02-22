/**
 * Options Strategy Selection Engine
 *
 * Implements the Strategy Selection Matrix from the spec:
 *   - Small Accounts (<$10k): Vertical Spreads, Iron Condors
 *   - Large Accounts (>$100k): Portfolio Margin, Wheel Strategy
 *
 * Each strategy is built, priced, and scored for the ranking system.
 */

import type {
  OptionType,
  OptionContract,
  OptionsStrategy,
  StrategyType,
  StrategyLeg,
  OptionChainEntry,
} from "../types/options.js";
import type { AccountTier, AccountSummary } from "../types/portfolio.js";
import type { RankedStrategy, StrategyFactor } from "../types/agents.js";
import { blackScholesPrice, type BSParams } from "./black-scholes.js";
import { calculateGreeks } from "./greeks.js";
import { calculateLambda } from "./lambda.js";

/** Determine account tier */
export function getAccountTier(netLiquidation: number): AccountTier {
  if (netLiquidation < 10_000) return "small";
  if (netLiquidation < 100_000) return "medium";
  return "large";
}

/** Get allowed strategies for account tier */
export function allowedStrategies(tier: AccountTier): StrategyType[] {
  const base: StrategyType[] = [
    "bull_call_spread",
    "bear_put_spread",
    "iron_condor",
    "iron_butterfly",
  ];

  if (tier === "small") return base;

  const medium: StrategyType[] = [
    ...base,
    "long_call",
    "long_put",
    "straddle",
    "strangle",
    "calendar_spread",
    "diagonal_spread",
  ];

  if (tier === "medium") return medium;

  return [
    ...medium,
    "covered_call",
    "cash_secured_put",
    "wheel",
  ];
}

/**
 * Build a Bull Call Spread (vertical debit spread).
 *
 * Buy lower strike call + Sell higher strike call
 * Max profit: (high strike - low strike - net debit) × 100
 * Max loss: net debit × 100
 */
export function buildBullCallSpread(
  underlying: string,
  underlyingPrice: number,
  chain: OptionChainEntry[],
  expiration: Date,
  targetWidth: number = 5
): OptionsStrategy | null {
  const calls = chain
    .filter(
      (e) =>
        e.contract.type === "call" &&
        e.contract.expiration.getTime() === expiration.getTime() &&
        e.mid > 0
    )
    .sort((a, b) => a.contract.strike - b.contract.strike);

  if (calls.length < 2) return null;

  // Find ATM call and the short leg ~targetWidth above
  const atm = calls.reduce((prev, curr) =>
    Math.abs(curr.contract.strike - underlyingPrice) <
    Math.abs(prev.contract.strike - underlyingPrice)
      ? curr
      : prev
  );

  const shortLeg = calls.find(
    (c) => c.contract.strike >= atm.contract.strike + targetWidth
  );
  if (!shortLeg) return null;

  const netDebit = atm.mid - shortLeg.mid;
  const width = shortLeg.contract.strike - atm.contract.strike;

  return {
    name: `Bull Call Spread ${underlying} ${atm.contract.strike}/${shortLeg.contract.strike}`,
    type: "bull_call_spread",
    legs: [
      { contract: atm.contract, side: "buy", quantity: 1, price: atm.mid },
      { contract: shortLeg.contract, side: "sell", quantity: 1, price: shortLeg.mid },
    ],
    maxProfit: (width - netDebit) * 100,
    maxLoss: netDebit * 100,
    breakeven: [atm.contract.strike + netDebit],
    netDebit: netDebit * 100,
    requiredCapital: netDebit * 100,
  };
}

/**
 * Build a Bear Put Spread.
 *
 * Buy higher strike put + Sell lower strike put
 */
export function buildBearPutSpread(
  underlying: string,
  underlyingPrice: number,
  chain: OptionChainEntry[],
  expiration: Date,
  targetWidth: number = 5
): OptionsStrategy | null {
  const puts = chain
    .filter(
      (e) =>
        e.contract.type === "put" &&
        e.contract.expiration.getTime() === expiration.getTime() &&
        e.mid > 0
    )
    .sort((a, b) => a.contract.strike - b.contract.strike);

  if (puts.length < 2) return null;

  const atm = puts.reduce((prev, curr) =>
    Math.abs(curr.contract.strike - underlyingPrice) <
    Math.abs(prev.contract.strike - underlyingPrice)
      ? curr
      : prev
  );

  const shortLeg = puts
    .filter((p) => p.contract.strike <= atm.contract.strike - targetWidth)
    .pop();
  if (!shortLeg) return null;

  const netDebit = atm.mid - shortLeg.mid;
  const width = atm.contract.strike - shortLeg.contract.strike;

  return {
    name: `Bear Put Spread ${underlying} ${shortLeg.contract.strike}/${atm.contract.strike}`,
    type: "bear_put_spread",
    legs: [
      { contract: atm.contract, side: "buy", quantity: 1, price: atm.mid },
      { contract: shortLeg.contract, side: "sell", quantity: 1, price: shortLeg.mid },
    ],
    maxProfit: (width - netDebit) * 100,
    maxLoss: netDebit * 100,
    breakeven: [atm.contract.strike - netDebit],
    netDebit: netDebit * 100,
    requiredCapital: netDebit * 100,
  };
}

/**
 * Build an Iron Condor.
 *
 * Sell OTM put spread + Sell OTM call spread (credit strategy).
 * Best in low-vol, sideways markets.
 */
export function buildIronCondor(
  underlying: string,
  underlyingPrice: number,
  chain: OptionChainEntry[],
  expiration: Date,
  wingWidth: number = 5,
  distanceFromATM: number = 10
): OptionsStrategy | null {
  const expirationTime = expiration.getTime();
  const calls = chain
    .filter((e) => e.contract.type === "call" && e.contract.expiration.getTime() === expirationTime && e.mid > 0)
    .sort((a, b) => a.contract.strike - b.contract.strike);
  const puts = chain
    .filter((e) => e.contract.type === "put" && e.contract.expiration.getTime() === expirationTime && e.mid > 0)
    .sort((a, b) => a.contract.strike - b.contract.strike);

  // Short call at ATM + distance
  const shortCall = calls.find((c) => c.contract.strike >= underlyingPrice + distanceFromATM);
  const longCall = shortCall && calls.find((c) => c.contract.strike >= shortCall.contract.strike + wingWidth);

  // Short put at ATM - distance
  const shortPut = [...puts].reverse().find((p) => p.contract.strike <= underlyingPrice - distanceFromATM);
  const longPut = shortPut && puts.find((p) => p.contract.strike <= shortPut.contract.strike - wingWidth);

  if (!shortCall || !longCall || !shortPut || !longPut) return null;

  const netCredit =
    (shortCall.mid - longCall.mid) + (shortPut.mid - longPut.mid);

  return {
    name: `Iron Condor ${underlying} ${longPut.contract.strike}/${shortPut.contract.strike}/${shortCall.contract.strike}/${longCall.contract.strike}`,
    type: "iron_condor",
    legs: [
      { contract: longPut.contract, side: "buy", quantity: 1, price: longPut.mid },
      { contract: shortPut.contract, side: "sell", quantity: 1, price: shortPut.mid },
      { contract: shortCall.contract, side: "sell", quantity: 1, price: shortCall.mid },
      { contract: longCall.contract, side: "buy", quantity: 1, price: longCall.mid },
    ],
    maxProfit: netCredit * 100,
    maxLoss: (wingWidth - netCredit) * 100,
    breakeven: [
      shortPut.contract.strike - netCredit,
      shortCall.contract.strike + netCredit,
    ],
    netDebit: -netCredit * 100, // negative = credit
    requiredCapital: (wingWidth - netCredit) * 100,
  };
}

/**
 * Build a Cash-Secured Put (component of the Wheel strategy).
 *
 * Sell ATM/slightly OTM put, secured by cash equal to strike × 100.
 * For large accounts with portfolio margin.
 */
export function buildCashSecuredPut(
  underlying: string,
  underlyingPrice: number,
  chain: OptionChainEntry[],
  expiration: Date
): OptionsStrategy | null {
  const puts = chain
    .filter(
      (e) =>
        e.contract.type === "put" &&
        e.contract.expiration.getTime() === expiration.getTime() &&
        e.mid > 0 &&
        e.contract.strike <= underlyingPrice
    )
    .sort((a, b) => b.contract.strike - a.contract.strike);

  if (puts.length === 0) return null;

  // Sell the first OTM put (closest to ATM)
  const shortPut = puts[0];
  const premium = shortPut.mid;

  return {
    name: `Cash-Secured Put ${underlying} ${shortPut.contract.strike}`,
    type: "cash_secured_put",
    legs: [
      { contract: shortPut.contract, side: "sell", quantity: 1, price: premium },
    ],
    maxProfit: premium * 100,
    maxLoss: (shortPut.contract.strike - premium) * 100,
    breakeven: [shortPut.contract.strike - premium],
    netDebit: -premium * 100,
    requiredCapital: shortPut.contract.strike * 100,
  };
}

/**
 * Score and rank strategies based on multiple factors.
 * Factors: Lambda, risk/reward ratio, probability of profit, capital efficiency.
 */
export function scoreStrategy(
  strategy: OptionsStrategy,
  underlyingPrice: number,
  ivRank: number
): { score: number; factors: StrategyFactor[] } {
  const factors: StrategyFactor[] = [];

  // 1. Risk/Reward ratio (higher is better)
  const maxProfitNum = strategy.maxProfit === "unlimited" ? strategy.maxLoss * 3 : strategy.maxProfit;
  const riskReward = maxProfitNum / Math.max(strategy.maxLoss, 1);
  factors.push({
    name: "Risk/Reward Ratio",
    value: riskReward,
    weight: 0.3,
    contribution: Math.min(riskReward / 3, 1) * 30,
  });

  // 2. Capital efficiency (lower required capital = better for small accounts)
  const capitalEfficiency = maxProfitNum / Math.max(strategy.requiredCapital, 1);
  factors.push({
    name: "Capital Efficiency",
    value: capitalEfficiency,
    weight: 0.25,
    contribution: Math.min(capitalEfficiency, 1) * 25,
  });

  // 3. IV Rank alignment (sell strategies better in high IV, buy in low IV)
  const isCreditStrategy = strategy.netDebit < 0;
  const ivAlignment = isCreditStrategy ? ivRank / 100 : (100 - ivRank) / 100;
  factors.push({
    name: "IV Rank Alignment",
    value: ivAlignment,
    weight: 0.25,
    contribution: ivAlignment * 25,
  });

  // 4. Defined risk bonus (strategies with defined max loss score higher)
  const definedRisk = strategy.maxLoss < strategy.requiredCapital * 0.5 ? 1 : 0.5;
  factors.push({
    name: "Defined Risk",
    value: definedRisk,
    weight: 0.2,
    contribution: definedRisk * 20,
  });

  const score = factors.reduce((sum, f) => sum + f.contribution, 0);
  return { score, factors };
}

/**
 * Find all viable strategies for the given market conditions and account.
 */
export function findStrategies(
  underlying: string,
  underlyingPrice: number,
  chain: OptionChainEntry[],
  account: AccountSummary,
  ivRank: number,
  expirations: Date[]
): RankedStrategy[] {
  const tier = getAccountTier(account.netLiquidation);
  const allowed = allowedStrategies(tier);
  const results: RankedStrategy[] = [];

  for (const expiration of expirations) {
    const builders: Array<{
      type: StrategyType;
      build: () => OptionsStrategy | null;
    }> = [
      {
        type: "bull_call_spread",
        build: () => buildBullCallSpread(underlying, underlyingPrice, chain, expiration),
      },
      {
        type: "bear_put_spread",
        build: () => buildBearPutSpread(underlying, underlyingPrice, chain, expiration),
      },
      {
        type: "iron_condor",
        build: () => buildIronCondor(underlying, underlyingPrice, chain, expiration),
      },
      {
        type: "cash_secured_put",
        build: () => buildCashSecuredPut(underlying, underlyingPrice, chain, expiration),
      },
    ];

    for (const builder of builders) {
      if (!allowed.includes(builder.type)) continue;

      const strategy = builder.build();
      if (!strategy) continue;

      // Skip if required capital exceeds available funds
      if (strategy.requiredCapital > account.availableFunds) continue;

      const { score, factors } = scoreStrategy(strategy, underlyingPrice, ivRank);

      results.push({
        strategy,
        score,
        factors,
        riskAssessment: {
          var: strategy.maxLoss,
          confidenceLevel: 0.95,
          horizon: 1,
          cvar: strategy.maxLoss * 1.2,
          method: "historical",
          stressTests: [],
        },
        approved: false,
      });
    }
  }

  // Sort by score descending
  return results.sort((a, b) => b.score - a.score);
}
