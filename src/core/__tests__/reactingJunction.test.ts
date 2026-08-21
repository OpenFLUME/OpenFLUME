/**
 * Reacting-junction tests (docs/combustion.md):
 *
 *   1. Thermochemistry model unit tests — createCombustionModel role
 *      mapping, CEA lookup plausibility, clamp flags, and the dual-number
 *      chamber-T0 path (primal identical to the scalar lookup; derivatives
 *      match central finite differences strictly inside a table cell, and
 *      honestly zero when clamped off the table).
 *   2. Validation rules — validate/junctions.ts, including the unlike-fluid
 *      exception for declared junction inlets (validate/branches.ts).
 *   3. Integration — the LOX/RP-1 thruster example solves with the junction
 *      closure inside the monolithic Newton system and matches the
 *      formula-coupled twin (basic-lox-rp1-thruster.fn) on Pc and mass
 *      flows; the junction summary is self-consistent (T = eta * T0,
 *      emergent c* near the CEA reference).
 *   4. Robustness — the motivating fix: the retired outer fixed-point loop
 *      diverged unless started essentially at its solution, so converging
 *      from strongly perturbed warm starts (mass flows x3 with the tiny
 *      solver default 0.1 kg/s per branch as a variant, feed/gas pressures
 *      x1.5) is asserted here.  Fully uniform P/T states are NOT asserted:
 *      the quasi-1D transonic nozzle discretization has multiple exact
 *      roots and a smooth pseudo-root near M = 1 (see docs/combustion.md);
 *      from far enough away Newton can land where no exact root exists.
 */
import { describe, it, expect } from "vitest";
import type { NetworkConfig } from "../schema";
import { decodeAndValidateNetwork } from "../config";
import { solveSteady } from "../solver";
import { createCombustionModel } from "../combustion/model";
import {
  lookupCombustionGas,
  lookupChamberT0Dual,
  combustionGasBounds,
} from "../combustion/combustionGas";
import { constant } from "../dual";
import { thrusterCombustor } from "../../ui/thrusterCombustor";

/* ==========================================================================
 * 1. Thermochemistry model
 * ========================================================================== */

const mdots = (ox: number, fuel: number) =>
  new Map([
    ["oxidizer", ox],
    ["fuel", fuel],
  ]);

describe("createCombustionModel (ceaTable)", () => {
  const model = createCombustionModel({
    type: "ceaTable",
    propellants: "lox-rp1",
  });

  it("requires the oxidizer and fuel roles", () => {
    expect([...model.requiredRoles].sort()).toEqual(["fuel", "oxidizer"]);
  });

  it("returns a plausible LOX/RP-1 chamber state at nominal conditions", () => {
    const { gas, clampedPc, clampedOf, of } = model.evaluate(
      1e6,
      mdots(2.6, 1.0),
    );
    expect(clampedPc).toBe(false);
    expect(clampedOf).toBe(false);
    expect(of).toBeCloseTo(2.6, 10);
    // Chamber equilibrium near stoichiometric LOX/RP-1 at 10 bar.
    expect(gas.T0).toBeGreaterThan(3200);
    expect(gas.T0).toBeLessThan(3600);
    expect(gas.gamma).toBeGreaterThan(1.08);
    expect(gas.gamma).toBeLessThan(1.25);
    expect(gas.cstar).toBeGreaterThan(1600);
    expect(gas.cstar).toBeLessThan(1900);
    // Self-consistency contract: cp = gamma/(gamma-1) * R exactly.
    expect(gas.cp).toBeCloseTo((gas.gamma / (gas.gamma - 1)) * gas.R, 8);
  });

  it("flags clamped lookups instead of extrapolating", () => {
    const bounds = combustionGasBounds("lox-rp1");
    const lowPc = model.evaluate(bounds.pcMinPa / 10, mdots(2.6, 1.0));
    expect(lowPc.clampedPc).toBe(true);
    const richOf = model.evaluate(1e6, mdots(bounds.ofMin / 2, 1.0));
    expect(richOf.clampedOf).toBe(true);
    // Clamped states still return the edge state, usable mid-iteration.
    expect(Number.isFinite(lowPc.gas.T0)).toBe(true);
    expect(Number.isFinite(richOf.gas.T0)).toBe(true);
  });

  it("survives degenerate mid-iteration mass flows (floored, not thrown)", () => {
    for (const [ox, fuel] of [
      [0, 0],
      [1, 0],
      [0, 1],
    ] as const) {
      const r = model.evaluate(1e6, mdots(ox, fuel));
      expect(Number.isFinite(r.gas.T0)).toBe(true);
      expect(r.gas.T0).toBeGreaterThan(0);
    }
  });

  it("chamberT0Dual primal equals evaluate().gas.T0", () => {
    for (const [pc, ox, fuel] of [
      [1e6, 2.6, 1.0],
      [5e5, 1.8, 1.0],
      [8e6, 3.4, 1.0],
    ] as const) {
      const scalar = model.evaluate(pc, mdots(ox, fuel)).gas.T0;
      const dual = model.chamberT0Dual(
        constant(pc),
        new Map([
          ["oxidizer", constant(ox)],
          ["fuel", constant(fuel)],
        ]),
      );
      expect(dual.v).toBe(scalar);
    }
  });
});

