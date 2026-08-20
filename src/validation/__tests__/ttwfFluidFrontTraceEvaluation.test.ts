/**
 * Tests for the TT-WF + fluid-front trace-evaluation plumbing
 * (ttwfFluidFrontTraceEvaluation.ts) — the artifact/summary layer of the
 * Phase-3B fixed-parameter falsification campaign.
 *
 * SCOPE DISCIPLINE (same as ttwfTraceEvaluation.test.ts): these tests pin
 * the PLUMBING — pre-registered configuration echo, accepted-step
 * front-fraction history summarization with hand-computed expectations,
 * per-station front-arrival interpolation (incl. the boundary anchors), and
 * the recorded-series tracer-conservation audit arithmetic.  They
 * deliberately do NOT pin any numerical model-error value from a real
 * solve (RMSE/knee errors change legitimately when the model improves).
 */

import { describe, it, expect } from 'vitest';
import { TTWF_DEFAULT_PARAMS } from '../../core';
import {
  fluidFrontStationArrivals,
  fluidFrontTracerAudit,
  summarizeFluidFrontNodeHistory,
  TTWF_FLUID_FRONT_PREREGISTERED,
} from '../ttwfFluidFrontTraceEvaluation';
import { TTWF_PREREGISTERED_PARAMS } from '../ttwfTraceEvaluation';
import { stationXM } from '../nbsChilldown';

// ---------------------------------------------------------------------------
// Pre-registered configuration echo (the campaign's no-tuning guard)
// ---------------------------------------------------------------------------

describe('TTWF_FLUID_FRONT_PREREGISTERED', () => {
  it('echoes the fixed front configuration and matches the TT-WF pre-registered vector', () => {
    expect(TTWF_FLUID_FRONT_PREREGISTERED.fluidFront).toBe(true);
    expect(TTWF_FLUID_FRONT_PREREGISTERED.fluidFrontInlet).toBe(1);
    // The TT-WF parameter vector under test is the SAME pre-registered
    // vector as the ungated campaign — no second tuning surface.
    expect(TTWF_FLUID_FRONT_PREREGISTERED.frontEnergyFactor).toBe(TTWF_PREREGISTERED_PARAMS.frontEnergyFactor);
    expect(TTWF_FLUID_FRONT_PREREGISTERED.rewetHysteresisOffsetK).toBe(TTWF_PREREGISTERED_PARAMS.rewetHysteresisOffsetK);
    // … and both equal the core defaults (the driver self-checks this too).
    expect(TTWF_DEFAULT_PARAMS.frontEnergyFactor).toBe(TTWF_PREREGISTERED_PARAMS.frontEnergyFactor);
    expect(TTWF_DEFAULT_PARAMS.rewetHysteresisOffsetK).toBe(TTWF_PREREGISTERED_PARAMS.rewetHysteresisOffsetK);
  });
});

// ---------------------------------------------------------------------------
// Per-node front-fraction history summarization
// ---------------------------------------------------------------------------

describe('summarizeFluidFrontNodeHistory', () => {
  const timesS = [0, 1, 2, 3, 4];

  it('extracts smooth a crossings and bounds with hand-computed values', () => {
    // a: 0 → 0.2 → 0.6 → 1 → 1: 0.5 crossing between k=1 and k=2 at
    // 1 + 0.3/0.4 = 1.75; 0.99 crossing between k=2 and k=3 at
    // 2 + 0.39/0.4 = 2.975.
    const s = summarizeFluidFrontNodeHistory('f1', 10.16, timesS, [0, 0.2, 0.6, 1, 1]);
    expect(s.nodeId).toBe('f1');
    expect(s.axialPositionM).toBeCloseTo(10.16, 12);
    expect(s.a50S).toBeCloseTo(1.75, 12);
    expect(s.a99S).toBeCloseTo(2.975, 12);
    expect(s.finalA).toBe(1);
    expect(s.minA).toBe(0);
    expect(s.maxA).toBe(1);
  });

  it('a front that never arrives reports undefined crossings (never fabricated)', () => {
    const s = summarizeFluidFrontNodeHistory('f3', 30.48, timesS, [0, 0.05, 0.1, 0.12, 0.12]);
    expect(s.a50S).toBeUndefined();
    expect(s.a99S).toBeUndefined();
    expect(s.finalA).toBe(0.12);
    expect(s.maxA).toBe(0.12);
  });

  it('throws on a history/time length mismatch (the accepted-step alignment contract)', () => {
    expect(() => summarizeFluidFrontNodeHistory('f1', 10.16, timesS, [0, 1])).toThrow(/alignment contract/);
  });
});

