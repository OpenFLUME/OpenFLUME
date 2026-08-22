/**
 * Static model formula bindings (core/paramBindings.ts): formula objects
 * `{ expr }` at the v1 allowlist of geometry-like fields, resolved ONCE at
 * validation/solve entry against the static model scope.
 */
import { describe, it, expect } from "vitest";
import type { NetworkConfig } from "../schema";
import {
  isParameterExpression,
  previewNetworkParameters,
  evaluateStaticExpression,
  resolveNetworkParameters,
} from "../paramBindings";
import { validateNetwork } from "../validate";
import { decodeNetworkConfig, ConfigDecodeError } from "../config";
import { solveSteady } from "../solver";
import { solveTransient } from "../transient";

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

/** Minimal steady network: boundary a —pipe seg1— boundary b. */
function steadyBase(): NetworkConfig {
  return {
    meta: { name: "bindings", version: 2 },
    settings: { mode: "steady", tolerance: 1e-8, maxIterations: 100 },
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
        x: 2,
        y: 0,
        pressure: 1e5,
        temperature: 300,
      },
    ],
    branches: [
      {
        id: "seg1",
        from: "a",
        to: "b",
        component: { type: "pipe", length: 2, diameter: 0.05, roughness: 1e-5 },
      },
    ],
  };
}

/** Steady network with an internal node, a heated pipe, and conductors. */
function thermalBase(): NetworkConfig {
  return {
    meta: { name: "bindings-thermal", version: 2 },
    settings: { mode: "steady", tolerance: 1e-8, maxIterations: 100 },
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
      { id: "n1", type: "internal", x: 1, y: 0, volume: 1e-3 },
      {
        id: "b",
        type: "boundary",
        x: 2,
        y: 0,
        pressure: 1e5,
        temperature: 300,
      },
    ],
    solidNodes: [
      {
        id: "wall",
        type: "solid",
        x: 1,
        y: 1,
        temperature: 350,
        mass: 2,
        cp: 385,
      },
      { id: "amb", type: "ambient", x: 0, y: 1, temperature: 290 },
    ],
    conductors: [
      {
        id: "c1",
        from: "wall",
        to: "amb",
        type: { kind: "conduction", k: 200, area: 0.01, length: 0.05 },
      },
    ],
    branches: [
      {
        id: "seg1",
        from: "a",
        to: "n1",
        component: { type: "pipe", length: 1, diameter: 0.05, roughness: 1e-5 },
      },
      {
        id: "seg2",
        from: "n1",
        to: "b",
        component: {
          type: "heatedPipe",
          length: 1,
          diameter: 0.05,
          roughness: 1e-5,
          ua: 40,
          wallTemperature: 350,
        },
      },
    ],
  };
}

const PIPE_D = 0.05;
const pipeArea = (Math.PI * PIPE_D * PIPE_D) / 4;

/** Bind `field` of fluid node `id` to `expr` (test helper, type-safe). */
function bindNode(config: NetworkConfig, id: string, expr: string): void {
  const node = config.nodes.find((n) => n.id === id)!;
  node.volume = { expr };
}

function bindComponent(
  config: NetworkConfig,
  id: string,
  field: string,
  expr: string,
): void {
  const branch = config.branches.find((b) => b.id === id)!;
  (branch.component as unknown as Record<string, unknown>)[field] = { expr };
}

function bindConductor(
  config: NetworkConfig,
  id: string,
  field: string,
  expr: string,
): void {
  const conductor = (config.conductors ?? []).find((c) => c.id === id)!;
  (conductor.type as unknown as Record<string, unknown>)[field] = { expr };
}

/* ------------------------------------------------------------------ */
/* Fast path                                                           */
/* ------------------------------------------------------------------ */

describe("resolveNetworkParameters fast path", () => {
  it("returns the SAME config reference and an empty map when no formulas are present", () => {
    const config = thermalBase();
    const r = resolveNetworkParameters(config);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.config).toBe(config); // identity, not just equality
    expect(r.resolved).toEqual({});
  });

  it("previewNetworkParameters shares the fast path", () => {
    const config = steadyBase();
    const r = previewNetworkParameters(config);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.config).toBe(config);
  });

  it("evaluateStaticExpression reads derived pipe geometry from literals", () => {
    const config = steadyBase();
    const r = evaluateStaticExpression(config, "pipe('seg1').volume");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBeCloseTo(2 * Math.PI * 0.05 * 0.05 * 0.25, 12);
  });
});

