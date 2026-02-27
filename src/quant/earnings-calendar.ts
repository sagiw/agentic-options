/**
 * Earnings Calendar & Corporate Events Module
 *
 * Provides:
 *   - Earnings date proximity check (avoid selling premium 7 days before earnings)
 *   - Ex-dividend date awareness
 *   - Event risk scoring
 *
 * Uses Yahoo Finance for earnings data (no API key needed).
 */

import { agentLogger } from "../utils/logger.js";

const log = agentLogger("earnings");

// ─── Interfaces ─────────────────────────────────────────

export interface EarningsInfo {
  symbol: string;
  /** Next earnings date (null if unknown) */
  earningsDate: Date | null;
  /** Days until next earnings */
  daysUntilEarnings: number | null;
  /** Is within the danger zone (7 days before earnings)? */
  isEarningsDangerZone: boolean;
  /** Ex-dividend date (null if N/A) */
  exDividendDate: Date | null;
  /** Days until ex-dividend */
  daysUntilExDiv: number | null;
}

export interface EventRisk {
  /** Overall event risk score 0-100 */
  score: number;
  /** Risk factors */
  factors: string[];
  /** Should we avoid selling premium? */
  avoidSellingPremium: boolean;
  /** Should we avoid short calls (for covered calls near ex-div)? */
  avoidShortCalls: boolean;
}

// ─── Cache ──────────────────────────────────────────────

const earningsCache = new Map<string, { data: EarningsInfo; expiry: number }>();
const EARNINGS_CACHE_TTL = 3_600_000; // 1 hour

// ─── Main Functions ─────────────────────────────────────

/**
 * Fetch earnings info for a symbol.
 * Uses Yahoo Finance quoteSummary endpoint.
 */
export async function getEarningsInfo(symbol: string): Promise<EarningsInfo> {
  // Check cache
  const cached = earningsCache.get(symbol);
  if (cached && Date.now() < cached.expiry) return cached.data;

  const now = new Date();
  let earningsDate: Date | null = null;
  let exDividendDate: Date | null = null;

  try {
    const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=calendarEvents,defaultKeyStatistics`;
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
    });

    if (res.ok) {
      const json = (await res.json()) as any;
      const calendar = json?.quoteSummary?.result?.[0]?.calendarEvents;
      const stats = json?.quoteSummary?.result?.[0]?.defaultKeyStatistics;

      // Earnings date
      const earningsDates = calendar?.earnings?.earningsDate;
      if (earningsDates && earningsDates.length > 0) {
        const rawDate = earningsDates[0]?.raw;
        if (rawDate) {
          earningsDate = new Date(rawDate * 1000);
        }
      }

      // Ex-dividend date
      const exDivRaw = calendar?.exDividendDate?.raw || stats?.exDividendDate?.raw;
      if (exDivRaw) {
        exDividendDate = new Date(exDivRaw * 1000);
      }
    }
  } catch (err) {
    log.warn(`Failed to fetch earnings for ${symbol}: ${err}`);
  }

  const daysUntilEarnings = earningsDate
    ? Math.round((earningsDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
    : null;
  const daysUntilExDiv = exDividendDate
    ? Math.round((exDividendDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
    : null;

  const info: EarningsInfo = {
    symbol,
    earningsDate,
    daysUntilEarnings,
    isEarningsDangerZone: daysUntilEarnings !== null && daysUntilEarnings >= 0 && daysUntilEarnings <= 7,
    exDividendDate,
    daysUntilExDiv,
  };

  earningsCache.set(symbol, { data: info, expiry: Date.now() + EARNINGS_CACHE_TTL });

  if (earningsDate) {
    log.info(`${symbol} earnings: ${earningsDate.toISOString().split("T")[0]} (${daysUntilEarnings}d away${info.isEarningsDangerZone ? " — DANGER ZONE" : ""})`);
  }
  if (exDividendDate && daysUntilExDiv !== null && daysUntilExDiv >= 0 && daysUntilExDiv <= 30) {
    log.info(`${symbol} ex-div: ${exDividendDate.toISOString().split("T")[0]} (${daysUntilExDiv}d away)`);
  }

  return info;
}

/**
 * Evaluate event risk for trading decisions.
 */
export function evaluateEventRisk(earnings: EarningsInfo): EventRisk {
  let score = 0;
  const factors: string[] = [];
  let avoidSellingPremium = false;
  let avoidShortCalls = false;

  // Earnings risk
  if (earnings.daysUntilEarnings !== null && earnings.daysUntilEarnings >= 0) {
    if (earnings.daysUntilEarnings <= 3) {
      score += 50;
      factors.push(`Earnings in ${earnings.daysUntilEarnings} day(s) — HIGH RISK`);
      avoidSellingPremium = true;
    } else if (earnings.daysUntilEarnings <= 7) {
      score += 35;
      factors.push(`Earnings in ${earnings.daysUntilEarnings} day(s) — avoid selling premium`);
      avoidSellingPremium = true;
    } else if (earnings.daysUntilEarnings <= 14) {
      score += 15;
      factors.push(`Earnings in ${earnings.daysUntilEarnings} day(s) — elevated risk`);
    }
  }

  // Ex-dividend risk (for short calls)
  if (earnings.daysUntilExDiv !== null && earnings.daysUntilExDiv >= 0 && earnings.daysUntilExDiv <= 7) {
    score += 20;
    factors.push(`Ex-dividend in ${earnings.daysUntilExDiv} day(s) — short call assignment risk`);
    avoidShortCalls = true;
  }

  return {
    score: Math.min(100, score),
    factors,
    avoidSellingPremium,
    avoidShortCalls,
  };
}

/**
 * Filter strategies based on event risk.
 * Returns true if the strategy should be KEPT (passes the filter).
 */
export function passesEventFilter(
  strategyType: string,
  eventRisk: EventRisk
): boolean {
  const isCreditStrategy = [
    "iron_condor", "iron_butterfly", "cash_secured_put",
    "put_credit_spread", "call_credit_spread", "covered_call",
  ].includes(strategyType);

  const hasShortCalls = [
    "covered_call", "call_credit_spread", "iron_condor", "iron_butterfly",
  ].includes(strategyType);

  // Block credit strategies near earnings
  if (eventRisk.avoidSellingPremium && isCreditStrategy) {
    return false;
  }

  // Block short calls near ex-dividend
  if (eventRisk.avoidShortCalls && hasShortCalls) {
    return false;
  }

  return true;
}
