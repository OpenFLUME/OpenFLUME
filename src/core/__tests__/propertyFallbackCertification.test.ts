/**
 * safeStatePH's final fallback tier returns a physically wrong but finite
 * state so a CoolProp failure does not kill the solve (diagnostics.ts
 * `lastResort`). A step that consumed such a value anywhere — residual,
 * Jacobian, node update — is built on fiction and must not be certified,
 * whatever residual the iteration then reports.
 *
 * The tier is simulated by wrapping safeStatePH: the FIRST call records a
 * last-resort fallback and returns the fabricated state, every later call is
 * the real function. The Newton therefore converges normally from one bad
 * evaluation, which is exactly the case the guard exists for — without it
 * the step reports converged: true.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import type { NetworkConfig } from "../schema";

let fabricateNext = false;
vi.mock("../solver/safeProps", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../solver/safeProps")>();
  const { recordStatePHFallback } = await import("../diagnostics");
  return {
    ...actual,
    safeStatePH: (...args: Parameters<typeof actual.safeStatePH>) => {
      if (fabricateNext) {
        fabricateNext = false;
        recordStatePHFallback("lastResort");
        return {
          T: 300,
          rho: 100,
          quality: undefined,
          mu: 1e-5,
          cp: 1000,
          phase: "supercritical" as const,
        };
      }
      return actual.safeStatePH(...args);
    },
  };
});

import { initRealFluids, realFluidsReady } from "../";
import {
  buildSolverContext,
  createInitialState,
  solveStateStep,
} from "../solver";

beforeAll(async () => {
  await initRealFluids();
  expect(realFluidsReady()).toBe(true);
}, 30000);

/** Warm nitrogen vapour, far from the dome: a benign transient step. */
function nitrogenLine(): NetworkConfig {
  return {
    meta: { name: "n2 line", version: 2 },
    settings: {
      mode: "transient",
      dt: 0.01,
      endTime: 0.01,
      tolerance: 1e-6,
      maxIterations: 200,
      relaxation: 0.9,
    },
    fluid: { model: "realFluid", params: { fluidName: "Nitrogen" } },
    nodes: [
      {
        id: "in",
        type: "boundary",
        x: 0,
        y: 0,
        pressure: 5e5,
        temperature: 300,
      },
      {
        id: "mid",
        type: "internal",
        x: 1,
        y: 0,
        pressure: 4.5e5,
        temperature: 300,
        volume: 1e-3,
      },
      {
        id: "out",
        type: "boundary",
        x: 2,
        y: 0,
        pressure: 4e5,
        temperature: 300,
      },
    ],
    branches: [
      {
        id: "p1",
        from: "in",
        to: "mid",
        component: { type: "pipe", length: 1, diameter: 0.02, roughness: 1e-5 },
      },
      {
        id: "p2",
        from: "mid",
        to: "out",
        component: { type: "pipe", length: 1, diameter: 0.02, roughness: 1e-5 },
      },
    ],
  };
}

function step(
  cfg: NetworkConfig,
  opts: { transient: boolean; fabricateFirstEvaluation?: boolean },
) {
  const ctx = buildSolverContext(cfg);
  const state = createInitialState(ctx, cfg);
  // Armed only now: the initial state above also evaluates properties, and
  // those calls precede the step whose certification is under test.
  fabricateNext = opts.fabricateFirstEvaluation ?? false;
  return solveStateStep(ctx, state, {
    ...(opts.transient ? { dt: cfg.settings.dt, t: 0 } : {}),
    tol: cfg.settings.tolerance,
    maxIterations: cfg.settings.maxIterations,
    relaxation: cfg.settings.relaxation ?? 1,
  });
}

describe("last-resort property fallback", () => {
  it("control: the step certifies when every property evaluation is real", () => {
    const res = step(nitrogenLine(), { transient: false });
    expect(res.converged).toBe(true);
    expect(res.propertyFallbacks).toBeUndefined();
  });

  it("withdraws a steady solve's certification after one fabricated evaluation", () => {
    // Steady solves have no retry cascade, so the guarded attempt IS the
    // result: the Newton converges from the bad point, the flag says no.
    const res = step(nitrogenLine(), {
      transient: false,
      fabricateFirstEvaluation: true,
    });
    expect(fabricateNext).toBe(false); // the tier did fire
    expect(res.converged).toBe(false);
    expect(res.propertyFallbacks).toBe(1);
  });

  it("makes a transient retry cascade discard the tainted tier and re-solve", () => {
    // Transient real-fluid steps cascade over step-control tiers and take
    // the first one that certifies. The tainted first tier is refused, the
    // second tier sees only real properties and certifies cleanly — the
    // fabricated evaluation never reaches the accepted state.
    const res = step(nitrogenLine(), {
      transient: true,
      fabricateFirstEvaluation: true,
    });
    expect(fabricateNext).toBe(false);
    expect(res.converged).toBe(true);
    expect(res.propertyFallbacks).toBeUndefined();
  });
});