describe("lookupChamberT0Dual derivatives", () => {
  // Strictly inside a table cell (Pc grid is log-spaced from 2e5, O/F grid
  // has 0.125 spacing from 1.0) so central differences never cross a grid
  // line: bilinear interpolation is smooth there and dual must match FD.
  const PC = 1.0e6;
  const OF = 2.55;

  it("dT0/dPc matches central finite differences inside a cell", () => {
    const h = 50; // Pa — far smaller than the cell width (~2.5e5 Pa)
    const fd =
      (lookupCombustionGas("lox-rp1", PC + h, OF).state.T0 -
        lookupCombustionGas("lox-rp1", PC - h, OF).state.T0) /
      (2 * h);
    const dual = lookupChamberT0Dual("lox-rp1", { v: PC, d: 1 }, constant(OF));
    expect(dual.d).toBeCloseTo(fd, 10);
  });

  it("dT0/dOF matches central finite differences inside a cell", () => {
    const h = 1e-5;
    const fd =
      (lookupCombustionGas("lox-rp1", PC, OF + h).state.T0 -
        lookupCombustionGas("lox-rp1", PC, OF - h).state.T0) /
      (2 * h);
    const dual = lookupChamberT0Dual("lox-rp1", constant(PC), { v: OF, d: 1 });
    expect(dual.d).toBeCloseTo(fd, 6);
  });

  it("clamped lookups carry zero derivative in the clamped direction", () => {
    const bounds = combustionGasBounds("lox-rp1");
    const below = lookupChamberT0Dual(
      "lox-rp1",
      constant(PC),
      { v: bounds.ofMin / 2, d: 1 },
    );
    expect(below.d).toBe(0);
    const above = lookupChamberT0Dual(
      "lox-rp1",
      { v: bounds.pcMaxPa * 2, d: 1 },
      constant(OF),
    );
    expect(above.d).toBe(0);
  });
});

/* ==========================================================================
 * 2. Validation rules
 * ========================================================================== */

/** Minimal valid junction network: two feed tanks, two injector orifices
 *  meeting at a chamber (the junction), one product branch to an exhaust
 *  boundary.  The lox/fuel inlets connect unlike fluids to the gas node —
 *  legal ONLY because they are declared junction inlets. */
function miniJunctionNetwork(): NetworkConfig {
  return {
    meta: { name: "mini junction", version: 2 },
    settings: {
      mode: "steady",
      tolerance: 1e-8,
      maxIterations: 200,
      relaxation: 0.9,
      kineticEnergy: true,
    },
    fluid: {
      model: "idealGas",
      params: { R: 363.6, gamma: 1.127, mu: 0.000106, cp: 3236 },
    },
    fluids: {
      gas: {
        model: "idealGas",
        params: { R: 363.6, gamma: 1.127, mu: 0.000106, cp: 3236 },
      },
      lox: {
        model: "incompressible",
        params: { rho: 1141, mu: 0.000195, cp: 1700 },
      },
      rp1: {
        model: "incompressible",
        params: { rho: 810, mu: 0.0017, cp: 2000 },
      },
    },
    junctions: [
      {
        id: "jn",
        node: "chamber",
        inlets: [
          { branch: "oxIn", role: "oxidizer" },
          { branch: "fuelIn", role: "fuel" },
        ],
        model: { type: "ceaTable", propellants: "lox-rp1", efficiency: 0.94 },
        productFluid: "gas",
      },
    ],
    nodes: [
      {
        id: "loxTank",
        type: "boundary",
        x: 0,
        y: 0,
        pressure: 1.3e6,
        temperature: 90,
        fluid: "lox",
      },
      {
        id: "fuelTank",
        type: "boundary",
        x: 0,
        y: 100,
        pressure: 1.3e6,
        temperature: 300,
        fluid: "rp1",
      },
      {
        id: "chamber",
        type: "internal",
        x: 100,
        y: 50,
        pressure: 1e6,
        temperature: 3200,
        fluid: "gas",
      },
      {
        id: "exhaust",
        type: "boundary",
        x: 200,
        y: 50,
        pressure: 1e5,
        temperature: 2000,
        fluid: "gas",
      },
    ],
    branches: [
      {
        id: "oxIn",
        from: "loxTank",
        to: "chamber",
        component: { type: "orifice", area: 3.2e-5, cd: 0.65 },
      },
      {
        id: "fuelIn",
        from: "fuelTank",
        to: "chamber",
        component: { type: "orifice", area: 1.5e-5, cd: 0.65 },
      },
      {
        id: "out",
        from: "chamber",
        to: "exhaust",
        component: {
          type: "pipe",
          length: 0.1,
          diameter: 0.02,
          roughness: 0,
          frictionFactor: 0.02,
        },
      },
    ],
  };
}

