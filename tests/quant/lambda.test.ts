/**
 * Lambda (Leverage) Calculator Tests
 */

import { describe, it, expect } from "vitest";
import {
  calculateLambda,
  lambdaCurve,
  strategyLambda,
} from "../../src/quant/lambda.js";

describe("calculateLambda", () => {
  it("should calculate lambda = delta × (S / C)", () => {
    // Delta=0.5, Stock=$100, Option=$5 → Lambda = 0.5 × (100/5) = 10
    const result = calculateLambda(0.5, 100, 5);
    expect(result.lambda).toBeCloseTo(10, 5);
  });

  it("should return 0 lambda for zero-priced options", () => {
    const result = calculateLambda(0.01, 100, 0);
    expect(result.lambda).toBe(0);
  });

  it("ATM calls should have lambda around 8-15", () => {
    // Typical ATM call: delta≈0.55, stock=$150, option≈$8
    const result = calculateLambda(0.55, 150, 8);
    expect(result.lambda).toBeGreaterThan(5);
    expect(result.lambda).toBeLessThan(20);
  });

  it("deep ITM options should have lower lambda (less leverage)", () => {
    const deepITM = calculateLambda(0.95, 100, 30);
    const atm = calculateLambda(0.5, 100, 5);
    expect(deepITM.lambda).toBeLessThan(atm.lambda);
  });

  it("OTM options should have higher lambda (more leverage)", () => {
    const otm = calculateLambda(0.15, 100, 0.5);
    const atm = calculateLambda(0.5, 100, 5);
    expect(otm.lambda).toBeGreaterThan(atm.lambda);
  });
});

describe("lambdaCurve", () => {
  it("should generate lambda values across strikes", () => {
    const strikes = [90, 95, 100, 105, 110];
    const curve = lambdaCurve(100, strikes, 30 / 365, 0.05, 0.3, "call");

    expect(curve.length).toBe(5);
    expect(curve.every((p) => p.strike > 0)).toBe(true);
    expect(curve.every((p) => isFinite(p.lambda))).toBe(true);
  });

  it("lambda should generally increase for OTM calls (higher strikes)", () => {
    const strikes = [80, 90, 100, 110, 120];
    const curve = lambdaCurve(100, strikes, 30 / 365, 0.05, 0.3, "call");

    // The 120 strike (deep OTM) should have higher lambda than 80 (deep ITM)
    const itm = curve.find((p) => p.strike === 80)!;
    const otm = curve.find((p) => p.strike === 120)!;
    expect(Math.abs(otm.lambda)).toBeGreaterThan(Math.abs(itm.lambda));
  });
});

describe("strategyLambda", () => {
  it("should calculate weighted lambda for a spread", () => {
    const legs = [
      { delta: 0.55, optionPrice: 5, underlyingPrice: 100, quantity: 1, side: "buy" as const },
      { delta: 0.3, optionPrice: 2, underlyingPrice: 100, quantity: 1, side: "sell" as const },
    ];

    const lambda = strategyLambda(legs);
    expect(isFinite(lambda)).toBe(true);
  });
});
