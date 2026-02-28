/**
 * Execution History Cache
 *
 * Persists IBKR trade executions and completed orders to a local JSON file.
 * Since IBKR's TWS API only provides:
 *   - reqExecutions: today's fills only
 *   - reqCompletedOrders: current TWS session only
 *
 * We cache every execution we receive so that over time we build up a complete
 * trade history. On each fetch, new executions are merged (deduplicated by execId
 * or orderId+time) into the cache.
 *
 * File: data/execution-history.json
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { agentLogger } from "../utils/logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const log = agentLogger("execution-cache");

const CACHE_PATH = path.join(__dirname, "..", "..", "data", "execution-history.json");

// ── Types ──────────────────────────────────────────────

export interface CachedExecution {
  /** Unique key for deduplication: execId or `${orderId}-${time}-${symbol}` */
  cacheKey: string;
  execId?: string;
  orderId: number | string;
  permId?: number;
  symbol: string;
  secType: string; // "OPT" | "STK"
  strike?: number;
  right?: string;  // "C" | "P"
  expiration?: string;
  side: string;    // "BOT" | "SLD" | "BUY" | "SELL"
  quantity: number;
  price: number;
  time: string;    // execution/completion time
  exchange?: string;
  commission: number;
  realizedPnL: number;
  source: "executions" | "completed"; // which API provided this
  cachedAt: string; // ISO timestamp of when we cached this
}

interface ExecutionCache {
  version: 1;
  lastUpdated: string;
  executions: CachedExecution[];
}

// ── In-memory state ────────────────────────────────────

let cache: ExecutionCache = {
  version: 1,
  lastUpdated: new Date().toISOString(),
  executions: [],
};

let loaded = false;

// ── Load / Save ────────────────────────────────────────

function ensureDataDir(): void {
  const dataDir = path.dirname(CACHE_PATH);
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }
}

export function loadExecutionCache(): void {
  try {
    if (existsSync(CACHE_PATH)) {
      const raw = readFileSync(CACHE_PATH, "utf-8");
      const parsed = JSON.parse(raw);
      if (parsed.version === 1 && Array.isArray(parsed.executions)) {
        cache = parsed;
        log.info(`Loaded execution cache: ${cache.executions.length} records`);
      }
    }
  } catch (err) {
    log.warn(`Failed to load execution cache: ${err}`);
  }
  loaded = true;
}

function saveCache(): void {
  try {
    ensureDataDir();
    cache.lastUpdated = new Date().toISOString();
    writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
  } catch (err) {
    log.warn(`Failed to save execution cache: ${err}`);
  }
}

// ── Key Generation ─────────────────────────────────────

function makeCacheKey(exec: {
  execId?: string;
  orderId?: number | string;
  time?: string;
  symbol?: string;
  side?: string;
  quantity?: number;
}): string {
  // Prefer execId (unique per fill)
  if (exec.execId) return `exec-${exec.execId}`;
  // For completed orders, use orderId + time + symbol
  return `order-${exec.orderId}-${exec.time || ""}-${exec.symbol || ""}-${exec.side || ""}-${exec.quantity || ""}`;
}

// ── Merge New Executions ───────────────────────────────

/**
 * Merge new executions from reqExecutions into the cache.
 * Deduplicates by cacheKey. Returns count of newly added records.
 */
export function mergeExecutions(executions: any[]): number {
  if (!loaded) loadExecutionCache();

  const existingKeys = new Set(cache.executions.map((e) => e.cacheKey));
  const now = new Date().toISOString();
  let added = 0;

  for (const exec of executions) {
    const key = makeCacheKey(exec);
    if (existingKeys.has(key)) continue;

    const comm = typeof exec.commission === "number" && exec.commission < 1e9 ? exec.commission : 0;
    const pnl = typeof exec.realizedPnL === "number" && Math.abs(exec.realizedPnL) < 1e9 ? exec.realizedPnL : 0;

    cache.executions.push({
      cacheKey: key,
      execId: exec.execId,
      orderId: exec.orderId,
      symbol: exec.symbol,
      secType: exec.secType || "OPT",
      strike: exec.strike,
      right: exec.right,
      expiration: exec.expiration,
      side: exec.side,
      quantity: exec.quantity || exec.shares,
      price: exec.price || exec.avgPrice,
      time: exec.time || "",
      exchange: exec.exchange,
      commission: comm,
      realizedPnL: pnl,
      source: "executions",
      cachedAt: now,
    });
    existingKeys.add(key);
    added++;
  }

  if (added > 0) {
    saveCache();
    log.info(`Cached ${added} new executions (total: ${cache.executions.length})`);
  }

  return added;
}

