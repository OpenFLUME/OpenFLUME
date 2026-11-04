/**
 * Critical (choked) flow of cryogens through nozzles and a sharp-edged
 * orifice — NASA Lewis measurements against OpenFLUME's restriction
 * closures.
 *
 * Data (validation/data/digitized/choked_flow_cavitation/, transcribed into
 * src/validation/generated/experimentalData.ts by
 * scripts/build-experimental-data.ts):
 *   - Simoneau & Hendricks, NASA TP-1484 (1979): maximum mass flux of
 *     nitrogen through four converging–diverging nozzles (7° and 3.5°
 *     conical, elliptical, two-dimensional) and of methane through the
 *     elliptical nozzle, from subcooled liquid to supercritical and gaseous
 *     stagnation states.
 *   - Simoneau, NASA TM X-71760 (1975): maximum flow of subcooled nitrogen
 *     through a 0.318 cm sharp-edged orifice.
 * Each data point gives the stagnation state (P0, T0) and the measured
 * maximum mass flux G = ṁ/A at the throat (orifice: bore).
 *
 * Models (OpenFLUME networks: boundary(P0, T0) → one branch → boundary):
 *   - `cavitatingVenturi` on its choked branch for liquid inlets
 *     (T0 < T_c): G = C_d √(2 ρ0 (P0 − P_v(T0))), the single-phase liquid
 *     choked at the vapor pressure.  The downstream boundary is placed at
 *     half the vapor pressure so the closure is evaluated choked, the state
 *     the experiments were run in.
 *   - `orifice` with the real-fluid isentropic exponent κ = c_s²ρ/P and
 *     choking at r* for supercritical and gaseous inlets (T0 ≥ T_c), with
 *     the downstream boundary below r*·P0 (choked).
 *   - For the sharp-edged orifice data, additionally the `orifice` closure
 *     at the measured back pressure — the model a user would build for a
 *     sharp-edged restriction.
 * C_d = 1 for the nozzles (the papers compare their data with ideal
 * isentropic flow at the measured throat area) and C_d = 0.61 for the
 * sharp-edged orifice (the standard high-Reynolds-number value; White,
 * Fluid Mechanics).  Nothing is fitted.
 *
 * Reference model (not an OpenFLUME closure): the isentropic homogeneous
 * equilibrium model (HEM), G* = max_P ρ(P, s0) √(2 (h0 − h(P, s0))),
 * evaluated directly with CoolProp.  It shows how much of each
 * disagreement is the closure's idealization and how much is the
 * non-equilibrium physics that no equilibrium model contains.
 *
 * Quality control is transcription QC only, independent of every model:
 * the fields a prediction needs (T0, P0, G; Pb for the orifice) must be
 * present and not flagged as OCR-uncertain, fused, unparsed, ditto, or
 * missing by the digitizer, and where the paper tabulates the saturation
 * pressure at T0, CoolProp's value must agree within 5 % — a check on the
 * transcribed temperature.  For the orifice data, whose table has column
 * shifts, the back temperature must also match the saturation temperature
 * at the back pressure within 1.5 K (the jet discharges two-phase), and the
 * tabulated discharge coefficient must agree within 3 % with
 * G/√(2ρ0(P0 − Pb)) recomputed from the transcribed values (the paper's
 * definition), which catches a mis-read G.  The last check makes the
 * orifice comparison at the measured back pressure equivalent to comparing
 * C_d = 0.61 (times the expansibility factor) with the tabulated discharge
 * coefficients; it is reported that way.
 */
import { solveSteady, validateNetwork, RealFluid } from "../core";
import type { NetworkConfig } from "../core";
import { getCoolProp } from "../core/fluids/coolprop";
import {
  SIMONEAU1975_N2_ORIFICE,
  SIMONEAU1979_CH4_ELLIPTICAL,
  SIMONEAU1979_N2_2D,
  SIMONEAU1979_N2_3P5DEG_CONICAL,
  SIMONEAU1979_N2_7DEG_CONICAL,
  SIMONEAU1979_N2_ELLIPTICAL,
  type Cell,
  type ExperimentalTable,
} from "./generated/experimentalData";

