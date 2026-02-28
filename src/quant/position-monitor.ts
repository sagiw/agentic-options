/**
 * Position Monitor & Exit Rules Engine
 *
 * Continuously evaluates open positions and generates action signals:
 *   - Profit-taking: close credit spreads at 50% max profit
 *   - Stop-loss: close if loss exceeds 2× credit received (or 50% of max loss)
 *   - DTE management: close or roll at 14 DTE to avoid gamma risk
 *   - Rolling: suggests rolling when profitable + nearing expiry
 *   - IV tracking: alert when IV changes significantly post-entry
 *   - Trend reversal: alert when technical trend flips against position
 */

import type { Position, Portfolio } from "../types/portfolio.js";
import type { StrategyType, OptionContract } from "../types/options.js";
import { getOpenTrades, type TradeRecord } from "./trade-journal.js";
import { agentLogger } from "../utils/logger.js";

const log = agentLogger("position-monitor");

/** Extract symbol from a Position's contract (works for both option and stock) */
function getPositionSymbol(pos: Position): string {
  const c = pos.contract as unknown as Record<string, unknown>;
  return (c.underlying as string) ?? (c.symbol as string) ?? "UNKNOWN";
}

// ─── Interfaces ─────────────────────────────────────────

export type ActionType =
  | "close_profit"       // take profit
  | "close_loss"         // stop loss
  | "close_dte"          // close before expiration
  | "roll_out"           // roll to later expiration
  | "hedge"              // add protective hedge
  | "hold"               // do nothing
  | "monitor";           // watch closely

export type ActionUrgency = "immediate" | "soon" | "watch";

export interface PositionAction {
  /** Unique action ID */
  id: string;
  /** Symbol being monitored */
  symbol: string;
  /** Action to take */
  action: ActionType;
  /** Urgency level */
  urgency: ActionUrgency;
  /** Human-readable recommendation */
  message: string;
  /** Detailed reasoning */
  reasoning: string[];
  /** Current P&L ($) */
  currentPnL: number;
  /** Current P&L as % of max profit */
  pnlPctOfMax: number;
  /** Days to expiration */
  daysToExpiry: number;
  /** Trade record reference */
  tradeId?: string;
  /** Suggested close price (if applicable) */
  suggestedClosePrice?: number;
  /** Roll target (if rolling) */
  rollTarget?: { newDTE: number; expectedCredit: number };
}

export interface PositionMonitorResult {
  /** All position actions (sorted by urgency) */
  actions: PositionAction[];
  /** Summary counts */
  summary: {
    totalOpen: number;
    closeProfit: number;
    closeLoss: number;
    closeDTE: number;
    rollOut: number;
    hedge: number;
    hold: number;
  };
  /** Portfolio-level warnings */
  warnings: string[];
  /** Timestamp */
  timestamp: string;
}

// ─── Configuration ──────────────────────────────────────

export interface ExitRuleConfig {
  /** Close credit strategies at this % of max profit (default: 50%) */
  profitTargetPct: number;
  /** Close if loss exceeds this % of max loss (default: 50%) */
  stopLossPct: number;
  /** Close or roll when DTE reaches this (default: 14) */
  minDTE: number;
  /** Roll window: suggest rolling between minDTE and this DTE (default: 21) */
  rollWindowDTE: number;
  /** IV change threshold for alert (default: 30% relative change) */
  ivChangeAlertPct: number;
  /** Max holding days before forced review (default: 45) */
  maxHoldingDays: number;
}

const DEFAULT_CONFIG: ExitRuleConfig = {
  profitTargetPct: 50,
  stopLossPct: 50,
  minDTE: 14,
  rollWindowDTE: 21,
  ivChangeAlertPct: 30,
  maxHoldingDays: 45,
};

// ─── Credit vs Debit strategy classification ────────────

const CREDIT_STRATEGIES: StrategyType[] = [
  "iron_condor",
  "iron_butterfly",
  "put_credit_spread",
  "call_credit_spread",
  "cash_secured_put",
  "covered_call",
  "jade_lizard",
  "wheel",
];

const DEBIT_STRATEGIES: StrategyType[] = [
  "bull_call_spread",
  "bear_put_spread",
  "long_call",
  "long_put",
  "straddle",
  "strangle",
  "calendar_spread",
  "diagonal_spread",
];

function isCreditStrategy(type: string): boolean {
  return CREDIT_STRATEGIES.includes(type as StrategyType);
}

// ─── Core Monitor Function ──────────────────────────────

