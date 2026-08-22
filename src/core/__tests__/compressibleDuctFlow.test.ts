/**
 * Compressible duct-flow validation — recreation of the NASA TFAWS-2007
 * GFSSP verification paper:
 *
 *   Bandyopadhyay & Majumdar, "Modeling of Compressible Flow with Friction
 *   and Heat Transfer using the Generalized Fluid System Simulation Program
 *   (GFSSP)", TFAWS 2007, NTRS 20070036728.
 *
 * The paper verifies a nodes-and-branches network solver against analytical
 * solutions of quasi-1-D compressible flow for five cases:
 *
 *   1. Fanno flow        — friction only, constant-area pipe, choked exit.
 *   2. Rayleigh flow     — heat only, frictionless constant-area pipe,
 *                          choked exit.
 *   3. Friction + heat   — combined, constant-area pipe.
 *   4. Nozzle, friction  — adiabatic converging-diverging nozzle (subsonic).
 *   5. Nozzle, friction + heat.
 *
 * This suite recreates the same cases with THIS solver:
 *   - settings.momentumFlux  — ΔP_accel from density/area change,
 *   - settings.kineticEnergy — stagnation-enthalpy transport ṁ(h + V²/2),
 *   - pipe.frictionFactor    — the paper's constant Darcy f,
 *   - pipe.diameterOut       — tapered segments for the nozzle.
 *
 * Analytical reference (paper eq. 3, Shapiro influence coefficients),
 * integrated with RK4:
 *
 *   dM/dx = M(1 + (γ−1)/2·M²)/(1−M²) ·
 *           [ (γM²/2)(f/D) + (1+γM²)/(2T₀)·dT₀/dx − (1/A)·dA/dx ]
 *   dT₀/dx = q·πD/(ṁ·cp)                               (paper eq. 4)
 *   T(x)/T(0) = (T₀/T₀₀)·(1 + (γ−1)/2·M₀²)/(1 + (γ−1)/2·M²)   (eq. 5)
 *   p(x)/p(0) = (A₀/A)(M₀/M)·√(T/T₀ᵢₙ)                          (eq. 6)
 *
 * Fluid: nitrogen as ideal gas (γ = 1.4, R = 296.8 J/kg·K), as in the paper.
 * Case 1 geometry reproduces the paper exactly: with M₁ = 0.5, f = 0.002,
 * D = 6 in, the Fanno critical length (paper eq. 7) is 3207 in.
 * The nozzle dimensions in the paper's Fig. 2 are stated to be arbitrary;
 * the linear-diameter converging-diverging geometry here follows the same
 * description with our own dimensions, validated against the same ODE.
 */
import { describe, it, expect } from "vitest";
import type { NetworkConfig } from "../schema";
import { validateNetwork } from "../validate";
import { solveSteady } from "../solver";

/* ==========================================================================
 * Constants (SI) — nitrogen as ideal gas, unit conversions
 * ========================================================================== */

const GAMMA = 1.4;
const R_N2 = 296.8; // J/kg·K
const CP = (GAMMA * R_N2) / (GAMMA - 1); // 1038.8 J/kg·K
const MU_N2 = 1.78e-5; // Pa·s (unused with fixed f, needed by the model)

const PSI = 6894.757; // Pa
const INCH = 0.0254; // m
const BTU = 1055.056; // J

const P1 = 50 * PSI; // 344 738 Pa    (paper: 50 psia)
const T1 = ((80 - 32) * 5) / 9 + 273.15; // 299.817 K  (paper: 80 °F)
const D_PIPE = 6 * INCH; // 0.1524 m       (paper: 6 in)

/* ==========================================================================
 * Analytical reference: RK4 of the generalized 1-D compressible-flow ODE
 * ========================================================================== */

interface DuctDef {
  /** Local diameter [m]. */
  D(x: number): number;
  /** Local dD/dx [m/m] (piecewise-constant for linear tapers). */
  dDdx(x: number): number;
  /** Constant Darcy friction factor. */
  f: number;
  /** Constant wall heat flux [W/m²] (0 = adiabatic). */
  q: number;
  /** Inlet static state and Mach number. */
  P1: number;
  T1: number;
  M1: number;
}

function areaOf(D: number): number {
  return (Math.PI / 4) * D * D;
}

function soundSpeed(T: number): number {
  return Math.sqrt(GAMMA * R_N2 * T);
}

function analyticMdot(d: DuctDef): number {
  const rho1 = d.P1 / (R_N2 * d.T1);
  return rho1 * d.M1 * soundSpeed(d.T1) * areaOf(d.D(0));
}

interface DuctStation {
  x: number;
  M: number;
  T0: number;
  T: number;
  P: number;
}