function validationErrors(mutate: (cfg: NetworkConfig) => void): string[] {
  const cfg = miniJunctionNetwork();
  mutate(cfg);
  return decodeAndValidateNetwork(JSON.parse(JSON.stringify(cfg))).errors;
}

describe("junction validation", () => {
  it("accepts the minimal junction network (incl. unlike-fluid inlets)", () => {
    expect(validationErrors(() => {})).toEqual([]);
  });

  it("requires steady mode", () => {
    const errors = validationErrors((cfg) => {
      cfg.settings.mode = "transient";
      cfg.settings.dt = 0.01;
      cfg.settings.endTime = 0.1;
    });
    expect(errors.join("\n")).toMatch(/require settings\.mode "steady"/);
  });

  it("requires kineticEnergy (the coupled enthalpy system)", () => {
    const errors = validationErrors((cfg) => {
      delete cfg.settings.kineticEnergy;
    });
    expect(errors.join("\n")).toMatch(/require settings\.kineticEnergy/);
  });

  it("rejects a boundary junction node", () => {
    const errors = validationErrors((cfg) => {
      cfg.junctions![0].node = "exhaust";
    });
    expect(errors.join("\n")).toMatch(/must be internal/);
  });

  it("rejects an inlet branch that does not end at the junction node", () => {
    const errors = validationErrors((cfg) => {
      // Reverse the ox inlet: chamber -> loxTank.
      const b = cfg.branches.find((b) => b.id === "oxIn")!;
      b.from = "chamber";
      b.to = "loxTank";
    });
    expect(errors.join("\n")).toMatch(/must END at the junction node/);
  });

  it("requires every role the model consumes", () => {
    const errors = validationErrors((cfg) => {
      cfg.junctions![0].inlets = [{ branch: "oxIn", role: "oxidizer" }];
    });
    expect(errors.join("\n")).toMatch(/requires an inlet with role "fuel"/);
  });

  it("rejects unknown propellants", () => {
    const errors = validationErrors((cfg) => {
      cfg.junctions![0].model.propellants = "unobtainium" as never;
    });
    expect(errors.join("\n")).toMatch(/model\.propellants must be one of/);
  });

  it("rejects an out-of-range efficiency", () => {
    const errors = validationErrors((cfg) => {
      cfg.junctions![0].model.efficiency = 1.5;
    });
    expect(errors.join("\n")).toMatch(/efficiency must be a finite number/);
  });

  it("requires the product fluid to be a named idealGas entry", () => {
    const errors = validationErrors((cfg) => {
      cfg.fluids!.gas = {
        model: "incompressible",
        params: { rho: 1, mu: 1e-5, cp: 1000 },
      };
    });
    expect(errors.join("\n")).toMatch(/model must be "idealGas"/);
  });

  it("requires a product-stream branch besides the inlets", () => {
    const errors = validationErrors((cfg) => {
      cfg.branches = cfg.branches.filter((b) => b.id !== "out");
      cfg.nodes = cfg.nodes.filter((n) => n.id !== "exhaust");
    });
    expect(errors.join("\n")).toMatch(/no product-stream branch/);
  });

  it("still rejects unlike fluids on a NON-inlet branch", () => {
    const errors = validationErrors((cfg) => {
      // "out" connects gas -> gas; retarget it at the RP-1 tank.
      const b = cfg.branches.find((b) => b.id === "out")!;
      b.to = "fuelTank";
      cfg.nodes = cfg.nodes.filter((n) => n.id !== "exhaust");
    });
    expect(errors.length).toBeGreaterThan(0);
  });
});

/* ==========================================================================
 * 3 + 4. Integration and robustness — LOX/RP-1 thruster example
 * ==========================================================================
 *
 * Formula-coupled twin reference (basic-lox-rp1-thruster.fn, same feed
 * plumbing and nozzle with static injector formulas and fixed gas
 * properties): Pc = 986633 Pa, mdot_ox = 0.547247, mdot_fuel = 0.21048,
 * mdot_gas = 0.757727 kg/s.  The junction formulation replaces the fixed
 * gamma = 1.2 gas with the CEA state at the solved (Pc, O/F), so a few
 * percent shift against the twin is physics, not error.
 */

