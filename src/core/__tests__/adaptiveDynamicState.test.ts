/**
 * Adaptive step doubling controls EVERY dynamic state, not only node P/T.
 *
 *  - A branch with fluid inertia integrates ṁ as an ODE state; it enters the
 *    error norm (scaled by `adaptive.absTolMdot`).
 *  - A stateful component (DynamicCheckValve poppet) is advanced along both
 *    candidate trajectories, its motion enters the error norm, and a
 *    rejected candidate rolls it back — the step is a transaction.
 */
import { describe, it, expect } from "vitest";
import { solveTransient } from "../transient";
import type { NetworkConfig } from "../schema";
import { DynamicCheckValve } from "../components/dynamicCheckValve";
import {
  snapshotStatefulComponents,
  restoreStatefulComponents,
  statefulComponentState,
  advanceStatefulComponents,
} from "../transient/statefulComponents";
import type { SolverContext, StepState } from "../solver";

/** Water column behind a valve that ramps open: with inertia the mass flow
 *  is a dynamic state that the P/T channels alone barely see. */
function inertiaRamp(absTolMdot?: number): NetworkConfig {
  return {
    meta: { name: "inertia ramp", version: 2 },
    settings: {
      mode: "transient",
      endTime: 0.5,
      timeStepping: "adaptive",
      adaptive: {
        dtMin: 1e-4,
        dtMax: 0.05,
        dtInitial: 0.01,
        relTol: 1e-3,
        ...(absTolMdot !== undefined ? { absTolMdot } : {}),
      },
      tolerance: 1e-8,
      maxIterations: 200,
      relaxation: 0.9,
    },
    fluid: { model: "incompressible", preset: "water" },
    nodes: [
      {
        id: "tank",
        type: "boundary",
        x: 0,
        y: 0,
        pressure: 3e5,
        temperature: 300,
      },
      {
        id: "mid",
        type: "internal",
        x: 1,
        y: 0,
        pressure: 1e5,
        temperature: 300,
        volume: 1e-3,
      },
      {
        id: "out",
        type: "boundary",
        x: 2,
        y: 0,
        pressure: 1e5,
        temperature: 300,
      },
    ],
    branches: [
      {
        id: "valve",
        from: "tank",
        to: "mid",
        initialMdot: 0,
        component: {
          type: "valve",
          area: 5e-4,
          cd: 0.6,
          position: 0,
          positionSchedule: [
            [0, 0],
            [0.1, 0],
            [0.2, 1],
          ],
        },
      },
      {
        id: "line",
        from: "mid",
        to: "out",
        initialMdot: 0,
        component: {
          type: "pipe",
          length: 20,
          diameter: 0.026,
          roughness: 1.5e-6,
          inertia: true,
        },
      },
    ],
  };
}

describe("adaptive error norm: fluid-inertia mass flow", () => {
  it("tightening absTolMdot takes more, smaller steps and tracks a fine fixed-dt reference", () => {
    const loose = solveTransient(inertiaRamp(1e3)); // ṁ channel effectively off
    const tight = solveTransient(inertiaRamp(1e-6));
    expect(loose.converged).toBe(true);
    expect(tight.converged).toBe(true);
    expect(tight.stats!.steps).toBeGreaterThan(loose.stats!.steps);

    const reference = solveTransient({
      ...inertiaRamp(),
      settings: {
        ...inertiaRamp().settings,
        timeStepping: "fixed",
        dt: 1e-4,
        adaptive: undefined,
      },
    });
    const endOf = (r: typeof reference) => r.branches.line.mdot.at(-1)!;
    const errTight = Math.abs(endOf(tight) - endOf(reference));
    const errLoose = Math.abs(endOf(loose) - endOf(reference));
    expect(errTight).toBeLessThanOrEqual(errLoose);
  });
});

