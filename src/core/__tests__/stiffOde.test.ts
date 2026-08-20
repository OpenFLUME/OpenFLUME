import { describe, it, expect } from "vitest";
import { integrateBDF1 } from "../stiffOde";

describe("BDF1 stiff ODE integrator", () => {
  it("stays stable on scalar stiff test y' = -1000(y - cos(t)) at large dt", () => {
    // The point is stability, not accuracy at large step.
    // BDF1 is unconditionally stable; with loose tol it should finish
    // without blow-up even with dt far beyond the explicit limit (~0.002).
    const f = (_t: number, y: number[]) => [-1000 * (y[0] - Math.cos(_t))];
    const tf = 0.05; // 50× the time constant (0.001)
    const res = integrateBDF1(f, [2.0], 0, tf, {
      atol: 1e-6,
      rtol: 1e-4,
      dtMax: 0.02,
    });

    // Exact steady-state particular solution: A·cos(t)+B·sin(t) where
    // B + 1000·A = 1000,  -A + 1000·B = 0  →  A ≈ 1, B ≈ 0.001
    const expected = (1000000 * Math.cos(tf) + 1000 * Math.sin(tf)) / 1000001;
    expect(Math.abs(res.y[0] - expected)).toBeLessThan(0.05);
    expect(Number.isFinite(res.y[0])).toBe(true);
  });

  it("linear stiff 2×2 with eigenvalue ratio ~1e6", () => {
    // System: y' = A·y where A = [[-1, 1], [0, -1e6]]
    // Exact: y1(t) = y1(0)·exp(-t) + y2(0)·(exp(-t) - exp(-1e6·t))/(1e6 - 1)
    //        y2(t) = y2(0)·exp(-1e6·t)
    const lambdaFast = 1e6;
    const f = (_t: number, y: number[]) => [
      -1 * y[0] + 1 * y[1],
      -lambdaFast * y[1],
    ];
    const y0 = [1, 1];
    const tf = 0.01; // 10× the slow time constant, 10000× the fast one
    const res = integrateBDF1(f, y0, 0, tf, {
      atol: 1e-6,
      rtol: 1e-4,
      dtMax: 0.02,
    });

    const exactY2 = Math.exp(-lambdaFast * tf);
    const exactY1 =
      Math.exp(-tf) + (Math.exp(-tf) - exactY2) / (lambdaFast - 1);

    expect(
      Math.abs(res.y[1] - exactY2) / Math.max(Math.abs(exactY2), 1e-12),
    ).toBeLessThan(0.05);
    expect(
      Math.abs(res.y[0] - exactY1) / Math.max(Math.abs(exactY1), 1e-12),
    ).toBeLessThan(0.05);
    expect(Number.isFinite(res.y[0]) && Number.isFinite(res.y[1])).toBe(true);
  });

  it("reversible reaction A⇌B relaxes to equilibrium with known analytical solution", () => {
    // A ⇌ B with kf = 10, kr = 2
    // d[A]/dt = -kf·[A] + kr·[B]
    // Exact: [A](t) = [A]_eq + ([A]_0 - [A]_eq)·exp(-(kf+kr)·t)
    // Equilibrium: [A]_eq = kr/(kf+kr) = 2/12 = 0.1667
    const kf = 10;
    const kr = 2;
    const f = (_t: number, y: number[]) => {
      const a = y[0];
      const b = y[1];
      const rate = kf * a - kr * b;
      return [-rate, rate];
    };
    const y0 = [1, 0];
    const tf = 1.0; // several time constants (1/(kf+kr) = 1/12)
    const res = integrateBDF1(f, y0, 0, tf, { atol: 1e-8, rtol: 1e-6 });

    const aEq = kr / (kf + kr);
    const aExact = aEq + (y0[0] - aEq) * Math.exp(-(kf + kr) * tf);
    expect(Math.abs(res.y[0] - aExact)).toBeLessThan(1e-6);
    expect(Math.abs(res.y[1] - (1 - aExact))).toBeLessThan(1e-6);
  });

  it("empirical first-order convergence (halve step, error halves)", () => {
    // Simple exponential decay: y' = -y, y(0)=1, y(t)=exp(-t)
    // Not stiff — just verifying the integrator order.
    // Use loose tolerance so adaptive controller accepts the fixed step quickly.
    const f = (_t: number, y: number[]) => [-y[0]];
    const tf = 0.5;

    const run = (dtMax: number) =>
      integrateBDF1(f, [1], 0, tf, {
        atol: 1e-6,
        rtol: 1,
        dtMax,
        dtMin: dtMax,
      });

    const res1 = run(0.1);
    const res2 = run(0.05);
    const res3 = run(0.025);

    const exact = Math.exp(-tf);
    const err1 = Math.abs(res1.y[0] - exact);
    const err2 = Math.abs(res2.y[0] - exact);
    const err3 = Math.abs(res3.y[0] - exact);

    // BDF1 is first-order: halving dt should roughly halve error
    const ratio12 = err1 / err2;
    const ratio23 = err2 / err3;

    expect(ratio12).toBeGreaterThanOrEqual(1.5);
    expect(ratio12).toBeLessThanOrEqual(2.5);
    expect(ratio23).toBeGreaterThanOrEqual(1.5);
    expect(ratio23).toBeLessThanOrEqual(2.5);
  });
});
