/**
 * NASA SP-125 A-1 stage engine balance case (750 klbf LOX/RP-1, gas
 * generator cycle): network builder, nested balance and post-processing.
 * Shared by the CI gate and the validation report.  The data, the imposed
 * inputs, the free parameter and the metrics are fixed in
 * docs/validation/engine-balance-protocol.md, committed before any run.
 *
 * Structure.  One steady network holds the LOX and RP-1 feed lines (one
 * square-law orifice per printed pressure drop), the two pumps (pressure rise
 * versus volumetric flow, a quadratic head-flow shape through the design
 * point, rebuilt for each shaft speed by the affinity laws), a reacting
 * junction chamber (CEA lox-rp1 table) with a choked throat, the gas
 * generator liquid branches and the turbine as a choked orifice with the
 * book's gas state.  Two script-level loops sit around it.  An inner scalar
 * root find sets the gas generator injector end pressure so that the liquid
 * flow into the gas generator equals the turbine flow.  An outer secant
 * iteration sets the common shaft speed so that the turbine power equals the
 * pump powers plus the auxiliary drive.  OpenFLUME has no turbine component
 * and no shaft unknown, so the turbine power is post-processed.
 */

import { solveSteady, validateNetwork } from "../core";
import type { NetworkConfig } from "../core";
import { Orifice } from "../core/components/orifice";

/* ------------------------------------------------------------------ */
/* Units                                                               */
/* ------------------------------------------------------------------ */

export const LB = 0.45359237;
export const PSI = 6894.757293168;
export const FT = 0.3048;
export const IN2 = 0.0254 * 0.0254;
export const G0 = 9.80665;
const BTU_PER_LB_F = 4186.8;
/** One mechanical horsepower, 550 ft lbf/s [W]. */
export const HP = 550 * 1.3558179483314;
const FT_LBF = 1.3558179483314;

/* ------------------------------------------------------------------ */
/* SP-125 data (printed values, see the protocol for page citations)   */
/* ------------------------------------------------------------------ */

export const A1 = {
  rhoLox: 71.38 * (LB / (FT * FT * FT)),
  rhoRp1: 50.45 * (LB / (FT * FT * FT)),
  loxInletP: 55 * PSI,
  fuelInletP: 45 * PSI,
  loxDischargeP: 1505 * PSI,
  fuelDischargeP: 1720 * PSI,
  injectorEndP: 1095 * PSI,
  nozzleStagP: 1000 * PSI,
  mdotOx: 1941 * LB,
  mdotFuel: 827 * LB,
  ggMdotOx: 26.7 * LB,
  ggMdotFuel: 65.3 * LB,
  hxMdot: 3 * LB,
  loxPumpMdot: 1971 * LB,
  fuelPumpMdot: 892 * LB,
  throatArea: 487 * IN2,
  cstarEff: 0.975,
  etaLoxPump: 0.707,
  etaFuelPump: 0.658,
  etaTurbine: 0.582,
  nDesign: 7000,
  auxHp: 500,
  turbineInletP: 640 * PSI,
  turbineExhaustP: 27 * PSI,
  turbineT: 1860 / 1.8,
  turbineCp: 0.653 * BTU_PER_LB_F,
  turbineGamma: 1.124,
  /** Printed R of Table 6-4, 53.6 ft lbf/(lb R), in J/(kg K). */
  turbineR: (53.6 * FT_LBF * 1.8) / LB,
  ggInjectorEndP: 710 * PSI,
  combustorDropP: 70 * PSI,
  /** Printed drops, psi, in flow order from the pump discharge. */
  dropsLox: [
    ["line", 25],
    ["valve", 35],
    ["dome", 150],
    ["injector", 200],
  ] as Array<[string, number]>,
  dropsFuel: [
    ["line", 10],
    ["valve", 15],
    ["calibration", 110],
    ["jacket", 290],
    ["injector", 200],
  ] as Array<[string, number]>,
  dropsGgLox: [
    ["entrance", 25],
    ["line", 25],
    ["control", 615],
    ["valve", 10],
    ["injector", 120],
  ] as Array<[string, number]>,
  dropsGgFuel: [
    ["entrance", 25],
    ["line", 25],
    ["control", 800],
    ["valve", 20],
    ["injector", 140],
  ] as Array<[string, number]>,
};

