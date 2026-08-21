/**
 * Synthetic-trace tests for traceObjectives.ts — every expectation is
 * hand-computed from a known curve.  No experimental data is used here;
 * corpus integrity is covered by nbsTraceCorpus.test.ts.
 */

import { describe, it, expect } from 'vitest';
import {
  alignTraces,
  traceRmseK,
  traceMaeK,
  traceNrmseK,
  observedTemperatureSpanK,
  stationTraceMetrics,
  poolRunMetrics,
  aggregateRunLevelMetrics,
  coolingRateProfileKperS,
  extractTraceFeatures,
  frontArrivalOrdering,
  discordantArrivalPairs,
  type StationTraceMetrics,
  type DataTraceLike,
} from '../traceObjectives';
import { NBS_TRACE_RUNS, getTraceRun } from '../nbsTraceCorpus';

/** Build a sampled trace of f on a given time grid. */
function sample(timesS: number[], f: (t: number) => number): { timesS: number[]; valuesK: number[] } {
  return { timesS, valuesK: timesS.map(f) };
}

function uniform(t0: number, t1: number, dt: number): number[] {
  const out: number[] = [];
  for (let t = t0; t <= t1 + 1e-12; t += dt) out.push(Number(t.toFixed(9)));
  return out;
}

function dataTrace(
  station: 1 | 2 | 3 | 4,
  timesS: number[],
  valuesK: number[],
  qualityWeight = 1,
  coldTailUsable = true
): DataTraceLike {
  return { station, timesS, valuesK, qualityWeight, qc: { coldTailUsable } };
}

describe('alignTraces: common-domain alignment', () => {
  it('identical traces on the same grid → RMSE/MAE exactly 0', () => {
    const t = uniform(0, 100, 2.5);
    const f = (x: number) => 300 - 2 * x;
    const a = alignTraces(sample(t, f), sample(t, f));
    expect(a.timesS).toHaveLength(t.length);
    expect(traceRmseK(a)).toBe(0);
    expect(traceMaeK(a)).toBe(0);
  });

  it('uniform +2 K model offset → RMSE = MAE = 2 K exactly', () => {
    const t = uniform(0, 50, 1);
    const a = alignTraces(sample(t, (x) => 302 - 2 * x), sample(t, (x) => 300 - 2 * x));
    expect(traceRmseK(a)).toBeCloseTo(2, 12);
    expect(traceMaeK(a)).toBeCloseTo(2, 12);
  });

  it('interpolates a nonuniform fine data grid onto a coarse model grid exactly (linear function)', () => {
    // Nonuniform data grid (digitized traces need not be uniform).
    const tData = [0, 0.4, 1.7, 3.3, 5.0, 8.9, 12.2, 20.0, 33.3, 50.0];
    const tModel = uniform(0, 50, 5);
    const f = (x: number) => 300 - 2 * x;
    const a = alignTraces(sample(tModel, f), sample(tData, f));
    expect(a.timesS).toEqual(tModel);
    expect(traceRmseK(a)).toBeCloseTo(0, 10);
  });

  it('restricts to the support overlap — never extrapolates the experiment', () => {
    // Data record ends at 40 s; model runs to 100 s.
    const tModel = uniform(0, 100, 5);
    const tData = uniform(0, 40, 1);
    const f = (x: number) => 300 - 2 * x;
    const a = alignTraces(sample(tModel, f), sample(tData, f));
    expect(a.overlapEndS).toBe(40);
    expect(Math.max(...a.timesS)).toBe(40);
    expect(a.timesS).toHaveLength(9); // 0,5,...,40
    expect(traceRmseK(a)).toBeCloseTo(0, 10);

    // Data starts late (fig02-style lost warm flat): overlap starts at data t0.
    const tData2 = uniform(10, 90, 1);
    const tModel2 = uniform(0, 100, 5);
    const a2 = alignTraces(sample(tModel2, f), sample(tData2, f));
    expect(a2.overlapStartS).toBe(10);
    expect(Math.min(...a2.timesS)).toBe(10);
  });

  it('returns an empty alignment (metrics undefined) when supports do not overlap', () => {
    const a = alignTraces(sample(uniform(0, 10, 1), (x) => x), sample(uniform(20, 30, 1), (x) => x));
    expect(a.timesS).toHaveLength(0);
    expect(traceRmseK(a)).toBeUndefined();
    expect(traceMaeK(a)).toBeUndefined();
  });

  it('NRMSE uses the documented observed-span scale', () => {
    const t = uniform(0, 50, 1);
    const data = sample(t, (x) => 300 - 2 * x); // span 100 K
    expect(observedTemperatureSpanK(data)).toBeCloseTo(100, 12);
    const a = alignTraces(sample(t, (x) => 302 - 2 * x), data);
    expect(traceNrmseK(a, 100)).toBeCloseTo(0.02, 12);
    expect(traceNrmseK(a, 0)).toBeUndefined(); // degenerate scale → undefined
  });
});

