/**
 * Integration tests for the trace-baseline plumbing (traceBaseline.ts) —
 * the objective/data-extraction layer of the pre-fit Miropolskii vs
 * Darr–Hartwig comparison against the trusted NBS-9264 corpus.
 *
 * SCOPE DISCIPLINE (per the tasking protocol): these tests pin the
 * PLUMBING — station extraction on synthetic data with hand-computed
 * expectations, QC-gated feature availability on real corpus metadata,
 * and the pre-registered solve-plan mapping.  They deliberately do NOT
 * pin any numerical model-error value (RMSE/knee errors of a real solve
 * change legitimately when the model improves).
 */

import { describe, it, expect } from 'vitest';
import {
  compareRunTraces,
  compareStationTrace,
  dataNativeKneeThresholdK,
  extractModelStationTrace,
  guardedFrontOrdering150K,
  onsetOptionsFor,
  runRateHalfWindowS,
  solveSpecForRun,
  TRACE_BASELINE_SOLVE_PLAN,
  type ModelWallHistory,
} from '../traceBaseline';
import {
  getTraceRun,
  NBS_TRUSTED_SATURATED_TRACE_RUNS,
} from '../nbsTraceCorpus';
import { NBS_CHILLDOWN_RIG } from '../nbsChilldown';

// ---------------------------------------------------------------------------
// Synthetic model history with a known closed-form field
// ---------------------------------------------------------------------------

/**
 * T(x, t) = 300 − x − t on a 3-node wall grid at 0 / 30.48 / 60.96 m —
 * linear in x and t, so spatial interpolation to any station is exact:
 * T(station, t) = 300 − xStation − t.
 */
function syntheticModel(timesS: number[]): ModelWallHistory {
  const wallXM = [0, 30.48, 60.96];
  return {
    timesS,
    wallXM,
    wallTracesK: wallXM.map((x) => timesS.map((t) => 300 - x - t)),
  };
}

describe('extractModelStationTrace: exact NBS station positions', () => {
  const timesS = [0, 10, 20, 30];
  const model = syntheticModel(timesS);

  it('interpolates in space to the exact station coordinates (no snapping)', () => {
    for (const st of NBS_CHILLDOWN_RIG.stations) {
      const tr = extractModelStationTrace(model, st.id);
      expect(tr.timesS).toEqual(timesS);
      tr.valuesK.forEach((v, k) => {
        expect(v).toBeCloseTo(300 - st.xM - timesS[k], 12);
      });
    }
  });

  it('station 1 (6.096 m) differs from every node — proves no nearest-node collapse', () => {
    const tr = extractModelStationTrace(model, 1);
    // x=6.096 is NOT a node (nodes at 0/30.48/60.96); value at t=0 is 293.904.
    expect(tr.valuesK[0]).toBeCloseTo(300 - 6.096, 12);
    expect(tr.valuesK[0]).not.toBeCloseTo(300 - 0, 9);
    expect(tr.valuesK[0]).not.toBeCloseTo(300 - 30.48, 9);
  });

  it('station 4 (60.3504 m) is bracketed by the outlet wall node at 60.96 m', () => {
    const tr = extractModelStationTrace(model, 4);
    expect(tr.valuesK[0]).toBeCloseTo(300 - 60.3504, 12);
  });
});

// ---------------------------------------------------------------------------
// Solve-plan mapping (the pre-registered discretization, protocol §3.1.6)
// ---------------------------------------------------------------------------

describe('TRACE_BASELINE_SOLVE_PLAN: pre-registered discretization per trusted run', () => {
  it('covers exactly the 4 trusted saturated corpus runs', () => {
    const planIds = TRACE_BASELINE_SOLVE_PLAN.map((s) => s.runId).sort();
    const trustedIds = NBS_TRUSTED_SATURATED_TRACE_RUNS.map((r) => r.runId).sort();
    expect(planIds).toEqual(trustedIds);
  });

  it('fig02 (sat LH2) → ParaHydrogen, N=6, dt=2.5 fixed; LN2 runs → Nitrogen, N=6, dt=10', () => {
    const fig02 = solveSpecForRun('nbs9264-fig02');
    expect(fig02.fluidName).toBe('ParaHydrogen');
    expect(fig02.dtS).toBe(2.5);
    expect(fig02.segments).toBe(6);
    for (const id of ['nbs9264-fig10', 'nbs9264-fig11', 'nbs9264-fig12']) {
      const spec = solveSpecForRun(id);
      expect(spec.fluidName).toBe('Nitrogen');
      expect(spec.dtS).toBe(10);
      expect(spec.segments).toBe(6);
    }
  });

  it('the solve horizon covers every figure\'s data span (no data-side extrapolation needed)', () => {
    for (const spec of TRACE_BASELINE_SOLVE_PLAN) {
      const run = getTraceRun(spec.runId);
      expect(spec.endTimeS).toBeGreaterThanOrEqual(run.timeSpanS);
    }
  });

  it('rejects non-trusted (subcooled, diagnosticOnly) runs', () => {
    expect(() => solveSpecForRun('nbs9264-fig03')).toThrow(/not a trusted/);
  });
});

