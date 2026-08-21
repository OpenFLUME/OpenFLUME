/**
 * Tests for the NBS-9264 trace corpus loader (nbsTraceCorpus.ts).
 *
 * Coverage:
 *   - all 11 runs / 44 traces / 10,195 samples load with EXACT station
 *     geometry (6.096 / 24.384 / 42.9768 / 60.3504 m) and source-rounded
 *     positions preserved as provenance;
 *   - trusted (4 saturated) vs diagnostic (7 subcooled) subset membership;
 *   - per-trace QC flags / cold-tail usability on the audit-flagged traces
 *     (fig11 stns 1–3 truncation, fig02 stn3/4 low-T knee crossing,
 *     fig13 stns 1–2 / fig14 stns 1–2 early record ends);
 *   - integrity: strictly ascending finite times, finite temperatures,
 *     sample/marker-count consistency (NO assertion that the physically
 *     suspect digitized low-T points are valid — instead that they are
 *     QC-marked);
 *   - dataset versioning: the embedded SHA-256 is recomputed from the
 *     tracked CSVs on disk (generated module cannot drift from sources);
 *   - the provenance guard against the known-bad "~20/60/100/140 ft"
 *     station annotation (found in
 *     brennan1966_nbs9264_inlet_restriction_results.csv);
 *   - Table-6 cross-references and the fig02 station-4 knee cross-check
 *     against the Table-6 chilldown time (protocol §4.3: same event read
 *     twice — used for cross-checking, never as two constraints).
 *
 * NOTE: this file reads the source CSVs via node:fs.  Tests run under
 * vitest's node environment; the corpus MODULE itself stays fs-free so it
 * works unchanged in the browser build.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  NBS9264_TRACE_RUN_DATA,
  NBS9264_TOTAL_SAMPLES,
} from '../generated/nbsTraceCorpusData';
import {
  CANONICAL_STATION_SOURCE_M,
  NBS9264_KNOWN_BAD_STATION_FT,
  NBS_TRACE_DATASET,
  NBS_TRACE_RUNS,
  NBS_TRUSTED_SATURATED_TRACE_RUNS,
  NBS_DIAGNOSTIC_SUBCOOLED_TRACE_RUNS,
  NBS_TRACE_CORPUS_BLOCKED_SOURCES,
  SPARSE_MARKER_THRESHOLD,
  coldTailUsableTraces,
  getTraceRun,
  stationIdFromSourceM,
  traceQualityWeight,
  validateTraceCorpus,
  type TraceRun,
} from '../nbsTraceCorpus';
import { ftToM, stationXM } from '../nbsChilldown';
import { thresholdCrossingTime } from '../stationInterp';

const DATA_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'validation',
  'data',
  'digitized',
  'chilldown'
);

describe('corpus load: runs / traces / samples', () => {
  it('loads exactly 11 runs, 44 traces, 10,195 samples', () => {
    expect(NBS_TRACE_RUNS).toHaveLength(11);
    let traces = 0;
    let samples = 0;
    for (const run of NBS_TRACE_RUNS) {
      expect(run.traces).toHaveLength(4);
      traces += run.traces.length;
      for (const tr of run.traces) samples += tr.timesS.length;
    }
    expect(traces).toBe(44);
    // Clicker-gold corpus (2026-08-13): 10,195 samples (auto pipeline: 11,330).
    expect(samples).toBe(10_195);
    expect(NBS9264_TOTAL_SAMPLES).toBe(10_195);
  });

  it('covers exactly the CRTech-priority figure set (2–7 LH2, 10–14 LN2)', () => {
    const ids = NBS_TRACE_RUNS.map((r) => r.runId).sort();
    expect(ids).toEqual(
      [
        'nbs9264-fig02',
        'nbs9264-fig03',
        'nbs9264-fig04',
        'nbs9264-fig05',
        'nbs9264-fig06',
        'nbs9264-fig07',
        'nbs9264-fig10',
        'nbs9264-fig11',
        'nbs9264-fig12',
        'nbs9264-fig13',
        'nbs9264-fig14',
      ].sort()
    );
  });

  it('every trace normalizes to the exact NBS station geometry and preserves source positions', () => {
    const exactByStation = [ftToM(20), ftToM(80), ftToM(141), ftToM(198)];
    for (const run of NBS_TRACE_RUNS) {
      run.traces.forEach((tr, i) => {
        expect(tr.station).toBe(i + 1);
        expect(tr.stationExactM).toBe(exactByStation[i]);
        expect(tr.stationExactM).toBe(stationXM(tr.station));
        // Source-rounded provenance preserved.
        expect(tr.stationSourceM).toBe(CANONICAL_STATION_SOURCE_M[i]);
        // Rounded source is within 0.15 m of the exact position.
        expect(Math.abs(tr.stationSourceM - tr.stationExactM)).toBeLessThan(0.15);
      });
    }
    // And the exact positions are the primary-source-verified ones.
    expect(exactByStation[0]).toBeCloseTo(6.096, 12);
    expect(exactByStation[1]).toBeCloseTo(24.384, 12);
    expect(exactByStation[2]).toBeCloseTo(42.9768, 12);
    expect(exactByStation[3]).toBeCloseTo(60.3504, 12);
  });

  it('carries run conditions, provenance and digitizer uncertainty on every trace', () => {
    for (const run of NBS_TRACE_RUNS) {
      expect(run.provenance.sourceFile).toMatch(/^nbs9264_fig\d+_.*\.csv$/);
      expect(run.provenance.citation).toContain('NBS Report 9264');
      expect(run.pdfPage).toBeGreaterThan(22);
      expect(Math.abs(run.drivingPressure.pa - run.drivingPressure.atm * 101325)).toBeLessThanOrEqual(1);
      expect(run.inletLiquidTempK).toBeGreaterThan(0);
      for (const tr of run.traces) {
        expect(tr.provenance.figure).toBe(run.figure);
        expect(tr.digitizationMethod.length).toBeGreaterThan(0);
        expect(tr.estimatedUncertainty.tempK).toBeGreaterThan(0);
        expect(tr.estimatedUncertainty.timeS).toBeGreaterThan(0);
        expect(tr.sampleCount).toBe(tr.timesS.length);
        expect(tr.originalMarkerCount).toBeGreaterThan(0);
      }
    }
  });
});

describe('trusted vs diagnostic subsets (protocol §3.2)', () => {
  it('trusted = the 4 saturated runs (fig02 LH2, figs 10–12 LN2)', () => {
    expect(NBS_TRUSTED_SATURATED_TRACE_RUNS.map((r) => r.runId).sort()).toEqual([
      'nbs9264-fig02',
      'nbs9264-fig10',
      'nbs9264-fig11',
      'nbs9264-fig12',
    ]);
    for (const run of NBS_TRUSTED_SATURATED_TRACE_RUNS) {
      expect(run.inletCondition).toBe('saturated');
      expect(run.calibrationTier).toBe('trustedSaturated');
    }
  });

  it('all 7 subcooled runs are diagnosticOnly by default', () => {
    expect(NBS_DIAGNOSTIC_SUBCOOLED_TRACE_RUNS.map((r) => r.runId).sort()).toEqual([
      'nbs9264-fig03',
      'nbs9264-fig04',
      'nbs9264-fig05',
      'nbs9264-fig06',
      'nbs9264-fig07',
      'nbs9264-fig13',
      'nbs9264-fig14',
    ]);
    for (const run of NBS_DIAGNOSTIC_SUBCOOLED_TRACE_RUNS) {
      expect(run.inletCondition).toBe('subcooled');
      expect(run.calibrationTier).toBe('diagnosticOnly');
    }
    // Trusted + diagnostic partition the corpus.
    expect(
      NBS_TRUSTED_SATURATED_TRACE_RUNS.length + NBS_DIAGNOSTIC_SUBCOOLED_TRACE_RUNS.length
    ).toBe(NBS_TRACE_RUNS.length);
  });
});

describe('per-trace QC flags and truncation policy', () => {
  it('fig10 stn4: clicker gold resolved the frame-edge truncation — cold tail usable', () => {
    // Auto pipeline (2026-08-05) truncated stn4 at ~147 K (t=240 frame
    // line); the hand-clicked gold data continues through the steep knee to
    // ~98 K at the 250 s figure edge, so no flags remain.
    const tr = getTraceRun('nbs9264-fig10').traces[3];
    expect(tr.qc.flags).toEqual([]);
    expect(tr.qc.coldTailUsable).toBe(true);
    expect(Math.min(...tr.wallTempsK)).toBeGreaterThan(95);
    expect(Math.min(...tr.wallTempsK)).toBeLessThan(100);
  });

  it('fig12 stn4: clicker gold fully clicked (24 markers) to the ~86 K plateau — usable', () => {
    // Auto pipeline had only 4 chained markers and stopped at 106.4 K /
    // 119.9 s (sparse + truncated); the clicker gold trace has 24 markers
    // and reaches ~85.6 K at the 130 s figure end.
    const tr = getTraceRun('nbs9264-fig12').traces[3];
    expect(tr.originalMarkerCount).toBe(24);
    expect(tr.qc.flags).toEqual([]);
    expect(tr.qc.coldTailUsable).toBe(true);
    // Reaches the cold plateau (below the ~96 K inlet saturation).
    expect(Math.min(...tr.wallTempsK)).toBeLessThan(90);
  });

  it('fig11 stns 1–3 stop before the cold plateau — cold tail NOT usable; stn4 usable', () => {
    const run = getTraceRun('nbs9264-fig11');
    for (const i of [0, 1, 2]) {
      expect(run.traces[i].qc.flags).toContain('truncatedColdTail');
      expect(run.traces[i].qc.coldTailUsable).toBe(false);
    }
    expect(run.traces[3].qc.coldTailUsable).toBe(true);
    expect(coldTailUsableTraces(run).map((t) => t.station)).toEqual([4]);
  });

  it('sparseOriginalMarkers flag agrees with marker counts corpus-wide', () => {
    for (const run of NBS_TRACE_RUNS) {
      for (const tr of run.traces) {
        const sparse = tr.originalMarkerCount < SPARSE_MARKER_THRESHOLD;
        expect(tr.qc.flags.includes('sparseOriginalMarkers')).toBe(sparse);
      }
    }
    // Clicker gold (2026-08-13): every station has ≥ 9 hand-clicked
    // markers — NO trace is sparse anymore (auto pipeline had fig12 stn3/4
    // at 7/4 chained markers).
    const sparseTraces = NBS_TRACE_RUNS.flatMap((r) =>
      r.traces.filter((t) => t.qc.flags.includes('sparseOriginalMarkers')).map((t) => `${r.runId}/stn${t.station}`)
    );
    expect(sparseTraces).toEqual([]);
  });

  it('quality weights follow the documented provisional policy', () => {
    // Clean trace: full weight.
    expect(getTraceRun('nbs9264-fig10').traces[0].qualityWeight).toBe(1);
    // Curve-crossing region halves the weight.
    expect(getTraceRun('nbs9264-fig02').traces[3].qualityWeight).toBe(0.5);
    // fig12 stn4: clicker gold — no longer sparse/truncated, full weight
    // (truncation itself carries no in-window penalty, and it is gone).
    expect(getTraceRun('nbs9264-fig12').traces[3].qualityWeight).toBe(1);
    // Oscillatory segment: ×0.75 (fig14 stn1).
    expect(getTraceRun('nbs9264-fig14').traces[0].qualityWeight).toBe(0.75);
    // Floor: never below 0.25 regardless of flag stack.
    const stacked = traceQualityWeight({
      flags: ['sparseOriginalMarkers', 'ambiguousTailAssignment', 'oscillatorySegment'],
      coldTailUsable: false,
      notes: [],
    });
    expect(stacked).toBe(0.25);
    // All weights inside [floor, 1].
    for (const run of NBS_TRACE_RUNS) {
      for (const tr of run.traces) {
        expect(tr.qualityWeight).toBeGreaterThanOrEqual(0.25);
        expect(tr.qualityWeight).toBeLessThanOrEqual(1);
      }
    }
  });

  it('trusted subset: 13 of 16 traces remain cold-tail usable (only fig11 stn1–3 excluded)', () => {
    // Clicker gold: fig02 all 4; fig10 all 4 (stn4 truncation resolved);
    // fig11 stn4 only; fig12 all 4 (stn4 sparse/truncated resolved) → 13.
    const usable = NBS_TRUSTED_SATURATED_TRACE_RUNS.flatMap((r) =>
      coldTailUsableTraces(r).map((t) => `${r.runId}/stn${t.station}`)
    );
    expect(usable).toHaveLength(13);
    expect(usable).toContain('nbs9264-fig10/stn4');
    expect(usable).toContain('nbs9264-fig12/stn4');
    for (const s of ['stn1', 'stn2', 'stn3']) {
      expect(usable).not.toContain(`nbs9264-fig11/${s}`);
    }
  });
});

describe('data integrity (no physical-validity assertion on suspect points)', () => {
  it('times strictly ascending, all values finite, temperatures in a loose sanity band', () => {
    for (const run of NBS_TRACE_RUNS) {
      for (const tr of run.traces) {
        expect(tr.timesS.length).toBeGreaterThanOrEqual(4);
        for (let i = 0; i < tr.timesS.length; i++) {
          expect(Number.isFinite(tr.timesS[i])).toBe(true);
          expect(Number.isFinite(tr.wallTempsK[i])).toBe(true);
          // Loose digitization sanity band only — the NBS report itself
          // flags low-T TC inaccuracies; validity of low-T points is carried
          // by QC flags, not asserted here.
          expect(tr.wallTempsK[i]).toBeGreaterThan(1);
          expect(tr.wallTempsK[i]).toBeLessThan(400);
          if (i > 0) expect(tr.timesS[i]).toBeGreaterThan(tr.timesS[i - 1]);
        }
      }
    }
  });

  it('each run spans its metadata time_span and starts near ambient', () => {
    for (const run of NBS_TRACE_RUNS) {
      const tMax = Math.max(...run.traces.map((t) => t.timesS[t.timesS.length - 1]));
      expect(Math.abs(tMax - run.timeSpanS)).toBeLessThan(0.01);
      // Every run's warmest station sample is in the ambient band (the
      // report states the line starts ~ambient, ~270–300 K).
      const warmest = Math.max(...run.traces.map((t) => t.wallTempsK[0]));
      expect(warmest).toBeGreaterThan(240);
      expect(warmest).toBeLessThan(310);
    }
  });

  it('physically suspect low-T regions are QC-marked, not asserted valid', () => {
    // fig02: stn3/4 knees cross at t~66 s in the hand-clicked gold data
    // (low-T crossing; NBS attributes such crossings to measurement error).
    const fig02 = getTraceRun('nbs9264-fig02');
    expect(fig02.traces[2].qc.flags).toContain('curveCrossingRegion');
    expect(fig02.traces[3].qc.flags).toContain('curveCrossingRegion');
    // fig10: the auto-pipeline stn3/4 low-T crossing was a chaining
    // artifact — the clicker gold data has NO crossing, so no flag.
    const fig10 = getTraceRun('nbs9264-fig10');
    expect(fig10.traces[2].qc.flags).not.toContain('curveCrossingRegion');
    expect(fig10.traces[3].qc.flags).not.toContain('curveCrossingRegion');
    // fig03: all four cold tails overlap → per-station tails unattributable.
    const fig03 = getTraceRun('nbs9264-fig03');
    for (const tr of fig03.traces) {
      expect(tr.qc.flags).toContain('ambiguousTailAssignment');
      expect(tr.qc.coldTailUsable).toBe(false);
    }
    // fig06: pre-t=0 valve opening (time origin shifted) is flagged on all traces.
    const fig06 = getTraceRun('nbs9264-fig06');
    for (const tr of fig06.traces) {
      expect(tr.qc.flags).toContain('preTZeroValveOpening');
    }
  });
});

describe('dataset versioning / reproducibility', () => {
  it('embedded SHA-256 matches the source CSVs on disk (no drift)', () => {
    const hash = crypto.createHash('sha256');
    for (const f of [...NBS_TRACE_DATASET.sourceFiles].sort()) {
      hash.update(f);
      hash.update('\0');
      hash.update(fs.readFileSync(path.join(DATA_DIR, f)));
      hash.update('\0');
    }
    expect(hash.digest('hex')).toBe(NBS_TRACE_DATASET.sourceHashSha256);
  });

  it('generated module row counts match an independent CSV re-parse', () => {
    let total = 0;
    for (const raw of NBS9264_TRACE_RUN_DATA) {
      const text = fs.readFileSync(path.join(DATA_DIR, raw.sourceFile), 'utf-8');
      const rows = text
        .split('\n')
        .filter((l) => l.length > 0 && !l.startsWith('#') && !l.startsWith('time_s,'));
      const perStation = new Map<number, number>();
      for (const row of rows) {
        const s = Number(row.split(',')[1]);
        perStation.set(s, (perStation.get(s) ?? 0) + 1);
      }
      const counts = CANONICAL_STATION_SOURCE_M.map((m) => perStation.get(m) ?? 0);
      expect(counts).toEqual(raw.stations.map((s) => s.timesS.length));
      total += rows.length;
    }
    expect(total).toBe(10_195);
  });
});

describe('provenance guard: known-bad "~20/60/100/140 ft" station list', () => {
  it('rejects the positions implied by the bad list (60/100/140 ft)', () => {
    // The bad list's first entry (20 ft) happens to coincide with the true
    // station 1; the other three are wrong and must be rejected.
    expect(stationIdFromSourceM(6.1)).toBe(1);
    expect(() => stationIdFromSourceM(ftToM(60))).toThrow(/known-bad/);
    expect(() => stationIdFromSourceM(ftToM(100))).toThrow(/known-bad/);
    expect(() => stationIdFromSourceM(ftToM(140))).toThrow(/known-bad/);
    expect(NBS9264_KNOWN_BAD_STATION_FT).toEqual([20, 60, 100, 140]);
  });

  it('the inlet-restriction CSV carries the bad annotation and is blocklisted', () => {
    const badFile = 'brennan1966_nbs9264_inlet_restriction_results.csv';
    expect(NBS_TRACE_CORPUS_BLOCKED_SOURCES).toContain(badFile);
    const text = fs.readFileSync(path.join(DATA_DIR, badFile), 'utf-8');
    // Confirm the audit finding is still visible in the file header...
    expect(text).toContain('~20, 60, 100, 140 ft');
    // ...and that it is a scalar surge-pressure table, not a trace source.
    expect(text).toContain('peak_line_pressure_atm');
    // No corpus run is sourced from it.
    for (const run of NBS_TRACE_RUNS) {
      expect(run.provenance.sourceFile).not.toBe(badFile);
    }
  });

  it('validateTraceCorpus throws on a synthetic run using the bad station list', () => {
    const good = getTraceRun('nbs9264-fig02');
    const badTrace = {
      ...good.traces[1],
      stationSourceM: ftToM(60), // 18.288 m — the known-bad second "station"
    };
    const badRun: TraceRun = { ...good, traces: [good.traces[0], badTrace, good.traces[2], good.traces[3]] };
    expect(() => validateTraceCorpus([badRun])).toThrow(/known-bad/);
  });

  it('validateTraceCorpus throws on a run sourced from the blocklisted file', () => {
    const good = getTraceRun('nbs9264-fig02');
    const badRun: TraceRun = {
      ...good,
      runId: 'nbs9264-inlet-restriction',
      provenance: {
        ...good.provenance,
        sourceFile: 'brennan1966_nbs9264_inlet_restriction_results.csv',
      },
    };
    expect(() => validateTraceCorpus([badRun])).toThrow(/blocked/);
  });
});

describe('Table-6 cross-references (protocol §4.3: same event read twice)', () => {
  it('conditionId mapping with pressure agreement', () => {
    expect(getTraceRun('nbs9264-fig02').conditionId).toBe('satLH2-P74.97');
    expect(getTraceRun('nbs9264-fig12').conditionId).toBe('satLN2-P86.73');
    expect(getTraceRun('nbs9264-fig07').conditionId).toBe('subLH2-P161.7');
    // figs 10/11 (sat LN2 2.5/3.4 atm) have no Table-6 counterpart.
    expect(getTraceRun('nbs9264-fig10').conditionId).toBeUndefined();
    expect(getTraceRun('nbs9264-fig11').conditionId).toBeUndefined();
  });

  it('fig02 stn4 smooth knee crossing lands near the Table-6 chilldown time (68 s)', () => {
    // Saturated run: local Tsat ≈ inlet liquid temperature; knee threshold
    // = Tsat + 15 K (primary chilldown definition, station 4).
    const run = getTraceRun('nbs9264-fig02');
    const stn4 = run.traces[3];
    expect(stn4.qc.coldTailUsable).toBe(true);
    const kneeS = thresholdCrossingTime(
      stn4.timesS,
      stn4.wallTempsK,
      run.inletLiquidTempK + 15,
      'below'
    );
    expect(kneeS).toBeDefined();
    // Cross-check only (±20 %): the digitized trace and the Table-6 knee
    // time are the SAME physical event read twice — never two constraints.
    expect(Math.abs(kneeS! - 68) / 68).toBeLessThan(0.2);
  });
});
