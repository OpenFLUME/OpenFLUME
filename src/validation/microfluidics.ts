/**
 * Published microfluidic network cases, rebuilt in OpenFLUME.
 *
 * Each case returns the solver's numbers, the published numbers (with where
 * in the paper they are stated) and, where one exists, an independent
 * reference computed here.  The scientific test suite
 * (src/validation/__tests__/microfluidics.test.ts) gates on these and the
 * report (scripts/microfluidics-validation-report.ts →
 * docs/validation/microfluidics-report.md) renders them — one definition of
 * every network, so the CI gate and the report can never drift apart.
 *
 * Only parameters stated in the papers' open-access full text are used; the
 * few modelling assumptions are named in each case.
 */
import { solveSteady, solveTransient, validateNetwork } from "../core";
import type { NetworkConfig, SteadyResult, TransientResult } from "../core";
import {
  rectCapillaryPressure,
  rectLaminarResistance,
} from "../core/components";

const P0 = 101325;
const RHO = 998; // water preset
const MU = 1e-3; // water preset
const UL_MIN = 1e-9 / 60; // 1 µL/min in m³/s

type Comp = NetworkConfig["branches"][number]["component"];

interface NodeSpec {
  id: string;
  internal?: boolean;
  p?: number;
  extra?: Record<string, unknown>;
}

function node(n: NodeSpec): NetworkConfig["nodes"][number] {
  return {
    id: n.id,
    type: n.internal ? "internal" : "boundary",
    x: 0,
    y: 0,
    pressure: n.p ?? P0,
    temperature: 293,
    ...(n.internal ? { volume: 1e-12 } : {}),
    ...(n.extra ?? {}),
  } as NetworkConfig["nodes"][number];
}

const rect = (w: number, h: number, L: number): Comp => ({
  type: "rectChannel",
  width: w,
  height: h,
  length: L,
});

interface BranchSpec {
  id: string;
  from: string;
  to: string;
  c: Comp;
  /** Initial ṁ [kg/s]: the true operating point for transients. */
  m0?: number;
}

function network(
  name: string,
  nodes: NodeSpec[],
  branches: BranchSpec[],
  extra: Partial<NetworkConfig> = {},
): NetworkConfig {
  return {
    meta: { name, version: 2 },
    settings: { mode: "steady", tolerance: 1e-9, maxIterations: 200 },
    fluid: { model: "incompressible", preset: "water" },
    nodes: nodes.map(node),
    branches: branches.map((b) => ({
      id: b.id,
      from: b.from,
      to: b.to,
      component: b.c,
      ...(b.m0 !== undefined ? { initialMdot: b.m0 } : {}),
    })),
    ...extra,
  };
}

function steady(cfg: NetworkConfig): SteadyResult {
  const errors = validateNetwork(cfg);
  if (errors.length) throw new Error(`${cfg.meta.name}: ${errors.join("; ")}`);
  const r = solveSteady(cfg);
  if (!r.converged) throw new Error(`${cfg.meta.name}: did not converge`);
  return r;
}

function transient(cfg: NetworkConfig): TransientResult {
  const errors = validateNetwork(cfg);
  if (errors.length) throw new Error(`${cfg.meta.name}: ${errors.join("; ")}`);
  const r = solveTransient(cfg);
  if (!r.converged) throw new Error(`${cfg.meta.name}: did not converge`);
  return r;
}

const q = (r: SteadyResult, id: string, rho = RHO) => r.branches[id].mdot / rho;

/* ------------------------------------------------------------------ */
/* 1. Vasilakis et al. 2019 — serial-dilution unit cell                */
/* ------------------------------------------------------------------ */