/** Printed book values compared in the report. */
export const BOOK = {
  mdotOx: 1941,
  mdotFuel: 827,
  of: 2.35,
  ggOx: 26.7,
  ggFuel: 65.3,
  ggOf: 0.408,
  turbineMdot: 92,
  loxPumpMdot: 1971,
  fuelPumpMdot: 892,
  pc: 1000,
  cstar: 5660,
  injectorEnd: 1095,
  ggInjectorEnd: 710,
  turbineInlet: 640,
  turbinePr: 23.7,
  loxHead: 2930,
  fuelHead: 4790,
  loxHp: 14850,
  fuelHp: 11790,
  turbineHp: 27140,
  auxHp: 500,
  torque: 20380,
  rpm: 7000,
};

export interface A1Options {
  /** Common shaft speed over the design speed. */
  speedRatio?: number;
  /** Common scale of the two gas generator control orifice areas. */
  ggOrificeScale?: number;
  /** Pump shut-off head over design head. */
  shutoff?: number;
  /** Turbine gas constant [J/(kg K)]. */
  turbineR?: number;
  /** Scale the combustor drop with the square of the gas generator flow. */
  scaleCombustorDrop?: boolean;
}

const DEFAULTS = {
  speedRatio: 1,
  ggOrificeScale: 1,
  shutoff: 1.2,
  turbineR: A1.turbineR,
  scaleCombustorDrop: false,
};

/** Effective area of a square-law restriction from flow and drop [m^2]. */
const areaFor = (mdot: number, dropPsi: number, rho: number): number =>
  mdot / Math.sqrt(2 * rho * dropPsi * PSI);

/** Choked mass flow of the turbine orifice per unit effective area. */
function turbineFluxPerArea(R: number): number {
  return new Orifice(1, 1).massFlow(
    A1.turbineInletP,
    A1.turbineExhaustP,
    A1.turbineT,
    R,
    A1.turbineGamma,
  );
}

/** Turbine effective area giving 92 lb/s at the printed inlet state. */
export function turbineArea(R: number): number {
  return (92 * LB) / turbineFluxPerArea(R);
}

/** Pump curve (volumetric flow [m3/s], rise [Pa]) at a speed ratio. */
export function pumpCurve(
  qDesign: number,
  riseDesign: number,
  speedRatio: number,
  shutoff: number,
): Array<[number, number]> {
  const pts: Array<[number, number]> = [];
  for (let i = 0; i <= 44; i++) {
    const q = i * 0.05;
    const h = shutoff - (shutoff - 1) * q * q;
    pts.push([
      q * qDesign * speedRatio,
      Math.max(h, 0) * riseDesign * speedRatio * speedRatio,
    ]);
  }
  return pts;
}

/* ------------------------------------------------------------------ */
/* Network                                                             */
/* ------------------------------------------------------------------ */

interface Chain {
  prefix: string;
  from: string;
  /** Final node id (a boundary or the chamber). */
  to: string;
  fluid: string;
  rho: number;
  mdot: number;
  drops: Array<[string, number]>;
  areaScale: Record<string, number>;
  p0: number;
}

function chainElements(c: Chain): {
  nodes: NetworkConfig["nodes"];
  branches: NetworkConfig["branches"];
} {
  const nodes: NetworkConfig["nodes"] = [];
  const branches: NetworkConfig["branches"] = [];
  let p = c.p0;
  let prev = c.from;
  c.drops.forEach(([name, drop], i) => {
    const last = i === c.drops.length - 1;
    const id = `${c.prefix}_${name}`;
    p -= drop * PSI;
    const to = last ? c.to : `${c.prefix}_after_${name}`;
    if (!last) {
      nodes.push({
        id: to,
        type: "internal",
        x: 0,
        y: 0,
        pressure: p,
        temperature: c.fluid === "lox" ? 90.17 : 300,
        fluid: c.fluid,
        label: `${c.prefix} after ${name}`,
      });
    }
    branches.push({
      id,
      from: prev,
      to,
      initialMdot: c.mdot,
      component: {
        type: "orifice",
        area: areaFor(c.mdot, drop, c.rho) * (c.areaScale[name] ?? 1),
        cd: 1,
      },
      label: `${c.prefix} ${name}`,
    });
    prev = to;
  });
  return { nodes, branches };
}

