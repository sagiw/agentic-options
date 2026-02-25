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
import { estimateMargin, checkMarginAvailability } from "./utils/margin.js";
import { loadSettings, saveSettings } from "./storage/settings.js";
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

    // Parse goal parameters
    const goalParams = {
      monthlyTarget: parseFloat(req.query.monthlyTarget as string) || 0,
      maxRiskPct: parseFloat(req.query.maxRiskPct as string) || 2,
      minDTE: parseInt(req.query.minDTE as string, 10) || 14,
      maxDTE: parseInt(req.query.maxDTE as string, 10) || 60,
      allowedStrategies: (req.query.strategies as string)?.split(",").filter(Boolean) || [],
    };

    const analysis = await runAnalysis(symbol, portfolio, goalParams);
    cachedRecommendations = analysis.strategies;

    res.json({
      success: true,
      data: {
        symbol,
        strategies: analysis.strategies.slice(0, 10).map((s, i) => {
          const estMargin = estimateMargin(s.strategy, analysis.underlyingPrice);
          return {
          id: i,
          name: s.strategy.name,
          type: s.strategy.type,
          score: s.score,
          maxProfit: s.strategy.maxProfit,
          maxLoss: s.strategy.maxLoss,
          breakeven: s.strategy.breakeven,
          netDebit: s.strategy.netDebit,
          requiredCapital: s.strategy.requiredCapital,
          estimatedMargin: Math.round(estMargin),
          capitalPct: portfolio.account.availableFunds > 0
            ? (s.strategy.requiredCapital / portfolio.account.availableFunds) * 100
            : 0,
          marginPct: portfolio.account.availableFunds > 0
            ? (estMargin / portfolio.account.availableFunds) * 100
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
        }; }),
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

// ══════════════════════════════════════════════════════════════
//  USER SETTINGS PERSISTENCE
// ══════════════════════════════════════════════════════════════

/**
 * GET /api/settings — Load saved user settings (goals, watchlist)
 */
app.get("/api/settings", (_req, res) => {
  try {
    const settings = loadSettings();
    res.json({ success: true, data: settings });
  } catch (err) {
    log.warn("Failed to load settings", { error: String(err) });
    res.status(500).json({ success: false, error: "Failed to load settings" });
  }
});

/**
 * POST /api/settings — Save user settings (goals, watchlist)
 */
app.post("/api/settings", (req, res) => {
  try {
    const saved = saveSettings(req.body);
    log.info(`Settings saved: target=$${saved.monthlyTarget}, symbols=[${saved.symbols.join(",")}]`);
    res.json({ success: true, data: saved });
  } catch (err: any) {
    log.warn("Failed to save settings", { error: String(err) });
    if (err?.name === "ZodError") {
      res.status(400).json({ success: false, error: "Invalid settings", details: err.issues });
    } else {
      res.status(500).json({ success: false, error: "Failed to save settings" });
    }
  }
});

/**
 * GET /api/optionchain/:symbol — Full option chain with live IBKR prices
 *
 * Query params:
 *   expiration  — YYYYMMDD (required, or "list" to get available expirations)
 *   range       — number of strikes above/below ATM (default 10)
 *
 * Returns:
 *   expirations[] — all available expirations
 *   strikes[]     — the filtered strikes
 *   calls{}       — { [strike]: { bid, ask, mid, last, delayed } | null }
 *   puts{}        — { [strike]: { bid, ask, mid, last, delayed } | null }
 */
const optionChainCache: Record<string, { data: any; cachedAt: number }> = {};
const chainParamsCache: Record<string, { data: any; cachedAt: number }> = {};
const CHAIN_CACHE_TTL = 60_000; // 60s
const PARAMS_CACHE_TTL = 300_000; // 5min — strikes/expirations don't change often

app.get("/api/optionchain/:symbol", async (req, res) => {
  try {
    const symbol = req.params.symbol.toUpperCase();
    const expirationParam = (req.query.expiration as string) || "list";
    const range = Math.min(parseInt(req.query.range as string) || 10, 25);

    // Step 1: Get chain params (strikes + expirations) from IBKR (cached 5min)
    let chainParams: { expirations: string[]; strikes: number[]; exchange: string };
    const paramsCached = chainParamsCache[symbol];
    if (paramsCached && Date.now() - paramsCached.cachedAt < PARAMS_CACHE_TTL) {
      chainParams = paramsCached.data;
      log.info(`[OptionChain] Using cached chain params for ${symbol}: ${chainParams.strikes.length} strikes, ${chainParams.expirations.length} expirations`);
    } else {
      try {
        chainParams = await ibkr.getOptionChainParams(symbol);
        chainParamsCache[symbol] = { data: chainParams, cachedAt: Date.now() };
      } catch (err) {
        return res.status(500).json({
          success: false,
          error: `Failed to get option chain for ${symbol}: ${err}`,
        });
      }
    }

    if (!chainParams.expirations.length || !chainParams.strikes.length) {
      return res.json({
        success: true,
        data: {
          symbol,
          expirations: [],
          strikes: [],
          calls: {},
          puts: {},
          underlyingPrice: 0,
          message: `No options available for ${symbol}`,
        },
      });
    }

    // If only listing expirations, return early
    if (expirationParam === "list") {
      return res.json({
        success: true,
        data: {
          symbol,
          expirations: chainParams.expirations,
          strikes: chainParams.strikes,
        },
      });
    }

    // Step 2: Get underlying price for ATM filtering
    const portfolio = await refreshPortfolio();
    let underlyingPrice = 0;
    for (const pos of portfolio.positions) {
      if (pos.contract.symbol === symbol && pos.contract.type === "stock" && pos.quantity > 0 && pos.marketValue > 0) {
        underlyingPrice = pos.marketValue / pos.quantity;
        break;
      }
    }
    if (underlyingPrice <= 0) {
      const snapshot = await getMarketSnapshot(symbol);
      if (snapshot && snapshot.price > 0) underlyingPrice = snapshot.price;
    }
    if (underlyingPrice <= 0) underlyingPrice = chainParams.strikes[Math.floor(chainParams.strikes.length / 2)];

    // Step 3: Filter strikes around ATM
    const allStrikes = chainParams.strikes;
    log.info(`[OptionChain] ${symbol}: ${allStrikes.length} total strikes from IBKR, underlyingPrice=${underlyingPrice}, range=±${range}`);
    const atmIdx = allStrikes.reduce((best, s, i) =>
      Math.abs(s - underlyingPrice) < Math.abs(allStrikes[best] - underlyingPrice) ? i : best, 0);
    const fromIdx = Math.max(0, atmIdx - range);
    const toIdx = Math.min(allStrikes.length - 1, atmIdx + range);
    const strikes = allStrikes.slice(fromIdx, toIdx + 1);
    log.info(`[OptionChain] ATM strike=${allStrikes[atmIdx]} (idx=${atmIdx}), filtered: ${strikes.length} strikes [${strikes[0]}..${strikes[strikes.length - 1]}]`);

    // Step 4: Check cache
    const cacheKey = `${symbol}-${expirationParam}-${fromIdx}-${toIdx}`;
    const cached = optionChainCache[cacheKey];
    if (cached && Date.now() - cached.cachedAt < CHAIN_CACHE_TTL) {
      return res.json({ success: true, data: cached.data });
    }

    // Step 5: Build batch requests — calls + puts for each strike
    const requests: Array<{ symbol: string; strike: number; right: "C" | "P"; expiration: string }> = [];
    for (const strike of strikes) {
      requests.push({ symbol, strike, right: "C", expiration: expirationParam });
      requests.push({ symbol, strike, right: "P", expiration: expirationParam });
    }

    log.info(`Option chain ${symbol} exp ${expirationParam}: fetching ${requests.length} options (${strikes.length} strikes)...`);

    // Step 6: Fetch all prices in parallel
    const batchResults = await ibkr.getOptionChainBatch(requests, 50);

    // Step 7: Organize results
    const calls: Record<number, any> = {};
    const puts: Record<number, any> = {};
    for (const strike of strikes) {
      calls[strike] = batchResults.get(`${strike}-C`) || null;
      puts[strike] = batchResults.get(`${strike}-P`) || null;
    }

    const data = {
      symbol,
      underlyingPrice,
      expiration: expirationParam,
      expirations: chainParams.expirations,
      strikes,
      calls,
      puts,
    };

    // Cache result
    optionChainCache[cacheKey] = { data, cachedAt: Date.now() };

    log.info(`Option chain ${symbol}: returned ${strikes.length} strikes, ` +
      `${Object.values(calls).filter(Boolean).length} calls, ${Object.values(puts).filter(Boolean).length} puts with data`);

    res.json({ success: true, data });
  } catch (err) {
    log.error(`Option chain failed`, { error: String(err) });
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

  // Margin check: verify available funds can cover estimated IBKR margin
  const underlyingPrice = strategy.strategy.legs[0]?.price
    ? strategy.strategy.legs[0].contract.strike
    : netLiq / 100; // fallback
  const marginCheck = checkMarginAvailability(
    strategy.strategy,
    portfolio.account.availableFunds || netLiq * 0.5,
    underlyingPrice
  );

  if (!marginCheck.canExecute) {
    log.warn(
      `Strategy #${id} REJECTED (margin): ${marginCheck.message}`
    );
    return res.status(400).json({
      success: false,
      error: `Insufficient margin: estimated $${marginCheck.estimatedMargin.toFixed(0)} required, ` +
        `but only $${marginCheck.availableFunds.toFixed(0)} available ` +
        `(short $${marginCheck.shortfall.toFixed(0)})`,
      estimatedMargin: marginCheck.estimatedMargin,
      availableFunds: marginCheck.availableFunds,
      shortfall: marginCheck.shortfall,
    });
  }

  strategy.approved = true;
  log.info(`Strategy #${id} APPROVED: ${strategy.strategy.name} (margin: $${marginCheck.estimatedMargin.toFixed(0)})`);

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
 * POST /api/close — Close existing position(s) via IBKR.
 *
 * Body: {
 *   legs: [{
 *     symbol: string,       // underlying symbol (e.g. "AAPL")
 *     type: "call"|"put"|"stock",
 *     strike?: number,
 *     expiration?: string,  // ISO date string or YYYYMMDD
 *     side: "buy"|"sell",   // closing side
 *     quantity: number,
 *     price: number,        // limit price per share
 *     exchange?: string,
 *   }]
 * }
 */
app.post("/api/close", async (req, res) => {
  try {
    const { legs } = req.body;

    if (!legs || !Array.isArray(legs) || legs.length === 0) {
      return res.status(400).json({
        success: false,
        error: "Request must include a 'legs' array with at least one leg",
      });
    }

    if (!ibkr.isConnected) {
      return res.status(400).json({
        success: false,
        error: "IBKR not connected — cannot submit close order",
      });
    }

    if (!ibkr.hasValidOrderId) {
      return res.status(400).json({
        success: false,
        error: "IBKR not ready — no valid order ID. Try again in a moment.",
      });
    }

    log.info(`Close request: ${legs.length} leg(s)`);

    // Build an OptionsStrategy from the close legs
    const closingStrategy = {
      name: `Close Position`,
      type: "custom" as any,
      legs: legs.map((l: any) => ({
        contract: {
          symbol: l.symbol,
          underlying: l.symbol,
          type: l.type,
          style: "american" as const,
          strike: l.strike || 0,
          expiration: l.expiration
            ? (/^\d{8}$/.test(String(l.expiration))
              // YYYYMMDD → parse as local date (avoid UTC shift)
              ? new Date(
                  parseInt(String(l.expiration).slice(0, 4)),
                  parseInt(String(l.expiration).slice(4, 6)) - 1,
                  parseInt(String(l.expiration).slice(6, 8))
                )
              : new Date(l.expiration))
            : new Date(),
          multiplier: 100,
          exchange: l.exchange || "SMART",
        },
        side: l.side as "buy" | "sell",
        quantity: l.quantity,
        price: l.price || 0,
      })),
      netDebit: 0,
      maxLoss: 0,
      maxProfit: 0,
      breakEven: 0,
      requiredCapital: 0,
      expiration: new Date(),
    };

    const submitResult = await submitStrategy(ibkr, closingStrategy as any);

    // Track as close order
    const trackedOrder: TrackedOrder = {
      id: nextLocalOrderId++,
      strategyId: -1,
      strategyName: `Close: ${legs.map((l: any) => `${l.side.toUpperCase()} ${l.quantity}x ${l.symbol} ${l.type?.toUpperCase() || ""} $${l.strike || ""}`).join(" + ")}`,
      symbol: legs[0]?.symbol ?? "???",
      type: "close" as any,
      legs: legs.length,
      ibkrOrderIds: submitResult.orderIds,
      status: submitResult.success ? "submitted" : "error",
      riskPct: 0,
      requiredCapital: 0,
      expiration: null,
      submittedAt: new Date().toISOString(),
      message: submitResult.message,
      errorDetails: [],
    };
    trackedOrders.push(trackedOrder);

    log.info(
      `Close order #${trackedOrder.id}: ${trackedOrder.status} ` +
      `(IBKR IDs: ${submitResult.orderIds.join(", ") || "none"}) — ${submitResult.message}`
    );

    res.json({
      success: submitResult.success,
      message: submitResult.message,
      orderId: trackedOrder.id,
      ibkrOrderIds: submitResult.orderIds,
    });
  } catch (err) {
    log.error(`Close order failed: ${err}`);
    res.status(500).json({ success: false, error: String(err) });
  }
});

/**
 * GET /api/quote/:symbol — Get real-time stock quote via IBKR snapshot.
 */
app.get("/api/quote/:symbol", async (req, res) => {
  try {
    const symbol = (req.params.symbol || "").toUpperCase().trim();
    if (!symbol) {
      return res.status(400).json({ success: false, error: "Missing symbol" });
    }
    const quote = await ibkr.getStockQuote(symbol);
    if (!quote) {
      return res.status(404).json({ success: false, error: `No quote for ${symbol}` });
    }
    const price = quote.last || quote.close || ((quote.bid + quote.ask) / 2);
    res.json({
      success: true,
      data: {
        symbol,
        price: Math.round(price * 100) / 100,
        bid: quote.bid,
        ask: quote.ask,
        last: quote.last,
        close: quote.close,
        delayed: quote.delayed,
      },
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/nbbo — Get real-time NBBO for a specific option contract.
 * Query params: symbol, strike, right (C/P), expiration (ISO date)
 */
app.get("/api/nbbo", async (req, res) => {
  try {
    const { symbol, strike, right, expiration } = req.query;

    if (!symbol || !strike || !right || !expiration) {
      return res.status(400).json({
        success: false,
        error: "Required params: symbol, strike, right (C/P), expiration",
      });
    }

    if (!ibkr.isConnected) {
      return res.json({ success: false, error: "IBKR not connected" });
    }

    const symStr = String(symbol).toUpperCase().trim();
    const strikeNum = parseFloat(String(strike));
    const rightStr = String(right).toUpperCase().trim();
    const rightChar: "P" | "C" = rightStr === "P" || rightStr === "PUT" ? "P" : "C";

    // ── Parse expiration robustly ──
    // Accept YYYYMMDD directly, or ISO date string, or "YYYY-MM-DD"
    let expStr: string;
    const expRaw = String(expiration).trim();
    if (/^\d{8}$/.test(expRaw)) {
      // Already YYYYMMDD format
      expStr = expRaw;
    } else if (/^\d{4}-\d{2}-\d{2}$/.test(expRaw)) {
      // "YYYY-MM-DD" — parse directly, no timezone issues
      expStr = expRaw.replace(/-/g, "");
    } else {
      // ISO string or other Date-parsable format — use UTC to avoid timezone shift
      const expDate = new Date(expRaw);
      expStr = `${expDate.getUTCFullYear()}${String(expDate.getUTCMonth() + 1).padStart(2, "0")}${String(expDate.getUTCDate()).padStart(2, "0")}`;
    }

    log.info(`NBBO request: ${symStr} ${strikeNum}${rightChar} exp ${expStr}`);

    // ── Step 1: Validate contract exists via reqContractDetails ──
    const conId = await ibkr.resolveOptionConId({
      symbol: symStr,
      strike: strikeNum,
      right: rightChar,
      expiration: expStr,
    });

    if (!conId) {
      return res.json({
        success: false,
        error: `Contract not found: ${symStr} ${rightChar} $${strikeNum} exp ${expStr}. Check strike/expiration date exist in IBKR option chain.`,
      });
    }

    // ── Step 2: Request NBBO snapshot ──
    const nbbo = await ibkr.getOptionNBBO({
      symbol: symStr,
      strike: strikeNum,
      right: rightChar,
      expiration: expStr,
    });

    if (!nbbo) {
      return res.json({
        success: false,
        error: `Contract found (conId ${conId}) but no market data for ${symStr} ${rightChar} $${strikeNum} exp ${expStr}. Market may be closed or no data subscription.`,
      });
    }

    res.json({
      success: true,
      data: {
        bid: nbbo.bid,
        ask: nbbo.ask,
        mid: nbbo.mid,
        last: nbbo.last,
        symbol: symStr,
        strike: strikeNum,
        right: rightChar,
        expiration: expStr,
        conId,
        delayed: nbbo.delayed || false,
      },
    });
  } catch (err) {
    log.error(`NBBO endpoint error: ${err}`);
    res.status(500).json({ success: false, error: String(err) });
  }
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

/**
 * GET /api/portfolio-plan — Multi-symbol portfolio plan.
 * Analyzes all specified symbols, picks the best strategies across all of them,
 * and builds a combined plan showing how to reach the monthly income target.
 */
app.get("/api/portfolio-plan", async (req, res) => {
  try {
    const portfolio = await refreshPortfolio();
    const symbols = (req.query.symbols as string)?.split(",").filter(Boolean).map((s) => s.toUpperCase()) || [];

    if (symbols.length === 0) {
      return res.status(400).json({ success: false, error: "No symbols provided" });
    }

    const goalParams: GoalParams = {
      monthlyTarget: parseFloat(req.query.monthlyTarget as string) || 1000,
      maxRiskPct: parseFloat(req.query.maxRiskPct as string) || 2,
      minDTE: parseInt(req.query.minDTE as string, 10) || 14,
      maxDTE: parseInt(req.query.maxDTE as string, 10) || 60,
      allowedStrategies: (req.query.strategies as string)?.split(",").filter(Boolean) || [],
    };

    const netLiq = portfolio.account.netLiquidation || 50_000;
    const availFunds = portfolio.account.availableFunds || netLiq * 0.5;
    const maxCapPerTrade = netLiq * (goalParams.maxRiskPct / 100) * 5; // up to 5x risk for capital

    log.info(`Portfolio Plan: scanning ${symbols.length} symbols for $${goalParams.monthlyTarget}/mo target`);

    // Analyze all symbols in parallel
    const results = await Promise.allSettled(
      symbols.map(async (sym) => {
        const analysis = await runAnalysis(sym, portfolio, goalParams);
        return {
          symbol: sym,
          price: analysis.underlyingPrice,
          ivRank: analysis.ivRank,
          strategies: analysis.strategies.slice(0, 5), // top 5 per symbol
        };
      })
    );

    // Collect all candidate strategies from all symbols
    interface PlanCandidate {
      symbol: string;
      name: string;
      type: string;
      score: number;
      maxProfit: number | string;
      maxLoss: number;
      expectedProfit: number;
      capitalRequired: number;
      estimatedMargin: number;
      riskPct: number;
      avgDTE: number;
      legs: any[];
      factors: any[];
    }

    const candidates: PlanCandidate[] = [];

    for (const result of results) {
      if (result.status !== "fulfilled") continue;
      const { symbol, price: symPrice, strategies } = result.value;
      for (const s of strategies) {
        const profit = s.strategy.maxProfit === "unlimited"
          ? s.strategy.maxLoss * 1.5
          : s.strategy.maxProfit;
        // Expected profit: conservative estimate (60% of max profit)
        const expectedProfit = typeof profit === "number" ? profit * 0.6 : 0;

        const now = Date.now();
        const legDTEs = s.strategy.legs
          .map((l) => {
            if (!l.contract.expiration) return 0;
            const expMs = new Date(l.contract.expiration).getTime();
            return Math.round((expMs - now) / (1000 * 60 * 60 * 24));
          })
          .filter((d) => d > 0);
        const avgDTE = legDTEs.length > 0
          ? Math.round(legDTEs.reduce((a, b) => a + b, 0) / legDTEs.length)
          : 30;

        // Estimate IBKR margin for this strategy
        const estMargin = estimateMargin(s.strategy, symPrice);

        // Skip strategies that exceed available funds (margin-based filter)
        if (estMargin > availFunds) continue;

        candidates.push({
          symbol,
          name: s.strategy.name,
          type: s.strategy.type,
          score: s.score,
          maxProfit: s.strategy.maxProfit,
          maxLoss: s.strategy.maxLoss,
          expectedProfit,
          capitalRequired: s.strategy.requiredCapital,
          estimatedMargin: Math.round(estMargin),
          riskPct: netLiq > 0 ? (s.strategy.maxLoss / netLiq) * 100 : 0,
          avgDTE,
          legs: s.strategy.legs.map((l) => ({
            symbol: l.contract.symbol,
            type: l.contract.type,
            strike: l.contract.strike,
            expiration: l.contract.expiration,
            side: l.side,
            quantity: l.quantity,
            price: l.price,
          })),
          factors: s.factors || [],
        });
      }
    }

    // Sort by efficiency: expected profit relative to capital and risk
    candidates.sort((a, b) => {
      const effA = a.capitalRequired > 0 ? (a.expectedProfit / a.capitalRequired) * a.score : 0;
      const effB = b.capitalRequired > 0 ? (b.expectedProfit / b.capitalRequired) * b.score : 0;
      return effB - effA;
    });

    // Greedy selection: pick strategies to maximize profit while respecting constraints
    const selected: PlanCandidate[] = [];
    let totalCapital = 0;
    let totalRisk = 0;
    let totalExpectedProfit = 0;
    const symbolCount: Record<string, number> = {};
    const maxPerSymbol = 2; // max 2 strategies per symbol for diversification

    for (const candidate of candidates) {
      // Diversification: max N per symbol
      const symCount = symbolCount[candidate.symbol] || 0;
      if (symCount >= maxPerSymbol) continue;

      // Margin constraint: check estimated IBKR margin against remaining available funds
      const remainingFunds = availFunds * 0.9 - totalCapital;
      if (candidate.estimatedMargin > remainingFunds) continue;

      // Capital constraint: don't exceed actual available funds (with 10% buffer)
      if (totalCapital + candidate.capitalRequired > availFunds * 0.9) continue;

      // Risk constraint: total risk shouldn't exceed monthly target * 3
      if (totalRisk + candidate.riskPct > goalParams.maxRiskPct * symbols.length) continue;

      selected.push(candidate);
      totalCapital += candidate.capitalRequired;
      totalRisk += candidate.riskPct;
      totalExpectedProfit += candidate.expectedProfit;
      symbolCount[candidate.symbol] = symCount + 1;

      // If we've reached the target, stop
      if (totalExpectedProfit >= goalParams.monthlyTarget) break;

      // Max 10 simultaneous positions
      if (selected.length >= 10) break;
    }

    // Calculate how many cycles needed per month
    const avgDTE = selected.length > 0
      ? Math.round(selected.reduce((s, c) => s + c.avgDTE, 0) / selected.length)
      : 30;
    const cyclesPerMonth = avgDTE > 0 ? Math.max(1, Math.floor(30 / avgDTE)) : 1;
    const projectedMonthly = totalExpectedProfit * cyclesPerMonth;
    const progressPct = goalParams.monthlyTarget > 0
      ? Math.min((projectedMonthly / goalParams.monthlyTarget) * 100, 150)
      : 0;

    log.info(
      `Portfolio Plan result: ${selected.length} strategies, ` +
      `projected $${projectedMonthly.toFixed(0)}/mo (${progressPct.toFixed(0)}% of target), ` +
      `capital: $${totalCapital.toFixed(0)}, risk: ${totalRisk.toFixed(1)}%`
    );

    res.json({
      success: true,
      data: {
        monthlyTarget: goalParams.monthlyTarget,
        projectedMonthly: Math.round(projectedMonthly),
        progressPct: Math.round(progressPct),
        totalCapitalRequired: Math.round(totalCapital),
        totalRiskPct: parseFloat(totalRisk.toFixed(1)),
        cyclesPerMonth,
        avgDTE,
        symbolsScanned: symbols.length,
        candidatesFound: candidates.length,
        selectedStrategies: selected.map((s, i) => ({
          ...s,
          idx: i,
          capitalRequired: Math.round(s.capitalRequired),
          expectedProfit: Math.round(s.expectedProfit),
        })),
        perSymbol: symbols.map((sym) => {
          const symStrats = selected.filter((s) => s.symbol === sym);
          const result = results.find(
            (r) => r.status === "fulfilled" && r.value.symbol === sym
          );
          const price = result?.status === "fulfilled" ? result.value.price : 0;
          const ivRank = result?.status === "fulfilled" ? result.value.ivRank : 0;
          return {
            symbol: sym,
            price,
            ivRank,
            strategiesSelected: symStrats.length,
            totalProfit: symStrats.reduce((s, c) => s + c.expectedProfit, 0),
          };
        }),
      },
    });
  } catch (err) {
    log.error("Portfolio plan failed", { error: err });
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

interface GoalParams {
  monthlyTarget: number;
  maxRiskPct: number;
  minDTE: number;
  maxDTE: number;
  allowedStrategies: string[];
}

interface AnalysisResult {
  underlyingPrice: number;
  dataSource: string;
  ivRank: number;
  hv30: number;
  chain: any[];
  strategies: RankedStrategy[];
  lambdaCurve: any[];
}

async function runAnalysis(
  symbol: string,
  portfolio: Portfolio,
  goalParams?: GoalParams
): Promise<AnalysisResult> {
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

  let strategies = (result?.payload as RankedStrategy[]) ?? [];

  // ── Apply goal-based filtering ──────────────────────────────
  if (goalParams) {
    const netLiq = portfolio.account.netLiquidation || 50_000;
    const now = Date.now();

    strategies = strategies.filter((s) => {
      // Filter by allowed strategy types
      if (goalParams.allowedStrategies.length > 0 &&
          !goalParams.allowedStrategies.includes(s.strategy.type)) {
        return false;
      }

      // Filter by max risk per trade
      if (goalParams.maxRiskPct > 0) {
        const riskPct = (s.strategy.maxLoss / netLiq) * 100;
        if (riskPct > goalParams.maxRiskPct) return false;
      }

      // Filter by DTE range
      if (goalParams.minDTE > 0 || goalParams.maxDTE > 0) {
        const legDTEs = s.strategy.legs
          .map((l) => {
            if (!l.contract.expiration) return 0;
            const expMs = new Date(l.contract.expiration).getTime();
            return Math.round((expMs - now) / (1000 * 60 * 60 * 24));
          })
          .filter((d) => d > 0);
        const avgDTE = legDTEs.length > 0
          ? legDTEs.reduce((a, b) => a + b, 0) / legDTEs.length
          : 30;
        if (goalParams.minDTE > 0 && avgDTE < goalParams.minDTE) return false;
        if (goalParams.maxDTE > 0 && avgDTE > goalParams.maxDTE) return false;
      }

      return true;
    });

    // Re-rank: boost strategies closer to optimal profit per trade for the monthly target
    if (goalParams.monthlyTarget > 0) {
      const targetPerTrade = goalParams.monthlyTarget / 4; // assume ~4 trades/month
      strategies = strategies.map((s) => {
        const profit = s.strategy.maxProfit === "unlimited"
          ? s.strategy.maxLoss * 1.5
          : s.strategy.maxProfit;
        // Goal alignment: how close is expected profit to target per trade
        const ratio = profit / Math.max(targetPerTrade, 1);
        const goalBonus = ratio >= 0.5 && ratio <= 3
          ? 15 * (1 - Math.abs(1 - ratio) / 2) // max 15pt bonus at ratio=1
          : 0;
        return { ...s, score: s.score + goalBonus };
      }).sort((a, b) => b.score - a.score);
    }

    log.info(
      `Goal filtering: ${strategies.length} strategies after filter ` +
      `(target: $${goalParams.monthlyTarget}/mo, risk: ${goalParams.maxRiskPct}%, ` +
      `DTE: ${goalParams.minDTE}-${goalParams.maxDTE}, types: ${goalParams.allowedStrategies.join(",")})`
    );
  }

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
