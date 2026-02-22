/**
 * IBKR Order Routing
 *
 * Translates OptionsStrategy objects into IBKR-compatible orders.
 * Submits through the connected PortfolioSync instance (which holds
 * the live IBApi connection and valid order IDs).
 *
 * Multi-leg strategies are submitted as combo/BAG orders — both legs
 * execute atomically (all or nothing), preventing partial fills.
 * Single-leg strategies are submitted as individual limit orders.
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

/** Resolved leg info after mapping synthetic → real IBKR contracts */
interface ResolvedLeg {
  leg: StrategyLeg;
  underlying: string;
  strike: number;
  right: "C" | "P";
  expiration: string; // YYYYMMDD
  conId: number | null;
  nbboMid: number | null; // real market mid-price from NBBO
}

/**
 * Submit a complete options strategy as IBKR order(s).
 *
 * For multi-leg strategies (spreads, iron condors, etc.):
 *   → Submits as a single combo/BAG order (atomic execution).
 *
 * For single-leg strategies (long call, cash-secured put, etc.):
 *   → Submits as an individual limit order.
 *
 * Falls back to individual leg orders if combo submission fails.
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

  // For multi-leg option strategies, try combo order first
  const optionLegs = strategy.legs.filter(
    (l) => l.contract.type === "call" || l.contract.type === "put"
  );

  if (optionLegs.length >= 2) {
    log.info(`Multi-leg strategy detected (${optionLegs.length} option legs) — attempting combo/BAG order`);
    try {
      const comboResult = await submitComboOrder(ibkr, strategy, orderType);
      if (comboResult.success) {
        return comboResult;
      }
      log.warn(`Combo order failed: ${comboResult.message} — falling back to individual legs`);
    } catch (err) {
      log.warn(`Combo order threw: ${err} — falling back to individual legs`);
    }
  }

  // Single-leg strategy or combo fallback: submit each leg individually
  return submitIndividualLegs(ibkr, strategy, orderType);
}

/**
 * Submit a multi-leg strategy as a single combo/BAG order.
 *
 * Steps:
 *   1. Resolve each leg's synthetic contract → real IBKR contract
 *   2. Get each leg's conId (required for combo order)
 *   3. Get NBBO for each leg to calculate realistic net price
 *   4. Build a BAG contract with comboLegs and submit
 */
