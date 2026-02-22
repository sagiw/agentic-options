/**
 * IBKR Order Routing
 *
 * Translates OptionsStrategy objects into IBKR-compatible orders.
 * Submits through the connected PortfolioSync instance (which holds
 * the live IBApi connection and valid order IDs).
 *
 * Each leg is submitted as an individual limit order.
 * Future: multi-leg combo/BAG orders for tighter fills.
 */

import { agentLogger } from "../../utils/logger.js";
import { roundToTickSize } from "../../utils/tick-size.js";
import type { PortfolioSync } from "./portfolio-sync.js";
import type { OptionsStrategy, StrategyLeg } from "../../types/options.js";

const log = agentLogger("ibkr-orders");

/** Result of submitting a strategy to IBKR */
export interface SubmitResult {
  success: boolean;
  orderIds: number[];
  legs: number;
  message: string;
}

/**
 * Submit a complete options strategy as IBKR order(s).
 *
 * Each leg is submitted as an individual limit order.
 * Returns the IBKR order IDs for status tracking.
 */
export async function submitStrategy(
  ibkr: PortfolioSync,
  strategy: OptionsStrategy,
  orderType: "LMT" | "MKT" = "LMT"
): Promise<SubmitResult> {
  log.info(`Submitting strategy: ${strategy.name} (${strategy.legs.length} legs)`);

  if (!ibkr.isConnected) {
    return {
      success: false,
      orderIds: [],
      legs: strategy.legs.length,
      message: "IBKR not connected — order saved locally only",
    };
  }

  if (!ibkr.hasValidOrderId) {
    return {
      success: false,
      orderIds: [],
      legs: strategy.legs.length,
      message: "IBKR not ready — no valid order ID yet. Try again in a moment.",
    };
  }

  const orderIds: number[] = [];
  const errors: string[] = [];

  for (const leg of strategy.legs) {
    try {
      const orderId = await submitLeg(ibkr, leg, orderType);
      orderIds.push(orderId);
      log.info(
        `Leg submitted: order ${orderId} — ` +
        `${leg.side} ${leg.quantity}x ${leg.contract.symbol}`
      );
    } catch (err) {
      const msg = `Failed to submit leg ${leg.side} ${leg.contract.symbol}: ${String(err)}`;
      log.error(msg);
      errors.push(msg);
    }
  }

  if (orderIds.length === 0) {
    return {
      success: false,
      orderIds: [],
      legs: strategy.legs.length,
      message: `All legs failed: ${errors.join("; ")}`,
    };
  }

  return {
    success: true,
    orderIds,
    legs: strategy.legs.length,
    message:
      orderIds.length === strategy.legs.length
        ? `All ${orderIds.length} leg(s) submitted to IBKR`
        : `${orderIds.length}/${strategy.legs.length} legs submitted (${errors.length} failed)`,
  };
}

/**
 * Submit a single leg to IBKR.
 *
 * Before placing the order, resolves the synthetic contract against IBKR's
 * real option chain — mapping fake expirations and strikes to actual ones
 * that exist in the market. Without this step, IBKR silently rejects the order
 * because the synthetic dates (21/45/75 DTE) don't match real expirations
 * (typically 3rd Friday of month or weekly).
 */