describe("adaptive end-time residue", () => {
  it("does not attempt a ~1e-16 s step when accumulated t lands ulps short of endTime", () => {
    // 0.05 + 0.05 + … does not sum to exactly 0.5; the driver used to treat
    // the residue as one more step. With a stiff inertia row that step
    // cannot converge, and the whole run was reported unconverged.
    const res = solveTransient(inertiaRamp(1e3));
    expect(res.converged).toBe(true);
    expect(res.times.at(-1)!).toBeCloseTo(0.5, 10);
    expect(res.stats!.steps).toBe(res.times.length - 1);
  });
});

describe("stateful components are transactional across candidates", () => {
  const valve = () =>
    new DynamicCheckValve(0.001, 0.6, 0.05, 5000, 50, 5, 0.005, undefined, 0);

  it("snapshot / restore round-trips the poppet state and dynamicState exposes the opening", () => {
    const v = valve();
    const snap = v.snapshotState();
    v.advanceState(0.01, 0, 3e5, 1e5);
    expect(v.position).toBeGreaterThan(0);
    expect(v.dynamicState()).toEqual([v.position]);
    v.restoreState(snap);
    expect(v.position).toBe(0);
    expect(v.v).toBe(0);
  });

  it("the transient helpers snapshot, advance and roll back every stateful branch", () => {
    const v = valve();
    const ctx = {
      branches: [
        { id: "dcv", from: "A", to: "B", component: v },
        { id: "p", from: "B", to: "C", component: { advanceState: undefined } },
      ],
    } as unknown as SolverContext;
    const state = {
      nodeP: new Map([
        ["A", 3e5],
        ["B", 1e5],
        ["C", 1e5],
      ]),
      mdots: [0, 0],
    } as unknown as StepState;

    const before = snapshotStatefulComponents(ctx);
    expect(before[1]).toBeUndefined();
    advanceStatefulComponents(ctx, state, 0.01);
    expect(statefulComponentState(ctx)).toEqual([v.position]);
    expect(v.position).toBeGreaterThan(0);
    restoreStatefulComponents(ctx, before);
    expect(statefulComponentState(ctx)).toEqual([0]);
  });

  it("adaptive stepping resolves a check valve's opening and agrees with fixed dt", () => {
    const base: NetworkConfig = {
      meta: { name: "dcv adaptive", version: 2 },
      settings: {
        mode: "transient",
        endTime: 0.05,
        tolerance: 1e-9,
        maxIterations: 500,
        relaxation: 0.9,
      },
      fluid: { model: "incompressible", preset: "water" },
      nodes: [
        {
          id: "A",
          type: "boundary",
          x: 0,
          y: 0,
          pressure: 200000,
          temperature: 300,
        },
        {
          id: "B",
          type: "boundary",
          x: 1,
          y: 0,
          pressure: 135000,
          temperature: 300,
        },
      ],
      branches: [
        {
          id: "dcv",
          from: "A",
          to: "B",
          component: {
            type: "dynamicCheckValve",
            area: 0.001,
            cd: 0.6,
            mass: 0.05,
            springRate: 5000,
            preload: 50,
            damping: 5,
            stroke: 0.005,
            initialPosition: 0,
          },
        },
      ],
    };
    const fixed = solveTransient({
      ...base,
      settings: { ...base.settings, dt: 0.0001 },
    });
    const adaptive = solveTransient({
      ...base,
      settings: {
        ...base.settings,
        timeStepping: "adaptive",
        adaptive: { dtMin: 1e-5, dtMax: 5e-3, dtInitial: 1e-3, relTol: 1e-3 },
      },
    });
    expect(adaptive.converged).toBe(true);
    // The poppet opens under the forward differential…
    const mdotEnd = adaptive.branches.dcv.mdot.at(-1)!;
    expect(mdotEnd).toBeGreaterThan(0);
    // …and the adaptive trajectory lands where the fine fixed-dt one does.
    const relDiff =
      Math.abs(mdotEnd - fixed.branches.dcv.mdot.at(-1)!) /
      Math.abs(fixed.branches.dcv.mdot.at(-1)!);
    expect(relDiff).toBeLessThan(0.05);
    // Rejected candidates happened (the opening is stiff) and did not leave
    // the poppet advanced: the accepted count equals the recorded steps.
    expect(adaptive.stats!.steps).toBe(adaptive.times.length - 1);
  });
});