/**
 * Integrate the generalized compressible-flow ODE from x = 0 through the
 * sorted station list `xs` (xs[0] must be 0).  RK4 with `substeps` steps per
 * interval; integration stops early (choking) if M reaches `mMax`, and the
 * returned array then contains only the stations reached.
 */
function integrateDuct(
  d: DuctDef,
  xs: number[],
  substeps = 4000,
  mMax = 0.9995,
): DuctStation[] {
  const mdot = analyticMdot(d);
  const T0in = d.T1 * (1 + ((GAMMA - 1) / 2) * d.M1 * d.M1);
  const A0 = areaOf(d.D(0));

  const rhs = (x: number, M: number, T0: number): [number, number] => {
    const D = d.D(x);
    const A = areaOf(D);
    const dAdx = (Math.PI / 2) * D * d.dDdx(x);
    const dT0dx = (d.q * Math.PI * D) / (mdot * CP);
    const M2 = M * M;
    const coeff = (M * (1 + ((GAMMA - 1) / 2) * M2)) / (1 - M2);
    const dMdx =
      coeff *
      (((GAMMA * M2) / 2) * (d.f / D) +
        ((1 + GAMMA * M2) / (2 * T0)) * dT0dx -
        dAdx / A);
    return [dMdx, dT0dx];
  };

  const stationOf = (x: number, M: number, T0: number): DuctStation => {
    const T = T0 / (1 + ((GAMMA - 1) / 2) * M * M);
    const P = d.P1 * ((A0 * d.M1) / (areaOf(d.D(x)) * M)) * Math.sqrt(T / d.T1);
    return { x, M, T0, T, P };
  };

  let M = d.M1;
  let T0 = T0in;
  const out: DuctStation[] = [stationOf(0, M, T0)];
  for (let i = 1; i < xs.length; i++) {
    const h = (xs[i] - xs[i - 1]) / substeps;
    let x = xs[i - 1];
    let choked = false;
    for (let s = 0; s < substeps; s++) {
      const [k1M, k1T] = rhs(x, M, T0);
      const [k2M, k2T] = rhs(x + h / 2, M + (h / 2) * k1M, T0 + (h / 2) * k1T);
      const [k3M, k3T] = rhs(x + h / 2, M + (h / 2) * k2M, T0 + (h / 2) * k2T);
      const [k4M, k4T] = rhs(x + h, M + h * k3M, T0 + h * k3T);
      M += (h / 6) * (k1M + 2 * k2M + 2 * k3M + k4M);
      T0 += (h / 6) * (k1T + 2 * k2T + 2 * k3T + k4T);
      x += h;
      if (!(M < mMax)) {
        choked = true;
        break;
      }
    }
    if (choked) break;
    out.push(stationOf(xs[i], M, T0));
  }
  return out;
}

/* Fanno closed forms (paper eq. 7 and the standard tables) */

/** f·Lstar/D as a function of Mach number (Darcy f). */
function fannoFLstarOverD(M: number): number {
  const M2 = M * M;
  return (
    (1 - M2) / (GAMMA * M2) +
    ((1 + GAMMA) / (2 * GAMMA)) *
      Math.log(((1 + GAMMA) * M2) / (2 + (GAMMA - 1) * M2))
  );
}

/** Fanno static-pressure ratio p/pstar. */
function fannoPOverPstar(M: number): number {
  return (1 / M) * Math.sqrt((GAMMA + 1) / (2 + (GAMMA - 1) * M * M));
}

/* Rayleigh closed forms */

/** Rayleigh T₀/T₀star. */
function rayleighT0OverT0star(M: number): number {
  const M2 = M * M;
  return (
    ((GAMMA + 1) * M2 * (2 + (GAMMA - 1) * M2)) / Math.pow(1 + GAMMA * M2, 2)
  );
}

/** Rayleigh static-pressure ratio p/pstar. */
function rayleighPOverPstar(M: number): number {
  return (GAMMA + 1) / (1 + GAMMA * M * M);
}

/* ==========================================================================
 * Grids and network construction
 * ========================================================================== */

/** Cosine-clustered stations on [0, L]: dense at both ends (paper Fig. 3). */
function cosineGrid(L: number, nSegments: number): number[] {
  const xs: number[] = [];
  for (let i = 0; i <= nSegments; i++) {
    xs.push((L / 2) * (1 - Math.cos((Math.PI * i) / nSegments)));
  }
  xs[0] = 0;
  xs[nSegments] = L;
  return xs;
}

