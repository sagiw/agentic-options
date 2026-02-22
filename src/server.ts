/**
 * Express API Server — The "Click" System Backend
 *
 * Connects directly to IBKR TWS (no browser needed) and exposes:
 *   GET  /api/portfolio          — Full portfolio with positions + Greeks
 *   GET  /api/account            — Account summary (net liq, buying power, margin)
 *   GET  /api/analysis/:symbol   — Full quant analysis on an underlying
 *   GET  /api/recommendations    — Top strategy recommendations for portfolio
 *   GET  /api/chain/:symbol      — Option chain with Lambda ranking
 *   GET  /api/var                — Portfolio VaR + stress tests
 *   POST /api/approve/:id        — Approve a strategy for execution
 *   GET  /                       — React dashboard
 *
 * Start: npm run dashboard
 */

import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { PortfolioSync } from "./api/ibkr/portfolio-sync.js";
import { QuantAnalyst } from "./agents/quant-analyst.js";
import { RiskSentinel } from "./agents/risk-sentinel.js";
import { generateExplanationCard } from "./xai/explanation-card.js";
import { computeSHAPFactors, formatSHAPReport } from "./xai/shap-values.js";
import { generatePayoffDiagram } from "./xai/payoff-diagram.js";
import { calculateFullVaR, validateTradeRisk } from "./quant/var.js";
import { calculateGreeks } from "./quant/greeks.js";
import { calculateLambda } from "./quant/lambda.js";
import { blackScholesPrice, type BSParams } from "./quant/black-scholes.js";
import { config } from "./config/index.js";
import { logger, agentLogger } from "./utils/logger.js";
import { getMarketSnapshot } from "./api/market-data/yahoo.js";
import { submitStrategy, type SubmitResult } from "./api/ibkr/orders.js";
import type { OrderStatusUpdate } from "./api/ibkr/portfolio-sync.js";
import type { Portfolio, AccountSummary } from "./types/portfolio.js";
import type { RankedStrategy } from "./types/agents.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const log = agentLogger("server");
const app = express();

app.use(express.json());

// ── CORS for local development ──────────────────────────────
app.use((_req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  next();
});

// ── Initialize Components ───────────────────────────────────
const ibkr = new PortfolioSync();
const quant = new QuantAnalyst();
const risk = new RiskSentinel();

let cachedPortfolio: Portfolio | null = null;
let cachedRecommendations: RankedStrategy[] = [];
let lastRefresh = 0;

// ── Order Tracking ──────────────────────────────────────────
interface TrackedOrder {
  id: number;
  strategyId: number;
  strategyName: string;
  symbol: string;
  type: string;
  legs: number;
  ibkrOrderIds: number[];
  status: "submitted" | "partial_fill" | "filled" | "cancelled" | "rejected" | "error" | "local_only";
  riskPct: number;
  requiredCapital: number;
  expiration: string | null;
  submittedAt: string;
  message: string;
  errorDetails: { orderId: number; code: number; message: string }[];
}

const trackedOrders: TrackedOrder[] = [];
let nextLocalOrderId = 1;

const CACHE_TTL_MS = 30_000; // 30 seconds

/**
 * Refresh portfolio data from IBKR if cache is stale.
 * Never overwrites good cached data with a zero-balance fallback.
 */
