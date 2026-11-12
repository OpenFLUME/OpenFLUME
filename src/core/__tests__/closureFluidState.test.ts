/**
 * settings.closureFluidState ("lagged" closure fluid state) and
 * settings.maxOuterIterations (exposed outer-iteration cap).
 *
 * The reproducer is a 3-segment LN₂ transfer line whose custom h has a
 * steep but continuous dry-out taper in the node quality,
 * smoothstep(0.95, 1, quality).  Evaluated at the iterate's own quality
 * (the default), the outer coupling loop of the step where the first node
 * dries out swings between a wet and a dry iterate and runs to the cap.
 * Evaluated at the start-of-step fluid state, h depends only on the wall
 * temperature within the step and every step settles in a few outers.
 *
 * Counts only (outer iterations, cap hits) — no timing, so not load-flaky.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { initRealFluids } from "../fluids/coolprop";
import { solveTransient } from "../transient";
import { validateNetwork } from "../validate";
import type { NetworkConfig } from "../schema";

const TAPER_H =
  "quality >= 0 && quality <= 1" +
  " ? 100 + 20000*(1 - smoothstep(0.95, 1, quality))" +
  " : (rho > 100 ? 2000 : 3.66*k/D)";

/** Horizontal LN₂ line, N segments, warm walls, custom h `expression`. */
function taperLine(
  N: number,
  expression: string,
  endTime: number,
  settings: Partial<NetworkConfig["settings"]> = {},
): NetworkConfig {
  const L = 7;
  const D = 0.0102;
  const segL = L / N;
  const flowArea = (Math.PI / 4) * D * D;
  const nodes: NetworkConfig["nodes"] = [
    {
      id: "f0",
      type: "boundary",
      x: 0,
      y: 0,
      pressure: 373000,
      temperature: 88.4,
    },
  ];
  for (let i = 1; i <= N + 1; i++) {
    const end = i === 1 || i === N + 1;
    nodes.push({
      id: `f${i}`,
      type: "internal",
      x: 100 * i,
      y: 0,
      position: { x: (i - 1) * segL, y: 0, z: 0 },
      pressure: 373000 - (i - 1) * 900,
      temperature: 285,
      volume: flowArea * segL * (end ? 0.5 : 1),
    });
  }
  nodes.push({
    id: `f${N + 2}`,
    type: "boundary",
    x: 100 * (N + 2),
    y: 0,
    pressure: 373000 - N * 900,
    temperature: 300,
  });
  const branches: NetworkConfig["branches"] = [
    {
      id: "in",
      from: "f0",
      to: "f1",
      component: { type: "flowSource", massFlow: 0.0045 },
    },
  ];
  for (let i = 1; i <= N; i++) {
    branches.push({
      id: `pipe${i}`,
      from: `f${i}`,
      to: `f${i + 1}`,
      component: { type: "pipe", length: segL, diameter: D, roughness: 1.5e-6 },
    });
  }
  branches.push({
    id: "out",
    from: `f${N + 1}`,
    to: `f${N + 2}`,
    component: { type: "pipe", length: 0.05, diameter: D, roughness: 1.5e-6 },
  });
  const solidNodes: NonNullable<NetworkConfig["solidNodes"]> = [];
  const conductors: NonNullable<NetworkConfig["conductors"]> = [];
  for (let i = 0; i <= N; i++) {
    const end = i === 0 || i === N;
    solidNodes.push({
      id: `s${i}`,
      type: "solid",
      x: 100 * (i + 1),
      y: 80,
      temperature: 285,
      mass: 0.25 * (end ? 0.5 : 1),
      cp: { material: "stainless-steel-304" },
    });
    conductors.push({
      id: `conv${i}`,
      from: `f${i + 1}`,
      to: `s${i}`,
      type: {
        kind: "convection",
        area: Math.PI * D * segL * (end ? 0.5 : 1),
        correlation: { model: "custom", expression, diameter: D, flowArea },
      },
    });
  }
  return {
    meta: { name: "closure fluid state line", version: 2 },
    settings: {
      mode: "transient",
      tolerance: 1e-5,
      maxIterations: 200,
      relaxation: 0.7,
      endTime,
      dt: 0.25,
      timeStepping: "fixed",
      momentumFlux: true,
      kineticEnergy: true,
      ...settings,
    },
    fluid: { model: "realFluid", params: { fluidName: "Nitrogen" } },
    nodes,
    branches,
    solidNodes,
    conductors,
  } as NetworkConfig;
}