export const VASILAKIS_2019 = {
  citation:
    "Vasilakis, N., Papadimitriou, K. I., Morgan, H., Prodromakis, T. (2019). Modular pressure and flow rate-balanced microfluidic serial dilution networks for miniaturised point-of-care diagnostic platforms. Sensors 19(4):911",
  doi: "10.3390/s19040911",
  /** Channel height (photoresist thickness), Methods. */
  height: 64e-6,
  /** Inlet flow per inlet, Fig. 1 caption. */
  inletFlow: 0.4 * UL_MIN,
  /** Fabricated widths / lengths, Table 1 ("COMSOL optimisation"). */
  channels: [
    { id: "c12", from: "A", to: "n2", w: 300e-6, L: 3.7e-3 },
    { id: "c43", from: "B", to: "n3", w: 263e-6, L: 5.4e-3 },
    { id: "c23", from: "n2", to: "n3", w: 160e-6, L: 2.5e-3 },
    { id: "c26", from: "n2", to: "D", w: 170e-6, L: 67.5e-3 },
    { id: "c35", from: "n3", to: "C", w: 380e-6, L: 57.9e-3 },
  ],
  published: {
    /** COMSOL inlet pressure at 0.4 µL/min, both inlets (§3.1.2). */
    inletPressureCOMSOL: 85.2,
    /** Design dilution ratio DR = 2:3. */
    ratioDesign: 2 / 3,
    /** Measured 1st-stage DR of the PCB two-stage device (§3.2, Fig. 8c):
     *  0.65 ± 0.02 at 0.2 µL/min and 0.70 ± 0.01 at 0.4 µL/min, judged
     *  against the glucose meter's ±10 % accuracy. */
    ratioMeasured: [
      { flow: 0.2, mean: 0.65, sd: 0.02 },
      { flow: 0.4, mean: 0.7, sd: 0.01 },
    ],
  },
};

export function vasilakis2019() {
  const c = VASILAKIS_2019;
  const qm = c.inletFlow * RHO;
  const cfg = network(
    "Vasilakis 2019 dilution cell",
    [
      { id: "srcA" },
      { id: "srcB" },
      { id: "A", internal: true },
      { id: "B", internal: true },
      { id: "n2", internal: true },
      { id: "n3", internal: true },
      { id: "C" },
      { id: "D" },
    ],
    [
      {
        id: "pumpA",
        from: "srcA",
        to: "A",
        c: { type: "flowSource", massFlow: qm },
      },
      {
        id: "pumpB",
        from: "srcB",
        to: "B",
        c: { type: "flowSource", massFlow: qm },
      },
      ...c.channels.map((ch) => ({
        id: ch.id,
        from: ch.from,
        to: ch.to,
        c: rect(ch.w, c.height, ch.L),
      })),
    ],
  );
  const r = steady(cfg);
  const qB = q(r, "c43");
  const q23 = q(r, "c23");
  return {
    config: cfg,
    inletPressureA: r.nodes.A.pressure - P0,
    inletPressureB: r.nodes.B.pressure - P0,
    /** Fraction of the mixed stream that is diluent B. */
    ratio: qB / (qB + q23),
  };
}

/* ------------------------------------------------------------------ */
/* 2. Tan & Takeuchi 2007 — hydrodynamic trap                          */
/* ------------------------------------------------------------------ */

export const TAN_TAKEUCHI_2007 = {
  citation:
    "Tan, W.-H., Takeuchi, S. (2007). A trap-and-release integrated microfluidic system for dynamic microarray applications. PNAS 104(4):1146–1151",
  doi: "10.1073/pnas.0606625104",
  /** Table 1. Path 1 = trap constriction, path 2 = loop. Lengths in µm. */
  devices: [
    {
      id: "A",
      W1: 6,
      L1: 5.5,
      W2: 25,
      L2: 163,
      H: 28,
      ratioPaper: 0.76,
      trapped: false,
    },
    {
      id: "B",
      W1: 7.5,
      L1: 4.5,
      W2: 20,
      L2: 172.5,
      H: 18,
      ratioPaper: 3.95,
      trapped: true,
    },
  ],
};

