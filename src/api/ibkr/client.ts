/**
 * Interactive Brokers TWS API Client
 *
 * Wraps @stoqey/ib for type-safe access to IBKR's Trader Workstation.
 * Handles connection management, reconnection, and event streaming.
 *
 * Connection modes:
 *   - Port 7496: Live trading
 *   - Port 7497: Paper trading (default for development)
 */

import { EventEmitter } from "eventemitter3";
import { agentLogger } from "../../utils/logger.js";
import { config } from "../../config/index.js";
import type {
  OptionChain,
  OptionChainEntry,
  Greeks,
  OptionContract,
} from "../../types/options.js";
import type { AccountSummary, Position } from "../../types/portfolio.js";
import type { StockQuote, PriceBar } from "../../types/market.js";

const log = agentLogger("ibkr");

/** IBKR connection states */
type ConnectionState = "disconnected" | "connecting" | "connected" | "error";

/** Events emitted by the IBKR client */
interface IBKREvents {
  connected: () => void;
  disconnected: (reason: string) => void;
  error: (error: Error) => void;
  accountUpdate: (summary: AccountSummary) => void;
  positionUpdate: (position: Position) => void;
  quoteUpdate: (quote: StockQuote) => void;
  greeksUpdate: (contractId: number, greeks: Greeks) => void;
  orderStatus: (orderId: number, status: string) => void;
}

export class IBKRClient extends EventEmitter<IBKREvents> {
  private state: ConnectionState = "disconnected";
  private ib: unknown = null; // @stoqey/ib instance
  private nextReqId: number = 1;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  /** Current connection state */
  get connectionState(): ConnectionState {
    return this.state;
  }