/** 1 N/cm² = 10⁴ Pa; 1 g/(cm²·s) = 10 kg/(m²·s). */
const N_CM2 = 1e4;
const G_CM2_S = 10;

/** Nozzle discharge coefficient (ideal), and the sharp-edged orifice value. */
export const CD_NOZZLE = 1;
export const CD_SHARP_ORIFICE = 0.61;

/** Branch area used for every solve; G = ṁ/A is independent of it. */
const AREA = 1e-4;

export type Geometry =
  | "7° conical nozzle"
  | "3.5° conical nozzle"
  | "elliptical nozzle"
  | "2-D nozzle"
  | "sharp-edged orifice";

/**
 * Inlet regimes.  Liquid inlets (T0 < T_c) are split by subcooling, the
 * ratio of stagnation pressure to the vapor pressure at T0: the choked
 * liquid closure drives the flow with P0 − P_v, so the nearer the inlet is
 * to saturation the more the result depends on where the liquid actually
 * flashes.
 */
export type InletRegime =
  | "subcooled liquid, P0/Pv ≥ 2"
  | "near-saturated liquid, P0/Pv < 2"
  | "supercritical, 1 ≤ T0/Tc < 1.5"
  | "gas, T0/Tc ≥ 1.5";

export const INLET_REGIMES: readonly InletRegime[] = [
  "subcooled liquid, P0/Pv ≥ 2",
  "near-saturated liquid, P0/Pv < 2",
  "supercritical, 1 ≤ T0/Tc < 1.5",
  "gas, T0/Tc ≥ 1.5",
];

export interface ChokedFlowPoint {
  source: string;
  geometry: Geometry;
  /** CoolProp fluid name. */
  fluid: "Nitrogen" | "Methane";
  reading: string;
  T0: number;
  P0: number;
  /** Measured back pressure [Pa] (null where blank). */
  Pb: number | null;
  /** Measured maximum mass flux [kg/(m²·s)]. */
  G: number;
  /** Tabulated saturation pressure at T0 [Pa] (null where not tabulated). */
  psatT0: number | null;
  /** Tabulated back temperature [K] (orifice table). */
  Tb: number | null;
  /** Usable after transcription QC. */
  usable: boolean;
  /** Why a row was excluded (empty when usable). */
  excluded: string[];
}

interface TableSpec {
  table: ExperimentalTable;
  source: string;
  geometry: Geometry;
  fluid: ChokedFlowPoint["fluid"];
}

const NOZZLE_TABLES: TableSpec[] = [
  {
    table: SIMONEAU1979_N2_7DEG_CONICAL,
    source: "Simoneau & Hendricks 1979, Table VI",
    geometry: "7° conical nozzle",
    fluid: "Nitrogen",
  },
  {
    table: SIMONEAU1979_N2_3P5DEG_CONICAL,
    source: "Simoneau & Hendricks 1979, Table VII",
    geometry: "3.5° conical nozzle",
    fluid: "Nitrogen",
  },
  {
    table: SIMONEAU1979_N2_2D,
    source: "Simoneau & Hendricks 1979, Table VIII",
    geometry: "2-D nozzle",
    fluid: "Nitrogen",
  },
  {
    table: SIMONEAU1979_N2_ELLIPTICAL,
    source: "Simoneau & Hendricks 1979, Table IX",
    geometry: "elliptical nozzle",
    fluid: "Nitrogen",
  },
  {
    table: SIMONEAU1979_CH4_ELLIPTICAL,
    source: "Simoneau & Hendricks 1979, Table X",
    geometry: "elliptical nozzle",
    fluid: "Methane",
  },
];

const col = (t: ExperimentalTable, row: readonly Cell[], name: string) => {
  const i = t.columns.indexOf(name);
  if (i < 0) throw new Error(`${t.file}: no column ${name}`);
  return row[i];
};
const num = (c: Cell): number | null =>
  typeof c === "number" && Number.isFinite(c) ? c : null;

/** Digitizer cell flags that make a value unusable. */
const BAD_FLAG = /^(ocr|fused|unparsed|ditto|ditto_arrow|missing|dash)$/;

