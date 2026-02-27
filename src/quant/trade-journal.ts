/**
 * Trade Journal & Performance Tracker
 *
 * Records every trade recommendation and outcome:
 *   - Trade entry/exit details
 *   - Win/loss tracking by strategy type
 *   - Rolling win rate and average P&L
 *   - Dynamic weight adjustment based on historical performance
 *   - Trade history persistence to disk
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { agentLogger } from "../utils/logger.js";

const log = agentLogger("trade-journal");
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const JOURNAL_PATH = path.join(__dirname, "..", "..", "data", "trade-journal.json");

// ─── Interfaces ─────────────────────────────────────────

export interface TradeRecord {
  id: string;
  symbol: string;
  strategyType: string;
  strategyName: string;
  entryDate: string;
  exitDate?: string;
  entryPrice: number; // net debit/credit per contract
  exitPrice?: number;
  quantity: number;
  maxProfit: number;
  maxLoss: number;
  actualPnL?: number;
  pnlPct?: number; // P&L as % of max risk
  pop?: number; // estimated POP at entry
  ivRank?: number; // IV rank at entry
  technicalTrend?: string; // trend at entry
  score?: number; // strategy score at entry
  outcome?: "win" | "loss" | "breakeven" | "open";
  notes?: string;
}

export interface StrategyPerformance {
  strategyType: string;
  totalTrades: number;
  wins: number;
  losses: number;
  breakevens: number;
  winRate: number;
  avgPnL: number;
  totalPnL: number;
  avgHoldingDays: number;
  bestTrade: number;
  worstTrade: number;
  /** Dynamic score adjustment based on historical performance (-10 to +10) */
  scoreAdjustment: number;
}

export interface JournalSummary {
  totalTrades: number;
  openTrades: number;
  closedTrades: number;
  overallWinRate: number;
  totalPnL: number;
  avgPnLPerTrade: number;
  byStrategy: StrategyPerformance[];
  recentTrades: TradeRecord[];
}

interface JournalData {
  trades: TradeRecord[];
  version: number;
}

// ─── Journal State ──────────────────────────────────────

let journal: JournalData = { trades: [], version: 1 };
let loaded = false;

// ─── Persistence ────────────────────────────────────────

function ensureDataDir(): void {
  const dataDir = path.dirname(JOURNAL_PATH);
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }
}

export function loadJournal(): JournalData {
  if (loaded) return journal;
  try {
    if (existsSync(JOURNAL_PATH)) {
      const raw = readFileSync(JOURNAL_PATH, "utf-8");
      journal = JSON.parse(raw) as JournalData;
      log.info(`Trade journal loaded: ${journal.trades.length} records`);
    }
  } catch (err) {
    log.warn(`Failed to load trade journal: ${err}`);
    journal = { trades: [], version: 1 };
  }
  loaded = true;
  return journal;
}

function saveJournal(): void {
  try {
    ensureDataDir();
    writeFileSync(JOURNAL_PATH, JSON.stringify(journal, null, 2));
  } catch (err) {
    log.error(`Failed to save trade journal: ${err}`);
  }
}

// ─── Core Functions ─────────────────────────────────────

/**
 * Record a new trade entry.
 */
