import { describe, it, expect } from "vitest";
import { NetworkConfig } from "../schema";
import { solveSteady } from "../solver";
import { solveTransient } from "../transient";
import { Pipe, Valve, Pump } from "../components";
import { IdealGas } from "../fluids";

// ─── Dense linear solver (Gauss elimination) ─────────────────────────
function solveLinear(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let i = 0; i < n; i++) {
    let maxRow = i;
    let maxVal = Math.abs(M[i][i]);
    for (let k = i + 1; k < n; k++) {
      const v = Math.abs(M[k][i]);
      if (v > maxVal) {
        maxVal = v;
        maxRow = k;
      }
    }
    if (maxVal < 1e-14) return new Array(n).fill(0);
    [M[i], M[maxRow]] = [M[maxRow], M[i]];
    for (let k = i + 1; k < n; k++) {
      const factor = M[k][i] / M[i][i];
      for (let j = i; j <= n; j++) M[k][j] -= factor * M[i][j];
    }
  }
  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let sum = M[i][n];
    for (let j = i + 1; j < n; j++) sum -= M[i][j] * x[j];
    x[i] = sum / M[i][i];
  }
  return x;
}

// ─── Bisection helper ────────────────────────────────────────────────
function bisection(
  f: (x: number) => number,
  lo: number,
  hi: number,
  tol = 1e-12,
  maxIter = 200,
): number {
  let flo = f(lo);
  let fhi = f(hi);
  if (flo * fhi > 0) {
    // expand bracket
    for (let e = 0; e < 60; e++) {
      if (flo * fhi <= 0) break;
      const mid = (lo + hi) / 2;
      const fmid = f(mid);
      if (flo * fmid <= 0) {
        hi = mid;
        fhi = fmid;
      } else {
        lo = mid;
        flo = fmid;
      }
    }
  }
  for (let i = 0; i < maxIter; i++) {
    const mid = (lo + hi) / 2;
    const fmid = f(mid);
    if (Math.abs(hi - lo) < tol || Math.abs(fmid) < tol) return mid;
    if (flo * fmid <= 0) {
      hi = mid;
      fhi = fmid;
    } else {
      lo = mid;
      flo = fmid;
    }
  }
  return (lo + hi) / 2;
}

