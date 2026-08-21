/**
 * Tests for the TT-WF trace-evaluation plumbing (ttwfTraceEvaluation.ts) —
 * the artifact/summary layer of the Phase-3 fixed-parameter campaign.
 *
 * SCOPE DISCIPLINE (same as traceBaseline.test.ts): these tests pin the
 * PLUMBING — pre-registered parameter echo, accepted-step history
 * summarization with hand-computed expectations, per-station subcell-front
 * arrival interpolation, and run-level campaign pooling.  They deliberately
 * do NOT pin any numerical model-error value from a real solve (RMSE/knee
 * errors change legitimately when the model improves).
 */

import { describe, it, expect } from 'vitest';
import { TTWF_DEFAULT_PARAMS } from '../../core';
import {
  poolCampaign,
  summarizeTtWfConductorHistory,
  ttwfStationFrontArrivals,
  TTWF_PREREGISTERED_PARAMS,
} from '../ttwfTraceEvaluation';
import { stationXM } from '../nbsChilldown';
import type { TtWfConductorHistory } from '../../core/schema';

// ---------------------------------------------------------------------------
// Pre-registered parameter echo (the campaign's no-tuning guard)
// ---------------------------------------------------------------------------

describe('TTWF_PREREGISTERED_PARAMS', () => {
  it('equals the core TT-WF defaults (C_q = 1, ΔT_h = 2 K) — the fixed vector under test', () => {
    // The evaluation driver self-checks this at startup and refuses to run
    // on drift; this test is the suite-level pin of the same contract.
    expect(TTWF_DEFAULT_PARAMS.frontEnergyFactor).toBe(TTWF_PREREGISTERED_PARAMS.frontEnergyFactor);
    expect(TTWF_DEFAULT_PARAMS.rewetHysteresisOffsetK).toBe(TTWF_PREREGISTERED_PARAMS.rewetHysteresisOffsetK);
  });
});

// ---------------------------------------------------------------------------
// Per-conductor accepted-step history summarization
// ---------------------------------------------------------------------------

describe('summarizeTtWfConductorHistory', () => {
  const timesS = [0, 1, 2, 3, 4];
  const history: TtWfConductorHistory = {
    fWet: [0, 0.2, 0.6, 1, 1],
    rewetLatched: [false, false, true, true, false],
    regime: ['FB', 'FB', 'NB', 'NB', 'DB'],
  };

  it('extracts latch transitions, smooth fWet crossings, and compressed regime runs', () => {
    const s = summarizeTtWfConductorHistory('conv1', 10.16, timesS, history);
    expect(s.conductorId).toBe('conv1');
    expect(s.axialPositionM).toBeCloseTo(10.16, 12);
    // Latch: set at t=2, clear at t=4; one transition each (chatter check).
    expect(s.latchSetS).toBe(2);
    expect(s.latchClearS).toBe(4);
    expect(s.latchSetCount).toBe(1);
    expect(s.latchClearCount).toBe(1);
    // fWet 0.5 crossing: between k=1 (0.2) and k=2 (0.6) → 1.75.
    expect(s.fWet50S).toBeCloseTo(1.75, 12);
    // fWet 0.99 crossing: between k=2 (0.6) and k=3 (1) → 2.975.
    expect(s.fWet99S).toBeCloseTo(2.975, 12);
    expect(s.finalFWet).toBe(1);
    expect(s.minFWet).toBe(0);
    expect(s.maxFWet).toBe(1);
    // Regime compression: FB(0–1) → NB(2–3) → DB(4–4).
    expect(s.regimeRuns).toEqual([
      { regime: 'FB', fromS: 0, toS: 1 },
      { regime: 'NB', fromS: 2, toS: 3 },
      { regime: 'DB', fromS: 4, toS: 4 },
    ]);
  });

  it('never-latched / never-arrived histories report undefined, not fabricated times', () => {
    const dry: TtWfConductorHistory = {
      fWet: [0, 0, 0, 0, 0],
      rewetLatched: [false, false, false, false, false],
      regime: ['FB', 'FB', 'FB', 'FB', 'FB'],
    };
    const s = summarizeTtWfConductorHistory('conv0', 0, timesS, dry);
    expect(s.latchSetS).toBeUndefined();
    expect(s.latchClearS).toBeUndefined();
    expect(s.fWet50S).toBeUndefined();
    expect(s.fWet99S).toBeUndefined();
    expect(s.latchSetCount).toBe(0);
    expect(s.regimeRuns).toEqual([{ regime: 'FB', fromS: 0, toS: 4 }]);
  });

  it('throws on a history/time length mismatch (the accepted-step alignment contract)', () => {
    const bad: TtWfConductorHistory = {
      fWet: [0, 1],
      rewetLatched: [false, true],
      regime: ['FB', 'NB'],
    };
    expect(() => summarizeTtWfConductorHistory('conv0', 0, timesS, bad)).toThrow(/alignment contract/);
  });
});

