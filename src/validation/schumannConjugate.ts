/**
 * Anzelius–Schumann verification case: network builder, closed-form
 * comparison and convergence helpers.  Shared by the CI gates
 * (src/validation/__tests__/schumannConjugate.test.ts) and the thermal
 * validation report (scripts/thermal-validation-report.ts, case 6).
 *
 * Setup (Cross, Majumdar, Bennett and Malla 2002, model 1 geometry): a 26 in
 * long, 3/16 in ID, 1/2 in OD aluminium tube.  The fluid is incompressible
 * with ρ = 10 kg/m³ and c_p = 14 434 J/kg·K (hydrogen-like heat capacity).
 * It enters at T_f0 through a constant mass-flow source and leaves through a
 * pressure boundary.  Wall and fluid properties are constant, the wall
 * conductivity along the tube is 1e-9 W/m·K (the closed form has no axial
 * conduction), the film coefficient is a constant h (a convection conductor
 * with no correlation), and the outer wall is adiabatic.
 *
 * Discretisation: N segments, N + 1 fluid nodes and N + 1 wall solid nodes at
 * z = j·L/N (half-volume end nodes), one convection conductor per
 * fluid/wall pair, backward Euler in time.
 *
 * The case is parameterised by the two closed-form groups
 *   a = h·P/(ρ_w c_w A_w) [1/s],    b = h·P/(ṁ c_f) [1/m],
 * from which h and ṁ follow for the fixed geometry.
 */

import { solveTransient } from "../core";
import type { NetworkConfig, TransientResult } from "../core";
import { interpolateAtPosition } from "./stationInterp";
import { schumannWallTemperature, type SchumannParams } from "./schumann";

export const SCHUMANN_GEOMETRY = {
  /** Tube length [m] (26 in). */
  L: 26 * 0.0254,
  /** Inside diameter [m] (3/16 in). */
  ID: (3 / 16) * 0.0254,
  /** Outside diameter [m] (1/2 in). */
  OD: 0.5 * 0.0254,
} as const;

export const SCHUMANN_PROPERTIES = {
  rhoW: 2700,
  cW: 900,
  rhoF: 10,
  cF: 14434,
  /** Fluid inlet temperature [K]. */
  Tf0: 33.15,
  /** Initial wall and fluid temperature [K]. */
  Tw0: 300,
} as const;

/** Wall temperature comparison stations [m] (Cross et al. 2002: z = 1.79, 12.56, 23.32 in). */
export const SCHUMANN_STATIONS_M = [0.0455, 0.319, 0.5923] as const;

/** Inverse wall time constant a = hP/(ρ_w c_w A_w) of the exploratory and report runs [1/s]. */
export const SCHUMANN_A = 0.038;

export interface SchumannSpec {
  /** Number of axial segments. */
  N: number;
  /** Fixed time step [s]. */
  dt: number;
  /** b = hP/(ṁ c_f) [1/m]. */
  b: number;
  /** a = hP/(ρ_w c_w A_w) [1/s]; defaults to SCHUMANN_A. */
  a?: number;
  /** End time [s]; defaults to 150. */
  tEnd?: number;
  /** Axial wall conductivity [W/m·K]; defaults to 1e-9 (none). */
  kAxial?: number;
}

/** Derived physical parameters of a spec. */
export function schumannParameters(spec: SchumannSpec) {
  const { ID, OD } = SCHUMANN_GEOMETRY;
  const { rhoW, cW, rhoF, cF, Tf0, Tw0 } = SCHUMANN_PROPERTIES;
  const a = spec.a ?? SCHUMANN_A;
  const Af = (Math.PI / 4) * ID * ID;
  const Aw = (Math.PI / 4) * (OD * OD - ID * ID);
  const Pw = Math.PI * ID;
  const hP = a * rhoW * cW * Aw;
  const h = hP / Pw;
  const mdot = hP / (spec.b * cF);
  const u = mdot / (rhoF * Af);
  const closedForm: SchumannParams = { a, b: spec.b, u, Tf0, Tw0 };
  return { a, Af, Aw, Pw, hP, h, mdot, u, closedForm };
}