/**
 * Build the engine network at a gas generator injector end pressure
 * `pGg` [Pa].  The gas generator end nodes and the turbine inlet are
 * boundary nodes at the values the inner loop sets.
 */
export function buildA1Network(
  pGg: number,
  options: A1Options = {},
  ggFlowForDrop?: number,
): NetworkConfig {
  const o = { ...DEFAULTS, ...options };
  const R = o.turbineR;
  const qLox = A1.loxPumpMdot / A1.rhoLox;
  const qFuel = A1.fuelPumpMdot / A1.rhoRp1;
  const riseLox = A1.loxDischargeP - A1.loxInletP;
  const riseFuel = A1.fuelDischargeP - A1.fuelInletP;

  const drop =
    o.scaleCombustorDrop && ggFlowForDrop !== undefined
      ? A1.combustorDropP * Math.pow(ggFlowForDrop / (92 * LB), 2)
      : A1.combustorDropP;

  const nodes: NetworkConfig["nodes"] = [
    {
      id: "loxTank",
      type: "boundary",
      x: 0,
      y: 0,
      pressure: A1.loxInletP,
      temperature: 90.17,
      fluid: "lox",
      label: "LOX tank (pump inlet)",
    },
    {
      id: "loxPumpOut",
      type: "internal",
      x: 0,
      y: 0,
      pressure: A1.loxDischargeP,
      temperature: 90.17,
      fluid: "lox",
      label: "LOX pump discharge",
    },
    {
      id: "loxHx",
      type: "boundary",
      x: 0,
      y: 0,
      pressure: 1e6,
      temperature: 90.17,
      fluid: "lox",
      label: "Heat exchanger sink",
    },
    {
      id: "fuelTank",
      type: "boundary",
      x: 0,
      y: 0,
      pressure: A1.fuelInletP,
      temperature: 300,
      fluid: "rp1",
      label: "RP-1 tank (pump inlet)",
    },
    {
      id: "fuelPumpOut",
      type: "internal",
      x: 0,
      y: 0,
      pressure: A1.fuelDischargeP,
      temperature: 300,
      fluid: "rp1",
      label: "Fuel pump discharge",
    },
    {
      id: "chamber",
      type: "internal",
      x: 0,
      y: 0,
      pressure: A1.injectorEndP,
      temperature: 3000,
      fluid: "gas",
      label: "Chamber (reacting junction, injector end)",
    },
    {
      id: "exhaust",
      type: "boundary",
      x: 0,
      y: 0,
      pressure: 101325,
      temperature: 1500,
      fluid: "gas",
      label: "Exhaust",
    },
    {
      id: "ggLoxEnd",
      type: "boundary",
      x: 0,
      y: 0,
      pressure: pGg,
      temperature: 90.17,
      fluid: "lox",
      label: "Gas generator injector end (LOX side)",
    },
    {
      id: "ggFuelEnd",
      type: "boundary",
      x: 0,
      y: 0,
      pressure: pGg,
      temperature: 300,
      fluid: "rp1",
      label: "Gas generator injector end (fuel side)",
    },
    {
      id: "turbIn",
      type: "boundary",
      x: 0,
      y: 0,
      pressure: pGg - drop,
      temperature: A1.turbineT,
      fluid: "ggGas",
      label: "Turbine inlet",
    },
    {
      id: "turbOut",
      type: "boundary",
      x: 0,
      y: 0,
      pressure: A1.turbineExhaustP,
      temperature: 900,
      fluid: "ggGas",
      label: "Turbine exhaust",
    },
  ];
  const branches: NetworkConfig["branches"] = [
    {
      id: "loxPump",
      from: "loxTank",
      to: "loxPumpOut",
      initialMdot: A1.loxPumpMdot,
      component: {
        type: "pump",
        curve: pumpCurve(qLox, riseLox, o.speedRatio, o.shutoff),
      },
      label: "LOX pump",
    },
    {
      id: "fuelPump",
      from: "fuelTank",
      to: "fuelPumpOut",
      initialMdot: A1.fuelPumpMdot,
      component: {
        type: "pump",
        curve: pumpCurve(qFuel, riseFuel, o.speedRatio, o.shutoff),
      },
      label: "Fuel pump",
    },
    {
      id: "loxHxFlow",
      from: "loxPumpOut",
      to: "loxHx",
      component: { type: "flowSource", massFlow: A1.hxMdot },
      label: "Heat exchanger LOX flow",
    },
    {
      id: "throat",
      from: "chamber",
      to: "exhaust",
      initialMdot: A1.mdotOx + A1.mdotFuel,
      component: {
        type: "orifice",
        area: A1.throatArea,
        cd: A1.nozzleStagP / A1.injectorEndP,
      },
      label: "Choked throat",
    },
    {
      id: "turbine",
      from: "turbIn",
      to: "turbOut",
      initialMdot: 92 * LB,
      component: { type: "orifice", area: turbineArea(R), cd: 1 },
      label: "Turbine nozzles (choked)",
    },
  ];

  const chains: Chain[] = [
    {
      prefix: "lox",
      from: "loxPumpOut",
      to: "chamber",
      fluid: "lox",
      rho: A1.rhoLox,
      mdot: A1.mdotOx,
      drops: A1.dropsLox,
      areaScale: {},
      p0: A1.loxDischargeP,
    },
    {
      prefix: "fuel",
      from: "fuelPumpOut",
      to: "chamber",
      fluid: "rp1",
      rho: A1.rhoRp1,
      mdot: A1.mdotFuel,
      drops: A1.dropsFuel,
      areaScale: {},
      p0: A1.fuelDischargeP,
    },
    {
      prefix: "ggLox",
      from: "loxPumpOut",
      to: "ggLoxEnd",
      fluid: "lox",
      rho: A1.rhoLox,
      mdot: A1.ggMdotOx,
      drops: A1.dropsGgLox,
      areaScale: { control: o.ggOrificeScale },
      p0: A1.loxDischargeP,
    },
    {
      prefix: "ggFuel",
      from: "fuelPumpOut",
      to: "ggFuelEnd",
      fluid: "rp1",
      rho: A1.rhoRp1,
      mdot: A1.ggMdotFuel,
      drops: A1.dropsGgFuel,
      areaScale: { control: o.ggOrificeScale },
      p0: A1.fuelDischargeP,
    },
  ];
  for (const c of chains) {
    const e = chainElements(c);
    nodes.push(...e.nodes);
    branches.push(...e.branches);
  }

  return {
    meta: { name: "SP-125 A-1 stage engine balance", version: 2 },
    settings: {
      mode: "steady",
      tolerance: 1e-8,
      maxIterations: 800,
      relaxation: 0.6,
      kineticEnergy: true,
    },
    fluid: {
      model: "idealGas",
      params: { R: 363.633, gamma: 1.126691, mu: 0.00010611, cp: 3235.32 },
    },
    fluids: {
      gas: {
        model: "idealGas",
        params: { R: 363.633, gamma: 1.126691, mu: 0.00010611, cp: 3235.32 },
      },
      ggGas: {
        model: "idealGas",
        params: {
          R,
          gamma: A1.turbineGamma,
          mu: 4e-5,
          cp: A1.turbineCp,
        },
      },
      lox: {
        model: "incompressible",
        params: { rho: A1.rhoLox, mu: 0.000195, cp: 1700 },
      },
      rp1: {
        model: "incompressible",
        params: { rho: A1.rhoRp1, mu: 0.0017, cp: 2000 },
      },
    },
    junctions: [
      {
        id: "mainCombustor",
        label: "LOX/RP-1 main chamber",
        node: "chamber",
        inlets: [
          { branch: "lox_injector", role: "oxidizer" },
          { branch: "fuel_injector", role: "fuel" },
        ],
        model: {
          type: "ceaTable",
          propellants: "lox-rp1",
          efficiency: A1.cstarEff * A1.cstarEff,
        },
        productFluid: "gas",
      },
    ],
    nodes,
    branches,
  };
}