export function tanTakeuchi2007() {
  return TAN_TAKEUCHI_2007.devices.map((d) => {
    const um = 1e-6;
    const r = steady(
      network(
        `Tan & Takeuchi device ${d.id}`,
        [{ id: "in", p: P0 + 100 }, { id: "out" }],
        [
          {
            id: "trap",
            from: "in",
            to: "out",
            c: rect(d.W1 * um, d.H * um, d.L1 * um),
          },
          {
            id: "loop",
            from: "in",
            to: "out",
            c: rect(d.W2 * um, d.H * um, d.L2 * um),
          },
        ],
      ),
    );
    const ratio = q(r, "trap") / q(r, "loop");
    return { ...d, ratio, predictsTrapping: ratio > 1 };
  });
}

/* ------------------------------------------------------------------ */
/* 3. Guermonprez, Michelin & Baroud 2015 — ladder manifold            */
/* ------------------------------------------------------------------ */

export const GUERMONPREZ_2015 = {
  citation:
    "Guermonprez, C., Michelin, S., Baroud, C. N. (2015). Flow distribution in parallel microfluidic networks and its effect on concentration gradient. Biomicrofluidics 9(5):054119",
  doi: "10.1063/1.4932305",
  /** Branch count of the Fig. 4(a) simulations (x-axis 1–20); inlet top-left,
   *  outlet bottom-right (Z layout, Fig. 1(a) caption). */
  branches: 20,
  /** R/R_b and the paper's statement for each (§IV A). */
  cases: [
    { ratio: 0.43, endShare: 0.85 },
    { ratio: 0.043, endShare: 0.46 },
    { ratio: 0.0043, maxSpread: 0.02 },
  ] as Array<{ ratio: number; endShare?: number; maxSpread?: number }>,
};

/** Ladder of N identical rungs (resistance R_b) between a distribution and
 *  a collection channel (resistance R per segment); inlet at the first
 *  distribution node, outlet after the last collection node.  Returns
 *  branch-flow fractions from OpenFLUME and from an independent linear
 *  nodal solve. */
export function guermonprezLadder(n: number, ratio: number) {
  const w = 50e-6;
  const h = 50e-6;
  const Lb = 10e-3;
  const Lr = ratio * Lb;
  const nodes: NodeSpec[] = [{ id: "in", p: P0 + 1000 }, { id: "out" }];
  const br: BranchSpec[] = [];
  for (let i = 0; i < n; i++)
    nodes.push(
      { id: `d${i}`, internal: true },
      { id: `c${i}`, internal: true },
    );
  br.push({ id: "feed", from: "in", to: "d0", c: rect(w, h, Lr) });
  br.push({ id: "drain", from: `c${n - 1}`, to: "out", c: rect(w, h, Lr) });
  for (let i = 0; i < n; i++)
    br.push({ id: `b${i}`, from: `d${i}`, to: `c${i}`, c: rect(w, h, Lb) });
  for (let i = 0; i < n - 1; i++) {
    br.push({
      id: `dd${i}`,
      from: `d${i}`,
      to: `d${i + 1}`,
      c: rect(w, h, Lr),
    });
    br.push({
      id: `cc${i}`,
      from: `c${i}`,
      to: `c${i + 1}`,
      c: rect(w, h, Lr),
    });
  }
  const r = steady(network(`Ladder N=${n} R/Rb=${ratio}`, nodes, br));
  const flows = Array.from({ length: n }, (_, i) => q(r, `b${i}`));
  const total = flows.reduce((a, b) => a + b, 0);
  const fractions = flows.map((f) => f / total);

  // Independent reference: dense nodal conductance solve (unit R_b).
  const ids = [...Array(n).keys()].flatMap((i) => [`d${i}`, `c${i}`]);
  const idx = new Map(ids.map((id, k) => [id, k]));
  const m = ids.length;
  const A = Array.from({ length: m }, () => new Array<number>(m).fill(0));
  const b = new Array<number>(m).fill(0);
  const fixed: Record<string, number> = { in: 1, out: 0 };
  const stamp = (u: string, v: string, g: number) => {
    for (const [a, c] of [
      [u, v],
      [v, u],
    ]) {
      const ia = idx.get(a);
      if (ia === undefined) continue;
      A[ia][ia] += g;
      const ic = idx.get(c);
      if (ic !== undefined) A[ia][ic] -= g;
      else b[ia] += g * fixed[c];
    }
  };
  for (const e of br) stamp(e.from, e.to, e.id.startsWith("b") ? 1 : 1 / ratio);
  const x = gauss(A, b);
  const refFlows = Array.from({ length: n }, (_, i) => x[2 * i] - x[2 * i + 1]);
  const refTotal = refFlows.reduce((a, c) => a + c, 0);
  const reference = refFlows.map((f) => f / refTotal);
  return {
    fractions,
    reference,
    endShare: fractions[0] + fractions[1] + fractions[n - 2] + fractions[n - 1],
    spread: Math.max(...fractions) - Math.min(...fractions),
  };
}

