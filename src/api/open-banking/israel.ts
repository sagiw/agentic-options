/**
 * Israeli Open Banking Integration
 *
 * Connects to FinTeka (Bank Leumi) and Bank Hapoalim Open Banking APIs
 * for account aggregation and net worth verification.
 *
 * Compliant with:
 *   - Amendment 13 of the Protection of Privacy Law (PPL)
 *   - Explicit opt-in consent required for AI processing
 *   - 2026 ISA Directive on Digital Investment Advice
 */

import { agentLogger } from "../../utils/logger.js";
import { config } from "../../config/index.js";
import type { BankAccount, NetWorthSnapshot } from "../../types/portfolio.js";

const log = agentLogger("open-banking-il");

/** Consent status for privacy compliance */
interface ConsentRecord {
  userId: string;
  provider: string;
  consentedAt: Date;
  expiresAt: Date;
  scopes: string[];
  isActive: boolean;
}

/**
 * FinTeka (Bank Leumi) Open Banking Client
 *
 * Reference: https://openbanking.bankleumi.co.il
 */
export class FinTekaClient {
  private baseUrl = "https://api.finteka.co.il/v1";
  private accessToken: string | null = null;
  private consent: ConsentRecord | null = null;

  /**
   * Authenticate with FinTeka OAuth2.
   * Requires explicit user consent (PPL Amendment 13).
   */
  async authenticate(authorizationCode: string): Promise<void> {
    if (!config.finteka.clientId || !config.finteka.clientSecret) {
      log.warn("FinTeka credentials not configured");
      return;
    }

    log.info("Authenticating with FinTeka...");

    // In production:
    // POST /oauth2/token with grant_type=authorization_code
    // Store access_token and refresh_token securely

    this.accessToken = "mock-token";
    this.consent = {
      userId: "user-001",
      provider: "finteka",
      consentedAt: new Date(),
      expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000), // 90 days
      scopes: ["accounts:read", "balances:read"],
      isActive: true,
    };

    log.info("FinTeka authentication successful");
  }

  /**
   * Get account balances from Bank Leumi.
   * Requires active consent.
   */
  async getAccounts(): Promise<BankAccount[]> {
    this.ensureConsent();

    log.info("Fetching Bank Leumi accounts...");

    // In production:
    // GET /accounts with Authorization: Bearer {token}
    // Parse response into BankAccount objects

    return [
      {
        bankName: "Bank Leumi",
        accountNumber: "****5678",
        balance: 125_000,
        currency: "ILS",
        lastUpdated: new Date(),
        source: "api",
      },
    ];
  }

  /**
   * Revoke consent (user's right under PPL).
   */
  async revokeConsent(): Promise<void> {
    if (this.consent) {
      this.consent.isActive = false;
      this.accessToken = null;
      log.info("FinTeka consent revoked");
    }
  }

  private ensureConsent(): void {
    if (!this.consent?.isActive) {
      throw new Error(
        "No active consent for FinTeka. " +
        "User must provide explicit opt-in consent per PPL Amendment 13."
      );
    }
  }
}

/**
 * Bank Hapoalim Open Banking Client
 */
export class HapoalimClient {
  private baseUrl = "https://api.bankhapoalim.co.il/v1";
  private apiKey: string;
  private consent: ConsentRecord | null = null;

  constructor() {
    this.apiKey = config.hapoalimApiKey ?? "";
  }

  async authenticate(authorizationCode: string): Promise<void> {
    if (!this.apiKey) {
      log.warn("Hapoalim API key not configured");
      return;
    }

    log.info("Authenticating with Bank Hapoalim...");
    this.consent = {
      userId: "user-001",
      provider: "hapoalim",
      consentedAt: new Date(),
      expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
      scopes: ["accounts:read", "balances:read"],
      isActive: true,
    };
  }

  async getAccounts(): Promise<BankAccount[]> {
    if (!this.consent?.isActive) {
      throw new Error("No active consent for Bank Hapoalim.");
    }

    return [
      {
        bankName: "Bank Hapoalim",
        accountNumber: "****9012",
        balance: 87_500,
        currency: "ILS",
        lastUpdated: new Date(),
        source: "api",
      },
    ];
  }

  async revokeConsent(): Promise<void> {
    if (this.consent) {
      this.consent.isActive = false;
      log.info("Hapoalim consent revoked");
    }
  }
}

/**
 * Aggregate net worth across all connected accounts.
 */
export async function aggregateNetWorth(
  finTeka: FinTekaClient,
  hapoalim: HapoalimClient
): Promise<NetWorthSnapshot> {
  const bankAccounts: BankAccount[] = [];

  try {
    const leumiAccounts = await finTeka.getAccounts();
    bankAccounts.push(...leumiAccounts);
  } catch (err) {
    log.warn("Could not fetch Leumi accounts", { error: err });
  }

  try {
    const hapoalimAccounts = await hapoalim.getAccounts();
    bankAccounts.push(...hapoalimAccounts);
  } catch (err) {
    log.warn("Could not fetch Hapoalim accounts", { error: err });
  }

  const totalBank = bankAccounts.reduce((sum, a) => sum + a.balance, 0);

  return {
    brokerageAccounts: [],
    bankAccounts,
    totalNetWorth: totalBank,
    availableForTrading: totalBank * 0.3, // conservative: 30% available
    timestamp: new Date(),
  };
}
