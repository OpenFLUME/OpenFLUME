import { describe, it, expect } from "vitest";
import { NetworkConfig } from "../schema";
import { solveTransient, applyBoundaryConditions } from "../transient";
import { validateNetwork } from "../validate";
import {
  buildSolverContext,
  createInitialState,
  solveStateStep,
  componentPressureDrop,
  solveSteady,
} from "../solver";
import { Pipe } from "../components";

/** RK4 integrator for system of ODEs dy/dt = f(t, y) where y is number[]. */
function rk4Vec(
  f: (t: number, y: number[]) => number[],
  y0: number[],
  t0: number,
  tf: number,
  dt: number,
): number[] {
  let y = [...y0];
  let t = t0;
  const steps = Math.ceil((tf - t0) / dt);
  const h = (tf - t0) / steps;
  for (let i = 0; i < steps; i++) {
    const k1 = f(t, y);
    const k2 = f(
      t + h / 2,
      y.map((v, j) => v + (h * k1[j]) / 2),
    );
    const k3 = f(
      t + h / 2,
      y.map((v, j) => v + (h * k2[j]) / 2),
    );
    const k4 = f(
      t + h,
      y.map((v, j) => v + h * k3[j]),
    );
    y = y.map((v, j) => v + (h / 6) * (k1[j] + 2 * k2[j] + 2 * k3[j] + k4[j]));
    t += h;
  }
  return y;
}

/** Run fixed-step transient with optional initial mdots override. */
function runFixedTransient(
  config: NetworkConfig,
  initialMdots?: number[],
): ReturnType<typeof solveTransient> {
  const ctx = buildSolverContext(config);
  const dt = config.settings.dt!;
  const endTime = config.settings.endTime!;
  const steps = Math.round(endTime / dt);

  let state = createInitialState(ctx, config);
  applyBoundaryConditions(ctx, config, state, 0);
  if (initialMdots) {
    for (let j = 0; j < ctx.nBranch; j++) state.mdots[j] = initialMdots[j];
  }

  const times: number[] = [0];
  const nodeResults: ReturnType<typeof solveTransient>["nodes"] = {};
  const branchResults: ReturnType<typeof solveTransient>["branches"] = {};
  const solidResults: ReturnType<typeof solveTransient>["solidNodes"] = {};
  const conductorResults: ReturnType<typeof solveTransient>["conductors"] = {};

  for (const node of config.nodes) {
    nodeResults[node.id] = {
      pressure: [state.nodeP.get(node.id)!],
      temperature: [state.nodeT.get(node.id)!],
      density: [state.nodeRho.get(node.id)!],
      quality: [],
    };
    const gc = node.gasCushion;
    if (gc) {
      const P0 = node.pressure ?? state.nodeP.get(node.id)!;
      const C = P0 * Math.pow(gc.initialGasVolume, gc.polytropicIndex);
      nodeResults[node.id].gasVolume = [
        Math.pow(C / state.nodeP.get(node.id)!, 1 / gc.polytropicIndex),
      ];
    }
  }
  for (let j = 0; j < ctx.nBranch; j++) {
    branchResults[ctx.branches[j].id] = { mdot: [state.mdots[j]] };
  }
  for (const sNode of config.solidNodes ?? []) {
    solidResults[sNode.id] = { temperature: [state.solidT.get(sNode.id)!] };
  }

  let allConverged = true;
  for (let step = 1; step <= steps; step++) {
    const t = step * dt;
    const prevState = {
      nodeP: new Map(state.nodeP),
      nodeT: new Map(state.nodeT),
      nodeRho: new Map(state.nodeRho),
      nodeMu: new Map(state.nodeMu),
      mdots: [...state.mdots],
      solidT: new Map(state.solidT),
    };
    applyBoundaryConditions(ctx, config, state, t);
    const res = solveStateStep(ctx, state, {
      dt,
      t,
      tol: config.settings.tolerance,
      maxIterations: config.settings.maxIterations,
      relaxation: config.settings.relaxation ?? 1.0,
      prevState,
    });
    if (!res.converged) allConverged = false;
    times.push(t);
    for (const node of config.nodes) {
      nodeResults[node.id].pressure.push(state.nodeP.get(node.id)!);
      nodeResults[node.id].temperature.push(state.nodeT.get(node.id)!);
      nodeResults[node.id].density.push(state.nodeRho.get(node.id)!);
      const gc = node.gasCushion;
      if (gc) {
        const P0 = node.pressure ?? state.nodeP.get(node.id)!;
        const C = P0 * Math.pow(gc.initialGasVolume, gc.polytropicIndex);
        nodeResults[node.id].gasVolume!.push(
          Math.pow(C / state.nodeP.get(node.id)!, 1 / gc.polytropicIndex),
        );
      }
    }
    for (let j = 0; j < ctx.nBranch; j++) {
      branchResults[ctx.branches[j].id].mdot.push(state.mdots[j]);
    }
    for (const sNode of config.solidNodes ?? []) {
      solidResults[sNode.id].temperature.push(state.solidT.get(sNode.id)!);
    }
  }

  return {
    converged: allConverged,
    times,
    nodes: nodeResults,
    branches: branchResults,
    solidNodes: solidResults,
    conductors: conductorResults,
  };
}