const m = (x: number) => ({ x, y: 0, z: 0 });

/** Build the OpenFLUME network of an Anzelius–Schumann case. */
export function buildSchumannNetwork(spec: SchumannSpec): NetworkConfig {
  const { L, ID } = SCHUMANN_GEOMETRY;
  const { rhoW, cW, rhoF, cF, Tf0, Tw0 } = SCHUMANN_PROPERTIES;
  const p = schumannParameters(spec);
  const N = spec.N;
  const segL = L / N;
  const P0 = 2e5;

  const nodes: NetworkConfig["nodes"] = [];
  const solidNodes: NonNullable<NetworkConfig["solidNodes"]> = [];
  const conductors: NonNullable<NetworkConfig["conductors"]> = [];
  const branches: NetworkConfig["branches"] = [];

  nodes.push({
    id: "f0",
    type: "boundary",
    x: 0,
    y: 0,
    position: m(-0.05),
    pressure: P0,
    temperature: Tf0,
  });
  for (let j = 0; j <= N; j++) {
    const frac = j === 0 || j === N ? 0.5 : 1;
    nodes.push({
      id: `f${j + 1}`,
      type: "internal",
      x: (j + 1) * 170,
      y: 0,
      position: m(j * segL),
      pressure: P0,
      temperature: Tw0,
      volume: p.Af * segL * frac,
    });
    solidNodes.push({
      id: `s${j}`,
      type: "solid",
      x: (j + 1) * 170,
      y: 80,
      position: m(j * segL),
      temperature: Tw0,
      mass: rhoW * p.Aw * segL * frac,
      cp: cW,
    });
    conductors.push({
      id: `conv${j}`,
      from: `f${j + 1}`,
      to: `s${j}`,
      type: { kind: "convection", h: p.h, area: p.Pw * segL * frac },
    });
  }
  nodes.push({
    id: `f${N + 2}`,
    type: "boundary",
    x: (N + 2) * 170,
    y: 0,
    position: m(L + 0.05),
    pressure: P0,
    temperature: Tw0,
  });
  for (let j = 0; j < N; j++) {
    conductors.push({
      id: `cond${j}`,
      from: `s${j}`,
      to: `s${j + 1}`,
      type: {
        kind: "conduction",
        k: spec.kAxial ?? 1e-9,
        area: p.Aw,
        length: segL,
      },
    });
  }
  const pipe = (length: number) => ({
    type: "pipe" as const,
    length,
    diameter: ID,
    roughness: 1.5e-6,
  });
  branches.push({
    id: "pipe0",
    from: "f0",
    to: "f1",
    component: { type: "flowSource", massFlow: p.mdot },
  });
  for (let j = 1; j <= N; j++) {
    branches.push({
      id: `pipe${j}`,
      from: `f${j}`,
      to: `f${j + 1}`,
      component: pipe(segL),
    });
  }
  branches.push({
    id: `pipe${N + 1}`,
    from: `f${N + 1}`,
    to: `f${N + 2}`,
    component: pipe(0.05),
  });

  return {
    meta: {
      name: `Anzelius-Schumann N=${N} dt=${spec.dt} b=${spec.b}`,
      version: 2,
    },
    settings: {
      mode: "transient",
      tolerance: 1e-10,
      maxIterations: 100,
      relaxation: 1.0,
      endTime: spec.tEnd ?? 150,
      dt: spec.dt,
      timeStepping: "fixed" as const,
    },
    fluid: {
      model: "incompressible",
      params: { rho: rhoF, cp: cF, mu: 1e-5 },
    },
    nodes,
    solidNodes,
    conductors,
    branches,
  };
}