interface DuctNetworkOptions {
  /** Exit boundary static pressure [Pa]. */
  exitP: number;
  /** Exit boundary static temperature [K] — for choked cases the sonic
   *  T✻ = T₀/(1 + (γ−1)/2), which sets the exit density seen by the last
   *  cell's momentum-flux and kinetic-energy terms. */
  exitT: number;
  /** Initial-guess profile at the stations (analytic seed for near-choked
   *  cases; Newton then has to hold it against the discrete equations). */
  guess?: { P: number[]; T: number[] };
  /** Mass-flow warm start [kg/s] (branch initialMdot) — near-choked ducts
   *  need a guess near the expected flow, exactly as GFSSP requires
   *  initial flow-rate guesses. */
  initialMdot?: number;
  tolerance?: number;
  relaxation?: number;
}

/**
 * Build the 1-D duct as a chain of pipe branches between stations `xs`,
 * with the quasi-1-D compressible options on: momentumFlux + kineticEnergy,
 * constant Darcy f, tapered segments where D varies, and per-node heat
 * inputs equivalent to the constant wall flux q.
 */
function buildDuctNetwork(
  d: DuctDef,
  xs: number[],
  opts: DuctNetworkOptions,
): NetworkConfig {
  const n = xs.length - 1; // segments
  const nodes: NetworkConfig["nodes"] = [];
  const branches: NetworkConfig["branches"] = [];

  // Node heat inputs: control volume of internal node i spans the midpoints
  // of the adjacent segments; the two boundary half-cells are folded into
  // the first/last internal nodes so the total equals q·π·∫D dx exactly
  // (boundary nodes have fixed T and cannot absorb heat).
  const cvHeat = (i: number): number => {
    if (d.q === 0) return 0;
    let lo = (xs[i - 1] + xs[i]) / 2;
    let hi = (xs[i] + xs[i + 1]) / 2;
    if (i === 1) lo = xs[0];
    if (i === n - 1) hi = xs[n];
    const Dmid = d.D((lo + hi) / 2);
    return d.q * Math.PI * Dmid * (hi - lo);
  };

  for (let i = 0; i <= n; i++) {
    const frac = xs[i] / xs[n];
    const Pguess = opts.guess?.P[i] ?? d.P1 + (opts.exitP - d.P1) * frac;
    const Tguess = opts.guess?.T[i] ?? d.T1;
    if (i === 0) {
      nodes.push({
        id: "n0",
        type: "boundary",
        x: 0,
        y: 0,
        pressure: d.P1,
        temperature: d.T1,
      });
    } else if (i === n) {
      nodes.push({
        id: `n${i}`,
        type: "boundary",
        x: i * 40,
        y: 0,
        pressure: opts.exitP,
        temperature: opts.exitT,
      });
    } else {
      nodes.push({
        id: `n${i}`,
        type: "internal",
        x: i * 40,
        y: 0,
        pressure: Pguess,
        temperature: Tguess,
        ...(d.q !== 0 ? { heatInput: cvHeat(i) } : {}),
      });
    }
  }

  for (let i = 0; i < n; i++) {
    const Din = d.D(xs[i]);
    const Dout = d.D(xs[i + 1]);
    branches.push({
      id: `b${i}`,
      from: `n${i}`,
      to: `n${i + 1}`,
      ...(opts.initialMdot !== undefined
        ? { initialMdot: opts.initialMdot }
        : {}),
      component: {
        type: "pipe",
        length: xs[i + 1] - xs[i],
        diameter: Din,
        roughness: 0,
        frictionFactor: d.f,
        ...(Math.abs(Dout - Din) > 1e-12 ? { diameterOut: Dout } : {}),
      },
    });
  }

  return {
    meta: { name: "compressible duct validation", version: 2 },
    settings: {
      mode: "steady",
      tolerance: opts.tolerance ?? 1e-6,
      maxIterations: 300,
      relaxation: opts.relaxation ?? 1.0,
      momentumFlux: true,
      kineticEnergy: true,
    },
    fluid: {
      model: "idealGas",
      params: { R: R_N2, gamma: GAMMA, mu: MU_N2, cp: CP },
    },
    nodes,
    branches,
  };
}

/** Node Mach number from the solved state and the local flow area. */
function nodeMach(mdot: number, rho: number, T: number, D: number): number {
  return mdot / (rho * areaOf(D) * soundSpeed(T));
}

/** Solve and return the result, asserting validation and convergence. */
function solveDuct(config: NetworkConfig) {
  expect(validateNetwork(config)).toEqual([]);
  const res = solveSteady(config);
  expect(res.converged).toBe(true);
  return res;
}

interface ProfileTolerances {
  /** Relative tolerance on static pressure per station. */
  p: number;
  /** Relative tolerance on static temperature per station. */
  t: number;
  /** Relative tolerance on Mach number per station. */
  m: number;
  /** Stations with analytic M above this are skipped (near-singular choke). */
  mSkipAbove?: number;
}