beforeAll(async () => {
  await initRealFluids();
});

describe("settings.closureFluidState", () => {
  it("lagged fluid state removes the dry-out outer oscillation", () => {
    // Cap well below the default so the grinding step stays cheap.
    const cap = 150;
    const current = solveTransient(
      taperLine(3, TAPER_H, 16, { maxOuterIterations: cap }),
    );
    const lagged = solveTransient(
      taperLine(3, TAPER_H, 16, {
        maxOuterIterations: cap,
        closureFluidState: "lagged",
      }),
    );
    const cur = current.stepOuterIterations!;
    const lag = lagged.stepOuterIterations!;
    expect(cur).toHaveLength(64);
    expect(lag).toHaveLength(64);

    // Default: the dry-out step runs to the cap.
    expect(current.outerCapSteps).toBeGreaterThanOrEqual(1);
    expect(Math.max(...cur)).toBeGreaterThanOrEqual(cap);

    // Lagged: no step comes near it, and the run certifies.
    expect(lagged.outerCapSteps).toBe(0);
    expect(Math.max(...lag)).toBeLessThan(20);
    expect(lagged.converged).toBe(true);
  }, 120_000);

  it('"current" and the default cap are the omitted settings, bit for bit', () => {
    const base = solveTransient(taperLine(3, TAPER_H, 1));
    const explicit = solveTransient(
      taperLine(3, TAPER_H, 1, {
        closureFluidState: "current",
        maxOuterIterations: 1000,
      }),
    );
    expect(explicit).toEqual(base);
    expect(base.outerCapSteps).toBe(0);
    expect(base.stepOuterIterations!.every((n) => n >= 1)).toBe(true);
  }, 60_000);

  it("lagged h reads the start-of-step fluid T and the current wall T", () => {
    // h = 1000 + Tf + 1e-3·Tw: the recorded coefficient of step k must be
    // built from the fluid temperature of step k−1 and the wall temperature
    // of step k (the recorder evaluates h without the outer-loop relaxation).
    const expr = "1000 + Tf + 0.001*Tw";
    const r = solveTransient(
      taperLine(3, expr, 1, { closureFluidState: "lagged" }),
    );
    const h = r.conductors!["conv1"].heatTransferCoeff!;
    const Tf = r.nodes["f2"].temperature;
    const Tw = r.solidNodes!["s1"].temperature;
    expect(h[0]).toBeCloseTo(1000 + Tf[0] + 0.001 * Tw[0], 9);
    for (let k = 1; k < h.length; k++) {
      expect(h[k]).toBeCloseTo(1000 + Tf[k - 1] + 0.001 * Tw[k], 9);
    }
    // The fluid did move, so this distinguishes lagged from current.
    expect(Math.abs(Tf[Tf.length - 1] - Tf[0])).toBeGreaterThan(1e-3);
  }, 60_000);
});

describe("settings validation", () => {
  const withSettings = (s: Record<string, unknown>) =>
    validateNetwork(
      taperLine(3, TAPER_H, 1, s as Partial<NetworkConfig["settings"]>),
    );

  it("accepts the documented values", () => {
    expect(withSettings({})).toEqual([]);
    expect(
      withSettings({ closureFluidState: "lagged", maxOuterIterations: 1 }),
    ).toEqual([]);
    expect(
      withSettings({ closureFluidState: "current", maxOuterIterations: 50 }),
    ).toEqual([]);
  });

  it("rejects an unknown closureFluidState", () => {
    const errs = withSettings({ closureFluidState: "explicit" });
    expect(errs.some((e) => e.includes("settings.closureFluidState"))).toBe(
      true,
    );
  });

  it.each([0, -3, 2.5, "10"])("rejects maxOuterIterations = %s", (value) => {
    const errs = withSettings({ maxOuterIterations: value });
    expect(errs.some((e) => e.includes("settings.maxOuterIterations"))).toBe(
      true,
    );
  });

  it("checks the values in steady mode too", () => {
    const errs = withSettings({ mode: "steady", maxOuterIterations: 0 });
    expect(errs.some((e) => e.includes("settings.maxOuterIterations"))).toBe(
      true,
    );
  });
});
