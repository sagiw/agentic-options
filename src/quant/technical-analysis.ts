/**
 * Technical Analysis Module
 *
 * Computes technical indicators from daily closing prices:
 * - RSI(14), SMA(20/50/200), MACD(12,26,9), Bollinger Bands
 * - Support/Resistance detection from local pivots
 * - Trend direction & strength
 * - Technical alignment scoring for strategy selection
 */

import type { StrategyType } from "../types/options.js";

// ─── Interfaces ────────────────────────────────────────────

export interface TechnicalAnalysis {
  rsi14: number;
  sma20: number;
  sma50: number;
  sma200: number;
  macd: number;
  macdSignal: number;
  macdHistogram: number;
  bollingerUpper: number;
  bollingerLower: number;
  bollingerMid: number;
  currentPrice: number;
  trend: "bullish" | "bearish" | "neutral";
  trendStrength: number; // 0-100
  supports: number[];
  resistances: number[];
  signals: TechnicalSignal[];
}

export interface TechnicalSignal {
  name: string;
  direction: "bullish" | "bearish" | "neutral";
  value: string; // human-readable value
  reasoning: string;
}

export interface TrendAnalysis {
  direction: "bullish" | "bearish" | "neutral";
  strength: number; // 0-100
  reasoning: string;
}

// ─── Helper: Simple Moving Average ─────────────────────────

function sma(data: number[], period: number): number {
  if (data.length < period) return data[data.length - 1] || 0;
  const slice = data.slice(-period);
  return slice.reduce((s, v) => s + v, 0) / period;
}

// ─── Helper: Exponential Moving Average ────────────────────

function ema(data: number[], period: number): number[] {
  if (data.length === 0) return [];
  const k = 2 / (period + 1);
  const result: number[] = [data[0]];
  for (let i = 1; i < data.length; i++) {
    result.push(data[i] * k + result[i - 1] * (1 - k));
  }
  return result;
}

// ─── Helper: RSI (Wilder's Smoothed) ───────────────────────