/** Compare solved node profiles against the analytic stations. */
function compareProfiles(
  res: ReturnType<typeof solveSteady>,
  d: DuctDef,
  xs: number[],
  analytic: DuctStation[],
  tol: ProfileTolerances,
): void {
  const mdot = res.branches["b0"].mdot;
  for (let i = 1; i < xs.length - 1 && i < analytic.length; i++) {
    const a = analytic[i];
    if (tol.mSkipAbove !== undefined && a.M > tol.mSkipAbove) continue;
    const node = res.nodes[`n${i}`];
    const M = nodeMach(mdot, node.density, node.temperature, d.D(xs[i]));
    expect(
      Math.abs(node.pressure - a.P) / a.P,
      `P at x=${xs[i].toFixed(2)} m (analytic M=${a.M.toFixed(3)})`,
    ).toBeLessThan(tol.p);
    expect(
      Math.abs(node.temperature - a.T) / a.T,
      `T at x=${xs[i].toFixed(2)} m (analytic M=${a.M.toFixed(3)})`,
    ).toBeLessThan(tol.t);
    expect(
      Math.abs(M - a.M) / a.M,
      `Mach at x=${xs[i].toFixed(2)} m (analytic M=${a.M.toFixed(3)})`,
    ).toBeLessThan(tol.m);
  }
}

/* ==========================================================================
 * Case 1 — Fanno flow (friction only, choked at exit)
 * ========================================================================== */

describe("GFSSP TFAWS-2007 case 1 — Fanno flow", () => {
  const f = 0.002;
  const M1 = 0.5;
  // Critical (choking) length from paper eq. 7 — 3207 in for these inputs.
  const Lstar = (D_PIPE / f) * fannoFLstarOverD(M1);

  const duct: DuctDef = {
    D: () => D_PIPE,
    dDdx: () => 0,
    f,
    q: 0,
    P1,
    T1,
    M1,
  };

  it("critical length reproduces the paper's 3207 in", () => {
    expect(Lstar / INCH).toBeGreaterThan(3200);
    expect(Lstar / INCH).toBeLessThan(3214);
  });

  const xs = cosineGrid(Lstar, 20); // 21 nodes, clustered at inlet and exit
  const analytic = integrateDuct(duct, xs);
  const exitP = P1 / fannoPOverPstar(M1); // p* — choked-exit pressure BC
  // Sonic static temperature at the choked exit (T0 is conserved — Fanno).
  const T0in = T1 * (1 + ((GAMMA - 1) / 2) * M1 * M1);
  const exitT = T0in / (1 + (GAMMA - 1) / 2);

  const config = buildDuctNetwork(duct, xs, {
    exitP,
    exitT,
    initialMdot: analyticMdot(duct),
    relaxation: 0.5,
    guess: {
      P: xs.map((_, i) => analytic[Math.min(i, analytic.length - 1)].P),
      T: xs.map((_, i) => analytic[Math.min(i, analytic.length - 1)].T),
    },
  });
  const res = solveDuct(config);

  it("mass flow matches the analytical choked flow rate (upwind: scheme accuracy; central: <1%)", () => {
    // Default limited-upwind momentum faces are first-order at the choking
    // cell — GFSSP-class accuracy (the TFAWS-2007 paper reports 1.7–5% on
    // these cases).  Measured here: 2.1%.
    const mdot = res.branches["b0"].mdot;
    expect(
      Math.abs(mdot - analyticMdot(duct)) / analyticMdot(duct),
    ).toBeLessThan(0.04);
    // The central endpoint scheme is the exact integral balance and holds
    // the historical sub-1% figure (its transonic root-multiplicity issue
    // does not arise in this monotone subsonic-to-choked duct, and the
    // second-law audit certifies the root).
    const central = solveDuct({
      ...config,
      settings: { ...config.settings, momentumFluxScheme: "central" },
    });
    const mdotC = central.branches["b0"].mdot;
    expect(
      Math.abs(mdotC - analyticMdot(duct)) / analyticMdot(duct),
    ).toBeLessThan(0.01);
  });

  it("static P, T and Mach profiles match the analytical Fanno solution", () => {
    compareProfiles(res, duct, xs, analytic, {
      p: 0.03,
      t: 0.02,
      m: 0.05,
      mSkipAbove: 0.95,
    });
  });

  it("stagnation temperature is conserved along the adiabatic pipe", () => {
    const mdot = res.branches["b0"].mdot;
    const T0in = T1 * (1 + ((GAMMA - 1) / 2) * M1 * M1);
    for (let i = 1; i < xs.length - 1; i++) {
      const node = res.nodes[`n${i}`];
      const M = nodeMach(mdot, node.density, node.temperature, D_PIPE);
      const T0 = node.temperature * (1 + ((GAMMA - 1) / 2) * M * M);
      expect(Math.abs(T0 - T0in) / T0in).toBeLessThan(0.01);
    }
  });

  it("reports branch Mach numbers rising toward 1 at the exit", () => {
    const machs = Array.from(
      { length: xs.length - 1 },
      (_, j) => res.branches[`b${j}`].mach!,
    );
    for (const m of machs) expect(m).toBeGreaterThan(0);
    for (let j = 1; j < machs.length; j++) {
      expect(machs[j]).toBeGreaterThan(machs[j - 1]);
    }
    expect(machs[0]).toBeGreaterThan(0.45);
    expect(machs[0]).toBeLessThan(0.55);
    expect(machs[machs.length - 1]).toBeGreaterThan(0.8);
  });
});

