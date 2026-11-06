/**
 * Initial wall temperature of the NBS 9264 runs.
 *
 * What the experiment states: the line was at "ambient temperature" before
 * the inlet valve opened (NBS Report 9264 §1: "the initial inflow of the
 * cryogen to a line at ambient temperature") and no number is given.  The
 * measured value is the pre-arrival plateau of the digitized wall
 * thermocouple traces: their first samples start between about 269 and
 * 307 K, not at the 300 K the builder defaults to.
 *
 * Policy (an input from the record, never fitted):
 *   - a run's initial wall temperature is the MEDIAN of the first samples
 *     of its four station traces (the median because a station can already
 *     have started to cool — Fig. 6's valve opened before chart zero — and
 *     because the thermocouples scatter by a few kelvin);
 *   - a Table-6 row takes the value of the digitized run of the same test
 *     where one exists (nine rows);
 *   - the other nine rows (and any run without a digitized record) take the
 *     mean of the eleven run values, with the minimum and maximum run value
 *     as the bracket to quote the sensitivity over.
 *
 * Every temperature is interpreted as a uniform initial temperature of the
 * wall and of the fluid in the line (the builder's `initialTemperature`).
 */

import type { ChilldownDataPoint } from "./nbsChilldown";
import { NBS_TRACE_RUNS, type TraceRun } from "./nbsTraceCorpus";

export interface RunInitialTemperature {
  /** Median of the four stations' first samples (K) — the value used. */
  medianK: number;
  minK: number;
  maxK: number;
  /** First sample of each station trace, stations 1–4 (K). */
  perStationK: number[];
}

export function runInitialWallTemperature(
  run: TraceRun,
): RunInitialTemperature {
  const first = run.traces.map((t) => t.wallTempsK[0]);
  const sorted = [...first].sort((a, b) => a - b);
  const n = sorted.length;
  const median =
    n % 2 === 1
      ? sorted[(n - 1) / 2]
      : 0.5 * (sorted[n / 2 - 1] + sorted[n / 2]);
  return {
    medianK: median,
    minK: sorted[0],
    maxK: sorted[n - 1],
    perStationK: first,
  };
}

export interface CorpusInitialTemperature {
  /** Mean of the per-run values (K): the value for rows with no trace. */
  meanK: number;
  /** Lowest and highest per-run value (K): the sensitivity bracket. */
  minK: number;
  maxK: number;
  runs: number;
}

export const CORPUS_INITIAL_WALL_TEMPERATURE: CorpusInitialTemperature =
  (() => {
    const v = NBS_TRACE_RUNS.map((r) => runInitialWallTemperature(r).medianK);
    return {
      meanK: v.reduce((a, b) => a + b, 0) / v.length,
      minK: Math.min(...v),
      maxK: Math.max(...v),
      runs: v.length,
    };
  })();

export interface InitialTemperatureChoice {
  K: number;
  /** 'trace': measured in the digitized run of the same test;
   *  'corpusMean': no digitized run — the mean of all runs. */
  source: "trace" | "corpusMean";
  runId?: string;
}

/** The initial wall temperature to use for a Table-6 row. */
export function initialWallTemperatureForPoint(
  point: Pick<ChilldownDataPoint, "id">,
): InitialTemperatureChoice {
  const run = NBS_TRACE_RUNS.find((r) => r.conditionId === point.id);
  if (run)
    return {
      K: runInitialWallTemperature(run).medianK,
      source: "trace",
      runId: run.runId,
    };
  return { K: CORPUS_INITIAL_WALL_TEMPERATURE.meanK, source: "corpusMean" };
}

/** The initial wall temperature of a digitized run (K). */
export function initialWallTemperatureForRun(run: TraceRun): number {
  return runInitialWallTemperature(run).medianK;
}