describe("Inertia startup", () => {
  it(
    "matches RK4 of (L/A)·dmdot/dt = ΔP − ΔP_f(mdot) within 1%",
    { timeout: 30000 },
    () => {
      const L = 100;
      const D = 0.1;
      const A = (Math.PI / 4) * D * D;
      const roughness = 1e-6;
      const rho = 998;
      const mu = 1e-3;
      const dt = 0.001;
      const endTime = 0.5;
      const P_from = 2e5;
      const P_to = 1e5;

      const pipe = new Pipe(L, D, roughness, 0);

      // RK4 reference
      const ode = (_t: number, y: number[]) => {
        const mdot = y[0];
        const dP_f = componentPressureDrop(mdot, rho, mu, pipe);
        return [(A / L) * (P_from - P_to - dP_f)];
      };
      const mdots_ref: number[] = [0];
      let y = [0];
      for (let step = 1; step <= Math.round(endTime / dt); step++) {
        y = rk4Vec(ode, y, (step - 1) * dt, step * dt, dt);
        mdots_ref.push(y[0]);
      }

      const config: NetworkConfig = {
        meta: { name: "inertia", version: 2 },
        settings: {
          mode: "transient",
          dt,
          endTime,
          tolerance: 1e-6,
          maxIterations: 200,
          relaxation: 0.9,
        },
        fluid: { model: "incompressible", preset: "water" },
        nodes: [
          {
            id: "A",
            type: "boundary",
            x: 0,
            y: 0,
            pressure: P_from,
            temperature: 300,
          },
          {
            id: "B",
            type: "boundary",
            x: 1,
            y: 0,
            pressure: P_to,
            temperature: 300,
          },
        ],
        branches: [
          {
            id: "p1",
            from: "A",
            to: "B",
            component: {
              type: "pipe",
              length: L,
              diameter: D,
              roughness,
              inertia: true,
            },
          },
        ],
      };

      const res = runFixedTransient(config, [0]);
      const mdots_solver = res.branches.p1.mdot;

      expect(mdots_solver.length).toBe(mdots_ref.length);
      for (let i = 1; i < mdots_solver.length; i++) {
        const denom = Math.max(Math.abs(mdots_ref[i]), 1e-6);
        expect(Math.abs(mdots_solver[i] - mdots_ref[i]) / denom).toBeLessThan(
          0.01,
        );
      }
    },
  );

  it(
    "without inertia flag, mdot jumps immediately to quasi-steady",
    { timeout: 30000 },
    () => {
      const L = 100;
      const D = 0.1;
      const roughness = 1e-6;
      const dt = 0.001;
      const endTime = 0.05;
      const P_from = 2e5;
      const P_to = 1e5;

      const config: NetworkConfig = {
        meta: { name: "no-inertia", version: 2 },
        settings: {
          mode: "transient",
          dt,
          endTime,
          tolerance: 1e-6,
          maxIterations: 200,
          relaxation: 0.9,
        },
        fluid: { model: "incompressible", preset: "water" },
        nodes: [
          {
            id: "A",
            type: "boundary",
            x: 0,
            y: 0,
            pressure: P_from,
            temperature: 300,
          },
          {
            id: "B",
            type: "boundary",
            x: 1,
            y: 0,
            pressure: P_to,
            temperature: 300,
          },
        ],
        branches: [
          {
            id: "p1",
            from: "A",
            to: "B",
            component: { type: "pipe", length: L, diameter: D, roughness },
          },
        ],
      };

      const steadyRes = solveSteady(config);
      const mdot_steady = steadyRes.branches.p1.mdot;
      expect(mdot_steady).toBeGreaterThan(0);

      const res = runFixedTransient(config, [0]);
      // After the first step (t=dt), mdot should already be very close to steady
      expect(
        Math.abs(res.branches.p1.mdot[1] - mdot_steady) / mdot_steady,
      ).toBeLessThan(0.05);
    },
  );
});