describe('run-level aggregation: runs are the independent unit', () => {
  function st(station: 1 | 2 | 3 | 4, rmseK: number, w: number, n = 10): StationTraceMetrics {
    return {
      station,
      qualityWeight: w,
      nSamples: n,
      overlapStartS: 0,
      overlapEndS: 100,
      rmseK,
      maeK: rmseK,
    };
  }

  it('within-run pooling is quality-weighted (w·n-weighted MSE)', () => {
    // rmse 10 (w=1) and rmse 20 (w=0.5), equal n:
    // mse = (1·100 + 0.5·400)/1.5 = 200 → rmse = 14.1421
    const run = poolRunMetrics([st(1, 10, 1), st(2, 20, 0.5)]);
    expect(run.mseK2).toBeCloseTo(200, 9);
    expect(run.rmseK).toBeCloseTo(Math.sqrt(200), 9);
    expect(run.nStations).toBe(2);
  });

  it('4 stations in one run do NOT outweigh 1 station in another (campaign = equal weight per run)', () => {
    // Run A: four stations at rmse 10 → run mse 100.
    const runA = poolRunMetrics([st(1, 10, 1), st(2, 10, 1), st(3, 10, 1), st(4, 10, 1)]);
    // Run B: one station at rmse 20 → run mse 400.
    const runB = poolRunMetrics([st(1, 20, 1)]);
    const campaign = aggregateRunLevelMetrics([runA, runB]);
    // Equal weight per RUN: sqrt((100 + 400)/2) = sqrt(250) ≈ 15.811.
    expect(campaign.rmseK).toBeCloseTo(Math.sqrt(250), 9);
    // The naive per-station pooling would give sqrt((4·100+400)/5) ≈ 12.649 —
    // the run-level policy must differ from it.
    expect(campaign.rmseK!).not.toBeCloseTo(Math.sqrt(800 / 5), 6);
    expect(campaign.nRuns).toBe(2);
  });

  it('runs/stations with undefined metrics (no overlap) are skipped, not zero-filled', () => {
    const bad: StationTraceMetrics = {
      station: 4,
      qualityWeight: 1,
      nSamples: 0,
      overlapStartS: NaN,
      overlapEndS: NaN,
    };
    const run = poolRunMetrics([st(1, 10, 1), bad]);
    expect(run.nStations).toBe(1);
    expect(run.rmseK).toBeCloseTo(10, 12);
    expect(aggregateRunLevelMetrics([run, { nStations: 0, nSamples: 0, weightSum: 0 }]).nRuns).toBe(1);
  });

  it('stationTraceMetrics wires corpus weight + span-scaled NRMSE through', () => {
    const t = uniform(0, 40, 2);
    const data = dataTrace(2, t, t.map((x) => 300 - 2 * x), 0.5);
    const model = sample(t, (x) => 301 - 2 * x);
    const m = stationTraceMetrics(model, data);
    expect(m.station).toBe(2);
    expect(m.qualityWeight).toBe(0.5);
    expect(m.rmseK).toBeCloseTo(1, 12);
    expect(m.nrmse).toBeCloseTo(1 / 80, 12); // span 300→220 = 80 K
  });
});