/**
 * Merge completed orders from reqCompletedOrders into the cache.
 * Only caches filled orders. Deduplicates by cacheKey.
 * Returns count of newly added records.
 */
export function mergeCompletedOrders(orders: any[]): number {
  if (!loaded) loadExecutionCache();

  const existingKeys = new Set(cache.executions.map((e) => e.cacheKey));
  const now = new Date().toISOString();
  let added = 0;

  for (const co of orders) {
    // Only cache filled orders
    const status = (co.status || co.completedStatus || "").toLowerCase();
    if (!status.includes("filled") && !status.includes("fill")) continue;

    const key = makeCacheKey({
      orderId: co.orderId || co.permId,
      time: co.completedTime,
      symbol: co.symbol,
      side: co.action,
      quantity: co.filledQuantity || co.totalQuantity,
    });
    if (existingKeys.has(key)) continue;

    const comm = typeof co.commission === "number" && co.commission < 1e9 ? co.commission : 0;
    const pnl = typeof co.realizedPnL === "number" && Math.abs(co.realizedPnL) < 1e9 ? co.realizedPnL : 0;

    cache.executions.push({
      cacheKey: key,
      orderId: co.orderId || co.permId,
      permId: co.permId,
      symbol: co.symbol,
      secType: co.secType || "OPT",
      strike: co.strike,
      right: co.right,
      expiration: co.expiration,
      side: co.action === "BUY" ? "BOT" : co.action === "SELL" ? "SLD" : co.action,
      quantity: co.filledQuantity || co.totalQuantity,
      price: co.avgFillPrice || co.lmtPrice,
      time: co.completedTime || "",
      exchange: co.exchange,
      commission: comm,
      realizedPnL: pnl,
      source: "completed",
      cachedAt: now,
    });
    existingKeys.add(key);
    added++;
  }

  if (added > 0) {
    saveCache();
    log.info(`Cached ${added} new completed orders (total: ${cache.executions.length})`);
  }

  return added;
}

// ── Query Cache ────────────────────────────────────────

/**
 * Get cached executions, optionally filtered by days back.
 * Returns all cached executions sorted by time (newest first).
 */
export function getCachedExecutions(daysBack?: number): CachedExecution[] {
  if (!loaded) loadExecutionCache();

  let results = cache.executions;

  if (daysBack && daysBack > 0) {
    const cutoff = Date.now() - daysBack * 24 * 60 * 60 * 1000;
    results = results.filter((e) => {
      // Try parsing the time string
      const t = parseIBKRTime(e.time);
      return t ? t >= cutoff : true; // keep if can't parse (better to show than hide)
    });
  }

  // Sort by time descending (newest first)
  return results.sort((a, b) => {
    const ta = parseIBKRTime(a.time) || 0;
    const tb = parseIBKRTime(b.time) || 0;
    return tb - ta;
  });
}

/**
 * Get cache statistics.
 */
export function getCacheStats(): {
  totalRecords: number;
  oldestRecord: string | null;
  newestRecord: string | null;
  lastUpdated: string;
} {
  if (!loaded) loadExecutionCache();

  const sorted = [...cache.executions].sort((a, b) => {
    const ta = parseIBKRTime(a.time) || 0;
    const tb = parseIBKRTime(b.time) || 0;
    return ta - tb;
  });

  return {
    totalRecords: cache.executions.length,
    oldestRecord: sorted.length > 0 ? sorted[0].time : null,
    newestRecord: sorted.length > 0 ? sorted[sorted.length - 1].time : null,
    lastUpdated: cache.lastUpdated,
  };
}

// ── Helpers ────────────────────────────────────────────

/**
 * Parse IBKR time string to epoch ms.
 * IBKR uses various formats: "yyyyMMdd-HH:mm:ss", "yyyyMMdd  HH:mm:ss", ISO, etc.
 */
function parseIBKRTime(timeStr: string): number | null {
  if (!timeStr) return null;

  // Try ISO parse first
  const iso = Date.parse(timeStr);
  if (!isNaN(iso)) return iso;

  // Try "yyyyMMdd-HH:mm:ss" or "yyyyMMdd  HH:mm:ss"
  const match = timeStr.match(/(\d{4})(\d{2})(\d{2})\s*[-\s]\s*(\d{2}):(\d{2}):(\d{2})/);
  if (match) {
    const [, y, m, d, h, min, s] = match;
    return new Date(`${y}-${m}-${d}T${h}:${min}:${s}`).getTime();
  }

  // Try "yyyyMMdd HH:mm:ss TZ"
  const match2 = timeStr.match(/(\d{4})(\d{2})(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/);
  if (match2) {
    const [, y, m, d, h, min, s] = match2;
    return new Date(`${y}-${m}-${d}T${h}:${min}:${s}`).getTime();
  }

  return null;
}
