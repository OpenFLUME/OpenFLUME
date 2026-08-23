import { describe, it, expect } from "vitest";
import type { NetworkConfig } from "../types";
import {
  applySweepValue,
  listSweepTargets,
  resolveSweepTarget,
  type NumericSweepDescriptor,
  type OptionSweepDescriptor,
  type SweepTarget,
  type SweepTargetDescriptor,
} from "../sweep";

/**
 * Representative network exercising every target family: transient settings,
 * fluid nodes (one fully specified, one sparse), solid nodes (numeric cp,
 * table cp, ambient), one branch per practical component variant, and
 * conductors of every kind (numeric k, material k, plain-h convection,
 * correlation convection, radiation).  listSweepTargets / resolveSweepTarget
 * do not require the config to pass validateNetwork.
 */
function richConfig(): NetworkConfig {
  return {
    meta: { name: "SweepTargets", version: 2 },
    settings: {
      mode: "transient",
      dt: 0.1,
      endTime: 10,
      tolerance: 1e-8,
      maxIterations: 200,
      relaxation: 0.8,
    },
    fluid: { model: "incompressible", preset: "water" },
    nodes: [
      {
        id: "in",
        label: "Inlet",
        type: "boundary",
        x: 0,
        y: 0,
        pressure: 2e5,
        temperature: 300,
        volume: 1e-3,
        heatInput: 5,
      },
      // Sparse node: only pressure set — volume/heatInput must NOT be offered.
      { id: "out", type: "boundary", x: 100, y: 0, pressure: 1e5 },
      {
        id: "n1",
        type: "internal",
        x: 50,
        y: 0,
        pressure: 1.5e5,
        temperature: 310,
        volume: 2e-3,
        heatInput: 0,
      },
    ],
    solidNodes: [
      {
        id: "wall",
        type: "solid",
        x: 50,
        y: 20,
        temperature: 350,
        mass: 2,
        cp: 385,
        heatInput: 0,
      },
      // Table cp: not sweepable.
      {
        id: "wallTable",
        type: "solid",
        x: 60,
        y: 20,
        temperature: 340,
        mass: 1,
        cp: {
          table: [
            [100, 200],
            [300, 400],
          ],
        },
      },
      // Ambient: temperature sweepable, mass/cp not applicable.
      { id: "amb", type: "ambient", x: 0, y: 20, temperature: 293 },
    ],
    branches: [
      {
        id: "bpipe",
        from: "in",
        to: "n1",
        component: {
          type: "pipe",
          length: 1,
          diameter: 0.02,
          roughness: 1e-5,
          elevationChange: 0.5,
        },
      },
      {
        id: "borifice",
        from: "in",
        to: "n1",
        component: { type: "orifice", area: 1e-4, cd: 0.6 },
      },
      {
        id: "bventuri",
        from: "in",
        to: "n1",
        component: {
          type: "cavitatingVenturi",
          throatArea: 5e-6,
          cd: 0.84,
          recoveryFactor: 0.5,
        },
      },
      {
        id: "bres",
        from: "in",
        to: "n1",
        component: { type: "resistance", k: 2, area: 1e-4 },
      },
      {
        id: "bvalve",
        from: "in",
        to: "n1",
        component: {
          type: "valve",
          area: 1e-4,
          cd: 0.6,
          position: 0.7,
          positionSchedule: [
            [0, 0.7],
            [10, 1],
          ],
        },
      },
      {
        id: "bcheck",
        from: "in",
        to: "n1",
        component: { type: "checkValve", area: 1e-4, cd: 0.6 },
      },
      {
        id: "brelief",
        from: "in",
        to: "n1",
        component: {
          type: "reliefValve",
          crackPressure: 1.5e5,
          fullOpenPressure: 2e5,
          area: 1e-4,
          cd: 0.6,
        },
      },
      {
        id: "bpump",
        from: "in",
        to: "n1",
        component: {
          type: "pump",
          curve: [
            [0, 1e5],
            [0.1, 0],
          ],
        },
      },
      {
        id: "bbend",
        from: "in",
        to: "n1",
        component: {
          type: "bend",
          diameter: 0.02,
          angle: 90,
          rOverD: 1.5,
          roughness: 1e-5,
        },
      },
      {
        id: "barea",
        from: "in",
        to: "n1",
        component: { type: "areaChange", areaIn: 1e-4, areaOut: 2e-4 },
      },
      {
        id: "bflow",
        from: "in",
        to: "n1",
        component: {
          type: "flowSource",
          massFlow: 0.1,
          massFlowSchedule: [
            [0, 0.1],
            [10, 0.2],
          ],
        },
      },
      {
        id: "breg",
        from: "in",
        to: "n1",
        component: { type: "regulator", setPressure: 1.5e5, maxCdA: 1e-4 },
      },
      {
        id: "bheat",
        from: "in",
        to: "n1",
        component: {
          type: "heatedPipe",
          length: 2,
          diameter: 0.02,
          roughness: 1e-5,
          elevationChange: 1,
          ua: 25,
          wallTemperature: 400,
          boilingModel: "miropolskii",
        },
      },
      {
        id: "bdp",
        from: "in",
        to: "n1",
        component: {
          type: "dpTable",
          points: [
            [0, 0],
            [1, 1000],
          ],
          extrapolate: "clamp",
        },
      },
      {
        id: "bcustom",
        from: "in",
        to: "n1",
        component: {
          type: "customResistance",
          k: 3,
          area: 1e-4,
          diameter: 0.02,
        },
      },
      // kTable form: k itself is NOT sweepable, but area is (diameter absent).
      {
        id: "bcustomT",
        from: "in",
        to: "n1",
        component: {
          type: "customResistance",
          k: {
            kTable: [
              [1e4, 2],
              [1e5, 1],
            ],
          },
          area: 2e-4,
        },
      },
      {
        id: "buser",
        from: "in",
        to: "n1",
        component: {
          type: "userComponent",
          component: "mine",
          params: { gain: 2 },
          area: 1e-4,
        },
      },
    ],
    conductors: [
      {
        id: "ccond",
        from: "wall",
        to: "wallTable",
        type: { kind: "conduction", k: 400, area: 0.01, length: 0.1 },
      },
      // Material-form k: not sweepable (area/length still are).
      {
        id: "ccondMat",
        from: "wall",
        to: "amb",
        type: {
          kind: "conduction",
          k: { material: "ofhc-copper" },
          area: 0.02,
          length: 0.2,
        },
      },
      {
        id: "cconv",
        from: "n1",
        to: "wall",
        type: { kind: "convection", h: 500, area: 0.05 },
      },
      {
        id: "ccorr",
        from: "n1",
        to: "wall",
        type: {
          kind: "convection",
          area: 0.06,
          correlation: {
            model: "dittusBoelter",
            diameter: 0.02,
            flowArea: 3e-4,
            axialPosition: 1.2,
            inletLiquidReynolds: 5e4,
          },
        },
      },
      {
        id: "crad",
        from: "wall",
        to: "amb",
        type: {
          kind: "radiation",
          emissivity: 0.8,
          area: 0.03,
          viewFactor: 0.5,
        },
      },
    ],
  };
}

