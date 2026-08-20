/**
 * Analytical unit tests for the station-interpolation and smooth
 * threshold-crossing utilities.
 *
 * The smoothness test is the point of the exercise: the naive
 * "first index below threshold" is piecewise-constant in any parameter
 * (gradient identically zero a.e. — the measured calibration trap),
 * while the interpolated crossing is exact on linear traces and varies
 * smoothly under perturbation.
 */

import { describe, it, expect } from 'vitest';
import {
  interpolateAtPosition,
  interpolateTraceToStation,
  thresholdCrossingTime,
} from '../stationInterp';

describe('interpolateAtPosition', () => {
  it('is exact on a linear field at interior points', () => {
    const x = [0, 3, 7, 12, 20];
    const f = (xx: number) => 2 * xx + 1;
    const y = x.map(f);
    for (const q of [0.5, 2.9, 3, 5, 11.9, 19.999]) {
      expect(interpolateAtPosition(x, y, q)).toBeCloseTo(f(q), 10);
    }
  });

  it('returns the chord value on a quadratic field (exactly computable)', () => {
    // T = x^2 sampled at integers; linear interp on [1,2] at x=1.5 = (1+4)/2 = 2.5
    const x = [0, 1, 2, 3];
    const y = x.map((xx) => xx * xx);
    expect(interpolateAtPosition(x, y, 1.5)).toBeCloseTo(2.5, 12);
    // chord on [2,3] at 2.25: 4 + 0.25*(9-4) = 5.25
    expect(interpolateAtPosition(x, y, 2.25)).toBeCloseTo(5.25, 12);
  });

  it('clamps at the ends (no extrapolation)', () => {
    const x = [1, 2, 3];
    const y = [10, 20, 30];
    expect(interpolateAtPosition(x, y, -5)).toBe(10);
    expect(interpolateAtPosition(x, y, 1)).toBe(10);
    expect(interpolateAtPosition(x, y, 3)).toBe(30);
    expect(interpolateAtPosition(x, y, 99)).toBe(30);
  });

  it('throws on bad input', () => {
    expect(() => interpolateAtPosition([1, 2], [1], 1.5)).toThrow();
    expect(() => interpolateAtPosition([], [], 1.5)).toThrow();
    expect(() => interpolateAtPosition([2, 1], [1, 2], 1.5)).toThrow(); // not ascending
  });
});

describe('interpolateTraceToStation', () => {
  it('interpolates every time slice to the station', () => {
    // Three nodes at 0/10/20 m; field T(x,k) = x + 100*k (linear in x ⇒ exact).
    const xPos = [0, 10, 20];
    const traces = [
      [0, 100, 200],
      [10, 110, 210],
      [20, 120, 220],
    ];
    const s = interpolateTraceToStation(xPos, traces, 15);
    expect(s).toEqual([15, 115, 215]);
  });

  it('clamps beyond the last node', () => {
    const xPos = [0, 10, 20];
    const traces = [
      [0, 5],
      [10, 15],
      [20, 25],
    ];
    expect(interpolateTraceToStation(xPos, traces, 25)).toEqual([20, 25]);
  });
});

describe('thresholdCrossingTime', () => {
  it('is exact on an analytically known monotone crossing', () => {
    // T(t) = 300 − 1.7 t  ⇒ crosses 100 K at t = 200/1.7 = 117.6470588…
    const times = Array.from({ length: 31 }, (_, k) => k * 10);
    const values = times.map((t) => 300 - 1.7 * t);
    const tc = thresholdCrossingTime(times, values, 100);
    expect(tc).toBeDefined();
    expect(tc!).toBeCloseTo(200 / 1.7, 9);
  });

  it('brackets the naive step answer', () => {
    const times = Array.from({ length: 31 }, (_, k) => k * 10);
    const values = times.map((t) => 300 - 1.7 * t);
    const naiveIdx = values.findIndex((v) => v < 100);
    const tc = thresholdCrossingTime(times, values, 100)!;
    expect(tc).toBeGreaterThanOrEqual(times[naiveIdx - 1]);
    expect(tc).toBeLessThanOrEqual(times[naiveIdx]);
  });

  it('handles direction "above"', () => {
    const times = [0, 1, 2, 3];
    const values = [10, 30, 50, 70]; // crosses 40 between k=1 and k=2
    expect(thresholdCrossingTime(times, values, 40, 'above')).toBeCloseTo(1.5, 12);
  });

  it('returns times[0] when already past the threshold at record start', () => {
    expect(thresholdCrossingTime([5, 10, 15], [50, 40, 30], 100)).toBe(5);
  });

  it('returns undefined for a non-crossing trace (documented)', () => {
    const times = [0, 10, 20, 30];
    const values = [300, 250, 200, 150];
    expect(thresholdCrossingTime(times, values, 100)).toBeUndefined();
  });

  it('non-monotone convention: FIRST crossing is returned', () => {
    // Dips below threshold at k=2, rises back above, falls again at k=4.
    const times = [0, 1, 2, 3, 4];
    const values = [300, 150, 90, 150, 80];
    // first crossing between k=1 (150) and k=2 (90): t = 1 + (150−100)/(150−90)
    expect(thresholdCrossingTime(times, values, 100)).toBeCloseTo(1 + 50 / 60, 9);
  });

  it('throws on length mismatch; undefined on empty', () => {
    expect(() => thresholdCrossingTime([0, 1], [1], 0.5)).toThrow();
    expect(thresholdCrossingTime([], [], 0.5)).toBeUndefined();
  });
});