/* ==========================================================================
 * Case 2 — Rayleigh flow (heat only, frictionless, choked at exit)
 * ========================================================================== */

describe("GFSSP TFAWS-2007 case 2 — Rayleigh flow", () => {
  const M1 = 0.46;
  const L = 3207 * INCH; // same pipe geometry as case 1 (paper)

  // The paper adds 2088 Btu/s to choke the exit; with our exact constants
  // the analytically-choking heat rate is computed from the Rayleigh
  // relations (it lands within ~1 % of the paper's figure — the difference
  // is the paper's unit constants).
  const T0in = T1 * (1 + ((GAMMA - 1) / 2) * M1 * M1);
  const T0star = T0in / rayleighT0OverT0star(M1);
  const mdotAn = (P1 / (R_N2 * T1)) * M1 * soundSpeed(T1) * areaOf(D_PIPE);
  const Qtotal = mdotAn * CP * (T0star - T0in); // W

  it("the choking heat rate reproduces the paper's 2088 Btu/s within 2%", () => {
    expect(Math.abs(Qtotal / BTU - 2088) / 2088).toBeLessThan(0.02);
  });

  const duct: DuctDef = {
    D: () => D_PIPE,
    dDdx: () => 0,
    f: 0,
    q: Qtotal / (Math.PI * D_PIPE * L), // uniform wall flux
    P1,
    T1,
    M1,
  };

  const xs = cosineGrid(L, 20);
  const analytic = integrateDuct(duct, xs);
  const exitP = P1 / rayleighPOverPstar(M1); // p* at the choked exit
  const exitT = T0star / (1 + (GAMMA - 1) / 2); // sonic static T✻

  const config = buildDuctNetwork(duct, xs, {
    exitP,
    exitT,
    initialMdot: mdotAn,
    relaxation: 0.5,
    guess: {
      P: xs.map((_, i) => analytic[Math.min(i, analytic.length - 1)].P),
      T: xs.map((_, i) => analytic[Math.min(i, analytic.length - 1)].T),
    },
  });
  const res = solveDuct(config);

  it("mass flow matches the analytical value (upwind: scheme accuracy; central: <1%)", () => {
    // Measured 3.5% under the default limited-upwind faces (first-order at
    // the choking cell; heat addition steepens the near-choke gradients);
    // the central endpoint scheme keeps the historical sub-1% figure.
    const mdot = res.branches["b0"].mdot;
    expect(Math.abs(mdot - mdotAn) / mdotAn).toBeLessThan(0.05);
    const central = solveDuct({
      ...config,
      settings: { ...config.settings, momentumFluxScheme: "central" },
    });
    expect(
      Math.abs(central.branches["b0"].mdot - mdotAn) / mdotAn,
    ).toBeLessThan(0.01);
  });

  it("static P, T and Mach profiles match the analytical Rayleigh solution (within the paper's 5%)", () => {
    // The last interior station sits at analytic M = 0.945; the node-lumped
    // heat allocation (all wall heat deposited by the last internal node)
    // chokes the discrete solution one node early there — the same
    // near-choking discrepancy the paper reports — so stations beyond
    // M = 0.92 are excluded from the 5 % bar.
    compareProfiles(res, duct, xs, analytic, {
      p: 0.05,
      t: 0.05,
      m: 0.05,
      mSkipAbove: 0.92,
    });
  });

  it("stagnation temperature rise matches the applied heat", () => {
    const mdot = res.branches["b0"].mdot;
    // Interior node midway down the pipe: T0(x) − T0in = Q(0..x)/(ṁ cp).
    const i = 10;
    const node = res.nodes[`n${i}`];
    const M = nodeMach(mdot, node.density, node.temperature, D_PIPE);
    const T0 = node.temperature * (1 + ((GAMMA - 1) / 2) * M * M);
    const a = analytic[i];
    expect(Math.abs(T0 - a.T0) / a.T0).toBeLessThan(0.02);
  });
});

