import { describe, it, expect } from "vitest";
import type { NetworkConfig } from "../types";
import {
  resolveNetworkParameters,
  solveSteady,
  validateNetwork,
} from "../../core";
import { configHash } from "../provenance";
import {
  createSweepJob,
  linspace,
  materializeSweepVariants,
  SweepDefinitionError,
  SWEEP_MAX_VARIANTS,
  validateSweepDefinition,
  type OptionSweepDefinition,
  type RangeSweepDefinition,
  type SweepDefinition,
} from "../sweep";

/** Minimal valid steady network (passes validateNetwork). */
function baseConfig(): NetworkConfig {
  return {
    meta: { name: "SweepVariants", version: 2 },
    settings: { mode: "steady", tolerance: 1e-8, maxIterations: 200 },
    fluid: { model: "incompressible", preset: "water" },
    nodes: [
      {
        id: "in",
        type: "boundary",
        x: 0,
        y: 0,
        pressure: 2e5,
        temperature: 300,
      },
      {
        id: "out",
        type: "boundary",
        x: 100,
        y: 0,
        pressure: 1e5,
        temperature: 300,
      },
    ],
    branches: [
      {
        id: "b1",
        from: "in",
        to: "out",
        component: { type: "valve", area: 1e-4, cd: 0.6, position: 0.5 },
      },
    ],
  };
}

const sweepOn = (
  target: SweepDefinition["target"],
  start: number,
  end: number,
  count: number,
): RangeSweepDefinition => ({
  target,
  start,
  end,
  count,
  spacing: "linear",
});

/**
 * Valid network with a wall and a correlation-driven convection conductor:
 * carries the categorical axes (cp material, heat-transfer model) and, by
 * omitting axialPosition, makes some correlation models legal and others
 * not — mixed-case option sweeps must report which models applied.
 */
function thermalConfig(): NetworkConfig {
  return {
    meta: { name: "SweepOptions", version: 2 },
    settings: { mode: "steady", tolerance: 1e-8, maxIterations: 200 },
    fluid: { model: "realFluid", params: { fluidName: "Nitrogen" } },
    nodes: [
      {
        id: "in",
        type: "boundary",
        x: 0,
        y: 0,
        pressure: 2e5,
        temperature: 300,
      },
      {
        id: "mid",
        type: "internal",
        x: 50,
        y: 0,
        pressure: 1.5e5,
        temperature: 300,
        volume: 1e-3,
      },
      {
        id: "out",
        type: "boundary",
        x: 100,
        y: 0,
        pressure: 1e5,
        temperature: 300,
      },
    ],
    branches: [
      {
        id: "b1",
        from: "in",
        to: "mid",
        component: { type: "pipe", length: 1, diameter: 0.02, roughness: 1e-5 },
      },
      {
        id: "b2",
        from: "mid",
        to: "out",
        component: { type: "pipe", length: 1, diameter: 0.02, roughness: 1e-5 },
      },
    ],
    solidNodes: [
      {
        id: "wall",
        type: "solid",
        x: 50,
        y: 40,
        temperature: 300,
        mass: 2,
        cp: 385,
      },
      { id: "amb", type: "ambient", x: 0, y: 40, temperature: 293 },
    ],
    conductors: [
      {
        id: "cwall",
        from: "mid",
        to: "wall",
        type: {
          kind: "convection",
          area: 0.05,
          correlation: { model: "dittusBoelter", diameter: 0.02 },
        },
      },
      {
        id: "cout",
        from: "wall",
        to: "amb",
        type: { kind: "conduction", k: 400, area: 0.01, length: 0.1 },
      },
    ],
  };
}

const optionSweep = (
  target: SweepDefinition["target"],
  optionIds: string[],
): OptionSweepDefinition => ({
  target,
  spacing: "options",
  optionIds,
});

describe("linspace", () => {
  it("produces inclusive evenly-spaced values with exact endpoints", () => {
    const v = linspace(0, 10, 5);
    expect(v).toEqual([0, 2.5, 5, 7.5, 10]);
    expect(v[0]).toBe(0);
    expect(v[v.length - 1]).toBe(10); // pinned exactly, no fp drift
  });

  it("defines count=1 as the start value", () => {
    expect(linspace(3, 9, 1)).toEqual([3]);
    expect(linspace(4, 4, 1)).toEqual([4]);
  });

  it("supports reversed and equal ranges", () => {
    expect(linspace(10, 0, 3)).toEqual([10, 5, 0]);
    expect(linspace(5, 5, 4)).toEqual([5, 5, 5, 5]);
  });

  it("is deterministic and rejects non-finite / non-integer inputs", () => {
    expect(linspace(0.1, 0.3, 3)).toEqual(linspace(0.1, 0.3, 3));
    expect(() => linspace(Number.NaN, 1, 3)).toThrow(SweepDefinitionError);
    expect(() => linspace(0, Number.POSITIVE_INFINITY, 3)).toThrow(
      SweepDefinitionError,
    );
    expect(() => linspace(0, 1, 2.5)).toThrow(SweepDefinitionError);
    expect(() => linspace(0, 1, 0)).toThrow(SweepDefinitionError);
  });
});