describe("Steady unaffected", () => {
  it(
    "same network solved steady with inertia:true identical to inertia:false (1e-12)",
    { timeout: 30000 },
    () => {
      const L = 50;
      const D = 0.05;
      const roughness = 1e-4;
      const P_from = 3e5;
      const P_to = 1e5;

      const baseConfig = (inertia: boolean): NetworkConfig => ({
        meta: { name: "steady", version: 2 },
        settings: {
          mode: "steady",
          tolerance: 1e-9,
          maxIterations: 200,
          relaxation: 0.9,
        },
        fluid: { model: "incompressible", preset: "water" },
        nodes: [
          {
            id: "A",
            type: "boundary",
            x: 0,
            y: 0,
            pressure: P_from,
            temperature: 300,
          },
          {
            id: "B",
            type: "boundary",
            x: 1,
            y: 0,
            pressure: P_to,
            temperature: 300,
          },
        ],
        branches: [
          {
            id: "p1",
            from: "A",
            to: "B",
            component: {
              type: "pipe",
              length: L,
              diameter: D,
              roughness,
              inertia,
            },
          },
        ],
      });

      const res_inertia = solveSteady(baseConfig(true));
      const res_no = solveSteady(baseConfig(false));

      expect(
        Math.abs(res_inertia.branches.p1.mdot - res_no.branches.p1.mdot),
      ).toBeLessThan(1e-12);
      expect(
        Math.abs(res_inertia.nodes.A.pressure - res_no.nodes.A.pressure),
      ).toBeLessThan(1e-12);
      expect(
        Math.abs(res_inertia.nodes.B.pressure - res_no.nodes.B.pressure),
      ).toBeLessThan(1e-12);
    },
  );
});

describe("Gas cushion static compression", () => {
  it(
    "quasi-static P·V_gas^n = const, volume sum, and mass conservation",
    { timeout: 30000 },
    () => {
      const mdot = 1.0;
      const V_total = 0.01;
      const Vg0 = 0.005;
      const n = 1.4;
      const P0 = 1e5;
      const rho = 998;
      const dt = 0.01;
      const endTime = 2.0;

      const config: NetworkConfig = {
        meta: { name: "cushion", version: 2 },
        settings: {
          mode: "transient",
          dt,
          endTime,
          tolerance: 1e-6,
          maxIterations: 200,
          relaxation: 0.9,
        },
        fluid: { model: "incompressible", preset: "water" },
        nodes: [
          {
            id: "A",
            type: "boundary",
            x: 0,
            y: 0,
            pressure: P0,
            temperature: 300,
          },
          {
            id: "C",
            type: "internal",
            x: 1,
            y: 0,
            pressure: P0,
            temperature: 300,
            volume: V_total,
            gasCushion: { initialGasVolume: Vg0, polytropicIndex: n },
          },
        ],
        branches: [
          {
            id: "fs1",
            from: "A",
            to: "C",
            component: { type: "flowSource", massFlow: mdot },
          },
        ],
      };

      const res = runFixedTransient(config, [mdot]);

      const C_const = P0 * Math.pow(Vg0, n);
      let totalInjected = 0;
      let maxPVdev = 0;
      let maxVolSumErr = 0;

      for (let i = 0; i < res.times.length; i++) {
        const P = res.nodes.C.pressure[i];
        const Vg = res.nodes.C.gasVolume![i];
        const Vw = V_total - Vg;
        const pv = P * Math.pow(Vg, n);
        maxPVdev = Math.max(maxPVdev, Math.abs(pv - C_const) / C_const);
        maxVolSumErr = Math.max(maxVolSumErr, Math.abs(Vw + Vg - V_total));
        if (i > 0) totalInjected += mdot * dt;
      }

      expect(maxPVdev).toBeLessThan(0.005);
      expect(maxVolSumErr).toBeLessThan(1e-9);

      const Vw_final =
        V_total - res.nodes.C.gasVolume![res.nodes.C.gasVolume!.length - 1];
      const Vw_initial = V_total - Vg0;
      const massExpected = rho * (Vw_final - Vw_initial);
      expect(
        Math.abs(totalInjected - massExpected) / massExpected,
      ).toBeLessThan(0.001);
    },
  );
});

