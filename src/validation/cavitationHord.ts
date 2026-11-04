/**
 * Developed cavitation of liquid hydrogen in a venturi — Hord, Anderson &
 * Hall, NASA CR-2054 (1972), Table A-1b — against the throat-pressure
 * assumption of OpenFLUME's `cavitatingVenturi` closure.
 *
 * The closure chokes the flow with the throat at the vapor pressure of the
 * inlet liquid, P_v(T0): ṁ = C_d A √(2 ρ0 (P0 − P_v(T0))).  Hord measured,
 * for 32 developed (super)cavities, the inlet state (P0, T0) and the wall
 * pressures and temperatures at seven ports along the cavity on both walls.
 * Evaporative cooling of the cavity ("thermodynamic suppression") holds the
 * cavity below T0, and therefore below P_v(T0).  This module quantifies
 * that, and what it means for the closure:
 *
 *   1. the vapor pressure OpenFLUME evaluates at T0 (CoolProp
 *      ParaHydrogen) against the value Hord tabulates (`pstar`, which equals
 *      ρ g h* — the saturation head at T0 — for every row);
 *   2. the measured cavity pressure at the leading edge, p_c (port 2, the
 *      port nearest the throat, mean of the two walls), and the minimum
 *      over all ports and both walls, against P_v(T0);
 *   3. the mass flux the closure predicts (an OpenFLUME solve, C_d = 1)
 *      against the flux a choked throat at the measured p_c would pass,
 *      G_c = √(2 ρ0 (P0 − p_c)).  Both carry the same C_d and area, so the
 *      ratio needs no venturi geometry;
 *   4. as a check on the data, each port's pressure against the saturation
 *      pressure at that port's measured temperature.
 *
 * Measured mass flow is not compared: the table gives a velocity "at the
 * test-section inlet" but the digitized record does not establish the area
 * it refers to, and with the throat diameter (1.905 cm) and the listed
 * inlet diameter (3.175 cm) the velocity head would exceed P0 − P_v.  The
 * hydrofoil and ogive sets (CR-2156, CR-2242) are external flows over
 * bodies with no network-component counterpart and are out of scope.
 */
import { RealFluid, solveSteady, validateNetwork } from "../core";
import type { NetworkConfig } from "../core";
import { HORD1972_LH2_VENTURI, type Cell } from "./generated/experimentalData";

const N_CM2 = 1e4;
const FLUID = "ParaHydrogen";
const AREA = 1e-4;

const PORTS = ["2", "4", "5", "6", "7", "8", "9"] as const;

export interface HordRun {
  run: string;
  T0: number;
  P0: number;
  /** Tabulated vapor pressure at T0 (pstar) [Pa]. */
  pvTab: number;
  cavityLengthCm: number;
  Kv: number;
  /** Port wall pressures [Pa] (both walls) and temperatures [K]. */
  ports: { port: string; p: number; pTop: number | null; T: number }[];
}

const t = HORD1972_LH2_VENTURI;
const col = (row: readonly Cell[], name: string): Cell => {
  const i = t.columns.indexOf(name);
  if (i < 0) throw new Error(`${t.file}: no column ${name}`);
  return row[i];
};
const n = (c: Cell): number => {
  if (typeof c !== "number") throw new Error(`non-numeric cell ${c}`);
  return c;
};
const nOrNull = (c: Cell): number | null => (typeof c === "number" ? c : null);

export function hordRuns(): HordRun[] {
  return t.rows.map((row) => ({
    run: String(col(row, "run")),
    T0: n(col(row, "T0_K")),
    P0: n(col(row, "P0_N_cm2")) * N_CM2,
    pvTab: n(col(row, "pstar_cavity_N_cm2")) * N_CM2,
    cavityLengthCm: n(col(row, "ell_cavity_cm")),
    Kv: n(col(row, "Kv")),
    ports: PORTS.map((k) => ({
      port: k,
      p: n(col(row, `p${k}_N_cm2`)) * N_CM2,
      pTop: (() => {
        const v = nOrNull(col(row, `p${k}top_N_cm2`));
        return v === null ? null : v * N_CM2;
      })(),
      T: n(col(row, `T${k}_K`)),
    })),
  }));
}

export interface HordResult {
  run: HordRun;
  /** OpenFLUME P_v(T0) [Pa]. */
  pv: number;
  /** Leading-edge cavity pressure (port 2, mean of both walls) [Pa]. */
  pC: number;
  /** Minimum measured cavity wall pressure [Pa] and its port. */
  pMin: number;
  pMinPort: string;
  /** Closure mass flux (OpenFLUME solve, C_d = 1) [kg/(m²·s)]. */
  Gclosure: number;
  /** Flux through a choked throat at the measured p_c [kg/(m²·s)]. */
  GatPc: number;
  converged: boolean;
  /** Port pressure / P_sat(port temperature), one per measured port. */
  portSaturationRatios: number[];
}

export function evaluateHord(r: HordRun): HordResult {
  const fluid = new RealFluid(FLUID);
  const pv = fluid.saturationPressure(r.T0);
  let pMin = Infinity;
  let pMinPort = "";
  const portSaturationRatios: number[] = [];
  for (const p of r.ports) {
    for (const v of [p.p, p.pTop]) {
      if (v === null) continue;
      if (v < pMin) {
        pMin = v;
        pMinPort = p.port;
      }
    }
    portSaturationRatios.push(p.p / fluid.saturationPressure(p.T));
  }
  const p2 = r.ports[0];
  const pC = p2.pTop === null ? p2.p : 0.5 * (p2.p + p2.pTop);
  const rho0 = fluid.density(r.P0, r.T0);
  const cfg: NetworkConfig = {
    meta: { name: "Hord venturi closure check", version: 2 },
    settings: { mode: "steady", tolerance: 1e-9, maxIterations: 200 },
    fluid: { model: "realFluid", params: { fluidName: FLUID } },
    nodes: [
      {
        id: "up",
        type: "boundary",
        x: 0,
        y: 0,
        pressure: r.P0,
        temperature: r.T0,
      },
      {
        id: "dn",
        type: "boundary",
        x: 100,
        y: 0,
        pressure: 0.5 * pv,
        temperature: r.T0,
      },
    ],
    branches: [
      {
        id: "v",
        from: "up",
        to: "dn",
        initialMdot: AREA * Math.sqrt(2 * rho0 * (r.P0 - pv)),
        component: {
          type: "cavitatingVenturi",
          throatArea: AREA,
          cd: 1,
          recoveryFactor: 0,
        },
      },
    ],
  };
  const errors = validateNetwork(cfg);
  if (errors.length) throw new Error(errors.join("; "));
  const res = solveSteady(cfg);
  return {
    run: r,
    pv,
    pC,
    pMin,
    pMinPort,
    Gclosure: res.branches.v.mdot / AREA,
    GatPc: Math.sqrt(2 * rho0 * (r.P0 - pC)),
    converged: res.converged,
    portSaturationRatios,
  };
}