// ---------------------------------------------------------------------------
// Identity comparison against real corpus metadata (no solver involved)
// ---------------------------------------------------------------------------

describe('compareRunTraces plumbing on real corpus metadata', () => {
  it('per-station identity: a "model" equal to the data gives exactly zero error', () => {
    for (const run of NBS_TRUSTED_SATURATED_TRACE_RUNS) {
      for (const tr of run.traces) {
        const cmp = compareStationTrace(
          { timesS: tr.timesS, valuesK: tr.wallTempsK },
          tr,
          { kneeThresholdK: dataNativeKneeThresholdK(run), rateHalfWindowS: 5 }
        );
        expect(cmp.metrics.rmseK).toBe(0);
        expect(cmp.metrics.maeK).toBe(0);
        expect(cmp.metrics.nrmse).toBe(0);
      }
    }
  });

  it('compareRunTraces on a spatially-exact interpolated model reproduces the data within interpolation error', () => {
    for (const run of NBS_TRUSTED_SATURATED_TRACE_RUNS) {
      // Shared uniform 1 s model grid over the figure span; each wall
      // "node" sits exactly at a station and carries that station's data
      // linearly interpolated onto the grid.
      const timesS: number[] = [];
      for (let t = 0; t <= run.timeSpanS + 1e-9; t += 1) timesS.push(t);
      const model: ModelWallHistory = {
        timesS,
        wallXM: run.traces.map((t) => t.stationExactM),
        wallTracesK: run.traces.map((t) =>
          timesS.map((tt) =>
            // linear interp within the record; clamp at the ends
            tt <= t.timesS[0]
              ? t.wallTempsK[0]
              : tt >= t.timesS[t.timesS.length - 1]
                ? t.wallTempsK[t.wallTempsK.length - 1]
                : t.wallTempsK[
                    Math.max(
                      0,
                      t.timesS.findIndex((x) => x >= tt) - 1
                    )
                  ]
          )
        ),
      };
      const cmp = compareRunTraces(run, model);
      expect(cmp.runId).toBe(run.runId);
      expect(cmp.pooled.nStations).toBe(4);
      // Not a pinned value — a plumbing soundness bound (linear
      // interpolation of a smooth-ish trace onto a 1 s grid).
      expect(cmp.pooled.rmseK!).toBeGreaterThanOrEqual(0);
      expect(cmp.pooled.rmseK!).toBeLessThan(20);
      expect(cmp.front150.discordantPairs).toBeGreaterThanOrEqual(0);
    }
  });

  it('QC-truncated tails exclude cold-side features on the data side (never imputed)', () => {
    // fig11 stn1 (drawn trace stops at 130 s / ~95 K, before the cold
    // plateau) is the truncated-truncation anchor; fig10 stn4 used to be
    // the anchor before the clicker gold (2026-08) resolved its frame-edge
    // truncation.
    const fig11 = getTraceRun('nbs9264-fig11');
    const stn1Data = fig11.traces[0];
    const cmp = compareStationTrace(
      { timesS: stn1Data.timesS, valuesK: stn1Data.wallTempsK },
      stn1Data,
      { kneeThresholdK: dataNativeKneeThresholdK(fig11), rateHalfWindowS: 5 }
    );
    expect(cmp.coldTailUsable).toBe(false);
    // Data side: cold-side features categorically unavailable.
    expect(cmp.dataFeatures.kneeTimeS.available).toBe(false);
    expect(cmp.dataFeatures.crossing50KS.available).toBe(false);
    expect(cmp.dataFeatures.plateauFractionPreKnee.available).toBe(false);
    // The 150 K mid-front crossing (t ≈ 59.7 s, well inside the record)
    // remains available.
    expect(cmp.dataFeatures.crossing150KS.available).toBe(true);

    // With mid-front crossings retained on all four stations, the guarded
    // ordering is complete (no station dropped, nothing extrapolated).
    const ordering = guardedFrontOrdering150K(
      fig11.traces.map((t) => ({ station: t.station, timesS: t.timesS, valuesK: t.wallTempsK }))
    );
    expect(ordering.missingStations).toEqual([]);
    expect(ordering.arrivals.map((a) => a.station)).toEqual([1, 2, 3, 4]);
  });

  it('fig11 stns 1–3 (drawn traces stop early) keep mid-front features but lose cold-side ones', () => {
    const fig11 = getTraceRun('nbs9264-fig11');
    for (const st of [0, 1, 2]) {
      const tr = fig11.traces[st];
      const cmp = compareStationTrace(
        { timesS: tr.timesS, valuesK: tr.wallTempsK },
        tr,
        { kneeThresholdK: dataNativeKneeThresholdK(fig11), rateHalfWindowS: 5 }
      );
      expect(cmp.coldTailUsable).toBe(false);
      expect(cmp.dataFeatures.kneeTimeS.available).toBe(false);
      expect(cmp.dataFeatures.crossing50KS.available).toBe(false);
      // Mid-front 150 K crossing remains usable on these traces.
      expect(cmp.dataFeatures.crossing150KS.available).toBe(true);
    }
    // Station 4 runs late and is fully usable.
    const tr4 = fig11.traces[3];
    const cmp4 = compareStationTrace(
      { timesS: tr4.timesS, valuesK: tr4.wallTempsK },
      tr4,
      { kneeThresholdK: dataNativeKneeThresholdK(fig11), rateHalfWindowS: 5 }
    );
    expect(cmp4.coldTailUsable).toBe(true);
    expect(cmp4.dataFeatures.kneeTimeS.available).toBe(true);
  });

  it('knee threshold is the data-native Tsat(P_drive)+15 K convention', () => {
    const fig02 = getTraceRun('nbs9264-fig02');
    expect(dataNativeKneeThresholdK(fig02)).toBeCloseTo(27.4 + 15, 12);
  });
});

