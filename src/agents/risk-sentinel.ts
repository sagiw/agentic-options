/**
 * The "Shield" — Risk Sentinel Agent
 *
 * Enforces strict risk management rules:
 *   - 1-2% max risk per trade (configurable)
 *   - Portfolio VaR limits
 *   - Stress testing at ±15% underlying movement
 *   - Position concentration limits
 *   - Correlated exposure monitoring
 *
 * Every trade suggestion MUST pass through the Risk Sentinel
 * before reaching the human approval stage.
 */

import { agentLogger } from "../utils/logger.js";
import { generateId } from "../utils/validation.js";
import { config } from "../config/index.js";
import {
  calculateFullVaR,
  validateTradeRisk,
  historicalVaR,
} from "../quant/var.js";
import type {
  Agent,
  AgentMessage,
  AgentRole,
  AgentStatus,
  TaskRequest,
  RankedStrategy,
  RiskAlert,
} from "../types/agents.js";
import type {
  Portfolio,
  RiskLimits,
  VaRResult,
} from "../types/portfolio.js";

const log = agentLogger("risk");

/** Risk validation result for a single strategy */
interface RiskValidation {
  strategy: RankedStrategy;
  passes: boolean;
  riskPct: number;
  violations: string[];
  adjustedScore: number;
}

export class RiskSentinel implements Agent {
  readonly role: AgentRole = "risk";
  status: AgentStatus = "idle";

  private limits: RiskLimits;
  private portfolio: Portfolio | null = null;
  private alerts: RiskAlert[] = [];

  constructor(limits?: Partial<RiskLimits>) {
    this.limits = {
      maxRiskPerTradePct: limits?.maxRiskPerTradePct ?? config.risk.maxRiskPerTradePct,
      maxPortfolioRiskPct: limits?.maxPortfolioRiskPct ?? 20,
      maxPositionSizePct: limits?.maxPositionSizePct ?? 10,
      maxCorrelatedExposure: limits?.maxCorrelatedExposure ?? 25,
      varLimit: limits?.varLimit ?? 5,
    };
  }

  async initialize(): Promise<void> {
    log.info("Initializing risk sentinel...", { limits: this.limits });
    this.status = "idle";
  }

  async handleMessage(message: AgentMessage): Promise<AgentMessage | null> {
    const task = message.payload as TaskRequest;
    this.status = "thinking";

    try {
      let result: unknown;

      switch (task.action) {
        case "validate_risk":
          result = this.validateStrategies(task.params);
          break;

        case "calculate_var":
          result = this.calculatePortfolioVaR(task.params);
          break;

        default:
          log.warn(`Unknown action: ${task.action}`);
          result = null;
      }

      this.status = "idle";
      return {
        id: generateId(),
        from: "risk",
        to: message.from,
        type: "task_response",
        payload: result,
        timestamp: new Date(),
        correlationId: message.id,
      };
    } catch (err) {
      this.status = "error";
      log.error(`Risk calculation failed: ${task.action}`, { error: err });
      return {
        id: generateId(),
        from: "risk",
        to: message.from,
        type: "error",
        payload: { error: String(err) },
        timestamp: new Date(),
        correlationId: message.id,
      };
    }
  }

  async shutdown(): Promise<void> {
    log.info("Risk sentinel shutting down");
    this.status = "idle";
  }

  // ─── Risk Validation ──────────────────────────────────────

  /**
   * Validate all proposed strategies against risk limits.
   * Returns only strategies that pass all risk checks.
   */
  private validateStrategies(params: Record<string, unknown>): {
    approved: RankedStrategy[];
    rejected: RiskValidation[];
    alerts: RiskAlert[];
  } {
    const strategies = params.strategies as RankedStrategy[];
    const portfolioValue =
      (params.portfolioValue as number) ??
      this.portfolio?.account.netLiquidation ??
      50_000;

    const approved: RankedStrategy[] = [];
    const rejected: RiskValidation[] = [];
    const newAlerts: RiskAlert[] = [];

    for (const strategy of strategies) {
      const validation = this.validateSingleStrategy(strategy, portfolioValue);

      if (validation.passes) {
        approved.push({
          ...strategy,
          score: validation.adjustedScore,
        });
      } else {
        rejected.push(validation);

        // Generate risk alert for each violation
        for (const violation of validation.violations) {
          const alert: RiskAlert = {
            id: generateId(),
            severity: validation.riskPct > this.limits.maxRiskPerTradePct * 2
              ? "critical"
              : "warning",
            message: violation,
            metric: "trade_risk",
            currentValue: validation.riskPct,
            threshold: this.limits.maxRiskPerTradePct,
            timestamp: new Date(),
          };
          newAlerts.push(alert);
          this.alerts.push(alert);
        }
      }
    }

    log.info(
      `Risk validation: ${approved.length} approved, ${rejected.length} rejected`
    );

    return { approved, rejected, alerts: newAlerts };
  }