/* ==========================================================================
 * Case 3 — Combined friction and heat transfer, constant-area pipe
 * ========================================================================== */

describe("GFSSP TFAWS-2007 case 3 — combined friction and heat", () => {
  const M1 = 0.45;
  const f = 0.002;
  const L = 3207 * INCH;
  const Qtotal = 555 * BTU; // 555 Btu/s (paper), uniform along the pipe

  const duct: DuctDef = {
    D: () => D_PIPE,
    dDdx: () => 0,
    f,
    q: Qtotal / (Math.PI * D_PIPE * L),
    P1,
    T1,
    M1,
  };

  const xs = cosineGrid(L, 20);
  const analytic = integrateDuct(duct, xs);

  it("the analytic solution spans the full pipe (subsonic throughout or choking only at the exit)", () => {
    // With f = 0.002 and 555 Btu/s from M₁ = 0.45 the flow accelerates
    // strongly but the ODE must reach at least the second-to-last station.
    expect(analytic.length).toBeGreaterThanOrEqual(xs.length - 1);
  });

  // Exit BC from the last analytic station actually reached.
  const lastA = analytic[analytic.length - 1];
  const xsUsed = xs.slice(0, analytic.length);
  const exitP = lastA.P;

  const config = buildDuctNetwork({ ...duct }, xsUsed, {
    exitP,
    exitT: lastA.T,
    initialMdot: analyticMdot(duct),
    relaxation: 0.5,
    guess: {
      P: xsUsed.map((_, i) => analytic[i].P),
      T: xsUsed.map((_, i) => analytic[i].T),
    },
  });
  const res = solveDuct(config);

  it("mass flow matches the analytical value (upwind: scheme accuracy; central: <1%)", () => {
    // Measured 2.2% under the default limited-upwind faces (first-order at
    // the choking cell); the central endpoint scheme keeps the historical
    // sub-1% figure.
    const mdot = res.branches["b0"].mdot;
    expect(
      Math.abs(mdot - analyticMdot(duct)) / analyticMdot(duct),
    ).toBeLessThan(0.04);
    const central = solveDuct({
      ...config,
      settings: { ...config.settings, momentumFluxScheme: "central" },
    });
    expect(
      Math.abs(central.branches["b0"].mdot - analyticMdot(duct)) /
        analyticMdot(duct),
    ).toBeLessThan(0.01);
  });

  it("static P, T and Mach profiles match the analytical combined solution", () => {
    compareProfiles(res, duct, xsUsed, analytic, {
      p: 0.04,
      t: 0.03,
      m: 0.06,
      mSkipAbove: 0.95,
    });
  });
});

/* ==========================================================================
 * Cases 4 & 5 — converging-diverging nozzle (subsonic), friction ± heat
 * ========================================================================== */

/**
 * Linear-diameter converging-diverging nozzle (the paper's Fig. 2 geometry
 * is stated to be arbitrary; these dimensions keep the flow subsonic at
 * M₁ = 0.25 with f = 0.05, throat Mach ≈ 0.6).
 */
const NOZZLE = {
  Din: 8 * INCH,
  Dth: 6 * INCH,
  Dex: 7.2 * INCH,
  xTh: 12 * INCH,
  L: 30 * INCH,
};

function nozzleDuct(f: number, q: number): DuctDef {
  const { Din, Dth, Dex, xTh, L } = NOZZLE;
  const slopeC = (Dth - Din) / xTh;
  const slopeD = (Dex - Dth) / (L - xTh);
  return {
    D: (x) => (x <= xTh ? Din + slopeC * x : Dth + slopeD * (x - xTh)),
    dDdx: (x) => (x < xTh ? slopeC : slopeD),
    f,
    q,
    P1,
    T1,
    M1: 0.25,
  };
}

/** Nozzle stations: cosine-clustered per section, throat station shared
 *  (~64 nodes as in the paper's grid study). */
function nozzleGrid(): number[] {
  const { xTh, L } = NOZZLE;
  const xs: number[] = [];
  const nC = 26;
  const nD = 38;
  for (let i = 0; i < nC; i++) {
    xs.push((xTh / 2) * (1 - Math.cos((Math.PI * i) / nC)));
  }
  for (let i = 0; i <= nD; i++) {
    xs.push(xTh + ((L - xTh) / 2) * (1 - Math.cos((Math.PI * i) / nD)));
  }
  return xs;
}

