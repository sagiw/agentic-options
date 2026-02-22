/**
 * Market data type definitions.
 * Covers real-time quotes, historical data, and data provider interfaces.
 */

/** Real-time stock quote */
export interface StockQuote {
  symbol: string;
  price: number;
  bid: number;
  ask: number;
  volume: number;
  high: number;
  low: number;
  open: number;
  previousClose: number;
  timestamp: Date;
}

/** Historical price bar */
export interface PriceBar {
  timestamp: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** Historical return for VaR calculation */
export interface HistoricalReturn {
  date: Date;
  return_pct: number; // daily log return
}

/** News sentiment for XAI */
export interface NewsSentiment {
  symbol: string;
  headline: string;
  source: string;
  sentiment: number; // -1 to +1
  relevance: number; // 0 to 1
  publishedAt: Date;
}

/** Earnings event */
export interface EarningsEvent {
  symbol: string;
  date: Date;
  estimated_eps: number;
  actual_eps?: number;
  surprise_pct?: number;
}

/** Sector/market regime */
export type MarketRegime = "bull" | "bear" | "sideways" | "high_vol" | "low_vol";

export interface MarketContext {
  regime: MarketRegime;
  vixLevel: number;
  sp500Change: number;
  sectorRotation: Record<string, number>;
  timestamp: Date;
}