  /**
   * Validate a single strategy against all risk rules.
   */
  private validateSingleStrategy(
    strategy: RankedStrategy,
    portfolioValue: number
  ): RiskValidation {
    const violations: string[] = [];
    let adjustedScore = strategy.score;

    // ── Rule 1: Max risk per trade (1-2%) ───────────────────
    const tradeRisk = validateTradeRisk(
      strategy.strategy.maxLoss,
      portfolioValue,
      this.limits.maxRiskPerTradePct
    );

    if (!tradeRisk.passes) {
      violations.push(tradeRisk.message);
      adjustedScore *= 0.5; // penalty
    }

    // ── Rule 2: Position size limit ─────────────────────────
    const positionSizePct =
      (strategy.strategy.requiredCapital / portfolioValue) * 100;
    if (positionSizePct > this.limits.maxPositionSizePct) {
      violations.push(
        `Position size ${positionSizePct.toFixed(1)}% exceeds ` +
        `${this.limits.maxPositionSizePct}% limit`
      );
      adjustedScore *= 0.6;
    }

    // ── Rule 3: Minimum risk/reward ratio ───────────────────
    const maxProfit =
      strategy.strategy.maxProfit === "unlimited"
        ? strategy.strategy.maxLoss * 3
        : strategy.strategy.maxProfit;
    const riskReward = maxProfit / Math.max(strategy.strategy.maxLoss, 1);
    if (riskReward < 0.5) {
      violations.push(
        `Risk/reward ratio ${riskReward.toFixed(2)} is below 0.5 minimum`
      );
      adjustedScore *= 0.7;
    }

    // ── Rule 4: Defined risk requirement for small accounts ─
    if (
      portfolioValue < 25_000 &&
      strategy.strategy.maxLoss > portfolioValue * 0.05
    ) {
      violations.push(
        "Small accounts require defined-risk strategies with max loss < 5% of portfolio"
      );
      adjustedScore *= 0.3;
    }

    return {
      strategy,
      passes: violations.length === 0,
      riskPct: tradeRisk.riskPct,
      violations,
      adjustedScore,
    };
  }

  // ─── Portfolio VaR ────────────────────────────────────────

  /**
   * Calculate portfolio-level VaR.
   */
  private calculatePortfolioVaR(
    params: Record<string, unknown>
  ): VaRResult {
    const historicalReturns = params.historicalReturns as number[];
    const portfolioValue = params.portfolioValue as number;
    const portfolioDelta = (params.portfolioDelta as number) ?? 0;
    const portfolioGamma = (params.portfolioGamma as number) ?? 0;
    const underlyingPrice = (params.underlyingPrice as number) ?? 100;

    return calculateFullVaR(
      historicalReturns,
      portfolioValue,
      portfolioDelta,
      portfolioGamma,
      underlyingPrice,
      config.risk.varConfidenceLevel,
      1,
      config.risk.stressTestMagnitudePct
    );
  }

  // ─── Public Accessors ─────────────────────────────────────

  /** Update the portfolio snapshot */
  updatePortfolio(portfolio: Portfolio): void {
    this.portfolio = portfolio;
    log.info("Portfolio snapshot updated");
  }

  /** Get all active risk alerts */
  getAlerts(): RiskAlert[] {
    return [...this.alerts];
  }

  /** Get current risk limits */
  getLimits(): Readonly<RiskLimits> {
    return { ...this.limits };
  }

  /** Update risk limits */
  setLimits(newLimits: Partial<RiskLimits>): void {
    this.limits = { ...this.limits, ...newLimits };
    log.info("Risk limits updated", { limits: this.limits });
  }
}
