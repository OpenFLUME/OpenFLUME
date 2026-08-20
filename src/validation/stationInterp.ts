/**
 * Station interpolation & smooth threshold-crossing utilities.
 *
 * Pure functions underpinning the chilldown objective.  Two measured
 * hazards motivate them (both observed on real solves):
 *
 *  1. STATION COLLAPSE — solid nodes sit at discretization-dependent
 *     axial positions (i·L/N), but the NBS instrument stations are fixed
 *     physical locations (6.096 / 24.384 / 42.98 / 60.35 m).  At N=3–4,
 *     nearest-node snapping maps three of the four stations onto the SAME
 *     node (measured completion-time gaps [30, 0, 0] s).  Snapping is
 *     therefore not acceptable for calibration: the "station" being
 *     compared would change with N.  `interpolateAtPosition` interpolates
 *     linearly in space to the true station coordinate.
 *
 *  2. ZERO-GRADIENT TRAP — the naive "first time step where
 *     T < threshold" is piecewise-constant in any model parameter, so
 *     its gradient is EXACTLY ZERO almost everywhere.  Measured: a
 *     parameter sweep produced chilldown times
 *     120, 120, 110, 110, 110, 110, 110, 110, 110 s (naive), while
 *     linear interpolation of the crossing gave the smooth sequence
 *     116.07, 111.86, 109.92, 108.93, 108.68, 108.44, 107.51, 106.39,
 *     103.27 s.  `thresholdCrossingTime` is the smooth version;
 *     gradient-based calibration is only possible because of it.
 */

/**
 * Linear interpolation of a scalar field sampled at positions `x`
 * (strictly ascending) to an arbitrary query position `xQuery`.
 *
 * End behaviour: CLAMPING — queries outside [x[0], x[n-1]] return the
 * nearest endpoint value (no extrapolation).  Documented consequence for
 * the chilldown objective: if the requested station lies beyond the last
 * usable wall node (e.g. station 4 at 60.35 m when the last usable node
 * is upstream), the result is the last node's value — a spatial
 * approximation whose error shrinks with N and is reported, not hidden.
 *
 * Errors: throws on length mismatch, empty arrays, or non-ascending `x`.
 */
export function interpolateAtPosition(
  x: number[],
  y: number[],
  xQuery: number
): number {
  if (x.length !== y.length) {
    throw new Error(`interpolateAtPosition: x (${x.length}) and y (${y.length}) length mismatch`);
  }
  if (x.length === 0) {
    throw new Error('interpolateAtPosition: empty sample arrays');
  }
  for (let i = 1; i < x.length; i++) {
    if (!(x[i] > x[i - 1])) {
      throw new Error(
        `interpolateAtPosition: x must be strictly ascending (x[${i - 1}]=${x[i - 1]}, x[${i}]=${x[i]})`
      );
    }
  }
  if (xQuery <= x[0]) return y[0];
  if (xQuery >= x[x.length - 1]) return y[y.length - 1];
  // Binary search for the bracketing interval x[i] <= xQuery < x[i+1].
  let lo = 0;
  let hi = x.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (x[mid] <= xQuery) lo = mid;
    else hi = mid;
  }
  const f = (xQuery - x[lo]) / (x[hi] - x[lo]);
  return y[lo] + f * (y[hi] - y[lo]);
}

/**
 * Spatially interpolate a multi-node time history to one station position.
 *
 * `xPositions[j]` is the axial position of node j; `nodeTraces[j][k]` is
 * node j's value at time index k (all traces share a common time grid).
 * Returns the interpolated station trace (same length as each input).
 */
export function interpolateTraceToStation(
  xPositions: number[],
  nodeTraces: number[][],
  stationX: number
): number[] {
  if (nodeTraces.length !== xPositions.length) {
    throw new Error(
      `interpolateTraceToStation: ${nodeTraces.length} traces for ${xPositions.length} positions`
    );
  }
  const nT = nodeTraces[0]?.length ?? 0;
  const out = new Array<number>(nT);
  for (let k = 0; k < nT; k++) {
    out[k] = interpolateAtPosition(
      xPositions,
      nodeTraces.map((tr) => tr[k]),
      stationX
    );
  }
  return out;
}

/**
 * Smooth first-threshold-crossing time via linear interpolation between
 * the bracketing time samples.
 *
 * Convention:
 *   - direction 'below' (default): first k with values[k] < threshold;
 *     'above': first k with values[k] > threshold.
 *   - NON-MONOTONE traces: the FIRST such crossing is returned (later
 *     re-crossings are ignored).  This is a deliberate, documented
 *     convention — during chilldown the physically meaningful event is
 *     the first passage of the quench front.
 *   - If the very first sample is already past the threshold, the
 *     crossing is at or before the record start: returns times[0].
 *   - If the trace never crosses, returns `undefined` (documented; the
 *     caller decides how to treat a non-chilldown — e.g. report
 *     "not chilled within endTime", never silently clamp).
 *
 * Smoothness: away from exact sample hits the return value is affine in
 * the two bracketing values, hence differentiable in any parameter that
 * moves the trace smoothly — unlike the naive step-function version.
 */
export function thresholdCrossingTime(
  times: number[],
  values: number[],
  threshold: number,
  direction: 'below' | 'above' = 'below'
): number | undefined {
  if (times.length !== values.length) {
    throw new Error(`thresholdCrossingTime: times (${times.length}) / values (${values.length}) length mismatch`);
  }
  if (times.length === 0) return undefined;
  const past = (v: number) => (direction === 'below' ? v < threshold : v > threshold);
  if (past(values[0])) return times[0];
  for (let k = 1; k < values.length; k++) {
    if (past(values[k])) {
      const v0 = values[k - 1];
      const v1 = values[k];
      const t0 = times[k - 1];
      const t1 = times[k];
      if (v1 === v0) return t1; // degenerate flat step; cannot interpolate
      const f = (threshold - v0) / (v1 - v0);
      return t0 + f * (t1 - t0);
    }
  }
  return undefined;
}