let fluidCache: Map<string, RealFluid> | undefined;
function fluidOf(name: string): RealFluid {
  fluidCache ??= new Map();
  let f = fluidCache.get(name);
  if (!f) {
    f = new RealFluid(name);
    fluidCache.set(name, f);
  }
  return f;
}

function psatCheck(
  fluid: RealFluid,
  T0: number,
  psatTab: number | null,
  excluded: string[],
) {
  if (psatTab === null || T0 >= fluid.criticalTemperature()) return;
  const ps = fluid.saturationPressure(T0);
  if (Math.abs(ps - psatTab) / ps > 0.05)
    excluded.push(
      `tabulated Psat(T0) ${(psatTab / 1e3).toFixed(0)} kPa vs CoolProp ${(ps / 1e3).toFixed(0)} kPa`,
    );
}

/** Parse the nozzle tables (TP-1484) with transcription QC. */
export function nozzlePoints(): ChokedFlowPoint[] {
  const out: ChokedFlowPoint[] = [];
  for (const spec of NOZZLE_TABLES) {
    const t = spec.table;
    const fluid = fluidOf(spec.fluid);
    for (const row of t.rows) {
      const excluded: string[] = [];
      const flags = String(col(t, row, "flags") ?? "")
        .split(";")
        .filter(Boolean);
      for (const f of flags) {
        const [field, kind] = f.split(":");
        if (["T0", "P0", "G"].includes(field) && BAD_FLAG.test(kind))
          excluded.push(`${field} flagged ${kind}`);
      }
      const T0 = num(col(t, row, "T0_K"));
      const P0c = num(col(t, row, "P0_N_cm2"));
      const Gc = num(col(t, row, "Gmax_g_cm2_s"));
      const Pbc = num(col(t, row, "Pb_N_cm2"));
      const psc = num(col(t, row, "Psat_T0_N_cm2"));
      if (T0 === null) excluded.push("T0 blank");
      if (P0c === null) excluded.push("P0 blank");
      if (Gc === null) excluded.push("G blank");
      const psatFlag = flags.find((f) => f.startsWith("PsatT0:"));
      const psatTab =
        psc !== null && !(psatFlag && BAD_FLAG.test(psatFlag.split(":")[1]))
          ? psc * N_CM2
          : null;
      if (T0 !== null) psatCheck(fluid, T0, psatTab, excluded);
      out.push({
        source: spec.source,
        geometry: spec.geometry,
        fluid: spec.fluid,
        reading: String(col(t, row, "reading") ?? ""),
        T0: T0 ?? NaN,
        P0: (P0c ?? NaN) * N_CM2,
        Pb: Pbc === null ? null : Pbc * N_CM2,
        G: (Gc ?? NaN) * G_CM2_S,
        psatT0: psatTab,
        Tb: num(col(t, row, "Tb_K")),
        usable: excluded.length === 0,
        excluded,
      });
    }
  }
  return out;
}

