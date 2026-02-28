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
import { roundToTickSize } from "../utils/tick-size.js";
import { estimateMargin } from "../utils/margin.js";
import { getTechnicalAlignmentScore, type TechnicalAnalysis } from "./technical-analysis.js";
import {
  buildPutCreditSpread,
  buildCallCreditSpread,
  buildIronButterfly,
  buildLongStraddle,
  buildLongStrangle,
  buildCoveredCall,
  buildCalendarSpread,
  buildDiagonalSpread,
  findByDelta,
} from "./strategy-builders.js";
import { calculatePOP, calculateEV, passesLiquidityFilter, type POPResult, type EVResult } from "./scoring.js";
import { getDynamicScoreAdjustment } from "./trade-journal.js";

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
    "put_credit_spread",
    "call_credit_spread",
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

  // Use ask for buying, bid for selling — matches real execution cost
  const buyPrice = roundToTickSize(atm.ask > 0 ? atm.ask : atm.mid, underlying);
  const sellPrice = roundToTickSize(shortLeg.bid > 0 ? shortLeg.bid : shortLeg.mid, underlying);
  const netDebit = buyPrice - sellPrice;
  const width = shortLeg.contract.strike - atm.contract.strike;

  return {
    name: `Bull Call Spread ${underlying} ${atm.contract.strike}/${shortLeg.contract.strike}`,
    type: "bull_call_spread",
    legs: [
      { contract: atm.contract, side: "buy", quantity: 1, price: buyPrice },
      { contract: shortLeg.contract, side: "sell", quantity: 1, price: sellPrice },
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

  // Use ask for buying, bid for selling — matches real execution cost
  const buyPrice = roundToTickSize(atm.ask > 0 ? atm.ask : atm.mid, underlying);
  const sellPrice = roundToTickSize(shortLeg.bid > 0 ? shortLeg.bid : shortLeg.mid, underlying);
  const netDebit = buyPrice - sellPrice;
  const width = atm.contract.strike - shortLeg.contract.strike;

  return {
    name: `Bear Put Spread ${underlying} ${shortLeg.contract.strike}/${atm.contract.strike}`,
    type: "bear_put_spread",
    legs: [
      { contract: atm.contract, side: "buy", quantity: 1, price: buyPrice },
      { contract: shortLeg.contract, side: "sell", quantity: 1, price: sellPrice },
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
  distanceFromATM: number = 10,
  targetDelta: number = 0.20 // Short legs at ~20-delta for wider iron condor
): OptionsStrategy | null {
  const expirationTime = expiration.getTime();
  const calls = chain
    .filter((e) => e.contract.type === "call" && e.contract.expiration.getTime() === expirationTime && e.mid > 0)
    .sort((a, b) => a.contract.strike - b.contract.strike);
  const puts = chain
    .filter((e) => e.contract.type === "put" && e.contract.expiration.getTime() === expirationTime && e.mid > 0)
    .sort((a, b) => a.contract.strike - b.contract.strike);

  // Delta-based strike selection for short legs (~20-delta for iron condors = ~80% POP per side)
  const otmCalls = calls.filter((c) => c.contract.strike > underlyingPrice);
  const otmPuts = puts.filter((p) => p.contract.strike < underlyingPrice);

  let shortCall = findByDelta(otmCalls, targetDelta);
  let shortPut = findByDelta(otmPuts, targetDelta);

  // Fallback to distance-from-ATM if no delta data
  if (!shortCall) {
    shortCall = calls.find((c) => c.contract.strike >= underlyingPrice + distanceFromATM) ?? null;
  }
  if (!shortPut) {
    shortPut = [...puts].reverse().find((p) => p.contract.strike <= underlyingPrice - distanceFromATM) ?? null;
  }

  const longCall = shortCall && calls.find((c) => c.contract.strike >= shortCall!.contract.strike + wingWidth);
  const longPut = shortPut && puts.find((p) => p.contract.strike <= shortPut!.contract.strike - wingWidth);

  if (!shortCall || !longCall || !shortPut || !longPut) return null;

  // Use ask for buying, bid for selling — matches real execution cost
  const lpPrice = roundToTickSize(longPut.ask > 0 ? longPut.ask : longPut.mid, underlying);
  const spPrice = roundToTickSize(shortPut.bid > 0 ? shortPut.bid : shortPut.mid, underlying);
  const scPrice = roundToTickSize(shortCall.bid > 0 ? shortCall.bid : shortCall.mid, underlying);
  const lcPrice = roundToTickSize(longCall.ask > 0 ? longCall.ask : longCall.mid, underlying);
  const netCredit = (scPrice - lcPrice) + (spPrice - lpPrice);

  return {
    name: `Iron Condor ${underlying} ${longPut.contract.strike}/${shortPut.contract.strike}/${shortCall.contract.strike}/${longCall.contract.strike}`,
    type: "iron_condor",
    legs: [
      { contract: longPut.contract, side: "buy", quantity: 1, price: lpPrice },
      { contract: shortPut.contract, side: "sell", quantity: 1, price: spPrice },
      { contract: shortCall.contract, side: "sell", quantity: 1, price: scPrice },
      { contract: longCall.contract, side: "buy", quantity: 1, price: lcPrice },
    ],
    maxProfit: netCredit * 100,
    // Use actual wing widths (may differ from wingWidth param if exact strikes unavailable)
    maxLoss: (Math.max(
      shortCall.contract.strike ? longCall.contract.strike - shortCall.contract.strike : wingWidth,
      shortPut.contract.strike ? shortPut.contract.strike - longPut.contract.strike : wingWidth,
    ) - netCredit) * 100,
    breakeven: [
      shortPut.contract.strike - netCredit,
      shortCall.contract.strike + netCredit,
    ],
    netDebit: -netCredit * 100, // negative = credit
    requiredCapital: (Math.max(
      longCall.contract.strike - shortCall.contract.strike,
      shortPut.contract.strike - longPut.contract.strike,
    ) - netCredit) * 100,
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
  expiration: Date,
  targetDelta: number = 0.25 // Sell ~25-delta OTM put for ~75% POP
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

  // Delta-based strike selection: target ~25-delta OTM put for better POP.
  // Falls back to closest OTM put if delta data unavailable.
  let shortPut = findByDelta(puts, targetDelta);
  if (!shortPut) {
    shortPut = puts[0]; // Fallback: closest to ATM
  }
  // Use bid for selling — matches real execution price
  const premium = roundToTickSize(shortPut.bid > 0 ? shortPut.bid : shortPut.mid, underlying);

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
  ivRank: number,
  technicalAnalysis?: TechnicalAnalysis | null
): { score: number; factors: StrategyFactor[]; pop?: POPResult; ev?: EVResult } {
  const factors: StrategyFactor[] = [];

  // 1. Risk/Reward ratio (higher is better) — weight 18%
  const maxProfitNum = strategy.maxProfit === "unlimited" ? Math.abs(strategy.maxLoss) * 3 : strategy.maxProfit;
  const maxLossAbs = Math.abs(strategy.maxLoss);
  const riskReward = maxLossAbs > 0 ? maxProfitNum / maxLossAbs : 0;
  factors.push({
    name: "Risk/Reward Ratio",
    value: riskReward,
    weight: 0.18,
    contribution: Math.min(riskReward / 3, 1) * 18,
  });

  // 2. Capital efficiency — weight 15%
  const capitalEfficiency = maxProfitNum / Math.max(strategy.requiredCapital, 1);
  factors.push({
    name: "Capital Efficiency",
    value: capitalEfficiency,
    weight: 0.15,
    contribution: Math.min(capitalEfficiency, 1) * 15,
  });

  // 3. IV Rank alignment — weight 15%
  const isCreditStrategy = strategy.netDebit < 0;
  const ivAlignment = isCreditStrategy ? ivRank / 100 : (100 - ivRank) / 100;
  factors.push({
    name: "IV Rank Alignment",
    value: ivAlignment,
    weight: 0.15,
    contribution: ivAlignment * 15,
  });

  // 4. Defined risk bonus — weight 10%
  const definedRisk = strategy.maxLoss < strategy.requiredCapital * 0.5 ? 1 : 0.5;
  factors.push({
    name: "Defined Risk",
    value: definedRisk,
    weight: 0.10,
    contribution: definedRisk * 10,
  });

  // 5. DTE sweet spot — weight 12%
  const now = Date.now();
  const legDTEs = strategy.legs
    .map((l) => {
      if (!l.contract.expiration) return 0;
      return Math.round((new Date(l.contract.expiration).getTime() - now) / (1000 * 60 * 60 * 24));
    })
    .filter((d) => d > 0);
  const avgDTE = legDTEs.length > 0
    ? legDTEs.reduce((a, b) => a + b, 0) / legDTEs.length
    : 30;

  const idealDTE = 37;
  const dteDeviation = Math.abs(avgDTE - idealDTE) / idealDTE;
  const dteFit = Math.max(0, 1 - dteDeviation);
  factors.push({
    name: "DTE Sweet Spot",
    value: avgDTE,
    weight: 0.12,
    contribution: dteFit * 12,
  });

  // 6. Technical Alignment — weight 10%
  const techScore = technicalAnalysis
    ? getTechnicalAlignmentScore(strategy.type, technicalAnalysis, underlyingPrice)
    : 50; // neutral if no data
  factors.push({
    name: "Technical Alignment",
    value: techScore,
    weight: 0.10,
    contribution: ((techScore - 50) / 50) * 10, // centered: 50→0, 100→+10, 0→-10
  });

  // 7. Probability of Profit (POP) — weight 10%
  const popResult = calculatePOP(strategy, underlyingPrice);
  factors.push({
    name: "Probability of Profit",
    value: popResult.pop,
    weight: 0.10,
    contribution: (popResult.pop - 0.5) * 20, // 50% POP → 0, 70% → +4, 30% → -4
  });

  // 8. Expected Value — weight 5%
  const evResult = calculateEV(strategy, popResult.pop);
  factors.push({
    name: "Expected Value",
    value: evResult.evPerDollarRisked,
    weight: 0.05,
    contribution: evResult.isPositiveEV ? Math.min(evResult.evPerDollarRisked * 10, 5) : -3,
  });

  // 9. Journal feedback — weight dynamic (up to ±10 points)
  const journalAdj = getDynamicScoreAdjustment(strategy.type);
  if (journalAdj !== 0) {
    factors.push({
      name: "Historical Performance",
      value: journalAdj,
      weight: 0.05,
      contribution: journalAdj,
    });
  }

  // 10. IV Rank quality gate — penalize credit in low IV, debit in high IV
  let ivGatePenalty = 0;
  if (isCreditStrategy && ivRank < 25) {
    ivGatePenalty = -8; // selling premium in low IV is poor value
  } else if (!isCreditStrategy && ivRank > 75) {
    ivGatePenalty = -5; // buying premium in high IV = overpaying
  } else if (isCreditStrategy && ivRank > 60) {
    ivGatePenalty = 3; // bonus for selling in high IV
  } else if (!isCreditStrategy && ivRank < 25) {
    ivGatePenalty = 3; // bonus for buying in low IV
  }
  if (ivGatePenalty !== 0) {
    factors.push({
      name: "IV Quality Gate",
      value: ivRank,
      weight: 0.05,
      contribution: ivGatePenalty,
    });
  }

  const score = factors.reduce((sum, f) => sum + f.contribution, 0);
  return { score, factors, pop: popResult, ev: evResult };
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
  expirations: Date[],
  options?: {
    technicalAnalysis?: TechnicalAnalysis | null;
    hasShares?: boolean;
    farExpirations?: Date[];
  }
): RankedStrategy[] {
  const tier = getAccountTier(account.netLiquidation);
  const allowed = allowedStrategies(tier);
  const results: RankedStrategy[] = [];
  const hasShares = options?.hasShares ?? false;

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
        type: "put_credit_spread",
        build: () => buildPutCreditSpread(underlying, underlyingPrice, chain, expiration),
      },
      {
        type: "call_credit_spread",
        build: () => buildCallCreditSpread(underlying, underlyingPrice, chain, expiration),
      },
      {
        type: "iron_condor",
        build: () => buildIronCondor(underlying, underlyingPrice, chain, expiration),
      },
      {
        type: "iron_butterfly",
        build: () => buildIronButterfly(underlying, underlyingPrice, chain, expiration),
      },
      {
        type: "cash_secured_put",
        build: () => buildCashSecuredPut(underlying, underlyingPrice, chain, expiration),
      },
      {
        type: "straddle",
        build: () => buildLongStraddle(underlying, underlyingPrice, chain, expiration),
      },
      {
        type: "strangle",
        build: () => buildLongStrangle(underlying, underlyingPrice, chain, expiration),
      },
      {
        type: "covered_call",
        build: () => buildCoveredCall(underlying, underlyingPrice, chain, expiration, hasShares),
      },
    ];

    // Calendar and diagonal spreads need a far expiration
    const farExps = options?.farExpirations ?? expirations.filter(
      (e) => e.getTime() > expiration.getTime() + 14 * 24 * 60 * 60 * 1000
    );
    if (farExps.length > 0) {
      const farExp = farExps[0];
      builders.push(
        {
          type: "calendar_spread",
          build: () => buildCalendarSpread(underlying, underlyingPrice, chain, expiration, farExp),
        },
        {
          type: "diagonal_spread",
          build: () => buildDiagonalSpread(underlying, underlyingPrice, chain, expiration, farExp),
        },
      );
    }

    for (const builder of builders) {
      if (!allowed.includes(builder.type)) continue;

      const strategy = builder.build();
      if (!strategy) continue;

      // Skip if estimated IBKR margin exceeds available funds.
      // Uses conservative margin estimates with 15% safety buffer
      // to avoid "insufficient funds" rejections from IBKR.
      const marginRequired = estimateMargin(strategy, underlyingPrice);
      if (marginRequired > account.availableFunds) continue;

      // Also skip if theoretical capital exceeds available funds
      if (strategy.requiredCapital > account.availableFunds) continue;

      // ── Liquidity hard filter: OI > 100, Volume > 10, Spread < 10% ──
      // Prevents entering illiquid contracts with bad fills
      if (!passesLiquidityFilter(strategy, chain, 100, 10, 10)) continue;

      // ── IV Rank quality gate: block poor-value entries ──
      // Don't sell premium in very low IV (< 20) — not enough edge
      const isCreditType = strategy.netDebit < 0;
      if (isCreditType && ivRank < 20) continue;

      const { score, factors } = scoreStrategy(
        strategy, underlyingPrice, ivRank, options?.technicalAnalysis
      );

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
  results.sort((a, b) => b.score - a.score);

  // ── Expiration diversity: round-robin selection across expiration dates ──
  // Without this, all top recommendations converge on the same DTE because
  // similar strategy types at different expirations get nearly identical scores.
  // Round-robin ensures the user gets recommendations across multiple dates.
  if (expirations.length > 1 && results.length > expirations.length) {
    const byExpiration = new Map<number, RankedStrategy[]>();
    for (const r of results) {
      const expMs = r.strategy.legs[0]?.contract.expiration?.getTime() ?? 0;
      if (!byExpiration.has(expMs)) byExpiration.set(expMs, []);
      byExpiration.get(expMs)!.push(r);
    }

    // Round-robin: pick the best from each expiration, then second-best, etc.
    const diverse: RankedStrategy[] = [];
    const iterators = Array.from(byExpiration.values()).map((arr) => arr[Symbol.iterator]());
    let exhausted = 0;
    while (exhausted < iterators.length && diverse.length < results.length) {
      for (const iter of iterators) {
        const next = iter.next();
        if (!next.done) {
          diverse.push(next.value);
        } else {
          exhausted++;
        }
      }
    }

    return diverse;
  }

  return results;
}
