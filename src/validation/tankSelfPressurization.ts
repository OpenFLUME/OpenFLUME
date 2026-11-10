/**
 * Self-pressurization of a closed liquid-hydrogen tank under a uniform wall
 * heat flux — Hasan, Lin & Van Dresar, NASA TM-103804 (1991), Table 1 —
 * against OpenFLUME's lumped real-fluid tank.
 *
 * The test article was the 4.89 m³ K-Site flightweight tank: an oblate
 * spheroid of 2.2 m major diameter and axis ratio 1.2, 83–84 % full of
 * liquid hydrogen, heated at 0.35, 2.0 and 3.5 W/m² in normal gravity.
 * Table 1 gives, for each heat flux, the quasi-steady measured pressure rise
 * rate over a stated pressure range (from steady-boil-off and from
 * isothermal initial conditions) and the rise rate of the paper's
 * homogeneous (thermal-equilibrium) model.
 *
 * OpenFLUME model: one internal node holding the whole tank volume, initial
 * state saturated at the lower end of the pressure range with the liquid
 * occupying 83.5 % of the volume, heat input q·S, and a closed valve to a
 * boundary node (a network needs one boundary).  A single lumped node is a
 * homogeneous equilibrium tank, so OpenFLUME represents the homogeneous
 * model of the paper and not the thermally stratified tank of the test.
 * The wall area S is that of the stated spheroid (a = 1.1 m, c = a/1.2),
 * scaled uniformly to the stated volume.  The model rise rate is the
 * pressure change across the stated range divided by the time to traverse
 * it.
 *
 * Analytic reference: a closed rigid tank at fixed mass m and density
 * ρ = m/V obeys m du/dt = Q, so P(t) = P(ρ, u0 + Q t/m) from CoolProp's
 * (ρ, u) flash — the homogeneous model evaluated directly, independent of
 * the network solver.
 */
import { solveTransient, validateNetwork } from "../core";
import type { NetworkConfig } from "../core";
import { getCoolProp } from "../core/fluids/coolprop";
import {
  HASAN1991_PRESSURE_RISE,
  type Cell,
} from "./generated/experimentalData";

const FLUID = "ParaHydrogen";

/** Stated tank geometry (TM-103804 via the CSV header). */
export const HASAN_TANK = {
  volume: 4.89,
  majorDiameter: 2.2,
  axisRatio: 1.2,
  liquidVolumeFraction: 0.835,
} as const;

/** Oblate-spheroid surface area for semi-axes a ≥ c. */
function spheroidArea(a: number, c: number): number {
  const e = Math.sqrt(1 - (c * c) / (a * a));
  return (
    2 * Math.PI * a * a + ((Math.PI * c * c) / e) * Math.log((1 + e) / (1 - e))
  );
}

/** Wall area of the stated spheroid scaled to the stated volume [m²]. */
export function hasanWallArea(): { area: number; scale: number } {
  const a = HASAN_TANK.majorDiameter / 2;
  const c = a / HASAN_TANK.axisRatio;
  const v = (4 / 3) * Math.PI * a * a * c;
  const scale = Math.cbrt(HASAN_TANK.volume / v);
  return { area: spheroidArea(a, c) * scale * scale, scale };
}

export interface HasanCase {
  heatFlux: number;
  pLow: number;
  pHigh: number;
  /** Measured rates [Pa/s] (null where not reported). */
  measuredSteadyBoiloff: number;
  measuredIsothermal: number | null;
  /** The paper's homogeneous-model rate [Pa/s]. */
  paperHomogeneous: number;
}

const KPA_PER_HR = 1000 / 3600;

export function hasanCases(): HasanCase[] {
  const t = HASAN1991_PRESSURE_RISE;
  const c = (row: readonly Cell[], name: string) =>
    row[t.columns.indexOf(name)];
  return t.rows.map((row) => {
    const [lo, hi] = String(c(row, "pressure_range_kPa"))
      .split("-")
      .map((x) => Number(x) * 1000);
    const iso = c(row, "rise_rate_isothermal_IC_kPa_hr");
    return {
      heatFlux: Number(c(row, "heat_flux_W_m2")),
      pLow: lo,
      pHigh: hi,
      measuredSteadyBoiloff:
        Number(c(row, "rise_rate_steady_boiloff_IC_kPa_hr")) * KPA_PER_HR,
      measuredIsothermal: typeof iso === "number" ? iso * KPA_PER_HR : null,
      paperHomogeneous:
        Number(c(row, "rise_rate_homogeneous_theory_kPa_hr")) * KPA_PER_HR,
    };
  });
}