async function refreshPortfolio(): Promise<Portfolio> {
  const now = Date.now();
  if (cachedPortfolio && now - lastRefresh < CACHE_TTL_MS) {
    return cachedPortfolio;
  }

  let fresh: Portfolio;
  if (ibkr.isConnected) {
    fresh = await ibkr.getFullPortfolio();

    // If the first fetch returned $0 and there's no cache yet, retry once.
    // The live subscription may need an extra moment to arrive.
    if (fresh.account.netLiquidation <= 0 && !cachedPortfolio) {
      log.warn("First portfolio load returned $0 — retrying in 3s...");
      await new Promise((r) => setTimeout(r, 3_000));
      fresh = await ibkr.getFullPortfolio();
      if (fresh.account.netLiquidation > 0) {
        log.info(`Retry succeeded: $${fresh.account.netLiquidation.toLocaleString()}`);
      } else {
        log.error("Retry also returned $0 — IBKR account summary may be unreachable");
      }
    }
  } else {
    // Fallback: generate demo portfolio for testing
    fresh = generateDemoPortfolio();
  }

  // Guard: if the new fetch returned netLiquidation=0 but we already had
  // a valid portfolio, keep the old one — the IBKR account summary probably
  // timed out. Log a warning so we know it happened.
  if (
    fresh.account.netLiquidation <= 0 &&
    cachedPortfolio &&
    cachedPortfolio.account.netLiquidation > 0
  ) {
    log.warn(
      "Refresh returned $0 balance — keeping previous cached portfolio " +
      `($${cachedPortfolio.account.netLiquidation.toLocaleString()})`
    );
    lastRefresh = now; // still reset TTL to avoid hammering IBKR
    return cachedPortfolio;
  }

  cachedPortfolio = fresh;
  lastRefresh = now;
  return cachedPortfolio;
}

// ══════════════════════════════════════════════════════════════
//  API ENDPOINTS
// ══════════════════════════════════════════════════════════════

/**
 * GET /api/portfolio — Full portfolio snapshot
 */
app.get("/api/portfolio", async (_req, res) => {
  try {
    const portfolio = await refreshPortfolio();
    res.json({
      success: true,
      data: {
        ...portfolio,
        // Serialize Map for JSON
        lastUpdated: portfolio.lastUpdated.toISOString(),
      },
    });
  } catch (err) {
    log.error("Portfolio fetch failed", { error: err });
    res.status(500).json({ success: false, error: String(err) });
  }
});

/**
 * GET /api/account — Account summary only
 */