/* ------------------------------------------------------------------ */
/* Resolution correctness                                              */
/* ------------------------------------------------------------------ */

describe("resolveNetworkParameters", () => {
  it("resolves scalar Property Panel values and their dependencies", () => {
    const config = thermalBase();
    (config.solidNodes![0] as unknown as Record<string, unknown>).mass = {
      expr: "3",
    };
    (config.nodes[1] as unknown as Record<string, unknown>).heatInput = {
      expr: "solid('wall').mass * 10",
    };
    bindComponent(config, "seg1", "roughness", "2e-5");
    bindComponent(
      config,
      "seg2",
      "wallTemperature",
      "node('a').temperature + 25",
    );

    const resolved = resolveNetworkParameters(config);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.config.solidNodes![0].mass).toBe(3);
    expect(resolved.config.nodes[1].heatInput).toBe(30);
    expect(resolved.config.branches[0].component).toMatchObject({
      roughness: 2e-5,
    });
    expect(resolved.config.branches[1].component).toMatchObject({
      wallTemperature: 325,
    });
  });

  it("resolves pipe-derived volume and surface area numerically", () => {
    const config = thermalBase();
    bindNode(config, "n1", "pipe('seg1').volume");
    bindConductor(config, "c1", "area", "pipe('seg1').surfaceArea");
    const r = resolveNetworkParameters(config);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const L1 = 1; // seg1 length in thermalBase
    const expectedVolume = pipeArea * L1;
    const expectedSurface = Math.PI * PIPE_D * L1;
    expect(r.resolved["node 'n1'.volume"]).toBe(expectedVolume);
    expect(r.resolved["conductor 'c1'.area"]).toBe(expectedSurface);
    expect(r.config.nodes.find((n) => n.id === "n1")!.volume).toBe(
      expectedVolume,
    );
    const c1 = r.config.conductors![0];
    expect(c1.type.kind === "conduction" && c1.type.area).toBe(expectedSurface);
  });

  it("resolves a conduction-k formula against registers", () => {
    const config = thermalBase();
    config.registers = { hgThroat: 12000, bartzExp: 0.9 };
    bindConductor(
      config,
      "c1",
      "k",
      "reg('hgThroat') / (2.5 ^ reg('bartzExp'))",
    );
    const r = resolveNetworkParameters(config);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const expected = 12000 / 2.5 ** 0.9;
    expect(r.resolved["conductor 'c1'.k"]).toBeCloseTo(expected, 12);
    const c1 = r.config.conductors![0];
    expect(c1.type.kind === "conduction" && c1.type.k).toBeCloseTo(
      expected,
      12,
    );
    expect(validateNetwork(config)).toEqual([]);
  });

  it("exposes pipe area / heatedPipe extras / bend / branch / node z / solid / reg", () => {
    const config = thermalBase();
    config.registers = { gain: 2.5 };
    config.nodes[0].position = { z: 3 };
    config.branches.push({
      id: "elbow",
      from: "a",
      to: "b",
      component: { type: "bend", diameter: 0.02, angle: 90, rOverD: 1.5 },
    });
    bindNode(
      config,
      "n1",
      [
        "pipe('seg1').area", //  π d²/4
        "heatedPipe('seg2').ua * 0.001", // stored numeric
        "bend('elbow').area", // derived from diameter
        "branch('seg2').diameter", // generic stored-property accessor
        "node('a').z",
        "solid('wall').mass",
        "reg('gain')",
      ].join(" + "),
    );
    const r = resolveNetworkParameters(config);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const expected =
      pipeArea + // pipe area (seg1 d = 0.05)
      40 * 0.001 +
      (Math.PI * 0.02 * 0.02) / 4 +
      0.05 +
      3 +
      2 +
      2.5;
    expect(r.resolved["node 'n1'.volume"]).toBeCloseTo(expected, 12);
  });

  it("supports convection correlation sub-fields (correlation.diameter / flowArea)", () => {
    const config = thermalBase();
    (config.conductors as NonNullable<NetworkConfig["conductors"]>)[0] = {
      id: "cv",
      from: "a",
      to: "wall",
      type: {
        kind: "convection",
        h: 50,
        area: 0.02,
        correlation: {
          model: "dittusBoelter",
          diameter: 0.05,
          flowArea: {
            expr: "circleArea(conductor('cv').correlation.diameter)",
          },
        },
      },
    };
    bindConductor(
      config,
      "cv",
      "area",
      "conductor('cv').correlation.flowArea * 2",
    );
    const r = resolveNetworkParameters(config);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.resolved["conductor 'cv'.correlation.flowArea"]).toBeCloseTo(
      pipeArea,
      12,
    );
    expect(r.resolved["conductor 'cv'.area"]).toBeCloseTo(2 * pipeArea, 12);
  });

  it("resolves chained dependencies (pipe diameter → node volume → conductor area)", () => {
    const config = thermalBase();
    bindComponent(config, "seg1", "diameter", "0.04 + 0.01");
    bindNode(config, "n1", "pipe('seg1').volume"); // depends on seg1.length (literal) + seg1.diameter (bound)
    bindConductor(config, "c1", "area", "node('n1').volume * 10");
    const r = resolveNetworkParameters(config);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = 0.05;
    const expectedVolume = ((Math.PI * d * d) / 4) * 1;
    expect(r.resolved["branch 'seg1'.diameter"]).toBe(d);
    expect(r.resolved["node 'n1'.volume"]).toBeCloseTo(expectedVolume, 12);
    expect(r.resolved["conductor 'c1'.area"]).toBeCloseTo(
      expectedVolume * 10,
      12,
    );
    // The resolved clone carries plain numbers everywhere.
    const seg1 = r.config.branches.find((b) => b.id === "seg1")!;
    expect(seg1.component.type === "pipe" && seg1.component.diameter).toBe(d);
  });

  it("resolves physical-coordinate formulas before deriving geometry", () => {
    const config = steadyBase();
    config.nodes[0].position = { x: { expr: "0" }, z: { expr: "1" } };
    config.nodes[1].position = {
      x: { expr: "node('a').position.x + pipe('seg1').length" },
      z: { expr: "node('a').z + 3" },
    };
    config.solidNodes = [
      {
        id: "wall",
        type: "ambient",
        x: 1,
        y: 1,
        position: { x: { expr: "node('b').position.x" }, y: { expr: "0" } },
        temperature: 300,
      },
    ];

    const r = resolveNetworkParameters(config);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.config.nodes[0].position).toEqual({ x: 0, z: 1 });
    expect(r.config.nodes[1].position).toEqual({ x: 2, z: 4 });
    expect(r.config.solidNodes![0].position).toEqual({ x: 2, y: 0 });
    expect(r.resolved["node 'b'.position.x"]).toBe(2);
    expect(r.resolved["node 'b'.position.z"]).toBe(4);
    expect(r.config.branches[0].component).toMatchObject({
      elevationChange: 3,
    });
  });

  it("provides circleArea / circleDiameter / cylinderVolume / cylinderArea helpers and builtins", () => {
    const config = thermalBase();
    bindNode(
      config,
      "n1",
      "circleArea(0.1) + circleDiameter(circleArea(0.1)) + cylinderVolume(2, 0.1) + cylinderArea(2, 0.1) + sqrt(4) + pi * 0",
    );
    const r = resolveNetworkParameters(config);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const expected =
      (Math.PI * 0.01) / 4 + // circleArea(0.1)
      0.1 + // circleDiameter(circleArea(0.1)) round-trips
      (2 * (Math.PI * 0.01)) / 4 + // cylinderVolume
      Math.PI * 0.1 * 2 + // cylinderArea
      2;
    expect(r.resolved["node 'n1'.volume"]).toBeCloseTo(expected, 12);
  });
});

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