const TWIN = { pc: 986633, ox: 0.547247, fuel: 0.21048, gas: 0.757727 };
const THROAT_AREA = Math.PI * 0.02 * 0.02; // d = 0.04 m

function thrusterConfig(mutate?: (cfg: NetworkConfig) => void): NetworkConfig {
  const cfg = JSON.parse(JSON.stringify(thrusterCombustor)) as NetworkConfig;
  mutate?.(cfg);
  return cfg;
}

function solveThruster(mutate?: (cfg: NetworkConfig) => void) {
  const { config, errors } = decodeAndValidateNetwork(thrusterConfig(mutate));
  expect(errors).toEqual([]);
  return solveSteady(config);
}

describe("LOX/RP-1 thruster with reacting junction", () => {
  it("solves from the authored warm start and matches the formula twin", () => {
    const res = solveThruster();
    expect(res.converged).toBe(true);

    const jn = res.junctions?.mainCombustor;
    expect(jn).toBeDefined();
    if (!jn) return;

    // Against the formula-coupled twin.
    expect(Math.abs(jn.pc - TWIN.pc) / TWIN.pc).toBeLessThan(0.02);
    expect(
      Math.abs(jn.mdotByRole.oxidizer - TWIN.ox) / TWIN.ox,
    ).toBeLessThan(0.05);
    expect(Math.abs(jn.mdotByRole.fuel - TWIN.fuel) / TWIN.fuel).toBeLessThan(
      0.05,
    );
    expect(Math.abs(jn.mdotTotal - TWIN.gas) / TWIN.gas).toBeLessThan(0.05);

    // Junction summary self-consistency.
    expect(jn.clampedPc).toBe(false);
    expect(jn.clampedOf).toBe(false);
    expect(jn.of).toBeDefined();
    expect(jn.of!).toBeGreaterThan(2.4);
    expect(jn.of!).toBeLessThan(2.8);
    // Constant-cp ideal gas: h = eta * h(T0)  =>  T = eta * T0 exactly.
    expect(jn.productTemperature / jn.gas.T0).toBeCloseTo(0.9409, 4);
    // The chamber node state IS the junction state.
    expect(res.nodes.chamber.pressure).toBeCloseTo(jn.pc, 6);
    expect(res.nodes.chamber.temperature).toBeCloseTo(
      jn.productTemperature,
      6,
    );
    // Mass balance: both inlets plus nothing else feed the gas path.
    expect(res.branches.seg1.mdot).toBeCloseTo(jn.mdotTotal, 8);

    // Emergent c* = Pc*At/mdot against the CEA reference with the c*
    // efficiency (eta_cstar = 0.97, efficiency = 0.97^2 on enthalpy).
    // The discretized nozzle with friction chokes slightly off the ideal
    // 1-D value — 10 % is the honest bar (observed ~7 %).
    const cstarEmergent = (jn.pc * THROAT_AREA) / jn.mdotTotal;
    const cstarRef = 0.97 * jn.gas.cstar;
    expect(Math.abs(cstarEmergent - cstarRef) / cstarRef).toBeLessThan(0.1);
  });

  it("converges from strongly perturbed warm-start mass flows (x3)", () => {
    const res = solveThruster((cfg) => {
      for (const b of cfg.branches) {
        if (b.initialMdot !== undefined) b.initialMdot *= 3;
      }
    });
    expect(res.converged).toBe(true);
    const jn = res.junctions!.mainCombustor;
    expect(Math.abs(jn.pc - TWIN.pc) / TWIN.pc).toBeLessThan(0.02);
    expect(jn.of!).toBeGreaterThan(2.4);
    expect(jn.of!).toBeLessThan(2.8);
  });

  it("converges from x1.5 pressures with solver-default mass flows", () => {
    const res = solveThruster((cfg) => {
      for (const n of cfg.nodes) {
        if (n.type === "internal" && n.pressure !== undefined) {
          n.pressure *= 1.5;
        }
      }
      for (const b of cfg.branches) delete b.initialMdot;
    });
    expect(res.converged).toBe(true);
    const jn = res.junctions!.mainCombustor;
    expect(Math.abs(jn.pc - TWIN.pc) / TWIN.pc).toBeLessThan(0.02);
    expect(jn.of!).toBeGreaterThan(2.4);
    expect(jn.of!).toBeLessThan(2.8);
  });
});
