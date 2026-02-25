/**
 * The "Brain" — Quantitative Analyst Agent
 *
 * Responsible for all quantitative computations:
 *   - Recalculating Greeks in real-time
 *   - Computing Lambda (leverage) for every option in the chain
 *   - Running the Strategy Selection Matrix
 *   - Providing data for XAI Explanation Cards
 *
 * This agent does NOT interact with the browser — it receives
 * market data and produces analytical results.
 */

import { agentLogger } from "../utils/logger.js";
import { generateId } from "../utils/validation.js";
import {
  blackScholesPrice,
  impliedVolatility,
  type BSParams,
} from "../quant/black-scholes.js";
import { calculateGreeks, aggregateGreeks } from "../quant/greeks.js";
import { calculateLambda, lambdaCurve } from "../quant/lambda.js";
import { findStrategies, scoreStrategy } from "../quant/strategies.js";
import { roundToTickSize } from "../utils/tick-size.js";
import type {
  Agent,
  AgentMessage,
  AgentRole,
  AgentStatus,
  TaskRequest,
  RankedStrategy,
} from "../types/agents.js";
import type {
  OptionChain,
  OptionChainEntry,
  Greeks,
  LambdaMetric,
} from "../types/options.js";
import type { AccountSummary } from "../types/portfolio.js";

const log = agentLogger("quant");

/** Result of a full chain analysis */
export interface ChainAnalysis {
  underlying: string;
  underlyingPrice: number;
  entries: Array<
    OptionChainEntry & {
      theoreticalPrice: number;
      mispricing: number; // market price - theoretical
    }
  >;
  ivSurface: Array<{ strike: number; expDays: number; iv: number }>;
  lambdaCurve: Array<{ strike: number; lambda: number }>;
}

export class QuantAnalyst implements Agent {
  readonly role: AgentRole = "quant";
  status: AgentStatus = "idle";

  /** Risk-free rate (updated from market data) */
  private riskFreeRate: number = 0.05; // default 5%

  /** Dividend yields by symbol */
  private dividendYields: Map<string, number> = new Map();

  async initialize(): Promise<void> {
    log.info("Initializing quant analyst...");
    this.status = "idle";
    // In production: fetch current risk-free rate from treasury API
  }

  async handleMessage(message: AgentMessage): Promise<AgentMessage | null> {
    const task = message.payload as TaskRequest;
    this.status = "thinking";

    try {
      let result: unknown;

      switch (task.action) {
        case "calculate_greeks":
          result = this.computeGreeks(task.params);
          break;

        case "fetch_option_chain":
          result = await this.analyzeChain(task.params);
          break;

        case "find_strategies":
          result = this.findOptimalStrategies(task.params);
          break;

        case "rank_strategies":
          result = this.rankStrategies(task.params);
          break;

        default:
          log.warn(`Unknown action: ${task.action}`);
          result = null;
      }

      this.status = "idle";
      return {
        id: generateId(),
        from: "quant",
        to: message.from,
        type: "task_response",
        payload: result,
        timestamp: new Date(),
        correlationId: message.id,
      };
    } catch (err) {
      this.status = "error";
      log.error(`Quant calculation failed: ${task.action}`, { error: err });
      return {
        id: generateId(),
        from: "quant",
        to: message.from,
        type: "error",
        payload: { error: String(err) },
        timestamp: new Date(),
        correlationId: message.id,
      };
    }
  }

  async shutdown(): Promise<void> {
    log.info("Quant analyst shutting down");
    this.status = "idle";
  }

  // ─── Core Calculations ────────────────────────────────────

  /**
   * Compute Greeks for a single option or set of options.
   */
  private computeGreeks(params: Record<string, unknown>): {
    greeks: Greeks;
    lambda: LambdaMetric;
    theoreticalPrice: number;
  } {
    const S = params.underlyingPrice as number;
    const K = params.strike as number;
    const T = params.timeToExpiry as number; // in years
    const sigma = params.iv as number;
    const type = params.type as "call" | "put";
    const q = (params.dividendYield as number) ?? 0;

    const bsParams: BSParams = {
      S,
      K,
      T,
      r: this.riskFreeRate,
      sigma,
      q,
    };

    const greeks = calculateGreeks(bsParams, type);
    const theoreticalPrice = blackScholesPrice(bsParams, type);
    const marketPrice = (params.marketPrice as number) ?? theoreticalPrice;
    const lambda = calculateLambda(greeks.delta, S, marketPrice);

    return { greeks, lambda, theoreticalPrice };
  }

