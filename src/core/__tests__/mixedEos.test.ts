/**
 * Mixed EOS classes in one network — an idealGas hot duct thermally coupled
 * through a solid wall to a realFluid (CoolProp Water) coolant loop.  The
 * regen-cooling topology that motivated lifting the "all fluids must share
 * the same EOS class" rule: unlike fluids never meet hydraulically (the
 * branch rule guarantees wall-only coupling), so correctness reduces to the
 * solver dispatching property access and state publishing per node.
 *
 * Physics bar shared by every solve mode:
 *   - the wall settles strictly BETWEEN the hot-gas and coolant node
 *     temperatures (conduction has no other path),
 *   - the hot gas cools below its inlet, the coolant warms above its inlet,
 *   - at steady state the wall stores nothing: Q(gas→wall) = Q(wall→coolant).
 */
import { describe, it, expect, beforeAll } from "vitest";
import type { NetworkConfig, SteadyResult } from "../schema";
import { initRealFluids, realFluidsReady } from "../";
import { validateNetwork } from "../validate";
import { solveSteady } from "../solver";
import { solveTransient } from "../transient";

beforeAll(async () => {
  await initRealFluids();
  expect(realFluidsReady()).toBe(true);
}, 30000);

/** Hot air (idealGas, default fluid) at 700 K over a wall cooled by liquid
 *  water (realFluid, named) at 300 K.  Tsat(2 bar) ≈ 393 K — the coolant
 *  node stays deeply subcooled at these heat rates. */
function gasOverWaterJacket(): NetworkConfig {
  return {
    meta: { name: "mixed-eos jacket", version: 2 },
    settings: {
      mode: "steady",
      tolerance: 1e-6,
      maxIterations: 300,
    },
    fluid: { model: "idealGas", preset: "air" },
    fluids: {
      h2o: { model: "realFluid", params: { fluidName: "Water" } },
    },
    nodes: [
      {
        id: "g_in",
        type: "boundary",
        x: 0,
        y: 1,
        pressure: 3.0e5,
        temperature: 700,
      },
      {
        id: "g",
        type: "internal",
        x: 1,
        y: 1,
        pressure: 2.95e5,
        temperature: 700,
        volume: 1e-3,
      },
      {
        id: "g_out",
        type: "boundary",
        x: 2,
        y: 1,
        pressure: 2.9e5,
        temperature: 700,
      },
      {
        id: "c_in",
        type: "boundary",
        x: 0,
        y: 0,
        pressure: 2.2e5,
        temperature: 300,
        fluid: "h2o",
      },
      {
        id: "c",
        type: "internal",
        x: 1,
        y: 0,
        pressure: 2.1e5,
        temperature: 300,
        volume: 1e-3,
        fluid: "h2o",
      },
      {
        id: "c_out",
        type: "boundary",
        x: 2,
        y: 0,
        pressure: 2.0e5,
        temperature: 300,
        fluid: "h2o",
      },
    ],
    solidNodes: [
      {
        id: "wall",
        type: "solid",
        x: 1,
        y: 0.5,
        temperature: 400,
        mass: 0.05,
        cp: 385,
      },
    ],
    conductors: [
      {
        id: "cv_g",
        from: "g",
        to: "wall",
        type: { kind: "convection", h: 400, area: 0.05 },
      },
      {
        id: "cv_c",
        from: "c",
        to: "wall",
        type: { kind: "convection", h: 800, area: 0.05 },
      },
    ],
    branches: [
      {
        id: "g1",
        from: "g_in",
        to: "g",
        component: {
          type: "pipe",
          length: 0.5,
          diameter: 0.02,
          roughness: 1e-5,
        },
      },
      {
        id: "g2",
        from: "g",
        to: "g_out",
        component: {
          type: "pipe",
          length: 0.5,
          diameter: 0.02,
          roughness: 1e-5,
        },
      },
      {
        id: "c1",
        from: "c_in",
        to: "c",
        component: {
          type: "pipe",
          length: 0.5,
          diameter: 0.01,
          roughness: 1e-5,
        },
      },
      {
        id: "c2",
        from: "c",
        to: "c_out",
        component: {
          type: "pipe",
          length: 0.5,
          diameter: 0.01,
          roughness: 1e-5,
        },
      },
    ],
  };
}

