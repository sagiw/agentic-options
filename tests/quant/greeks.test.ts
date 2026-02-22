/**
 * Greeks Calculator Tests
 *
 * Validates Delta, Gamma, Theta, Vega, Rho against known values.
 */

import { describe, it, expect } from "vitest";
import { calculateGreeks, aggregateGreeks } from "../../src/quant/greeks.js";
import type { BSParams } from "../../src/quant/black-scholes.js";

describe("calculateGreeks", () => {
  const params: BSParams = { S: 100, K: 100, T: 1, r: 0.05, sigma: 0.2 };

  describe("Delta", () => {
    it("ATM call delta should be ~0.6 (>0.5 due to drift)", () => {
      const { delta } = calculateGreeks(params, "call");
      expect(delta).toBeGreaterThan(0.5);
      expect(delta).toBeLessThan(0.7);
    });

    it("ATM put delta should be ~-0.4", () => {
      const { delta } = calculateGreeks(params, "put");
      expect(delta).toBeLessThan(-0.3);
      expect(delta).toBeGreaterThan(-0.5);
    });

    it("call delta + |put delta| should ≈ 1 (with dividend adjustment)", () => {
      const callDelta = calculateGreeks(params, "call").delta;
      const putDelta = calculateGreeks(params, "put").delta;
      // N(d1) + [N(d1) - 1] = 2N(d1) - 1, but |call| + |put| = e^(-qT)
      expect(callDelta + Math.abs(putDelta)).toBeCloseTo(1, 1);
    });

    it("deep ITM call delta should approach 1", () => {
      const deepITM: BSParams = { ...params, S: 200, K: 100 };
      expect(calculateGreeks(deepITM, "call").delta).toBeGreaterThan(0.95);
    });

    it("deep OTM call delta should approach 0", () => {
      const deepOTM: BSParams = { ...params, S: 50, K: 200 };
      expect(calculateGreeks(deepOTM, "call").delta).toBeLessThan(0.05);
    });
  });

  describe("Gamma", () => {
    it("Gamma should be positive", () => {
      const { gamma } = calculateGreeks(params, "call");
      expect(gamma).toBeGreaterThan(0);
    });

    it("Gamma should be same for calls and puts at same strike", () => {
      const callGamma = calculateGreeks(params, "call").gamma;
      const putGamma = calculateGreeks(params, "put").gamma;
      expect(callGamma).toBeCloseTo(putGamma, 8);
    });

    it("Gamma should be highest ATM", () => {
      const itm: BSParams = { ...params, S: 120 };
      const otm: BSParams = { ...params, S: 80 };
      const atmGamma = calculateGreeks(params, "call").gamma;
      const itmGamma = calculateGreeks(itm, "call").gamma;
      const otmGamma = calculateGreeks(otm, "call").gamma;
      expect(atmGamma).toBeGreaterThan(itmGamma);
      expect(atmGamma).toBeGreaterThan(otmGamma);
    });
  });

  describe("Theta", () => {
    it("Theta should be negative for long options (time decay)", () => {
      const { theta } = calculateGreeks(params, "call");
      expect(theta).toBeLessThan(0);
    });

    it("Theta magnitude should increase as expiration approaches", () => {
      const longTerm: BSParams = { ...params, T: 1 };
      const shortTerm: BSParams = { ...params, T: 0.05 };
      const thetaLong = Math.abs(calculateGreeks(longTerm, "call").theta);
      const thetaShort = Math.abs(calculateGreeks(shortTerm, "call").theta);
      expect(thetaShort).toBeGreaterThan(thetaLong);
    });
  });

  describe("Vega", () => {
    it("Vega should be positive (higher vol = higher option price)", () => {
      const { vega } = calculateGreeks(params, "call");
      expect(vega).toBeGreaterThan(0);
    });

    it("Vega should be same for calls and puts", () => {
      const callVega = calculateGreeks(params, "call").vega;
      const putVega = calculateGreeks(params, "put").vega;
      expect(callVega).toBeCloseTo(putVega, 8);
    });
  });

  describe("Rho", () => {
    it("Call rho should be positive (higher rates = higher call value)", () => {
      expect(calculateGreeks(params, "call").rho).toBeGreaterThan(0);
    });

    it("Put rho should be negative", () => {
      expect(calculateGreeks(params, "put").rho).toBeLessThan(0);
    });
  });
});

describe("aggregateGreeks", () => {
  it("should sum up Greeks across positions", () => {
    const positions = [
      {
        greeks: { delta: 0.5, gamma: 0.02, theta: -0.05, vega: 0.3, rho: 0.1 },
        quantity: 10,
        multiplier: 100,
      },
      {
        greeks: { delta: -0.3, gamma: 0.01, theta: -0.03, vega: 0.2, rho: -0.05 },
        quantity: 5,
        multiplier: 100,
      },
    ];

    const agg = aggregateGreeks(positions);
    expect(agg.delta).toBeCloseTo(0.5 * 1000 + (-0.3) * 500);
    expect(agg.gamma).toBeCloseTo(0.02 * 1000 + 0.01 * 500);
    expect(agg.theta).toBeCloseTo(-0.05 * 1000 + (-0.03) * 500);
  });
});