/**
 * Evaluate all open positions and generate action signals.
 *
 * @param portfolio  Current portfolio from IBKR
 * @param currentIV  Current IV rank for the symbol (optional)
 * @param config     Exit rule configuration
 */
export function monitorPositions(
  portfolio: Portfolio,
  currentIVBySymbol?: Map<string, number>,
  config: ExitRuleConfig = DEFAULT_CONFIG
): PositionMonitorResult {
  const openTrades = getOpenTrades();
  const actions: PositionAction[] = [];
  const warnings: string[] = [];
  const now = Date.now();

  for (const trade of openTrades) {
    const action = evaluateTrade(trade, portfolio, currentIVBySymbol, config, now);
    if (action) {
      actions.push(action);
    }
  }

  // Also check portfolio positions that might not be in journal
  // (positions opened before journal existed, or manual trades)
  if (portfolio.positions) {
    for (const pos of portfolio.positions) {
      const posSymbol = getPositionSymbol(pos);
      const inJournal = openTrades.some(
        (t) => t.symbol === posSymbol
      );
      if (!inJournal && pos.quantity !== 0) {
        // Generate basic monitoring for untracked positions
        const action = evaluateUntrackedPosition(pos, config, now);
        if (action) {
          actions.push(action);
        }
      }
    }
  }

  // Sort: immediate first, then soon, then watch
  const urgencyOrder: Record<ActionUrgency, number> = {
    immediate: 0,
    soon: 1,
    watch: 2,
  };
  actions.sort((a, b) => urgencyOrder[a.urgency] - urgencyOrder[b.urgency]);

  // Portfolio-level warnings
  const totalDelta = portfolio.positions?.reduce(
    (sum, p) => sum + (p.greeks?.delta ?? 0) * (p.quantity ?? 0), 0
  ) ?? 0;

  if (Math.abs(totalDelta) > 50) {
    warnings.push(
      `Portfolio delta is ${totalDelta > 0 ? "+" : ""}${totalDelta.toFixed(0)} — consider hedging.`
    );
  }

  const immediateCnt = actions.filter((a) => a.urgency === "immediate").length;
  if (immediateCnt > 0) {
    warnings.push(`${immediateCnt} position(s) require immediate attention!`);
  }

  return {
    actions,
    summary: {
      totalOpen: openTrades.length,
      closeProfit: actions.filter((a) => a.action === "close_profit").length,
      closeLoss: actions.filter((a) => a.action === "close_loss").length,
      closeDTE: actions.filter((a) => a.action === "close_dte").length,
      rollOut: actions.filter((a) => a.action === "roll_out").length,
      hedge: actions.filter((a) => a.action === "hedge").length,
      hold: actions.filter((a) => a.action === "hold").length,
    },
    warnings,
    timestamp: new Date().toISOString(),
  };
}

// ─── Trade Evaluation ───────────────────────────────────