/* ------------------------------------------------------------------ */
/* Solves                                                              */
/* ------------------------------------------------------------------ */

export type SteadyResult = ReturnType<typeof solveSteady>;

export interface A1Point {
  result: SteadyResult;
  pGg: number;
  speedRatio: number;
  innerSolves: number;
  innerResidual: number;
}

function runOnce(
  pGg: number,
  o: A1Options,
  ggFlow?: number,
): { res: SteadyResult; f: number } {
  const config = buildA1Network(pGg, o, ggFlow);
  const res = solveSteady(config);
  if (!res.converged) {
    throw new Error(`A-1 network did not converge at pGg = ${pGg / PSI} psia`);
  }
  const ggIn =
    res.branches.ggLox_injector.mdot + res.branches.ggFuel_injector.mdot;
  const turb = res.branches.turbine.mdot;
  return { res, f: ggIn - turb };
}

/**
 * Network solve with the inner loop closed, so the liquid flow into the gas
 * generator equals the turbine flow (secant on the injector end pressure).
 */
export function solveA1(options: A1Options = {}): A1Point {
  const o = { ...DEFAULTS, ...options };
  let solves = 0;
  const g = (p: number, flow?: number) => {
    solves++;
    return runOnce(p, o, flow);
  };
  let p0 = A1.ggInjectorEndP;
  let a = g(p0);
  let flow = a.res.branches.turbine.mdot;
  if (o.scaleCombustorDrop) a = g(p0, flow);
  let p1 = p0 * (1 + 0.02 * Math.sign(a.f || 1));
  let b = g(p1, o.scaleCombustorDrop ? flow : undefined);
  let best = Math.abs(a.f) < Math.abs(b.f) ? { p: p0, r: a } : { p: p1, r: b };
  for (let it = 0; it < 30; it++) {
    const tol = 1e-9 * 92 * LB;
    if (Math.abs(b.f) < tol) {
      best = { p: p1, r: b };
      break;
    }
    const slope = (b.f - a.f) / (p1 - p0);
    if (!Number.isFinite(slope) || slope === 0) break;
    const p2 = p1 - b.f / slope;
    p0 = p1;
    a = b;
    p1 = p2;
    flow = b.res.branches.turbine.mdot;
    b = g(p1, o.scaleCombustorDrop ? flow : undefined);
    best = { p: p1, r: b };
  }
  return {
    result: best.r.res,
    pGg: best.p,
    speedRatio: o.speedRatio,
    innerSolves: solves,
    innerResidual: best.r.f,
  };
}

