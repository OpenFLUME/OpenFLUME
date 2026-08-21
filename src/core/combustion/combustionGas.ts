/**
 * Runtime combustion-gas model: bilinear interpolation of the committed CEA
 * chamber-equilibrium tables (generated/ceaTables.ts) in (ln Pc, O/F).
 *
 * This module is the ONLY place that reads the generated tables at runtime;
 * everything else (the schema, validation, and the reacting-junction model in
 * ./model.ts) goes through `lookupCombustionGas` / `lookupChamberT0Dual`.
 * See scripts/build-cea-tables.py and docs/combustion.md for how the tables
 * were produced and why `gamma` here is CEA's isentropic exponent gamma_s
 * rather than cp_eq/cv_eq.
 *
 * Self-consistency: `R` and `cp` are DERIVED from the interpolated `mw` and
 * `gamma` (R = R_universal/mw, cp = gamma/(gamma-1)*R) rather than
 * interpolating a separately-tabulated cp.  This guarantees the returned
 * state is always usable as a constant-property ideal-gas fluid model
 * (src/core/fluids/index.ts IdealGas) with cp, R, gamma satisfying the
 * ideal-gas relation exactly — interpolating cp_eq independently would not.
 *
 * Range handling: requests outside the tabulated (Pc, O/F) box are CLAMPED
 * to the nearest edge (never extrapolated) and flagged via `clampedPc` /
 * `clampedOf` so callers (the junction summaries in core/solver/steady.ts)
 * can surface a warning.
 */
import {
  CEA_TABLES,
  type CombustionPropellants,
  type CeaChamberTable,
} from "./generated/ceaTables";
import type { Dual } from "../dual";
import { constant, add, sub, mul, div, log } from "../dual";

export type { CombustionPropellants } from "./generated/ceaTables";
export { CEA_PROVENANCE } from "./generated/ceaTables";

/** Universal gas constant [J/(mol*K)] — matches IdealGasMixture.R_universal. */
export const R_UNIVERSAL = 8.314462618;

export interface CombustionGasState {
  /** Equilibrium chamber (stagnation) temperature [K]. */
  readonly T0: number;
  /** Equilibrium mixture molecular weight [kg/mol]. */
  readonly mw: number;
  /** Specific gas constant R = R_universal / mw [J/(kg*K)]. */
  readonly R: number;
  /** Frozen-flow ideal-gas exponent — CEA's isentropic gamma_s. */
  readonly gamma: number;
  /** Self-consistent ideal-gas cp = gamma/(gamma-1)*R [J/(kg*K)]. */
  readonly cp: number;
  /** Equilibrium viscosity [Pa*s]. */
  readonly mu: number;
  /** CEA's own characteristic velocity c* [m/s] — a validation reference
   *  only; the driver never uses this to set network state. */
  readonly cstar: number;
}

export interface CombustionGasBounds {
  readonly pcMinPa: number;
  readonly pcMaxPa: number;
  readonly ofMin: number;
  readonly ofMax: number;
}

export interface CombustionGasResult {
  readonly state: CombustionGasState;
  /** True if the requested Pc fell outside the table and was clamped. */
  readonly clampedPc: boolean;
  /** True if the requested O/F fell outside the table and was clamped. */
  readonly clampedOf: boolean;
}

export function listCombustionPropellants(): CombustionPropellants[] {
  return Object.keys(CEA_TABLES) as CombustionPropellants[];
}

export function combustionGasBounds(
  propellants: CombustionPropellants,
): CombustionGasBounds {
  const table = requireTable(propellants);
  return {
    pcMinPa: table.pcGridPa[0],
    pcMaxPa: table.pcGridPa[table.pcGridPa.length - 1],
    ofMin: table.ofGrid[0],
    ofMax: table.ofGrid[table.ofGrid.length - 1],
  };
}

/**
 * Interpolate the equilibrium chamber gas state at (pcPa, of).
 *
 * @param pcPa chamber stagnation pressure [Pa], must be > 0.
 * @param of   oxidizer/fuel mass ratio, must be > 0.
 */
export function lookupCombustionGas(
  propellants: CombustionPropellants,
  pcPa: number,
  of: number,
): CombustionGasResult {
  const table = requireTable(propellants);
  if (!(pcPa > 0) || !Number.isFinite(pcPa)) {
    throw new Error(
      `lookupCombustionGas: pcPa must be a positive finite number, got ${pcPa}`,
    );
  }
  if (!(of > 0) || !Number.isFinite(of)) {
    throw new Error(
      `lookupCombustionGas: O/F must be a positive finite number, got ${of}`,
    );
  }

  const pcB = bracket(lnPcGridOf(table), Math.log(pcPa));
  const ofB = bracket(table.ofGrid, of);

  const mw = bilerp(table.mw, pcB, ofB);
  const gamma = bilerp(table.gammaS, pcB, ofB);
  const R = R_UNIVERSAL / mw;

  const state: CombustionGasState = {
    T0: bilerp(table.t0, pcB, ofB),
    mw,
    R,
    gamma,
    cp: (gamma / (gamma - 1)) * R,
    mu: bilerp(table.muPaS, pcB, ofB),
    cstar: bilerp(table.cstar, pcB, ofB),
  };

  return { state, clampedPc: pcB.clamped, clampedOf: ofB.clamped };
}