// ---------------------------------------------------------------------------
// Per-station subcell-front arrival (spatial interpolation of fWet)
// ---------------------------------------------------------------------------

describe('ttwfStationFrontArrivals', () => {
  it('interpolates the fWet field in space to the exact station before crossing', () => {
    // Two conductors bracketing station 1 (6.096 m): x = 0 and 12.192 m.
    // fWet_a = [0,0,1,1] at x=0; fWet_b = [0,0,0,1] at x=12.192.
    // Station midpoint field = [0,0,0.5,1] → 0.5 crossing at t=2 (the
    // 'above' convention crosses AT the bracket start when the level is
    // hit exactly), 0.99 crossing at 2 + 0.98 = 2.98.
    const timesS = [0, 1, 2, 3];
    const arrivals = ttwfStationFrontArrivals(timesS, [
      { axialPositionM: 0, fWet: [0, 0, 1, 1] },
      { axialPositionM: 2 * stationXM(1), fWet: [0, 0, 0, 1] },
    ]);
    const st1 = arrivals.find((a) => a.station === 1)!;
    expect(st1.fWet50S).toBeCloseTo(2, 12);
    expect(st1.fWet99S).toBeCloseTo(2.98, 12);
  });

  it('a front that never arrives yields undefined (reported, never extrapolated)', () => {
    const timesS = [0, 1, 2, 3];
    const arrivals = ttwfStationFrontArrivals(timesS, [
      { axialPositionM: 0, fWet: [0, 0.1, 0.2, 0.3] },
      { axialPositionM: 60.96, fWet: [0, 0.1, 0.2, 0.3] },
    ]);
    for (const a of arrivals) {
      expect(a.fWet50S).toBeUndefined();
      expect(a.fWet99S).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Campaign pooling (run-level, equal weight per run)
// ---------------------------------------------------------------------------

describe('poolCampaign', () => {
  const runs = [
    { runId: 'runA', status: 'ok', rmseK: 10, maeK: 5 },
    { runId: 'runB', status: 'ok', rmseK: 20, maeK: 8 },
    { runId: 'runC', status: 'timeout' }, // not evaluable — excluded, counted out
    { runId: 'runD', status: 'ok', rmseK: 30, maeK: 12 },
  ];

  it('pools equal-weight per run over completed solves only', () => {
    const p = poolCampaign('ttWf', runs);
    expect(p.runsOk).toBe(3);
    // sqrt(mean(rmse²)) = sqrt((100+400+900)/3) = sqrt(466.67) ≈ 21.6025.
    expect(p.rmseK).toBeCloseTo(Math.sqrt(1400 / 3), 9);
    expect(p.maeK).toBeCloseTo((5 + 8 + 12) / 3, 12);
  });

  it('run restriction (like-for-like subsets) intersects before pooling', () => {
    const p = poolCampaign('ttWf', runs, ['runA', 'runB']);
    expect(p.runsOk).toBe(2);
    expect(p.rmseK).toBeCloseTo(Math.sqrt(250), 9);
    expect(p.maeK).toBeCloseTo(6.5, 12);
  });

  it('a closure with no completed solves reports undefined metrics (never 0)', () => {
    const p = poolCampaign('ttWf', [{ runId: 'runX', status: 'timeout' }]);
    expect(p.runsOk).toBe(0);
    expect(p.rmseK).toBeUndefined();
    expect(p.maeK).toBeUndefined();
  });
});
