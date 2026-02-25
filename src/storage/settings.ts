/**
 * Local settings persistence — JSON file storage
 *
 * Stores user goals/targets + watchlist in data/user-settings.json.
 * Atomic writes (tmp + rename) to prevent corruption.
 * Graceful fallback to defaults if file missing or corrupt.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { z } from "zod";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, "../../data");
const SETTINGS_FILE = path.join(DATA_DIR, "user-settings.json");

// ── Schema ──────────────────────────────────────────────────

export const UserSettingsSchema = z.object({
  monthlyTarget: z.number().min(0).default(1000),
  maxRiskPct: z.number().min(0.1).max(100).default(2),
  minDTE: z.number().min(1).max(365).default(14),
  maxDTE: z.number().min(1).max(365).default(60),
  strategies: z.array(z.string()).default([
    "bull_call_spread",
    "bear_put_spread",
    "iron_condor",
    "cash_secured_put",
  ]),
  symbols: z.array(z.string()).default([
    "AAPL", "MSFT", "TSLA", "SPY",
  ]),
});

export type UserSettings = z.infer<typeof UserSettingsSchema>;

const DEFAULT_SETTINGS: UserSettings = {
  monthlyTarget: 1000,
  maxRiskPct: 2,
  minDTE: 14,
  maxDTE: 60,
  strategies: ["bull_call_spread", "bear_put_spread", "iron_condor", "cash_secured_put"],
  symbols: ["AAPL", "MSFT", "TSLA", "SPY"],
};

// ── Public API ──────────────────────────────────────────────

/**
 * Load settings from disk. Returns defaults if file missing or invalid.
 */
export function loadSettings(): UserSettings {
  try {
    if (!fs.existsSync(SETTINGS_FILE)) {
      return { ...DEFAULT_SETTINGS };
    }
    const raw = fs.readFileSync(SETTINGS_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    // Validate + fill in missing fields with defaults
    return UserSettingsSchema.parse(parsed);
  } catch {
    // Corrupt file or parse error — return defaults silently
    return { ...DEFAULT_SETTINGS };
  }
}

/**
 * Save settings to disk. Atomic write (tmp + rename).
 * Returns the validated settings that were actually saved.
 */
export function saveSettings(settings: unknown): UserSettings {
  // Validate input — throws ZodError if invalid
  const validated = UserSettingsSchema.parse(settings);

  // Ensure data directory exists
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  // Atomic write: write to tmp file, then rename
  const tmpFile = SETTINGS_FILE + ".tmp";
  fs.writeFileSync(tmpFile, JSON.stringify(validated, null, 2), "utf-8");
  fs.renameSync(tmpFile, SETTINGS_FILE);

  return validated;
}

/**
 * Get default settings (for reference / reset).
 */
export function getDefaultSettings(): UserSettings {
  return { ...DEFAULT_SETTINGS };
}