const byLabel = (config: NetworkConfig) =>
  new Map(listSweepTargets(config).map((d) => [d.label, d]));

/** Narrow to the numeric arm; undefined for a missing or categorical target. */
const numeric = (
  d: SweepTargetDescriptor | undefined,
): NumericSweepDescriptor | undefined =>
  d?.axis === "numeric" ? d : undefined;

/** Narrow to the option arm; undefined for a missing or numeric target. */
const options = (
  d: SweepTargetDescriptor | undefined,
): OptionSweepDescriptor | undefined => (d?.axis === "options" ? d : undefined);

describe("listSweepTargets", () => {
  it("enumerates settings fields that exist with finite values", () => {
    const targets = byLabel(richConfig());
    for (const f of ["dt", "endTime", "tolerance", "relaxation"]) {
      expect(targets.has(`Settings · ${f}`), f).toBe(true);
    }
    expect(targets.get("Settings · dt")).toMatchObject({
      quantity: "time",
      unit: "s",
      currentValue: 0.1,
    });
    expect(targets.get("Settings · tolerance")).toMatchObject({
      quantity: "dimensionless",
      currentValue: 1e-8,
    });
  });

  it("omits absent settings fields (steady config without dt/endTime/relaxation)", () => {
    const cfg = richConfig();
    cfg.settings = { mode: "steady", tolerance: 1e-6, maxIterations: 100 };
    const targets = byLabel(cfg);
    expect(targets.has("Settings · tolerance")).toBe(true);
    expect(targets.has("Settings · dt")).toBe(false);
    expect(targets.has("Settings · endTime")).toBe(false);
    expect(targets.has("Settings · relaxation")).toBe(false);
  });

  it("enumerates fluid-node fields only when present, with labels and quantities", () => {
    const targets = byLabel(richConfig());
    expect(targets.get("Node Inlet · pressure")).toMatchObject({
      quantity: "pressure",
      unit: "Pa",
      currentValue: 2e5,
    });
    expect(targets.get("Node Inlet · volume")).toMatchObject({
      quantity: "volume",
      unit: "m³",
      currentValue: 1e-3,
    });
    expect(targets.get("Node Inlet · heatInput")).toMatchObject({
      quantity: "power",
      unit: "W",
      currentValue: 5,
    });
    // Sparse node: only pressure exists.
    expect(targets.has("Node out · pressure")).toBe(true);
    expect(targets.has("Node out · volume")).toBe(false);
    expect(targets.has("Node out · heatInput")).toBe(false);
    expect(targets.has("Node out · temperature")).toBe(false);
  });

  it("enumerates solid-node fields with numeric-cp and ambient rules", () => {
    const targets = byLabel(richConfig());
    expect(targets.get("Solid node wall · temperature")).toMatchObject({
      quantity: "temperature",
      currentValue: 350,
    });
    expect(targets.get("Solid node wall · mass")).toMatchObject({
      quantity: "dimensionless",
      unit: "kg",
      currentValue: 2,
    });
    expect(targets.get("Solid node wall · cp")).toMatchObject({
      quantity: "specificHeat",
      unit: "J/(kg·K)",
      currentValue: 385,
    });
    expect(targets.get("Solid node wall · heatInput")).toMatchObject({
      quantity: "power",
      currentValue: 0,
    });
    // Table cp: excluded, but the node's other scalars remain.
    expect(targets.has("Solid node wallTable · cp")).toBe(false);
    expect(targets.has("Solid node wallTable · mass")).toBe(true);
    // Ambient: temperature only (no thermal mass).
    expect(targets.has("Ambient node amb · temperature")).toBe(true);
    expect(targets.has("Ambient node amb · mass")).toBe(false);
    expect(targets.has("Ambient node amb · cp")).toBe(false);
  });

  it("enumerates component scalar fields across all practical variants", () => {
    const targets = byLabel(richConfig());
    const expectFields = (
      branchId: string,
      typeLabel: string,
      fields: string[],
    ) => {
      for (const f of fields) {
        expect(
          targets.has(`${typeLabel} ${branchId} · ${f}`),
          `${branchId}.${f}`,
        ).toBe(true);
      }
    };
    expectFields("bpipe", "Pipe", [
      "length",
      "diameter",
      "roughness",
      "elevationChange",
    ]);
    expectFields("borifice", "Orifice", ["area", "cd"]);
    expectFields("bventuri", "Cavitating Venturi", [
      "throatArea",
      "cd",
      "recoveryFactor",
    ]);
    expectFields("bres", "Resistance", ["k", "area"]);
    expectFields("bvalve", "Valve", ["area", "cd", "position"]);
    expectFields("bcheck", "Check Valve", ["area", "cd"]);
    expectFields("brelief", "Relief Valve", [
      "crackPressure",
      "fullOpenPressure",
      "area",
      "cd",
    ]);
    expectFields("bbend", "Bend", ["diameter", "angle", "rOverD", "roughness"]);
    expectFields("barea", "Area Change", ["areaIn", "areaOut"]);
    expectFields("bflow", "Flow Source", ["massFlow"]);
    expectFields("breg", "Regulator", ["setPressure", "maxCdA"]);
    expectFields("bheat", "Heated Pipe", [
      "length",
      "diameter",
      "roughness",
      "elevationChange",
      "ua",
      "wallTemperature",
    ]);
    expectFields("bcustom", "Custom Resistance", ["k", "area", "diameter"]);
    expectFields("bcustomT", "Custom Resistance", ["area"]); // kTable k excluded; diameter absent
    expectFields("buser", "Local Component", ["area"]); // dynamic params excluded
  });

  it("keeps tables/arrays/strings off both axes, and enums/booleans off the numeric one", () => {
    const descriptors = listSweepTargets(richConfig());
    const fieldsOn = (axis: "numeric" | "options") =>
      descriptors
        .filter(
          (d) =>
            d.axis === axis &&
            (d.target.kind === "branch" || d.target.kind === "conductor"),
        )
        .map((d) => `${(d.target as { id: string }).id}.${d.target.field}`);
    const numericFields = fieldsOn("numeric");

    // A pump curve is tabular: nothing to sweep either way.
    expect(
      descriptors.some(
        (d) => d.target.kind === "branch" && d.target.id === "bpump",
      ),
    ).toBe(false);
    // A dpTable has no sweepable scalar — only its extrapolation choice.
    expect(
      descriptors
        .filter((d) => d.target.kind === "branch" && d.target.id === "bdp")
        .map((d) => d.target.field),
    ).toEqual(["extrapolate"]);

    for (const excluded of [
      "bvalve.positionSchedule",
      "bflow.massFlowSchedule",
      "bpipe.inertia",
      "bheat.boilingModel",
      "bdp.extrapolate",
      "bdp.points",
      "buser.component",
      "buser.params",
      "bcustomT.k",
      "ccondMat.k",
    ]) {
      expect(numericFields, excluded).not.toContain(excluded);
    }

    // The categorical ones are offered as options rather than as ranges;
    // tables, schedules and library names remain out of reach entirely.
    const optionFields = fieldsOn("options");
    for (const offered of [
      "bpipe.inertia",
      "bheat.boilingModel",
      "bdp.extrapolate",
      "ccondMat.k.material",
    ]) {
      expect(optionFields, offered).toContain(offered);
    }
    for (const never of [
      "bdp.points",
      "bvalve.positionSchedule",
      "buser.component",
      "bcustomT.k",
    ]) {
      expect(optionFields, never).not.toContain(never);
    }
  });

  it("enumerates conductor fields, numeric-k rule, and correlation sub-fields", () => {
    const targets = byLabel(richConfig());
    expect(targets.get("Conduction ccond · k")).toMatchObject({
      quantity: "thermalConductivity",
      unit: "W/(m·K)",
      currentValue: 400,
    });
    expect(targets.get("Conduction ccond · area")).toMatchObject({
      quantity: "area",
    });
    expect(targets.get("Conduction ccond · length")).toMatchObject({
      quantity: "length",
    });
    // Material-form k excluded, geometry kept.
    expect(targets.has("Conduction ccondMat · k")).toBe(false);
    expect(targets.has("Conduction ccondMat · area")).toBe(true);
    expect(targets.get("Convection cconv · h")).toMatchObject({
      quantity: "heatTransferCoeff",
      unit: "W/(m²·K)",
      currentValue: 500,
    });
    expect(
      targets.get("Convection ccorr · correlation.diameter"),
    ).toMatchObject({ quantity: "length", currentValue: 0.02 });
    expect(
      targets.get("Convection ccorr · correlation.flowArea"),
    ).toMatchObject({ quantity: "area" });
    expect(
      targets.get("Convection ccorr · correlation.axialPosition"),
    ).toMatchObject({ quantity: "length" });
    expect(
      targets.get("Convection ccorr · correlation.inletLiquidReynolds"),
    ).toMatchObject({ quantity: "dimensionless" });
    // Absent optional h on ccorr / flowArea on cconv not offered.
    expect(targets.has("Convection ccorr · h")).toBe(false);
    expect(targets.has("Convection cconv · correlation.diameter")).toBe(false);
    expect(targets.get("Radiation crad · emissivity")).toMatchObject({
      quantity: "dimensionless",
      bounds: { min: 0, max: 1 },
    });
    expect(targets.get("Radiation crad · viewFactor")).toMatchObject({
      quantity: "dimensionless",
    });
    expect(targets.get("Radiation crad · area")).toMatchObject({
      quantity: "area",
    });
  });

  it("carries advisory bounds from validation rules", () => {
    const targets = byLabel(richConfig());
    expect(numeric(targets.get("Valve bvalve · position"))?.bounds).toEqual({
      min: 0,
      max: 1,
    });
    expect(numeric(targets.get("Bend bbend · angle"))?.bounds).toEqual({
      min: 0,
      max: 180,
    });
    expect(numeric(targets.get("Pipe bpipe · diameter"))?.bounds).toEqual({
      min: 0,
    });
  });
});

