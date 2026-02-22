/**
 * Input validation utilities.
 */

import { z } from "zod";

/** Validate a stock ticker symbol */
export const TickerSchema = z
  .string()
  .min(1)
  .max(10)
  .regex(/^[A-Z]{1,10}$/, "Ticker must be 1-10 uppercase letters");

/** Validate option order parameters */
export const OrderParamsSchema = z.object({
  symbol: TickerSchema,
  strike: z.number().positive(),
  expiration: z.string().datetime(),
  type: z.enum(["call", "put"]),
  side: z.enum(["buy", "sell"]),
  quantity: z.number().int().positive(),
  limitPrice: z.number().positive().optional(),
  orderType: z.enum(["market", "limit", "stop", "stop_limit"]).default("limit"),
  timeInForce: z.enum(["DAY", "GTC", "IOC", "FOK"]).default("DAY"),
});

/** Validate risk parameters */
export const RiskParamsSchema = z.object({
  maxRiskPct: z.number().min(0.1).max(10).default(2),
  confidenceLevel: z.number().min(0.5).max(0.999).default(0.95),
  horizon: z.number().int().positive().default(1),
});

/** Generate a unique correlation ID for message tracking */
export function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}
