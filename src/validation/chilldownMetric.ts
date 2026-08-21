/**
 * Compute OUR predicted chilldown time from a transient solve, under the
 * (configurable) NBS chilldown-time definition — see nbsChilldown.ts
 * header for the definition, its primary-source justification, and the
 * rejected alternatives.
 *
 * Pipeline (all steps differentiable-by-construction except the explicit
 * late-time pressure average, which is a fixed smoother):
 *   1. wall temperature traces are linearly interpolated IN SPACE to the
 *      physical station coordinate (stationInterp.ts — no node snapping);
 *   2. the threshold temperature is formed per the configured mode
 *      (local-Tsat uses the mean of the spatially-interpolated pressure
 *      trace at the station over the final 10% of samples — the wall's
 *      asymptote is the LOCAL saturation temperature);
 *   3. the chilldown time is the smooth (linearly interpolated) first
 *      crossing of that threshold (stationInterp.ts — not the naive
 *      piecewise-constant first-below).
 */

import {
  interpolateTraceToStation,
  thresholdCrossingTime,
} from './stationInterp';
import { stationXM, type ChilldownTimeDefinition } from './nbsChilldown';

export interface ChilldownMetricInput {
  /** Common time grid (s). */
  timesS: number[];
  /** Axial positions (m) of the wall (solid) samples, ascending. */
  wallXM: number[];
  /** wallTracesK[j][k]: wall temperature (K) of node j at time index k. */
  wallTracesK: number[][];
  /** Axial positions (m) of the fluid nodes, ascending. */
  fluidXM: number[];
  /** pressureTracesPa[j][k]: pressure (Pa) of fluid node j at time k. */
  pressureTracesPa: number[][];
  /**
   * Inlet liquid temperature (K): Tsat at the driving pressure for
   * saturated cases; the subcooling reference temperature for subcooled
   * cases.  Only used by the 'aboveInletLiquid' threshold mode.
   */
  inletLiquidTempK: number;
  /** Saturation-temperature provider (K) at a given pressure (Pa). */
  saturationTemperatureK: (pPa: number) => number;
}

export interface ChilldownMetricResult {
  /** Smooth chilldown time (s); undefined if the trace never crosses. */
  timeS: number | undefined;
  /** Station coordinate (m) the wall trace was interpolated to. */
  stationXM: number;
  /** Threshold temperature (K) that was crossed. */
  thresholdK: number;
  /** Late-time local pressure (Pa) at the station (local-Tsat mode). */
  pLocalLatePa: number | undefined;
  /** Local saturation temperature (K) at pLocalLatePa. */
  tSatLocalK: number | undefined;
}

/** Fraction of trailing samples used for the late-time pressure mean. */
const LATE_FRACTION = 0.1;

export function predictedChilldownTime(
  input: ChilldownMetricInput,
  def: ChilldownTimeDefinition
): ChilldownMetricResult {
  const xStation = stationXM(def.station);
  const wallAtStation = interpolateTraceToStation(
    input.wallXM,
    input.wallTracesK,
    xStation
  );

  let thresholdK: number;
  let pLocalLatePa: number | undefined;
  let tSatLocalK: number | undefined;
  switch (def.threshold.mode) {
    case 'fixed':
      thresholdK = def.threshold.valueK;
      break;
    case 'aboveInletLiquid':
      thresholdK = input.inletLiquidTempK + def.threshold.marginK;
      break;
    case 'aboveLocalTsat': {
      const pTrace = interpolateTraceToStation(
        input.fluidXM,
        input.pressureTracesPa,
        xStation
      );
      const nLate = Math.max(1, Math.floor(pTrace.length * LATE_FRACTION));
      pLocalLatePa = pTrace.slice(-nLate).reduce((a, b) => a + b, 0) / nLate;
      tSatLocalK = input.saturationTemperatureK(pLocalLatePa);
      thresholdK = tSatLocalK + def.threshold.marginK;
      break;
    }
  }

  return {
    timeS: thresholdCrossingTime(input.timesS, wallAtStation, thresholdK, 'below'),
    stationXM: xStation,
    thresholdK,
    pLocalLatePa,
    tSatLocalK,
  };
}

/**
 * Convenience: evaluate one case under several definitions at once
 * (sensitivity reporting — the definitional spread is a first-class
 * output of the baseline, not a hidden choice).
 */
export function predictedChilldownTimeSweep(
  input: ChilldownMetricInput,
  defs: ChilldownTimeDefinition[]
): ChilldownMetricResult[] {
  return defs.map((d) => predictedChilldownTime(input, d));
}