/* ------------------------------------------------------------------ */
/* 4. Reis et al. 2021 — gravity-driven microcapillary siphon           */
/* ------------------------------------------------------------------ */

export const REIS_2021 = {
  citation:
    "Reis, N. M. et al. (2021). Gravity-driven microfluidic siphons: fluidic characterization and application to quantitative immunoassays. ACS Sensors 6(12):4338–4348",
  doi: "10.1021/acssensors.1c01524",
  bores: 10,
  /** Mean hydraulic diameter ± SD (Experimental). */
  diameter: 204e-6,
  diameterSd: 13.8e-6,
  rho: 998.2,
  mu: 0.001002,
  /** Measured 3.63 ± 0.07 µL/s at H/L = 0.69 (text). */
  measured: { hOverL: 0.69, flow: 3.63e-9, sd: 0.07e-9 },
  /** "≈2.5 µL/s" for the Fig. 2 devices, H = 40 mm, L = 70 mm (text). */
  fig2: { H: 0.04, L: 0.07, flow: 2.5e-9 },
};

export function reis2021Flow(hOverL: number, diameter = REIS_2021.diameter) {
  const c = REIS_2021;
  const L = 0.07;
  const H = hOverL * L;
  const br = Array.from({ length: c.bores }, (_, i) => ({
    id: `bore${i}`,
    from: "top",
    to: "bottom",
    c: {
      type: "pipe",
      length: L,
      diameter,
      roughness: 0,
      elevationChange: -H,
    } as Comp,
  }));
  const r = steady(
    network("Reis 2021 siphon", [{ id: "top" }, { id: "bottom" }], br, {
      fluid: {
        model: "incompressible",
        params: { rho: c.rho, mu: c.mu, cp: 4182 },
      },
    }),
  );
  const solved = br.reduce((s, b) => s + q(r, b.id, c.rho), 0);
  const hagenPoiseuille =
    (c.bores * Math.PI * diameter ** 4 * c.rho * 9.80665 * H) /
    (128 * c.mu * L);
  return { solved, hagenPoiseuille };
}

/* ------------------------------------------------------------------ */
/* 5. Olanrewaju et al. 2016 — capillaric circuit valve pressures       */
/* ------------------------------------------------------------------ */

export const OLANREWAJU_2016 = {
  citation:
    "Olanrewaju, A. O., Robillard, A., Dagher, M., Juncker, D. (2016). Autonomous microfluidic capillaric circuits replicated from 3D-printed molds. Lab Chip 16:3804–3814",
  doi: "10.1039/c6lc00764c",
  /** Printed "72 N m⁻¹" [sic]; 72 mN/m. */
  surfaceTension: 0.072,
  /** Receding angles, walls and floor 31°.  The cover angle is stated as 95°
   *  for the RBV calculation (RBV section) and 89° in the Conclusions;
   *  Table 1 is reproduced by 89° (see the report). */
  receding: { cover: 89, coverRbvText: 95, walls: 31 },
  /** Advancing angles: cover 114°, walls and floor 45° (Conclusions). */
  advancing: { cover: 114, walls: 45 },
  /** Table 1 retention burst valves: width, height [µm], P_i [Pa]. */
  rbv: [
    { w: 960, h: 1000, p: -194 },
    { w: 670, h: 750, p: -271 },
    { w: 480, h: 650, p: -358 },
    { w: 380, h: 550, p: -441 },
  ],
  /** Capillary pump channels 200 × 100 µm², quoted −736 Pa. */
  pump: { w: 200, h: 100, p: -736 },
};