describe('smoothness — the property that makes gradient calibration possible', () => {
  /**
   * Family of parametrised cooling traces T(t; a) = 300 − a·t sampled on a
   * fixed 10 s grid.  Analytic crossing of 100 K: t*(a) = 200/a.
   * Because each trace is exactly linear in t, the interpolated crossing
   * must equal t*(a) EXACTLY; the naive step version must quantise.
   */
  const tStar = (a: number) => 200 / a;
  const times = Array.from({ length: 61 }, (_, k) => k * 10); // 0…600 s
  const trace = (a: number) => times.map((t) => 300 - a * t);

  it('interpolated crossing is exact on linear traces', () => {
    for (const a of [0.4, 0.5, 0.75, 1.0, 1.3, 1.7, 2.0]) {
      const tc = thresholdCrossingTime(times, trace(a), 100)!;
      expect(tc).toBeCloseTo(tStar(a), 9);
    }
  });

  it('naive crossing is piecewise-constant (zero gradient a.e.) — the trap', () => {
    const naive = (a: number) => {
      const v = trace(a);
      const i = v.findIndex((x) => x < 100);
      return i >= 0 ? times[i] : undefined;
    };
    // Two different parameter values with DIFFERENT analytic crossings…
    // (both inside the same 10 s grid cell (390, 400))
    const a1 = 0.502; // t* = 398.41 s
    const a2 = 0.508; // t* = 393.70 s
    expect(tStar(a1)).not.toBeCloseTo(tStar(a2), 3);
    // …collapse to the SAME naive answer ⇒ local gradient exactly zero.
    expect(naive(a1)).toBe(naive(a2));
    // The smooth crossing separates them.
    const s1 = thresholdCrossingTime(times, trace(a1), 100)!;
    const s2 = thresholdCrossingTime(times, trace(a2), 100)!;
    expect(s1).toBeGreaterThan(s2);
    expect(Math.abs(s1 - s2)).toBeGreaterThan(1);
  });

  it('crossing time varies smoothly under a small parameter perturbation', () => {
    // Central-difference quotient ≈ analytic derivative dt*/da = −200/a²,
    // and the perturbation response is proportional (Lipschitz), not a jump.
    const a = 1.0;
    const da = 1e-3;
    const s = (aa: number) => thresholdCrossingTime(times, trace(aa), 100)!;
    const dq = (s(a + da) - s(a - da)) / (2 * da);
    // Central difference has O(da²) truncation = (da²/6)·|f‴| = 2e-4 here;
    // assert agreement within that deterministic bound.
    expect(Math.abs(dq - -200 / (a * a))).toBeLessThan(3e-4);
    // Response stays bounded and continuous down to arbitrarily small da:
    for (const eps of [1e-4, 1e-6, 1e-8]) {
      expect(Math.abs(s(a + eps) - s(a))).toBeLessThanOrEqual((200 / (a * a)) * eps + 1e-6);
    }
  });

  it('crossing is smooth under small perturbation of the SAMPLES (not just a parameter)', () => {
    // Perturb one interior sample value by ε; crossing moves by O(ε), not by a grid step.
    const base = trace(1.0);
    const kCross = base.findIndex((v) => v < 100);
    const s0 = thresholdCrossingTime(times, base, 100)!;
    const eps = 1e-3;
    const perturbed = base.slice();
    perturbed[kCross - 1] += eps; // move the bracketing sample
    const s1 = thresholdCrossingTime(times, perturbed, 100)!;
    // slope of values at the bracket is −10 K/step ⇒ Δt ≈ ε/10 s, tiny vs the 10 s grid.
    expect(Math.abs(s1 - s0)).toBeLessThan(0.001);
    expect(Math.abs(s1 - s0)).toBeGreaterThan(0);
  });
});