describe("GFSSP TFAWS-2007 case 4 — nozzle flow with friction (adiabatic)", () => {
  const duct = nozzleDuct(0.05, 0);
  const xs = nozzleGrid();
  const analytic = integrateDuct(duct, xs);

  it("the analytic nozzle flow stays subsonic", () => {
    expect(analytic.length).toBe(xs.length);
    const maxM = Math.max(...analytic.map((a) => a.M));
    expect(maxM).toBeLessThan(1);
    expect(maxM).toBeGreaterThan(0.4);
  });

  const config = buildDuctNetwork(duct, xs, {
    exitP: analytic[analytic.length - 1].P,
    exitT: analytic[analytic.length - 1].T,
    guess: {
      P: xs.map((_, i) => analytic[i].P),
      T: xs.map((_, i) => analytic[i].T),
    },
  });
  const res = solveDuct(config);

  it("mass flow matches the analytical value", () => {
    const mdot = res.branches["b0"].mdot;
    expect(
      Math.abs(mdot - analyticMdot(duct)) / analyticMdot(duct),
    ).toBeLessThan(0.02);
  });

  it("static P, T and Mach profiles match the analytical nozzle solution", () => {
    compareProfiles(res, duct, xs, analytic, { p: 0.04, t: 0.02, m: 0.06 });
  });

  it("Mach peaks at the throat and the flow decelerates in the diffuser", () => {
    const mdot = res.branches["b0"].mdot;
    const machAt = (i: number) => {
      const node = res.nodes[`n${i}`];
      return nodeMach(mdot, node.density, node.temperature, duct.D(xs[i]));
    };
    const iThroat = xs.findIndex((x) => Math.abs(x - NOZZLE.xTh) < 1e-12);
    expect(iThroat).toBeGreaterThan(0);
    const mIn = machAt(1);
    const mTh = machAt(iThroat);
    const mEx = machAt(xs.length - 2);
    expect(mTh).toBeGreaterThan(mIn);
    expect(mTh).toBeGreaterThan(mEx);
  });
});

describe("GFSSP TFAWS-2007 case 5 — nozzle flow with friction and heat", () => {
  const q = 1e6; // W/m² constant wall flux (paper: arbitrary constant q)
  const duct = nozzleDuct(0.05, q);
  const xs = nozzleGrid();
  const analytic = integrateDuct(duct, xs);

  it("the analytic heated nozzle flow stays subsonic", () => {
    expect(analytic.length).toBe(xs.length);
    expect(Math.max(...analytic.map((a) => a.M))).toBeLessThan(1);
  });

  const config = buildDuctNetwork(duct, xs, {
    exitP: analytic[analytic.length - 1].P,
    exitT: analytic[analytic.length - 1].T,
    guess: {
      P: xs.map((_, i) => analytic[i].P),
      T: xs.map((_, i) => analytic[i].T),
    },
  });
  const res = solveDuct(config);

  it("mass flow matches the analytical value", () => {
    const mdot = res.branches["b0"].mdot;
    expect(
      Math.abs(mdot - analyticMdot(duct)) / analyticMdot(duct),
    ).toBeLessThan(0.02);
  });

  it("static P, T and Mach profiles match the analytical heated-nozzle solution", () => {
    compareProfiles(res, duct, xs, analytic, { p: 0.04, t: 0.03, m: 0.06 });
  });

  it("heating raises the stagnation temperature along the nozzle", () => {
    const mdot = res.branches["b0"].mdot;
    const iEx = xs.length - 2;
    const node = res.nodes[`n${iEx}`];
    const M = nodeMach(mdot, node.density, node.temperature, duct.D(xs[iEx]));
    const T0 = node.temperature * (1 + ((GAMMA - 1) / 2) * M * M);
    const a = analytic[iEx];
    expect(T0).toBeGreaterThan(T1 * (1 + ((GAMMA - 1) / 2) * 0.25 * 0.25));
    expect(Math.abs(T0 - a.T0) / a.T0).toBeLessThan(0.03);
  });
});

/* ==========================================================================
 * Feature-level checks: fixed friction factor and kineticEnergy behaviour
 * ========================================================================== */

