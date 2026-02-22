/**
 * IBKR Real-Time Data Streams
 *
 * Manages subscriptions to live market data, Greeks, and order updates.
 * Uses an event-driven architecture to push data to the Quant Analyst.
 */

import { EventEmitter } from "eventemitter3";
import { agentLogger } from "../../utils/logger.js";
import { ibkrClient } from "./client.js";
import type { OptionContract, Greeks } from "../../types/options.js";
import type { StockQuote } from "../../types/market.js";

const log = agentLogger("ibkr-streams");

interface StreamEvents {
  quote: (symbol: string, quote: StockQuote) => void;
  greeks: (contractSymbol: string, greeks: Greeks) => void;
  iv: (contractSymbol: string, iv: number) => void;
  error: (error: Error) => void;
}

export class IBKRStreamManager extends EventEmitter<StreamEvents> {
  private activeSubscriptions: Map<string, number> = new Map();

  /**
   * Subscribe to real-time quotes for an underlying.
   */
  subscribeQuote(symbol: string): void {
    if (this.activeSubscriptions.has(`quote:${symbol}`)) {
      log.debug(`Already subscribed to ${symbol} quotes`);
      return;
    }

    log.info(`Subscribing to ${symbol} quotes`);

    // In production: call ibkrClient methods that return reqIds
    // and set up event forwarding
    const reqId = Date.now(); // placeholder
    this.activeSubscriptions.set(`quote:${symbol}`, reqId);
  }

  /**
   * Subscribe to real-time Greeks for an option contract.
   */
  subscribeGreeks(contract: OptionContract): void {
    const key = `greeks:${contract.symbol}`;
    if (this.activeSubscriptions.has(key)) return;

    log.info(`Subscribing to Greeks for ${contract.symbol}`);
    const reqId = ibkrClient.subscribeGreeks(contract);
    this.activeSubscriptions.set(key, reqId);
  }

  /**
   * Unsubscribe from all data streams.
   */
  unsubscribeAll(): void {
    log.info(`Unsubscribing from ${this.activeSubscriptions.size} streams`);
    for (const [key, reqId] of this.activeSubscriptions) {
      ibkrClient.unsubscribeMarketData(reqId);
    }
    this.activeSubscriptions.clear();
  }

  /**
   * Get count of active subscriptions.
   */
  get subscriptionCount(): number {
    return this.activeSubscriptions.size;
  }
}

export const streamManager = new IBKRStreamManager();