describe("validateSweepDefinition", () => {
  it("rejects non-finite endpoints, bad counts, and unresolvable targets without throwing", () => {
    const cfg = baseConfig();
    const target = sweepOn(
      { kind: "branch", id: "b1", field: "position" },
      0,
      1,
      5,
    ).target;
    const cases: SweepDefinition[] = [
      sweepOn(target, Number.NaN, 1, 5),
      sweepOn(target, 0, Number.POSITIVE_INFINITY, 5),
      sweepOn(target, 0, 1, 0),
      sweepOn(target, 0, 1, SWEEP_MAX_VARIANTS + 1),
      sweepOn(target, 0, 1, 2.5),
      sweepOn({ kind: "branch", id: "ghost", field: "position" }, 0, 1, 5),
      sweepOn({ kind: "branch", id: "b1", field: "length" }, 0, 1, 5),
      { ...sweepOn(target, 0, 1, 5), spacing: "log" as unknown as "linear" },
    ];
    for (const def of cases) {
      const r = validateSweepDefinition(cfg, def);
      expect(r.ok, JSON.stringify(def)).toBe(false);
      if (!r.ok) expect(r.errors.length).toBeGreaterThan(0);
    }
  });

  it("accepts the count bounds 1 and SWEEP_MAX_VARIANTS", () => {
    const cfg = baseConfig();
    const target = { kind: "settings", field: "tolerance" } as const;
    expect(
      validateSweepDefinition(cfg, sweepOn(target, 1e-8, 1e-6, 1)).ok,
    ).toBe(true);
    expect(
      validateSweepDefinition(
        cfg,
        sweepOn(target, 1e-8, 1e-6, SWEEP_MAX_VARIANTS),
      ).ok,
    ).toBe(true);
  });

  it("reports per-value validation errors instead of failing the whole sweep", () => {
    const cfg = baseConfig();
    // Valve position must stay in [0,1]: sweeping to 2 makes the last
    // variant invalid while the others stay valid.
    const r = validateSweepDefinition(
      cfg,
      sweepOn({ kind: "branch", id: "b1", field: "position" }, 0, 2, 5),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.values).toEqual([0, 0.5, 1, 1.5, 2]);
    expect(r.invalidValues.map((v) => v.index)).toEqual([3, 4]);
    expect(r.invalidValues[0].value).toBe(1.5);
    expect(r.invalidValues[0].errors.join(" ")).toMatch(
      /position must be in \[0,1\]/,
    );
    expect(r.descriptor.label).toBe("Valve b1 · position");
  });

  it("returns empty invalidValues when every variant config is valid", () => {
    const cfg = baseConfig();
    const r = validateSweepDefinition(
      cfg,
      sweepOn({ kind: "node", id: "in", field: "pressure" }, 1.5e5, 3e5, 4),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.invalidValues).toEqual([]);
  });
});