export function olanrewaju2016() {
  const c = OLANREWAJU_2016;
  const um = 1e-6;
  const meniscus = (w: number, h: number, cover: number, walls: number) =>
    -rectCapillaryPressure(
      w * um,
      h * um,
      c.surfaceTension,
      cover,
      walls,
      walls,
    );
  return {
    rbv: c.rbv.map((v) => ({
      ...v,
      solved: meniscus(v.w, v.h, c.receding.cover, c.receding.walls),
      solvedRbvTextAngle: meniscus(
        v.w,
        v.h,
        c.receding.coverRbvText,
        c.receding.walls,
      ),
    })),
    pump: {
      ...c.pump,
      solved: meniscus(
        c.pump.w,
        c.pump.h,
        c.advancing.cover,
        c.advancing.walls,
      ),
    },
  };
}

/* ------------------------------------------------------------------ */
/* 6. Lee, Rahman, Laoui & Karnik 2012 — bubble-damped syringe network  */
/* ------------------------------------------------------------------ */

export const LEE_2012 = {
  citation:
    "Lee, J., Rahman, F., Laoui, T., Karnik, R. (2012). Bubble-induced damping in displacement-driven microfluidic flows. Phys. Rev. E 86:026301",
  doi: "10.1103/PhysRevE.86.026301",
  /** Channel resistances [psi·min/µL], Sec. II. */
  resistancePsiMinPerUl: { R1: 0.14, R2: 0.2, R3: 0.25 },
  /** Bubble volumes at 1 atm [µL], in 50 µL gastight syringes. */
  bubbles: [2, 5, 10],
  syringeVolume: 50e-9,
  /** Q_s1 = 1 µL/min; Q_s2 steps 1 → 2.5 µL/min (Sec. IV). */
  q1: 1 * UL_MIN,
  q2Before: 1 * UL_MIN,
  q2After: 2.5 * UL_MIN,
};

const PSI_MIN_PER_UL = (6894.757 * 60) / 1e-9; // → Pa·s/m³

/**
 * Step response of the bubble-damped Y-junction.  Returns the solved flow
 * in branch R1 and the same quantity from an independent RK4 integration of
 * the network's exact ODE (isothermal bubbles P·V = const, laminar
 * resistors), sampled at the solver's own times; time is also given scaled
 * by the paper's t0 = V0·R3/P0.
 */
