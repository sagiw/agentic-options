/**
 * The "Eyes" — Browser Operator Agent
 *
 * Uses Playwright to navigate the user's brokerage/bank portal.
 * Implements the Observe → Think → Act loop from the spec:
 *
 *   1. Observe: Capture Accessibility Tree (67% token efficiency vs raw HTML)
 *   2. Think:   Map visual elements to financial actions
 *   3. Act:     Execute click/type/hover via CDP
 *
 * All browser instances run in sandboxed contexts for security.
 */

import type { Browser, BrowserContext, Page } from "playwright";
import { agentLogger } from "../utils/logger.js";
import { generateId } from "../utils/validation.js";
import { config } from "../config/index.js";
import type {
  Agent,
  AgentMessage,
  AgentRole,
  AgentStatus,
  TaskRequest,
} from "../types/agents.js";
import type { BankAccount, AccountSummary } from "../types/portfolio.js";

const log = agentLogger("browser");

/** Parsed element from accessibility tree */
interface A11yElement {
  role: string;
  name: string;
  value?: string;
  description?: string;
  children: A11yElement[];
}

/** Browser action for the Act phase */
interface BrowserAction {
  type: "click" | "type" | "hover" | "scroll" | "wait" | "navigate";
  selector?: string;
  value?: string;
  url?: string;
  timeout?: number;
}

export class BrowserOperator implements Agent {
  readonly role: AgentRole = "browser";
  status: AgentStatus = "idle";

  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;

  async initialize(): Promise<void> {
    log.info("Initializing browser operator...");

    // Dynamic import for Playwright (tree-shakeable)
    const { chromium } = await import("playwright");

    this.browser = await chromium.launch({
      headless: config.browser.headless,
      args: config.browser.sandbox
        ? ["--no-sandbox", "--disable-setuid-sandbox"]
        : [],
    });

    // Create isolated context (sandboxing per spec)
    this.context = await this.browser.newContext({
      viewport: { width: 1920, height: 1080 },
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    });

    this.page = await this.context.newPage();
    this.status = "idle";
    log.info("Browser operator ready");
  }

  async handleMessage(message: AgentMessage): Promise<AgentMessage | null> {
    const task = message.payload as TaskRequest;
    this.status = "acting";

    try {
      let result: unknown;

      switch (task.action) {
        case "scrape_portfolio":
          result = await this.scrapePortfolio(task.params as Record<string, string>);
          break;

        case "scrape_bank_balance":
          result = await this.scrapeBankBalance(task.params as Record<string, string>);
          break;

        case "place_order":
          result = await this.placeOrder(task.params);
          break;

        default:
          log.warn(`Unknown action: ${task.action}`);
          result = null;
      }

      this.status = "idle";
      return {
        id: generateId(),
        from: "browser",
        to: message.from,
        type: "task_response",
        payload: result,
        timestamp: new Date(),
        correlationId: message.id,
      };
    } catch (err) {
      this.status = "error";
      log.error(`Action ${task.action} failed`, { error: err });
      return {
        id: generateId(),
        from: "browser",
        to: message.from,
        type: "error",
        payload: { error: String(err), action: task.action },
        timestamp: new Date(),
        correlationId: message.id,
      };
    }
  }

  async shutdown(): Promise<void> {
    log.info("Shutting down browser operator...");
    await this.page?.close();
    await this.context?.close();
    await this.browser?.close();
    this.browser = null;
    this.context = null;
    this.page = null;
    this.status = "idle";
  }

  // ─── Observe Phase: Accessibility Tree ────────────────────

  /**
   * Capture the accessibility tree of the current page.
   * This is 67% more token-efficient than raw HTML per the spec.
   */
  private async captureAccessibilityTree(): Promise<A11yElement | null> {
    if (!this.page) throw new Error("Browser not initialized");

    // Use Playwright's page.evaluate to extract accessibility tree via DOM
    // This runs in the browser context where DOM types are available
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const snapshot = await (this.page.evaluate as any)(`(() => {
      function walkTree(el) {
        return {
          role: el.getAttribute && el.getAttribute("role") || el.tagName?.toLowerCase() || "unknown",
          name: el.getAttribute && el.getAttribute("aria-label") || el.textContent?.slice(0, 100) || "",
          children: Array.from(el.children || []).map(walkTree),
        };
      }
      return walkTree(document.body);
    })()`);

    return snapshot as unknown as A11yElement;
  }