  /**
   * Connect to TWS/IB Gateway.
   * Retries with exponential backoff on failure.
   */
  async connect(): Promise<void> {
    if (this.state === "connected") {
      log.warn("Already connected to IBKR");
      return;
    }

    this.state = "connecting";
    log.info(
      `Connecting to IBKR at ${config.ibkr.host}:${config.ibkr.port} ` +
      `(clientId: ${config.ibkr.clientId})`
    );

    try {
      // Dynamic import for @stoqey/ib
      const { IBApi, EventName } = await import("@stoqey/ib");

      this.ib = new IBApi({
        host: config.ibkr.host,
        port: config.ibkr.port,
        clientId: config.ibkr.clientId,
      });

      const ibApi = this.ib as InstanceType<typeof IBApi>;

      // Register event handlers
      ibApi.on(EventName.connected, () => {
        this.state = "connected";
        log.info("Connected to IBKR TWS");
        this.emit("connected");
      });

      ibApi.on(EventName.disconnected, () => {
        this.state = "disconnected";
        log.warn("Disconnected from IBKR TWS");
        this.emit("disconnected", "connection_lost");
        this.scheduleReconnect();
      });

      ibApi.on(EventName.error, (err: Error) => {
        log.error("IBKR API error", { error: err.message });
        this.emit("error", err);
      });

      // Connect
      ibApi.connect();

      // Wait for connection confirmation
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error("IBKR connection timeout"));
        }, 10_000);

        ibApi.once(EventName.connected, () => {
          clearTimeout(timeout);
          resolve();
        });
      });
    } catch (err) {
      this.state = "error";
      log.error("Failed to connect to IBKR", { error: err });
      this.scheduleReconnect();
      throw err;
    }
  }

  /**
   * Disconnect from TWS.
   */
  async disconnect(): Promise<void> {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.ib) {
      (this.ib as { disconnect(): void }).disconnect();
    }

    this.state = "disconnected";
    log.info("Disconnected from IBKR");
  }

  // ─── Account & Portfolio ──────────────────────────────────

  /**
   * Request account summary.
   * Returns current balances, margin, and P&L.
   */
  async getAccountSummary(): Promise<AccountSummary> {
    this.ensureConnected();
    const reqId = this.nextReqId++;

    log.info("Requesting account summary...");

    // In production: use ibApi.reqAccountSummary()
    // Scaffold: return structured mock
    return {
      accountId: `U${config.ibkr.clientId}`,
      currency: "USD",
      netLiquidation: 0,
      totalCash: 0,
      buyingPower: 0,
      availableFunds: 0,
      marginUsed: 0,
      marginType: "reg_t",
      unrealizedPnL: 0,
      realizedPnL: 0,
      tier: "medium",
    };
  }

  /**
   * Request all current positions.
   */
  async getPositions(): Promise<Position[]> {
    this.ensureConnected();
    log.info("Requesting positions...");

    // In production: use ibApi.reqPositions()
    return [];
  }

  // ─── Market Data ──────────────────────────────────────────

  /**
   * Request real-time quote for a symbol.
   */
  async getQuote(symbol: string): Promise<StockQuote> {
    this.ensureConnected();
    const reqId = this.nextReqId++;

    log.info(`Requesting quote for ${symbol}`);

    // In production: use ibApi.reqMktData() with contract
    return {
      symbol,
      price: 0,
      bid: 0,
      ask: 0,
      volume: 0,
      high: 0,
      low: 0,
      open: 0,
      previousClose: 0,
      timestamp: new Date(),
    };
  }

  /**
   * Request historical price data.
   */
  async getHistoricalData(
    symbol: string,
    duration: string = "1 Y",
    barSize: string = "1 day"
  ): Promise<PriceBar[]> {
    this.ensureConnected();
    const reqId = this.nextReqId++;

    log.info(`Requesting historical data for ${symbol}: ${duration}, ${barSize}`);

    // In production: use ibApi.reqHistoricalData()
    return [];
  }

  // ─── Options ──────────────────────────────────────────────

  /**
   * Request option chain for an underlying.
   * Returns all available expirations and strikes.
   */
  async getOptionChain(symbol: string): Promise<{
    expirations: string[];
    strikes: number[];
  }> {
    this.ensureConnected();
    const reqId = this.nextReqId++;

    log.info(`Requesting option chain for ${symbol}`);

    // In production: use ibApi.reqSecDefOptParams()
    return { expirations: [], strikes: [] };
  }

  /**
   * Subscribe to real-time Greeks stream for an option contract.
   * IBKR provides model-computed Greeks (delta, gamma, vega, theta, IV).
   */
  subscribeGreeks(contract: OptionContract): number {
    this.ensureConnected();
    const reqId = this.nextReqId++;

    log.info(
      `Subscribing to Greeks for ${contract.symbol} ` +
      `${contract.strike}${contract.type[0].toUpperCase()} ` +
      `exp:${contract.expiration.toISOString().slice(0, 10)}`
    );

    // In production: use ibApi.reqMktData() with genericTickList="106"
    // Tick 106 = implied volatility
    // Option model ticks: 10=bid, 11=ask, 13=model, etc.

    return reqId;
  }

  /**
   * Unsubscribe from a market data stream.
   */
  unsubscribeMarketData(reqId: number): void {
    if (this.ib) {
      (this.ib as { cancelMktData(id: number): void }).cancelMktData(reqId);
    }
  }

  // ─── Order Management ─────────────────────────────────────

  /**
   * Place an order.
   * This is only called after human-in-the-loop approval.
   */
  async placeOrder(
    contract: OptionContract,
    side: "buy" | "sell",
    quantity: number,
    orderType: "market" | "limit",
    limitPrice?: number
  ): Promise<number> {
    this.ensureConnected();
    const orderId = this.nextReqId++;

    log.info(
      `Placing order: ${side} ${quantity}x ${contract.symbol} ` +
      `@ ${orderType}${limitPrice ? ` $${limitPrice}` : ""}`
    );

    // In production: construct IB Contract + Order objects and call ibApi.placeOrder()

    return orderId;
  }

  /**
   * Cancel an open order.
   */
  async cancelOrder(orderId: number): Promise<void> {
    this.ensureConnected();
    log.info(`Cancelling order ${orderId}`);

    // In production: ibApi.cancelOrder(orderId)
  }

  // ─── Internals ────────────────────────────────────────────

  private ensureConnected(): void {
    if (this.state !== "connected") {
      throw new Error(
        `IBKR not connected (state: ${this.state}). Call connect() first.`
      );
    }
  }

  private scheduleReconnect(delayMs: number = 5000): void {
    if (this.reconnectTimer) return;

    log.info(`Scheduling reconnect in ${delayMs}ms...`);
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        await this.connect();
      } catch {
        // Exponential backoff (max 60s)
        this.scheduleReconnect(Math.min(delayMs * 2, 60_000));
      }
    }, delayMs);
  }
}

/** Singleton IBKR client */
export const ibkrClient = new IBKRClient();