  /**
   * Analyze an entire option chain.
   * Calculates Greeks + Lambda for every option, identifies mispricings.
   */
  private async analyzeChain(
    params: Record<string, unknown>
  ): Promise<ChainAnalysis> {
    const symbol = params.symbol as string;
    log.info(`Analyzing option chain for ${symbol}`);

    // In production: fetch real chain from IBKR
    // Scaffold: generate synthetic chain for development
    const underlyingPrice = (params.underlyingPrice as number) ?? 150;
    const chain = this.generateSyntheticChain(symbol, underlyingPrice);

    const q = this.dividendYields.get(symbol) ?? 0;
    const entries = chain.map((entry) => {
      const T = this.yearFraction(entry.contract.expiration);
      const bsParams: BSParams = {
        S: underlyingPrice,
        K: entry.contract.strike,
        T,
        r: this.riskFreeRate,
        sigma: entry.iv,
        q,
      };

      const theoreticalPrice = blackScholesPrice(bsParams, entry.contract.type);
      const greeks = calculateGreeks(bsParams, entry.contract.type);
      const lambda = calculateLambda(greeks.delta, underlyingPrice, entry.mid);

      return {
        ...entry,
        greeks,
        lambda,
        theoreticalPrice,
        mispricing: entry.mid - theoreticalPrice,
      };
    });

    // Build lambda curve for calls
    const strikes = [...new Set(entries.map((e) => e.contract.strike))].sort(
      (a, b) => a - b
    );
    const lambdaCurveData = lambdaCurve(
      underlyingPrice,
      strikes,
      30 / 365,
      this.riskFreeRate,
      0.3,
      "call",
      q
    );

    return {
      underlying: symbol,
      underlyingPrice,
      entries,
      ivSurface: entries.map((e) => ({
        strike: e.contract.strike,
        expDays: Math.round(this.yearFraction(e.contract.expiration) * 365),
        iv: e.iv,
      })),
      lambdaCurve: lambdaCurveData.map((p) => ({
        strike: p.strike,
        lambda: p.lambda,
      })),
    };
  }

  /**
   * Find optimal strategies using the Strategy Selection Matrix.
   */
  private findOptimalStrategies(
    params: Record<string, unknown>
  ): RankedStrategy[] {
    const symbol = params.symbol as string;
    const underlyingPrice = (params.underlyingPrice as number) ?? 150;
    const ivRank = (params.ivRank as number) ?? 50;
    const baseIV = (params.baseIV as number) ?? 0.3;

    // Mock account for scaffold
    const account: AccountSummary = (params.account as AccountSummary) ?? {
      accountId: "DEV-001",
      currency: "USD",
      netLiquidation: 50_000,
      totalCash: 25_000,
      buyingPower: 100_000,
      availableFunds: 25_000,
      marginUsed: 12_500,
      marginType: "reg_t" as const,
      unrealizedPnL: 0,
      realizedPnL: 0,
      tier: "medium" as const,
    };

    log.info(
      `Building chain for ${symbol}: price=$${underlyingPrice.toFixed(2)}, ` +
      `IV=${(baseIV * 100).toFixed(1)}%, IV Rank=${ivRank}`
    );

    const chain = this.generateSyntheticChain(symbol, underlyingPrice, baseIV);
    const expirations = [
      ...new Set(chain.map((e) => e.contract.expiration.getTime())),
    ].map((t) => new Date(t));

    return findStrategies(
      symbol,
      underlyingPrice,
      chain,
      account,
      ivRank,
      expirations
    );
  }

  /**
   * Re-rank strategies with updated data.
   */
  private rankStrategies(params: Record<string, unknown>): RankedStrategy[] {
    const strategies = params.strategies as RankedStrategy[];
    const underlyingPrice = params.underlyingPrice as number;
    const ivRank = (params.ivRank as number) ?? 50;

    return strategies
      .map((s) => {
        const { score, factors } = scoreStrategy(
          s.strategy,
          underlyingPrice,
          ivRank
        );
        return { ...s, score, factors };
      })
      .sort((a, b) => b.score - a.score);
  }

  // ─── Helpers ──────────────────────────────────────────────

  private yearFraction(expiration: Date): number {
    const now = new Date();
    const msPerYear = 365.25 * 24 * 60 * 60 * 1000;
    return Math.max((expiration.getTime() - now.getTime()) / msPerYear, 0.001);
  }