describe("resolveSweepTarget", () => {
  it("resolves representatives of every target family", () => {
    const cfg = richConfig();
    const cases: Array<[SweepTarget, string, number]> = [
      [{ kind: "settings", field: "endTime" }, "Settings · endTime", 10],
      [
        { kind: "node", id: "n1", field: "temperature" },
        "Node n1 · temperature",
        310,
      ],
      [
        { kind: "solidNode", id: "wall", field: "cp" },
        "Solid node wall · cp",
        385,
      ],
      [
        { kind: "branch", id: "bpipe", field: "diameter" },
        "Pipe bpipe · diameter",
        0.02,
      ],
      [
        { kind: "conductor", id: "ccorr", field: "correlation.diameter" },
        "Convection ccorr · correlation.diameter",
        0.02,
      ],
    ];
    for (const [target, label, value] of cases) {
      const r = resolveSweepTarget(cfg, target);
      expect(r.ok, label).toBe(true);
      if (r.ok) {
        expect(r.descriptor.label).toBe(label);
        expect(numeric(r.descriptor)?.currentValue).toBe(value);
      }
    }
  });

  it("fails with useful errors for unknown ids, unknown fields, and non-scalars", () => {
    const cfg = richConfig();
    const bad: Array<[SweepTarget, RegExp]> = [
      [{ kind: "node", id: "nope", field: "pressure" }, /Unknown fluid node/],
      [
        { kind: "node", id: "out", field: "volume" },
        /not set to a finite number/,
      ],
      [
        { kind: "solidNode", id: "wallTable", field: "cp" },
        /not a plain number/,
      ],
      [
        { kind: "solidNode", id: "amb", field: "mass" },
        /no thermal-mass field/,
      ],
      [{ kind: "branch", id: "bpipe", field: "area" }, /no sweepable field/],
      [{ kind: "branch", id: "bpump", field: "curve" }, /no sweepable fields/],
      [{ kind: "branch", id: "bcustomT", field: "k" }, /not a plain number/],
      [
        { kind: "conductor", id: "crad", field: "correlation.diameter" },
        /no correlation block/,
      ],
      [{ kind: "conductor", id: "ccond", field: "h" }, /no sweepable field/],
    ];
    for (const [target, pattern] of bad) {
      const r = resolveSweepTarget(cfg, target);
      expect(r.ok, JSON.stringify(target)).toBe(false);
      if (!r.ok) expect(r.error).toMatch(pattern);
    }

    // Settings field absent on this (steady) config.
    const steady = richConfig();
    steady.settings = { mode: "steady", tolerance: 1e-6, maxIterations: 100 };
    const r = resolveSweepTarget(steady, { kind: "settings", field: "dt" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/not set/);
  });

  it("rejects formula-bound direct targets with a clear message", () => {
    const cfg = richConfig();
    const n1 = cfg.nodes.find((n) => n.id === "n1")!;
    n1.volume = { expr: "pipe('bpipe').volume" };
    const bpipe = cfg.branches.find((b) => b.id === "bpipe")!;
    (bpipe.component as { diameter: unknown }).diameter = { expr: "0.02" };
    const ccond = (cfg.conductors ?? []).find((c) => c.id === "ccond")!;
    (ccond.type as { area: unknown }).area = {
      expr: "conductor('ccond').length * 0.1",
    };

    const cases: SweepTarget[] = [
      { kind: "node", id: "n1", field: "volume" },
      { kind: "branch", id: "bpipe", field: "diameter" },
      { kind: "conductor", id: "ccond", field: "area" },
    ];
    for (const target of cases) {
      const r = resolveSweepTarget(cfg, target);
      expect(r.ok, JSON.stringify(target)).toBe(false);
      if (!r.ok) {
        expect(r.error).toMatch(/bound to a formula/);
        expect(r.error).toMatch(/cannot be swept directly/);
      }
    }
    // Formula-bound fields are also not OFFERED as sweep targets.
    const labels = [...byLabel(cfg).keys()];
    expect(labels.some((l) => l === "Node n1 · volume")).toBe(false);
    expect(labels.some((l) => l === "Pipe bpipe · diameter")).toBe(false);
    expect(labels.some((l) => l === "Conduction ccond · area")).toBe(false);
  });
});

describe("applySweepValue", () => {
  it("changes exactly the target field and returns a deep-new config", () => {
    const cfg = richConfig();
    const next = applySweepValue(
      cfg,
      { kind: "branch", id: "bpipe", field: "diameter" },
      0.05,
    );

    // Exactly one field changed.
    const pipe = next.branches.find((b) => b.id === "bpipe")!;
    expect(pipe.component).toMatchObject({ type: "pipe", diameter: 0.05 });
    const rest = (c: NetworkConfig) => ({
      ...c,
      branches: c.branches.filter((b) => b.id !== "bpipe"),
    });
    const pipeSans = (c: NetworkConfig) => {
      const b = c.branches.find((x) => x.id === "bpipe")!;
      const comp = { ...b.component } as Record<string, unknown>;
      delete comp.diameter;
      return { ...b, component: comp };
    };
    expect(rest(next)).toEqual(rest(cfg));
    expect(pipeSans(next)).toEqual(pipeSans(cfg));

    // Deep-new: no shared references with the input anywhere.
    expect(next).not.toBe(cfg);
    expect(next.settings).not.toBe(cfg.settings);
    expect(next.nodes).not.toBe(cfg.nodes);
    expect(next.branches).not.toBe(cfg.branches);
    expect(next.branches.find((b) => b.id === "borifice")).not.toBe(
      cfg.branches.find((b) => b.id === "borifice"),
    );
    expect(next.conductors?.[0]).not.toBe(cfg.conductors?.[0]);
    expect(next.conductors?.[0].type).not.toBe(cfg.conductors?.[0].type);
  });

  it("never mutates the input, across all target families", () => {
    const cases: Array<[SweepTarget, number, (c: NetworkConfig) => unknown]> = [
      [{ kind: "settings", field: "endTime" }, 42, (c) => c.settings.endTime],
      [
        { kind: "node", id: "n1", field: "volume" },
        9e-3,
        (c) => c.nodes.find((n) => n.id === "n1")!.volume,
      ],
      [
        { kind: "solidNode", id: "wall", field: "heatInput" },
        123,
        (c) => c.solidNodes!.find((s) => s.id === "wall")!.heatInput,
      ],
      [
        { kind: "branch", id: "bvalve", field: "position" },
        0.2,
        (c) => {
          const comp = c.branches.find((b) => b.id === "bvalve")!.component;
          return comp.type === "valve" ? comp.position : undefined;
        },
      ],
      [
        { kind: "conductor", id: "ccond", field: "k" },
        111,
        (c) => {
          const t = c.conductors!.find((x) => x.id === "ccond")!.type;
          return t.kind === "conduction" ? t.k : undefined;
        },
      ],
      [
        { kind: "conductor", id: "ccorr", field: "correlation.axialPosition" },
        3.3,
        (c) => {
          const t = c.conductors!.find((x) => x.id === "ccorr")!.type;
          return t.kind === "convection"
            ? t.correlation?.axialPosition
            : undefined;
        },
      ],
    ];
    for (const [target, value, read] of cases) {
      const cfg = richConfig();
      const before = structuredClone(cfg);
      const next = applySweepValue(cfg, target, value);
      expect(cfg, JSON.stringify(target)).toEqual(before); // input untouched
      expect(read(next), JSON.stringify(target)).toBe(value);
      expect(read(cfg), JSON.stringify(target)).not.toBe(value);
    }
  });

  it("isolates subsequent mutations of the result from the input", () => {
    const cfg = richConfig();
    const next = applySweepValue(
      cfg,
      { kind: "node", id: "n1", field: "pressure" },
      9e5,
    );
    next.nodes[0].pressure = -1;
    next.branches[0].component = { type: "orifice", area: 1, cd: 1 };
    expect(cfg.nodes[0].pressure).toBe(2e5);
    expect(cfg.branches[0].component.type).toBe("pipe");
  });

  it("throws for unresolvable targets and non-finite values", () => {
    const cfg = richConfig();
    expect(() =>
      applySweepValue(cfg, { kind: "branch", id: "nope", field: "x" }, 1),
    ).toThrow(/Unknown branch/);
    expect(() =>
      applySweepValue(
        cfg,
        { kind: "node", id: "n1", field: "pressure" },
        Number.NaN,
      ),
    ).toThrow(/finite/);
  });
});

/* ------------------------------------------------------------------ */
/* Categorical (option) axes                                           */
/* ------------------------------------------------------------------ */

describe("option axes", () => {
  it("offers the model choice on correlation conductors only, marking the current one", () => {
    const targets = byLabel(richConfig());
    const model = options(
      targets.get("Convection ccorr · heat-transfer model"),
    );
    expect(model?.options.map((o) => o.id)).toEqual([
      "dittusBoelter",
      "miropolskii",
      "darrHartwig",
      "ttWf",
    ]);
    expect(model?.currentOptionId).toBe("dittusBoelter");
    // 'custom' needs an expression the conductor does not have.
    expect(model?.options.some((o) => o.id === "custom")).toBe(false);
    // A plain-h convection conductor has no correlation to choose.
    expect(targets.has("Convection cconv · heat-transfer model")).toBe(false);
    // The front gate is a ttWf state, so it is not offered on a D-B model.
    expect(targets.has("Convection ccorr · fluid-front gate")).toBe(false);
  });

  it("offers custom and the front gate once the model carries them", () => {
    const cfg = richConfig();
    const conv = cfg.conductors!.find((c) => c.id === "ccorr")!.type;
    if (conv.kind !== "convection") throw new Error("fixture changed");
    conv.correlation = {
      ...conv.correlation!,
      model: "ttWf",
      segmentLength: 0.25,
      expression: "100 * Re^0.8",
    };
    const targets = byLabel(cfg);
    expect(
      options(
        targets.get("Convection ccorr · heat-transfer model"),
      )?.options.map((o) => o.id),
    ).toContain("custom");
    const gate = options(targets.get("Convection ccorr · fluid-front gate"));
    expect(gate?.options.map((o) => o.id)).toEqual(["off", "on"]);
    expect(gate?.currentOptionId).toBe("off");
  });

  it("offers every registry material for cp and k, leading with the current value", () => {
    const targets = byLabel(richConfig());

    // Numeric cp: the constant leads as an explicit baseline.
    const wallCp = options(targets.get("Solid node wall · cp material"));
    expect(wallCp?.options[0].id).toBe("current");
    expect(wallCp?.options[0].label).toBe("Current — 385 J/(kg·K)");
    expect(wallCp?.options.map((o) => o.id)).toContain("stainless-steel-304");
    expect(wallCp?.currentOptionId).toBeUndefined();

    // A table cp is equally a baseline worth comparing against.
    expect(
      options(targets.get("Solid node wallTable · cp material"))?.options[0]
        .label,
    ).toBe("Current — 2-pt table");

    // Material-form k: no baseline row, and the held material is marked.
    const kMat = options(targets.get("Conduction ccondMat · k material"));
    expect(kMat?.options.some((o) => o.id === "current")).toBe(false);
    expect(kMat?.currentOptionId).toBe("ofhc-copper");
    // Only materials with a k curve are offered for k.
    expect(
      kMat?.options.every((o) => o.id !== "ptfe" || o.label !== undefined),
    ).toBe(true);

    // Ambient nodes have no thermal mass, so no cp axis.
    expect(targets.has("Ambient node amb · cp material")).toBe(false);
  });

  it("offers the component flags: pipe inertia, boiling model, dpTable extrapolation", () => {
    const targets = byLabel(richConfig());
    expect(
      options(targets.get("Pipe bpipe · fluid inertia"))?.currentOptionId,
    ).toBe("off");
    expect(
      options(targets.get("Heated Pipe bheat · boiling model"))
        ?.currentOptionId,
    ).toBe("miropolskii");
    expect(
      options(
        targets.get("Pressure Drop Table bdp · extrapolation"),
      )?.options.map((o) => o.id),
    ).toEqual(["clamp", "linear"]);
    // Flags belong to the components that define them.
    expect(targets.has("Orifice borifice · fluid inertia")).toBe(false);
  });

  it("applies an option by writing the field and dropping what the choice invalidates", () => {
    const cfg = richConfig();
    const conv = cfg.conductors!.find((c) => c.id === "ccorr")!.type;
    if (conv.kind !== "convection") throw new Error("fixture changed");
    conv.correlation = {
      ...conv.correlation!,
      model: "custom",
      expression: "500",
      params: { a: 1 },
    };

    const target: SweepTarget = {
      kind: "conductor",
      id: "ccorr",
      field: "correlation.model",
    };
    const next = applySweepValue(cfg, target, "miropolskii");
    const applied = next.conductors!.find((c) => c.id === "ccorr")!.type;
    if (applied.kind !== "convection") throw new Error("fixture changed");
    expect(applied.correlation?.model).toBe("miropolskii");
    // The custom-only fields would make the named model invalid.
    expect(applied.correlation?.expression).toBeUndefined();
    expect(applied.correlation?.params).toBeUndefined();
    // Everything else on the correlation survives untouched.
    expect(applied.correlation?.diameter).toBe(0.02);
    expect(applied.correlation?.axialPosition).toBe(1.2);
    // The input is never mutated.
    expect(conv.correlation?.model).toBe("custom");
  });

  it("applies material and flag options", () => {
    const cfg = richConfig();
    const withMaterial = applySweepValue(
      cfg,
      { kind: "solidNode", id: "wall", field: "cp.material" },
      "inconel-718",
    );
    expect(withMaterial.solidNodes!.find((s) => s.id === "wall")!.cp).toEqual({
      material: "inconel-718",
    });
    expect(cfg.solidNodes!.find((s) => s.id === "wall")!.cp).toBe(385);

    const baseline = applySweepValue(
      cfg,
      { kind: "solidNode", id: "wall", field: "cp.material" },
      "current",
    );
    expect(baseline.solidNodes!.find((s) => s.id === "wall")!.cp).toBe(385);

    const inertial = applySweepValue(
      cfg,
      { kind: "branch", id: "bpipe", field: "inertia" },
      "on",
    );
    expect(
      inertial.branches.find((b) => b.id === "bpipe")!.component,
    ).toMatchObject({ inertia: true });

    const noBoiling = applySweepValue(
      cfg,
      { kind: "branch", id: "bheat", field: "boilingModel" },
      "off",
    );
    expect(
      noBoiling.branches.find((b) => b.id === "bheat")!.component,
    ).not.toHaveProperty("boilingModel");
  });

  it("rejects values that are not options of the axis", () => {
    const cfg = richConfig();
    expect(() =>
      applySweepValue(
        cfg,
        { kind: "solidNode", id: "wall", field: "cp.material" },
        "unobtanium",
      ),
    ).toThrow(/not an option/);
    expect(() =>
      applySweepValue(
        cfg,
        { kind: "branch", id: "bpipe", field: "inertia" },
        1,
      ),
    ).toThrow(/not an option/);
    const bad = resolveSweepTarget(cfg, {
      kind: "branch",
      id: "bpipe",
      field: "boilingModel",
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toMatch(/sweepable: .*inertia/);
  });
});