function expectJacketPhysics(res: SteadyResult): void {
  const Tg = res.nodes["g"].temperature;
  const Tc = res.nodes["c"].temperature;
  const Tw = res.solidNodes!["wall"].temperature;

  // Flow direction as configured (pressure-driven, both loops).
  expect(res.branches["g1"].mdot).toBeGreaterThan(0);
  expect(res.branches["c1"].mdot).toBeGreaterThan(0);

  // Heat path: hot gas above the wall, wall above the coolant.
  expect(Tg).toBeGreaterThan(Tw);
  expect(Tw).toBeGreaterThan(Tc);
  // Gas measurably cooled below its inlet, coolant measurably warmed.
  expect(Tg).toBeLessThan(699.5);
  expect(Tc).toBeGreaterThan(300.01);
  // Coolant stays liquid (deeply subcooled: Tsat(2 bar) ≈ 393 K).
  expect(Tc).toBeLessThan(390);
  expect(res.nodes["c"].density).toBeGreaterThan(900);

  // Steady wall stores nothing: the two conductor heat rates balance.
  // Conductor heatRate sign follows its from→to orientation, so the g→wall
  // and c→wall rates must be equal and opposite.
  const Qg = res.conductors!["cv_g"].heatRate;
  const Qc = res.conductors!["cv_c"].heatRate;
  expect(Qg).toBeGreaterThan(50); // a real heat duty, not numerical dust
  expect(Math.abs(Qg + Qc)).toBeLessThan(0.02 * Math.abs(Qg));
}

describe("mixed EOS — idealGas hot duct + realFluid water jacket", () => {
  it("validates: unlike EOS classes are accepted (wall-only coupling)", () => {
    expect(validateNetwork(gasOverWaterJacket())).toEqual([]);
  });

  it("steady segregated solve converges with per-node property dispatch", () => {
    const res = solveSteady(gasOverWaterJacket());
    expect(res.converged).toBe(true);
    expectJacketPhysics(res);
  });

  it("steady coupled h-system (kineticEnergy) carries both EOS classes", () => {
    const config = gasOverWaterJacket();
    config.settings.kineticEnergy = true;
    expect(validateNetwork(config)).toEqual([]);
    const res = solveSteady(config);
    expect(res.converged).toBe(true);
    expectJacketPhysics(res);

    // The coupled answer must agree with the segregated one to within the
    // genuine KE effect: the gas runs ≈ 120 m/s here, so stagnation-enthalpy
    // transport legitimately shifts the static gas temperature by ≲ 1 K
    // (measured 0.7 K); the wall and coolant follow by less.
    const ref = solveSteady(gasOverWaterJacket());
    expect(
      Math.abs(res.nodes["g"].temperature - ref.nodes["g"].temperature),
    ).toBeLessThan(1.5);
    expect(
      Math.abs(res.nodes["c"].temperature - ref.nodes["c"].temperature),
    ).toBeLessThan(0.5);
    expect(
      Math.abs(
        res.solidNodes!["wall"].temperature -
          ref.solidNodes!["wall"].temperature,
      ),
    ).toBeLessThan(1.0);
  });

  it("transient extended system marches the mixed network to the steady state", () => {
    const config = gasOverWaterJacket();
    config.settings = {
      ...config.settings,
      mode: "transient",
      dt: 0.05,
      endTime: 3.0,
      maxIterations: 200,
      relaxation: 0.7,
    };
    expect(validateNetwork(config)).toEqual([]);
    const res = solveTransient(config);
    expect(res.converged).toBe(true);

    const last = <T>(xs: T[]): T => xs[xs.length - 1];
    const steady = solveSteady(gasOverWaterJacket());
    // The slowest pole is the coolant node's flush time ρV/ṁ (a few
    // seconds), so at 3 s the march sits within ~1.3 K of the steady solve
    // and still approaching — a 1.5 K bar proves it is converging to the
    // right answer without an expensive long march.
    expect(
      Math.abs(
        last(res.solidNodes!["wall"].temperature) -
          steady.solidNodes!["wall"].temperature,
      ),
    ).toBeLessThan(1.5);
    expect(
      Math.abs(
        last(res.nodes["g"].temperature) - steady.nodes["g"].temperature,
      ),
    ).toBeLessThan(1.5);
    expect(
      Math.abs(
        last(res.nodes["c"].temperature) - steady.nodes["c"].temperature,
      ),
    ).toBeLessThan(1.5);
    // The transient records real-fluid extras for the coolant node.
    expect(last(res.nodes["c"].phase!)).toBe("liquid");
  });
});