async function submitLeg(
  ibkr: PortfolioSync,
  leg: StrategyLeg,
  orderType: "LMT" | "MKT"
): Promise<number> {
  const isOption = leg.contract.type === "call" || leg.contract.type === "put";
  const underlying = isOption
    ? (leg.contract as any).underlying ?? leg.contract.symbol
    : leg.contract.symbol;

  let strike = isOption ? leg.contract.strike : undefined;
  let expiration = isOption ? formatExpiration(leg.contract.expiration) : undefined;
  const right: "C" | "P" | undefined = isOption
    ? (leg.contract.type === "call" ? "C" : "P")
    : undefined;

  // Resolve synthetic contract against IBKR's real option chain
  if (isOption && ibkr.isConnected) {
    log.info(
      `Resolving synthetic contract: ${underlying} ${strike}${right} ` +
      `exp ${expiration} → real IBKR chain`
    );
    const resolved = await ibkr.resolveOptionContract(
      underlying,
      strike!,
      leg.contract.expiration
    );
    if (resolved) {
      const oldStrike = strike;
      const oldExp = expiration;
      strike = resolved.strike;
      expiration = resolved.expiration;
      log.info(
        `Resolved: strike ${oldStrike} → ${strike}, ` +
        `exp ${oldExp} → ${expiration}`
      );
    } else {
      log.warn(
        `Could not resolve real contract for ${underlying} — ` +
        `using synthetic params (order may be rejected by IBKR)`
      );
    }
  }

  // Round limit price to valid tick size to avoid IBKR rejection:
  // "The price does not conform to the minimum price variation for this contract."
  const rawPrice = leg.price ?? 0;
  let tickRoundedPrice = isOption
    ? roundToTickSize(rawPrice, underlying)
    : roundToTickSize(rawPrice, underlying, true);

  if (rawPrice !== tickRoundedPrice) {
    log.info(
      `Tick size adjustment: $${rawPrice.toFixed(4)} → $${tickRoundedPrice.toFixed(2)} ` +
      `(${underlying} ${isOption ? "option" : "stock"})`
    );
  }

  // ── NBBO validation: clamp limit price to actual market bid/ask ──
  // Without this, Black-Scholes theoretical prices can be far from the
  // real NBBO, causing IBKR to reject with "Limit price too far outside of NBBO".
  if (isOption && strike && right && expiration && orderType === "LMT") {
    try {
      const nbbo = await ibkr.getOptionNBBO({
        symbol: underlying,
        strike: strike!,
        right: right!,
        expiration: expiration!,
        exchange: leg.contract.exchange || "SMART",
      });

      if (nbbo && nbbo.bid > 0 && nbbo.ask > 0) {
        const oldPrice = tickRoundedPrice;
        const spread = nbbo.ask - nbbo.bid;

        if (leg.side === "buy") {
          // BUY: use mid-price (or theoretical if within NBBO spread).
          // Never exceed ask, never go below bid.
          if (tickRoundedPrice > nbbo.ask * 1.05 || tickRoundedPrice < nbbo.bid * 0.5) {
            // Price is way off — use mid price for a fair fill
            tickRoundedPrice = nbbo.mid;
          }
          // Clamp: willing to pay up to ask, but not less than bid
          tickRoundedPrice = Math.min(tickRoundedPrice, nbbo.ask);
          tickRoundedPrice = Math.max(tickRoundedPrice, nbbo.bid);
        } else {
          // SELL: use mid-price (or theoretical if within NBBO spread).
          // Never go below bid, never exceed ask.
          if (tickRoundedPrice < nbbo.bid * 0.5 || tickRoundedPrice > nbbo.ask * 1.5) {
            // Price is way off — use mid price for a fair fill
            tickRoundedPrice = nbbo.mid;
          }
          // Clamp: willing to sell down to bid, but not more than ask
          tickRoundedPrice = Math.max(tickRoundedPrice, nbbo.bid);
          tickRoundedPrice = Math.min(tickRoundedPrice, nbbo.ask);
        }

        // Re-round to tick size after NBBO adjustment
        tickRoundedPrice = roundToTickSize(tickRoundedPrice, underlying);

        if (oldPrice !== tickRoundedPrice) {
          log.info(
            `NBBO adjustment: $${oldPrice.toFixed(2)} → $${tickRoundedPrice.toFixed(2)} ` +
            `(NBBO: $${nbbo.bid.toFixed(2)}/$${nbbo.ask.toFixed(2)}, mid: $${nbbo.mid.toFixed(2)})`
          );
        }
      } else {
        log.warn(
          `No NBBO data for ${underlying} ${strike}${right} — using theoretical price $${tickRoundedPrice.toFixed(2)}`
        );
      }
    } catch (err) {
      log.warn(`NBBO lookup failed for ${underlying} ${strike}${right}: ${err}`);
      // Continue with theoretical price — IBKR may still accept it
    }
  }

  return ibkr.placeOrder({
    symbol: underlying,
    secType: isOption ? "OPT" : "STK",
    strike,
    right,
    expiration,
    exchange: leg.contract.exchange || "SMART",
    action: leg.side === "buy" ? "BUY" : "SELL",
    quantity: leg.quantity,
    orderType,
    limitPrice: tickRoundedPrice,
  });
}

/**
 * Format a Date as YYYYMMDD for IBKR.
 */
function formatExpiration(date: Date): string {
  const d = new Date(date);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}${month}${day}`;
}

/**
 * Calculate the natural price for a combo order.
 * Sum of individual leg mid prices, accounting for buy/sell direction.
 */
export function calculateNaturalPrice(legs: StrategyLeg[]): number {
  return legs.reduce((total, leg) => {
    const direction = leg.side === "buy" ? 1 : -1;
    return total + (leg.price ?? 0) * direction * leg.quantity;
  }, 0);
}

/**
 * Adjust limit price by a specified improvement amount.
 * Positive = more aggressive (better for fills), Negative = wider (better price).
 */
export function adjustLimitPrice(
  naturalPrice: number,
  improvementCents: number = 0,
  underlying?: string
): number {
  const adjusted = Math.round((naturalPrice + improvementCents / 100) * 100) / 100;
  return roundToTickSize(adjusted, underlying);
}