/** Initial saturated state at P with the stated liquid volume fraction. */
function initialState(P: number) {
  const cp = getCoolProp();
  const st = cp.factory("HEOS", FLUID);
  st.update(cp.input_pairs.PQ_INPUTS, P, 0);
  const rf = st.rhomass();
  const uf = st.umass();
  st.update(cp.input_pairs.PQ_INPUTS, P, 1);
  const rg = st.rhomass();
  const ug = st.umass();
  const phi = HASAN_TANK.liquidVolumeFraction;
  const rho = phi * rf + (1 - phi) * rg;
  const quality = ((1 - phi) * rg) / rho;
  const u = (phi * rf * uf + (1 - phi) * rg * ug) / rho;
  return { rho, quality, u };
}

/** Analytic homogeneous rate: time to go pLow → pHigh at fixed ρ. */
export function analyticHomogeneousRate(c: HasanCase): number {
  const cp = getCoolProp();
  const st = cp.factory("HEOS", FLUID);
  const { area } = hasanWallArea();
  const { rho, u } = initialState(c.pLow);
  const m = rho * HASAN_TANK.volume;
  const Q = c.heatFlux * area;
  const pAt = (du: number) => {
    st.update(cp.input_pairs.DmassUmass_INPUTS, rho, u + du);
    return st.p();
  };
  // Bisect the specific-energy rise that reaches pHigh.
  let lo = 0;
  let hi = 1;
  while (pAt(hi) < c.pHigh) hi *= 2;
  for (let k = 0; k < 80; k++) {
    const mid = 0.5 * (lo + hi);
    if (pAt(mid) < c.pHigh) lo = mid;
    else hi = mid;
  }
  const time = (0.5 * (lo + hi) * m) / Q;
  return (c.pHigh - pAt(0)) / time;
}

export interface HasanResult {
  case: HasanCase;
  /** OpenFLUME rate over the stated range [Pa/s]. */
  model: number;
  analytic: number;
  converged: boolean;
  steps: number;
  /** Largest |ṁ| through the closed valve after t = 0 [kg/s] (the t = 0
   *  sample is the solver's flow seed, not a solved flow). */
  valveLeak: number;
}

export function solveHasan(c: HasanCase): HasanResult {
  const { area } = hasanWallArea();
  const { quality } = initialState(c.pLow);
  const Q = c.heatFlux * area;
  const analytic = analyticHomogeneousRate(c);
  // Run 1.5× the analytic traverse time at 60 steps per traverse.
  const tTraverse = (c.pHigh - c.pLow) / analytic;
  const dt = tTraverse / 60;
  const cfg: NetworkConfig = {
    meta: { name: "Hasan 1991 self-pressurization", version: 2 },
    settings: {
      mode: "transient",
      dt,
      endTime: 1.5 * tTraverse,
      timeStepping: "fixed",
      tolerance: 1e-8,
      maxIterations: 200,
    },
    fluid: { model: "realFluid", params: { fluidName: FLUID } },
    nodes: [
      {
        id: "tank",
        type: "internal",
        x: 0,
        y: 0,
        pressure: c.pLow,
        quality,
        volume: HASAN_TANK.volume,
        heatInput: Q,
      },
      {
        id: "vent",
        type: "boundary",
        x: 100,
        y: 0,
        pressure: c.pLow,
        quality: 1,
      },
    ],
    branches: [
      {
        id: "v",
        from: "tank",
        to: "vent",
        component: { type: "valve", area: 1e-4, cd: 0.6, position: 0 },
      },
    ],
  };
  const errors = validateNetwork(cfg);
  if (errors.length) throw new Error(errors.join("; "));
  const res = solveTransient(cfg);
  const P = res.nodes.tank.pressure;
  const crossing = (target: number): number => {
    for (let k = 1; k < P.length; k++) {
      if (P[k - 1] < target && P[k] >= target) {
        const f = (target - P[k - 1]) / (P[k] - P[k - 1]);
        return res.times[k - 1] + f * (res.times[k] - res.times[k - 1]);
      }
    }
    return NaN;
  };
  const tHigh = crossing(c.pHigh);
  return {
    case: c,
    model: (c.pHigh - P[0]) / tHigh,
    analytic,
    converged: res.converged,
    steps: res.times.length - 1,
    valveLeak: Math.max(...res.branches.v.mdot.slice(1).map(Math.abs)),
  };
}