describe("option sweeps", () => {
  const materialTarget = {
    kind: "solidNode",
    id: "wall",
    field: "cp.material",
  } as const;
  const modelTarget = {
    kind: "conductor",
    id: "cwall",
    field: "correlation.model",
  } as const;

  it("the fixture itself is a valid model", () => {
    expect(validateNetwork(thermalConfig())).toEqual([]);
  });

  it("validates the selected option list, in the order chosen", () => {
    const cfg = thermalConfig();
    const r = validateSweepDefinition(
      cfg,
      optionSweep(materialTarget, [
        "stainless-steel-304",
        "current",
        "ofhc-copper",
      ]),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.values).toEqual(["stainless-steel-304", "current", "ofhc-copper"]);
    expect(r.invalidValues).toEqual([]);
    expect(r.descriptor.label).toBe("Solid node wall · cp material");
  });

  it("rejects an empty, over-long, duplicated, or unknown selection", () => {
    const cfg = thermalConfig();
    const cases: Array<[OptionSweepDefinition, RegExp]> = [
      [optionSweep(materialTarget, []), /at least one/],
      [
        optionSweep(
          materialTarget,
          Array.from({ length: SWEEP_MAX_VARIANTS + 1 }, (_, i) => `m${i}`),
        ),
        /limited to/,
      ],
      [
        optionSweep(materialTarget, ["ofhc-copper", "ofhc-copper"]),
        /more than once/,
      ],
      [optionSweep(materialTarget, ["unobtanium"]), /is not an option/],
    ];
    for (const [def, pattern] of cases) {
      const r = validateSweepDefinition(cfg, def);
      expect(r.ok, JSON.stringify(def)).toBe(false);
      if (!r.ok) expect(r.errors.join(" ")).toMatch(pattern);
    }
  });

  it("rejects an axis used the wrong way round", () => {
    const cfg = thermalConfig();
    const asRange = validateSweepDefinition(
      cfg,
      sweepOn(materialTarget, 0, 1, 3),
    );
    expect(asRange.ok).toBe(false);
    if (!asRange.ok)
      expect(asRange.errors.join(" ")).toMatch(
        /choice between options, not a range/,
      );

    const asOptions = validateSweepDefinition(
      cfg,
      optionSweep({ kind: "node", id: "in", field: "pressure" }, ["x"]),
    );
    expect(asOptions.ok).toBe(false);
    if (!asOptions.ok)
      expect(asOptions.errors.join(" ")).toMatch(
        /numeric range, not an option list/,
      );
  });

  it("reports options that fail model validation without failing the sweep", () => {
    const cfg = thermalConfig();
    // The conductor has no axialPosition, which the chilldown closures need.
    const r = validateSweepDefinition(
      cfg,
      optionSweep(modelTarget, [
        "dittusBoelter",
        "miropolskii",
        "darrHartwig",
        "ttWf",
      ]),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.invalidValues.map((v) => v.value)).toEqual([
      "darrHartwig",
      "ttWf",
    ]);
    expect(r.invalidValues[0].valueLabel).toBe("Darr–Hartwig");
    expect(r.invalidValues[0].errors.join(" ")).toMatch(/axialPosition/);
  });

  it("materializes one frozen variant per option, labelled and hashed", () => {
    const cfg = thermalConfig();
    const def = optionSweep(materialTarget, [
      "current",
      "ofhc-copper",
      "stainless-steel-304",
    ]);
    const variants = materializeSweepVariants(cfg, def);

    expect(variants.map((v) => v.value)).toEqual([
      "current",
      "ofhc-copper",
      "stainless-steel-304",
    ]);
    expect(variants.map((v) => v.valueLabel)).toEqual([
      "Current — 385 J/(kg·K)",
      "OFHC copper",
      "Stainless steel 304",
    ]);

    const cpOf = (i: number) =>
      variants[i].config.solidNodes!.find((s) => s.id === "wall")!.cp;
    expect(cpOf(0)).toBe(385);
    expect(cpOf(1)).toEqual({ material: "ofhc-copper" });
    expect(cpOf(2)).toEqual({ material: "stainless-steel-304" });

    for (const v of variants) {
      expect(Object.isFrozen(v.config)).toBe(true);
      expect(v.configHash).toBe(configHash(v.config));
    }
    expect(new Set(variants.map((v) => v.configHash)).size).toBe(3);
    // Deterministic: the same selection re-materializes to the same hashes.
    expect(materializeSweepVariants(cfg, def).map((v) => v.configHash)).toEqual(
      variants.map((v) => v.configHash),
    );
    // The base config is untouched.
    expect(cfg.solidNodes!.find((s) => s.id === "wall")!.cp).toBe(385);
  });

  it("carries option labels into the job records", () => {
    const job = createSweepJob({
      id: "opt-job",
      baseConfig: thermalConfig(),
      definition: optionSweep(modelTarget, ["dittusBoelter", "miropolskii"]),
      now: 1,
    });
    expect(job.targetLabel).toBe("Convection cwall · heat-transfer model");
    expect(job.variants.map((v) => v.valueLabel)).toEqual([
      "Dittus–Boelter",
      "Miropolskii",
    ]);
    expect(job.progress).toEqual({ completed: 0, total: 2 });
  });
});