/** Parse the sharp-edged orifice table (TM X-71760) with transcription QC. */
export function orificePoints(): ChokedFlowPoint[] {
  const t = SIMONEAU1975_N2_ORIFICE;
  const fluid = fluidOf("Nitrogen");
  return t.rows.map((row) => {
    const excluded: string[] = [];
    const flags = String(col(t, row, "flags") ?? "");
    if (flags) excluded.push(`row flagged ${flags}`);
    const T0 = num(col(t, row, "T0_K"));
    const P0c = num(col(t, row, "P0_N_cm2"));
    const Pbc = num(col(t, row, "Pb_N_cm2"));
    const Gc = num(col(t, row, "Gmax_g_cm2_s"));
    const Tb = num(col(t, row, "Tb_K"));
    const psc = num(col(t, row, "Psat_T0_N_cm2"));
    if (
      T0 === null ||
      P0c === null ||
      Pbc === null ||
      Gc === null ||
      Tb === null
    )
      excluded.push("required field blank");
    if (T0 !== null && excluded.length === 0) {
      psatCheck(fluid, T0, psc === null ? null : psc * N_CM2, excluded);
      if (psc === null && T0 < fluid.criticalTemperature())
        excluded.push("Psat(T0) not tabulated");
      // The table's discharge coefficient is G/√(2ρ0(P0 − Pb)); recomputing
      // it from the transcribed G, P0, Pb, T0 catches a mis-read G.
      const cdTab = num(col(t, row, "Cd"));
      const rho0 = fluid.density(P0c! * N_CM2, T0);
      const cdCalc =
        (Gc! * G_CM2_S) / Math.sqrt(2 * rho0 * (P0c! - Pbc!) * N_CM2);
      if (cdTab === null || Math.abs(cdCalc - cdTab) / cdTab > 0.03)
        excluded.push(
          `tabulated Cd ${cdTab} vs ${cdCalc.toFixed(3)} from G, P0, Pb, T0`,
        );
      const tsatB = fluid.saturationTemperature(Pbc! * N_CM2);
      if (Math.abs(tsatB - Tb!) > 1.5)
        excluded.push(
          `Tb ${Tb} K vs Tsat(Pb) ${tsatB.toFixed(1)} K (column shift)`,
        );
    }
    return {
      source: "Simoneau 1975, Table I",
      geometry: "sharp-edged orifice" as const,
      fluid: "Nitrogen" as const,
      reading: String(col(t, row, "rdg") ?? ""),
      T0: T0 ?? NaN,
      P0: (P0c ?? NaN) * N_CM2,
      Pb: Pbc === null ? null : Pbc * N_CM2,
      G: (Gc ?? NaN) * G_CM2_S,
      psatT0: psc === null ? null : psc * N_CM2,
      Tb,
      usable: excluded.length === 0,
      excluded,
    };
  });
}

export function inletRegime(p: ChokedFlowPoint): InletRegime {
  const fluid = fluidOf(p.fluid);
  const Tr = p.T0 / fluid.criticalTemperature();
  if (Tr < 1)
    return p.P0 / fluid.saturationPressure(p.T0) >= 2
      ? INLET_REGIMES[0]
      : INLET_REGIMES[1];
  if (Tr < 1.5) return INLET_REGIMES[2];
  return INLET_REGIMES[3];
}

/**
 * Isentropic homogeneous-equilibrium critical mass flux from (P0, T0):
 * max over P of ρ(P, s0)·√(2(h0 − h(P, s0))), by a fine scan in P followed
 * by golden-section refinement.  Returns G* and the critical pressure.
 */
export function hemCriticalFlux(
  fluidName: string,
  P0: number,
  T0: number,
): { G: number; Pstar: number } {
  const cp = getCoolProp();
  const st = cp.factory("HEOS", fluidName);
  st.update(cp.input_pairs.PT_INPUTS, P0, T0);
  if (!st.smass) throw new Error("CoolProp build has no entropy accessor");
  const s0 = st.smass();
  const h0 = st.hmass();
  const Gat = (P: number): number => {
    try {
      st.update(cp.input_pairs.PSmass_INPUTS, P, s0);
      const dh = h0 - st.hmass();
      return dh > 0 ? st.rhomass() * Math.sqrt(2 * dh) : 0;
    } catch {
      return 0;
    }
  };
  const N = 400;
  let best = 0;
  let iBest = 1;
  for (let i = 1; i < N; i++) {
    const g = Gat((P0 * i) / N);
    if (g > best) {
      best = g;
      iBest = i;
    }
  }
  let lo = (P0 * Math.max(iBest - 1, 0.5)) / N;
  let hi = (P0 * Math.min(iBest + 1, N - 0.5)) / N;
  const phi = (Math.sqrt(5) - 1) / 2;
  for (let k = 0; k < 60; k++) {
    const a = hi - phi * (hi - lo);
    const b = lo + phi * (hi - lo);
    if (Gat(a) > Gat(b)) hi = b;
    else lo = a;
  }
  const Pstar = 0.5 * (lo + hi);
  return { G: Math.max(best, Gat(Pstar)), Pstar };
}