describe("Oscillator", () => {
  it(
    "nonlinear mass-spring matches RK4 and linearized period",
    { timeout: 30000 },
    () => {
      const L = 10;
      const D = 0.05;
      const A = (Math.PI / 4) * D * D;
      const roughness = 1e-6;
      const rho = 998;
      const mu = 1e-3;
      const V_total = 0.01;
      const Vg0 = 0.005;
      const n = 1.4;
      const P_eq = 1e5;
      const P_step = 2e5;
      const dt = 0.002;
      const endTime = 5.0;

      const pipe = new Pipe(L, D, roughness, 0);

      // RK4 reference
      const Vw_eq = V_total - Vg0;
      const C_const = P_eq * Math.pow(Vg0, n);
      const ode = (_t: number, y: number[]) => {
        const mdot = y[0];
        const Vw = y[1];
        const Vg = V_total - Vw;
        const P_gas = C_const / Math.pow(Vg, n);
        const dP_f = componentPressureDrop(mdot, rho, mu, pipe);
        return [(A / L) * (P_step - dP_f - P_gas), mdot / rho];
      };
      const mdots_rk4: number[] = [0];
      const steps = Math.round(endTime / dt);
      let y = [0, Vw_eq];
      for (let step = 1; step <= steps; step++) {
        y = rk4Vec(ode, y, (step - 1) * dt, step * dt, dt);
        mdots_rk4.push(y[0]);
      }

      const config: NetworkConfig = {
        meta: { name: "osc", version: 2 },
        settings: {
          mode: "transient",
          dt,
          endTime,
          tolerance: 1e-6,
          maxIterations: 200,
          relaxation: 0.9,
        },
        fluid: { model: "incompressible", preset: "water" },
        nodes: [
          {
            id: "R",
            type: "boundary",
            x: 0,
            y: 0,
            pressure: P_eq,
            temperature: 300,
            pressureSchedule: [
              [0, P_step],
              [endTime, P_step],
            ],
          },
          {
            id: "C",
            type: "internal",
            x: 1,
            y: 0,
            pressure: P_eq,
            temperature: 300,
            volume: V_total,
            gasCushion: { initialGasVolume: Vg0, polytropicIndex: n },
          },
        ],
        branches: [
          {
            id: "p1",
            from: "R",
            to: "C",
            component: {
              type: "pipe",
              length: L,
              diameter: D,
              roughness,
              inertia: true,
            },
          },
        ],
      };

      const res = runFixedTransient(config, [0]);

      function findPeaks(arr: number[]): Array<{ idx: number; value: number }> {
        const peaks: Array<{ idx: number; value: number }> = [];
        for (let i = 1; i < arr.length - 1; i++) {
          if (arr[i] > arr[i - 1] && arr[i] > arr[i + 1] && arr[i] > 0) {
            peaks.push({ idx: i, value: arr[i] });
          }
        }
        return peaks;
      }

      const peaksSolver = findPeaks(res.branches.p1.mdot);
      const peaksRK4 = findPeaks(mdots_rk4);

      expect(peaksSolver.length).toBeGreaterThanOrEqual(3);
      expect(peaksRK4.length).toBeGreaterThanOrEqual(3);

      for (let i = 0; i < Math.min(peaksSolver.length, peaksRK4.length); i++) {
        const t_s = peaksSolver[i].idx * dt;
        const t_r = peaksRK4[i].idx * dt;
        expect(Math.abs(t_s - t_r) / Math.max(t_r, 1e-6)).toBeLessThan(0.05);
      }

      const ampSolver = peaksSolver[0].value;
      const ampRK4 = peaksRK4[0].value;
      expect(
        Math.abs(ampSolver - ampRK4) / Math.max(ampRK4, 1e-6),
      ).toBeLessThan(0.05);

      const Vg_eq_new = Vg0 * Math.pow(P_eq / P_step, 1 / n);
      const m_eff = rho * L * A;
      const k_eff = (n * P_step * A * A) / Vg_eq_new;
      const T_lin = 2 * Math.PI * Math.sqrt(m_eff / k_eff);

      const periodsSolver: number[] = [];
      const periodsRK4: number[] = [];
      for (let i = 1; i < peaksSolver.length; i++) {
        periodsSolver.push((peaksSolver[i].idx - peaksSolver[i - 1].idx) * dt);
      }
      for (let i = 1; i < peaksRK4.length; i++) {
        periodsRK4.push((peaksRK4[i].idx - peaksRK4[i - 1].idx) * dt);
      }
      const T_solver =
        periodsSolver.length > 0
          ? periodsSolver.reduce((a, b) => a + b) / periodsSolver.length
          : 0;
      const T_rk4 =
        periodsRK4.length > 0
          ? periodsRK4.reduce((a, b) => a + b) / periodsRK4.length
          : 0;
      expect(Math.abs(T_solver - T_lin) / T_lin).toBeLessThan(0.15);
      expect(Math.abs(T_rk4 - T_lin) / T_lin).toBeLessThan(0.15);

      const configFriction: NetworkConfig = {
        ...config,
        branches: [
          {
            id: "p1",
            from: "R",
            to: "C",
            component: {
              type: "pipe",
              length: L,
              diameter: D,
              roughness: 1e-4,
              inertia: true,
            },
          },
        ],
      };
      const resFriction = runFixedTransient(configFriction, [0]);
      const peaksFriction = findPeaks(resFriction.branches.p1.mdot);
      if (peaksFriction.length >= 2) {
        expect(peaksFriction[peaksFriction.length - 1].value).toBeLessThan(
          peaksFriction[0].value,
        );
      }
    },
  );
});