describe("materializeSweepVariants", () => {
  it("materializes frozen snapshots with deterministic hashes", () => {
    const cfg = baseConfig();
    const def = sweepOn(
      { kind: "branch", id: "b1", field: "position" },
      0.1,
      0.9,
      5,
    );
    const variants = materializeSweepVariants(cfg, def);
    expect(variants.map((v) => v.index)).toEqual([0, 1, 2, 3, 4]);
    // Midpoints follow start + step*i float arithmetic (deterministic);
    // endpoints are pinned exactly.
    for (const [i, expected] of [0.1, 0.3, 0.5, 0.7, 0.9].entries()) {
      expect(variants[i].value).toBeCloseTo(expected, 12);
    }
    expect(variants[0].value).toBe(0.1);
    expect(variants[4].value).toBe(0.9);
    for (const v of variants) {
      const comp = v.config.branches[0].component;
      expect(comp.type === "valve" && comp.position).toBe(v.value);
      expect(Object.isFrozen(v.config)).toBe(true);
      expect(Object.isFrozen(v.config.settings)).toBe(true);
      expect(Object.isFrozen(v.config.branches[0].component)).toBe(true);
      expect(v.configHash).toBe(configHash(v.config));
      expect(v.configHash).toMatch(/^[0-9a-f]{16}$/);
    }
    // Distinct values → distinct hashes; deterministic across calls.
    expect(new Set(variants.map((v) => v.configHash)).size).toBe(5);
    const again = materializeSweepVariants(cfg, def);
    expect(again.map((v) => v.configHash)).toEqual(
      variants.map((v) => v.configHash),
    );
  });

  it("never mutates or freezes the base config, and variants share no references with it", () => {
    const cfg = baseConfig();
    const before = structuredClone(cfg);
    const def = sweepOn(
      { kind: "node", id: "out", field: "pressure" },
      1e5,
      2e5,
      3,
    );
    const variants = materializeSweepVariants(cfg, def);
    expect(cfg).toEqual(before);
    expect(Object.isFrozen(cfg)).toBe(false);
    expect(Object.isFrozen(cfg.branches[0])).toBe(false);
    for (const v of variants) {
      expect(v.config.nodes).not.toBe(cfg.nodes);
      expect(v.config.branches[0]).not.toBe(cfg.branches[0]);
      expect(v.config.nodes.find((n) => n.id === "out")!.pressure).toBe(
        v.value,
      );
    }
  });

  it("throws SweepDefinitionError on structural problems", () => {
    const cfg = baseConfig();
    expect(() =>
      materializeSweepVariants(
        cfg,
        sweepOn({ kind: "branch", id: "ghost", field: "x" }, 0, 1, 3),
      ),
    ).toThrow(SweepDefinitionError);
    expect(() =>
      materializeSweepVariants(
        cfg,
        sweepOn({ kind: "settings", field: "tolerance" }, 0, 1, 99),
      ),
    ).toThrow(SweepDefinitionError);
  });

  it("keeps the base config out of the variant snapshots (exactly one field differs)", () => {
    const cfg = baseConfig();
    const def = sweepOn(
      { kind: "settings", field: "tolerance" },
      1e-8,
      1e-6,
      2,
    );
    const [a, b] = materializeSweepVariants(cfg, def);
    for (const [v, expected] of [
      [a, 1e-8],
      [b, 1e-6],
    ] as const) {
      expect(v.config.settings.tolerance).toBe(expected);
      const sansTol = (c: NetworkConfig) => ({
        ...c,
        settings: { ...c.settings, tolerance: 0 },
      });
      expect(sansTol(v.config)).toEqual(sansTol(cfg));
    }
  });
});

describe("createSweepJob", () => {
  it("builds a pending job with frozen base snapshot and variant records", () => {
    const cfg = baseConfig();
    const def = sweepOn(
      { kind: "branch", id: "b1", field: "position" },
      0.2,
      0.8,
      3,
    );
    const job = createSweepJob({
      id: "job-1",
      baseConfig: cfg,
      definition: def,
      now: 1_700_000_000_000,
    });
    expect(job).toMatchObject({
      id: "job-1",
      kind: "parameterSweep",
      status: "pending",
      targetLabel: "Valve b1 · position",
      createdAt: 1_700_000_000_000,
      progress: { completed: 0, total: 3 },
    });
    expect(job.baseConfigHash).toBe(configHash(cfg));
    expect(Object.isFrozen(job.baseConfig)).toBe(true);
    expect(Object.isFrozen(job.baseConfig.branches[0].component)).toBe(true);
    expect(job.variants).toHaveLength(3);
    expect(job.variants.map((v) => [v.index, v.value, v.status])).toEqual([
      [0, 0.2, "pending"],
      [1, 0.5, "pending"],
      [2, 0.8, "pending"],
    ]);
    // Variant record hashes match the materialized snapshots.
    const variants = materializeSweepVariants(cfg, def);
    expect(job.variants.map((v) => v.configHash)).toEqual(
      variants.map((v) => v.configHash),
    );
    // Base config itself untouched/unfrozen.
    expect(Object.isFrozen(cfg)).toBe(false);
    // Job sweep definition is a copy.
    expect(job.sweep).toEqual(def);
    expect(job.sweep).not.toBe(def);
  });

  it("throws SweepDefinitionError for invalid definitions", () => {
    expect(() =>
      createSweepJob({
        id: "job-2",
        baseConfig: baseConfig(),
        definition: sweepOn(
          { kind: "branch", id: "b1", field: "nope" },
          0,
          1,
          3,
        ),
      }),
    ).toThrow(SweepDefinitionError);
  });
});