async function submitComboOrder(
  ibkr: PortfolioSync,
  strategy: OptionsStrategy,
  orderType: "LMT" | "MKT"
): Promise<SubmitResult> {
  // Step 1+2: Resolve all legs and get their conIds
  const resolvedLegs: ResolvedLeg[] = [];

  for (const leg of strategy.legs) {
    const isOption = leg.contract.type === "call" || leg.contract.type === "put";
    if (!isOption) {
      log.warn(`Non-option leg in combo: ${leg.contract.symbol} — combo not supported`);
      return {
        success: false,
        orderIds: [],
        legs: strategy.legs.length,
        message: "Combo orders only support option legs",
      };
    }

    const underlying = (leg.contract as any).underlying ?? leg.contract.symbol;
    let strike = leg.contract.strike;
    let expiration = formatExpiration(leg.contract.expiration);
    const right: "C" | "P" = leg.contract.type === "call" ? "C" : "P";

    // Resolve synthetic → real contract
    const resolved = await ibkr.resolveOptionContract(
      underlying,
      strike,
      leg.contract.expiration
    );
    if (resolved) {
      log.info(
        `Resolved: ${underlying} ${strike}${right} exp ${expiration} → ` +
        `strike ${resolved.strike}, exp ${resolved.expiration}`
      );
      strike = resolved.strike;
      expiration = resolved.expiration;
    }

    // Get the conId for this specific option contract
    const conId = await ibkr.resolveOptionConId({
      symbol: underlying,
      strike,
      right,
      expiration,
      exchange: leg.contract.exchange || "SMART",
    });

    if (!conId) {
      log.warn(`Could not resolve conId for ${underlying} ${strike}${right} — combo not possible`);
      return {
        success: false,
        orderIds: [],
        legs: strategy.legs.length,
        message: `Could not resolve contract ID for ${underlying} ${strike}${right} exp ${expiration}`,
      };
    }

    // Get NBBO for this leg to calculate realistic net price
    let nbboMid: number | null = null;
    try {
      const nbbo = await ibkr.getOptionNBBO({
        symbol: underlying,
        strike,
        right,
        expiration,
        exchange: leg.contract.exchange || "SMART",
      });
      if (nbbo && nbbo.mid > 0) {
        nbboMid = nbbo.mid;
      }
    } catch {
      // Non-fatal — will use theoretical price
    }

    resolvedLegs.push({
      leg,
      underlying,
      strike,
      right,
      expiration,
      conId,
      nbboMid,
    });

    log.info(
      `Combo leg resolved: conId=${conId}, ${leg.side} ${underlying} ${strike}${right} ` +
      `exp ${expiration}, price=$${(leg.price ?? 0).toFixed(2)}` +
      (nbboMid ? `, NBBO mid=$${nbboMid.toFixed(2)}` : "")
    );
  }

  // Step 3: Calculate net combo price
  // Net price = sum of (leg price × direction), where BUY = +, SELL = -
  // Use NBBO mid-prices when available for a realistic fill price
  let netPrice = 0;
  for (const rl of resolvedLegs) {
    const price = rl.nbboMid ?? rl.leg.price ?? 0;
    const direction = rl.leg.side === "buy" ? -1 : 1; // BUY costs money (-), SELL receives (+)
    netPrice += price * direction * rl.leg.quantity;
  }
  // Round to tick size (combo prices use $0.01 increments)
  netPrice = Math.round(netPrice * 100) / 100;

  // Determine combo action: if netPrice > 0, we're receiving a net credit (SELL combo)
  // if netPrice < 0, we're paying a net debit (BUY combo)
  const comboAction: "BUY" | "SELL" = netPrice >= 0 ? "SELL" : "BUY";
  const comboPrice = Math.abs(netPrice);

  log.info(
    `Combo net price: $${netPrice.toFixed(2)} → ${comboAction} @ $${comboPrice.toFixed(2)}`
  );

  // Step 4: Submit the combo order
  const underlying = resolvedLegs[0].underlying;
  const orderId = await ibkr.placeComboOrder({
    symbol: underlying,
    legs: resolvedLegs.map((rl) => ({
      conId: rl.conId!,
      action: rl.leg.side === "buy" ? "BUY" : "SELL",
      ratio: rl.leg.quantity,
      exchange: "SMART",
    })),
    action: comboAction,
    quantity: 1, // combo quantity = 1 (ratios handle per-leg quantities)
    orderType,
    limitPrice: orderType === "LMT" ? comboPrice : undefined,
  });

  return {
    success: true,
    orderIds: [orderId],
    legs: strategy.legs.length,
    message: `Combo order submitted to IBKR: ${strategy.legs.length} legs as single atomic order (net ${comboAction} $${comboPrice.toFixed(2)})`,
  };
}

/**
 * Submit each leg as an individual order (original behavior).
 * Used for single-leg strategies or as fallback when combo fails.
 */
async function submitIndividualLegs(
  ibkr: PortfolioSync,
  strategy: OptionsStrategy,
  orderType: "LMT" | "MKT"
): Promise<SubmitResult> {
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
        ? `All ${orderIds.length} leg(s) submitted individually to IBKR`
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

        if (leg.side === "buy") {
          // BUY: use mid-price (or theoretical if within NBBO spread).
          // Never exceed ask, never go below bid.
          if (tickRoundedPrice > nbbo.ask * 1.05 || tickRoundedPrice < nbbo.bid * 0.5) {
            tickRoundedPrice = nbbo.mid;
          }
          tickRoundedPrice = Math.min(tickRoundedPrice, nbbo.ask);
          tickRoundedPrice = Math.max(tickRoundedPrice, nbbo.bid);
        } else {
          // SELL: use mid-price (or theoretical if within NBBO spread).
          // Never go below bid, never exceed ask.
          if (tickRoundedPrice < nbbo.bid * 0.5 || tickRoundedPrice > nbbo.ask * 1.5) {
            tickRoundedPrice = nbbo.mid;
          }
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
