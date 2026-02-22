# Agentic Options "Click" System

**Multi-agent AI swarm for institutional-grade options trading execution.**

An autonomous system that analyzes portfolios via browser interaction, calculates optimal options strategies using quantitative models, and facilitates execution through a human-in-the-loop approval flow.

## Architecture

The system uses a hierarchical multi-agent swarm with four specialist agents:

| Agent | Codename | Role |
|-------|----------|------|
| **Orchestrator** | The "Click" | Task delegation, workflow management, human approval |
| **Browser Operator** | The "Eyes" | Playwright-based brokerage/bank navigation |
| **Quant Analyst** | The "Brain" | Black-Scholes, Greeks, Lambda, strategy ranking |
| **Risk Sentinel** | The "Shield" | VaR calculation, 1-2% risk enforcement, stress tests |

```
User Intent
    │
    ▼
┌─────────────────┐
│   Orchestrator   │ ◄── Human-in-the-Loop Approval
│   (The Click)    │
└────┬───┬───┬─────┘
     │   │   │
     ▼   ▼   ▼
   Eyes Brain Shield
     │   │   │
     ▼   ▼   ▼
  Browser Quant  Risk
  Scrape  Engine Limits
```

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Install Playwright browsers
npx playwright install chromium

# 3. Configure environment
cp .env.example .env
# Edit .env with your API keys

# 4. Run in development mode
npm run dev

# 5. Run tests
npm test

# 6. Start mock bank portal (separate terminal)
npm run mock:bank
```

## Project Structure

```
src/
├── agents/                  # Multi-agent swarm
│   ├── orchestrator.ts      # The "Click" — workflow coordinator
│   ├── browser-operator.ts  # The "Eyes" — Playwright automation
│   ├── quant-analyst.ts     # The "Brain" — quantitative analysis
│   └── risk-sentinel.ts     # The "Shield" — risk management
├── quant/                   # Quantitative engine
│   ├── black-scholes.ts     # BS pricing + IV solver
│   ├── greeks.ts            # Delta, Gamma, Theta, Vega, Rho
│   ├── lambda.ts            # Leverage calculation (λ = Δ × S/C)
│   ├── var.ts               # Historical, Parametric, Monte Carlo VaR
│   └── strategies.ts        # Strategy builder + selection matrix
├── api/
│   ├── ibkr/                # Interactive Brokers TWS API
│   │   ├── client.ts        # Connection management
│   │   ├── orders.ts        # Order routing (single + combo)
│   │   └── streams.ts       # Real-time data subscriptions
│   ├── market-data/
│   │   └── polygon.ts       # Polygon.io / FMP provider
│   └── open-banking/
│       └── israel.ts        # FinTeka + Hapoalim integration
├── xai/                     # Explainable AI
│   ├── explanation-card.ts  # Trade recommendation explanations
│   ├── payoff-diagram.ts    # T+0 and expiration PnL curves
│   └── shap-values.ts       # SHAP-like factor attribution
├── types/                   # TypeScript type definitions
├── config/                  # Environment configuration (Zod)
└── utils/                   # Logger, validation utilities

tests/quant/                 # Quant engine test suite
mock/bank-portal/            # Mock banking portal for dev
```

## Quantitative Models

### Lambda (Leverage)
```
λ = Δ × (S / C)
```
Where S = stock price, C = option price. Higher λ = more leverage.

### VaR (Value at Risk)
Historical Simulation at 95% or 99% confidence with stress testing at ±15% underlying moves.

### Strategy Selection Matrix

| Account Size | Default Strategies |
|-------------|-------------------|
| < $10k | Vertical Spreads, Iron Condors |
| $10k–$100k | + Straddles, Strangles, Calendars |
| > $100k | + Covered Calls, Cash-Secured Puts, Wheel |

## IBKR Integration

Connects to TWS or IB Gateway via the TWS API:

- **Paper trading** (port 7497) — default for development
- **Live trading** (port 7496) — requires explicit configuration
- Supports single-leg and multi-leg (combo/BAG) orders
- Real-time Greeks streaming via tick type 106

## Israeli Market Compliance

- **ISA 2026 Directive**: Single-provider execution for independent trading advisors
- **PPL Amendment 13**: Explicit opt-in consent for AI processing of financial data
- **Open Banking**: FinTeka (Bank Leumi) and Bank Hapoalim API integration

## Security

- Browser instances run in isolated sandboxed contexts
- All trades require mandatory human approval (Approve click)
- Risk Sentinel blocks trades exceeding configurable risk limits
- Credentials never stored in code — environment variables only

## Docker

```bash
# Build and run
docker compose up --build

# Paper trading mode (default)
IBKR_PORT=7497 docker compose up
```

## Testing

```bash
npm test              # Run all tests
npm run test:watch    # Watch mode
npm run test:coverage # Coverage report
npm run typecheck     # Type checking only
```

## License

MIT
