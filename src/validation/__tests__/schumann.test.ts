/**
 * Unit tests of the Anzelius–Schumann closed form (src/validation/schumann.ts).
 *
 * Reference values for J(a, b) = Q₁(√(2b), √(2a)) come from an independent
 * 80-digit decimal evaluation of the Poisson-mixture series (python
 * decimal), which agrees with scipy.stats.ncx2.sf(2a, 2, 2b) to 3e-15
 * relative at every point below.  The test requires 1e-10 relative accuracy,
 * including the small values (1e-54) and the large arguments (a, b ~ 1e3).
 */

import { describe, it, expect } from "vitest";
import {
  lnGamma,
  schumannJ,
  schumannFluidTheta,
  schumannFluidTemperature,
  schumannWallTheta,
  schumannWallTemperature,
} from "../schumann";

// [a, b, J(a, b)]
const REFERENCE: Array<[number, number, number]> = [
  [0.3, 0.5, 0.8313205169908968],
  [2, 1, 0.39429685889233157],
  [5, 3, 0.2981933963739992],
  [10, 0.2, 0.0001773291515199951],
  [1, 8, 0.9973974918990147],
  [20, 15, 0.2230169880123561],
  [100, 90, 0.24528540778788624],
  [250, 300, 0.9844418084753743],
  [400, 380, 0.24250586642454308],
  [0.001, 2, 0.9998645970716757],
  [5.7, 2.6, 0.18061193924595495],
  [50, 1, 1.2172651930100624e-17],
  [0.01, 0.01, 0.990148347812305],
  [200, 10, 2.3834794844817346e-54],
  [700, 650, 0.08891811255316813],
  [30, 2, 9.162716512529296e-9],
  [1200, 1100, 0.018983692184875313],
  [0.04, 25, 0.9999999999991361],
];

describe("lnGamma", () => {
  it("matches math.lgamma", () => {
    const ref: Array<[number, number]> = [
      [0.5, 0.5723649429247004],
      [1.5, -0.12078223763524543],
      [3.7, 1.4280723266653885],
      [14.9, 24.924132002217277],
      [15, 25.191221182738683],
      [100.5, 361.4355404677776],
      [1001, 5912.128178488163],
      [50000.5, 490989.83315821405],
    ];
    for (const [x, v] of ref) {
      expect(Math.abs(lnGamma(x) - v)).toBeLessThan(
        1e-13 * Math.max(1, Math.abs(v)),
      );
    }
    expect(lnGamma(1)).toBeCloseTo(0, 14);
    expect(lnGamma(10)).toBeCloseTo(Math.log(362880), 12);
  });

  it("rejects non-positive arguments", () => {
    expect(() => lnGamma(0)).toThrow(RangeError);
    expect(() => lnGamma(-1)).toThrow(RangeError);
  });
});

describe("schumannJ (Marcum Q1)", () => {
  it.each(REFERENCE)(
    "J(%s, %s) matches the 80-digit reference to 1e-10 relative",
    (a, b, ref) => {
      const v = schumannJ(a, b);
      expect(Math.abs(v - ref) / ref).toBeLessThan(1e-10);
    },
  );

  it("limits: J(0, b) = 1 and J(a, 0) = exp(-a)", () => {
    for (const b of [0, 0.3, 5, 800]) expect(schumannJ(0, b)).toBe(1);
    for (const a of [1e-6, 0.5, 3, 40]) {
      expect(
        Math.abs(schumannJ(a, 0) - Math.exp(-a)) / Math.exp(-a),
      ).toBeLessThan(1e-15);
    }
  });

  it("is monotone: decreasing in a, increasing in b", () => {
    let prev = 1;
    for (let a = 0.25; a < 30; a += 0.25) {
      const v = schumannJ(a, 3);
      expect(v).toBeLessThan(prev);
      prev = v;
    }
    prev = 0;
    for (let b = 0.25; b < 30; b += 0.25) {
      const v = schumannJ(4, b);
      expect(v).toBeGreaterThan(prev);
      prev = v;
    }
  });

  it("agrees with the defining integral 1 - ∫ e^-(b+ξ) I0(2√(bξ)) dξ", () => {
    // Composite Gauss-Legendre (5 points) on the scaled integrand
    // e^{-(√b-√ξ)²} i0e(2√(bξ)) with i0e from its power series (small arguments only).
    const i0 = (x: number) => {
      let term = 1;
      let s = 1;
      for (let k = 1; k < 60; k++) {
        term *= (x * x) / (4 * k * k);
        s += term;
      }
      return s;
    };
    const gl = [
      [-0.906179845938664, 0.2369268850561891],
      [-0.5384693101056831, 0.4786286704993665],
      [0, 0.5688888888888889],
      [0.5384693101056831, 0.4786286704993665],
      [0.906179845938664, 0.2369268850561891],
    ];
    for (const [a, b] of [
      [0.5, 0.5],
      [2, 1],
      [3, 4],
      [5.7, 2.6],
    ]) {
      let integral = 0;
      const panels = 200;
      for (let p = 0; p < panels; p++) {
        const lo = (a * p) / panels;
        const hi = (a * (p + 1)) / panels;
        for (const [x, w] of gl) {
          const xi = 0.5 * (lo + hi) + 0.5 * (hi - lo) * x;
          integral +=
            0.5 *
            (hi - lo) *
            w *
            Math.exp(-(b + xi)) *
            i0(2 * Math.sqrt(b * xi));
        }
      }
      expect(Math.abs(schumannJ(a, b) - (1 - integral))).toBeLessThan(1e-12);
    }
  });

  it("rejects invalid arguments", () => {
    expect(() => schumannJ(-1, 1)).toThrow(RangeError);
    expect(() => schumannJ(1, -1)).toThrow(RangeError);
    expect(() => schumannJ(NaN, 1)).toThrow(RangeError);
    expect(() => schumannJ(1, Infinity)).toThrow(RangeError);
  });
});