export function recordTradeEntry(trade: Omit<TradeRecord, "id" | "outcome">): TradeRecord {
  loadJournal();

  const record: TradeRecord = {
    ...trade,
    id: `trade-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    outcome: "open",
  };

  journal.trades.push(record);
  saveJournal();
  log.info(`Trade recorded: ${record.id} — ${record.strategyName} (${record.symbol})`);
  return record;
}

/**
 * Record a trade exit/close.
 */
export function recordTradeExit(
  tradeId: string,
  exitPrice: number,
  exitDate?: string
): TradeRecord | null {
  loadJournal();

  const trade = journal.trades.find((t) => t.id === tradeId);
  if (!trade) {
    log.warn(`Trade not found: ${tradeId}`);
    return null;
  }

  trade.exitDate = exitDate || new Date().toISOString().split("T")[0];
  trade.exitPrice = exitPrice;

  // Calculate P&L
  // For credit strategies (negative netDebit): profit = entryPrice - exitPrice
  // For debit strategies (positive netDebit): profit = exitPrice - entryPrice
  const isCredit = trade.entryPrice < 0;
  if (isCredit) {
    trade.actualPnL = (Math.abs(trade.entryPrice) - exitPrice) * trade.quantity * 100;
  } else {
    trade.actualPnL = (exitPrice - trade.entryPrice) * trade.quantity * 100;
  }

  const maxRisk = Math.abs(trade.maxLoss) || 1;
  trade.pnlPct = (trade.actualPnL / maxRisk) * 100;

  // Determine outcome
  if (trade.actualPnL > 0) {
    trade.outcome = "win";
  } else if (trade.actualPnL < -1) { // small tolerance for breakeven
    trade.outcome = "loss";
  } else {
    trade.outcome = "breakeven";
  }

  saveJournal();
  log.info(`Trade closed: ${tradeId} — ${trade.outcome} ($${trade.actualPnL?.toFixed(2)})`);
  return trade;
}

/**
 * Get performance stats by strategy type.
 */
export function getStrategyPerformance(strategyType?: string): StrategyPerformance[] {
  loadJournal();

  const closedTrades = journal.trades.filter(
    (t) => t.outcome && t.outcome !== "open" && (!strategyType || t.strategyType === strategyType)
  );

  // Group by strategy type
  const byType = new Map<string, TradeRecord[]>();
  for (const trade of closedTrades) {
    const type = trade.strategyType;
    if (!byType.has(type)) byType.set(type, []);
    byType.get(type)!.push(trade);
  }

  const results: StrategyPerformance[] = [];

  for (const [type, trades] of byType) {
    const wins = trades.filter((t) => t.outcome === "win").length;
    const losses = trades.filter((t) => t.outcome === "loss").length;
    const breakevens = trades.filter((t) => t.outcome === "breakeven").length;
    const totalPnL = trades.reduce((sum, t) => sum + (t.actualPnL || 0), 0);
    const avgPnL = trades.length > 0 ? totalPnL / trades.length : 0;

    // Average holding days
    const holdingDays = trades
      .filter((t) => t.entryDate && t.exitDate)
      .map((t) => {
        const entry = new Date(t.entryDate).getTime();
        const exit = new Date(t.exitDate!).getTime();
        return Math.round((exit - entry) / (1000 * 60 * 60 * 24));
      });
    const avgHoldingDays = holdingDays.length > 0
      ? holdingDays.reduce((a, b) => a + b, 0) / holdingDays.length
      : 0;

    const pnls = trades.map((t) => t.actualPnL || 0);
    const winRate = trades.length > 0 ? wins / trades.length : 0;

    // Dynamic score adjustment: boost winning strategies, penalize losers
    // Based on last 20 trades (rolling window)
    const recentTrades = trades.slice(-20);
    const recentWinRate = recentTrades.length > 0
      ? recentTrades.filter((t) => t.outcome === "win").length / recentTrades.length
      : 0.5;
    // Score adjustment: -10 to +10 based on performance
    const scoreAdjustment = recentTrades.length >= 5
      ? Math.round((recentWinRate - 0.5) * 20)
      : 0; // Need at least 5 trades for meaningful adjustment

    results.push({
      strategyType: type,
      totalTrades: trades.length,
      wins,
      losses,
      breakevens,
      winRate: Math.round(winRate * 1000) / 10, // e.g., 65.5%
      avgPnL: Math.round(avgPnL * 100) / 100,
      totalPnL: Math.round(totalPnL * 100) / 100,
      avgHoldingDays: Math.round(avgHoldingDays * 10) / 10,
      bestTrade: pnls.length > 0 ? Math.max(...pnls) : 0,
      worstTrade: pnls.length > 0 ? Math.min(...pnls) : 0,
      scoreAdjustment,
    });
  }

  return results.sort((a, b) => b.winRate - a.winRate);
}

/**
 * Get full journal summary.
 */
export function getJournalSummary(): JournalSummary {
  loadJournal();

  const openTrades = journal.trades.filter((t) => t.outcome === "open");
  const closedTrades = journal.trades.filter((t) => t.outcome && t.outcome !== "open");

  const totalPnL = closedTrades.reduce((sum, t) => sum + (t.actualPnL || 0), 0);
  const wins = closedTrades.filter((t) => t.outcome === "win").length;
  const overallWinRate = closedTrades.length > 0 ? wins / closedTrades.length : 0;

  return {
    totalTrades: journal.trades.length,
    openTrades: openTrades.length,
    closedTrades: closedTrades.length,
    overallWinRate: Math.round(overallWinRate * 1000) / 10,
    totalPnL: Math.round(totalPnL * 100) / 100,
    avgPnLPerTrade: closedTrades.length > 0 ? Math.round((totalPnL / closedTrades.length) * 100) / 100 : 0,
    byStrategy: getStrategyPerformance(),
    recentTrades: journal.trades.slice(-10).reverse(),
  };
}

/**
 * Get dynamic weight adjustment for a strategy type based on historical performance.
 * Returns a score modifier (-10 to +10) to apply to the strategy scoring.
 */
export function getDynamicScoreAdjustment(strategyType: string): number {
  const perf = getStrategyPerformance(strategyType);
  const match = perf.find((p) => p.strategyType === strategyType);
  return match?.scoreAdjustment ?? 0;
}

/**
 * Get all open trades.
 */
export function getOpenTrades(): TradeRecord[] {
  loadJournal();
  return journal.trades.filter((t) => t.outcome === "open");
}

/**
 * Get all trades for a specific symbol.
 */
export function getTradesBySymbol(symbol: string): TradeRecord[] {
  loadJournal();
  return journal.trades.filter((t) => t.symbol === symbol);
}
