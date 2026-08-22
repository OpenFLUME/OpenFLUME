/**
 * Loop-based min/max for arrays whose length scales with model or timestep
 * size. `Math.min(...values)` pushes every element onto the call stack and
 * throws a RangeError past the engine's argument limit, so large arrays are
 * reduced iteratively instead. Empty input yields Infinity / -Infinity,
 * matching `Math.min()` / `Math.max()` with no arguments.
 */
export function arrayMin(values: readonly number[]): number {
  let min = Infinity;
  for (const v of values) if (v < min) min = v;
  return min;
}

export function arrayMax(values: readonly number[]): number {
  let max = -Infinity;
  for (const v of values) if (v > max) max = v;
  return max;
}