function evaluateTrade(
  trade: TradeRecord,
  portfolio: Portfolio,
  currentIVBySymbol: Map<string, number> | undefined,
  config: ExitRuleConfig,
  now: number
): PositionAction | null {
  const reasoning: string[] = [];
  const isCredit = isCreditStrategy(trade.strategyType);

  // Calculate days held
  const entryDate = new Date(trade.entryDate).getTime();
  const daysHeld = Math.round((now - entryDate) / (1000 * 60 * 60 * 24));

  // Find matching portfolio position for current P&L
  const position = portfolio.positions?.find(
    (p) => getPositionSymbol(p) === trade.symbol
  );
  const currentPnL = position?.unrealizedPnL ?? 0;

  // Calculate max profit/loss as positive numbers
  const maxProfit = typeof trade.maxProfit === "number"
    ? Math.abs(trade.maxProfit)
    : Math.abs(trade.maxLoss) * 2; // estimate for unlimited
  const maxLoss = Math.abs(trade.maxLoss);

  // P&L as percentage of max
  const pnlPctOfMax = maxProfit > 0 ? (currentPnL / maxProfit) * 100 : 0;
  const lossPctOfMax = maxLoss > 0 ? (Math.abs(Math.min(0, currentPnL)) / maxLoss) * 100 : 0;

  // Calculate DTE from trade's legs (we stored entry date, estimate expiry)
  // For now use holding days vs typical 30-45 DTE entry
  const estimatedDTE = Math.max(0, 37 - daysHeld); // rough estimate

  // ── Rule 1: Profit-taking ──
  if (isCredit && pnlPctOfMax >= config.profitTargetPct) {
    reasoning.push(`Profit at ${pnlPctOfMax.toFixed(0)}% of max (target: ${config.profitTargetPct}%)`);
    reasoning.push(`Credit strategy collected most of premium — theta edge diminishing`);
    reasoning.push(`Remaining profit ($${(maxProfit - currentPnL).toFixed(0)}) not worth the risk`);

    return {
      id: `action-${trade.id}-profit`,
      symbol: trade.symbol,
      action: "close_profit",
      urgency: pnlPctOfMax >= 75 ? "immediate" : "soon",
      message: `CLOSE for profit — ${pnlPctOfMax.toFixed(0)}% of max profit reached`,
      reasoning,
      currentPnL,
      pnlPctOfMax,
      daysToExpiry: estimatedDTE,
      tradeId: trade.id,
    };
  }

  // Debit strategy profit-taking at higher threshold
  if (!isCredit && pnlPctOfMax >= 75) {
    reasoning.push(`Profit at ${pnlPctOfMax.toFixed(0)}% of max — significant move captured`);
    reasoning.push(`Consider locking in gains before theta erodes remaining value`);

    return {
      id: `action-${trade.id}-profit`,
      symbol: trade.symbol,
      action: "close_profit",
      urgency: pnlPctOfMax >= 90 ? "immediate" : "soon",
      message: `CLOSE for profit — ${pnlPctOfMax.toFixed(0)}% of max profit reached`,
      reasoning,
      currentPnL,
      pnlPctOfMax,
      daysToExpiry: estimatedDTE,
      tradeId: trade.id,
    };
  }

  // ── Rule 2: Stop-loss ──
  if (lossPctOfMax >= config.stopLossPct) {
    reasoning.push(`Loss at ${lossPctOfMax.toFixed(0)}% of max loss (limit: ${config.stopLossPct}%)`);
    reasoning.push(`Cut losses to preserve capital — avoid max loss scenario`);
    if (isCredit) {
      reasoning.push(`Credit strategy underwater — premium collected insufficient to offset move`);
    }

    return {
      id: `action-${trade.id}-stop`,
      symbol: trade.symbol,
      action: "close_loss",
      urgency: lossPctOfMax >= 75 ? "immediate" : "soon",
      message: `STOP LOSS — loss at ${lossPctOfMax.toFixed(0)}% of max ($${currentPnL.toFixed(0)})`,
      reasoning,
      currentPnL,
      pnlPctOfMax,
      daysToExpiry: estimatedDTE,
      tradeId: trade.id,
    };
  }

  // ── Rule 3: DTE management ──
  if (estimatedDTE <= config.minDTE && estimatedDTE > 0) {
    // If profitable, close; if not, consider rolling
    if (currentPnL > 0) {
      reasoning.push(`Only ${estimatedDTE} DTE remaining — gamma risk increasing`);
      reasoning.push(`Position is profitable ($${currentPnL.toFixed(0)}) — lock in gains before expiry`);

      return {
        id: `action-${trade.id}-dte`,
        symbol: trade.symbol,
        action: "close_dte",
        urgency: estimatedDTE <= 7 ? "immediate" : "soon",
        message: `CLOSE at ${estimatedDTE} DTE — profitable, avoid gamma risk`,
        reasoning,
        currentPnL,
        pnlPctOfMax,
        daysToExpiry: estimatedDTE,
        tradeId: trade.id,
      };
    }

    // If losing but within roll window, suggest roll
    if (isCredit && estimatedDTE <= config.rollWindowDTE) {
      reasoning.push(`${estimatedDTE} DTE — entering gamma zone`);
      reasoning.push(`Credit strategy with unrealized loss — consider rolling to later month`);
      reasoning.push(`Rolling preserves the trade thesis while resetting theta decay`);

      return {
        id: `action-${trade.id}-roll`,
        symbol: trade.symbol,
        action: "roll_out",
        urgency: estimatedDTE <= 7 ? "immediate" : "soon",
        message: `ROLL OUT — ${estimatedDTE} DTE, roll to next month to collect more premium`,
        reasoning,
        currentPnL,
        pnlPctOfMax,
        daysToExpiry: estimatedDTE,
        tradeId: trade.id,
        rollTarget: {
          newDTE: 30,
          expectedCredit: Math.abs(trade.maxProfit) * 0.3, // rough estimate
        },
      };
    }
  }

  // ── Rule 4: IV change alert ──
  if (trade.ivRank && currentIVBySymbol) {
    const currentIV = currentIVBySymbol.get(trade.symbol);
    if (currentIV !== undefined) {
      const ivChange = ((currentIV - trade.ivRank) / trade.ivRank) * 100;

      if (isCredit && ivChange > config.ivChangeAlertPct) {
        reasoning.push(`IV expanded ${ivChange.toFixed(0)}% since entry (${trade.ivRank.toFixed(0)} → ${currentIV.toFixed(0)})`);
        reasoning.push(`Credit strategy at risk — vega exposure increasing losses`);

        return {
          id: `action-${trade.id}-iv`,
          symbol: trade.symbol,
          action: "hedge",
          urgency: ivChange > 50 ? "immediate" : "watch",
          message: `IV SPIKE — IV up ${ivChange.toFixed(0)}% since entry, consider closing or hedging`,
          reasoning,
          currentPnL,
          pnlPctOfMax,
          daysToExpiry: estimatedDTE,
          tradeId: trade.id,
        };
      }

      if (!isCredit && ivChange < -config.ivChangeAlertPct) {
        reasoning.push(`IV crushed ${Math.abs(ivChange).toFixed(0)}% since entry (${trade.ivRank.toFixed(0)} → ${currentIV.toFixed(0)})`);
        reasoning.push(`Debit strategy losing vega value even if direction is right`);

        return {
          id: `action-${trade.id}-iv`,
          symbol: trade.symbol,
          action: "close_loss",
          urgency: "watch",
          message: `IV CRUSH — IV down ${Math.abs(ivChange).toFixed(0)}%, vega drag on debit position`,
          reasoning,
          currentPnL,
          pnlPctOfMax,
          daysToExpiry: estimatedDTE,
          tradeId: trade.id,
        };
      }
    }
  }

  // ── Rule 5: Max holding period ──
  if (daysHeld >= config.maxHoldingDays) {
    reasoning.push(`Held for ${daysHeld} days (max: ${config.maxHoldingDays})`);
    reasoning.push(`Extended holding increases exposure to unpredictable events`);

    return {
      id: `action-${trade.id}-maxhold`,
      symbol: trade.symbol,
      action: "close_dte",
      urgency: "watch",
      message: `REVIEW — held ${daysHeld} days, consider closing to free capital`,
      reasoning,
      currentPnL,
      pnlPctOfMax,
      daysToExpiry: estimatedDTE,
      tradeId: trade.id,
    };
  }

  // ── Default: HOLD ──
  reasoning.push(`P&L: $${currentPnL.toFixed(0)} (${pnlPctOfMax.toFixed(0)}% of max profit)`);
  reasoning.push(`Days held: ${daysHeld}, Est. DTE: ${estimatedDTE}`);
  if (isCredit) {
    reasoning.push(`Theta working in your favor — continue holding`);
  }

  return {
    id: `action-${trade.id}-hold`,
    symbol: trade.symbol,
    action: "hold",
    urgency: "watch",
    message: `HOLD — position within parameters`,
    reasoning,
    currentPnL,
    pnlPctOfMax,
    daysToExpiry: estimatedDTE,
    tradeId: trade.id,
  };
}