describe('feature observables on a known synthetic quench curve', () => {
  // Flat 300 K until t=50, linear drop 300→80 K over 50–70 s (−11 K/s),
  // flat 80 K afterwards to t=100.
  const q = (x: number): number => (x <= 50 ? 300 : x >= 70 ? 80 : 300 - 11 * (x - 50));
  const tQ = uniform(0, 100, 1);
  const traceQ = sample(tQ, q);

  it('smooth crossings land exactly on the piecewise-linear curve', () => {
    const feats = extractTraceFeatures(traceQ, { kneeThresholdK: 95 });
    // 150 K crossing: 300 − 11(t−50) = 150 → t = 50 + 150/11 = 63.6364
    expect(feats.crossing150KS).toEqual({ available: true, value: expect.closeTo(50 + 150 / 11, 9) });
    // knee at 95 K: t = 50 + 205/11 = 68.6364
    expect(feats.kneeTimeS).toEqual({ available: true, value: expect.closeTo(50 + 205 / 11, 9) });
    // 50 K is below the 80 K floor: never crossed → unavailable, not invented.
    expect(feats.crossing50KS.available).toBe(false);
    if (!feats.crossing50KS.available) expect(feats.crossing50KS.reason).toMatch(/never crossed/);
    expect(feats.drop150to50S.available).toBe(false);
  });

  it('onset: belowThreshold (290 K) and dropFromStart (5 K) conventions', () => {
    const fFixed = extractTraceFeatures(traceQ, { onset: { mode: 'belowThreshold', thresholdK: 290 } });
    // 300 − 11(t−50) = 290 → t = 50 + 10/11
    expect(fFixed.onsetTimeS).toEqual({ available: true, value: expect.closeTo(50 + 10 / 11, 9) });
    expect(fFixed.onsetThresholdK).toBe(290);
    const fDrop = extractTraceFeatures(traceQ, { onset: { mode: 'dropFromStart', dropK: 5 } });
    // 295 K → t = 50 + 5/11
    expect(fDrop.onsetTimeS).toEqual({ available: true, value: expect.closeTo(50 + 5 / 11, 9) });
    expect(fDrop.onsetThresholdK).toBe(295);
  });

  it('peak cooling rate recovers the exact −11 K/s slope of the drop', () => {
    const feats = extractTraceFeatures(traceQ, { kneeThresholdK: 95, rateHalfWindowS: 2 });
    expect(feats.peakCoolingRate.available).toBe(true);
    if (feats.peakCoolingRate.available) {
      expect(feats.peakCoolingRate.value.rateKperS).toBeCloseTo(11, 9);
      expect(feats.peakCoolingRate.value.timeS).toBeGreaterThanOrEqual(50);
      expect(feats.peakCoolingRate.value.timeS).toBeLessThanOrEqual(70);
    }
  });

  it('least-squares derivative is exact on a linear ramp and robust on nonuniform grids', () => {
    const t = [0, 0.3, 0.9, 2.0, 3.1, 4.4, 6.0, 7.8, 9.9, 12.0];
    const tr = sample(t, (x) => 250 - 10 * x);
    const rate = coolingRateProfileKperS(tr.timesS, tr.valuesK, 2.5);
    for (let k = 0; k < t.length; k++) {
      expect(rate[k]).toBeCloseTo(10, 9);
    }
  });

  it('plateau fraction of the pre-knee interval (repo morphology convention)', () => {
    const feats = extractTraceFeatures(traceQ, { kneeThresholdK: 95, rateHalfWindowS: 2 });
    expect(feats.plateauFractionPreKnee.available).toBe(true);
    if (feats.plateauFractionPreKnee.available) {
      // Pre-knee interval ≈ [0, 68.64]: flat for t ≲ 48 (window ±2 s
      // smears the t=50 break), dropping after.  Expect ≈ 0.7.
      expect(feats.plateauFractionPreKnee.value).toBeGreaterThan(0.55);
      expect(feats.plateauFractionPreKnee.value).toBeLessThan(0.85);
    }
  });

  it('coldTailUsable=false ⇒ cold-side features unavailable, mid-front retained', () => {
    // Same curve but truncated at t=65 (min T = 300−11·15 = 135 K): the
    // 150 K crossing (t = 63.64, inside the record) IS available; 50 K /
    // knee are categorically gated by the QC flag.
    const tTrunc = uniform(0, 65, 1);
    const trTrunc = sample(tTrunc, q);
    const feats = extractTraceFeatures(trTrunc, { kneeThresholdK: 95, coldTailUsable: false });
    expect(feats.crossing150KS.available).toBe(true);
    for (const f of [feats.crossing50KS, feats.kneeTimeS, feats.drop150to50S, feats.plateauFractionPreKnee]) {
      expect(f.available).toBe(false);
    }
    if (!feats.kneeTimeS.available) expect(feats.kneeTimeS.reason).toMatch(/cold tail flagged unusable/);
  });

  it('a crossing in the FINAL sample interval is unavailable (truncation boundary guard)', () => {
    // Threshold crossed between the last two samples only.
    const feats = extractTraceFeatures({ timesS: [0, 1, 2], valuesK: [300, 200, 90] }, {});
    expect(feats.crossing150KS.available).toBe(false);
    if (!feats.crossing150KS.available) {
      expect(feats.crossing150KS.reason).toMatch(/final sample interval/);
    }
    // Same crossing one sample earlier is fine.
    const tr2 = { timesS: [0, 1, 2, 3], valuesK: [300, 200, 90, 85] };
    expect(extractTraceFeatures(tr2, {}).crossing150KS.available).toBe(true);
  });

  it('peak rate unavailable on too-short records (never invented)', () => {
    const feats = extractTraceFeatures({ timesS: [0, 1], valuesK: [300, 250] }, { rateHalfWindowS: 1 });
    expect(feats.peakCoolingRate.available).toBe(false);
  });
});

