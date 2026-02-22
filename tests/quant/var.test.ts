/**
 * Value at Risk Tests
 *
 * Validates VaR calculations using known distributions.
 */

import { describe, it, expect } from "vitest";
import {
  historicalVaR,
  parametricVaR,
  validateTradeRisk,
  stressTest,
} from "../../src/quant/var.js";

describe("historicalVaR", () => {
  it("should calculate VaR from historical returns", () => {
    // Generate 250 daily returns with mean=0, std=0.02
    const returns = Array.from(
      { length: 250 },
      () => (Math.random() - 0.5) * 0.04
    );

    const portfolioValue = 100_000;
    const { var: varValue, cvar } = historicalVaR(returns, portfolioValue, 0.95);

    // VaR should be positive and reasonable
    expect(varValue).toBeGreaterThan(0);
    expect(varValue).toBeLessThan(portfolioValue);

    // CVaR should be >= VaR (expected shortfall is always worse)
    expect(cvar).toBeGreaterThanOrEqual(varValue);
  });

  it("should scale with portfolio value", () => {
    const returns = Array.from({ length: 100 }, (_, i) => -0.02 + i * 0.0004);

    const var1 = historicalVaR(returns, 100_000, 0.95);
    const var2 = historicalVaR(returns, 200_000, 0.95);

    expect(var2.var).toBeCloseTo(var1.var * 2, 0);
  });

  it("should increase with lower confidence level", () => {
    const returns = Array.from({ length: 250 }, () => (Math.random() - 0.5) * 0.04);

    const var95 = historicalVaR(returns, 100_000, 0.95);
    const var99 = historicalVaR(returns, 100_000, 0.99);

    expect(var99.var).toBeGreaterThanOrEqual(var95.var);
  });

  it("should throw on empty returns", () => {
    expect(() => historicalVaR([], 100_000)).toThrow();
  });
});

describe("parametricVaR", () => {
  it("should give reasonable results for normal returns", () => {
    const returns = Array.from({ length: 252 }, () => (Math.random() - 0.5) * 0.04);

    const { var: varValue } = parametricVaR(returns, 100_000, 0.95);
    expect(varValue).toBeGreaterThan(0);
    expect(varValue).toBeLessThan(100_000);
  });
});

describe("validateTradeRisk", () => {
  it("should pass trades within risk limit", () => {
    const result = validateTradeRisk(1_000, 100_000, 2);
    expect(result.passes).toBe(true);
    expect(result.riskPct).toBeCloseTo(1, 1);
  });

  it("should block trades exceeding risk limit", () => {
    const result = validateTradeRisk(5_000, 100_000, 2);
    expect(result.passes).toBe(false);
    expect(result.riskPct).toBeCloseTo(5, 1);
  });

  it("should handle edge case at exactly the limit", () => {
    const result = validateTradeRisk(2_000, 100_000, 2);
    expect(result.passes).toBe(true);
    expect(result.riskPct).toBeCloseTo(2, 1);
  });
});

describe("stressTest", () => {
  it("should generate stress scenarios", () => {
    const results = stressTest(100_000, 500, 10, 150, 15);

    expect(results.length).toBe(4);
    expect(results.some((r) => r.underlyingMove > 0)).toBe(true);
    expect(results.some((r) => r.underlyingMove < 0)).toBe(true);
  });

  it("positive delta should profit from up moves", () => {
    const results = stressTest(100_000, 500, 0, 100, 10);
    const upMove = results.find((r) => r.underlyingMove === 10);
    expect(upMove?.portfolioPnL).toBeGreaterThan(0);
  });

  it("should calculate worst case loss correctly", () => {
    const results = stressTest(100_000, 500, 10, 150, 15);
    for (const r of results) {
      expect(r.worstCaseLoss).toBeLessThanOrEqual(0);
    }
  });
});