export function lee2012(bubbleUl: number, tolerance = 1e-9, stepsPerT0 = 200) {
  const c = LEE_2012;
  const R1 = c.resistancePsiMinPerUl.R1 * PSI_MIN_PER_UL;
  const R2 = c.resistancePsiMinPerUl.R2 * PSI_MIN_PER_UL;
  const R3 = c.resistancePsiMinPerUl.R3 * PSI_MIN_PER_UL;
  const V0 = bubbleUl * 1e-9;
  const t0 = (V0 * R3) / P0;
  const dt = t0 / stepsPerT0;
  const tStep = 40 * dt; // on a step boundary: backward Euler sees it exactly
  const tEnd = tStep + 8 * t0;
  const perM = rectLaminarResistance(200e-6, 20e-6, 1, MU);
  const res = (R: number): Comp => rect(200e-6, 20e-6, R / perM);
  // Initial state: the steady operating point before the step.
  const pJ = P0 + R3 * (c.q1 + c.q2Before);
  const pa = pJ + R1 * c.q1;
  const pb = pJ + R2 * c.q2Before;
  const cushion = (p: number) => ({
    pressure: p,
    volume: c.syringeVolume,
    gasCushion: { initialGasVolume: V0, polytropicIndex: 1 },
  });
  const cfg = network(
    `Lee 2012 bubble ${bubbleUl} µL`,
    [
      { id: "s1" },
      { id: "s2" },
      { id: "a", internal: true, extra: cushion(pa) },
      { id: "b", internal: true, extra: cushion(pb) },
      { id: "J", internal: true, p: pJ },
      { id: "out" },
    ],
    [
      {
        id: "pump1",
        from: "s1",
        to: "a",
        c: { type: "flowSource", massFlow: c.q1 * RHO },
        m0: c.q1 * RHO,
      },
      {
        id: "pump2",
        from: "s2",
        to: "b",
        c: {
          type: "flowSource",
          massFlow: c.q2Before * RHO,
          massFlowSchedule: [
            [0, c.q2Before * RHO],
            [tStep, c.q2Before * RHO],
            [tStep + dt * 1e-6, c.q2After * RHO],
          ],
        },
        m0: c.q2Before * RHO,
      },
      { id: "R1", from: "a", to: "J", c: res(R1), m0: c.q1 * RHO },
      { id: "R2", from: "b", to: "J", c: res(R2), m0: c.q2Before * RHO },
      {
        id: "R3",
        from: "J",
        to: "out",
        c: res(R3),
        m0: (c.q1 + c.q2Before) * RHO,
      },
    ],
    {
      settings: {
        mode: "transient",
        tolerance,
        maxIterations: 200,
        dt,
        endTime: tEnd,
      },
    },
  );
  const r = transient(cfg);

  // Exact ODE of the same network, gauge pressures p = P − P0.
  const Ka = pa * V0;
  const Kb = pb * V0;
  const g = 1 / R1 + 1 / R2 + 1 / R3;
  const rhs = (p: number[], qs2: number): number[] => {
    const pj = (p[0] / R1 + p[1] / R2) / g;
    const A0 = p[0] + P0;
    const B0 = p[1] + P0;
    return [
      ((A0 * A0) / Ka) * (c.q1 - (p[0] - pj) / R1),
      ((B0 * B0) / Kb) * (qs2 - (p[1] - pj) / R2),
    ];
  };
  const q1Of = (p: number[]) => (p[0] - (p[0] / R1 + p[1] / R2) / g) / R1;
  let p = [pa - P0, pb - P0];
  let t = 0;
  const reference: number[] = [q1Of(p)];
  for (let i = 1; i < r.times.length; i++) {
    const sub = 20;
    const h = (r.times[i] - t) / sub;
    // The step's whole interval sees the flow in force at its END (the
    // backward-Euler convention for schedules), which for a step at a step
    // boundary is the physical flow over that interval.
    const qs2 = r.times[i] > tStep + 1e-12 ? c.q2After : c.q2Before;
    for (let k = 0; k < sub; k++) {
      const k1 = rhs(p, qs2);
      const k2 = rhs([p[0] + (h / 2) * k1[0], p[1] + (h / 2) * k1[1]], qs2);
      const k3 = rhs([p[0] + (h / 2) * k2[0], p[1] + (h / 2) * k2[1]], qs2);
      const k4 = rhs([p[0] + h * k3[0], p[1] + h * k3[1]], qs2);
      p = [
        p[0] + (h / 6) * (k1[0] + 2 * k2[0] + 2 * k3[0] + k4[0]),
        p[1] + (h / 6) * (k1[1] + 2 * k2[1] + 2 * k3[1] + k4[1]),
      ];
    }
    t = r.times[i];
    reference.push(q1Of(p));
  }
  return {
    t0,
    tStep,
    times: r.times,
    scaledTime: r.times.map((ti) => (ti - tStep) / t0),
    q1: r.branches.R1.mdot.map((m) => m / RHO),
    reference,
  };
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

function gauss(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let i = 0; i < n; i++) {
    let piv = i;
    for (let k = i + 1; k < n; k++)
      if (Math.abs(M[k][i]) > Math.abs(M[piv][i])) piv = k;
    [M[i], M[piv]] = [M[piv], M[i]];
    for (let k = i + 1; k < n; k++) {
      const f = M[k][i] / M[i][i];
      for (let j = i; j <= n; j++) M[k][j] -= f * M[i][j];
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let s = M[i][n];
    for (let j = i + 1; j < n; j++) s -= M[i][j] * x[j];
    x[i] = s / M[i][i];
  }
  return x;
}