// ---------------------------------------------------------------------------
// Per-station front arrival (spatial interpolation with boundary anchors)
// ---------------------------------------------------------------------------

describe('fluidFrontStationArrivals', () => {
  it('anchors the inlet boundary at a = 1 (constant) and interpolates to the exact station', () => {
    // One internal node exactly at 2× station 1 (12.192 m): the inlet anchor
    // (x=0, a=1 constant) and the node series [0,0,1,1] give the station-1
    // midpoint field [0.5, 0.5, 1, 1] → a50 crossing AT t=0 (the 'above'
    // convention does not trigger on a start-at-level), actually: a starts
    // at exactly 0.5 — check the documented crossing behavior.
    const timesS = [0, 1, 2, 3];
    const arrivals = fluidFrontStationArrivals(
      timesS,
      [{ axialPositionM: 2 * stationXM(1), fraction: [0, 0, 1, 1] }],
      { inletXM: 0, inletA: 1, outletXM: 3 * stationXM(1) }
    );
    const st1 = arrivals.find((a) => a.station === 1)!;
    // Station-1 field: (1 + a_node)/2 = [0.5, 0.5, 1, 1].  'above' 0.5:
    // first sample STRICTLY above is k=2 (a=1) — bracketed crossing at the
    // k=1→k=2 interval start per thresholdCrossingTime's convention…
    // (hand-check: values 0.5, 0.5, 1 — first k with v > 0.5 is k=2, and
    // the smooth crossing is linear between k=1 (0.5) and k=2 (1) at the
    // level 0.5 ⇒ t = 1).  a99: between k=1 and k=2 at 1 + 0.98 = 1.98.
    expect(st1.a50S).toBeCloseTo(1, 12);
    expect(st1.a99S).toBeCloseTo(1.98, 12);
  });

  it('the outlet anchor carries the upwind (last internal) node series (no station extrapolation bias)', () => {
    // Two internal nodes at station 2 and halfway to station 4; station 4
    // (60.35 m) sits between the last internal node and the outlet anchor
    // (x = L), which duplicates the upwind series — so the station-4 field
    // equals the last internal node's series exactly.
    const timesS = [0, 1, 2, 3];
    const lastNode = { axialPositionM: 50.8, fraction: [0, 0, 0.6, 1] };
    const arrivals = fluidFrontStationArrivals(
      timesS,
      [{ axialPositionM: 10.16, fraction: [0, 1, 1, 1] }, lastNode],
      { inletXM: 0, inletA: 1, outletXM: 60.96 }
    );
    const st4 = arrivals.find((a) => a.station === 4)!;
    // last-node series crossed 0.5 between k=1 and k=2 at 1 + 0.5/0.6…
    // values [0, 0, 0.6, 1]: first k with v > 0.5 is k=2; smooth crossing
    // between k=1 (0) and k=2 (0.6) at level 0.5 ⇒ t = 1 + 0.5/0.6 = 1.8333.
    expect(st4.a50S).toBeCloseTo(1 + 0.5 / 0.6, 9);
  });

  it('a front that never arrives yields undefined (reported, never extrapolated)', () => {
    const timesS = [0, 1, 2, 3];
    const arrivals = fluidFrontStationArrivals(
      timesS,
      [{ axialPositionM: 10.16, fraction: [0, 0.1, 0.2, 0.3] }],
      { inletXM: 0, inletA: 0, outletXM: 60.96 }
    );
    // With a warm inlet (a_bnd = 0) and a node that never reaches 0.5, no
    // station may report an arrival.
    for (const a of arrivals) {
      expect(a.a50S).toBeUndefined();
      expect(a.a99S).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Recorded-series tracer-conservation audit (hand-computed arithmetic)
// ---------------------------------------------------------------------------

describe('fluidFrontTracerAudit', () => {
  it('reproduces the BE telescoping identity on a hand-computed two-node example', () => {
    // Two internal nodes in series, constant masses m1 = m2 = 2 kg,
    // constant inlet mdot = 1 kg/s (a_bnd = 1), outlet mdot = 1 kg/s,
    // dt = 1 s, three steps.  BE commits (upwind):
    //   step 1: a1 = (2·0 + 1·1)/(2/1 + 1) = 1/3;  a2 = (2·0 + 1·a1)/(3) = 1/9
    //   step 2: a1 = (2·(1/3) + 1)/3 = 5/9;        a2 = (2·(1/9) + 5/9)/3 = 7/27
    //   step 3: a1 = (2·(5/9) + 1)/3 = 19/27;      a2 = (2·(7/27) + 19/27)/3 = 33/81
    const a1 = [0, 1 / 3, 5 / 9, 19 / 27];
    const a2 = [0, 1 / 9, 7 / 27, 33 / 81];
    const audit = fluidFrontTracerAudit({
      timesS: [0, 1, 2, 3],
      nodes: [
        { id: 'f1', volumeM3: 1, density: [2, 2, 2, 2] },
        { id: 'f2', volumeM3: 1, density: [2, 2, 2, 2] },
      ],
      fraction: { f1: a1, f2: a2 },
      inletMdot: [1, 1, 1, 1],
      outletMdot: [1, 1, 1, 1],
      outletUpwindNodeId: 'f2',
      inletBoundaryA: 1,
    });
    // Hand-computed expectation: ΔΣ(m·a) = 2·(19/27 + 33/81) − 0
    //   = 2·(57/81 + 33/81) = 180/81 = 20/9.
    // ∫Φ dt (right rectangle) = Σ_k (1·1 − 1·a2[k+1])·1
    //   = (1 − 1/9) + (1 − 7/27) + (1 − 33/81) = 8/9 + 20/27 + 48/81
    //   = 72/81 + 60/81 + 48/81 = 180/81 = 20/9  — identical (telescoped).
    expect(audit).toBeDefined();
    expect(audit!.dStoredTracerKg).toBeCloseTo(20 / 9, 12);
    expect(audit!.integralBoundaryInfluxKg).toBeCloseTo(20 / 9, 12);
    expect(audit!.relativeError).toBeCloseTo(0, 12);
  });

  it('a mismatch is reported, not hidden (scale-referenced)', () => {
    // Corrupt the f2 series: the audit MUST measure the discrepancy.
    const audit = fluidFrontTracerAudit({
      timesS: [0, 1],
      nodes: [{ id: 'f1', volumeM3: 1, density: [1, 1] }],
      fraction: { f1: [0, 0.25] }, // claims 0.25 kg stored…
      inletMdot: [1, 1], // …but the boundary supplied 1 kg
      outletMdot: [0, 0],
      outletUpwindNodeId: 'f1',
      inletBoundaryA: 1,
    });
    expect(audit!.dStoredTracerKg).toBeCloseTo(0.25, 12);
    expect(audit!.integralBoundaryInfluxKg).toBeCloseTo(1, 12);
    expect(audit!.relativeError).toBeCloseTo(0.75, 12);
  });

  it('degenerate (single-sample) results yield undefined, not a fabricated zero', () => {
    const audit = fluidFrontTracerAudit({
      timesS: [0],
      nodes: [{ id: 'f1', volumeM3: 1, density: [1] }],
      fraction: { f1: [0] },
      inletMdot: [1],
      outletMdot: [0],
      outletUpwindNodeId: 'f1',
      inletBoundaryA: 1,
    });
    expect(audit).toBeUndefined();
  });
});