function computeRSI(closes: number[], period: number = 14): number {
  if (closes.length < period + 1) return 50; // neutral default

  const changes: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    changes.push(closes[i] - closes[i - 1]);
  }

  // Initial average gain/loss
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 0; i < period; i++) {
    if (changes[i] >= 0) avgGain += changes[i];
    else avgLoss += Math.abs(changes[i]);
  }
  avgGain /= period;
  avgLoss /= period;

  // Wilder's smoothing for remaining periods
  for (let i = period; i < changes.length; i++) {
    const change = changes[i];
    avgGain = (avgGain * (period - 1) + (change >= 0 ? change : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (change < 0 ? Math.abs(change) : 0)) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

// ─── Helper: MACD ──────────────────────────────────────────

function computeMACD(closes: number[]): {
  macd: number;
  signal: number;
  histogram: number;
} {
  if (closes.length < 35) return { macd: 0, signal: 0, histogram: 0 };

  const ema12 = ema(closes, 12);
  const ema26 = ema(closes, 26);

  // MACD line = EMA12 - EMA26
  const macdLine: number[] = [];
  for (let i = 0; i < closes.length; i++) {
    macdLine.push(ema12[i] - ema26[i]);
  }

  // Signal line = EMA9 of MACD line
  const signalLine = ema(macdLine, 9);

  const lastIdx = closes.length - 1;
  const macdVal = macdLine[lastIdx];
  const signalVal = signalLine[lastIdx];

  return {
    macd: macdVal,
    signal: signalVal,
    histogram: macdVal - signalVal,
  };
}

// ─── Helper: Bollinger Bands ───────────────────────────────

function computeBollingerBands(
  closes: number[],
  period: number = 20,
  multiplier: number = 2
): { upper: number; lower: number; mid: number } {
  if (closes.length < period) {
    const last = closes[closes.length - 1] || 0;
    return { upper: last, lower: last, mid: last };
  }

  const slice = closes.slice(-period);
  const mid = slice.reduce((s, v) => s + v, 0) / period;
  const variance =
    slice.reduce((s, v) => s + (v - mid) ** 2, 0) / period;
  const std = Math.sqrt(variance);

  return {
    upper: mid + multiplier * std,
    lower: mid - multiplier * std,
    mid,
  };
}

// ─── Helper: Support/Resistance Detection ──────────────────

function detectSupportResistance(
  closes: number[],
  lookback: number = 60,
  minDistancePct: number = 0.02
): { supports: number[]; resistances: number[] } {
  const data = closes.slice(-Math.min(lookback, closes.length));
  const currentPrice = data[data.length - 1];
  if (data.length < 10) return { supports: [], resistances: [] };

  const pivots: { price: number; type: "high" | "low" }[] = [];
  const windowSize = 5;

  // Find local highs and lows
  for (let i = windowSize; i < data.length - windowSize; i++) {
    let isHigh = true;
    let isLow = true;

    for (let j = i - windowSize; j <= i + windowSize; j++) {
      if (j === i) continue;
      if (data[j] >= data[i]) isHigh = false;
      if (data[j] <= data[i]) isLow = false;
    }

    if (isHigh) pivots.push({ price: data[i], type: "high" });
    if (isLow) pivots.push({ price: data[i], type: "low" });
  }

  // Cluster nearby levels
  const cluster = (
    levels: number[],
    threshold: number
  ): number[] => {
    if (levels.length === 0) return [];
    const sorted = [...levels].sort((a, b) => a - b);
    const clusters: number[][] = [[sorted[0]]];

    for (let i = 1; i < sorted.length; i++) {
      const lastCluster = clusters[clusters.length - 1];
      const lastAvg =
        lastCluster.reduce((s, v) => s + v, 0) / lastCluster.length;
      if (Math.abs(sorted[i] - lastAvg) / lastAvg < threshold) {
        lastCluster.push(sorted[i]);
      } else {
        clusters.push([sorted[i]]);
      }
    }

    return clusters.map(
      (c) => Math.round((c.reduce((s, v) => s + v, 0) / c.length) * 100) / 100
    );
  };

  const highPrices = pivots.filter((p) => p.type === "high").map((p) => p.price);
  const lowPrices = pivots.filter((p) => p.type === "low").map((p) => p.price);

  const allResistances = cluster(highPrices, minDistancePct);
  const allSupports = cluster(lowPrices, minDistancePct);

  // Keep only levels near current price (within 15%)
  const supports = allSupports
    .filter((s) => s < currentPrice && s > currentPrice * 0.85)
    .sort((a, b) => b - a) // closest first
    .slice(0, 3);

  const resistances = allResistances
    .filter((r) => r > currentPrice && r < currentPrice * 1.15)
    .sort((a, b) => a - b) // closest first
    .slice(0, 3);

  return { supports, resistances };
}

// ─── Main: Compute All Technical Indicators ────────────────

export function computeTechnicalAnalysis(
  closes: number[]
): TechnicalAnalysis | null {
  if (!closes || closes.length < 60) return null;

  const currentPrice = closes[closes.length - 1];
  const rsi14 = computeRSI(closes, 14);
  const sma20Val = sma(closes, 20);
  const sma50Val = sma(closes, 50);
  const sma200Val = closes.length >= 200 ? sma(closes, 200) : sma50Val;
  const macdResult = computeMACD(closes);
  const bb = computeBollingerBands(closes, 20, 2);
  const { supports, resistances } = detectSupportResistance(closes);

  // ── Build signals ──
  const signals: TechnicalSignal[] = [];

  // 1. Price vs SMA50
  const aboveSMA50 = currentPrice > sma50Val;
  signals.push({
    name: "Price vs SMA(50)",
    direction: aboveSMA50 ? "bullish" : "bearish",
    value: `$${currentPrice.toFixed(2)} ${aboveSMA50 ? ">" : "<"} $${sma50Val.toFixed(2)}`,
    reasoning: aboveSMA50
      ? "Price above 50-day average — uptrend"
      : "Price below 50-day average — downtrend",
  });

  // 2. SMA20 vs SMA50 (golden/death cross)
  const sma20Above50 = sma20Val > sma50Val;
  signals.push({
    name: "SMA(20) vs SMA(50)",
    direction: sma20Above50 ? "bullish" : "bearish",
    value: `$${sma20Val.toFixed(2)} ${sma20Above50 ? ">" : "<"} $${sma50Val.toFixed(2)}`,
    reasoning: sma20Above50
      ? "Short-term MA above long-term — bullish crossover"
      : "Short-term MA below long-term — bearish crossover",
  });

  // 3. RSI
  const rsiDir: "bullish" | "bearish" | "neutral" =
    rsi14 > 60 ? "bullish" : rsi14 < 40 ? "bearish" : "neutral";
  signals.push({
    name: "RSI(14)",
    direction: rsiDir,
    value: rsi14.toFixed(1),
    reasoning:
      rsi14 > 70
        ? "Overbought (>70) — potential reversal down"
        : rsi14 < 30
          ? "Oversold (<30) — potential bounce up"
          : rsi14 > 60
            ? "Bullish momentum (>60)"
            : rsi14 < 40
              ? "Bearish momentum (<40)"
              : "Neutral range (40-60)",
  });

  // 4. MACD
  const macdBullish = macdResult.histogram > 0;
  signals.push({
    name: "MACD",
    direction: macdBullish ? "bullish" : "bearish",
    value: `${macdResult.macd.toFixed(3)} (hist: ${macdResult.histogram > 0 ? "+" : ""}${macdResult.histogram.toFixed(3)})`,
    reasoning: macdBullish
      ? "MACD above signal line — bullish momentum"
      : "MACD below signal line — bearish momentum",
  });

  // 5. Bollinger Bands position
  const bbPct = (currentPrice - bb.lower) / (bb.upper - bb.lower);
  const bbDir: "bullish" | "bearish" | "neutral" =
    bbPct > 0.8 ? "bearish" : bbPct < 0.2 ? "bullish" : "neutral";
  signals.push({
    name: "Bollinger Bands",
    direction: bbDir,
    value: `${(bbPct * 100).toFixed(0)}% band position`,
    reasoning:
      bbPct > 0.8
        ? "Near upper band — overbought, may pull back"
        : bbPct < 0.2
          ? "Near lower band — oversold, may bounce"
          : "Mid-range — no strong signal",
  });

  // 6. Price vs SMA200 (long-term trend)
  const aboveSMA200 = currentPrice > sma200Val;
  signals.push({
    name: "Price vs SMA(200)",
    direction: aboveSMA200 ? "bullish" : "bearish",
    value: `$${currentPrice.toFixed(2)} ${aboveSMA200 ? ">" : "<"} $${sma200Val.toFixed(2)}`,
    reasoning: aboveSMA200
      ? "Above 200-day average — long-term uptrend"
      : "Below 200-day average — long-term downtrend",
  });

  // ── Compute trend ──
  const bullishCount = signals.filter((s) => s.direction === "bullish").length;
  const bearishCount = signals.filter((s) => s.direction === "bearish").length;
  const totalSignals = signals.length;
  const bullishPct = (bullishCount / totalSignals) * 100;

  const trend: "bullish" | "bearish" | "neutral" =
    bullishPct >= 60 ? "bullish" : bullishPct <= 40 ? "bearish" : "neutral";
  const trendStrength =
    trend === "bullish"
      ? bullishPct
      : trend === "bearish"
        ? 100 - bullishPct
        : 50;

  return {
    rsi14,
    sma20: sma20Val,
    sma50: sma50Val,
    sma200: sma200Val,
    macd: macdResult.macd,
    macdSignal: macdResult.signal,
    macdHistogram: macdResult.histogram,
    bollingerUpper: bb.upper,
    bollingerLower: bb.lower,
    bollingerMid: bb.mid,
    currentPrice,
    trend,
    trendStrength,
    supports,
    resistances,
    signals,
  };
}

// ─── Trend Analysis with reasoning ─────────────────────────

export function getTrendAnalysis(
  ta: TechnicalAnalysis
): TrendAnalysis {
  const bullishSignals = ta.signals.filter((s) => s.direction === "bullish");
  const bearishSignals = ta.signals.filter((s) => s.direction === "bearish");

  const parts: string[] = [];

  if (ta.trend === "bullish") {
    parts.push(`📈 Bullish trend (${bullishSignals.length}/${ta.signals.length} bullish signals)`);
    bullishSignals.forEach((s) => parts.push(`  • ${s.name}: ${s.reasoning}`));
  } else if (ta.trend === "bearish") {
    parts.push(`📉 Bearish trend (${bearishSignals.length}/${ta.signals.length} bearish signals)`);
    bearishSignals.forEach((s) => parts.push(`  • ${s.name}: ${s.reasoning}`));
  } else {
    parts.push(`➡️ Neutral/Mixed (${bullishSignals.length} bullish, ${bearishSignals.length} bearish)`);
  }

  // RSI extreme warnings
  if (ta.rsi14 > 70) parts.push(`  ⚠️ RSI ${ta.rsi14.toFixed(0)} — overbought`);
  if (ta.rsi14 < 30) parts.push(`  ⚠️ RSI ${ta.rsi14.toFixed(0)} — oversold`);

  // S/R context
  if (ta.supports.length > 0) parts.push(`  Support: $${ta.supports[0].toFixed(2)}`);
  if (ta.resistances.length > 0) parts.push(`  Resistance: $${ta.resistances[0].toFixed(2)}`);

  return {
    direction: ta.trend,
    strength: ta.trendStrength,
    reasoning: parts.join("\n"),
  };
}

// ─── Technical Alignment Score for Strategy Ranking ────────

const BULLISH_STRATEGIES: StrategyType[] = [
  "long_call",
  "bull_call_spread",
  "cash_secured_put",
  "covered_call",
  "wheel",
];

const BEARISH_STRATEGIES: StrategyType[] = [
  "long_put",
  "bear_put_spread",
];

const NEUTRAL_STRATEGIES: StrategyType[] = [
  "iron_condor",
  "iron_butterfly",
  "straddle",
  "strangle",
  "calendar_spread",
  "diagonal_spread",
];

export function isBullishStrategy(type: StrategyType): boolean {
  return BULLISH_STRATEGIES.includes(type);
}

export function isBearishStrategy(type: StrategyType): boolean {
  return BEARISH_STRATEGIES.includes(type);
}

export function isNeutralStrategy(type: StrategyType): boolean {
  return NEUTRAL_STRATEGIES.includes(type);
}

/**
 * Score how well a strategy type aligns with current technical conditions.
 * Returns 0-100 (50 = neutral).
 */
export function getTechnicalAlignmentScore(
  strategyType: StrategyType,
  ta: TechnicalAnalysis | null | undefined,
  currentPrice: number
): number {
  if (!ta) return 50; // neutral if no technical data

  let score = 50; // baseline

  const nearSupport = ta.supports.some(
    (s) => Math.abs(s - currentPrice) / currentPrice < 0.03
  );
  const nearResistance = ta.resistances.some(
    (r) => Math.abs(r - currentPrice) / currentPrice < 0.03
  );

  if (isBullishStrategy(strategyType)) {
    // Trend alignment
    if (ta.trend === "bullish") score += 15;
    else if (ta.trend === "bearish") score -= 12;

    // RSI — oversold is good for bullish
    if (ta.rsi14 < 30) score += 10;
    else if (ta.rsi14 > 70) score -= 8;

    // Near support — bullish bounce expected
    if (nearSupport) score += 8;
    if (nearResistance) score -= 5;

    // Price above short-term MA
    if (currentPrice > ta.sma20) score += 5;

    // MACD bullish
    if (ta.macdHistogram > 0) score += 5;
  } else if (isBearishStrategy(strategyType)) {
    // Trend alignment
    if (ta.trend === "bearish") score += 15;
    else if (ta.trend === "bullish") score -= 12;

    // RSI — overbought is good for bearish
    if (ta.rsi14 > 70) score += 10;
    else if (ta.rsi14 < 30) score -= 8;

    // Near resistance — rejection expected
    if (nearResistance) score += 8;
    if (nearSupport) score -= 5;

    // Price below short-term MA
    if (currentPrice < ta.sma20) score += 5;

    // MACD bearish
    if (ta.macdHistogram < 0) score += 5;
  } else {
    // Neutral strategies — best in range-bound markets
    if (ta.rsi14 >= 40 && ta.rsi14 <= 60) score += 10;
    if (ta.trend === "neutral") score += 10;

    // Good if price is between support and resistance
    if (nearSupport || nearResistance) score -= 5; // near extremes = bad for neutral
    else score += 5; // mid-range = good

    // Low MACD histogram = range-bound
    if (Math.abs(ta.macdHistogram) < 0.5) score += 5;
  }

  return Math.max(0, Math.min(100, score));
}

/**
 * Generate human-readable explanation for why a strategy fits (or doesn't)
 * the current technical conditions.
 */
export function generateTechnicalExplanation(
  strategyType: StrategyType,
  strategyName: string,
  ta: TechnicalAnalysis | null | undefined,
  ivRank: number,
  currentPrice: number
): string {
  if (!ta) return "Technical data unavailable — recommendation based on IV and risk metrics only.";

  const parts: string[] = [];
  const alignScore = getTechnicalAlignmentScore(strategyType, ta, currentPrice);
  const aligned = alignScore >= 60;
  const opposed = alignScore < 40;

  // 1. Trend context
  if (ta.trend === "bullish") {
    parts.push(`📈 Market is in a BULLISH trend (${ta.signals.filter(s => s.direction === "bullish").length}/${ta.signals.length} bullish signals, strength ${ta.trendStrength.toFixed(0)}%).`);
  } else if (ta.trend === "bearish") {
    parts.push(`📉 Market is in a BEARISH trend (${ta.signals.filter(s => s.direction === "bearish").length}/${ta.signals.length} bearish signals, strength ${ta.trendStrength.toFixed(0)}%).`);
  } else {
    parts.push(`➡️ Market trend is NEUTRAL/MIXED — no clear directional bias.`);
  }

  // 2. Key indicator values
  const indicators: string[] = [];
  indicators.push(`RSI(14)=${ta.rsi14.toFixed(0)}`);
  if (ta.rsi14 > 70) indicators[indicators.length - 1] += " (overbought)";
  if (ta.rsi14 < 30) indicators[indicators.length - 1] += " (oversold)";

  indicators.push(`Price ${currentPrice > ta.sma50 ? "above" : "below"} SMA(50) $${ta.sma50.toFixed(2)}`);

  if (ta.macdHistogram > 0) indicators.push("MACD bullish");
  else indicators.push("MACD bearish");

  parts.push(`Indicators: ${indicators.join(" | ")}`);

  // 3. S/R context
  if (ta.supports.length > 0) {
    parts.push(`Support: $${ta.supports.map(s => s.toFixed(2)).join(", $")}`);
  }
  if (ta.resistances.length > 0) {
    parts.push(`Resistance: $${ta.resistances.map(r => r.toFixed(2)).join(", $")}`);
  }

  // 4. Strategy alignment
  if (isBullishStrategy(strategyType)) {
    if (aligned) {
      parts.push(`✅ ${strategyName} aligns with bullish trend — good entry.`);
    } else if (opposed) {
      parts.push(`⚠️ ${strategyName} is bullish but market shows bearish signals — higher risk.`);
    } else {
      parts.push(`⚖️ ${strategyName} — mixed signals, moderate confidence.`);
    }
  } else if (isBearishStrategy(strategyType)) {
    if (aligned) {
      parts.push(`✅ ${strategyName} aligns with bearish trend — good entry.`);
    } else if (opposed) {
      parts.push(`⚠️ ${strategyName} is bearish but market shows bullish signals — higher risk.`);
    } else {
      parts.push(`⚖️ ${strategyName} — mixed signals, moderate confidence.`);
    }
  } else {
    if (ta.trend === "neutral") {
      parts.push(`✅ ${strategyName} fits neutral/range-bound market — ideal setup.`);
    } else {
      parts.push(`⚠️ ${strategyName} is neutral but market is trending ${ta.trend} — watch for breakout.`);
    }
  }

  // 5. IV context
  if (ivRank > 60) {
    parts.push(`IV Rank ${ivRank.toFixed(0)} (high) — favors selling premium.`);
  } else if (ivRank < 30) {
    parts.push(`IV Rank ${ivRank.toFixed(0)} (low) — favors buying options.`);
  }

  return parts.join("\n");
}