describe("parameter binding errors", () => {
  it("rejects unknown ids with the field path in the message", () => {
    const config = steadyBase();
    bindComponent(config, "seg1", "length", "pipe('nope').volume");
    const r = resolveNetworkParameters(config);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0]).toContain("branch 'seg1'.length");
    expect(r.errors[0]).toContain("unknown branch 'nope'");
  });

  it("rejects unknown properties", () => {
    const config = steadyBase();
    bindComponent(config, "seg1", "length", "pipe('seg1').pressure");
    const r = resolveNetworkParameters(config);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0]).toContain(
      "pipe('seg1') has no static property 'pressure'",
    );
  });

  it("rejects entity type mismatches", () => {
    const config = steadyBase();
    config.branches.push({
      id: "orf",
      from: "a",
      to: "b",
      component: { type: "orifice", area: 1e-4, cd: 0.6 },
    });
    bindComponent(config, "seg1", "length", "pipe('orf').volume");
    const r = resolveNetworkParameters(config);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0]).toContain("type mismatch: branch 'orf' is a orifice");
  });

  it("reports parse errors with the binding path", () => {
    const config = steadyBase();
    bindComponent(config, "seg1", "length", "1 +* 2");
    const r = resolveNetworkParameters(config);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0]).toContain("branch 'seg1'.length");
  });

  it("rejects non-finite results (1/0) and non-number results", () => {
    const config = steadyBase();
    bindComponent(config, "seg1", "length", "1/0");
    bindComponent(config, "seg1", "diameter", "pipe('seg1')"); // object, not a number
    const r = resolveNetworkParameters(config);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.some((e) => e.includes("not a finite number"))).toBe(true);
    expect(r.errors.some((e) => e.includes("branch 'seg1'.diameter"))).toBe(
      true,
    );
  });

  it("detects self-cycles with a readable field path", () => {
    const config = steadyBase();
    bindComponent(config, "seg1", "length", "pipe('seg1').length + 1");
    const r = resolveNetworkParameters(config);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0]).toBe(
      "Parameter binding cycle: branch 'seg1'.length → branch 'seg1'.length",
    );
  });

  it("detects multi-field cycles as a readable chain", () => {
    const config = thermalBase();
    bindComponent(config, "seg1", "diameter", "node('n1').volume");
    bindNode(config, "n1", "pipe('seg1').volume");
    const r = resolveNetworkParameters(config);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0]).toContain("Parameter binding cycle:");
    expect(r.errors[0]).toContain("node 'n1'.volume");
    expect(r.errors[0]).toContain("branch 'seg1'.diameter");
  });

  it("enforces static-only scope: t, dt and solver state are unknown identifiers", () => {
    for (const expr of ["t", "dt", "1 + t * 2"]) {
      const config = steadyBase();
      bindComponent(config, "seg1", "length", expr);
      const r = resolveNetworkParameters(config);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errors[0]).toContain("Unknown identifier");
    }
  });

  it("rejects node('x').P-style state access (only volume/z are exposed)", () => {
    const config = steadyBase();
    bindComponent(config, "seg1", "length", "node('a').P");
    const r = resolveNetworkParameters(config);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0]).toContain("node('a') has no static property 'P'");
  });

  it("requires string-literal reference ids", () => {
    const config = steadyBase();
    bindComponent(config, "seg1", "length", "pipe('seg' + '1').volume");
    const r = resolveNetworkParameters(config);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0]).toContain("string-literal id");
  });

  it("reads only INITIAL registers (unknown names fail)", () => {
    const config = steadyBase();
    bindComponent(config, "seg1", "length", "reg('missing')");
    const r = resolveNetworkParameters(config);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0]).toContain("reg('missing') references unknown register");
  });

  it("rejects malformed formula objects at bindable positions", () => {
    const config = steadyBase();
    (
      config.branches[0].component as unknown as Record<string, unknown>
    ).length = { expr: 42 };
    const r = resolveNetworkParameters(config);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0]).toContain("branch 'seg1'.length");
    expect(r.errors[0]).toContain("expected a number or { expr: string }");
  });
});

