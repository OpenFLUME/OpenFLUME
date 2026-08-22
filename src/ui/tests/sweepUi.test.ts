/**
 * sweepUi.test.ts — unit tests for the Sweep workspace's pure UI-policy
 * helpers (src/ui/sweep/uiPolicy.ts): target identity keys, selection-driven
 * preselection, grouping/filtering, default ranges, input parsing, variant
 * row formatting, the progress line, and CSV export generation.
 */
import { describe, it, expect } from "vitest";
import type { NetworkConfig } from "../../core";
import { SI_PRESET } from "../units";
import { configHash } from "../provenance";
import { listSweepTargets, type SolveJob, type VariantSummary } from "../sweep";
import {
  DEFAULT_SWEEP_COUNT,
  buildSweepCsv,
  checkSweepOptions,
  defaultOptionSelection,
  defaultSweepRange,
  filterSweepTargets,
  formatDurationMs,
  formatSweepValue,
  formatVariantRow,
  groupSweepTargets,
  parseCountInput,
  parseSweepNumber,
  parseTargetKey,
  preselectTarget,
  sweepCsvFilename,
  sweepProgressLine,
  targetKey,
  toggleOptionId,
} from "../sweep/uiPolicy";
import type {
  NumericSweepDescriptor,
  OptionSweepDescriptor,
  SweepVariantRecord,
} from "../sweep";

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