/**
 * Adiabatic chamber temperature T0 [K] at (pcPa, of) with derivative
 * propagation — the dual-number mirror of `lookupCombustionGas(...).state.T0`
 * for the reacting-junction Newton residual (core/solver/kernel.ts).
 *
 * The primal value is bit-identical to the scalar lookup (same bracket, same
 * bilinear arithmetic).  The derivative chains through the interpolation
 * fractions: dT0/dPc via the ln-Pc axis (d lnPc/dPc = 1/Pc), dT0/dOF
 * directly.  Where the lookup point is CLAMPED to a table edge the
 * interpolation fraction is constant, so the propagated derivative is 0 in
 * the clamped direction — the honest derivative of the clamped function.
 */
export function lookupChamberT0Dual(
  propellants: CombustionPropellants,
  pcPa: Dual,
  of: Dual,
): Dual {
  const table = requireTable(propellants);
  const pcB = bracket(lnPcGridOf(table), Math.log(pcPa.v));
  const ofB = bracket(table.ofGrid, of.v);

  const lnPcGrid = lnPcGridOf(table);
  const pcT: Dual = pcB.clamped
    ? constant(pcB.t)
    : divBySpan(log(pcPa), lnPcGrid[pcB.i0], lnPcGrid[pcB.i1]);
  const ofT: Dual = ofB.clamped
    ? constant(ofB.t)
    : divBySpan(of, table.ofGrid[ofB.i0], table.ofGrid[ofB.i1]);

  const t0 = table.t0;
  const v00 = t0[pcB.i0][ofB.i0];
  const v01 = t0[pcB.i0][ofB.i1];
  const v10 = t0[pcB.i1][ofB.i0];
  const v11 = t0[pcB.i1][ofB.i1];
  const v0 = add(constant(v00), mul(constant(v01 - v00), ofT));
  const v1 = add(constant(v10), mul(constant(v11 - v10), ofT));
  return add(v0, mul(sub(v1, v0), pcT));
}

/** Interpolation fraction t = (x − lo)/(hi − lo) as a dual in x. */
function divBySpan(x: Dual, lo: number, hi: number): Dual {
  const span = hi - lo;
  if (span === 0) return constant(0);
  return div(sub(x, constant(lo)), constant(span));
}

/* ------------------------------------------------------------------------ */
/* Internals                                                                 */
/* ------------------------------------------------------------------------ */

function requireTable(propellants: CombustionPropellants): CeaChamberTable {
  const table = CEA_TABLES[propellants];
  if (!table) {
    throw new Error(`lookupCombustionGas: unknown propellants "${propellants}"`);
  }
  return table;
}

// ln(pcGridPa) is used (not pcGridPa directly) so interpolation is linear in
// ln(Pc), matching the log-spaced grid and the mildly-nonlinear Pc
// dependence of the equilibrium properties. Cached per table since it never
// changes across calls.
const lnPcGridCache = new WeakMap<CeaChamberTable, readonly number[]>();
function lnPcGridOf(table: CeaChamberTable): readonly number[] {
  let cached = lnPcGridCache.get(table);
  if (!cached) {
    cached = table.pcGridPa.map(Math.log);
    lnPcGridCache.set(table, cached);
  }
  return cached;
}

interface Bracket {
  readonly i0: number;
  readonly i1: number;
  /** Interpolation fraction in [0, 1] between grid[i0] and grid[i1]. */
  readonly t: number;
  readonly clamped: boolean;
}

/** Locate the bracketing interval for `x` in a strictly increasing grid,
 *  clamping to the end intervals when `x` is out of range. */
function bracket(grid: readonly number[], x: number): Bracket {
  const n = grid.length;
  if (n === 1) return { i0: 0, i1: 0, t: 0, clamped: x !== grid[0] };
  if (x <= grid[0]) return { i0: 0, i1: 1, t: 0, clamped: x < grid[0] };
  if (x >= grid[n - 1]) {
    return { i0: n - 2, i1: n - 1, t: 1, clamped: x > grid[n - 1] };
  }
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (grid[mid] <= x) lo = mid;
    else hi = mid;
  }
  const span = grid[hi] - grid[lo];
  const t = span === 0 ? 0 : (x - grid[lo]) / span;
  return { i0: lo, i1: hi, t, clamped: false };
}

function bilerp(
  table: readonly (readonly number[])[],
  pcB: Bracket,
  ofB: Bracket,
): number {
  const v00 = table[pcB.i0][ofB.i0];
  const v01 = table[pcB.i0][ofB.i1];
  const v10 = table[pcB.i1][ofB.i0];
  const v11 = table[pcB.i1][ofB.i1];
  const v0 = v00 + (v01 - v00) * ofB.t;
  const v1 = v10 + (v11 - v10) * ofB.t;
  return v0 + (v1 - v0) * pcB.t;
}