/* ------------------------------------------------------------------ */
/* Formula bindings (core/paramBindings.ts) interacting with sweeps     */
/* ------------------------------------------------------------------ */

describe("sweeps with formula bindings", () => {
  /** in —pipe b1— mid —pipe b2— out; mid.volume is bound to pipe geometry. */
  function boundConfig(): NetworkConfig {
    return {
      meta: { name: "SweepBound", version: 2 },
      settings: { mode: "steady", tolerance: 1e-8, maxIterations: 200 },
      fluid: { model: "incompressible", preset: "water" },
      nodes: [
        {
          id: "in",
          type: "boundary",
          x: 0,
          y: 0,
          pressure: 2e5,
          temperature: 300,
        },
        {
          id: "mid",
          type: "internal",
          x: 50,
          y: 0,
          volume: { expr: "pipe('b1').volume + pipe('b2').volume" },
        },
        {
          id: "out",
          type: "boundary",
          x: 100,
          y: 0,
          pressure: 1e5,
          temperature: 300,
        },
      ],
      branches: [
        {
          id: "b1",
          from: "in",
          to: "mid",
          component: {
            type: "pipe",
            length: 1,
            diameter: 0.04,
            roughness: 1e-5,
          },
        },
        {
          id: "b2",
          from: "mid",
          to: "out",
          component: {
            type: "pipe",
            length: 1,
            diameter: 0.04,
            roughness: 1e-5,
          },
        },
      ],
    };
  }

  it("rejects sweeping a formula-bound field directly", () => {
    const cfg = boundConfig();
    const r = validateSweepDefinition(
      cfg,
      sweepOn({ kind: "node", id: "mid", field: "volume" }, 1e-3, 2e-3, 3),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join("; ")).toMatch(/bound to a formula/);
  });

  it("re-resolves formulas referencing a swept literal dependency per variant", () => {
    const cfg = boundConfig();
    const def = sweepOn(
      { kind: "branch", id: "b1", field: "diameter" },
      0.04,
      0.06,
      3,
    );

    const validation = validateSweepDefinition(cfg, def);
    expect(validation.ok).toBe(true);
    if (validation.ok) expect(validation.invalidValues).toEqual([]);

    const variants = materializeSweepVariants(cfg, def);
    expect(variants).toHaveLength(3);
    for (const variant of variants) {
      // The variant snapshot preserves the formula object (deep-frozen).
      const mid = variant.config.nodes.find((n) => n.id === "mid")!;
      expect(mid.volume).toEqual({
        expr: "pipe('b1').volume + pipe('b2').volume",
      });
      // …and validation/solving resolves it against the SWEPT diameter.
      expect(validateNetwork(variant.config)).toEqual([]);
      const r = resolveNetworkParameters(variant.config);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const d = variant.value as number;
      const expectedVolume =
        ((Math.PI * d * d) / 4) * 1 + ((Math.PI * 0.04 * 0.04) / 4) * 1;
      expect(r.resolved["node 'mid'.volume"]).toBeCloseTo(expectedVolume, 15);
      // Solving the bound variant equals solving the equivalent literal one.
      const literal = structuredClone(variant.config) as NetworkConfig;
      const midLit = literal.nodes.find((n) => n.id === "mid")!;
      midLit.volume = expectedVolume;
      const sBound = solveSteady(variant.config);
      const sLit = solveSteady(literal);
      expect(sBound.converged).toBe(true);
      expect(sBound.branches.b1.mdot).toBeCloseTo(sLit.branches.b1.mdot, 12);
    }
    // The base config keeps its original formula (never mutated/frozen).
    expect(Object.isFrozen(cfg)).toBe(false);
    expect(cfg.nodes[1].volume).toEqual({
      expr: "pipe('b1').volume + pipe('b2').volume",
    });
  });
});
