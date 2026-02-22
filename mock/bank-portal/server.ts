/**
 * Mock Bank Portal Server
 *
 * A simple Express server that simulates a banking portal
 * for the Browser Operator to scrape during development.
 *
 * Serves an HTML page with account balances and transaction history
 * using semantic HTML and data-testid attributes for reliable scraping.
 */

import express from "express";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = parseInt(process.env.MOCK_BANK_PORT ?? "3001", 10);

// Mock account data
const accounts = [
  {
    id: "ACC-001",
    name: "Checking Account",
    number: "****1234",
    balance: 45_230.50,
    currency: "ILS",
  },
  {
    id: "ACC-002",
    name: "Savings Account",
    number: "****5678",
    balance: 125_000.00,
    currency: "ILS",
  },
  {
    id: "ACC-003",
    name: "Investment Account",
    number: "****9012",
    balance: 312_750.25,
    currency: "ILS",
  },
];

const transactions = [
  { date: "2026-02-20", desc: "Salary Deposit", amount: 28_000, type: "credit" },
  { date: "2026-02-19", desc: "Rent Payment", amount: -8_500, type: "debit" },
  { date: "2026-02-18", desc: "IBKR Transfer", amount: -15_000, type: "debit" },
  { date: "2026-02-15", desc: "Freelance Payment", amount: 5_200, type: "credit" },
  { date: "2026-02-10", desc: "Utilities", amount: -1_800, type: "debit" },
];

// ─── API Endpoints ──────────────────────────────────────────

app.get("/api/accounts", (_req, res) => {
  res.json({ accounts });
});

app.get("/api/accounts/:id/balance", (req, res) => {
  const account = accounts.find((a) => a.id === req.params.id);
  if (!account) return res.status(404).json({ error: "Account not found" });
  res.json({ balance: account.balance, currency: account.currency });
});

app.get("/api/transactions", (_req, res) => {
  res.json({ transactions });
});

// ─── HTML Portal ────────────────────────────────────────────

app.get("/", (_req, res) => {
  const totalBalance = accounts.reduce((sum, a) => sum + a.balance, 0);

  res.send(`<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Mock Bank Portal — Development</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: system-ui, -apple-system, sans-serif; background: #f5f7fa; color: #1a1a2e; padding: 2rem; }
    .header { background: #0f3460; color: white; padding: 1.5rem 2rem; border-radius: 12px; margin-bottom: 2rem; }
    .header h1 { font-size: 1.5rem; margin-bottom: 0.5rem; }
    .total-balance { font-size: 2.5rem; font-weight: 700; }
    .accounts { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 1rem; margin-bottom: 2rem; }
    .account-card { background: white; border-radius: 12px; padding: 1.5rem; box-shadow: 0 2px 8px rgba(0,0,0,0.08); }
    .account-card h3 { color: #0f3460; margin-bottom: 0.5rem; }
    .account-balance { font-size: 1.8rem; font-weight: 600; color: #16a085; }
    .account-number { color: #888; font-size: 0.9rem; margin-top: 0.25rem; }
    .transactions { background: white; border-radius: 12px; padding: 1.5rem; box-shadow: 0 2px 8px rgba(0,0,0,0.08); }
    .transactions h2 { margin-bottom: 1rem; color: #0f3460; }
    .tx-row { display: flex; justify-content: space-between; padding: 0.75rem 0; border-bottom: 1px solid #eee; }
    .tx-row:last-child { border-bottom: none; }
    .tx-amount.credit { color: #16a085; }
    .tx-amount.debit { color: #e74c3c; }
    .dev-banner { background: #fff3cd; border: 1px solid #ffc107; padding: 0.75rem 1rem; border-radius: 8px; margin-bottom: 1rem; font-size: 0.85rem; }
  </style>
</head>
<body>
  <div class="dev-banner" data-testid="dev-banner">
    Development Mock — This portal simulates a banking interface for the Browser Operator agent.
  </div>

  <div class="header">
    <h1 data-testid="bank-name">Mock National Bank</h1>
    <div class="total-balance" data-testid="account-balance">
      ₪${totalBalance.toLocaleString("en-US", { minimumFractionDigits: 2 })}
    </div>
    <div style="opacity:0.8; margin-top:0.25rem;">Total Balance Across All Accounts</div>
  </div>

  <div class="accounts" data-testid="accounts-grid">
    ${accounts
      .map(
        (a) => `
    <div class="account-card" data-testid="account-card-${a.id}">
      <h3>${a.name}</h3>
      <div class="account-balance" data-testid="balance-${a.id}">
        ₪${a.balance.toLocaleString("en-US", { minimumFractionDigits: 2 })}
      </div>
      <div class="account-number" data-testid="account-number-${a.id}">${a.number}</div>
    </div>`
      )
      .join("")}
  </div>

  <div class="transactions" data-testid="transactions-table">
    <h2>Recent Transactions</h2>
    ${transactions
      .map(
        (tx) => `
    <div class="tx-row" data-testid="transaction">
      <div>
        <div style="font-weight:500">${tx.desc}</div>
        <div style="color:#888; font-size:0.85rem">${tx.date}</div>
      </div>
      <div class="tx-amount ${tx.type}" data-testid="tx-amount">
        ${tx.type === "credit" ? "+" : ""}₪${Math.abs(tx.amount).toLocaleString()}
      </div>
    </div>`
      )
      .join("")}
  </div>
</body>
</html>`);
});

// ─── Start Server ───────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`Mock Bank Portal running at http://localhost:${PORT}`);
  console.log("Accounts:", accounts.length);
  console.log(
    "Total Balance: ₪" +
    accounts.reduce((s, a) => s + a.balance, 0).toLocaleString()
  );
});

export default app;
