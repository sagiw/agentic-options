/**
 * IBKR Portfolio Synchronization — API-First
 *
 * Connects directly to TWS/IB Gateway via the @stoqey/ib library.
 * No browser scraping needed — this is the proper way to get portfolio data.
 *
 * Capabilities:
 *   - Full account summary (net liq, buying power, margin)
 *   - All positions with real-time Greeks
 *   - Option chains with live pricing
 *   - Order placement and status tracking
 *
 * Requirements:
 *   - TWS or IB Gateway running on localhost:7497 (paper) or :7496 (live)
 *   - API connections enabled in TWS: Edit → Global Config → API → Settings
 */

import EventEmitter from "eventemitter3";
import { agentLogger } from "../../utils/logger.js";
import { config } from "../../config/index.js";
import { calculateGreeks } from "../../quant/greeks.js";
import { calculateLambda } from "../../quant/lambda.js";
import { blackScholesPrice, impliedVolatility, type BSParams } from "../../quant/black-scholes.js";
import { roundToTickSize } from "../../utils/tick-size.js";
import type {
  OptionContract,
  OptionChainEntry,
  Greeks,
  OptionType,
} from "../../types/options.js";
import type {
  AccountSummary,
  Position,
  Portfolio,
  PortfolioGreeks,
  AccountTier,
} from "../../types/portfolio.js";
import type { StockQuote, PriceBar } from "../../types/market.js";

const log = agentLogger("ibkr-sync");

/**
 * Parse IBKR date string (YYYYMMDD or YYYYMM) into a proper Date object.
 * new Date("20260320") returns Invalid Date in JavaScript — must parse manually.
 */
function parseIBKRDate(dateStr: string | undefined | null): Date {
  if (!dateStr) return new Date(NaN);
  const s = String(dateStr).trim();
  // YYYYMMDD format (e.g. "20260320")
  if (/^\d{8}$/.test(s)) {
    return new Date(parseInt(s.slice(0, 4)), parseInt(s.slice(4, 6)) - 1, parseInt(s.slice(6, 8)));
  }
  // YYYYMM format (e.g. "202603")
  if (/^\d{6}$/.test(s)) {
    return new Date(parseInt(s.slice(0, 4)), parseInt(s.slice(4, 6)) - 1, 1);
  }
  // Fallback: try standard parsing (ISO, etc.)
  return new Date(s);
}

/** Order status update from IBKR */
export interface OrderStatusUpdate {
  orderId: number;
  status: string;
  filled: number;
  remaining: number;
  avgFillPrice: number;
  errorCode?: number;
  errorMessage?: string;
}

/** Events emitted during sync */
interface SyncEvents {
  connected: () => void;
  disconnected: () => void;
  accountUpdate: (summary: AccountSummary) => void;
  positionsUpdate: (positions: Position[]) => void;
  portfolioReady: (portfolio: Portfolio) => void;
  error: (error: Error) => void;
  orderStatus: (update: OrderStatusUpdate) => void;
}

/**
 * Full portfolio synchronization with IBKR TWS.
 *
 * Usage:
 *   const sync = new PortfolioSync();
 *   await sync.connect();
 *   const portfolio = await sync.getFullPortfolio();
 */
export class PortfolioSync extends EventEmitter<SyncEvents> {
  private ib: any = null;
  private connected = false;
  private nextReqId = 1000;

  // Cached data
  private accountData: Partial<AccountSummary> = {};
  private positions: Map<string, Position> = new Map();
  private quotes: Map<string, StockQuote> = new Map();
  private optionGreeks: Map<number, Greeks> = new Map();

  // ── Order tracking ───────────────────────────────────────────
  private nextOrderId = 0;
  private placedOrderIds: Set<number> = new Set();

  // ── Contract resolution cache ─────────────────────────────
  private chainParamsCache: Map<string, {
    expirations: string[];
    strikes: number[];
    exchange: string;
    cachedAt: number;
  }> = new Map();
  private conIdCache: Map<string, { conId: number; cachedAt: number }> = new Map();
  private readonly CHAIN_CACHE_TTL = 300_000; // 5 minutes

  // ── Live account subscription data ──────────────────────────
  // reqAccountUpdates pushes data continuously — much more reliable
  // than reqAccountSummary which requires an "end" event.
  private liveAccountData: Partial<AccountSummary> = {};
  private liveAccountReady = false;

  // ── Live position data with P&L (from updatePortfolioValue) ─
  // reqPositions only gives contract+qty+avgCost — no market value or P&L.
  // updatePortfolioValue (from reqAccountUpdates) gives the full picture.
  private livePositions: Map<string, Position> = new Map();

  // Reference to @stoqey/ib EventName enum (set during connect)
  private eventNameRef: any = null;

  // Pending request resolvers
  private pendingRequests: Map<number, {
    resolve: (value: any) => void;
    reject: (error: Error) => void;
    data: any[];
  }> = new Map();

  /**
   * Connect to TWS/IB Gateway.
   */
  async connect(): Promise<void> {
    if (this.connected) return;

    log.info(`Connecting to IBKR at ${config.ibkr.host}:${config.ibkr.port}...`);

    try {
      const { IBApi, EventName, SecType, OptionType: IBOptionType } = await import("@stoqey/ib");

      // Store EventName reference for use in other methods (e.g., getOptionNBBO)
      this.eventNameRef = EventName;

      this.ib = new IBApi({
        host: config.ibkr.host,
        port: config.ibkr.port,
        clientId: config.ibkr.clientId,
      });

      // ── Connection Events ───────────────────────────────
      this.ib.on(EventName.connected, () => {
        this.connected = true;
        log.info("✓ Connected to IBKR TWS");
        this.emit("connected");
      });

      this.ib.on(EventName.disconnected, () => {
        this.connected = false;
        log.warn("✗ Disconnected from IBKR TWS");
        this.emit("disconnected");
      });

      this.ib.on(EventName.error, (err: Error, code: number, reqId: number) => {
        // Code 2104/2106/2158 are just informational data farm messages
        if ([2104, 2106, 2158].includes(code)) {
          log.debug(`IBKR info [${code}]: ${err.message}`);
          return;
        }
        log.error(`IBKR error [${code}] reqId=${reqId}: ${err.message}`);

        // If this error is about a placed order, emit orderStatus so tracked orders update
        if (this.placedOrderIds.has(reqId)) {
          log.error(`Order ${reqId} REJECTED by IBKR: [${code}] ${err.message}`);
          this.emit("orderStatus", {
            orderId: reqId,
            status: `Error`,
            filled: 0,
            remaining: 0,
            avgFillPrice: 0,
            errorCode: code,
            errorMessage: err.message,
          });
        }

        const pending = this.pendingRequests.get(reqId);
        if (pending) {
          pending.reject(err);
          this.pendingRequests.delete(reqId);
        }
        this.emit("error", err);
      });

      // ── Order Events ────────────────────────────────────
      this.ib.on(EventName.nextValidId, (orderId: number) => {
        this.nextOrderId = orderId;
        log.info(`Next valid order ID: ${orderId}`);
      });

      this.ib.on(EventName.orderStatus, (
        orderId: number, status: string, filled: number, remaining: number,
        avgFillPrice: number, _permId: number, _parentId: number,
        _lastFillPrice: number, _clientId: number, _whyHeld: string
      ) => {
        log.info(
          `Order ${orderId}: ${status} ` +
          `(filled: ${filled}/${filled + remaining}, avg: $${avgFillPrice})`
        );
        this.emit("orderStatus", { orderId, status, filled, remaining, avgFillPrice });
      });

      // openOrder — IBKR confirms it received the order
      this.ib.on(EventName.openOrder, (
        orderId: number, contract: any, order: any, orderState: any
      ) => {
        log.info(
          `openOrder confirmed: #${orderId} ${order?.action} ${order?.totalQuantity}x ` +
          `${contract?.symbol} ${contract?.secType} ${contract?.strike ?? ""}${contract?.right ?? ""} ` +
          `exp ${contract?.lastTradeDateOrContractMonth ?? "n/a"} — ` +
          `status: ${orderState?.status ?? "?"}`
        );
        // Collect for getOpenOrders query
        const pending = this.pendingRequests.get(-2); // special ID for open orders
        if (pending) {
          pending.data.push({
            orderId,
            symbol: contract?.symbol,
            secType: contract?.secType,
            strike: contract?.strike,
            right: contract?.right,
            expiration: contract?.lastTradeDateOrContractMonth,
            action: order?.action,
            quantity: order?.totalQuantity,
            orderType: order?.orderType,
            limitPrice: order?.lmtPrice,
            status: orderState?.status,
          });
        }
      });

      this.ib.on(EventName.openOrderEnd, () => {
        const pending = this.pendingRequests.get(-2);
        if (pending) {
          pending.resolve(pending.data);
          this.pendingRequests.delete(-2);
        }
      });

      // ── Account Summary Events (one-shot, backup) ────────
      this.ib.on(EventName.accountSummary, (
        reqId: number, account: string, tag: string, value: string, currency: string
      ) => {
        this.handleAccountSummaryTag(account, tag, value, currency);
      });

      this.ib.on(EventName.accountSummaryEnd, (reqId: number) => {
        const pending = this.pendingRequests.get(reqId);
        if (pending) {
          pending.resolve(this.accountData);
          this.pendingRequests.delete(reqId);
        }
      });

      // ── Live Account Updates (subscription, primary) ─────
      // reqAccountUpdates pushes data continuously — no "end"
      // event needed, so it never times out.
      this.ib.on(EventName.updateAccountValue, (
        tag: string, value: string, currency: string, account: string
      ) => {
        this.handleLiveAccountUpdate(account, tag, value, currency);
      });

      // ── Live Portfolio Value Updates ────────────────────
      // reqAccountUpdates also pushes per-position market value and P&L
      // via updatePortfolioValue. This is the ONLY way to get real-time
      // P&L per position — reqPositions does NOT provide market value or P&L.
      this.ib.on(EventName.updatePortfolio, (
        contract: any, pos: number, marketPrice: number, marketValue: number,
        averageCost: number, unrealizedPnL: number, realizedPnL: number,
        accountName: string
      ) => {
        this.handleLivePortfolioValue(
          contract, pos, marketPrice, marketValue,
          averageCost, unrealizedPnL, realizedPnL
        );
      });

      this.ib.on(EventName.accountDownloadEnd, (account: string) => {
        this.liveAccountReady = true;
        log.info(
          `Live account subscription ready for ${account}: ` +
          `Net Liq $${(this.liveAccountData.netLiquidation ?? 0).toLocaleString()}, ` +
          `${this.livePositions.size} positions with P&L`
        );
        this.emit("accountUpdate", this.normalizeAccount(this.liveAccountData));
      });

      // ── Position Events ─────────────────────────────────
      this.ib.on(EventName.position, (
        account: string, contract: any, pos: number, avgCost: number
      ) => {
        this.handlePosition(account, contract, pos, avgCost);
      });

      this.ib.on(EventName.positionEnd, () => {
        const pending = this.pendingRequests.get(-1); // special ID for positions
        if (pending) {
          pending.resolve(Array.from(this.positions.values()));
          this.pendingRequests.delete(-1);
        }
      });

      // ── Market Data Events ──────────────────────────────
      this.ib.on(EventName.tickPrice, (
        reqId: number, tickType: number, price: number, _attribs: any
      ) => {
        this.handleTickPrice(reqId, tickType, price);
      });

      this.ib.on(EventName.tickOptionComputation, (
        reqId: number, tickType: number,
        tickAttrib: number,
        iv: number, delta: number, optPrice: number,
        pvDividend: number, gamma: number, vega: number, theta: number,
        undPrice: number
      ) => {
        this.handleTickOption(reqId, tickType, iv, delta, gamma, vega, theta, undPrice);
      });

      // ── Historical Data Events ──────────────────────────
      this.ib.on(EventName.historicalData, (
        reqId: number, bar: any
      ) => {
        const pending = this.pendingRequests.get(reqId);
        if (pending && bar.date !== "finished") {
          pending.data.push({
            timestamp: new Date(bar.date),
            open: bar.open,
            high: bar.high,
            low: bar.low,
            close: bar.close,
            volume: bar.volume,
          });
        }
      });

      this.ib.on("historicalDataEnd" as any, (reqId: number) => {
        const pending = this.pendingRequests.get(reqId);
        if (pending) {
          pending.resolve(pending.data);
          this.pendingRequests.delete(reqId);
        }
      });

      // Connect
      this.ib.connect();

      // Wait for connection
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Connection timeout (3s)")), 3_000);
        this.ib.once(EventName.connected, () => {
          clearTimeout(timeout);
          resolve();
        });
      });