/** One-branch network: boundary (P0, T0) → component → boundary Pdown. */
function solveBranch(
  fluidName: string,
  P0: number,
  T0: number,
  Pdown: number,
  component: NetworkConfig["branches"][number]["component"],
  mdotGuess: number,
): { G: number; converged: boolean } {
  const cfg: NetworkConfig = {
    meta: { name: "choked-flow validation", version: 2 },
    settings: { mode: "steady", tolerance: 1e-9, maxIterations: 200 },
    fluid: { model: "realFluid", params: { fluidName } },
    nodes: [
      { id: "up", type: "boundary", x: 0, y: 0, pressure: P0, temperature: T0 },
      {
        id: "dn",
        type: "boundary",
        x: 100,
        y: 0,
        pressure: Pdown,
        temperature: T0,
      },
    ],
    branches: [
      { id: "r", from: "up", to: "dn", component, initialMdot: mdotGuess },
    ],
  };
  const errors = validateNetwork(cfg);
  if (errors.length) throw new Error(errors.join("; "));
  const res = solveSteady(cfg);
  return { G: res.branches.r.mdot / AREA, converged: res.converged };
}

export type ClosureName =
  | "cavitatingVenturi (choked)"
  | "orifice (κ = c²ρ/P, choked)"
  | "orifice at measured Pb";

export interface ChokedFlowResult {
  point: ChokedFlowPoint;
  regime: InletRegime;
  closure: ClosureName;
  cd: number;
  /** OpenFLUME prediction [kg/(m²·s)]. */
  Gmodel: number;
  converged: boolean;
  /** HEM reference times the same C_d [kg/(m²·s)], and the HEM critical
   *  pressure ratio. */
  Ghem: number;
  hemPressureRatio: number;
}

/** Solve the primary closure for one usable point (see module header). */
export function predict(
  p: ChokedFlowPoint,
  closure?: ClosureName,
): ChokedFlowResult {
  const fluid = fluidOf(p.fluid);
  const liquid = p.T0 < fluid.criticalTemperature();
  const cd =
    p.geometry === "sharp-edged orifice" ? CD_SHARP_ORIFICE : CD_NOZZLE;
  const which: ClosureName =
    closure ??
    (liquid ? "cavitatingVenturi (choked)" : "orifice (κ = c²ρ/P, choked)");
  const rho0 = fluid.density(p.P0, p.T0);
  const guess = cd * AREA * Math.sqrt(2 * rho0 * 0.5 * p.P0);
  let sol: { G: number; converged: boolean };
  if (which === "cavitatingVenturi (choked)") {
    const pv = fluid.saturationPressure(p.T0);
    sol = solveBranch(
      p.fluid,
      p.P0,
      p.T0,
      0.5 * pv,
      { type: "cavitatingVenturi", throatArea: AREA, cd, recoveryFactor: 0 },
      guess,
    );
  } else if (which === "orifice (κ = c²ρ/P, choked)") {
    sol = solveBranch(
      p.fluid,
      p.P0,
      p.T0,
      0.05 * p.P0,
      { type: "orifice", area: AREA, cd },
      guess,
    );
  } else {
    if (p.Pb === null) throw new Error(`${p.reading}: no back pressure`);
    sol = solveBranch(
      p.fluid,
      p.P0,
      p.T0,
      p.Pb,
      { type: "orifice", area: AREA, cd },
      guess,
    );
  }
  const hem = hemCriticalFlux(p.fluid, p.P0, p.T0);
  return {
    point: p,
    regime: inletRegime(p),
    closure: which,
    cd,
    Gmodel: sol.G,
    converged: sol.converged,
    Ghem: cd * hem.G,
    hemPressureRatio: hem.Pstar / p.P0,
  };
}

export interface RegimeStats {
  n: number;
  /** Median and range of G_model/G_measured. */
  median: number;
  min: number;
  max: number;
  /** Mean absolute deviation |G_model/G_meas − 1|. */
  meanAbsDev: number;
}

export function ratioStats(ratios: number[]): RegimeStats | undefined {
  if (ratios.length === 0) return undefined;
  const s = [...ratios].sort((a, b) => a - b);
  const m = s.length;
  const median = m % 2 ? s[(m - 1) / 2] : 0.5 * (s[m / 2 - 1] + s[m / 2]);
  return {
    n: m,
    median,
    min: s[0],
    max: s[m - 1],
    meanAbsDev: s.reduce((a, r) => a + Math.abs(r - 1), 0) / m,
  };
}