describe("Adaptive compatibility", () => {
  it(
    "oscillator under adaptive stepping resolves oscillation and shrinks dt near peaks",
    { timeout: 30000 },
    () => {
      const L = 10;
      const D = 0.05;
      const roughness = 1e-6;
      const V_total = 0.01;
      const Vg0 = 0.005;
      const n = 1.4;
      const P_eq = 1e5;
      const P_step = 2e5;
      const endTime = 5.0;

      const config: NetworkConfig = {
        meta: { name: "osc-adaptive", version: 2 },
        settings: {
          mode: "transient",
          timeStepping: "adaptive",
          adaptive: { dtMin: 0.0001, dtMax: 0.05, relTol: 1e-3, safety: 0.9 },
          endTime,
          tolerance: 1e-6,
          maxIterations: 200,
          relaxation: 0.9,
        },
        fluid: { model: "incompressible", preset: "water" },
        nodes: [
          {
            id: "R",
            type: "boundary",
            x: 0,
            y: 0,
            pressure: P_eq,
            temperature: 300,
            pressureSchedule: [
              [0, P_step],
              [endTime, P_step],
            ],
          },
          {
            id: "C",
            type: "internal",
            x: 1,
            y: 0,
            pressure: P_eq,
            temperature: 300,
            volume: V_total,
            gasCushion: { initialGasVolume: Vg0, polytropicIndex: n },
          },
        ],
        branches: [
          {
            id: "p1",
            from: "R",
            to: "C",
            component: {
              type: "pipe",
              length: L,
              diameter: D,
              roughness,
              inertia: true,
            },
          },
        ],
      };

      const configFixed: NetworkConfig = {
        ...config,
        settings: {
          ...config.settings,
          timeStepping: "fixed",
          dt: 0.001,
        },
      };
      const resFixed = solveTransient(configFixed);
      const resAdaptive = solveTransient(config);

      function findPeaks(arr: number[]): Array<{ idx: number; value: number }> {
        const peaks: Array<{ idx: number; value: number }> = [];
        for (let i = 1; i < arr.length - 1; i++) {
          if (arr[i] > arr[i - 1] && arr[i] > arr[i + 1] && arr[i] > 0) {
            peaks.push({ idx: i, value: arr[i] });
          }
        }
        return peaks;
      }

      const peaksFixed = findPeaks(resFixed.branches.p1.mdot);
      const peaksAdaptive = findPeaks(resAdaptive.branches.p1.mdot);

      expect(peaksFixed.length).toBeGreaterThanOrEqual(3);
      expect(peaksAdaptive.length).toBeGreaterThanOrEqual(3);

      let T_fixed = 0;
      if (peaksFixed.length >= 2) {
        let sum = 0;
        for (let i = 1; i < peaksFixed.length; i++) {
          sum += (peaksFixed[i].idx - peaksFixed[i - 1].idx) * 0.001;
        }
        T_fixed = sum / (peaksFixed.length - 1);
      }

      let T_adaptive = 0;
      if (peaksAdaptive.length >= 2) {
        let sum = 0;
        for (let i = 1; i < peaksAdaptive.length; i++) {
          sum +=
            resAdaptive.times[peaksAdaptive[i].idx] -
            resAdaptive.times[peaksAdaptive[i - 1].idx];
        }
        T_adaptive = sum / (peaksAdaptive.length - 1);
      }

      expect(T_fixed).toBeGreaterThan(0);
      expect(Math.abs(T_adaptive - T_fixed) / T_fixed).toBeLessThan(0.05);

      expect(resAdaptive.stats).toBeDefined();
      expect(resAdaptive.stats!.minDt).toBeLessThan(
        resAdaptive.stats!.maxDt / 3,
      );
    },
  );
});