app.get("/api/account", async (_req, res) => {
  try {
    const portfolio = await refreshPortfolio();
    res.json({ success: true, data: portfolio.account });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

/**
 * GET /api/analysis/:symbol — Full quant analysis for an underlying
 */
app.get("/api/analysis/:symbol", async (req, res) => {
  try {
    const symbol = req.params.symbol.toUpperCase();
    const portfolio = await refreshPortfolio();

    // Run quant analysis
    const analysis = await runAnalysis(symbol, portfolio);

    res.json({ success: true, data: analysis });
  } catch (err) {
    log.error(`Analysis failed for ${req.params.symbol}`, { error: err });
    res.status(500).json({ success: false, error: String(err) });
  }
});

/**
 * GET /api/recommendations — Strategy recommendations across portfolio
 */
app.get("/api/recommendations", async (req, res) => {
  try {
    const portfolio = await refreshPortfolio();
    const symbol = (req.query.symbol as string)?.toUpperCase() ?? "AAPL";

    const analysis = await runAnalysis(symbol, portfolio);
    cachedRecommendations = analysis.strategies;

    res.json({
      success: true,
      data: {
        symbol,
        strategies: analysis.strategies.slice(0, 10).map((s, i) => ({
          id: i,
          name: s.strategy.name,
          type: s.strategy.type,
          score: s.score,
          maxProfit: s.strategy.maxProfit,
          maxLoss: s.strategy.maxLoss,
          breakeven: s.strategy.breakeven,
          netDebit: s.strategy.netDebit,
          requiredCapital: s.strategy.requiredCapital,
          capitalPct: portfolio.account.availableFunds > 0
            ? (s.strategy.requiredCapital / portfolio.account.availableFunds) * 100
            : 0,
          riskPct: portfolio.account.netLiquidation > 0
            ? (s.strategy.maxLoss / portfolio.account.netLiquidation) * 100
            : 0,
          legs: s.strategy.legs.map((l) => ({
            symbol: l.contract.symbol,
            type: l.contract.type,
            strike: l.contract.strike,
            expiration: l.contract.expiration,
            side: l.side,
            quantity: l.quantity,
            price: l.price,
          })),
          factors: s.factors,
          explanation: s.strategy.name,
          approved: s.approved,
        })),
        account: {
          accountId: portfolio.account.accountId,
          netLiquidation: portfolio.account.netLiquidation,
          totalCash: portfolio.account.totalCash,
          buyingPower: portfolio.account.buyingPower,
          availableFunds: portfolio.account.availableFunds,
          marginUsed: portfolio.account.marginUsed,
          unrealizedPnL: portfolio.account.unrealizedPnL,
          realizedPnL: portfolio.account.realizedPnL,
          tier: portfolio.account.tier,
        },
        market: {
          price: analysis.underlyingPrice,
          ivRank: analysis.ivRank,
          hv30: analysis.hv30,
          dataSource: analysis.dataSource,
        },
        isLive: ibkr.isConnected,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

/**
 * GET /api/chain/:symbol — Option chain with Greeks + Lambda
 */
app.get("/api/chain/:symbol", async (req, res) => {
  try {
    const symbol = req.params.symbol.toUpperCase();
    const analysis = await runAnalysis(symbol, await refreshPortfolio());

    res.json({
      success: true,
      data: {
        symbol,
        underlyingPrice: analysis.underlyingPrice,
        entries: analysis.chain.slice(0, 100), // limit for response size
        lambdaCurve: analysis.lambdaCurve,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

/**
 * GET /api/var — Portfolio Value at Risk
 */
app.get("/api/var", async (_req, res) => {
  try {
    const portfolio = await refreshPortfolio();

    // Generate synthetic returns for demo (in production: use IBKR historical data)
    const returns = Array.from({ length: 252 }, () => (Math.random() - 0.48) * 0.03);

    const varResult = calculateFullVaR(
      returns,
      portfolio.account.netLiquidation,
      portfolio.greeks.totalDelta,
      portfolio.greeks.totalGamma,
      150, // SPY proxy price
      config.risk.varConfidenceLevel,
      1,
      config.risk.stressTestMagnitudePct
    );

    res.json({ success: true, data: varResult });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

/**
 * GET /api/payoff/:id — Payoff diagram for a recommended strategy
 */
app.get("/api/payoff/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const strategy = cachedRecommendations[id];
    if (!strategy) {
      return res.status(404).json({ success: false, error: "Strategy not found" });
    }

    const diagram = generatePayoffDiagram(strategy.strategy, 150);
    res.json({ success: true, data: diagram });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

/**
 * POST /api/approve/:id — Approve a strategy (human-in-the-loop)
 */
app.post("/api/approve/:id", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const strategy = cachedRecommendations[id];

  if (!strategy) {
    return res.status(404).json({ success: false, error: "Strategy not found" });
  }

  // Validate risk one more time
  const portfolio = await refreshPortfolio();
  const netLiq = portfolio.account.netLiquidation;

  if (!netLiq || netLiq <= 0) {
    return res.status(400).json({
      success: false,
      error: "Cannot approve — account balance is $0. IBKR account summary may have timed out. Try refreshing.",
    });
  }

  const riskCheck = validateTradeRisk(
    strategy.strategy.maxLoss,
    netLiq,
    config.risk.maxRiskPerTradePct
  );

  if (!riskCheck.passes) {
    return res.status(400).json({
      success: false,
      error: riskCheck.message,
      riskPct: riskCheck.riskPct,
    });
  }

  strategy.approved = true;
  log.info(`Strategy #${id} APPROVED: ${strategy.strategy.name}`);

  // ── Submit to IBKR ───────────────────────────────────────
  let submitResult: SubmitResult;
  try {
    submitResult = await submitStrategy(ibkr, strategy.strategy);
  } catch (err) {
    submitResult = {
      success: false,
      orderIds: [],
      legs: strategy.strategy.legs.length,
      message: `Submission error: ${String(err)}`,
    };
  }

  // Find the nearest expiration from the strategy legs
  const expirations = strategy.strategy.legs
    .map((l) => l.contract.expiration)
    .filter((e): e is Date => e instanceof Date && !isNaN(e.getTime()));
  const nearestExp = expirations.length > 0
    ? new Date(Math.min(...expirations.map((d) => d.getTime()))).toISOString()
    : null;

  // Track the order
  const trackedOrder: TrackedOrder = {
    id: nextLocalOrderId++,
    strategyId: id,
    strategyName: strategy.strategy.name,
    symbol: strategy.strategy.legs[0]?.contract.symbol ?? "???",
    type: strategy.strategy.type,
    legs: strategy.strategy.legs.length,
    ibkrOrderIds: submitResult.orderIds,
    status: submitResult.success ? "submitted" : (ibkr.isConnected ? "error" : "local_only"),
    riskPct: riskCheck.riskPct,
    requiredCapital: strategy.strategy.requiredCapital,
    expiration: nearestExp,
    submittedAt: new Date().toISOString(),
    message: submitResult.message,
    errorDetails: [],
  };
  trackedOrders.push(trackedOrder);

  log.info(
    `Order #${trackedOrder.id}: ${trackedOrder.status} ` +
    `(IBKR IDs: ${submitResult.orderIds.join(", ") || "none"}) — ${submitResult.message}`
  );

  res.json({
    success: true,
    message: submitResult.success
      ? `Strategy approved & submitted to IBKR: ${strategy.strategy.name}`
      : `Strategy approved locally: ${submitResult.message}`,
    riskPct: riskCheck.riskPct,
    orderId: trackedOrder.id,
    ibkrOrderIds: submitResult.orderIds,
    ibkrStatus: trackedOrder.status,
    ibkrMessage: submitResult.message,
  });
});

/**
 * GET /api/status — System health check
 */
app.get("/api/status", (_req, res) => {
  res.json({
    success: true,
    data: {
      system: "Agentic Options Click v1.0",
      ibkrConnected: ibkr.isConnected,
      portfolioLoaded: cachedPortfolio !== null,
      lastRefresh: lastRefresh ? new Date(lastRefresh).toISOString() : null,
      cachedStrategies: cachedRecommendations.length,
    },
  });
});

/**
 * GET /api/orders — All tracked orders with IBKR status
 */
app.get("/api/orders", (_req, res) => {
  res.json({ success: true, data: trackedOrders });
});

/**
 * GET /api/orders/verify — Query IBKR TWS for all open orders.
 * This is the definitive check — shows every order IBKR actually received.
 * Compare with tracked orders to diagnose submission issues.
 */
app.get("/api/orders/verify", async (_req, res) => {
  try {
    if (!ibkr.isConnected) {
      return res.json({
        success: false,
        error: "IBKR not connected — cannot verify orders",
        trackedOrders: trackedOrders.map((o) => ({
          id: o.id,
          name: o.strategyName,
          ibkrOrderIds: o.ibkrOrderIds,
          status: o.status,
          message: o.message,
        })),
        ibkrOrders: [],
      });
    }

    log.info("Querying IBKR for all open orders...");
    const ibkrOrders = await ibkr.getOpenOrders();

    // Cross-reference with our tracked orders
    const verification = trackedOrders.map((tracked) => {
      const matchingIbkr = ibkrOrders.filter((ib: any) =>
        tracked.ibkrOrderIds.includes(ib.orderId)
      );
      return {
        localId: tracked.id,
        strategyName: tracked.strategyName,
        ibkrOrderIds: tracked.ibkrOrderIds,
        localStatus: tracked.status,
        ibkrMatches: matchingIbkr,
        verified: matchingIbkr.length > 0,
      };
    });

    res.json({
      success: true,
      data: {
        trackedCount: trackedOrders.length,
        ibkrOpenCount: ibkrOrders.length,
        verification,
        allIbkrOrders: ibkrOrders,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

// ── Serve React Dashboard ───────────────────────────────────
app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "dashboard", "index.html"));
});

// ══════════════════════════════════════════════════════════════
//  ANALYSIS ENGINE
// ══════════════════════════════════════════════════════════════

interface AnalysisResult {
  underlyingPrice: number;
  dataSource: string;
  ivRank: number;
  hv30: number;
  chain: any[];
  strategies: RankedStrategy[];
  lambdaCurve: any[];
}

async function runAnalysis(symbol: string, portfolio: Portfolio): Promise<AnalysisResult> {
  // Initialize quant if needed
  if (quant.status === "idle") await quant.initialize();

  // ── Step 1: Get real price for the symbol ──────────────────
  // Priority: IBKR position → Yahoo Finance → hardcoded fallback
  let underlyingPrice = 0;
  let ivRank = 50;
  let realHV = 0.3;
  let dataSource = "fallback";

  // Try portfolio positions first
  for (const pos of portfolio.positions) {
    if (
      pos.contract.symbol === symbol &&
      pos.contract.type === "stock" &&
      pos.quantity > 0 &&
      pos.marketValue > 0
    ) {
      underlyingPrice = pos.marketValue / pos.quantity;
      dataSource = "portfolio";
      log.info(`Price for ${symbol}: $${underlyingPrice.toFixed(2)} (from portfolio)`);
      break;
    }
  }

  // If no portfolio price, try Yahoo Finance (free, no API key)
  if (underlyingPrice <= 0) {
    log.info(`Fetching real market data for ${symbol} from Yahoo Finance...`);
    const snapshot = await getMarketSnapshot(symbol);
    if (snapshot && snapshot.price > 0) {
      underlyingPrice = snapshot.price;
      ivRank = snapshot.ivRank;
      realHV = snapshot.hv30;
      dataSource = "yahoo";
      log.info(
        `Price for ${symbol}: $${underlyingPrice.toFixed(2)} | ` +
        `IV Rank: ${ivRank} | HV30: ${(realHV * 100).toFixed(1)}% (from Yahoo)`
      );
    }
  }

  // Absolute fallback (should rarely happen)
  if (underlyingPrice <= 0) {
    underlyingPrice = 100;
    log.warn(`No market data for ${symbol} — using $100 fallback`);
    dataSource = "fallback";
  }

  // Run quant analysis via the agent's message protocol
  const result = await quant.handleMessage({
    id: "analysis-" + Date.now(),
    from: "orchestrator",
    to: "quant",
    type: "task_request",
    payload: {
      taskId: "analysis-" + Date.now(),
      action: "find_strategies",
      params: {
        symbol,
        underlyingPrice,
        ivRank,
        baseIV: realHV,
        account: portfolio.account,
      },
      priority: "high",
    },
    timestamp: new Date(),
  });

  const strategies = (result?.payload as RankedStrategy[]) ?? [];

  // Generate explanation cards for top strategies using real IV rank
  for (const s of strategies.slice(0, 5)) {
    const greeks = { delta: 0.5, gamma: 0.02, theta: -0.05, vega: 0.3, rho: 0.1 };
    const shap = computeSHAPFactors(s.strategy, greeks, underlyingPrice, ivRank);
    s.factors = shap.factors;
    s.score = shap.finalScore;
  }

  return {
    underlyingPrice,
    dataSource,
    ivRank,
    hv30: realHV,
    chain: [],
    strategies,
    lambdaCurve: [],
  };
}

// ── Demo Portfolio (when IBKR not connected) ────────────────
function generateDemoPortfolio(): Portfolio {
  return {
    account: {
      accountId: "DEMO-U1234567",
      currency: "USD",
      netLiquidation: 87_432.50,
      totalCash: 34_210.00,
      buyingPower: 174_865.00,
      availableFunds: 42_100.00,
      marginUsed: 12_340.00,
      marginType: "reg_t",
      unrealizedPnL: 3_456.78,
      realizedPnL: 1_234.50,
      tier: "medium",
    },
    positions: [
      {
        contract: { symbol: "AAPL", exchange: "SMART", type: "stock" as const },
        quantity: 100,
        averageCost: 178.50,
        marketValue: 18_920.00,
        unrealizedPnL: 970.00,
        realizedPnL: 0,
      },
      {
        contract: {
          symbol: "AAPL260320C190",
          underlying: "AAPL",
          type: "call" as const,
          style: "american" as const,
          strike: 190,
          expiration: new Date("2026-03-20"),
          multiplier: 100,
          exchange: "SMART",
        },
        quantity: 2,
        averageCost: 540.00, // IBKR format: $5.40/sh × 100 multiplier = $540/contract
        marketValue: 1_360.00,
        unrealizedPnL: 280.00,
        realizedPnL: 0,
        greeks: { delta: 0.45, gamma: 0.025, theta: -0.08, vega: 0.32, rho: 0.05 },
      },
      {
        contract: {
          symbol: "TSLA260417P230",
          underlying: "TSLA",
          type: "put" as const,
          style: "american" as const,
          strike: 230,
          expiration: new Date("2026-04-17"),
          multiplier: 100,
          exchange: "SMART",
        },
        quantity: -3,
        averageCost: 820.00, // IBKR format: $8.20/sh × 100 multiplier = $820/contract
        marketValue: -2_100.00,
        unrealizedPnL: 360.00,
        realizedPnL: 0,
        greeks: { delta: -0.35, gamma: 0.018, theta: -0.12, vega: 0.45, rho: -0.03 },
      },
      {
        contract: { symbol: "MSFT", exchange: "SMART", type: "stock" as const },
        quantity: 50,
        averageCost: 415.20,
        marketValue: 21_500.00,
        unrealizedPnL: 740.00,
        realizedPnL: 0,
      },
      {
        contract: { symbol: "SPY", exchange: "SMART", type: "stock" as const },
        quantity: 30,
        averageCost: 580.00,
        marketValue: 17_850.00,
        unrealizedPnL: 450.00,
        realizedPnL: 0,
      },
    ],
    greeks: {
      totalDelta: 215.4,
      totalGamma: 8.3,
      totalTheta: -28.4,
      totalVega: 154.0,
      betaWeightedDelta: 198.7,
    },
    var: {
      var: 2_450,
      confidenceLevel: 0.95,
      horizon: 1,
      cvar: 3_120,
      method: "historical",
      stressTests: [
        { scenario: "-15% crash", underlyingMove: -15, portfolioPnL: -12_340, worstCaseLoss: -12_340 },
        { scenario: "-7.5% correction", underlyingMove: -7.5, portfolioPnL: -5_670, worstCaseLoss: -5_670 },
        { scenario: "+7.5% rally", underlyingMove: 7.5, portfolioPnL: 6_210, worstCaseLoss: 0 },
        { scenario: "+15% surge", underlyingMove: 15, portfolioPnL: 13_890, worstCaseLoss: 0 },
      ],
    },
    lastUpdated: new Date(),
  };
}

// ══════════════════════════════════════════════════════════════
//  START SERVER
// ══════════════════════════════════════════════════════════════

async function startServer() {
  // Try to connect to IBKR
  try {
    await ibkr.connect();
    log.info("Connected to IBKR TWS — using live data");

    // Listen for IBKR order status updates to keep tracked orders current
    ibkr.on("orderStatus", (update: OrderStatusUpdate) => {
      for (const order of trackedOrders) {
        if (order.ibkrOrderIds.includes(update.orderId)) {
          const ibkrStatus = update.status.toLowerCase();
          if (ibkrStatus === "filled") order.status = "filled";
          else if (ibkrStatus === "cancelled") order.status = "cancelled";
          else if (ibkrStatus === "inactive") order.status = "rejected";
          else if (ibkrStatus === "error") {
            order.status = "error";
            const errMsg = update.errorMessage
              ? `[${update.errorCode}] ${update.errorMessage}`
              : `Unknown error`;
            order.message = `IBKR rejected order #${update.orderId}: ${errMsg}`;
            order.errorDetails.push({
              orderId: update.orderId,
              code: update.errorCode ?? 0,
              message: update.errorMessage ?? "Unknown error",
            });
          }
          else if (ibkrStatus.includes("submit")) order.status = "submitted";
          else if (ibkrStatus.includes("partial")) order.status = "partial_fill";
          log.info(`Order #${order.id} (IBKR ${update.orderId}): status → ${order.status}`);
          break;
        }
      }
    });
  } catch (err) {
    log.warn("IBKR not available — using demo portfolio", { error: String(err) });
  }

  // Initialize agents
  await quant.initialize();
  await risk.initialize();

  const PORT = config.port;
  app.listen(PORT, () => {
    log.info(`═══════════════════════════════════════════`);
    log.info(`  Agentic Options "Click" Dashboard`);
    log.info(`  http://localhost:${PORT}`);
    log.info(`  IBKR: ${ibkr.isConnected ? "Connected ✓" : "Demo Mode"}`);
    log.info(`═══════════════════════════════════════════`);
  });
}

startServer().catch((err) => {
  log.error("Server startup failed", { error: err });
  process.exit(1);
});

export default app;