describe("Anzelius–Schumann temperatures", () => {
  it("limit zeta -> 0 gives theta_w = exp(-tau) (lumped wall, fluid at inlet temperature)", () => {
    for (const tau of [0.01, 0.5, 2, 7]) {
      const v = schumannWallTheta(0, tau);
      expect(Math.abs(v - Math.exp(-tau)) / Math.exp(-tau)).toBeLessThan(1e-15);
      // Tiny zeta approaches the same limit linearly.
      expect(
        Math.abs(schumannWallTheta(1e-9, tau) - Math.exp(-tau)),
      ).toBeLessThan(1e-8);
    }
  });

  it("limit tau -> 0 gives theta_w = 1, and theta_w = 1 before the front arrives", () => {
    for (const zeta of [0, 0.3, 2, 40]) {
      expect(schumannWallTheta(zeta, 0)).toBe(1);
      expect(schumannWallTheta(zeta, -1)).toBe(1);
      expect(Math.abs(schumannWallTheta(zeta, 1e-12) - 1)).toBeLessThan(1e-11);
    }
  });

  it("fluid: theta_f(zeta, tau=0) = 1 - exp(-zeta) and theta_f -> 1 ahead of the front", () => {
    for (const zeta of [0.1, 1, 3]) {
      expect(
        Math.abs(schumannFluidTheta(zeta, 0) - (1 - Math.exp(-zeta))),
      ).toBeLessThan(1e-15);
    }
    expect(schumannFluidTheta(2, -0.5)).toBe(1);
    // Inlet: theta_f(0, tau) = 0.
    expect(schumannFluidTheta(0, 3)).toBe(0);
  });

  it("satisfies the governing equations (central finite differences)", () => {
    // d theta_f / d zeta = -(theta_f - theta_w),  d theta_w / d tau = theta_f - theta_w
    const h = 1e-4;
    for (const [zeta, tau] of [
      [0.5, 0.7],
      [2, 3],
      [4, 1],
      [1.2, 6],
    ]) {
      const diff = schumannFluidTheta(zeta, tau) - schumannWallTheta(zeta, tau);
      const dFdz =
        (schumannFluidTheta(zeta + h, tau) -
          schumannFluidTheta(zeta - h, tau)) /
        (2 * h);
      const dWdt =
        (schumannWallTheta(zeta, tau + h) - schumannWallTheta(zeta, tau - h)) /
        (2 * h);
      expect(Math.abs(dFdz + diff)).toBeLessThan(1e-7);
      expect(Math.abs(dWdt - diff)).toBeLessThan(1e-7);
    }
  });

  it("dimensional wrappers apply the transit delay", () => {
    const p = { a: 0.038, b: 0.94, u: 4, Tf0: 33.15, Tw0: 300 };
    const z = 0.5;
    // Before z/u the wall is untouched and the fluid is at its initial temperature.
    expect(schumannWallTemperature(p, z, 0.5 * (z / p.u))).toBe(300);
    expect(schumannFluidTemperature(p, z, 0.5 * (z / p.u))).toBe(300);
    // Long after the front the wall approaches the inlet temperature.
    const late = schumannWallTemperature(p, z, 2000);
    expect(late).toBeGreaterThanOrEqual(33.15);
    expect(late - 33.15).toBeLessThan(1e-6);
    // Mid-transient value equals the dimensionless formula.
    const t = 40;
    const tau = p.a * (t - z / p.u);
    expect(schumannWallTemperature(p, z, t)).toBeCloseTo(
      33.15 + 266.85 * schumannJ(tau, p.b * z),
      10,
    );
  });
});