/* ------------------------------------------------------------------ */
/* Post-processing                                                     */
/* ------------------------------------------------------------------ */

export interface A1Metrics {
  mdotOx: number;
  mdotFuel: number;
  of: number;
  ggOx: number;
  ggFuel: number;
  ggOf: number;
  turbineMdot: number;
  loxPumpMdot: number;
  fuelPumpMdot: number;
  /** Station pressures [psia]. */
  lox: Record<string, number>;
  fuel: Record<string, number>;
  ggInjectorEnd: number;
  turbineInlet: number;
  turbinePr: number;
  injectorEnd: number;
  pc: number;
  cstar: number;
  loxHead: number;
  fuelHead: number;
  loxHp: number;
  fuelHp: number;
  auxHp: number;
  turbineHp: number;
  residualHp: number;
  residualFraction: number;
  torque: number;
  rpm: number;
  oxStar: { cstarCea: number; gamma: number; T0: number };
}

/** Turbine shaft power [hp] by equations 6-18 and 6-19. */
export function turbinePowerHp(
  mdot: number,
  pr: number,
  gamma = A1.turbineGamma,
): number {
  const dh =
    A1.turbineCp * A1.turbineT * (1 - Math.pow(1 / pr, (gamma - 1) / gamma));
  return (A1.etaTurbine * mdot * dh) / HP;
}

