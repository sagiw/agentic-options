/**
 * Centralized configuration loaded from environment variables.
 * Uses zod for runtime validation.
 */

import { z } from "zod";
import dotenv from "dotenv";

dotenv.config();

const ConfigSchema = z.object({
  // LLM (optional — not needed for dashboard-only mode)
  anthropicApiKey: z.string().default(""),
  llmModel: z.string().default("claude-sonnet-4-5-20250929"),

  // IBKR
  ibkr: z.object({
    host: z.string().default("127.0.0.1"),
    port: z.coerce.number().default(7497),
    clientId: z.coerce.number().default(1),
  }),

  // Israeli Open Banking
  finteka: z.object({
    clientId: z.string().optional(),
    clientSecret: z.string().optional(),
  }),
  hapoalimApiKey: z.string().optional(),

  // Browser
  browser: z.object({
    headless: z.coerce.boolean().default(true),
    sandbox: z.coerce.boolean().default(true),
    timeoutMs: z.coerce.number().default(30_000),
  }),

  // Risk Parameters
  risk: z.object({
    maxRiskPerTradePct: z.coerce.number().default(2.0),
    varConfidenceLevel: z.coerce.number().default(0.95),
    stressTestMagnitudePct: z.coerce.number().default(15.0),
  }),

  // System
  logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),
  nodeEnv: z.enum(["development", "production", "test"]).default("development"),
  port: z.coerce.number().default(3000),
  mockBankPort: z.coerce.number().default(3001),
});

export type Config = z.infer<typeof ConfigSchema>;

function loadConfig(): Config {
  const raw = {
    anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",
    llmModel: process.env.LLM_MODEL,
    ibkr: {
      host: process.env.IBKR_HOST,
      port: process.env.IBKR_PORT,
      clientId: process.env.IBKR_CLIENT_ID,
    },
    finteka: {
      clientId: process.env.FINTEKA_CLIENT_ID,
      clientSecret: process.env.FINTEKA_CLIENT_SECRET,
    },
    hapoalimApiKey: process.env.HAPOALIM_API_KEY,
    browser: {
      headless: process.env.BROWSER_HEADLESS,
      sandbox: process.env.BROWSER_SANDBOX,
      timeoutMs: process.env.BROWSER_TIMEOUT_MS,
    },
    risk: {
      maxRiskPerTradePct: process.env.MAX_RISK_PER_TRADE_PCT,
      varConfidenceLevel: process.env.VAR_CONFIDENCE_LEVEL,
      stressTestMagnitudePct: process.env.STRESS_TEST_MAGNITUDE_PCT,
    },
    logLevel: process.env.LOG_LEVEL,
    nodeEnv: process.env.NODE_ENV,
    port: process.env.PORT,
    mockBankPort: process.env.MOCK_BANK_PORT,
  };

  return ConfigSchema.parse(raw);
}

/** Singleton config instance */
export const config = loadConfig();