  /**
   * Get the next N monthly option expirations (3rd Friday of each month).
   * These match real IBKR monthly expiration dates.
   */
  private getNextMonthlyExpirations(count: number): Date[] {
    const results: Date[] = [];
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    for (let m = 0; results.length < count && m < 12; m++) {
      const year = now.getFullYear() + Math.floor((now.getMonth() + m) / 12);
      const month = (now.getMonth() + m) % 12;
      // Find the 3rd Friday of this month
      const firstDay = new Date(year, month, 1);
      const firstFriday = ((5 - firstDay.getDay() + 7) % 7) + 1;
      const thirdFriday = new Date(year, month, firstFriday + 14);
      // Must be at least 14 days out (skip near-term expirations)
      const daysOut = Math.ceil((thirdFriday.getTime() - today.getTime()) / 86400000);
      if (daysOut >= 14) {
        results.push(thirdFriday);
      }
    }
    return results;
  }

  /**
   * Generate a synthetic option chain calibrated to real market data.
   *
   * Strike spacing adapts to the stock price:
   *   - Under $50:  $1 strikes
   *   - $50-$200:   $2.5 strikes
   *   - $200-$500:  $5 strikes
   *   - Over $500:  $10 strikes
   *
   * Base IV comes from real historical volatility when available.
   */
  private generateSyntheticChain(
    symbol: string,
    underlyingPrice: number,
    baseIV: number = 0.3
  ): OptionChainEntry[] {
    const entries: OptionChainEntry[] = [];
    // Use real monthly expirations (3rd Friday of each month)
    // instead of arbitrary "today + N days" which creates wrong dates
    const expirations = this.getNextMonthlyExpirations(3);

    // Adaptive strike spacing based on stock price
    let strikeStep: number;
    if (underlyingPrice < 50) strikeStep = 1;
    else if (underlyingPrice < 200) strikeStep = 2.5;
    else if (underlyingPrice < 500) strikeStep = 5;
    else strikeStep = 10;

    // Round price to nearest strike
    const atmStrike = Math.round(underlyingPrice / strikeStep) * strikeStep;

    // Generate ~20 strikes in each direction
    const numStrikes = 12;
    const strikes: number[] = [];
    for (let i = -numStrikes; i <= numStrikes; i++) {
      strikes.push(atmStrike + i * strikeStep);
    }

    for (const exp of expirations) {
      for (const strike of strikes) {
        if (strike <= 0) continue;

        for (const type of ["call", "put"] as const) {
          const T = this.yearFraction(exp);
          // IV smile: higher IV for OTM options (skew)
          const moneyness = (strike - underlyingPrice) / underlyingPrice;
          // Put skew: OTM puts have higher IV; OTM calls slightly lower
          const skew = type === "put"
            ? Math.max(-moneyness, 0) * 0.4
            : Math.max(moneyness, 0) * 0.15;
          const iv = baseIV * (1 + skew + Math.abs(moneyness) * 0.3);

          const bsParams: BSParams = {
            S: underlyingPrice,
            K: strike,
            T,
            r: this.riskFreeRate,
            sigma: iv,
          };

          const price = blackScholesPrice(bsParams, type);
          if (price < 0.01) continue; // skip worthless options

          const greeks = calculateGreeks(bsParams, type);
          const lambda = calculateLambda(greeks.delta, underlyingPrice, price);

          // Bid-ask spread: tighter for ATM, wider for OTM
          const spreadPct = 0.02 + Math.abs(moneyness) * 0.08;
          const spread = price * spreadPct;

          entries.push({
            contract: {
              symbol: `${symbol}${exp.toISOString().slice(2, 10).replace(/-/g, "")}${type === "call" ? "C" : "P"}${strike}`,
              underlying: symbol,
              type,
              style: "american",
              strike,
              expiration: exp,
              multiplier: 100,
              exchange: "SMART",
            },
            bid: roundToTickSize(Math.max(price - spread / 2, 0.01), symbol),
            ask: roundToTickSize(price + spread / 2, symbol),
            mid: roundToTickSize(price, symbol),
            last: roundToTickSize(price, symbol),
            volume: Math.floor(Math.random() * 5000),
            openInterest: Math.floor(Math.random() * 20000),
            iv,
            greeks,
            lambda,
          });
        }
      }
    }

    return entries;
  }

  /** Update risk-free rate */
  setRiskFreeRate(rate: number): void {
    this.riskFreeRate = rate;
    log.info(`Risk-free rate updated to ${(rate * 100).toFixed(2)}%`);
  }

  /** Set dividend yield for a symbol */
  setDividendYield(symbol: string, yield_: number): void {
    this.dividendYields.set(symbol, yield_);
  }
}