describe("pipe.frictionFactor and settings.kineticEnergy", () => {
  it("a fixed friction factor produces exactly f·(L/D)·ρv²/2", () => {
    const f = 0.002;
    const L = 10;
    const config: NetworkConfig = {
      meta: { name: "fixed f", version: 2 },
      settings: { mode: "steady", tolerance: 1e-8, maxIterations: 200 },
      fluid: { model: "incompressible", preset: "water" },
      nodes: [
        {
          id: "a",
          type: "boundary",
          x: 0,
          y: 0,
          pressure: 2e5,
          temperature: 300,
        },
        {
          id: "b",
          type: "boundary",
          x: 100,
          y: 0,
          pressure: 1e5,
          temperature: 300,
        },
      ],
      branches: [
        {
          id: "p",
          from: "a",
          to: "b",
          component: {
            type: "pipe",
            length: L,
            diameter: 0.05,
            roughness: 0,
            frictionFactor: f,
          },
        },
      ],
    };
    expect(validateNetwork(config)).toEqual([]);
    const res = solveSteady(config);
    expect(res.converged).toBe(true);
    // ΔP = f (L/D) ρ v²/2  ⇒  ṁ = ρ v A with v = √(2 ΔP D/(f L ρ))
    const rho = 998;
    const A = areaOf(0.05);
    const v = Math.sqrt((2 * 1e5 * 0.05) / (f * L * rho));
    expect(
      Math.abs(res.branches["p"].mdot - rho * v * A) / (rho * v * A),
    ).toBeLessThan(1e-6);
  });

  it("frictionFactor 0 gives a frictionless pipe (ΔP = 0 at equal elevation)", () => {
    // Frictionless pipe in series with an orifice: the whole ΔP appears
    // across the orifice and the intermediate node sits at inlet pressure.
    const config: NetworkConfig = {
      meta: { name: "frictionless", version: 2 },
      settings: { mode: "steady", tolerance: 1e-8, maxIterations: 200 },
      fluid: { model: "incompressible", preset: "water" },
      nodes: [
        {
          id: "a",
          type: "boundary",
          x: 0,
          y: 0,
          pressure: 2e5,
          temperature: 300,
        },
        {
          id: "m",
          type: "internal",
          x: 50,
          y: 0,
          pressure: 1.5e5,
          temperature: 300,
        },
        {
          id: "b",
          type: "boundary",
          x: 100,
          y: 0,
          pressure: 1e5,
          temperature: 300,
        },
      ],
      branches: [
        {
          id: "p",
          from: "a",
          to: "m",
          component: {
            type: "pipe",
            length: 10,
            diameter: 0.05,
            roughness: 0,
            frictionFactor: 0,
          },
        },
        {
          id: "o",
          from: "m",
          to: "b",
          component: { type: "orifice", area: 1e-4, cd: 0.6 },
        },
      ],
    };
    expect(validateNetwork(config)).toEqual([]);
    const res = solveSteady(config);
    expect(res.converged).toBe(true);
    expect(Math.abs(res.nodes["m"].pressure - 2e5)).toBeLessThan(50);
  });

  it("kineticEnergy is accepted with realFluid (coupled h-system covers every EOS)", () => {
    // Physics assertions live in realFluidKineticEnergy.test.ts; this only
    // pins the validation contract that the old EOS gate is gone.
    const config: NetworkConfig = {
      meta: { name: "ke realfluid", version: 2 },
      settings: {
        mode: "steady",
        tolerance: 1e-6,
        maxIterations: 100,
        kineticEnergy: true,
      },
      fluid: { model: "realFluid", params: { fluidName: "Nitrogen" } },
      nodes: [
        {
          id: "a",
          type: "boundary",
          x: 0,
          y: 0,
          pressure: 2e5,
          temperature: 300,
        },
        {
          id: "b",
          type: "boundary",
          x: 100,
          y: 0,
          pressure: 1e5,
          temperature: 300,
        },
      ],
      branches: [
        {
          id: "p",
          from: "a",
          to: "b",
          component: {
            type: "pipe",
            length: 10,
            diameter: 0.05,
            roughness: 1e-5,
          },
        },
      ],
    };
    expect(validateNetwork(config)).toEqual([]);
  });

  it("with kineticEnergy on, an adiabatic accelerating gas duct conserves T0 (static T drops)", () => {
    // Two segments of the Fanno pipe: enough to see the static temperature
    // fall below the inlet temperature while T0 is conserved.
    const f = 0.002;
    const L = 40; // m — a stretch of the case-1 pipe
    const duct: DuctDef = {
      D: () => D_PIPE,
      dDdx: () => 0,
      f,
      q: 0,
      P1,
      T1,
      M1: 0.5,
    };
    const xs = [0, L / 2, L];
    const analytic = integrateDuct(duct, xs);
    const config = buildDuctNetwork(duct, xs, {
      exitP: analytic[2].P,
      exitT: analytic[2].T,
    });
    const res = solveDuct(config);
    const node = res.nodes["n1"];
    expect(node.temperature).toBeLessThan(T1); // static T drops
    const mdot = res.branches["b0"].mdot;
    const M = nodeMach(mdot, node.density, node.temperature, D_PIPE);
    const T0 = node.temperature * (1 + ((GAMMA - 1) / 2) * M * M);
    const T0in = T1 * (1 + ((GAMMA - 1) / 2) * 0.25);
    expect(Math.abs(T0 - T0in) / T0in).toBeLessThan(0.01);
  });
});