function baseConfig(): NetworkConfig {
  return {
    meta: { name: "Sweep UI", version: 2 },
    settings: {
      mode: "steady",
      tolerance: 1e-8,
      maxIterations: 200,
      relaxation: 0.9,
    },
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
      {
        id: "b2",
        from: "in",
        to: "out",
        component: { type: "pipe", length: 2, diameter: 0.02, roughness: 1e-5 },
      },
    ],
    conductors: [
      {
        id: "c1",
        from: "in",
        to: "out",
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

function fakeDescriptor(
  partial: Partial<NumericSweepDescriptor>,
): NumericSweepDescriptor {
  return {
    axis: "numeric",
    target: { kind: "node", id: "in", field: "pressure" },
    label: "Node in · pressure",
    quantity: "pressure",
    unit: "Pa",
    currentValue: 2e5,
    ...partial,
  };
}

const steadySummary: VariantSummary = {
  mode: "steady",
  converged: true,
  aborted: false,
  userTerminated: false,
  iterations: 7,
  residual: 1.2e-9,
  pressure: { min: 1e5, max: 2e5 },
  temperature: { min: 300, max: 300.5 },
  peakAbsMassFlow: 0.5,
};

function transientSummary(over: Partial<VariantSummary> = {}): VariantSummary {
  return {
    mode: "transient",
    converged: true,
    aborted: false,
    userTerminated: false,
    steps: 10,
    rejectedSteps: 2,
    endTime: 5,
    reachedEnd: true,
    pressure: { min: 1e5, max: 3e5 },
    peakAbsMassFlow: 1.25,
    ...over,
  };
}

function fakeJob(): SolveJob {
  const base = baseConfig();
  return {
    id: "job-1",
    kind: "parameterSweep",
    status: "completed",
    baseConfig: base,
    baseConfigHash: configHash(base),
    sweep: {
      target: { kind: "branch", id: "b2", field: "diameter" },
      start: 0.01,
      end: 0.03,
      count: 3,
      spacing: "linear",
    },
    targetLabel: "Pipe b2 · diameter",
    variants: [
      {
        index: 0,
        value: 0.01,
        configHash: "aaa",
        status: "completed",
        summary: steadySummary,
        durationMs: 12,
      },
      // Comma in the error exercises CSV quoting.
      {
        index: 1,
        value: 0.02,
        configHash: "bbb",
        status: "failed",
        error: "solver exploded, badly",
        durationMs: 2500,
      },
      {
        index: 2,
        value: 0.03,
        configHash: "ccc",
        status: "completed",
        summary: { ...steadySummary, converged: false },
        durationMs: 1500,
      },
    ],
    createdAt: 1000,
    startedAt: 1000,
    finishedAt: 5000,
    durationMs: 4000,
    progress: { completed: 2, total: 3 },
    result: { total: 3, completed: 2, failed: 1, converged: 1 },
    summary: "2/3 completed · 1 failed · 1 converged",
  };
}

/* ------------------------------------------------------------------ */
/* Target keys                                                         */
/* ------------------------------------------------------------------ */

describe("targetKey / parseTargetKey", () => {
  it("round-trips every target family, including correlation sub-fields", () => {
    const targets = listSweepTargets(baseConfig()).map((d) => d.target);
    expect(targets.length).toBeGreaterThan(0);
    for (const t of targets) {
      expect(parseTargetKey(targetKey(t))).toEqual(t);
    }
    const corr = {
      kind: "conductor",
      id: "c1",
      field: "correlation.diameter",
    } as const;
    expect(parseTargetKey(targetKey(corr))).toEqual(corr);
  });

  it("returns undefined for malformed keys", () => {
    expect(parseTargetKey("not json")).toBeUndefined();
    expect(parseTargetKey('{"kind":"node"}')).toBeUndefined(); // missing field
    expect(
      parseTargetKey('{"kind":"node","field":"pressure"}'),
    ).toBeUndefined(); // missing id
    expect(
      parseTargetKey('{"kind":"weird","id":"x","field":"y"}'),
    ).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/* Preselection / grouping / filtering                                 */
/* ------------------------------------------------------------------ */

describe("preselectTarget", () => {
  it("prefers the first enumerated field of the selected element", () => {
    const targets = listSweepTargets(baseConfig());
    expect(
      preselectTarget(targets, { kind: "node", id: "in" })?.target,
    ).toEqual({ kind: "node", id: "in", field: "pressure" });
    expect(
      preselectTarget(targets, { kind: "branch", id: "b1" })?.target,
    ).toEqual({ kind: "branch", id: "b1", field: "area" });
    expect(
      preselectTarget(targets, { kind: "branch", id: "b2" })?.target,
    ).toEqual({ kind: "branch", id: "b2", field: "length" });
    expect(
      preselectTarget(targets, { kind: "conductor", id: "c1" })?.target,
    ).toEqual({ kind: "conductor", id: "c1", field: "emissivity" });
  });

  it("falls back to the first target for none/group/unknown selections", () => {
    const targets = listSweepTargets(baseConfig());
    const first = targets[0];
    expect(preselectTarget(targets, { kind: "none" })).toBe(first);
    expect(preselectTarget(targets, { kind: "group", id: "g1" })).toBe(first);
    expect(preselectTarget(targets, { kind: "branch", id: "ghost" })).toBe(
      first,
    );
  });

  it("returns undefined when nothing is sweepable", () => {
    expect(preselectTarget([], { kind: "none" })).toBeUndefined();
  });
});

describe("groupSweepTargets / filterSweepTargets", () => {
  it("groups by family in enumeration order, omitting empty families", () => {
    const groups = groupSweepTargets(listSweepTargets(baseConfig()));
    expect(groups.map((g) => g.label)).toEqual([
      "Settings",
      "Fluid nodes",
      "Branches",
      "Conductors",
    ]);
    expect(groups[1].targets.every((d) => d.target.kind === "node")).toBe(true);
  });

  it("filters case-insensitively on the human label and passes through blank queries", () => {
    const targets = listSweepTargets(baseConfig());
    expect(filterSweepTargets(targets, "  ")).toHaveLength(targets.length);
    const pipes = filterSweepTargets(targets, "pipe");
    expect(pipes.length).toBeGreaterThan(0);
    expect(pipes.every((d) => d.label.toLowerCase().includes("pipe"))).toBe(
      true,
    );
    expect(filterSweepTargets(targets, "VALVE")).toEqual(
      filterSweepTargets(targets, "valve"),
    );
  });
});

/* ------------------------------------------------------------------ */
/* Defaults / parsing                                                  */
/* ------------------------------------------------------------------ */

describe("defaultSweepRange", () => {
  it("is ±10% around a positive current value with the default count", () => {
    const r = defaultSweepRange(fakeDescriptor({ currentValue: 300000 }));
    expect(r).toEqual({
      start: 270000,
      end: 330000,
      count: DEFAULT_SWEEP_COUNT,
    });
    expect(DEFAULT_SWEEP_COUNT).toBe(5);
  });

  it("mirrors the ±10% band for negative current values (start ≤ end)", () => {
    const r = defaultSweepRange(
      fakeDescriptor({ quantity: "length", unit: "m", currentValue: -3 }),
    );
    expect(r.start).toBeCloseTo(-3.3, 12);
    expect(r.end).toBeCloseTo(-2.7, 12);
  });

  it("uses bounds (or [0, 1]) when the current value is zero", () => {
    expect(
      defaultSweepRange(
        fakeDescriptor({ currentValue: 0, bounds: { min: 0, max: 1 } }),
      ),
    ).toMatchObject({ start: 0, end: 1 });
    expect(
      defaultSweepRange(fakeDescriptor({ currentValue: 0 })),
    ).toMatchObject({ start: 0, end: 1 });
    // Degenerate equal bounds are widened rather than producing an empty range.
    expect(
      defaultSweepRange(
        fakeDescriptor({ currentValue: 0, bounds: { min: 2, max: 2 } }),
      ),
    ).toMatchObject({ start: 2, end: 3 });
  });
});

describe("parseSweepNumber / parseCountInput", () => {
  it("parses finite numbers and rejects blanks/garbage", () => {
    expect(parseSweepNumber("0.1")).toBe(0.1);
    expect(parseSweepNumber(" 2e5 ")).toBe(200000);
    expect(parseSweepNumber("-3.5")).toBe(-3.5);
    expect(parseSweepNumber("")).toBeUndefined();
    expect(parseSweepNumber("abc")).toBeUndefined();
    expect(parseSweepNumber("Infinity")).toBeUndefined();
  });

  it("count input requires an integer; range is left to validation", () => {
    expect(parseCountInput("5")).toBe(5);
    expect(parseCountInput("0")).toBe(0); // structural error surfaces via validateSweepDefinition
    expect(parseCountInput("30")).toBe(30);
    expect(parseCountInput("2.5")).toBeUndefined();
    expect(parseCountInput("")).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/* Row formatting                                                      */
/* ------------------------------------------------------------------ */

describe("formatDurationMs", () => {
  it("formats sub-second as ms and longer as seconds", () => {
    expect(formatDurationMs(undefined)).toBe("—");
    expect(formatDurationMs(12)).toBe("12 ms");
    expect(formatDurationMs(1500)).toBe("1.5 s");
  });
});

describe("formatVariantRow", () => {
  it("formats a completed steady row with envelopes in SI prefs", () => {
    const record: SweepVariantRecord = {
      index: 0,
      value: 0.02,
      configHash: "x",
      status: "completed",
      summary: steadySummary,
      durationMs: 12,
    };
    const row = formatVariantRow(record, { unitPrefs: SI_PRESET });
    expect(row.value).toBe("0.02");
    expect(row.status).toBe("completed");
    expect(row.converged).toBe("yes");
    expect(row.detail).toBe("7 iter · res 1.2e-9");
    expect(row.peakMdot).toBe("500 g/s"); // base-SI prefs auto-scale (format.ts convention)
    expect(row.pressure).toBe("100 kPa – 200 kPa");
    expect(row.temperature).toBe("300 K – 300.5 K");
    expect(row.duration).toBe("12 ms");
    expect(row.error).toBe("");
  });

  it("honors unit preferences for envelope columns", () => {
    const record: SweepVariantRecord = {
      index: 0,
      value: 1,
      configHash: "x",
      status: "completed",
      summary: steadySummary,
    };
    const row = formatVariantRow(record, {
      unitPrefs: { ...SI_PRESET, pressure: "bar", temperature: "C" },
    });
    expect(row.pressure).toBe("1 bar – 2 bar");
    expect(row.temperature).toContain("°C");
  });

  it("formats a transient row with steps/rejected and end-reached nuance", () => {
    const ok: SweepVariantRecord = {
      index: 1,
      value: 1,
      configHash: "x",
      status: "completed",
      summary: transientSummary(),
    };
    expect(formatVariantRow(ok).detail).toBe("10 steps · 2 rejected");
    const incomplete: SweepVariantRecord = {
      ...ok,
      summary: transientSummary({ reachedEnd: false }),
    };
    expect(formatVariantRow(incomplete).detail).toBe(
      "10 steps · 2 rejected · incomplete",
    );
    const aborted: SweepVariantRecord = {
      ...ok,
      summary: transientSummary({ aborted: true }),
    };
    expect(formatVariantRow(aborted).detail).toContain("aborted");
  });

  it("shows the error as the detail for failed variants and dashes elsewhere", () => {
    const failed: SweepVariantRecord = {
      index: 1,
      value: 0.02,
      configHash: "x",
      status: "failed",
      error: "solver exploded",
    };
    const row = formatVariantRow(failed);
    expect(row.detail).toBe("solver exploded");
    expect(row.converged).toBe("—");
    expect(row.peakMdot).toBe("—");
    expect(row.pressure).toBe("—");
    expect(row.error).toBe("solver exploded");
  });

  it("marks pending and running rows", () => {
    const pending: SweepVariantRecord = {
      index: 0,
      value: 1,
      configHash: "x",
      status: "pending",
    };
    expect(formatVariantRow(pending).detail).toBe("—");
    const running: SweepVariantRecord = { ...pending, status: "running" };
    expect(formatVariantRow(running).detail).toBe("solving…");
  });
});

/* ------------------------------------------------------------------ */
/* Progress line                                                       */
/* ------------------------------------------------------------------ */

describe("sweepProgressLine", () => {
  it("describes the in-flight variant with steady progress detail", () => {
    const job = { ...fakeJob(), status: "running" as const };
    const line = sweepProgressLine({
      job,
      activeVariantIndex: 1,
      activeProgress: { kind: "steady", iteration: 4, residual: 1e-7 },
      valueUnit: "m",
    });
    expect(line).toBe(
      "Running variant 2/3 · value 0.02 m · iter 4 · residual 1e-7",
    );
  });

  it("describes transient progress detail", () => {
    const job = { ...fakeJob(), status: "running" as const };
    const line = sweepProgressLine({
      job,
      activeVariantIndex: 0,
      activeProgress: {
        kind: "transient",
        step: 10,
        time: 0.5,
        endTime: 5,
        partial: {} as never,
      },
      valueUnit: "-",
    });
    expect(line).toBe("Running variant 1/3 · value 0.01 · t = 0.5 s / 5 s");
  });

  it("falls back to the frozen summary at terminal states and a ready line when pending", () => {
    expect(
      sweepProgressLine({
        job: fakeJob(),
        activeVariantIndex: null,
        activeProgress: null,
        valueUnit: "m",
      }),
    ).toBe("2/3 completed · 1 failed · 1 converged");
    const pending = {
      ...fakeJob(),
      status: "pending" as const,
      progress: { completed: 0, total: 3 },
    };
    expect(
      sweepProgressLine({
        job: pending,
        activeVariantIndex: null,
        activeProgress: null,
        valueUnit: "m",
      }),
    ).toBe("Ready to run · 3 variants");
  });
});

/* ------------------------------------------------------------------ */
/* CSV export                                                          */
/* ------------------------------------------------------------------ */

describe("buildSweepCsv", () => {
  it("emits provenance comments, a unit-labeled header, and one row per variant", () => {
    const job = fakeJob();
    const csv = buildSweepCsv(job, {
      unitPrefs: SI_PRESET,
      now: 1700000000000,
    });
    const lines = csv.split("\n");

    expect(lines[0]).toBe("# model=Sweep UI");
    expect(lines).toContain(`# base_config_hash=${job.baseConfigHash}`);
    expect(lines).toContain("# sweep_target=Pipe b2 · diameter");
    expect(lines).toContain("# sweep_start=0.01");
    expect(lines).toContain("# sweep_end=0.03");
    expect(lines).toContain("# sweep_count=3");
    expect(lines).toContain("# sweep_spacing=linear");
    expect(lines).toContain("# job_status=completed");
    expect(lines).toContain("# generated=2023-11-14T22:13:20.000Z");

    const headerIdx = lines.findIndex((l) => l.startsWith("index,"));
    const header = lines[headerIdx];
    expect(header).toContain("value (m)"); // pipe diameter: config-native metres
    expect(header).toContain("pressure_min (kPa)"); // auto-scaled SI display unit
    expect(header).toContain("temperature_min (K)");
    expect(header).toContain("peak_abs_mdot (g/s)"); // 0.5 kg/s peak auto-scales to g/s

    const rows = lines.slice(headerIdx + 1);
    expect(rows).toHaveLength(3); // failures keep their rows
    const first = rows[0].split(",");
    expect(first[0]).toBe("0");
    expect(first[1]).toBe("0.01"); // raw full-precision config-native value
    expect(first[2]).toBe("completed");
    expect(first[3]).toBe("yes");
    expect(first[4]).toBe("steady");
    expect(first[5]).toBe("7");
    expect(first[11]).toBe("100"); // 1e5 Pa → 100 kPa in the resolved column scale
    expect(first[16]).toBe("aaa");

    // The failed row keeps status + quoted error, with empty result cells.
    expect(rows[1]).toContain("failed");
    expect(rows[1]).toContain('"solver exploded, badly"');
    expect(rows[1].split(",")[3]).toBe("");

    // Non-converged completed variant reports converged=no.
    expect(rows[2].split(",")[3]).toBe("no");
  });

  it("honors explicit unit preferences in envelope column headers and values", () => {
    const csv = buildSweepCsv(fakeJob(), {
      unitPrefs: { ...SI_PRESET, pressure: "bar" },
      now: 0,
    });
    const header = csv.split("\n").find((l) => l.startsWith("index,"))!;
    expect(header).toContain("pressure_min (bar)");
    const firstRow = csv
      .split("\n")
      .slice(csv.split("\n").indexOf(header) + 1)[0];
    expect(firstRow.split(",")[11]).toBe("1"); // 1e5 Pa → 1 bar
  });

  it("neutralizes spreadsheet formula triggers in the free-text error column", () => {
    for (const trigger of ["=", "+", "-", "@", "\t"]) {
      const job = fakeJob();
      job.variants[1] = {
        ...job.variants[1],
        error: `${trigger}HYPERLINK("http://x")`,
      };
      const csv = buildSweepCsv(job, { now: 0 });
      const lines = csv.split("\n");
      const headerIdx = lines.findIndex((l) => l.startsWith("index,"));
      const row = lines[headerIdx + 2]; // variant 1
      expect(row).toContain(`'${trigger}HYPERLINK(`);
      expect(row).not.toContain(`"${trigger}HYPERLINK`);
    }
    // A quote in a triggered cell is still RFC-4180 escaped after the prefix.
    const job = fakeJob();
    job.variants[1] = { ...job.variants[1], error: '="x"' };
    const csv = buildSweepCsv(job, { now: 0 });
    expect(csv).toContain(`"'=""x"""`);
  });
});

describe("sweepCsvFilename", () => {
  it("is filesystem-safe and carries the swept field + base hash prefix", () => {
    const job = fakeJob();
    const name = sweepCsvFilename(job);
    expect(name).toBe(
      `Sweep_UI-sweep-diameter-${job.baseConfigHash.slice(0, 8)}.csv`,
    );
    expect(name).not.toMatch(/[^\w.-]/);
  });
});

/* ------------------------------------------------------------------ */
/* Option axes                                                         */
/* ------------------------------------------------------------------ */

/**
 * Valid thermal model with both kinds of categorical axis: a wall cp that
 * can be compared against the material registry, and a correlation whose
 * missing axialPosition makes the chilldown models unusable as things
 * stand — the case the picker has to explain rather than hide.
 */
function thermalConfig(): NetworkConfig {
  return {
    meta: { name: "Sweep Options", version: 2 },
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

function optionDescriptorOf(
  cfg: NetworkConfig,
  label: string,
): OptionSweepDescriptor {
  const d = listSweepTargets(cfg).find((t) => t.label === label);
  if (!d || d.axis !== "options") throw new Error(`no option target ${label}`);
  return d;
}

/** Option-axis twin of fakeJob: three materials, one of them failed. */
function fakeOptionJob(): SolveJob {
  const base = thermalConfig();
  return {
    ...fakeJob(),
    baseConfig: base,
    baseConfigHash: configHash(base),
    sweep: {
      target: { kind: "solidNode", id: "wall", field: "cp.material" },
      spacing: "options",
      optionIds: ["current", "ofhc-copper", "ptfe"],
    },
    targetLabel: "Solid node wall · cp material",
    variants: [
      {
        index: 0,
        value: "current",
        valueLabel: "Current — 385 J/(kg·K)",
        configHash: "aaa",
        status: "completed",
        summary: steadySummary,
        durationMs: 12,
      },
      {
        index: 1,
        value: "ofhc-copper",
        valueLabel: "OFHC copper",
        configHash: "bbb",
        status: "failed",
        error: "solver exploded, badly",
        durationMs: 2500,
      },
      {
        index: 2,
        value: "ptfe",
        valueLabel: "PTFE (Teflon)",
        configHash: "ccc",
        status: "completed",
        summary: steadySummary,
        durationMs: 1500,
      },
    ],
  };
}

describe("checkSweepOptions / defaultOptionSelection", () => {
  it("marks every option that validates on its own and preselects those", () => {
    const cfg = thermalConfig();
    const d = optionDescriptorOf(cfg, "Solid node wall · cp material");
    const validity = checkSweepOptions(cfg, d);
    expect(validity.length).toBe(d.options.length);
    expect(validity.every((v) => v.ok)).toBe(true);
    expect(defaultOptionSelection(cfg, d)).toEqual(d.options.map((o) => o.id));
  });

  it("reports the model-validation reason for an option that cannot be used", () => {
    const cfg = thermalConfig();
    const d = optionDescriptorOf(cfg, "Convection cwall · heat-transfer model");
    const validity = checkSweepOptions(cfg, d);

    // The chilldown closures need an axial position this conductor lacks.
    const darr = validity.find((v) => v.id === "darrHartwig")!;
    expect(darr.ok).toBe(false);
    expect(darr.error).toMatch(/axialPosition/);
    expect(validity.find((v) => v.id === "dittusBoelter")!.ok).toBe(true);

    // Only the usable ones are preselected, so the form runs as offered.
    expect(defaultOptionSelection(cfg, d)).toEqual([
      "dittusBoelter",
      "miropolskii",
    ]);
  });

  it("falls back to the current option when nothing validates", () => {
    const cfg = thermalConfig();
    // Named correlations require the realFluid model; on an incompressible
    // fluid every choice fails, and the axis still must not be empty.
    cfg.fluid = { model: "incompressible", preset: "water" };
    const d = optionDescriptorOf(cfg, "Convection cwall · heat-transfer model");
    expect(checkSweepOptions(cfg, d).every((v) => !v.ok)).toBe(true);
    expect(defaultOptionSelection(cfg, d)).toEqual(["dittusBoelter"]);
  });
});

describe("toggleOptionId / formatSweepValue", () => {
  it("toggles membership while preserving selection order", () => {
    expect(toggleOptionId(["a", "b"], "c")).toEqual(["a", "b", "c"]);
    expect(toggleOptionId(["a", "b", "c"], "b")).toEqual(["a", "c"]);
  });

  it("prefers the frozen option label and falls back to formatted numbers", () => {
    expect(
      formatSweepValue({ value: "ofhc-copper", valueLabel: "OFHC copper" }),
    ).toBe("OFHC copper");
    expect(formatSweepValue({ value: 0.012345 }, 3)).toBe("0.0123");
    // A label-less option id still reads as itself rather than as NaN.
    expect(formatSweepValue({ value: "ptfe" })).toBe("ptfe");
  });
});

describe("option-sweep presentation", () => {
  it("names the option instead of a number in variant rows and the progress line", () => {
    const job = fakeOptionJob();
    expect(formatVariantRow(job.variants[0]).value).toBe(
      "Current — 385 J/(kg·K)",
    );

    const line = sweepProgressLine({
      job: { ...job, status: "running" },
      activeVariantIndex: 1,
      activeProgress: null,
      valueUnit: "J/(kg·K)",
    });
    // No unit is appended to a named choice — it is not a measurement.
    expect(line).toBe("Running variant 2/3 · value OFHC copper");
  });

  it("exports the option id with its label, and the selection as provenance", () => {
    const csv = buildSweepCsv(fakeOptionJob(), {
      unitPrefs: SI_PRESET,
      now: 0,
    });
    const lines = csv.split("\n");
    expect(lines).toContain("# sweep_options=current|ofhc-copper|ptfe");
    expect(lines).toContain("# sweep_count=3");
    expect(lines).toContain("# sweep_spacing=options");
    expect(lines.some((l) => l.startsWith("# sweep_start="))).toBe(false);

    const headerIdx = lines.findIndex((l) => l.startsWith("index,"));
    expect(lines[headerIdx]).toContain("value,value_label,status");

    const first = lines[headerIdx + 1].split(",");
    expect(first[0]).toBe("0");
    expect(first[1]).toBe("current");
    expect(first[2]).toBe("Current — 385 J/(kg·K)");
    expect(first[3]).toBe("completed");
  });

  it("names the swept field in the download filename", () => {
    expect(sweepCsvFilename(fakeOptionJob())).toMatch(/-sweep-cp\.material-/);
  });
});