// ---------------------------------------------------------------------------
// Conventions: onset mode selection, shared rate window, guarded ordering
// ---------------------------------------------------------------------------

describe('feature conventions', () => {
  it('onset: belowThreshold(290) when the record starts above 290 K, else dropFromStart(5)', () => {
    expect(onsetOptionsFor({ timesS: [0, 1], valuesK: [300, 250] }).convention).toBe('belowThreshold290');
    expect(onsetOptionsFor({ timesS: [0, 1], valuesK: [285, 250] }).convention).toBe('dropFromStart5');
  });

  it('the run rate half-window is the max over model AND data adaptive windows', () => {
    const coarse = { timesS: [0, 10, 20, 30], valuesK: [300, 250, 200, 150] }; // 3·dt = 30
    const fine = { timesS: [0, 0.5, 1, 1.5, 2, 2.5, 3], valuesK: [300, 290, 280, 270, 260, 250, 240] };
    const hw = runRateHalfWindowS([coarse], [fine]);
    expect(hw).toBeCloseTo(30, 12); // limited by the coarse (model) grid
  });

  it('guardedFrontOrdering150K drops final-interval crossings into missingStations', () => {
    const ordering = guardedFrontOrdering150K([
      // crosses 150 K between the last two samples only → guard fires.
      { station: 1 as const, timesS: [0, 1, 2], valuesK: [300, 200, 90] },
      { station: 2 as const, timesS: [0, 1, 2, 3], valuesK: [300, 200, 90, 85] },
    ]);
    expect(ordering.missingStations).toEqual([1]);
    expect(ordering.arrivals.map((a) => a.station)).toEqual([2]);
    expect(ordering.complete).toBe(false);
  });

  it('compareStationTrace wires QC weight and both feature sets through', () => {
    const run = getTraceRun('nbs9264-fig12');
    const data = run.traces[0];
    // A model 5 K hotter than the data everywhere on the data grid.
    const model = { timesS: data.timesS, valuesK: data.wallTempsK.map((v) => v + 5) };
    const cmp = compareStationTrace(model, data, {
      kneeThresholdK: dataNativeKneeThresholdK(run),
      rateHalfWindowS: 5,
    });
    expect(cmp.metrics.rmseK).toBeCloseTo(5, 9);
    expect(cmp.qualityWeight).toBe(data.qualityWeight);
    expect(cmp.metrics.nrmse).toBeCloseTo(5 / cmp.scaleK, 9);
    expect(cmp.modelFeatures.crossing150KS.available).toBe(true);
    expect(cmp.dataFeatures.crossing150KS.available).toBe(true);
  });
});