      // Start live account subscription immediately after connect.
      // This pushes account updates continuously — by the time the
      // first API request arrives, balance data is already available.
      this.startAccountSubscription();

    } catch (err) {
      log.error("Failed to connect to IBKR", { error: err });
      throw err;
    }
  }

  /**
   * Disconnect from TWS.
   */
  async disconnect(): Promise<void> {
    if (this.ib && this.connected) {
      this.ib.disconnect();
      this.connected = false;
      log.info("Disconnected from IBKR");
    }
  }

  // ══════════════════════════════════════════════════════════
  //  PORTFOLIO DATA
  // ══════════════════════════════════════════════════════════

  /**
   * Start a persistent subscription for live account updates.
   * Unlike reqAccountSummary (one-shot, needs "end" event),
   * reqAccountUpdates pushes data continuously and never times out.
   */
  private startAccountSubscription(): void {
    try {
      // Subscribe to account updates — data arrives via updateAccountValue
      this.ib.reqAccountUpdates(true, "");
      log.info("Started live account subscription (reqAccountUpdates)");
    } catch (err) {
      log.error("Failed to start account subscription", { error: String(err) });
    }
  }

  /**
   * Handle a single tag from the live account subscription.
   */
  private handleLiveAccountUpdate(
    account: string, tag: string, value: string, currency: string
  ): void {
    const numValue = parseFloat(value);
    if (isNaN(numValue)) return;

    this.liveAccountData.accountId = account;
    this.liveAccountData.currency = currency;

    switch (tag) {
      case "NetLiquidation":    this.liveAccountData.netLiquidation = numValue; break;
      case "TotalCashValue":    this.liveAccountData.totalCash = numValue; break;
      case "BuyingPower":       this.liveAccountData.buyingPower = numValue; break;
      case "AvailableFunds":    this.liveAccountData.availableFunds = numValue; break;
      case "MaintMarginReq":    this.liveAccountData.marginUsed = numValue; break;
      case "UnrealizedPnL":     this.liveAccountData.unrealizedPnL = numValue; break;
      case "RealizedPnL":       this.liveAccountData.realizedPnL = numValue; break;
    }
  }

  /**
   * Handle per-position market data from the live account subscription.
   * This is the ONLY reliable way to get market value and P&L per position.
   * reqPositions does NOT provide these — only contract, qty, and avgCost.
   */
  private handleLivePortfolioValue(
    contract: any, pos: number, marketPrice: number, marketValue: number,
    averageCost: number, unrealizedPnL: number, realizedPnL: number
  ): void {
    const isOption = contract.secType === "OPT";
    const key = `${contract.symbol}-${contract.secType}-${contract.strike ?? 0}-${contract.right ?? ""}-${contract.lastTradeDateOrContractMonth ?? ""}`;

    const position: Position = {
      contract: isOption
        ? {
            symbol: contract.localSymbol ?? contract.symbol,
            underlying: contract.symbol,
            type: (contract.right === "C" ? "call" : "put") as OptionType,
            style: "american" as const,
            strike: contract.strike ?? 0,
            expiration: parseIBKRDate(contract.lastTradeDateOrContractMonth),
            multiplier: parseInt(contract.multiplier ?? "100", 10),
            exchange: contract.exchange ?? "SMART",
            conId: contract.conId,
          }
        : {
            symbol: contract.symbol,
            exchange: contract.exchange ?? "SMART",
            type: "stock" as const,
          },
      quantity: pos,
      averageCost: averageCost,
      marketValue: marketValue,
      unrealizedPnL: unrealizedPnL,
      realizedPnL: realizedPnL,
    };

    this.livePositions.set(key, position);

    log.debug(
      `Portfolio update: ${contract.symbol} ${contract.secType} ` +
      `${contract.strike ?? ""} ${contract.right ?? ""} — ` +
      `qty: ${pos}, mktVal: $${marketValue.toFixed(2)}, ` +
      `uPnL: $${unrealizedPnL.toFixed(2)}`
    );
  }

  /**
   * Get account summary — prefers live subscription data, falls back to one-shot request.
   *
   * Priority:
   *   1. Live subscription data (reqAccountUpdates — always up-to-date)
   *   2. One-shot request (reqAccountSummary — backup, can time out)
   *   3. Default account ($0) — last resort
   */
  async getAccountSummary(): Promise<AccountSummary> {
    this.ensureConnected();

    // ── 1. Try live subscription data first ──────────────────
    if (this.liveAccountReady && (this.liveAccountData.netLiquidation ?? 0) > 0) {
      log.info(
        `Using live account data: $${(this.liveAccountData.netLiquidation ?? 0).toLocaleString()}`
      );
      return this.normalizeAccount(this.liveAccountData);
    }

    // ── 2. Wait briefly for subscription to arrive ───────────
    // On first load, the subscription might not have fired yet.
    // Give it up to 5 seconds before falling back.
    if (!this.liveAccountReady) {
      log.info("Waiting for live account subscription data...");
      const gotLive = await this.waitForLiveAccount(5_000);
      if (gotLive && (this.liveAccountData.netLiquidation ?? 0) > 0) {
        log.info(
          `Live subscription arrived: $${(this.liveAccountData.netLiquidation ?? 0).toLocaleString()}`
        );
        return this.normalizeAccount(this.liveAccountData);
      }
    }

    // ── 3. Fallback: one-shot reqAccountSummary ──────────────
    log.warn("Live subscription data unavailable — trying one-shot reqAccountSummary");
    return this.requestAccountSummaryOneShot();
  }

  /**
   * Wait for the live account subscription to produce data.
   */
  private waitForLiveAccount(timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      if (this.liveAccountReady) return resolve(true);

      const checkInterval = setInterval(() => {
        if (this.liveAccountReady) {
          clearInterval(checkInterval);
          clearTimeout(timeout);
          resolve(true);
        }
      }, 200);

      const timeout = setTimeout(() => {
        clearInterval(checkInterval);
        resolve(false);
      }, timeoutMs);
    });
  }

  /**
   * One-shot reqAccountSummary (backup — can time out if "end" event doesn't arrive).
   */
  private requestAccountSummaryOneShot(): Promise<AccountSummary> {
    const reqId = this.nextReqId++;

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(reqId, { resolve, reject, data: [] });

      this.ib.reqAccountSummary(
        reqId,
        "All",
        [
          "NetLiquidation", "TotalCashValue", "BuyingPower",
          "AvailableFunds", "MaintMarginReq", "UnrealizedPnL",
          "RealizedPnL", "AccountType",
        ].join(",")
      );

      // Timeout — increased from 15s to 30s
      setTimeout(() => {
        if (this.pendingRequests.has(reqId)) {
          this.ib.cancelAccountSummary(reqId);
          this.pendingRequests.delete(reqId);

          // Even if the one-shot timed out, check if live data arrived in the meantime
          if ((this.liveAccountData.netLiquidation ?? 0) > 0) {
            log.warn("One-shot timed out, but live subscription data is available — using it");
            resolve(this.normalizeAccount(this.liveAccountData));
          } else {
            reject(new Error("Account summary request timed out (30s) and no live data available"));
          }
        }
      }, 30_000);
    });
  }

  /**
   * Get all positions in the account.
   */
  async getPositions(): Promise<Position[]> {
    this.ensureConnected();

    return new Promise((resolve, reject) => {
      this.positions.clear();
      this.pendingRequests.set(-1, { resolve, reject, data: [] });
      this.ib.reqPositions();

      setTimeout(() => {
        if (this.pendingRequests.has(-1)) {
          this.pendingRequests.delete(-1);
          // Return whatever we have
          resolve(Array.from(this.positions.values()));
        }
      }, 10_000);
    });
  }

  /**
   * Get historical daily prices for VaR calculation.
   */
  async getHistoricalPrices(symbol: string, days: number = 252): Promise<PriceBar[]> {
    this.ensureConnected();
    const reqId = this.nextReqId++;
    const { SecType } = await import("@stoqey/ib");

    const contract = {
      symbol,
      secType: SecType.STK,
      exchange: "SMART",
      currency: "USD",
    };

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(reqId, { resolve, reject, data: [] });

      this.ib.reqHistoricalData(
        reqId,
        contract,
        "", // end date (empty = now)
        `${days} D`,
        "1 day",
        "TRADES",
        1, // use RTH
        1, // format dates as strings
        false // keep up to date
      );

      setTimeout(() => {
        if (this.pendingRequests.has(reqId)) {
          const pending = this.pendingRequests.get(reqId)!;
          this.pendingRequests.delete(reqId);
          resolve(pending.data);
        }
      }, 30_000);
    });
  }

  /**
   * Request real-time market data for a symbol.
   * Returns a reqId that can be used to cancel the subscription.
   */
  requestMarketData(symbol: string, secType: string = "STK"): number {
    this.ensureConnected();
    const reqId = this.nextReqId++;

    const contract: any = {
      symbol,
      secType,
      exchange: "SMART",
      currency: "USD",
    };

    // Generic tick list: 106 = implied volatility
    this.ib.reqMktData(reqId, contract, "106", false, false);
    return reqId;
  }

  /**
   * Resolve the IBKR conId for a stock symbol using reqContractDetails.
   * This is required by reqSecDefOptParams (conId=0 causes error 321).
   */
  async resolveConId(symbol: string): Promise<number> {
    // Check cache first
    const cached = this.conIdCache.get(symbol);
    if (cached && Date.now() - cached.cachedAt < this.CHAIN_CACHE_TTL) {
      return cached.conId;
    }

    this.ensureConnected();
    const reqId = this.nextReqId++;

    return new Promise((resolve, reject) => {
      let resolved = false;

      const onDetails = (_reqId: number, details: any) => {
        if (_reqId === reqId && !resolved) {
          resolved = true;
          const conId = details?.contract?.conId ?? details?.conId ?? 0;
          log.info(`Resolved conId for ${symbol}: ${conId}`);
          this.conIdCache.set(symbol, { conId, cachedAt: Date.now() });
          this.ib.removeListener("contractDetails", onDetails);
          this.ib.removeListener("contractDetailsEnd", onEnd);
          resolve(conId);
        }
      };

      const onEnd = (_reqId: number) => {
        if (_reqId === reqId && !resolved) {
          resolved = true;
          this.ib.removeListener("contractDetails", onDetails);
          this.ib.removeListener("contractDetailsEnd", onEnd);
          reject(new Error(`No contract details found for ${symbol}`));
        }
      };

      this.ib.on("contractDetails", onDetails);
      this.ib.on("contractDetailsEnd", onEnd);

      this.ib.reqContractDetails(reqId, {
        symbol,
        secType: "STK" as any,
        exchange: "SMART",
        currency: "USD",
      });

      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          this.ib.removeListener("contractDetails", onDetails);
          this.ib.removeListener("contractDetailsEnd", onEnd);
          reject(new Error(`Timeout resolving conId for ${symbol}`));
        }
      }, 10_000);
    });
  }

  /**
   * Request option chain parameters (available strikes + expirations).
   * First resolves the underlying stock's conId, which IBKR requires.
   */
  async getOptionChainParams(symbol: string): Promise<{
    expirations: string[];
    strikes: number[];
    exchange: string;
  }> {
    this.ensureConnected();

    // Step 1: Get the real conId for the underlying stock
    const conId = await this.resolveConId(symbol);
    log.info(`Using conId ${conId} for ${symbol} option chain request`);

    const reqId = this.nextReqId++;

    return new Promise((resolve, reject) => {
      const results: { expirations: Set<string>; strikes: Set<number>; exchange: string } = {
        expirations: new Set(),
        strikes: new Set(),
        exchange: "SMART",
      };

      const onParam = (
        _reqId: number, exchange: string, underlyingConId: number,
        tradingClass: string, multiplier: string | number,
        expirations: string[] | Set<string>, strikes: number[] | Set<number>
      ) => {
        if (_reqId !== reqId) return;
        results.exchange = exchange;
        const expArr = Array.isArray(expirations) ? expirations : Array.from(expirations);
        const strkArr = Array.isArray(strikes) ? strikes : Array.from(strikes);
        log.info(`[ChainParams] Exchange=${exchange} tradingClass=${tradingClass} expirations=${expArr.length} strikes=${strkArr.length}`);
        expArr.forEach((e: string) => results.expirations.add(e));
        strkArr.forEach((s: number) => results.strikes.add(s));
      };

      const onEnd = (_reqId: number) => {
        if (_reqId !== reqId) return;
        cleanup();
        const finalExps = Array.from(results.expirations).sort();
        const finalStrikes = Array.from(results.strikes).sort((a, b) => a - b);
        log.info(`[ChainParams] DONE: ${finalExps.length} expirations, ${finalStrikes.length} strikes total`);
        if (finalStrikes.length <= 30) {
          log.info(`[ChainParams] All strikes: ${finalStrikes.join(", ")}`);
        } else {
          log.info(`[ChainParams] Strike range: ${finalStrikes[0]} - ${finalStrikes[finalStrikes.length - 1]}`);
        }
        resolve({
          expirations: finalExps,
          strikes: finalStrikes,
          exchange: results.exchange,
        });
      };

      const cleanup = () => {
        this.ib.removeListener("securityDefinitionOptionParameter" as any, onParam);
        this.ib.removeListener("securityDefinitionOptionParameterEnd" as any, onEnd);
      };

      this.ib.on("securityDefinitionOptionParameter" as any, onParam);
      this.ib.on("securityDefinitionOptionParameterEnd" as any, onEnd);

      this.ib.reqSecDefOptParams(reqId, symbol, "", "STK", conId);

      setTimeout(() => {
        cleanup();
        reject(new Error("Option chain params timeout"));
      }, 15_000);
    });
  }

  /**
   * Build a full portfolio snapshot with Greeks and risk metrics.
   *
   * Prefers live positions (from updatePortfolioValue) which include
   * market value and unrealized P&L. Falls back to reqPositions which
   * only gives contract + qty + avgCost (P&L will be 0).
   */
  async getFullPortfolio(): Promise<Portfolio> {
    log.info("Building full portfolio snapshot...");

    const [accountSummary, barePositions] = await Promise.all([
      this.getAccountSummary().catch((err) => {
        log.warn("Account summary failed, using defaults", { error: String(err) });
        return this.buildDefaultAccount();
      }),
      this.getPositions().catch((err) => {
        log.warn("Positions fetch failed", { error: String(err) });
        return [] as Position[];
      }),
    ]);

    const account = this.normalizeAccount(accountSummary);

    // ── Prefer live positions (with P&L) over bare reqPositions (without P&L) ──
    // updatePortfolioValue gives us: marketValue, unrealizedPnL, realizedPnL
    // reqPositions only gives us: contract, quantity, averageCost
    let positions: Position[];
    if (this.livePositions.size > 0) {
      positions = Array.from(this.livePositions.values());
      log.info(
        `Using ${positions.length} live positions with P&L data ` +
        `(total uPnL: $${positions.reduce((s, p) => s + p.unrealizedPnL, 0).toFixed(2)})`
      );
    } else if (barePositions.length > 0) {
      positions = barePositions;
      log.warn(
        `Using ${barePositions.length} bare positions from reqPositions — ` +
        `P&L will be $0 (live subscription data not yet available)`
      );
    } else {
      positions = [];
    }

    // Aggregate portfolio Greeks
    const greeks = this.aggregatePortfolioGreeks(positions);

    log.info(
      `Portfolio loaded: ${positions.length} positions, ` +
      `Net Liq: $${account.netLiquidation.toLocaleString()}`
    );

    return {
      account,
      positions,
      greeks,
      var: {
        var: 0,
        confidenceLevel: 0.95,
        horizon: 1,
        cvar: 0,
        method: "historical",
        stressTests: [],
      },
      lastUpdated: new Date(),
    };
  }

  // ══════════════════════════════════════════════════════════
  //  NBBO SNAPSHOT (for order price validation)
  // ══════════════════════════════════════════════════════════

  /**
   * Request a snapshot of the current NBBO (National Best Bid and Offer)
   * for an option contract. Returns bid, ask, mid, and last price.
   *
   * Used before order submission to ensure limit prices are within
   * IBKR's acceptable range — prevents "Limit price too far outside
   * of NBBO" rejections.
   *
   * Returns null if data is unavailable within the timeout.
   */
  async getOptionNBBO(params: {
    symbol: string;
    strike: number;
    right: "C" | "P";
    expiration: string; // YYYYMMDD
    exchange?: string;
  }): Promise<{ bid: number; ask: number; mid: number; last: number; delayed?: boolean } | null> {
    if (!this.connected) return null;

    const reqId = this.nextReqId++;
    const prices: { bid: number; ask: number; last: number; close: number; isDelayed: boolean } = {
      bid: 0, ask: 0, last: 0, close: 0, isDelayed: false,
    };

    const contract: any = {
      symbol: params.symbol,
      secType: "OPT",
      exchange: params.exchange || "SMART",
      currency: "USD",
      strike: params.strike,
      right: params.right,
      lastTradeDateOrContractMonth: params.expiration,
      multiplier: "100",
    };

    const tag = `${params.symbol} ${params.strike}${params.right} exp ${params.expiration}`;
    log.info(`NBBO snapshot request [${reqId}]: ${tag}`);

    // ── Request delayed-frozen data type so we get prices even when market is closed ──
    // MarketDataType: 1=REALTIME, 2=FROZEN, 3=DELAYED, 4=DELAYED_FROZEN
    // DELAYED_FROZEN returns the last known frozen data if delayed is not available
    try {
      this.ib.reqMarketDataType(4);
      log.info(`NBBO [${reqId}]: Set market data type to DELAYED_FROZEN (4)`);
    } catch (err) {
      log.warn(`NBBO [${reqId}]: Failed to set market data type: ${err}`);
    }

    return new Promise((resolve) => {
      let resolved = false;

      const finalize = () => {
        // Restore to real-time data type after request
        try { this.ib.reqMarketDataType(1); } catch {}
      };

      const resolveWith = () => {
        const refPrice = prices.last || prices.close || 0;
        const bid = prices.bid || (refPrice > 0 ? refPrice * 0.95 : 0);
        const ask = prices.ask || (refPrice > 0 ? refPrice * 1.05 : 0);
        if (bid > 0 || ask > 0) {
          const mid = Math.round(((bid + ask) / 2) * 100) / 100;
          log.info(
            `NBBO [${reqId}] ${tag}: bid=$${bid} ask=$${ask} mid=$${mid} last=$${refPrice}` +
            (prices.isDelayed ? " (DELAYED)" : " (LIVE)")
          );
          resolve({ bid, ask, mid, last: refPrice, delayed: prices.isDelayed });
        } else {
          log.warn(`NBBO [${reqId}] ${tag}: no usable prices`);
          resolve(null);
        }
      };

      const onTick = (_reqId: number, tickType: number, price: number) => {
        if (_reqId !== reqId || resolved) return;
        if (price <= 0 || price === -1) return;

        // Real-time ticks: 1=bid, 2=ask, 4=last, 6=high, 7=low, 9=close
        // Delayed ticks:   66=bid, 67=ask, 68=last, 75=close
        if (tickType === 1) prices.bid = price;
        else if (tickType === 2) prices.ask = price;
        else if (tickType === 4) prices.last = price;
        else if (tickType === 9) prices.close = price;
        else if (tickType === 66) { prices.bid = price; prices.isDelayed = true; }
        else if (tickType === 67) { prices.ask = price; prices.isDelayed = true; }
        else if (tickType === 68) { prices.last = price; prices.isDelayed = true; }
        else if (tickType === 75) { prices.close = price; prices.isDelayed = true; }
        else return; // ignore unrelated tick types

        log.info(`NBBO [${reqId}] tick: type=${tickType} price=${price}`);

        // Resolve as soon as we have both bid and ask
        if (prices.bid > 0 && prices.ask > 0) {
          resolved = true;
          cleanup();
          finalize();
          resolveWith();
        }
      };

      // ── Handle tickSnapshotEnd (only fires in snapshot mode, kept as safety) ──
      const onSnapshotEnd = (_reqId: number) => {
        if (_reqId !== reqId || resolved) return;
        resolved = true;
        cleanup();
        finalize();
        if (prices.bid > 0 || prices.ask > 0 || prices.last > 0 || prices.close > 0) {
          resolveWith();
        } else {
          log.warn(`NBBO [${reqId}] ${tag}: snapshotEnd with no data`);
          resolve(null);
        }
      };

      // ── Handle IBKR error events ──
      const onError = (_reqId: number, errorCode: number, errorMsg: string) => {
        if (_reqId !== reqId || resolved) return;
        // Non-fatal informational messages
        // 2104, 2106, 2158 = market data farm connection messages
        // 2119 = market data farm is connecting
        // 10167 = "Displaying delayed data" — expected when market closed
        if ([2104, 2106, 2119, 2158, 10167].includes(errorCode)) {
          if (errorCode === 10167) {
            log.info(`NBBO [${reqId}] ${tag}: IBKR switched to delayed data`);
            prices.isDelayed = true;
          }
          return;
        }

        log.warn(`NBBO [${reqId}] ${tag}: IBKR error ${errorCode}: ${errorMsg}`);
        // Fatal errors: 200=no contract, 354/10168=no data subscription, 162=historical error
        if ([200, 354, 10168, 162, 10187, 10090].includes(errorCode)) {
          resolved = true;
          cleanup();
          finalize();
          resolve(null);
        }
      };

      const cleanup = () => {
        const EN = this.eventNameRef!;
        this.ib.removeListener(EN.tickPrice, onTick);
        this.ib.removeListener(EN.tickSnapshotEnd, onSnapshotEnd);
        this.ib.removeListener(EN.error, onError);
        try { this.ib.cancelMktData(reqId); } catch {}
      };

      // Register listeners
      const EventNameRef = this.eventNameRef!;
      this.ib.on(EventNameRef.tickPrice, onTick);
      this.ib.on(EventNameRef.tickSnapshotEnd, onSnapshotEnd);
      this.ib.on(EventNameRef.error, onError);

      // ── Use STREAMING mode (snapshot=false) ──
      // Snapshot mode doesn't return delayed data when market is closed.
      // Streaming mode with DELAYED_FROZEN will send delayed ticks (66,67,68,75).
      // We cancel the subscription once we have enough data.
      try {
        this.ib.reqMktData(reqId, contract, "", false, false);
      } catch (err) {
        log.warn(`NBBO [${reqId}] reqMktData failed: ${err}`);
        cleanup();
        finalize();
        resolve(null);
        return;
      }

      // ── Settle timer: after 3s, if we have any data, resolve with it ──
      // This handles the case where only partial data (e.g., last but no bid/ask) arrives.
      setTimeout(() => {
        if (!resolved && (prices.bid > 0 || prices.ask > 0 || prices.last > 0 || prices.close > 0)) {
          resolved = true;
          cleanup();
          finalize();
          log.info(`NBBO [${reqId}] ${tag}: settling with partial data after 3s`);
          resolveWith();
        }
      }, 3_000);

      // ── Hard timeout: 8s, resolve with whatever we have ──
      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          cleanup();
          finalize();
          if (prices.bid > 0 || prices.ask > 0 || prices.last > 0 || prices.close > 0) {
            log.info(`NBBO [${reqId}] ${tag}: timeout with partial data`);
            resolveWith();
          } else {
            log.warn(`NBBO [${reqId}] ${tag}: timeout — no data received`);
            resolve(null);
          }
        }
      }, 8_000);
    });
  }

  // ══════════════════════════════════════════════════════════
  //  OPTION CHAIN BATCH — fetch NBBO for many options at once
  // ══════════════════════════════════════════════════════════

  /**
   * Fetch NBBO for a batch of options in parallel.
   * Each option gets its own reqMktData stream with independent
   * listeners, timeouts, and cleanup.  Market data type is set to
   * DELAYED_FROZEN once before the batch and restored afterwards.
   *
   * @param requests Array of {symbol, strike, right, expiration}
   * @param concurrency Max simultaneous IBKR reqMktData calls (default 50)
   * @returns Map of "strike-right" → {bid,ask,mid,last,delayed} | null
   */
  async getOptionChainBatch(
    requests: Array<{
      symbol: string;
      strike: number;
      right: "C" | "P";
      expiration: string;
      exchange?: string;
    }>,
    concurrency = 50,
  ): Promise<
    Map<string, { bid: number; ask: number; mid: number; last: number; delayed?: boolean } | null>
  > {
    const results = new Map<
      string,
      { bid: number; ask: number; mid: number; last: number; delayed?: boolean } | null
    >();

    if (!this.connected || requests.length === 0) return results;

    log.info(`[ChainBatch] Starting batch of ${requests.length} requests (concurrency=${concurrency})`);

    // Set delayed-frozen once for the entire batch
    try { this.ib.reqMarketDataType(4); } catch {}

    // Process in chunks to respect IBKR concurrent data line limits
    let successCount = 0;
    let nullCount = 0;
    for (let i = 0; i < requests.length; i += concurrency) {
      const chunk = requests.slice(i, i + concurrency);
      log.info(`[ChainBatch] Processing chunk ${Math.floor(i / concurrency) + 1}: ${chunk.length} requests`);
      const promises = chunk.map(async (req) => {
        const key = `${req.strike}-${req.right}`;
        try {
          const data = await this.getOptionNBBOInternal(req);
          results.set(key, data);
          if (data) { successCount++; } else { nullCount++; }
        } catch (err) {
          log.warn(`[ChainBatch] Error for ${key}: ${err}`);
          results.set(key, null);
          nullCount++;
        }
      });
      await Promise.all(promises);
    }

    log.info(`[ChainBatch] Done: ${successCount} with data, ${nullCount} null/failed out of ${requests.length} total`);

    // Restore real-time data type
    try { this.ib.reqMarketDataType(1); } catch {}

    return results;
  }

  /**
   * Internal NBBO fetch without changing the MarketDataType.
   * Used by getOptionChainBatch so it only sets the type once.
   */
  private async getOptionNBBOInternal(params: {
    symbol: string;
    strike: number;
    right: "C" | "P";
    expiration: string;
    exchange?: string;
  }): Promise<{ bid: number; ask: number; mid: number; last: number; delayed?: boolean } | null> {
    const reqId = this.nextReqId++;
    const prices = { bid: 0, ask: 0, last: 0, close: 0, isDelayed: false };

    const contract: any = {
      symbol: params.symbol,
      secType: "OPT",
      exchange: params.exchange || "SMART",
      currency: "USD",
      strike: params.strike,
      right: params.right,
      lastTradeDateOrContractMonth: params.expiration,
      multiplier: "100",
    };

    return new Promise((resolve) => {
      let resolved = false;

      const resolveWith = () => {
        const refPrice = prices.last || prices.close || 0;
        const bid = prices.bid || (refPrice > 0 ? refPrice * 0.95 : 0);
        const ask = prices.ask || (refPrice > 0 ? refPrice * 1.05 : 0);
        if (bid > 0 || ask > 0) {
          const mid = Math.round(((bid + ask) / 2) * 100) / 100;
          resolve({ bid, ask, mid, last: refPrice, delayed: prices.isDelayed });
        } else {
          resolve(null);
        }
      };

      const onTick = (_reqId: number, tickType: number, price: number) => {
        if (_reqId !== reqId || resolved) return;
        if (price <= 0 || price === -1) return;
        if (tickType === 1) prices.bid = price;
        else if (tickType === 2) prices.ask = price;
        else if (tickType === 4) prices.last = price;
        else if (tickType === 9) prices.close = price;
        else if (tickType === 66) { prices.bid = price; prices.isDelayed = true; }
        else if (tickType === 67) { prices.ask = price; prices.isDelayed = true; }
        else if (tickType === 68) { prices.last = price; prices.isDelayed = true; }
        else if (tickType === 75) { prices.close = price; prices.isDelayed = true; }
        else return;

        if (prices.bid > 0 && prices.ask > 0) {
          resolved = true;
          cleanup();
          resolveWith();
        }
      };

      const onSnapshotEnd = (_reqId: number) => {
        if (_reqId !== reqId || resolved) return;
        resolved = true;
        cleanup();
        resolveWith();
      };

      const onError = (_reqId: number, errorCode: number, _errorMsg: string) => {
        if (_reqId !== reqId || resolved) return;
        if ([2104, 2106, 2119, 2158, 10167].includes(errorCode)) {
          if (errorCode === 10167) prices.isDelayed = true;
          return;
        }
        if ([200, 354, 10168, 162, 10187, 10090].includes(errorCode)) {
          resolved = true;
          cleanup();
          resolve(null);
        }
      };

      const cleanup = () => {
        const EN = this.eventNameRef!;
        this.ib.removeListener(EN.tickPrice, onTick);
        this.ib.removeListener(EN.tickSnapshotEnd, onSnapshotEnd);
        this.ib.removeListener(EN.error, onError);
        try { this.ib.cancelMktData(reqId); } catch {}
      };

      const EventNameRef = this.eventNameRef!;
      this.ib.on(EventNameRef.tickPrice, onTick);
      this.ib.on(EventNameRef.tickSnapshotEnd, onSnapshotEnd);
      this.ib.on(EventNameRef.error, onError);

      try {
        // Use snapshot=true for batch queries — avoids consuming IBKR streaming data lines
        this.ib.reqMktData(reqId, contract, "", true, false);
      } catch {
        cleanup();
        resolve(null);
        return;
      }

      // Settle after 3s with partial data
      setTimeout(() => {
        if (!resolved && (prices.bid > 0 || prices.ask > 0 || prices.last > 0 || prices.close > 0)) {
          resolved = true;
          cleanup();
          resolveWith();
        }
      }, 3_000);

      // Hard timeout 8s
      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          cleanup();
          if (prices.bid > 0 || prices.ask > 0 || prices.last > 0 || prices.close > 0) {
            resolveWith();
          } else {
            resolve(null);
          }
        }
      }, 8_000);
    });
  }

  // ══════════════════════════════════════════════════════════
  //  STOCK QUOTE (snapshot)
  // ══════════════════════════════════════════════════════════

  /**
   * Get a stock quote via reqMktData snapshot.
   * Tries real-time first; on error 10089 (subscription required),
   * automatically retries with delayed market data (type 3).
   */
  async getStockQuote(symbol: string): Promise<{ last: number; bid: number; ask: number; close: number; delayed: boolean } | null> {
    // Try real-time first, then fall back to delayed on 10089
    log.info(`[StockQuote] Requesting real-time quote for ${symbol}...`);
    const result = await this._stockQuoteSnapshot(symbol, false);
    if (result) {
      log.info(`[StockQuote] ${symbol} real-time: last=${result.last} bid=${result.bid} ask=${result.ask} close=${result.close}`);
      return result;
    }

    // Retry with delayed market data
    log.info(`[StockQuote] No real-time data for ${symbol}, retrying with delayed data...`);
    const delayed = await this._stockQuoteSnapshot(symbol, true);
    if (delayed) {
      log.info(`[StockQuote] ${symbol} delayed: last=${delayed.last} bid=${delayed.bid} ask=${delayed.ask} close=${delayed.close}`);
    } else {
      log.warn(`[StockQuote] ${symbol} — no data at all (neither real-time nor delayed)`);
    }
    return delayed;
  }

  private async _stockQuoteSnapshot(
    symbol: string,
    useDelayed: boolean
  ): Promise<{ last: number; bid: number; ask: number; close: number; delayed: boolean } | null> {
    this.ensureConnected();
    const reqId = this.nextReqId++;
    const prices = { bid: 0, ask: 0, last: 0, close: 0, isDelayed: useDelayed };

    const contract: any = {
      symbol,
      secType: "STK",
      exchange: "SMART",
      currency: "USD",
    };

    // Explicitly set market data type: 1=REALTIME, 3=DELAYED
    // Must set explicitly since other methods may leave it in type 4 (delayed-frozen)
    try { this.ib.reqMarketDataType(useDelayed ? 3 : 1); } catch {}

    return new Promise((resolve) => {
      let resolved = false;
      let got10089 = false;

      const resolveWith = () => {
        // Always restore real-time mode
        try { this.ib.reqMarketDataType(1); } catch {}
        const price = prices.last || prices.close || ((prices.bid + prices.ask) / 2);
        if (price > 0) {
          resolve({ last: prices.last, bid: prices.bid, ask: prices.ask, close: prices.close, delayed: prices.isDelayed });
        } else {
          resolve(null);
        }
      };

      const onTick = (_reqId: number, tickType: number, price: number) => {
        if (_reqId !== reqId || resolved) return;
        if (price <= 0 || price === -1) return;
        if (tickType === 1) prices.bid = price;
        else if (tickType === 2) prices.ask = price;
        else if (tickType === 4) prices.last = price;
        else if (tickType === 9) prices.close = price;
        else if (tickType === 66) { prices.bid = price; prices.isDelayed = true; }
        else if (tickType === 67) { prices.ask = price; prices.isDelayed = true; }
        else if (tickType === 68) { prices.last = price; prices.isDelayed = true; }
        else if (tickType === 75) { prices.close = price; prices.isDelayed = true; }
        else return;

        if (prices.last > 0 && prices.bid > 0 && prices.ask > 0) {
          resolved = true;
          cleanup();
          resolveWith();
        }
      };

      const onSnapshotEnd = (_reqId: number) => {
        if (_reqId !== reqId || resolved) return;
        resolved = true;
        cleanup();
        resolveWith();
      };

      const onError = (_reqId: number, errorCode: number, errorMsg: string) => {
        if (_reqId !== reqId || resolved) return;
        if ([2104, 2106, 2119, 2158, 10167].includes(errorCode)) {
          if (errorCode === 10167) prices.isDelayed = true;
          return;
        }
        // 10089 = subscription required, delayed available — abort this attempt
        if (errorCode === 10089) {
          log.info(`[StockQuote] ${symbol} error 10089 (useDelayed=${useDelayed}): ${errorMsg}`);
          got10089 = true;
          if (!useDelayed) {
            resolved = true;
            cleanup();
            resolve(null); // caller will retry with delayed
          }
          return;
        }
        log.warn(`[StockQuote] ${symbol} error ${errorCode} (useDelayed=${useDelayed}): ${errorMsg}`);
        resolved = true;
        cleanup();
        resolve(null);
      };

      const cleanup = () => {
        const EN = this.eventNameRef!;
        this.ib.removeListener(EN.tickPrice, onTick);
        this.ib.removeListener(EN.tickSnapshotEnd, onSnapshotEnd);
        this.ib.removeListener(EN.error, onError);
        try { this.ib.cancelMktData(reqId); } catch {}
      };

      const EventNameRef = this.eventNameRef!;
      this.ib.on(EventNameRef.tickPrice, onTick);
      this.ib.on(EventNameRef.tickSnapshotEnd, onSnapshotEnd);
      this.ib.on(EventNameRef.error, onError);

      try {
        this.ib.reqMktData(reqId, contract, "", true, false);
      } catch {
        cleanup();
        try { this.ib.reqMarketDataType(1); } catch {}
        resolve(null);
        return;
      }

      // Settle after 3s with partial data
      setTimeout(() => {
        if (!resolved && (prices.bid > 0 || prices.ask > 0 || prices.last > 0 || prices.close > 0)) {
          resolved = true;
          cleanup();
          resolveWith();
        }
      }, 3_000);

      // Hard timeout 5s
      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          cleanup();
          try { this.ib.reqMarketDataType(1); } catch {}
          if (prices.bid > 0 || prices.ask > 0 || prices.last > 0 || prices.close > 0) {
            resolveWith();
          } else {
            resolve(null);
          }
        }
      }, 5_000);
    });
  }

  // ══════════════════════════════════════════════════════════
  //  CONTRACT ID RESOLUTION (for combo orders)
  // ══════════════════════════════════════════════════════════

  /**
   * Resolve the IBKR conId for a specific option contract.
   * Required for combo/BAG orders — each leg needs its conId.
   */
  async resolveOptionConId(params: {
    symbol: string;
    strike: number;
    right: "C" | "P";
    expiration: string; // YYYYMMDD
    exchange?: string;
  }): Promise<number | null> {
    if (!this.connected) return null;

    const cacheKey = `${params.symbol}-${params.strike}-${params.right}-${params.expiration}`;
    const cached = this.conIdCache.get(cacheKey);
    if (cached && Date.now() - cached.cachedAt < this.CHAIN_CACHE_TTL) {
      return cached.conId;
    }

    const reqId = this.nextReqId++;

    return new Promise((resolve) => {
      let resolved = false;

      const contract: any = {
        symbol: params.symbol,
        secType: "OPT",
        exchange: params.exchange || "SMART",
        currency: "USD",
        strike: params.strike,
        right: params.right,
        lastTradeDateOrContractMonth: params.expiration,
        multiplier: "100",
      };

      const onDetails = (_reqId: number, details: any) => {
        if (_reqId !== reqId || resolved) return;
        resolved = true;
        const conId = details?.contract?.conId ?? details?.conId ?? 0;
        if (conId > 0) {
          this.conIdCache.set(cacheKey, { conId, cachedAt: Date.now() });
          log.info(
            `Resolved option conId: ${params.symbol} ${params.strike}${params.right} ` +
            `exp ${params.expiration} → conId ${conId}`
          );
        }
        this.ib.removeListener("contractDetails", onDetails);
        this.ib.removeListener("contractDetailsEnd", onEnd);
        resolve(conId > 0 ? conId : null);
      };

      const onEnd = (_reqId: number) => {
        if (_reqId !== reqId || resolved) return;
        resolved = true;
        this.ib.removeListener("contractDetails", onDetails);
        this.ib.removeListener("contractDetailsEnd", onEnd);
        log.warn(`No conId found for ${params.symbol} ${params.strike}${params.right}`);
        resolve(null);
      };

      this.ib.on("contractDetails", onDetails);
      this.ib.on("contractDetailsEnd", onEnd);

      try {
        this.ib.reqContractDetails(reqId, contract);
      } catch (err) {
        log.warn(`reqContractDetails failed for option: ${err}`);
        this.ib.removeListener("contractDetails", onDetails);
        this.ib.removeListener("contractDetailsEnd", onEnd);
        resolve(null);
        return;
      }

      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          this.ib.removeListener("contractDetails", onDetails);
          this.ib.removeListener("contractDetailsEnd", onEnd);
          log.warn(`Timeout resolving option conId for ${params.symbol} ${params.strike}${params.right}`);
          resolve(null);
        }
      }, 8_000);
    });
  }

  // ══════════════════════════════════════════════════════════
  //  ORDER PLACEMENT
  // ══════════════════════════════════════════════════════════

  /**
   * Place a combo (BAG) order — all legs execute atomically.
   * This prevents partial fills where one leg executes but the other doesn't.
   *
   * Each leg needs a conId (resolved via resolveOptionConId).
   * The net limit price is the combined debit/credit for the whole combo.
   */
  async placeComboOrder(params: {
    symbol: string;       // Underlying symbol (e.g. "AAPL")
    legs: Array<{
      conId: number;
      action: "BUY" | "SELL";
      ratio: number;      // Usually 1
      exchange?: string;
    }>;
    action: "BUY" | "SELL";  // Net direction of the combo
    quantity: number;
    orderType: "LMT" | "MKT";
    limitPrice?: number;      // Net combo price (debit = positive, credit = negative)
  }): Promise<number> {
    this.ensureConnected();

    if (this.nextOrderId <= 0) {
      throw new Error("No valid order ID from IBKR — wait for connection to fully initialize");
    }

    const orderId = this.nextOrderId++;

    // Build BAG contract with combo legs
    const contract: any = {
      symbol: params.symbol,
      secType: "BAG",
      exchange: "SMART",
      currency: "USD",
      comboLegs: params.legs.map(leg => ({
        conId: leg.conId,
        ratio: leg.ratio,
        action: leg.action,
        exchange: leg.exchange || "SMART",
        openClose: 0,  // 0 = same as parent (retail)
      })),
    };

    // Build order
    const order: any = {
      action: params.action,
      totalQuantity: params.quantity,
      orderType: params.orderType === "LMT" ? "LMT" : "MKT",
      tif: "DAY",
      transmit: true,
    };

    if (params.orderType === "LMT" && params.limitPrice !== undefined) {
      // For combo orders, the limit price is the net debit (positive) or credit (negative)
      order.lmtPrice = Math.round(params.limitPrice * 100) / 100;
    }

    log.info(
      `Placing COMBO order ${orderId}: ${params.action} ${params.quantity}x ${params.symbol} ` +
      `(${params.legs.length} legs) @ ${params.orderType}` +
      `${params.limitPrice !== undefined ? ` net $${params.limitPrice.toFixed(2)}` : ""}`
    );
    log.info(`  Combo legs: ${JSON.stringify(contract.comboLegs)}`);
    log.info(`  Order: ${JSON.stringify(order)}`);

    this.placedOrderIds.add(orderId);

    try {
      this.ib.placeOrder(orderId, contract, order);
      log.info(`  placeComboOrder(${orderId}) call completed — awaiting IBKR acknowledgment`);
    } catch (err) {
      log.error(`  placeComboOrder(${orderId}) threw: ${String(err)}`);
      throw err;
    }

    return orderId;
  }

  /**
   * Place an option or stock order through IBKR TWS.
   * Returns the IBKR order ID.
   */
  async placeOrder(params: {
    symbol: string;
    secType: "OPT" | "STK";
    strike?: number;
    right?: "C" | "P";
    expiration?: string; // YYYYMMDD
    exchange?: string;
    action: "BUY" | "SELL";
    quantity: number;
    orderType: "LMT" | "MKT";
    limitPrice?: number;
  }): Promise<number> {
    this.ensureConnected();

    if (this.nextOrderId <= 0) {
      throw new Error("No valid order ID from IBKR — wait for connection to fully initialize");
    }

    const orderId = this.nextOrderId++;

    // Build IBKR Contract object
    const contract: any = {
      symbol: params.symbol,
      secType: params.secType,
      exchange: params.exchange || "SMART",
      currency: "USD",
    };

    if (params.secType === "OPT") {
      contract.strike = params.strike;
      contract.right = params.right;
      contract.lastTradeDateOrContractMonth = params.expiration;
      contract.multiplier = "100";
    }

    // Build IBKR Order object
    const order: any = {
      action: params.action,
      totalQuantity: params.quantity,
      orderType: params.orderType === "LMT" ? "LMT" : "MKT",
      tif: "DAY",
      transmit: true,
    };

    if (params.orderType === "LMT" && params.limitPrice !== undefined) {
      // Round to valid tick size as final safety net.
      // IBKR rejects orders with prices that don't conform to minimum price variation.
      const isOpt = params.secType === "OPT";
      const rounded = roundToTickSize(params.limitPrice, params.symbol, !isOpt);
      if (rounded !== params.limitPrice) {
        log.info(
          `  Tick-size safety net: $${params.limitPrice} → $${rounded} ` +
          `(${params.symbol} ${isOpt ? "option" : "stock"})`
        );
      }
      order.lmtPrice = rounded;
    }

    log.info(
      `Placing IBKR order ${orderId}: ${params.action} ${params.quantity}x ` +
      `${params.symbol} ${params.strike ?? ""}${params.right ?? ""} ` +
      `exp ${params.expiration ?? "n/a"} ` +
      `@ ${params.orderType}${params.limitPrice ? ` $${params.limitPrice}` : ""}`
    );
    log.info(`  Contract: ${JSON.stringify(contract)}`);
    log.info(`  Order:    ${JSON.stringify(order)}`);

    this.placedOrderIds.add(orderId);

    try {
      this.ib.placeOrder(orderId, contract, order);
      log.info(`  placeOrder(${orderId}) call completed — awaiting IBKR acknowledgment`);
    } catch (err) {
      log.error(`  placeOrder(${orderId}) threw: ${String(err)}`);
      throw err;
    }

    return orderId;
  }

  /**
   * Query IBKR for all currently open orders.
   * This is the definitive check — if an order was actually received
   * by IBKR, it will appear here.
   */
  async getOpenOrders(): Promise<any[]> {
    this.ensureConnected();

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(-2, { resolve, reject, data: [] });

      // reqAllOpenOrders returns orders from ALL clients (not just ours)
      // reqOpenOrders returns only orders placed by our clientId
      this.ib.reqAllOpenOrders();

      // Timeout after 10s — resolve with whatever we have
      setTimeout(() => {
        const pending = this.pendingRequests.get(-2);
        if (pending) {
          this.pendingRequests.delete(-2);
          resolve(pending.data);
        }
      }, 10_000);
    });
  }

  /**
   * Query IBKR for recent trade executions and commissions.
   * Uses reqExecutions with an optional time filter.
   * Returns execution details including fill price, commission, and realized P&L.
   */
  async getExecutions(daysBack: number = 7): Promise<any[]> {
    this.ensureConnected();
    const EventNameRef = this.eventNameRef!;

    return new Promise((resolve) => {
      const executions: any[] = [];
      const commissions = new Map<string, any>(); // execId → commission data

      const onExecDetails = (reqId: number, contract: any, execution: any) => {
        if (reqId !== -3) return;
        executions.push({
          execId: execution?.execId,
          orderId: execution?.orderId,
          symbol: contract?.symbol,
          secType: contract?.secType,
          strike: contract?.strike,
          right: contract?.right,
          expiration: contract?.lastTradeDateOrContractMonth,
          side: execution?.side,
          quantity: execution?.shares || execution?.cumQty,
          price: execution?.price || execution?.avgPrice,
          time: execution?.time,
          exchange: execution?.exchange,
          account: execution?.acctNumber,
          commission: 0,
          realizedPnL: 0,
        });
      };

      const onCommissionReport = (report: any) => {
        if (report?.execId) {
          commissions.set(report.execId, {
            commission: report.commission,
            currency: report.currency,
            realizedPnL: report.realizedPnL,
          });
        }
      };

      const onExecDetailsEnd = (reqId: number) => {
        if (reqId !== -3) return;
        // Merge commissions into executions
        for (const exec of executions) {
          const comm = commissions.get(exec.execId);
          if (comm) {
            exec.commission = comm.commission ?? 0;
            exec.realizedPnL = comm.realizedPnL ?? 0;
          }
        }
        cleanup();
        resolve(executions);
      };

      const cleanup = () => {
        this.ib.removeListener(EventNameRef.execDetails, onExecDetails);
        this.ib.removeListener(EventNameRef.execDetailsEnd, onExecDetailsEnd);
        this.ib.removeListener(EventNameRef.commissionReport, onCommissionReport);
      };

      this.ib.on(EventNameRef.execDetails, onExecDetails);
      this.ib.on(EventNameRef.execDetailsEnd, onExecDetailsEnd);
      this.ib.on(EventNameRef.commissionReport, onCommissionReport);

      // Build time filter: "yyyyMMdd-HH:mm:ss" format
      const fromDate = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000);
      const timeFilter = `${fromDate.getFullYear()}${String(fromDate.getMonth() + 1).padStart(2, "0")}${String(fromDate.getDate()).padStart(2, "0")}-00:00:00`;

      // reqExecutions(reqId, filter)
      this.ib.reqExecutions(-3, {
        time: timeFilter,
      });

      // Timeout after 15s
      setTimeout(() => {
        cleanup();
        // Merge what we have
        for (const exec of executions) {
          const comm = commissions.get(exec.execId);
          if (comm) {
            exec.commission = comm.commission ?? 0;
            exec.realizedPnL = comm.realizedPnL ?? 0;
          }
        }
        resolve(executions);
      }, 15_000);
    });
  }

  /**
   * Query IBKR for completed orders (filled/cancelled).
   *
   * Unlike reqExecutions (which only returns today's executions),
   * reqCompletedOrders returns orders that have reached a terminal state
   * (filled, cancelled) over recent days — typically up to a week.
   *
   * Each completed order includes full contract details, order parameters,
   * fill price, quantity, and completion time/status.
   *
   * @param apiOnly - If true, only return orders placed via the API (not TWS manual orders)
   * @returns Array of completed order records with contract, order, and state info
   */
  async getCompletedOrders(apiOnly: boolean = false): Promise<any[]> {
    this.ensureConnected();
    const EventNameRef = this.eventNameRef!;

    return new Promise((resolve) => {
      const orders: any[] = [];

      const onCompletedOrder = (contract: any, order: any, orderState: any) => {
        // Extract useful fields from the completed order
        const isOption = contract?.secType === "OPT";
        orders.push({
          orderId: order?.orderId ?? order?.permId,
          permId: order?.permId,
          symbol: contract?.symbol,
          secType: contract?.secType,
          strike: isOption ? contract?.strike : undefined,
          right: isOption ? contract?.right : undefined,
          expiration: isOption ? contract?.lastTradeDateOrContractMonth : undefined,
          exchange: contract?.exchange || contract?.primaryExch,
          action: order?.action, // BUY or SELL
          totalQuantity: order?.totalQuantity,
          orderType: order?.orderType, // LMT, MKT, etc.
          lmtPrice: order?.lmtPrice,
          auxPrice: order?.auxPrice,
          filledQuantity: order?.filledQuantity ?? order?.totalQuantity,
          avgFillPrice: orderState?.avgFillPrice ?? order?.lmtPrice,
          status: orderState?.status, // Filled, Cancelled, etc.
          completedTime: orderState?.completedTime || order?.completedTime,
          completedStatus: orderState?.completedStatus || orderState?.status,
          commission: orderState?.commission ?? 0,
          realizedPnL: orderState?.realizedPnL ?? 0,
          // Combo legs for multi-leg orders
          comboLegs: contract?.comboLegs?.map((leg: any) => ({
            conId: leg.conId,
            ratio: leg.ratio,
            action: leg.action,
            exchange: leg.exchange,
          })) || [],
        });
      };

      const onCompletedOrdersEnd = () => {
        cleanup();
        resolve(orders);
      };

      const cleanup = () => {
        this.ib.removeListener(EventNameRef.completedOrder, onCompletedOrder);
        this.ib.removeListener(EventNameRef.completedOrdersEnd, onCompletedOrdersEnd);
      };

      this.ib.on(EventNameRef.completedOrder, onCompletedOrder);
      this.ib.on(EventNameRef.completedOrdersEnd, onCompletedOrdersEnd);

      // Request completed orders
      this.ib.reqCompletedOrders(apiOnly);

      // Timeout after 15s
      setTimeout(() => {
        cleanup();
        resolve(orders);
      }, 15_000);
    });
  }

  // ══════════════════════════════════════════════════════════
  //  CONTRACT RESOLUTION
  // ══════════════════════════════════════════════════════════

  /**
   * Resolve a synthetic option contract against IBKR's real option chain.
   * Finds the nearest valid expiration and strike that actually exist in the market.
   */
  async resolveOptionContract(
    symbol: string,
    syntheticStrike: number,
    syntheticExpiration: Date
  ): Promise<{ strike: number; expiration: string } | null> {
    try {
      // Get real chain params (with caching)
      const now = Date.now();
      let cached = this.chainParamsCache.get(symbol);

      if (!cached || now - cached.cachedAt > this.CHAIN_CACHE_TTL) {
        log.info(`Fetching real option chain params for ${symbol} from IBKR...`);
        const fresh = await this.getOptionChainParams(symbol);
        cached = { ...fresh, cachedAt: now };
        this.chainParamsCache.set(symbol, cached);
        log.info(
          `${symbol} chain: ${cached.expirations.length} expirations, ` +
          `${cached.strikes.length} strikes (${cached.exchange})`
        );
      }

      if (!cached.expirations.length || !cached.strikes.length) {
        log.warn(`No valid expirations/strikes found for ${symbol}`);
        return null;
      }

      // ── Find nearest valid expiration ───────────────────
      const targetMs = syntheticExpiration.getTime();
      let nearestExp = cached.expirations[0];
      let minExpDiff = Infinity;

      for (const exp of cached.expirations) {
        const year = parseInt(exp.slice(0, 4));
        const month = parseInt(exp.slice(4, 6)) - 1;
        const day = parseInt(exp.slice(6, 8));
        const expMs = new Date(year, month, day).getTime();
        const diff = Math.abs(expMs - targetMs);
        if (diff < minExpDiff) {
          minExpDiff = diff;
          nearestExp = exp;
        }
      }

      // ── Find nearest valid strike ──────────────────────
      let nearestStrike = cached.strikes[0];
      let minStrikeDiff = Infinity;

      for (const strike of cached.strikes) {
        const diff = Math.abs(strike - syntheticStrike);
        if (diff < minStrikeDiff) {
          minStrikeDiff = diff;
          nearestStrike = strike;
        }
      }

      log.info(
        `Resolved ${symbol}: ` +
        `strike ${syntheticStrike} → ${nearestStrike}, ` +
        `exp ${syntheticExpiration.toISOString().slice(0, 10)} → ${nearestExp}`
      );

      return { strike: nearestStrike, expiration: nearestExp };
    } catch (err) {
      log.error(`Failed to resolve contract for ${symbol}: ${err}`);
      return null;
    }
  }

  // ══════════════════════════════════════════════════════════
  //  EVENT HANDLERS
  // ══════════════════════════════════════════════════════════

  private handleAccountSummaryTag(
    account: string, tag: string, value: string, currency: string
  ): void {
    const numValue = parseFloat(value);
    this.accountData.accountId = account;
    this.accountData.currency = currency;

    switch (tag) {
      case "NetLiquidation": this.accountData.netLiquidation = numValue; break;
      case "TotalCashValue": this.accountData.totalCash = numValue; break;
      case "BuyingPower": this.accountData.buyingPower = numValue; break;
      case "AvailableFunds": this.accountData.availableFunds = numValue; break;
      case "MaintMarginReq": this.accountData.marginUsed = numValue; break;
      case "UnrealizedPnL": this.accountData.unrealizedPnL = numValue; break;
      case "RealizedPnL": this.accountData.realizedPnL = numValue; break;
    }
  }

  private handlePosition(
    account: string, contract: any, pos: number, avgCost: number
  ): void {
    const key = `${contract.symbol}-${contract.secType}-${contract.strike ?? 0}`;
    const liveKey = `${contract.symbol}-${contract.secType}-${contract.strike ?? 0}-${contract.right ?? ""}-${contract.lastTradeDateOrContractMonth ?? ""}`;

    // Check if we already have live data with P&L for this position
    const liveData = this.livePositions.get(liveKey);

    const isOption = contract.secType === "OPT";
    const position: Position = {
      contract: isOption
        ? {
            symbol: contract.localSymbol ?? contract.symbol,
            underlying: contract.symbol,
            type: (contract.right === "C" ? "call" : "put") as OptionType,
            style: "american" as const,
            strike: contract.strike ?? 0,
            expiration: parseIBKRDate(contract.lastTradeDateOrContractMonth),
            multiplier: parseInt(contract.multiplier ?? "100", 10),
            exchange: contract.exchange ?? "SMART",
            conId: contract.conId,
          }
        : {
            symbol: contract.symbol,
            exchange: contract.exchange ?? "SMART",
            type: "stock" as const,
          },
      quantity: pos,
      averageCost: avgCost,
      // Use live data if available, otherwise 0 (reqPositions doesn't provide these)
      marketValue: liveData?.marketValue ?? 0,
      unrealizedPnL: liveData?.unrealizedPnL ?? 0,
      realizedPnL: liveData?.realizedPnL ?? 0,
    };

    this.positions.set(key, position);
  }

  private handleTickPrice(reqId: number, tickType: number, price: number): void {
    // tickType: 1=bid, 2=ask, 4=last, 6=high, 7=low, 9=close
    // Store for later use
  }

  private handleTickOption(
    reqId: number, tickType: number,
    iv: number, delta: number, gamma: number,
    vega: number, theta: number, undPrice: number
  ): void {
    if (delta !== -2) { // -2 means "not computed"
      this.optionGreeks.set(reqId, { delta, gamma, theta, vega, rho: 0 });
    }
  }

  // ══════════════════════════════════════════════════════════
  //  HELPERS
  // ══════════════════════════════════════════════════════════

  private normalizeAccount(raw: any): AccountSummary {
    const netLiq = raw.netLiquidation ?? 0;
    let tier: AccountTier = "small";
    if (netLiq >= 100_000) tier = "large";
    else if (netLiq >= 10_000) tier = "medium";

    return {
      accountId: raw.accountId ?? "unknown",
      currency: raw.currency ?? "USD",
      netLiquidation: netLiq,
      totalCash: raw.totalCash ?? 0,
      buyingPower: raw.buyingPower ?? 0,
      availableFunds: raw.availableFunds ?? 0,
      marginUsed: raw.marginUsed ?? 0,
      marginType: netLiq >= 100_000 ? "portfolio_margin" : "reg_t",
      unrealizedPnL: raw.unrealizedPnL ?? 0,
      realizedPnL: raw.realizedPnL ?? 0,
      tier,
    };
  }

  private aggregatePortfolioGreeks(positions: Position[]): PortfolioGreeks {
    let totalDelta = 0, totalGamma = 0, totalTheta = 0, totalVega = 0;

    for (const pos of positions) {
      if (pos.greeks) {
        const mult = pos.quantity * (
          "multiplier" in pos.contract ? (pos.contract as OptionContract).multiplier : 1
        );
        totalDelta += pos.greeks.delta * mult;
        totalGamma += pos.greeks.gamma * mult;
        totalTheta += pos.greeks.theta * mult;
        totalVega += pos.greeks.vega * mult;
      }
    }

    return {
      totalDelta,
      totalGamma,
      totalTheta,
      totalVega,
      betaWeightedDelta: totalDelta, // TODO: beta-weight against SPY
    };
  }

  private buildDefaultAccount(): AccountSummary {
    return {
      accountId: "PAPER",
      currency: "USD",
      netLiquidation: 0,
      totalCash: 0,
      buyingPower: 0,
      availableFunds: 0,
      marginUsed: 0,
      marginType: "reg_t",
      unrealizedPnL: 0,
      realizedPnL: 0,
      tier: "small",
    };
  }

  private ensureConnected(): void {
    if (!this.connected) {
      throw new Error("Not connected to IBKR. Call connect() first.");
    }
  }

  get isConnected(): boolean {
    return this.connected;
  }

  /** Whether the live account subscription has delivered data */
  get hasLiveAccountData(): boolean {
    return this.liveAccountReady && (this.liveAccountData.netLiquidation ?? 0) > 0;
  }

  /** Current live net liquidation value (0 if not yet received) */
  get liveNetLiquidation(): number {
    return this.liveAccountData.netLiquidation ?? 0;
  }

  /** Whether IBKR has provided a valid order ID (needed for placing orders) */
  get hasValidOrderId(): boolean {
    return this.nextOrderId > 0;
  }
}