export interface SchumannRun {
  spec: SchumannSpec;
  converged: boolean;
  /** Steps whose scaled inner-Newton residual is at or above 0.01 (stalled). */
  stalledSteps: number;
  wallSeconds: number;
  times: number[];
  /** Per station: closed-form and OpenFLUME wall temperature traces [K]. */
  stations: Array<{
    z: number;
    analytic: number[];
    numeric: number[];
    /** max_t |ΔT| / (T_w0 − T_f0) */
    maxError: number;
    /** rms over time of |ΔT| / (T_w0 − T_f0) */
    rmsError: number;
  }>;
  /** max over stations of the station maximum errors. */
  maxError: number;
  /**
   * Global energy closure at the end time:
   * |ΔE_wall + ΔE_fluid − ∫ṁ c_f (T_f0 − T_out) dt| / |ΔE_wall|, where the
   * outflow temperature is the last fluid node (backward-Euler enthalpy flux).
   */
  energyClosure: number;
}

/** Solve one case and compare the wall temperature with the closed form. */
export function runSchumannCase(spec: SchumannSpec): SchumannRun {
  const cfg = buildSchumannNetwork(spec);
  const p = schumannParameters(spec);
  const { cW, rhoF, cF, Tf0, Tw0 } = SCHUMANN_PROPERTIES;
  const t0 = performance.now();
  const res: TransientResult = solveTransient(cfg);
  const wallSeconds = (performance.now() - t0) / 1000;

  const solid = cfg.solidNodes!;
  const wallX = solid.map((s) => (s.position as { x: number }).x);
  const times = res.times;
  const span = Tw0 - Tf0;

  const stations = SCHUMANN_STATIONS_M.map((z) => {
    // Linear interpolation in z between the wall nodes, trace by trace.
    const numeric = times.map((_, k) =>
      interpolateAtPosition(
        wallX,
        solid.map((s) => res.solidNodes![s.id].temperature[k]),
        z,
      ),
    );
    const analytic = times.map((t) =>
      schumannWallTemperature(p.closedForm, z, t),
    );
    const err = numeric.map((v, k) => Math.abs(v - analytic[k]) / span);
    return {
      z,
      analytic,
      numeric,
      maxError: Math.max(...err),
      rmsError: Math.sqrt(err.reduce((s, e) => s + e * e, 0) / err.length),
    };
  });

  // Energy closure over the whole solve.
  const last = times.length - 1;
  let dEwall = 0;
  for (const s of solid) {
    dEwall += s.mass! * cW * (res.solidNodes![s.id].temperature[last] - Tw0);
  }
  let dEfluid = 0;
  const fluidNodes = cfg.nodes.filter((n) => n.type === "internal");
  for (const n of fluidNodes) {
    dEfluid +=
      rhoF * n.volume! * cF * (res.nodes[n.id].temperature[last] - Tw0);
  }
  const outId = fluidNodes[fluidNodes.length - 1].id;
  let flowIn = 0;
  for (let k = 1; k <= last; k++) {
    flowIn +=
      p.mdot *
      cF *
      (Tf0 - res.nodes[outId].temperature[k]) *
      (times[k] - times[k - 1]);
  }
  const energyClosure = Math.abs(dEwall + dEfluid - flowIn) / Math.abs(dEwall);

  const sr = res.stepResidualsScaled ?? [];
  return {
    spec,
    converged: res.converged,
    stalledSteps: sr.filter((x) => x >= 0.01).length,
    wallSeconds,
    times,
    stations,
    maxError: Math.max(...stations.map((s) => s.maxError)),
    energyClosure,
  };
}

/**
 * Observed convergence order between consecutive (h, error) pairs,
 * p = ln(e₁/e₂) / ln(h₁/h₂), for a sequence ordered from coarse to fine.
 */
export function observedOrders(
  series: Array<{ h: number; error: number }>,
): number[] {
  const out: number[] = [];
  for (let i = 1; i < series.length; i++) {
    out.push(
      Math.log(series[i - 1].error / series[i].error) /
        Math.log(series[i - 1].h / series[i].h),
    );
  }
  return out;
}