describe('front-arrival ordering', () => {
  // Station s crosses 150 K at t = 10·s (front propagates downstream).
  const mkTrace = (delayS: number) => sample(uniform(0, 100, 1), (x) => 300 - Math.max(0, x - delayS) * 5);

  it('recovers the physical downstream ordering with smooth crossing times', () => {
    const ordering = frontArrivalOrdering(
      [
        { station: 3 as const, ...mkTrace(30) },
        { station: 1 as const, ...mkTrace(10) },
        { station: 4 as const, ...mkTrace(40) },
        { station: 2 as const, ...mkTrace(20) },
      ],
      150
    );
    expect(ordering.complete).toBe(true);
    expect(ordering.arrivals.map((a) => a.station)).toEqual([1, 2, 3, 4]);
    // 150 K: 300 − 5(t−d) = 150 → t = d + 30.
    expect(ordering.arrivals[0].timeS).toBeCloseTo(40, 9);
    expect(ordering.arrivals[3].timeS).toBeCloseTo(70, 9);
  });

  it('missing crossings are reported, not extrapolated; discordance counts order swaps', () => {
    const data = frontArrivalOrdering(
      [
        { station: 1 as const, ...mkTrace(10) },
        { station: 2 as const, ...mkTrace(20) },
        { station: 3 as const, ...mkTrace(30) },
        // station 4 never crosses 150 K (stays warm)
        { station: 4 as const, ...sample(uniform(0, 100, 1), () => 280) },
      ],
      150
    );
    expect(data.complete).toBe(false);
    expect(data.missingStations).toEqual([4]);

    const model = frontArrivalOrdering(
      [
        { station: 1 as const, ...mkTrace(10) },
        { station: 2 as const, ...mkTrace(30) }, // swapped with stn3
        { station: 3 as const, ...mkTrace(20) },
        { station: 4 as const, ...mkTrace(40) },
      ],
      150
    );
    // Common stations {1,2,3}: order data 1<2<3, model 1<3<2 → one discordant pair.
    expect(discordantArrivalPairs(data, model)).toBe(1);
    expect(discordantArrivalPairs(data, data)).toBe(0);
  });
});