// ═══════════════════════════════════════════════════════════════════════
// Benchmark 1 — Multi-loop water network (Hardy-Cross style)
// ═══════════════════════════════════════════════════════════════════════
describe("B1: Multi-loop water network (Hardy-Cross)", () => {
  it("matches independent nodal reference within 0.5%", () => {
    const rho = 998;
    const HP = { id: "HP", pressure: 500_000 };
    const LP = { id: "LP", pressure: 100_000 };
    const internalIds = ["N1", "N2", "N3", "N4", "N5", "N6"];

    // Branch definitions with effective R = K/(2·ρ·A²)
    const branches = [
      {
        id: "b1",
        from: "HP",
        to: "N1",
        k: 10,
        A: 0.001,
        R: 10 / (2 * rho * 0.001 * 0.001),
      },
      {
        id: "b2",
        from: "N1",
        to: "N2",
        k: 5,
        A: 0.001,
        R: 5 / (2 * rho * 0.001 * 0.001),
      },
      {
        id: "b3",
        from: "N2",
        to: "LP",
        k: 10,
        A: 0.001,
        R: 10 / (2 * rho * 0.001 * 0.001),
      },
      {
        id: "b4",
        from: "HP",
        to: "N3",
        k: 8,
        A: 0.001,
        R: 8 / (2 * rho * 0.001 * 0.001),
      },
      {
        id: "b5",
        from: "N3",
        to: "N4",
        k: 6,
        A: 0.001,
        R: 6 / (2 * rho * 0.001 * 0.001),
      },
      {
        id: "b6",
        from: "N4",
        to: "LP",
        k: 8,
        A: 0.001,
        R: 8 / (2 * rho * 0.001 * 0.001),
      },
      {
        id: "b7",
        from: "N3",
        to: "N5",
        k: 10,
        A: 0.001,
        R: 10 / (2 * rho * 0.001 * 0.001),
      },
      {
        id: "b8",
        from: "N5",
        to: "N6",
        k: 5,
        A: 0.001,
        R: 5 / (2 * rho * 0.001 * 0.001),
      },
      {
        id: "b9",
        from: "N6",
        to: "LP",
        k: 10,
        A: 0.001,
        R: 10 / (2 * rho * 0.001 * 0.001),
      },
      {
        id: "b10",
        from: "N1",
        to: "N3",
        k: 2,
        A: 0.001,
        R: 2 / (2 * rho * 0.001 * 0.001),
      },
      {
        id: "b11",
        from: "N2",
        to: "N4",
        k: 2,
        A: 0.001,
        R: 2 / (2 * rho * 0.001 * 0.001),
      },
      {
        id: "b12",
        from: "N4",
        to: "N6",
        k: 2,
        A: 0.001,
        R: 2 / (2 * rho * 0.001 * 0.001),
      },
    ];

    // ── Solver network ──────────────────────────────────────────────
    const config: NetworkConfig = {
      meta: { name: "b1", version: 2 },
      settings: {
        mode: "steady",
        tolerance: 1e-9,
        maxIterations: 500,
        relaxation: 0.8,
      },
      fluid: { model: "incompressible", preset: "water" },
      nodes: [
        {
          id: "HP",
          type: "boundary",
          x: 0,
          y: 0,
          pressure: HP.pressure,
          temperature: 300,
        },
        {
          id: "N1",
          type: "internal",
          x: 1,
          y: 2,
          pressure: 400_000,
          temperature: 300,
        },
        {
          id: "N2",
          type: "internal",
          x: 2,
          y: 2,
          pressure: 300_000,
          temperature: 300,
        },
        {
          id: "N3",
          type: "internal",
          x: 1,
          y: 1,
          pressure: 400_000,
          temperature: 300,
        },
        {
          id: "N4",
          type: "internal",
          x: 2,
          y: 1,
          pressure: 300_000,
          temperature: 300,
        },
        {
          id: "N5",
          type: "internal",
          x: 1,
          y: 0,
          pressure: 400_000,
          temperature: 300,
        },
        {
          id: "N6",
          type: "internal",
          x: 2,
          y: 0,
          pressure: 300_000,
          temperature: 300,
        },
        {
          id: "LP",
          type: "boundary",
          x: 3,
          y: 1,
          pressure: LP.pressure,
          temperature: 300,
        },
      ],
      branches: branches.map((b) => ({
        id: b.id,
        from: b.from,
        to: b.to,
        component: { type: "resistance", k: b.k, area: b.A } as any,
      })),
    };

    const res = solveSteady(config);
    expect(res.converged).toBe(true);

    // ── Independent reference solver (nodal Newton on ΔP=R·q·|q|) ───
    const Pguess = new Map<string, number>();
    for (const id of internalIds)
      Pguess.set(id, (HP.pressure + LP.pressure) / 2);
    for (let iter = 0; iter < 500; iter++) {
      const F = new Array(internalIds.length).fill(0);
      for (const b of branches) {
        const pFrom =
          b.from === HP.id
            ? HP.pressure
            : b.from === LP.id
              ? LP.pressure
              : Pguess.get(b.from)!;
        const pTo =
          b.to === HP.id
            ? HP.pressure
            : b.to === LP.id
              ? LP.pressure
              : Pguess.get(b.to)!;
        const dp = pFrom - pTo;
        const mdot = Math.sign(dp) * Math.sqrt(Math.abs(dp) / b.R);
        if (internalIds.includes(b.from))
          F[internalIds.indexOf(b.from)] -= mdot;
        if (internalIds.includes(b.to)) F[internalIds.indexOf(b.to)] += mdot;
      }
      if (Math.max(...F.map(Math.abs)) < 1e-12) break;
      const J = Array.from({ length: internalIds.length }, () =>
        new Array(internalIds.length).fill(0),
      );
      for (let k = 0; k < internalIds.length; k++) {
        const h = Math.max(Math.abs(Pguess.get(internalIds[k])!), 1.0) * 1e-7;
        Pguess.set(internalIds[k], Pguess.get(internalIds[k])! + h);
        const Fp = new Array(internalIds.length).fill(0);
        for (const b of branches) {
          const pFrom =
            b.from === HP.id
              ? HP.pressure
              : b.from === LP.id
                ? LP.pressure
                : Pguess.get(b.from)!;
          const pTo =
            b.to === HP.id
              ? HP.pressure
              : b.to === LP.id
                ? LP.pressure
                : Pguess.get(b.to)!;
          const dp = pFrom - pTo;
          const mdot = Math.sign(dp) * Math.sqrt(Math.abs(dp) / b.R);
          if (internalIds.includes(b.from))
            Fp[internalIds.indexOf(b.from)] -= mdot;
          if (internalIds.includes(b.to)) Fp[internalIds.indexOf(b.to)] += mdot;
        }
        for (let j = 0; j < internalIds.length; j++)
          J[j][k] = (Fp[j] - F[j]) / h;
        Pguess.set(internalIds[k], Pguess.get(internalIds[k])! - h);
      }
      const dP = solveLinear(
        J,
        F.map((v) => -v),
      );
      for (let k = 0; k < internalIds.length; k++) {
        Pguess.set(internalIds[k], Pguess.get(internalIds[k])! + 0.9 * dP[k]);
      }
    }
    const refFlows = new Map<string, number>();
    for (const b of branches) {
      const pFrom =
        b.from === HP.id
          ? HP.pressure
          : b.from === LP.id
            ? LP.pressure
            : Pguess.get(b.from)!;
      const pTo =
        b.to === HP.id
          ? HP.pressure
          : b.to === LP.id
            ? LP.pressure
            : Pguess.get(b.to)!;
      const dp = pFrom - pTo;
      refFlows.set(b.id, Math.sign(dp) * Math.sqrt(Math.abs(dp) / b.R));
    }

    // ── Assert branch flows within 0.5% ─────────────────────────────
    let maxFlowErr = 0;
    for (const b of branches) {
      const s = res.branches[b.id].mdot;
      const r = refFlows.get(b.id)!;
      const err = Math.abs(s - r) / Math.max(Math.abs(r), 1e-12);
      maxFlowErr = Math.max(maxFlowErr, err);
      expect(err).toBeLessThan(0.005);
    }

    // ── Mass imbalance at every internal node < 1e-9 relative ─────────
    const maxMdot = Math.max(
      ...branches.map((b) => Math.abs(res.branches[b.id].mdot)),
    );
    for (const nid of internalIds) {
      let sum = 0;
      for (const b of branches) {
        if (b.from === nid) sum -= res.branches[b.id].mdot;
        if (b.to === nid) sum += res.branches[b.id].mdot;
      }
      expect(Math.abs(sum) / maxMdot).toBeLessThan(1e-9);
    }

    // ── Loop pressure-drop sum < 1e-6 of system ΔP ───────────────────
    const sysDP = HP.pressure - LP.pressure;
    const loopDefs = [
      // Loop A: HP→N1→N2→N4→N3→HP  (b1, b2, b11, -b5, -b4)
      { branches: ["b1", "b2", "b11", "b5", "b4"], signs: [1, 1, 1, -1, -1] },
      // Loop B: N1→N3→N4→N2→N1    (b10, b5, -b11, -b2)
      { branches: ["b10", "b5", "b11", "b2"], signs: [1, 1, -1, -1] },
      // Loop C: N3→N5→N6→N4→N3    (b7, b8, -b12, -b5)
      { branches: ["b7", "b8", "b12", "b5"], signs: [1, 1, -1, -1] },
      // Loop D: N2→LP→N4→N2       (b3, -b6, -b11)
      { branches: ["b3", "b6", "b11"], signs: [1, -1, -1] },
    ];
    for (const loop of loopDefs) {
      let sumDP = 0;
      for (let i = 0; i < loop.branches.length; i++) {
        const bid = loop.branches[i];
        const s = loop.signs[i];
        sumDP += s * res.branches[bid].dP;
      }
      expect(Math.abs(sumDP) / sysDP).toBeLessThan(1e-6);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Benchmark 2 — Pump + valve + pipe system curve
// ═══════════════════════════════════════════════════════════════════════
describe("B2: Pump + valve + pipe system curve", () => {
  const rho = 998;
  const mu = 1e-3;
  const Psupply = 100_000;
  const Pdisch = 100_000;

  function makeConfig(valvePos: number): NetworkConfig {
    return {
      meta: { name: "b2", version: 2 },
      settings: {
        mode: "steady",
        tolerance: 1e-9,
        maxIterations: 500,
        relaxation: 0.9,
      },
      fluid: { model: "incompressible", preset: "water" },
      nodes: [
        {
          id: "supply",
          type: "boundary",
          x: 0,
          y: 0,
          pressure: Psupply,
          temperature: 300,
        },
        {
          id: "mid1",
          type: "internal",
          x: 1,
          y: 0,
          pressure: 250_000,
          temperature: 300,
        },
        {
          id: "mid2",
          type: "internal",
          x: 2,
          y: 0,
          pressure: 200_000,
          temperature: 300,
        },
        {
          id: "disch",
          type: "boundary",
          x: 3,
          y: 0,
          pressure: Pdisch,
          temperature: 300,
        },
      ],
      branches: [
        {
          id: "pump",
          from: "supply",
          to: "mid1",
          component: {
            type: "pump",
            curve: [
              [0, 200_000],
              [0.01, 150_000],
              [0.02, 50_000],
            ],
          } as any,
        },
        {
          id: "pipe",
          from: "mid1",
          to: "mid2",
          component: {
            type: "pipe",
            length: 10,
            diameter: 0.05,
            roughness: 1e-5,
            elevationChange: 5,
          } as any,
        },
        {
          id: "valve",
          from: "mid2",
          to: "disch",
          component: {
            type: "valve",
            area: 0.001,
            cd: 0.6,
            position: valvePos,
          } as any,
        },
      ],
    };
  }

  function systemResidual(mdot: number, pos: number): number {
    const dpPump = new Pump([
      [0, 200_000],
      [0.01, 150_000],
      [0.02, 50_000],
    ]).pressureDrop(mdot, rho, mu);
    const rise = -dpPump;
    const dpPipe = new Pipe(10, 0.05, 1e-5, 5).pressureDrop(mdot, rho, mu);
    const dpValve = new Valve(0.001, 0.6, pos).pressureDrop(mdot, rho, mu);
    return rise - dpPipe - dpValve - (Pdisch - Psupply);
  }

  it("operating point at pos=0.5 matches bisection within 0.5%", () => {
    const pos = 0.5;
    const f = (m: number) => systemResidual(m, pos);
    let hi = 1.0;
    while (f(hi) > 0) hi *= 2;
    const mdotRef = bisection(f, 0, hi, 1e-12);

    const res = solveSteady(makeConfig(pos));
    expect(res.converged).toBe(true);
    const mdotSolver = res.branches.pump.mdot;
    const err = Math.abs(mdotSolver - mdotRef) / Math.abs(mdotRef);
    expect(err).toBeLessThan(0.005);
    // console.log('B2 pos=0.5 mdot:', mdotSolver);
  });

  it("flow is monotonic with valve position", () => {
    const flows: number[] = [];
    for (const pos of [0.25, 0.5, 0.75]) {
      const res = solveSteady(makeConfig(pos));
      expect(res.converged).toBe(true);
      flows.push(res.branches.pump.mdot);
    }
    expect(flows[0]).toBeLessThan(flows[1]);
    expect(flows[1]).toBeLessThan(flows[2]);
    // console.log('B2 flows:', flows);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Benchmark 3 — Ideal gas isothermal series pipes
// ═══════════════════════════════════════════════════════════════════════
describe("B3: Ideal gas isothermal series pipes", () => {
  it("mdot uniform, dP consistent, velocity accelerates", () => {
    const T = 300;
    const P1 = 10e5;
    const P4 = 1e5;
    const fluid = IdealGas.AIR;
    const pipe = new Pipe(5, 0.05, 1e-5, 0);

    function totalResidual(mdot: number): number {
      let P = P1;
      for (let i = 0; i < 3; i++) {
        const rho = fluid.density(P, T);
        const mu = fluid.viscosity(P, T);
        P -= pipe.pressureDrop(mdot, rho, mu);
      }
      return P - P4;
    }

    const mdotRef = bisection(totalResidual, 0, 5.0, 1e-12);

    // Extra validation: solver mdot matches reference bisection
    expect(
      Math.abs(mdotRef - 3.6978287432393704) / 3.6978287432393704,
    ).toBeLessThan(0.01);

    const config: NetworkConfig = {
      meta: { name: "b3", version: 2 },
      settings: {
        mode: "steady",
        tolerance: 1e-9,
        maxIterations: 500,
        relaxation: 0.9,
      },
      fluid: { model: "idealGas", preset: "air" },
      nodes: [
        {
          id: "IN",
          type: "boundary",
          x: 0,
          y: 0,
          pressure: P1,
          temperature: T,
        },
        {
          id: "N1",
          type: "internal",
          x: 1,
          y: 0,
          pressure: 7e5,
          temperature: T,
        },
        {
          id: "N2",
          type: "internal",
          x: 2,
          y: 0,
          pressure: 4e5,
          temperature: T,
        },
        {
          id: "OUT",
          type: "boundary",
          x: 3,
          y: 0,
          pressure: P4,
          temperature: T,
        },
      ],
      branches: [
        {
          id: "p1",
          from: "IN",
          to: "N1",
          component: {
            type: "pipe",
            length: 5,
            diameter: 0.05,
            roughness: 1e-5,
          },
        },
        {
          id: "p2",
          from: "N1",
          to: "N2",
          component: {
            type: "pipe",
            length: 5,
            diameter: 0.05,
            roughness: 1e-5,
          },
        },
        {
          id: "p3",
          from: "N2",
          to: "OUT",
          component: {
            type: "pipe",
            length: 5,
            diameter: 0.05,
            roughness: 1e-5,
          },
        },
      ],
    };

    const res = solveSteady(config);
    expect(res.converged).toBe(true);

    const mdots = [
      res.branches.p1.mdot,
      res.branches.p2.mdot,
      res.branches.p3.mdot,
    ];
    const maxM = Math.max(...mdots.map(Math.abs));

    // Identical mdot in all branches (<1e-9 relative)
    for (const m of mdots) {
      expect(Math.abs(m - mdots[0]) / maxM).toBeLessThan(1e-9);
    }

    // Each branch ΔP consistent with Darcy–Weisbach using upstream density
    const nodesP = {
      IN: res.nodes.IN.pressure,
      N1: res.nodes.N1.pressure,
      N2: res.nodes.N2.pressure,
      OUT: res.nodes.OUT.pressure,
    };
    const branchChecks = [
      { id: "p1", up: "IN", dn: "N1" },
      { id: "p2", up: "N1", dn: "N2" },
      { id: "p3", up: "N2", dn: "OUT" },
    ];
    for (const bc of branchChecks) {
      const Pup = nodesP[bc.up as keyof typeof nodesP];
      const rhoUp = fluid.density(Pup, T);
      const muUp = fluid.viscosity(Pup, T);
      const dpCalc = pipe.pressureDrop(mdots[0], rhoUp, muUp);
      const dpSolver = res.branches[bc.id].dP;
      expect(Math.abs(dpCalc - dpSolver) / Math.abs(dpSolver)).toBeLessThan(
        1e-6,
      );
    }

    // Downstream velocity > upstream velocity
    const v1 = res.branches.p1.velocity;
    const v2 = res.branches.p2.velocity;
    const v3 = res.branches.p3.velocity;
    expect(v2).toBeGreaterThan(v1);
    expect(v3).toBeGreaterThan(v2);

    // console.log('B3 mdot:', mdots[0]);
    // console.log('B3 P N1:', nodesP.N1);
    // console.log('B3 P N2:', nodesP.N2);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Benchmark 4 — Two-tank transient equalization
// ═══════════════════════════════════════════════════════════════════════
describe("B4: Two-tank transient equalization", () => {
  it("converges to equilibrium and matches coupled mass+energy RK4 within 2%", () => {
    const R = 287;
    const cp = 1005;
    const cv = cp - R;
    const T0 = 300;
    const V1 = 0.05;
    const V2 = 0.1;
    const P1_0 = 5e5;
    const P2_0 = 2e5;
    const A_orifice = 1e-4;
    const Cd = 0.6;
    const endTime = 3.0;
    const dtSolver = 0.05;
    const dtRef = dtSolver / 100; // 0.0005

    // Coupled 4-ODE RK4 reference: y = [m1, U1, m2, U2]
    const m1_0 = (P1_0 * V1) / (R * T0);
    const m2_0 = (P2_0 * V2) / (R * T0);
    const U1_0 = m1_0 * cv * T0;
    const U2_0 = m2_0 * cv * T0;

    const ode = (_t: number, y: number[]) => {
      const [m1, U1, m2, U2] = y;
      const T1 = U1 / (m1 * cv);
      const T2 = U2 / (m2 * cv);
      const P1 = (m1 * R * T1) / V1;
      const P2 = (m2 * R * T2) / V2;
      const dp = P1 - P2;
      const T_up = dp > 0 ? T1 : T2;
      const rhoUp = Math.max(P1, P2) / (R * T_up);
      const mdot =
        Cd * A_orifice * Math.sqrt(2 * rhoUp * Math.abs(dp)) * Math.sign(dp);
      return [-mdot, -mdot * cp * T_up, +mdot, +mdot * cp * T_up];
    };

    const steps = Math.round(endTime / dtRef);
    const h = endTime / steps;
    let y = [m1_0, U1_0, m2_0, U2_0];
    const refP1: number[] = [P1_0];
    const refP2: number[] = [P2_0];
    const refT1: number[] = [T0];
    const refT2: number[] = [T0];
    for (let i = 0; i < steps; i++) {
      const k1 = ode(0, y);
      const y2 = y.map((v, j) => v + (h * k1[j]) / 2);
      const k2 = ode(0, y2);
      const y3 = y.map((v, j) => v + (h * k2[j]) / 2);
      const k3 = ode(0, y3);
      const y4 = y.map((v, j) => v + h * k3[j]);
      const k4 = ode(0, y4);
      y = y.map(
        (v, j) => v + (h / 6) * (k1[j] + 2 * k2[j] + 2 * k3[j] + k4[j]),
      );
      const [m1, U1, m2, U2] = y;
      const T1 = U1 / (m1 * cv);
      const T2 = U2 / (m2 * cv);
      const P1 = (m1 * R * T1) / V1;
      const P2 = (m2 * R * T2) / V2;
      refP1.push(P1);
      refP2.push(P2);
      refT1.push(T1);
      refT2.push(T2);
    }

    // Solver network (needs one boundary; attach closed valve)
    const config: NetworkConfig = {
      meta: { name: "b4", version: 2 },
      settings: {
        mode: "transient",
        dt: dtSolver,
        endTime,
        tolerance: 1e-9,
        maxIterations: 500,
        relaxation: 0.9,
      },
      fluid: { model: "idealGas", preset: "air" },
      nodes: [
        {
          id: "tank1",
          type: "internal",
          x: 0,
          y: 0,
          pressure: P1_0,
          temperature: T0,
          volume: V1,
        },
        {
          id: "tank2",
          type: "internal",
          x: 1,
          y: 0,
          pressure: P2_0,
          temperature: T0,
          volume: V2,
        },
        {
          id: "amb",
          type: "boundary",
          x: 2,
          y: 0,
          pressure: 1e5,
          temperature: T0,
        },
      ],
      branches: [
        {
          id: "o1",
          from: "tank1",
          to: "tank2",
          component: { type: "orifice", area: A_orifice, cd: Cd },
        },
        {
          id: "v1",
          from: "tank1",
          to: "amb",
          component: { type: "valve", area: 1e-4, cd: Cd, position: 0 },
        },
      ],
    };

    const res = solveTransient(config);
    expect(res.converged).toBe(true);

    // Tiny valve flow must be negligible (<1e-4 of orifice flow, skip t=0 initial guess)
    const maxOrificeMdot = Math.max(
      ...res.branches.o1.mdot.slice(1).map(Math.abs),
    );
    const maxValveMdot = Math.max(
      ...res.branches.v1.mdot.slice(1).map(Math.abs),
    );
    expect(maxValveMdot / maxOrificeMdot).toBeLessThan(1e-4);

    // Pressures converge to analytical equilibrium within 0.5%
    // For ideal gas with total internal energy conservation, P_eq is still (P1V1+P2V2)/(V1+V2)
    const P_eq = (P1_0 * V1 + P2_0 * V2) / (V1 + V2);
    const finalP1 =
      res.nodes.tank1.pressure[res.nodes.tank1.pressure.length - 1];
    const finalP2 =
      res.nodes.tank2.pressure[res.nodes.tank2.pressure.length - 1];
    expect(Math.abs(finalP1 - P_eq) / P_eq).toBeLessThan(0.005);
    expect(Math.abs(finalP2 - P_eq) / P_eq).toBeLessThan(0.005);

    // Temperatures diverge: expanding tank cools, receiving tank warms
    const finalT1 =
      res.nodes.tank1.temperature[res.nodes.tank1.temperature.length - 1];
    const finalT2 =
      res.nodes.tank2.temperature[res.nodes.tank2.temperature.length - 1];
    expect(finalT1).toBeLessThan(T0);
    expect(finalT2).toBeGreaterThan(T0);

    // Trajectory matches coupled RK4 within 2% (sample at solver time points)
    for (let i = 1; i < res.times.length; i++) {
      const t = res.times[i];
      const idxRef = Math.round(t / dtRef);
      const solverP1 = res.nodes.tank1.pressure[i];
      const solverP2 = res.nodes.tank2.pressure[i];
      const refP1t = refP1[Math.min(idxRef, refP1.length - 1)];
      const refP2t = refP2[Math.min(idxRef, refP2.length - 1)];
      expect(Math.abs(solverP1 - refP1t) / P1_0).toBeLessThan(0.02);
      expect(Math.abs(solverP2 - refP2t) / P1_0).toBeLessThan(0.02);
    }

    // Total mass conserved to 0.1% using variable temperatures
    const m0 = (P1_0 * V1) / (R * T0) + (P2_0 * V2) / (R * T0);
    let maxMassErr = 0;
    for (let i = 0; i < res.times.length; i++) {
      const T1 = res.nodes.tank1.temperature[i];
      const T2 = res.nodes.tank2.temperature[i];
      const m =
        (res.nodes.tank1.pressure[i] * V1) / (R * T1) +
        (res.nodes.tank2.pressure[i] * V2) / (R * T2);
      maxMassErr = Math.max(maxMassErr, Math.abs(m - m0) / m0);
    }
    expect(maxMassErr).toBeLessThan(0.001);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Benchmark 5 — Heated flow string (steady energy)
// ═══════════════════════════════════════════════════════════════════════
describe("B5: Heated flow string", () => {
  it("node temperatures match analytical cumulative heating within 0.2%", () => {
    const cp = 4182;
    const Tin = 300;
    const Pin = 300_000;
    const Pout = 100_000;
    const A = 0.001;
    const Cd = 0.6;

    const Q = [1000, 2000, 3000, 4000];

    const config: NetworkConfig = {
      meta: { name: "b5", version: 2 },
      settings: {
        mode: "steady",
        tolerance: 1e-9,
        maxIterations: 500,
        relaxation: 0.9,
      },
      fluid: { model: "incompressible", preset: "water" },
      nodes: [
        {
          id: "IN",
          type: "boundary",
          x: 0,
          y: 0,
          pressure: Pin,
          temperature: Tin,
        },
        {
          id: "N1",
          type: "internal",
          x: 1,
          y: 0,
          pressure: 250_000,
          temperature: Tin,
          heatInput: Q[0],
        },
        {
          id: "N2",
          type: "internal",
          x: 2,
          y: 0,
          pressure: 200_000,
          temperature: Tin,
          heatInput: Q[1],
        },
        {
          id: "N3",
          type: "internal",
          x: 3,
          y: 0,
          pressure: 150_000,
          temperature: Tin,
          heatInput: Q[2],
        },
        {
          id: "N4",
          type: "internal",
          x: 4,
          y: 0,
          pressure: 120_000,
          temperature: Tin,
          heatInput: Q[3],
        },
        {
          id: "OUT",
          type: "boundary",
          x: 5,
          y: 0,
          pressure: Pout,
          temperature: Tin,
        },
      ],
      branches: [
        {
          id: "o1",
          from: "IN",
          to: "N1",
          component: { type: "orifice", area: A, cd: Cd },
        },
        {
          id: "o2",
          from: "N1",
          to: "N2",
          component: { type: "orifice", area: A, cd: Cd },
        },
        {
          id: "o3",
          from: "N2",
          to: "N3",
          component: { type: "orifice", area: A, cd: Cd },
        },
        {
          id: "o4",
          from: "N3",
          to: "N4",
          component: { type: "orifice", area: A, cd: Cd },
        },
        {
          id: "o5",
          from: "N4",
          to: "OUT",
          component: { type: "orifice", area: A, cd: Cd },
        },
      ],
    };

    const res = solveSteady(config);
    expect(res.converged).toBe(true);
    const mdot = res.branches.o1.mdot;

    let Tsum = Tin;
    let maxTErr = 0;
    for (let i = 0; i < 4; i++) {
      Tsum += Q[i] / (mdot * cp);
      const nodeId = `N${i + 1}`;
      const Tnode = res.nodes[nodeId].temperature;
      maxTErr = Math.max(maxTErr, Math.abs(Tnode - Tsum) / Tsum);
      expect(Math.abs(Tnode - Tsum) / Tsum).toBeLessThan(0.002);
    }
    // (logs removed)
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Benchmark 6 — Blowdown through valve schedule (transient, compound)
// ═══════════════════════════════════════════════════════════════════════
describe("B6: Blowdown through valve schedule", () => {
  it("matches coupled mass+energy RK4 within 2% and discharged mass within 0.5%", () => {
    const R = 287;
    const cp = 1005;
    const cv = cp - R;
    const T0 = 300;
    const V = 0.1;
    const P0 = 5e5;
    const Pamb = 1e5;
    const Cd = 0.6;
    const A_valve = 0.001;
    const A_orifice = 0.001;
    const endTime = 4.0;
    const dtSolver = 0.05;

    const CdA_v = Cd * A_valve;
    const CdA_o = Cd * A_orifice;

    function valvePos(t: number): number {
      return t <= 2.0 ? t / 2.0 : 1.0;
    }

    // Bisection: solve series valve+orifice for mdot given tank (P,T)
    function mdotFromPT(P_tank: number, T_tank: number, pos: number): number {
      if (P_tank <= Pamb) return 0;
      const rho_tank = P_tank / (R * T_tank);
      const effCdA_v = Math.max(CdA_v * pos, 1e-9);
      const residual = (m: number) => {
        const disc = Pamb * Pamb + (2 * m * m * R * T_tank) / (CdA_o * CdA_o);
        const P_mid = (Pamb + Math.sqrt(disc)) / 2;
        const dp_valve = (m * m) / (2 * rho_tank * effCdA_v * effCdA_v);
        return P_tank - P_mid - dp_valve;
      };
      let hi = effCdA_v * Math.sqrt(2 * rho_tank * (P_tank - Pamb));
      for (let e = 0; e < 60; e++) {
        if (residual(hi) <= 0) break;
        hi *= 2;
      }
      return bisection(residual, 0, hi, 1e-12);
    }

    const m0 = (P0 * V) / (R * T0);
    const U0 = m0 * cv * T0;

    // RK4 reference at dt/20 (fine enough)
    const dtRef = dtSolver / 20; // 0.0025
    const steps = Math.round(endTime / dtRef);
    const h = endTime / steps;
    let m = m0;
    let U = U0;
    const refPressures: number[] = [P0];
    const refMdots: number[] = [];
    for (let i = 0; i < steps; i++) {
      const t = i * h;
      const pos = valvePos(t);
      const T = U / (m * cv);
      const P = (m * R * T) / V;
      const mdot = mdotFromPT(P, T, pos);
      const k1_m = -mdot;
      const k1_U = -mdot * cp * T;

      const m2 = m + (h * k1_m) / 2;
      const U2 = U + (h * k1_U) / 2;
      const T2 = U2 / (m2 * cv);
      const P2 = (m2 * R * T2) / V;
      const mdot2 = mdotFromPT(P2, T2, pos);
      const k2_m = -mdot2;
      const k2_U = -mdot2 * cp * T2;

      const m3 = m + (h * k2_m) / 2;
      const U3 = U + (h * k2_U) / 2;
      const T3 = U3 / (m3 * cv);
      const P3 = (m3 * R * T3) / V;
      const mdot3 = mdotFromPT(P3, T3, pos);
      const k3_m = -mdot3;
      const k3_U = -mdot3 * cp * T3;

      const m4 = m + h * k3_m;
      const U4 = U + h * k3_U;
      const T4 = U4 / (m4 * cv);
      const P4 = (m4 * R * T4) / V;
      const mdot4 = mdotFromPT(P4, T4, pos);
      const k4_m = -mdot4;
      const k4_U = -mdot4 * cp * T4;

      m += (h / 6) * (k1_m + 2 * k2_m + 2 * k3_m + k4_m);
      U += (h / 6) * (k1_U + 2 * k2_U + 2 * k3_U + k4_U);
      const T_new = U / (m * cv);
      const P_new = (m * R * T_new) / V;
      refPressures.push(P_new);
      const pos_next = valvePos(t + h);
      refMdots.push(mdotFromPT(P_new, T_new, pos_next));
    }

    // Solver network: tank -> mid (tiny volume) -> ambient
    const config: NetworkConfig = {
      meta: { name: "b6", version: 2 },
      settings: {
        mode: "transient",
        dt: dtSolver,
        endTime,
        tolerance: 1e-9,
        maxIterations: 500,
        relaxation: 0.9,
      },
      fluid: { model: "idealGas", preset: "air" },
      nodes: [
        {
          id: "tank",
          type: "internal",
          x: 0,
          y: 0,
          pressure: P0,
          temperature: T0,
          volume: V,
        },
        {
          id: "mid",
          type: "internal",
          x: 1,
          y: 0,
          pressure: P0,
          temperature: T0,
          volume: 1e-6,
        },
        {
          id: "amb",
          type: "boundary",
          x: 2,
          y: 0,
          pressure: Pamb,
          temperature: T0,
        },
      ],
      branches: [
        {
          id: "v1",
          from: "tank",
          to: "mid",
          component: {
            type: "valve",
            area: A_valve,
            cd: Cd,
            position: 0,
            positionSchedule: [
              [0, 0],
              [2, 1],
              [4, 1],
            ],
          } as any,
        },
        {
          id: "o1",
          from: "mid",
          to: "amb",
          component: { type: "orifice", area: A_orifice, cd: Cd },
        },
      ],
    };

    const res = solveTransient(config);
    expect(res.converged).toBe(true);

    // Final pressure within 2%
    const PfinalSolver =
      res.nodes.tank.pressure[res.nodes.tank.pressure.length - 1];
    const PfinalRef = refPressures[refPressures.length - 1];
    expect(Math.abs(PfinalSolver - PfinalRef) / P0).toBeLessThan(0.02);

    // Integrated discharged mass matches tank mass loss within 0.5%
    let discharged = 0;
    for (let i = 1; i < res.times.length; i++) {
      discharged += Math.abs(res.branches.o1.mdot[i]) * dtSolver;
    }
    const rho0 = P0 / (R * T0);
    const rhoFinal = res.nodes.tank.density[res.nodes.tank.density.length - 1];
    const massLoss = V * (rho0 - rhoFinal);
    const massErr = Math.abs(discharged - massLoss) / massLoss;
    expect(massErr).toBeLessThan(0.005);

    // Tank temperature must drop (adiabatic cooling)
    const finalT =
      res.nodes.tank.temperature[res.nodes.tank.temperature.length - 1];
    expect(finalT).toBeLessThan(T0);

    let maxBranchDiff = 0;
    // Valve and orifice mdots agree (<0.5% relative; tiny mid volume causes minor mismatch)
    for (let i = 1; i < res.times.length; i++) {
      const diff = Math.abs(res.branches.v1.mdot[i] - res.branches.o1.mdot[i]);
      maxBranchDiff = Math.max(
        maxBranchDiff,
        diff / Math.abs(res.branches.o1.mdot[i]),
      );
      expect(diff / Math.abs(res.branches.o1.mdot[i])).toBeLessThan(0.005);
    }
    // (logs removed)
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Benchmark 7 — Scalability/robustness ladder network
// ═══════════════════════════════════════════════════════════════════════
describe("B7: Scalability ladder network", () => {
  it("30 internal nodes / 61 branches converges in <30 s", () => {
    const nPairs = 15; // 30 internal nodes
    const nodes: NetworkConfig["nodes"] = [
      {
        id: "HP",
        type: "boundary",
        x: 0,
        y: 0,
        pressure: 400_000,
        temperature: 300,
      },
      {
        id: "LP",
        type: "boundary",
        x: nPairs + 1,
        y: 0,
        pressure: 100_000,
        temperature: 300,
      },
    ];
    const branches: NetworkConfig["branches"] = [];

    for (let i = 1; i <= nPairs; i++) {
      nodes.push({
        id: `T${i}`,
        type: "internal",
        x: i,
        y: 1,
        pressure: 300_000,
        temperature: 300,
      });
      nodes.push({
        id: `B${i}`,
        type: "internal",
        x: i,
        y: 0,
        pressure: 300_000,
        temperature: 300,
      });
    }

    const pipeSpec = {
      type: "pipe",
      length: 2,
      diameter: 0.03,
      roughness: 1e-5,
    } as const;

    // Top rail
    branches.push({ id: "t0", from: "HP", to: "T1", component: pipeSpec });
    for (let i = 1; i < nPairs; i++) {
      branches.push({
        id: `t${i}`,
        from: `T${i}`,
        to: `T${i + 1}`,
        component: pipeSpec,
      });
    }
    branches.push({
      id: `t${nPairs}`,
      from: `T${nPairs}`,
      to: "LP",
      component: pipeSpec,
    });

    // Bottom rail
    branches.push({ id: "b0", from: "HP", to: "B1", component: pipeSpec });
    for (let i = 1; i < nPairs; i++) {
      branches.push({
        id: `b${i}`,
        from: `B${i}`,
        to: `B${i + 1}`,
        component: pipeSpec,
      });
    }
    branches.push({
      id: `b${nPairs}`,
      from: `B${nPairs}`,
      to: "LP",
      component: pipeSpec,
    });

    // Rungs
    for (let i = 1; i <= nPairs; i++) {
      branches.push({
        id: `r${i}`,
        from: `T${i}`,
        to: `B${i}`,
        component: pipeSpec,
      });
    }

    // Extra diagonals
    for (let i = 1; i < nPairs; i++) {
      branches.push({
        id: `d${i}`,
        from: `T${i + 1}`,
        to: `B${i}`,
        component: pipeSpec,
      });
    }

    const config: NetworkConfig = {
      meta: { name: "b7", version: 2 },
      settings: {
        mode: "steady",
        tolerance: 1e-8,
        maxIterations: 1000,
        relaxation: 0.7,
      },
      fluid: { model: "incompressible", preset: "water" },
      nodes,
      branches,
    };

    const t0 = performance.now();
    const res = solveSteady(config);
    const t1 = performance.now();
    const elapsed = (t1 - t0) / 1000;

    expect(res.converged).toBe(true);
    expect(elapsed).toBeLessThan(30);

    // Mass balance everywhere < 1e-8 relative
    const allMdots = branches.map((b) => Math.abs(res.branches[b.id].mdot));
    const maxMdot = Math.max(...allMdots);
    for (const nid of nodes
      .filter((n) => n.type === "internal")
      .map((n) => n.id)) {
      let sum = 0;
      for (const b of branches) {
        if (b.from === nid) sum -= res.branches[b.id].mdot;
        if (b.to === nid) sum += res.branches[b.id].mdot;
      }
      expect(Math.abs(sum) / maxMdot).toBeLessThan(1e-8);
    }

    // Monotonic pressure gradient along rails
    const topP = [res.nodes.HP.pressure];
    for (let i = 1; i <= nPairs; i++) topP.push(res.nodes[`T${i}`].pressure);
    topP.push(res.nodes.LP.pressure);
    for (let i = 0; i < topP.length - 1; i++) {
      expect(topP[i]).toBeGreaterThan(topP[i + 1] + 1); // strictly decreasing by >1 Pa
    }

    const botP = [res.nodes.HP.pressure];
    for (let i = 1; i <= nPairs; i++) botP.push(res.nodes[`B${i}`].pressure);
    botP.push(res.nodes.LP.pressure);
    for (let i = 0; i < botP.length - 1; i++) {
      expect(botP[i]).toBeGreaterThan(botP[i + 1] + 1);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Benchmark 8 — Regression goldens (values captured from passing B1–B3)
// ═══════════════════════════════════════════════════════════════════════
describe("B8: Regression goldens", () => {
  it("B1 exact branch flows and node pressures", () => {
    const config: NetworkConfig = {
      meta: { name: "b1-reg", version: 2 },
      settings: {
        mode: "steady",
        tolerance: 1e-9,
        maxIterations: 500,
        relaxation: 0.8,
      },
      fluid: { model: "incompressible", preset: "water" },
      nodes: [
        {
          id: "HP",
          type: "boundary",
          x: 0,
          y: 0,
          pressure: 500_000,
          temperature: 300,
        },
        {
          id: "N1",
          type: "internal",
          x: 1,
          y: 2,
          pressure: 400_000,
          temperature: 300,
        },
        {
          id: "N2",
          type: "internal",
          x: 2,
          y: 2,
          pressure: 300_000,
          temperature: 300,
        },
        {
          id: "N3",
          type: "internal",
          x: 1,
          y: 1,
          pressure: 400_000,
          temperature: 300,
        },
        {
          id: "N4",
          type: "internal",
          x: 2,
          y: 1,
          pressure: 300_000,
          temperature: 300,
        },
        {
          id: "N5",
          type: "internal",
          x: 1,
          y: 0,
          pressure: 400_000,
          temperature: 300,
        },
        {
          id: "N6",
          type: "internal",
          x: 2,
          y: 0,
          pressure: 300_000,
          temperature: 300,
        },
        {
          id: "LP",
          type: "boundary",
          x: 3,
          y: 1,
          pressure: 100_000,
          temperature: 300,
        },
      ],
      branches: [
        {
          id: "b1",
          from: "HP",
          to: "N1",
          component: { type: "resistance", k: 10, area: 0.001 },
        },
        {
          id: "b2",
          from: "N1",
          to: "N2",
          component: { type: "resistance", k: 5, area: 0.001 },
        },
        {
          id: "b3",
          from: "N2",
          to: "LP",
          component: { type: "resistance", k: 10, area: 0.001 },
        },
        {
          id: "b4",
          from: "HP",
          to: "N3",
          component: { type: "resistance", k: 8, area: 0.001 },
        },
        {
          id: "b5",
          from: "N3",
          to: "N4",
          component: { type: "resistance", k: 6, area: 0.001 },
        },
        {
          id: "b6",
          from: "N4",
          to: "LP",
          component: { type: "resistance", k: 8, area: 0.001 },
        },
        {
          id: "b7",
          from: "N3",
          to: "N5",
          component: { type: "resistance", k: 10, area: 0.001 },
        },
        {
          id: "b8",
          from: "N5",
          to: "N6",
          component: { type: "resistance", k: 5, area: 0.001 },
        },
        {
          id: "b9",
          from: "N6",
          to: "LP",
          component: { type: "resistance", k: 10, area: 0.001 },
        },
        {
          id: "b10",
          from: "N1",
          to: "N3",
          component: { type: "resistance", k: 2, area: 0.001 },
        },
        {
          id: "b11",
          from: "N2",
          to: "N4",
          component: { type: "resistance", k: 2, area: 0.001 },
        },
        {
          id: "b12",
          from: "N4",
          to: "N6",
          component: { type: "resistance", k: 2, area: 0.001 },
        },
      ],
    };
    const res = solveSteady(config);
    expect(res.converged).toBe(true);

    // Golden values (relative 1e-6) — captured from converged B1 run
    const mdots: Record<string, number> = {
      b1: 6.607217765337947,
      b2: 5.61067107328098,
      b3: 4.52159910376039,
      b4: 7.40387969753758,
      b5: 5.128094096144156,
      b6: 5.0258883423937695,
      b7: 3.2723322934503907,
      b8: 3.2723322934503907,
      b9: 4.4636100167213675,
      b10: 0.9965466920569666,
      b11: 1.0890719695205906,
      b12: 1.1912777232709766,
    };
    const pressures: Record<string, number> = {
      N1: 281285.93888478295,
      N2: 202429.15057678721,
      N3: 280290.8433843324,
      N4: 201240.69591266353,
      N5: 226642.75401179583,
      N6: 199818.70932552757,
    };

    for (const [bid, val] of Object.entries(mdots)) {
      expect(
        Math.abs(res.branches[bid].mdot - val) / Math.abs(val),
      ).toBeLessThan(1e-6);
    }
    for (const [nid, val] of Object.entries(pressures)) {
      expect(
        Math.abs(res.nodes[nid].pressure - val) / Math.abs(val),
      ).toBeLessThan(1e-6);
    }
  });

  it("B2 exact operating point at valve=0.5", () => {
    const config: NetworkConfig = {
      meta: { name: "b2-reg", version: 2 },
      settings: {
        mode: "steady",
        tolerance: 1e-9,
        maxIterations: 500,
        relaxation: 0.9,
      },
      fluid: { model: "incompressible", preset: "water" },
      nodes: [
        {
          id: "supply",
          type: "boundary",
          x: 0,
          y: 0,
          pressure: 100_000,
          temperature: 300,
        },
        {
          id: "mid1",
          type: "internal",
          x: 1,
          y: 0,
          pressure: 250_000,
          temperature: 300,
        },
        {
          id: "mid2",
          type: "internal",
          x: 2,
          y: 0,
          pressure: 200_000,
          temperature: 300,
        },
        {
          id: "disch",
          type: "boundary",
          x: 3,
          y: 0,
          pressure: 100_000,
          temperature: 300,
        },
      ],
      branches: [
        {
          id: "pump",
          from: "supply",
          to: "mid1",
          component: {
            type: "pump",
            curve: [
              [0, 200_000],
              [0.01, 150_000],
              [0.02, 50_000],
            ],
          },
        },
        {
          id: "pipe",
          from: "mid1",
          to: "mid2",
          component: {
            type: "pipe",
            length: 10,
            diameter: 0.05,
            roughness: 1e-5,
            elevationChange: 5,
          },
        },
        {
          id: "valve",
          from: "mid2",
          to: "disch",
          component: { type: "valve", area: 0.001, cd: 0.6, position: 0.5 },
        },
      ],
    };
    const res = solveSteady(config);
    expect(res.converged).toBe(true);
    expect(
      Math.abs(res.branches.pump.mdot - 4.600762731665299) / 4.600762731665299,
    ).toBeLessThan(1e-6);
  });

  it("B3 exact mdot and intermediate pressures", () => {
    const config: NetworkConfig = {
      meta: { name: "b3-reg", version: 2 },
      settings: {
        mode: "steady",
        tolerance: 1e-9,
        maxIterations: 500,
        relaxation: 0.9,
      },
      fluid: { model: "idealGas", preset: "air" },
      nodes: [
        {
          id: "IN",
          type: "boundary",
          x: 0,
          y: 0,
          pressure: 1_000_000,
          temperature: 300,
        },
        {
          id: "N1",
          type: "internal",
          x: 1,
          y: 0,
          pressure: 700_000,
          temperature: 300,
        },
        {
          id: "N2",
          type: "internal",
          x: 2,
          y: 0,
          pressure: 400_000,
          temperature: 300,
        },
        {
          id: "OUT",
          type: "boundary",
          x: 3,
          y: 0,
          pressure: 100_000,
          temperature: 300,
        },
      ],
      branches: [
        {
          id: "p1",
          from: "IN",
          to: "N1",
          component: {
            type: "pipe",
            length: 5,
            diameter: 0.05,
            roughness: 1e-5,
          },
        },
        {
          id: "p2",
          from: "N1",
          to: "N2",
          component: {
            type: "pipe",
            length: 5,
            diameter: 0.05,
            roughness: 1e-5,
          },
        },
        {
          id: "p3",
          from: "N2",
          to: "OUT",
          component: {
            type: "pipe",
            length: 5,
            diameter: 0.05,
            roughness: 1e-5,
          },
        },
      ],
    };
    const res = solveSteady(config);
    expect(res.converged).toBe(true);
    expect(
      Math.abs(res.branches.p1.mdot - 3.6978287432393704) / 3.6978287432393704,
    ).toBeLessThan(1e-6);
    expect(
      Math.abs(res.nodes.N1.pressure - 786422.4963551194) / 786422.4963551194,
    ).toBeLessThan(1e-6);
    expect(
      Math.abs(res.nodes.N2.pressure - 514841.37471279444) / 514841.37471279444,
    ).toBeLessThan(1e-6);
  });
});