export function a1Metrics(pt: A1Point): A1Metrics {
  const { result: r, speedRatio } = pt;
  const B = r.branches;
  const N = r.nodes;
  const psia = (id: string): number => N[id].pressure / PSI;
  const ox = B.lox_injector.mdot;
  const fu = B.fuel_injector.mdot;
  const total = ox + fu;
  const jn = r.junctions!.mainCombustor;
  const pcPa = N.chamber.pressure / (A1.injectorEndP / A1.nozzleStagP);
  const cstar = (pcPa * A1.throatArea) / total / FT;
  const loxRise = N.loxPumpOut.pressure - N.loxTank.pressure;
  const fuelRise = N.fuelPumpOut.pressure - N.fuelTank.pressure;
  const loxMdot = B.loxPump.mdot;
  const fuelMdot = B.fuelPump.mdot;
  const loxHp = ((loxMdot / A1.rhoLox) * loxRise) / A1.etaLoxPump / HP;
  const fuelHp = ((fuelMdot / A1.rhoRp1) * fuelRise) / A1.etaFuelPump / HP;
  const turbMdot = B.turbine.mdot;
  const pr = N.turbIn.pressure / N.turbOut.pressure;
  const turbHp = turbinePowerHp(turbMdot, pr);
  const resid = turbHp - loxHp - fuelHp - A1.auxHp;
  const rpm = BOOK.rpm * speedRatio;
  return {
    mdotOx: ox / LB,
    mdotFuel: fu / LB,
    of: ox / fu,
    ggOx: B.ggLox_injector.mdot / LB,
    ggFuel: B.ggFuel_injector.mdot / LB,
    ggOf: B.ggLox_injector.mdot / B.ggFuel_injector.mdot,
    turbineMdot: turbMdot / LB,
    loxPumpMdot: loxMdot / LB,
    fuelPumpMdot: fuelMdot / LB,
    lox: {
      pump: psia("loxPumpOut"),
      line: psia("lox_after_line"),
      valve: psia("lox_after_valve"),
      dome: psia("lox_after_dome"),
      injector: psia("chamber"),
    },
    fuel: {
      pump: psia("fuelPumpOut"),
      line: psia("fuel_after_line"),
      valve: psia("fuel_after_valve"),
      calibration: psia("fuel_after_calibration"),
      jacket: psia("fuel_after_jacket"),
      injector: psia("chamber"),
    },
    ggInjectorEnd: pt.pGg / PSI,
    turbineInlet: N.turbIn.pressure / PSI,
    turbinePr: pr,
    injectorEnd: psia("chamber"),
    pc: pcPa / PSI,
    cstar,
    loxHead: loxRise / (A1.rhoLox * G0) / FT,
    fuelHead: fuelRise / (A1.rhoRp1 * G0) / FT,
    loxHp,
    fuelHp,
    auxHp: A1.auxHp,
    turbineHp: turbHp,
    residualHp: resid,
    residualFraction: resid / turbHp,
    torque: (turbHp * 550) / ((2 * Math.PI * rpm) / 60),
    rpm,
    oxStar: {
      cstarCea: jn.gas.cstar ?? NaN,
      gamma: jn.gas.gamma,
      T0: jn.gas.T0,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Outer balance                                                       */
/* ------------------------------------------------------------------ */

export type FreeParameter = "speed" | "ggOrificeScale";

export interface A1Balance {
  parameter: FreeParameter;
  value: number;
  iterations: number;
  history: Array<{ x: number; residualHp: number }>;
  point: A1Point;
  metrics: A1Metrics;
  solves: number;
}

/**
 * Close the power balance by a secant iteration on one free parameter.
 * Tolerance is a residual below 1e-6 of the turbine power.
 */
export function balanceA1(
  parameter: FreeParameter,
  options: A1Options = {},
): A1Balance {
  const at = (x: number) => {
    const o: A1Options =
      parameter === "speed"
        ? { ...options, speedRatio: x }
        : { ...options, ggOrificeScale: x };
    const pt = solveA1(o);
    return { pt, m: a1Metrics(pt) };
  };
  const history: Array<{ x: number; residualHp: number }> = [];
  let solves = 0;
  let x0 = 1;
  let e0 = at(x0);
  solves += e0.pt.innerSolves;
  history.push({ x: x0, residualHp: e0.m.residualHp });
  let x1 = x0 * 1.02;
  let e1 = at(x1);
  solves += e1.pt.innerSolves;
  history.push({ x: x1, residualHp: e1.m.residualHp });
  for (let it = 0; it < 30; it++) {
    if (Math.abs(e1.m.residualFraction) < 1e-6) break;
    const slope = (e1.m.residualHp - e0.m.residualHp) / (x1 - x0);
    if (!Number.isFinite(slope) || slope === 0) break;
    const x2 = x1 - e1.m.residualHp / slope;
    x0 = x1;
    e0 = e1;
    x1 = x2;
    e1 = at(x1);
    solves += e1.pt.innerSolves;
    history.push({ x: x1, residualHp: e1.m.residualHp });
  }
  return {
    parameter,
    value: x1,
    iterations: history.length,
    history,
    point: e1.pt,
    metrics: e1.m,
    solves,
  };
}

export { validateNetwork };