describe('corpus integration smoke checks (real data through the objectives)', () => {
  it('a trace aligned against itself gives exactly zero error on every corpus run', () => {
    for (const run of NBS_TRACE_RUNS) {
      for (const tr of run.traces) {
        const a = alignTraces(
          { timesS: tr.timesS, valuesK: tr.wallTempsK },
          { timesS: tr.timesS, valuesK: tr.wallTempsK }
        );
        expect(traceRmseK(a)).toBe(0);
        expect(traceMaeK(a)).toBe(0);
      }
    }
  });

  it('QC-gated features on the audit-flagged trusted traces', () => {
    // fig10 stn4 (clicker gold 2026-08: hand-clicked THROUGH the former
    // t=240 s frame-line truncation to ~98 K at the 250 s figure edge):
    // cold tail now usable — knee (t ≈ 244.6 s) and 150 K crossing
    // (t ≈ 238.7 s) available; the 50 K crossing is unavailable because
    // it is never crossed (LN2 plateau ~86 K), not because of QC.
    const fig10stn4 = getTraceRun('nbs9264-fig10').traces[3];
    const feats = extractTraceFeatures(
      { timesS: fig10stn4.timesS, valuesK: fig10stn4.wallTempsK },
      { kneeThresholdK: 86.1 + 15, coldTailUsable: fig10stn4.qc.coldTailUsable }
    );
    expect(fig10stn4.qc.coldTailUsable).toBe(true);
    expect(feats.kneeTimeS.available).toBe(true);
    if (feats.kneeTimeS.available) {
      expect(feats.kneeTimeS.value).toBeCloseTo(244.57, 1);
    }
    expect(feats.crossing150KS.available).toBe(true);
    if (feats.crossing150KS.available) {
      expect(feats.crossing150KS.value).toBeCloseTo(238.71, 1);
    }
    expect(feats.crossing50KS.available).toBe(false);
    if (!feats.crossing50KS.available) {
      expect(feats.crossing50KS.reason).toMatch(/never crossed/);
    }

    // fig11 stn1 (stops at 130 s / ~95 K): cold tail gated, but the
    // 150 K mid-front crossing (t ≈ 59.7 s) IS retained.
    const fig11stn1 = getTraceRun('nbs9264-fig11').traces[0];
    expect(fig11stn1.qc.coldTailUsable).toBe(false);
    const feats11 = extractTraceFeatures(
      { timesS: fig11stn1.timesS, valuesK: fig11stn1.wallTempsK },
      { kneeThresholdK: 89.5 + 15, coldTailUsable: fig11stn1.qc.coldTailUsable }
    );
    expect(feats11.kneeTimeS.available).toBe(false);
    expect(feats11.crossing150KS.available).toBe(true);
    if (feats11.crossing150KS.available) {
      expect(feats11.crossing150KS.value).toBeCloseTo(59.73, 1);
    }

    // fig12 stn1 (clean, cold-tail usable): the knee IS available.
    const fig12stn1 = getTraceRun('nbs9264-fig12').traces[0];
    const feats12 = extractTraceFeatures(
      { timesS: fig12stn1.timesS, valuesK: fig12stn1.wallTempsK },
      { kneeThresholdK: 96.3 + 15, coldTailUsable: fig12stn1.qc.coldTailUsable }
    );
    expect(feats12.kneeTimeS.available).toBe(true);
    if (feats12.kneeTimeS.available) {
      expect(feats12.kneeTimeS.value).toBeCloseTo(43.9, 1);
    }
  });

  it('front arrival at 150 K is downstream-ordered on the trusted LN2 runs', () => {
    for (const runId of ['nbs9264-fig10', 'nbs9264-fig11', 'nbs9264-fig12']) {
      const run = getTraceRun(runId);
      const ordering = frontArrivalOrdering(
        run.traces.map((tr) => ({ station: tr.station, timesS: tr.timesS, valuesK: tr.wallTempsK })),
        150
      );
      expect(ordering.complete).toBe(true);
      expect(ordering.arrivals.map((a) => a.station)).toEqual([1, 2, 3, 4]);
    }
  });
});