  private flattenA11yTree(node: A11yElement): A11yElement {
    return {
      role: node.role,
      name: node.name,
      value: node.value,
      description: node.description,
      children: (node.children ?? []).map((c) => this.flattenA11yTree(c)),
    };
  }

  // ─── Act Phase: Execute Browser Actions ───────────────────

  private async executeAction(action: BrowserAction): Promise<void> {
    if (!this.page) throw new Error("Browser not initialized");

    switch (action.type) {
      case "navigate":
        if (action.url) {
          await this.page.goto(action.url, {
            timeout: config.browser.timeoutMs,
            waitUntil: "networkidle",
          });
        }
        break;

      case "click":
        if (action.selector) {
          await this.page.click(action.selector, {
            timeout: config.browser.timeoutMs,
          });
        }
        break;

      case "type":
        if (action.selector && action.value) {
          await this.page.fill(action.selector, action.value);
        }
        break;

      case "hover":
        if (action.selector) {
          await this.page.hover(action.selector);
        }
        break;

      case "scroll":
        await this.page.mouse.wheel(0, 300);
        break;

      case "wait":
        await this.page.waitForTimeout(action.timeout ?? 1000);
        break;
    }
  }

  // ─── Task Implementations ─────────────────────────────────

  /**
   * Scrape portfolio positions from brokerage.
   * NOTE: This is a scaffold — real implementation would navigate
   * the brokerage's web interface and extract data.
   */
  private async scrapePortfolio(
    _params: Record<string, string>
  ): Promise<Partial<AccountSummary>> {
    log.info("Scraping portfolio from brokerage...");

    // In production, this would:
    // 1. Navigate to brokerage login
    // 2. Authenticate (with user's stored session)
    // 3. Navigate to positions page
    // 4. Capture accessibility tree
    // 5. Extract position data from tree

    // Scaffold: return mock data
    return {
      accountId: "MOCK-001",
      currency: "USD",
      netLiquidation: 50_000,
      totalCash: 25_000,
      buyingPower: 100_000,
      availableFunds: 25_000,
      marginUsed: 12_500,
      unrealizedPnL: 2_340,
      realizedPnL: 890,
    };
  }

  /**
   * Scrape bank balance from banking portal.
   * Connects via Open Banking API or browser scraping fallback.
   */
  private async scrapeBankBalance(
    params: Record<string, string>
  ): Promise<BankAccount> {
    const bankUrl = params.url ?? `http://localhost:${config.mockBankPort}`;
    log.info(`Scraping bank balance from ${bankUrl}`);

    if (!this.page) throw new Error("Browser not initialized");

    // Navigate to bank portal
    await this.executeAction({ type: "navigate", url: bankUrl });

    // Capture accessibility tree
    const tree = await this.captureAccessibilityTree();
    log.debug("Captured accessibility tree", {
      elements: tree?.children?.length ?? 0,
    });

    // Extract balance from tree (mock implementation)
    // Real implementation would parse the a11y tree to find balance elements
    const balanceText = await this.page
      .locator('[data-testid="account-balance"]')
      .textContent()
      .catch(() => null);

    const balance = balanceText
      ? parseFloat(balanceText.replace(/[^0-9.-]/g, ""))
      : 0;

    return {
      bankName: params.bankName ?? "Mock Bank",
      accountNumber: "****1234",
      balance,
      currency: "ILS",
      lastUpdated: new Date(),
      source: "browser_scrape",
    };
  }

  /**
   * Place an order through the brokerage's web interface.
   * This is the final step — only called after human approval.
   */
  private async placeOrder(params: Record<string, unknown>): Promise<{
    success: boolean;
    orderId?: string;
    message: string;
  }> {
    log.info("Placing order via brokerage...", { strategy: params.strategy });

    // In production, this would:
    // 1. Navigate to order entry page
    // 2. Select the option contract(s)
    // 3. Fill in order details (strategy legs)
    // 4. Review the order
    // 5. Submit (only after human "Approve" click)

    // Scaffold: simulate success
    const orderId = `ORD-${generateId()}`;
    log.info(`Order placed: ${orderId}`);

    return {
      success: true,
      orderId,
      message: `Order ${orderId} submitted successfully`,
    };
  }
}