/* ------------------------------------------------------------------ */
/* Immutability / determinism                                          */
/* ------------------------------------------------------------------ */

describe("resolution immutability and determinism", () => {
  it("never mutates the input and deep-freezes the resolved clone", () => {
    const config = thermalBase();
    bindNode(config, "n1", "pipe('seg1').volume");
    const snapshot = JSON.parse(JSON.stringify(config));
    const r = resolveNetworkParameters(config);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(config).toEqual(snapshot); // input untouched, formula preserved
    expect(Object.isFrozen(r.config)).toBe(true);
    expect(Object.isFrozen(r.config.nodes)).toBe(true);
    expect(Object.isFrozen(r.config.nodes.find((n) => n.id === "n1"))).toBe(
      true,
    );
    expect(() => {
      (r.config.nodes[2] as { volume: number }).volume = 99;
    }).toThrow();
  });

  it("is deterministic across repeated resolutions", () => {
    const config = thermalBase();
    bindComponent(config, "seg1", "diameter", "0.04 + 0.01");
    bindNode(config, "n1", "pipe('seg1').volume");
    const r1 = resolveNetworkParameters(config);
    const r2 = resolveNetworkParameters(config);
    expect(r1.ok && r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;
    expect(r1.resolved).toEqual(r2.resolved);
    expect(JSON.stringify(r1.config)).toBe(JSON.stringify(r2.config));
    expect(r1.config).not.toBe(r2.config); // independent clones
  });
});

/* ------------------------------------------------------------------ */
/* validateNetwork integration                                         */
/* ------------------------------------------------------------------ */

describe("validateNetwork with bindings", () => {
  it("returns formula errors instead of semantic errors when resolution fails", () => {
    const config = steadyBase();
    bindComponent(config, "seg1", "length", "pipe('ghost').volume");
    const errors = validateNetwork(config);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("Parameter binding");
  });

  it("runs range checks against RESOLVED values", () => {
    const config = steadyBase();
    bindComponent(config, "seg1", "diameter", "-0.5"); // resolves fine, invalid range
    const errors = validateNetwork(config);
    expect(errors).toEqual(["Pipe seg1 diameter must be positive"]);
  });

  it("passes when resolved values are valid, keeping the input formulas intact", () => {
    const config = thermalBase();
    bindNode(config, "n1", "pipe('seg1').volume");
    expect(validateNetwork(config)).toEqual([]);
    expect(
      isParameterExpression(config.nodes.find((n) => n.id === "n1")!.volume),
    ).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* Solver integration                                                  */
/* ------------------------------------------------------------------ */

describe("solver equivalence", () => {
  it("solveSteady on a bound config matches the equivalent literal config", () => {
    const literal = steadyBase();
    const bound = steadyBase();
    bindComponent(
      bound,
      "seg1",
      "diameter",
      "circleDiameter(circleArea(0.05))",
    );
    bindComponent(
      bound,
      "seg1",
      "length",
      "cylinderVolume(2, 0.05) / circleArea(0.05)",
    );
    const rLit = solveSteady(literal);
    const rBound = solveSteady(bound);
    expect(rBound.converged).toBe(true);
    expect(rBound.branches.seg1.mdot).toBe(rLit.branches.seg1.mdot);
    expect(rBound.nodes.a.pressure).toBe(rLit.nodes.a.pressure);
  });

  it("solveSteady throws a clear error on unresolvable bindings", () => {
    const config = steadyBase();
    bindComponent(config, "seg1", "length", "pipe('ghost').volume");
    expect(() => solveSteady(config)).toThrowError(
      /invalid parameter bindings/,
    );
  });

  it("solveTransient resolves node volumes from pipe geometry (bound === literal)", () => {
    const make = (bound: boolean): NetworkConfig => ({
      meta: { name: "bindings-transient", version: 2 },
      settings: {
        mode: "transient",
        dt: 0.01,
        endTime: 0.2,
        tolerance: 1e-8,
        maxIterations: 100,
      },
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
          id: "n1",
          type: "internal",
          x: 1,
          y: 0,
          pressure: 1.5e5,
          temperature: 300,
          volume: bound
            ? { expr: "pipe('p1').volume + pipe('p2').volume" }
            : 2 * pipeArea * 1,
        },
        {
          id: "b",
          type: "boundary",
          x: 2,
          y: 0,
          pressure: 1e5,
          temperature: 300,
        },
      ],
      branches: [
        {
          id: "p1",
          from: "a",
          to: "n1",
          component: {
            type: "pipe",
            length: 1,
            diameter: PIPE_D,
            roughness: 1e-5,
          },
        },
        {
          id: "p2",
          from: "n1",
          to: "b",
          component: {
            type: "pipe",
            length: 1,
            diameter: PIPE_D,
            roughness: 1e-5,
          },
        },
      ],
    });
    const rLit = solveTransient(make(false));
    const rBound = solveTransient(make(true));
    expect(rBound.converged).toBe(true);
    expect(rBound.times).toEqual(rLit.times);
    const pLit = rLit.nodes.n1.pressure;
    const pBound = rBound.nodes.n1.pressure;
    for (let i = 0; i < pLit.length; i++) {
      expect(pBound[i]).toBeCloseTo(pLit[i], 10);
    }
  });

  it("solveTransient throws a clear error on unresolvable bindings", () => {
    const config = steadyBase();
    config.settings = {
      mode: "transient",
      dt: 0.1,
      endTime: 1,
      tolerance: 1e-6,
      maxIterations: 100,
    };
    bindComponent(config, "seg1", "length", "node('missing').pressure");
    expect(() => solveTransient(config)).toThrowError(
      /invalid parameter bindings/,
    );
  });
});

/* ------------------------------------------------------------------ */
/* Decode boundary                                                     */
/* ------------------------------------------------------------------ */

describe("decodeNetworkConfig expression objects", () => {
  it("accepts well-formed { expr } at allowlisted positions without changing identity semantics", () => {
    const raw = JSON.parse(JSON.stringify(steadyBase())) as Record<
      string,
      unknown
    >;
    (raw.nodes as Array<Record<string, unknown>>)[0].volume; // boundary node: volume not required, still bindable
    (
      (raw.branches as Array<Record<string, unknown>>)[0].component as Record<
        string,
        unknown
      >
    ).length = { expr: "1 + 1" };
    const decoded = decodeNetworkConfig(raw);
    const comp = decoded.branches[0].component;
    expect(
      comp.type === "pipe" &&
        isParameterExpression(comp.length) &&
        comp.length.expr,
    ).toBe("1 + 1");
  });

  it("rejects { expr: <non-string> } with a ConfigDecodeError path", () => {
    const raw = JSON.parse(JSON.stringify(steadyBase())) as Record<
      string,
      unknown
    >;
    (
      (raw.branches as Array<Record<string, unknown>>)[0].component as Record<
        string,
        unknown
      >
    ).length = { expr: 42 };
    try {
      decodeNetworkConfig(raw);
      expect.unreachable("expected ConfigDecodeError");
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigDecodeError);
      expect((e as ConfigDecodeError).path).toBe(
        "branches[0].component.length.expr",
      );
    }
  });

  it("rejects non-number non-expression values at allowlisted positions", () => {
    const raw = JSON.parse(JSON.stringify(steadyBase())) as Record<
      string,
      unknown
    >;
    (raw.nodes as Array<Record<string, unknown>>)[0].volume = "big";
    try {
      decodeNetworkConfig(raw);
      expect.unreachable("expected ConfigDecodeError");
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigDecodeError);
      expect((e as ConfigDecodeError).path).toBe("nodes[0].volume");
    }
  });

  it("rejects malformed correlation sub-field expressions with a path", () => {
    const raw = JSON.parse(JSON.stringify(thermalBase())) as Record<
      string,
      unknown
    >;
    (raw.conductors as Array<Record<string, unknown>>)[0] = {
      id: "cv",
      from: "a",
      to: "wall",
      type: {
        kind: "convection",
        h: 50,
        area: 0.02,
        correlation: { model: "dittusBoelter", diameter: { expr: [1] } },
      },
    };
    try {
      decodeNetworkConfig(raw);
      expect.unreachable("expected ConfigDecodeError");
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigDecodeError);
      expect((e as ConfigDecodeError).path).toBe(
        "conductors[0].type.correlation.diameter.expr",
      );
    }
  });
});
