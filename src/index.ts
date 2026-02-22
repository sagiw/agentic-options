/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║  Agentic Options "Click" System — Entry Point               ║
 * ║                                                              ║
 * ║  Multi-agent swarm for institutional-grade options execution ║
 * ║  with browser automation, quantitative analysis, and XAI.   ║
 * ╚══════════════════════════════════════════════════════════════╝
 */

import { Orchestrator } from "./agents/orchestrator.js";
import { BrowserOperator } from "./agents/browser-operator.js";
import { QuantAnalyst } from "./agents/quant-analyst.js";
import { RiskSentinel } from "./agents/risk-sentinel.js";
import { ibkrClient } from "./api/ibkr/client.js";

import { generateExplanationCard } from "./xai/explanation-card.js";
import { formatSHAPReport, computeSHAPFactors } from "./xai/shap-values.js";
import { generatePayoffDiagram } from "./xai/payoff-diagram.js";
import { config } from "./config/index.js";
import { logger } from "./utils/logger.js";

/**
 * Initialize and start the Click System.
 */
async function main(): Promise<void> {
  logger.info("═══ Agentic Options Click System v1.0 ═══");
  logger.info(`Environment: ${config.nodeEnv}`);
  logger.info(`IBKR: ${config.ibkr.host}:${config.ibkr.port}`);

  // ── 1. Initialize Agents ──────────────────────────────────
  const orchestrator = new Orchestrator();
  const browserOperator = new BrowserOperator();
  const quantAnalyst = new QuantAnalyst();
  const riskSentinel = new RiskSentinel();

  // Register specialist agents with the orchestrator
  orchestrator.registerAgent(browserOperator);
  orchestrator.registerAgent(quantAnalyst);
  orchestrator.registerAgent(riskSentinel);

  // ── 2. Initialize All Agents ──────────────────────────────
  await orchestrator.initialize();
  logger.info("All agents initialized");

  // ── 3. Connect to IBKR (optional — skip if unavailable) ──
  try {
    await ibkrClient.connect();
    logger.info("Connected to IBKR TWS");
  } catch (err) {
    logger.warn("IBKR connection failed — running in offline mode", {
      error: String(err),
    });
  }

  // ── 4. Market Data ───────────────────────────────────────
  // Yahoo Finance (free, no API key) is used as fallback in server.ts
  // IBKR provides real-time data when connected
  // ── 5. Event Listeners ────────────────────────────────────
  orchestrator.on("strategies_ready", (strategies) => {
    logger.info(`${strategies.length} strategies ready for review`);

    // Generate XAI explanation for top strategy
    if (strategies.length > 0) {
      const top = strategies[0];
      const explanation = generateExplanationCard(
        top.strategy,
        top.factors,
        150, // underlying price
        50,  // IV rank
        top.riskAssessment,
        top.score
      );
      logger.info("Top strategy explanation:", {
        summary: explanation.summary,
        confidence: explanation.confidence,
        warnings: explanation.riskWarnings.length,
      });
    }
  });

  orchestrator.on("risk_alert", (alert) => {
    logger.warn(`RISK ALERT [${alert.severity}]: ${alert.message}`);
  });

  // ── 6. Demo Workflow ──────────────────────────────────────
  if (config.nodeEnv === "development") {
    logger.info("Running demo workflow...");

    try {
      const strategies = await orchestrator.startWorkflow(
        "AAPL",
        "Find the best defined-risk options play for Apple"
      );

      logger.info(`Found ${strategies.length} viable strategies`);

      for (const [i, s] of strategies.slice(0, 3).entries()) {
        logger.info(
          `  #${i + 1}: ${s.strategy.name} — Score: ${s.score.toFixed(1)} ` +
          `Max Profit: $${typeof s.strategy.maxProfit === "number" ? s.strategy.maxProfit.toLocaleString() : s.strategy.maxProfit} ` +
          `Max Loss: $${s.strategy.maxLoss.toLocaleString()}`
        );
      }
    } catch (err) {
      logger.error("Demo workflow failed", { error: err });
    }
  }

  // ── 7. Graceful Shutdown ──────────────────────────────────
  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}, shutting down...`);
    await orchestrator.shutdown();
    await ibkrClient.disconnect();

    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  logger.info("Click System running. Waiting for commands...");
}

// ── Exports ─────────────────────────────────────────────────
export {
  Orchestrator,
  BrowserOperator,
  QuantAnalyst,
  RiskSentinel,
  ibkrClient,

  generateExplanationCard,
  computeSHAPFactors,
  formatSHAPReport,
  generatePayoffDiagram,
};

// Run if executed directly
main().catch((err) => {
  logger.error("Fatal error", { error: err });
  process.exit(1);
});
