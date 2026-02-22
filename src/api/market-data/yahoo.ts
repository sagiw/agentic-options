/**
 * Yahoo Finance Market Data — Free Fallback
 *
 * Uses Yahoo Finance's public chart API to fetch:
 *   - Real-time stock quotes (price, volume, change)
 *   - Historical prices (for HV and IV rank approximation)
 *   - Approximate implied volatility from historical volatility
 *
 * No API key required. Used when IBKR data is unavailable.
 */

import { agentLogger } from "../../utils/logger.js";

const log = agentLogger("yahoo");

const YAHOO_BASE = "https://query1.finance.yahoo.com/v8/finance/chart";

export interface YahooQuote {
  symbol: string;
  price: number;
  previousClose: number;
  change: number;
  changePct: number;
  high: number;
  low: number;
  open: number;
  volume: number;
  marketCap: number;
  timestamp: Date;
}

export interface VolatilityData {
  /** Annualized historical volatility (30-day) */
  hv30: number;
  /** Annualized historical volatility (60-day) */
  hv60: number;
  /** Approximate IV Rank (0-100) based on HV percentile over 1 year */
  ivRank: number;
  /** Average daily move in % */
  avgDailyMove: number;
}

// ── In-memory cache to avoid hammering Yahoo ────────────────
const quoteCache: Map<string, { data: YahooQuote; expiry: number }> = new Map();
const volCache: Map<string, { data: VolatilityData; expiry: number }> = new Map();
const CACHE_TTL = 60_000; // 1 minute for quotes
const VOL_CACHE_TTL = 300_000; // 5 minutes for volatility

/**
 * Fetch real-time quote from Yahoo Finance.
 */
export async function getYahooQuote(symbol: string): Promise<YahooQuote | null> {
  // Check cache
  const cached = quoteCache.get(symbol);
  if (cached && Date.now() < cached.expiry) return cached.data;

  try {
    const url = `${YAHOO_BASE}/${encodeURIComponent(symbol)}?interval=1d&range=1d`;
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
    });

    if (!res.ok) {
      log.warn(`Yahoo quote failed for ${symbol}: HTTP ${res.status}`);
      return null;
    }

    const json = (await res.json()) as any;
    const result = json?.chart?.result?.[0];
    if (!result) {
      log.warn(`Yahoo returned no data for ${symbol}`);
      return null;
    }

    const meta = result.meta;
    const price = meta.regularMarketPrice ?? 0;
    const prevClose = meta.chartPreviousClose ?? meta.previousClose ?? price;

    const quote: YahooQuote = {
      symbol: meta.symbol ?? symbol,
      price,
      previousClose: prevClose,
      change: price - prevClose,
      changePct: prevClose > 0 ? ((price - prevClose) / prevClose) * 100 : 0,
      high: meta.regularMarketDayHigh ?? price,
      low: meta.regularMarketDayLow ?? price,
      open: meta.regularMarketOpen ?? price,
      volume: meta.regularMarketVolume ?? 0,
      marketCap: meta.marketCap ?? 0,
      timestamp: new Date(),
    };

    quoteCache.set(symbol, { data: quote, expiry: Date.now() + CACHE_TTL });
    log.info(`Yahoo quote for ${symbol}: $${price.toFixed(2)} (${quote.changePct >= 0 ? "+" : ""}${quote.changePct.toFixed(2)}%)`);
    return quote;
  } catch (err) {
    log.error(`Yahoo quote fetch failed for ${symbol}`, { error: String(err) });
    return null;
  }
}

/**
 * Fetch historical prices and compute volatility metrics.
 */
export async function getVolatilityData(symbol: string): Promise<VolatilityData | null> {
  // Check cache
  const cached = volCache.get(symbol);
  if (cached && Date.now() < cached.expiry) return cached.data;

  try {
    // Fetch 1 year of daily data
    const url = `${YAHOO_BASE}/${encodeURIComponent(symbol)}?interval=1d&range=1y`;
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
    });

    if (!res.ok) return null;

    const json = (await res.json()) as any;
    const result = json?.chart?.result?.[0];
    if (!result?.indicators?.quote?.[0]) return null;

    const closes: number[] = result.indicators.quote[0].close?.filter(
      (c: number | null) => c != null && c > 0
    ) ?? [];

    if (closes.length < 60) {
      log.warn(`Not enough data for ${symbol} volatility (${closes.length} bars)`);
      return null;
    }

    // Compute daily log returns
    const returns: number[] = [];
    for (let i = 1; i < closes.length; i++) {
      returns.push(Math.log(closes[i] / closes[i - 1]));
    }

    // 30-day HV
    const recent30 = returns.slice(-30);
    const hv30 = stdDev(recent30) * Math.sqrt(252);

    // 60-day HV
    const recent60 = returns.slice(-60);
    const hv60 = stdDev(recent60) * Math.sqrt(252);

    // IV Rank approximation: where is current 30-day HV relative to its 1-year range?
    const rollingHVs: number[] = [];
    for (let i = 30; i <= returns.length; i++) {
      const window = returns.slice(i - 30, i);
      rollingHVs.push(stdDev(window) * Math.sqrt(252));
    }

    const minHV = Math.min(...rollingHVs);
    const maxHV = Math.max(...rollingHVs);
    const ivRank =
      maxHV > minHV ? ((hv30 - minHV) / (maxHV - minHV)) * 100 : 50;

    // Average daily move
    const avgDailyMove =
      returns.slice(-30).reduce((s, r) => s + Math.abs(r), 0) / 30 * 100;

    const data: VolatilityData = {
      hv30,
      hv60,
      ivRank: Math.round(Math.max(0, Math.min(100, ivRank))),
      avgDailyMove,
    };

    volCache.set(symbol, { data, expiry: Date.now() + VOL_CACHE_TTL });
    log.info(
      `Yahoo volatility for ${symbol}: HV30=${(hv30 * 100).toFixed(1)}%, ` +
      `HV60=${(hv60 * 100).toFixed(1)}%, IV Rank≈${data.ivRank}`
    );
    return data;
  } catch (err) {
    log.error(`Yahoo volatility fetch failed for ${symbol}`, { error: String(err) });
    return null;
  }
}

/**
 * Get everything we need for analysis in one call.
 */
export async function getMarketSnapshot(symbol: string): Promise<{
  price: number;
  ivRank: number;
  hv30: number;
  changePct: number;
  volume: number;
} | null> {
  const [quote, vol] = await Promise.all([
    getYahooQuote(symbol),
    getVolatilityData(symbol),
  ]);

  if (!quote) return null;

  return {
    price: quote.price,
    ivRank: vol?.ivRank ?? 50,
    hv30: vol?.hv30 ?? 0.3,
    changePct: quote.changePct,
    volume: quote.volume,
  };
}

// ── Utility ─────────────────────────────────────────────────

function stdDev(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const sqDiffs = values.map((v) => (v - mean) ** 2);
  return Math.sqrt(sqDiffs.reduce((s, v) => s + v, 0) / (values.length - 1));
}
