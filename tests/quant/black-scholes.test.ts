/**
 * Black-Scholes Model Tests
 *
 * Validates pricing accuracy against known analytical values
 * and edge cases. Uses standard test cases from Hull (2022).
 */

import { describe, it, expect } from "vitest";
import {
  blackScholesPrice,
  impliedVolatility,
  normalCDF,
  normalPDF,
  type BSParams,
} from "../../src/quant/black-scholes.js";

describe("normalCDF", () => {
  it("should return 0.5 for x=0", () => {
    expect(normalCDF(0)).toBeCloseTo(0.5, 6);
  });

  it("should return ~0.8413 for x=1", () => {
    expect(normalCDF(1)).toBeCloseTo(0.8413, 3);
  });

  it("should return ~0.1587 for x=-1", () => {
    expect(normalCDF(-1)).toBeCloseTo(0.1587, 3);
  });

  it("should return ~0.9772 for x=2", () => {
    expect(normalCDF(2)).toBeCloseTo(0.9772, 3);
  });

  it("should approach 1 for large positive x", () => {
    expect(normalCDF(5)).toBeGreaterThan(0.999);
  });

  it("should approach 0 for large negative x", () => {
    expect(normalCDF(-5)).toBeLessThan(0.001);
  });
});

describe("normalPDF", () => {
  it("should return ~0.3989 for x=0 (peak of standard normal)", () => {
    expect(normalPDF(0)).toBeCloseTo(0.3989, 3);
  });

  it("should be symmetric: PDF(x) = PDF(-x)", () => {
    expect(normalPDF(1.5)).toBeCloseTo(normalPDF(-1.5), 10);
  });
});

describe("blackScholesPrice", () => {
  // Standard test case: S=100, K=100, T=1, r=5%, σ=20%
  const standard: BSParams = { S: 100, K: 100, T: 1, r: 0.05, sigma: 0.2 };

  it("should price an ATM call correctly (~$10.45)", () => {
    const price = blackScholesPrice(standard, "call");
    expect(price).toBeCloseTo(10.4506, 1);
  });

  it("should price an ATM put correctly (~$5.57)", () => {
    const price = blackScholesPrice(standard, "put");
    expect(price).toBeCloseTo(5.5735, 1);
  });

  it("should satisfy put-call parity: C - P = S·e^(-qT) - K·e^(-rT)", () => {
    const call = blackScholesPrice(standard, "call");
    const put = blackScholesPrice(standard, "put");
    const parity = standard.S - standard.K * Math.exp(-standard.r * standard.T);
    expect(call - put).toBeCloseTo(parity, 4);
  });

  it("should return intrinsic value at expiration (T=0)", () => {
    const expired: BSParams = { S: 110, K: 100, T: 0, r: 0.05, sigma: 0.2 };
    expect(blackScholesPrice(expired, "call")).toBeCloseTo(10, 10);
    expect(blackScholesPrice(expired, "put")).toBeCloseTo(0, 10);
  });

  it("deep ITM call should approach S - K·e^(-rT)", () => {
    const deepITM: BSParams = { S: 200, K: 100, T: 0.5, r: 0.05, sigma: 0.2 };
    const price = blackScholesPrice(deepITM, "call");
    const intrinsic = 200 - 100 * Math.exp(-0.05 * 0.5);
    expect(price).toBeCloseTo(intrinsic, 0);
  });

  it("deep OTM call should approach 0", () => {
    const deepOTM: BSParams = { S: 50, K: 200, T: 0.25, r: 0.05, sigma: 0.2 };
    const price = blackScholesPrice(deepOTM, "call");
    expect(price).toBeLessThan(0.01);
  });

  it("should handle dividends correctly", () => {
    const withDiv: BSParams = { S: 100, K: 100, T: 1, r: 0.05, sigma: 0.2, q: 0.02 };
    const callWithDiv = blackScholesPrice(withDiv, "call");
    const callNoDiv = blackScholesPrice(standard, "call");
    // Dividends reduce call value
    expect(callWithDiv).toBeLessThan(callNoDiv);
  });

  it("should increase with longer time to expiry (call)", () => {
    const short: BSParams = { ...standard, T: 0.25 };
    const long: BSParams = { ...standard, T: 2 };
    expect(blackScholesPrice(long, "call")).toBeGreaterThan(
      blackScholesPrice(short, "call")
    );
  });

  it("should increase with higher volatility", () => {
    const lowVol: BSParams = { ...standard, sigma: 0.1 };
    const highVol: BSParams = { ...standard, sigma: 0.5 };
    expect(blackScholesPrice(highVol, "call")).toBeGreaterThan(
      blackScholesPrice(lowVol, "call")
    );
  });
});

describe("impliedVolatility", () => {
  it("should recover the original sigma from a BS price", () => {
    const params: BSParams = { S: 100, K: 100, T: 1, r: 0.05, sigma: 0.3 };
    const marketPrice = blackScholesPrice(params, "call");
    const recoveredIV = impliedVolatility(marketPrice, 100, 100, 1, 0.05, "call");
    expect(recoveredIV).toBeCloseTo(0.3, 4);
  });

  it("should work for puts", () => {
    const params: BSParams = { S: 100, K: 95, T: 0.5, r: 0.05, sigma: 0.25 };
    const marketPrice = blackScholesPrice(params, "put");
    const recoveredIV = impliedVolatility(marketPrice, 100, 95, 0.5, 0.05, "put");
    expect(recoveredIV).toBeCloseTo(0.25, 3);
  });

  it("should work for OTM options", () => {
    const params: BSParams = { S: 100, K: 120, T: 0.5, r: 0.05, sigma: 0.35 };
    const marketPrice = blackScholesPrice(params, "call");
    const recoveredIV = impliedVolatility(marketPrice, 100, 120, 0.5, 0.05, "call");
    expect(recoveredIV).toBeCloseTo(0.35, 2);
  });

  it("should converge for high IV inputs", () => {
    const params: BSParams = { S: 100, K: 100, T: 1, r: 0.05, sigma: 1.5 };
    const marketPrice = blackScholesPrice(params, "call");
    const recoveredIV = impliedVolatility(marketPrice, 100, 100, 1, 0.05, "call");
    expect(recoveredIV).toBeCloseTo(1.5, 1);
  });
});