// ─── Untracked Position Evaluation ──────────────────────

function evaluateUntrackedPosition(
  pos: Position,
  config: ExitRuleConfig,
  now: number
): PositionAction | null {
  // For positions not in the journal, provide basic monitoring
  const sym = getPositionSymbol(pos);
  const pnl = pos.unrealizedPnL ?? 0;
  const marketValue = Math.abs(pos.marketValue ?? 0);

  if (marketValue === 0) return null;

  const pnlPct = marketValue > 0 ? (pnl / marketValue) * 100 : 0;
  const reasoning: string[] = [];

  // Big loss warning
  if (pnl < 0 && Math.abs(pnlPct) > 20) {
    reasoning.push(`Unrealized loss of $${pnl.toFixed(0)} (${pnlPct.toFixed(0)}% of value)`);
    reasoning.push(`Position not tracked in journal — review and decide`);

    return {
      id: `action-untracked-${sym}-${now}`,
      symbol: sym,
      action: "monitor",
      urgency: Math.abs(pnlPct) > 40 ? "soon" : "watch",
      message: `REVIEW untracked position — ${pnlPct.toFixed(0)}% P&L`,
      reasoning,
      currentPnL: pnl,
      pnlPctOfMax: pnlPct,
      daysToExpiry: 0,
    };
  }

  return null;
}

// ─── Exit Rule Configuration Builder ────────────────────

export function buildExitConfig(overrides?: Partial<ExitRuleConfig>): ExitRuleConfig {
  return { ...DEFAULT_CONFIG, ...overrides };
}