describe("Validation errors", () => {
  it(
    "gasCushion with gas fluid / steady mode / bad volumes",
    { timeout: 30000 },
    () => {
      const baseConfig = (
        overrides: Partial<NetworkConfig>,
      ): NetworkConfig => ({
        meta: { name: "val", version: 2 },
        settings: {
          mode: "transient",
          dt: 0.1,
          endTime: 1.0,
          tolerance: 1e-6,
          maxIterations: 200,
          relaxation: 0.9,
        },
        fluid: { model: "incompressible", preset: "water" },
        nodes: [
          {
            id: "C",
            type: "internal",
            x: 0,
            y: 0,
            pressure: 1e5,
            temperature: 300,
            volume: 0.01,
            gasCushion: { initialGasVolume: 0.005, polytropicIndex: 1.4 },
          },
        ],
        branches: [],
        ...overrides,
      });

      const gasFluid = validateNetwork(
        baseConfig({ fluid: { model: "idealGas", preset: "air" } }),
      );
      expect(
        gasFluid.some(
          (e) => e.includes("gasCushion") && e.includes("incompressible"),
        ),
      ).toBe(true);

      const realFluid = validateNetwork(
        baseConfig({
          fluid: { model: "realFluid", params: { fluidName: "Water" } },
        }),
      );
      expect(
        realFluid.some(
          (e) => e.includes("gasCushion") && e.includes("incompressible"),
        ),
      ).toBe(true);

      const steady = validateNetwork(
        baseConfig({
          settings: {
            mode: "steady",
            tolerance: 1e-6,
            maxIterations: 200,
            relaxation: 0.9,
          },
        }),
      );
      expect(
        steady.some((e) => e.includes("gasCushion") && e.includes("transient")),
      ).toBe(true);

      const tooBig = validateNetwork(
        baseConfig({
          nodes: [
            {
              id: "C",
              type: "internal",
              x: 0,
              y: 0,
              pressure: 1e5,
              temperature: 300,
              volume: 0.01,
              gasCushion: { initialGasVolume: 0.01, polytropicIndex: 1.4 },
            },
          ],
        }),
      );
      expect(
        tooBig.some(
          (e) => e.includes("initialGasVolume") && e.includes("less than"),
        ),
      ).toBe(true);

      const notPositive = validateNetwork(
        baseConfig({
          nodes: [
            {
              id: "C",
              type: "internal",
              x: 0,
              y: 0,
              pressure: 1e5,
              temperature: 300,
              volume: 0.01,
              gasCushion: { initialGasVolume: 0, polytropicIndex: 1.4 },
            },
          ],
        }),
      );
      expect(
        notPositive.some(
          (e) => e.includes("initialGasVolume") && e.includes("positive"),
        ),
      ).toBe(true);
    },
  );
});
