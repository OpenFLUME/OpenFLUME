/**
 * SplitPipeSection — the property panel's inline "Split into N segments"
 * control (Phase 4b), plus the pure helpers behind it in
 * ../repeatSelection.ts.
 *
 * The repo has no DOM test environment (every .test.tsx renders with
 * react-dom/server), so these tests split the section along the same line
 * the implementation does: the interactive shell is asserted on its SSR
 * HTML (gating by component type, defaults, the disabled/invalid wiring via
 * the initialSegments seed), and everything that would need a typed
 * keystroke — count validation, the live summary's count dependence, the
 * exact apply arguments — is pinned through the pure helpers that the
 * section's render/apply paths call directly.  The store-level flow (the
 * arguments splitBranch actually receives, the preserved totals, the
 * failure path) is exercised against the real store.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { renderToString } from "react-dom/server";
import type { ReactElement } from "react";
import PropertyPanel from "../components/PropertyPanel";
import SplitPipeSection from "../components/SplitPipeSection";
import {
  buildSplitArgs,
  isSplittableComponentType,
  parseSplitCount,
  resolvedBranchLength,
  splitSummaryText,
  splitUnclonedWarnings,
  REPEAT_COUNT_MAX,
  REPEAT_COUNT_MIN,
} from "../repeatSelection";
import { useStore } from "../store";
import { previewNetworkParameters, validateNetwork } from "../../core";
import type { NetworkConfig, Selection } from "../types";

type Branch = NetworkConfig["branches"][number];

const PIPE = {
  type: "pipe",
  length: 1,
  diameter: 0.02,
  roughness: 1e-5,
} as const;

/** Boundary A → boundary B through one branch p1 (the split target). */
function cfgWith(component: Branch["component"]): NetworkConfig {
  return {
    meta: { name: "Split", version: 2 },
    settings: { mode: "steady", tolerance: 1e-6, maxIterations: 100 },
    fluid: { model: "incompressible", preset: "water" },
    nodes: [
      {
        id: "A",
        type: "boundary",
        x: 0,
        y: 0,
        pressure: 2e5,
        temperature: 300,
      },
      {
        id: "B",
        type: "boundary",
        x: 100,
        y: 0,
        pressure: 1e5,
        temperature: 300,
      },
    ],
    branches: [{ id: "p1", from: "A", to: "B", component }],
  };
}

const pipeCfg = () => cfgWith({ ...PIPE });
const heatedCfg = () =>
  cfgWith({ ...PIPE, type: "heatedPipe", ua: 50, wallTemperature: 400 });
/** An { expr } length that RESOLVES — must be evaluated, not read raw. */
const exprLengthCfg = () => cfgWith({ ...PIPE, length: { expr: "2 * 0.5" } });
/** An expression that cannot resolve: the summary must degrade, not NaN. */
const brokenLengthCfg = () => cfgWith({ ...PIPE, length: { expr: "1 +" } });

const P1: Selection = { kind: "branch", id: "p1" };

function loadConfig(config: NetworkConfig, selection: Selection = P1) {
  useStore.setState({
    config,
    baseConfig: structuredClone(config),
    activeVariantId: null,
    selection,
    result: null,
    resultConfig: null,
    resultDiary: null,
    runHistory: [],
    runSeq: 0,
    selectedRunId: null,
    baselineRunId: null,
    canvasSelection: [],
    past: [],
    future: [],
    dirty: false,
    resultStale: false,
    duplicateNotice: "",
    preparingOperation: null,
  });
}

/** SSR inserts `<!-- -->` separators between adjacent text nodes. */
const render = (el: ReactElement) =>
  renderToString(el).replace(/<!-- -->/g, "");

/**
 * SSR render of the whole property panel.  Zustand's useSyncExternalStore
 * server snapshot is the INITIAL state object, so SSR tests seed by
 * mutating it (the propertyPanelGaps convention) — setState would only
 * reach the client snapshot.  Store-flow tests below use setState instead.
 */
function renderPanel(config: NetworkConfig, selection: Selection = P1) {
  Object.assign(useStore.getInitialState(), {
    config,
    baseConfig: config,
    selection,
    result: null,
  });
  return render(<PropertyPanel />);
}

/**
 * SSR render of the section alone with its count field seeded (the repo has
 * no DOM to type into).  The section takes config by prop and only touches
 * the store inside apply, so no state seeding is needed here.
 */
function renderSection(config: NetworkConfig, segments: string) {
  return render(
    <SplitPipeSection
      config={config}
      branchId="p1"
      initialSegments={segments}
    />,
  );
}

const tagOf = (html: string, testid: string) => {
  const match = html.match(
    new RegExp(`<[a-z]+[^>]*data-testid="${testid}"[^>]*>`),
  );
  expect(match, `tag for ${testid}`).not.toBeNull();
  return match![0];
};

/* ------------------------------------------------------------------ */
/* parseSplitCount                                                     */
/* ------------------------------------------------------------------ */

describe("parseSplitCount", () => {
  it("rejects an empty field, non-numbers, and non-integers", () => {
    for (const raw of ["", "   ", "abc", "2.5", "NaN"]) {
      expect(parseSplitCount(raw).ok, raw).toBe(false);
    }
    for (const [raw, message] of [
      ["", "number of segments"],
      ["abc", "integer"],
      ["2.5", "integer"],
    ] as const) {
      const parsed = parseSplitCount(raw);
      if (!parsed.ok) expect(parsed.error).toContain(message);
      else expect.unreachable(`${raw} should not parse`);
    }
  });

  it("rejects 1, 0, negative, and counts above the max", () => {
    for (const raw of ["1", "0", "-3"]) {
      const parsed = parseSplitCount(raw);
      expect(parsed.ok, raw).toBe(false);
      if (!parsed.ok) expect(parsed.error).toContain("at least 2");
    }
    const over = parseSplitCount(String(REPEAT_COUNT_MAX + 1));
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.error).toContain(String(REPEAT_COUNT_MAX));
  });

  it("accepts the boundaries and trims whitespace", () => {
    expect(parseSplitCount(String(REPEAT_COUNT_MIN))).toEqual({
      ok: true,
      value: REPEAT_COUNT_MIN,
    });
    expect(parseSplitCount(String(REPEAT_COUNT_MAX))).toEqual({
      ok: true,
      value: REPEAT_COUNT_MAX,
    });
    expect(parseSplitCount(" 10 ")).toEqual({ ok: true, value: 10 });
  });

  it("keeps repeat wording out of the split messages", () => {
    const parsed = parseSplitCount("1");
    if (!parsed.ok) {
      expect(parsed.error).toContain("segments");
      expect(parsed.error).not.toContain("instance");
    } else {
      expect.unreachable("1 should not parse");
    }
  });
});

/* ------------------------------------------------------------------ */
/* isSplittableComponentType + resolvedBranchLength                    */
/* ------------------------------------------------------------------ */

describe("eligibility and length resolution", () => {
  it("matches the core gate: pipe and heatedPipe only", () => {
    expect(isSplittableComponentType("pipe")).toBe(true);
    expect(isSplittableComponentType("heatedPipe")).toBe(true);
    for (const type of ["orifice", "valve", "pump", "bend", "regulator"]) {
      expect(isSplittableComponentType(type), type).toBe(false);
    }
  });

  it("resolves a literal length", () => {
    expect(resolvedBranchLength(pipeCfg(), "p1")).toBe(1);
  });

  it("resolves an { expr } length instead of assuming a literal", () => {
    expect(resolvedBranchLength(exprLengthCfg(), "p1")).toBe(1);
  });

  it("returns null when the length cannot resolve (never a NaN)", () => {
    expect(resolvedBranchLength(brokenLengthCfg(), "p1")).toBeNull();
  });

  it("returns null for non-pipe components and unknown branches", () => {
    const orifice = cfgWith({ type: "orifice", area: 1e-3, cd: 0.6 });
    expect(resolvedBranchLength(orifice, "p1")).toBeNull();
    expect(resolvedBranchLength(pipeCfg(), "ghost")).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* splitSummaryText — the live summary                                 */
/* ------------------------------------------------------------------ */

describe("splitSummaryText", () => {
  it("counts the inserted nodes and pipes (N segments ⇒ N−1 of each)", () => {
    expect(splitSummaryText(2, 1)).toBe(
      "Creates 1 new node and 1 new pipe; each segment 0.5 m.",
    );
    expect(splitSummaryText(10, 3.05)).toBe(
      "Creates 9 new nodes and 9 new pipes; each segment 0.305 m.",
    );
  });

  it("rounds the per-segment length to significant figures", () => {
    expect(splitSummaryText(3, 1)).toBe(
      "Creates 2 new nodes and 2 new pipes; each segment 0.3333 m.",
    );
  });

  it("omits the per-segment figure when the length did not resolve", () => {
    expect(splitSummaryText(2, null)).toBe(
      "Creates 1 new node and 1 new pipe.",
    );
    expect(splitSummaryText(2, null)).not.toContain("NaN");
  });
});

/* ------------------------------------------------------------------ */
/* buildSplitArgs — exactly what apply hands to the store              */
/* ------------------------------------------------------------------ */

describe("buildSplitArgs", () => {
  it("folds the draft into exact store arguments", () => {
    expect(buildSplitArgs({ segments: "10", linkParams: true })).toEqual({
      ok: true,
      args: { segments: 10, linkParams: true },
    });
    expect(buildSplitArgs({ segments: "2", linkParams: false })).toEqual({
      ok: true,
      args: { segments: 2, linkParams: false },
    });
  });

  it("fails on an invalid count", () => {
    const built = buildSplitArgs({ segments: "1", linkParams: true });
    expect(built.ok).toBe(false);
    if (!built.ok) expect(built.error).toContain("at least 2");
  });
});

/* ------------------------------------------------------------------ */
/* Section rendering inside the property panel (react-dom/server)      */
/* ------------------------------------------------------------------ */

describe("SplitPipeSection in PropertyPanel", () => {
  it("renders for a pipe branch", () => {
    const html = renderPanel(pipeCfg());
    for (const testid of [
      "split-segments",
      "split-link-params",
      "split-apply",
      "split-summary",
    ]) {
      expect(html).toContain(`data-testid="${testid}"`);
    }
    expect(html).toContain("Split into segments");
  });

  it("renders for a heatedPipe branch with the UA preservation hint", () => {
    const html = renderPanel(heatedCfg());
    expect(html).toContain('data-testid="split-segments"');
    expect(html).toContain("Total length, elevation change and UA");
    expect(html).toContain("divided across the segments, not duplicated");
  });

  it("does NOT render for non-pipe components (orifice, valve, pump)", () => {
    const orifice = renderPanel(
      cfgWith({ type: "orifice", area: 1e-3, cd: 0.6 }),
    );
    const valve = renderPanel(
      cfgWith({ type: "valve", area: 1e-3, cd: 0.6, position: 1 }),
    );
    const pump = renderPanel(
      cfgWith({
        type: "pump",
        curve: [
          [0, 0],
          [0.001, 100000],
        ],
      }),
    );
    for (const html of [orifice, valve, pump]) {
      expect(html).not.toContain('data-testid="split-segments"');
      expect(html).not.toContain('data-testid="split-apply"');
    }
  });

  it("bounds the count field 2…200 with the pipe's eventual role explained", () => {
    const html = renderPanel(pipeCfg());
    const count = tagOf(html, "split-segments");
    expect(count).toContain('type="number"');
    expect(count).toContain(`value="${REPEAT_COUNT_MIN}"`);
    expect(count).toContain(`min="${REPEAT_COUNT_MIN}"`);
    expect(count).toContain(`max="${REPEAT_COUNT_MAX}"`);
    expect(html).toContain("The original pipe becomes the last segment");
  });

  it("defaults link-parameters ON, consistent with the Repeat dialog", () => {
    const html = renderPanel(pipeCfg());
    expect(tagOf(html, "split-link-params")).toContain("checked");
    expect(html).toContain("Link parameters to the first segment");
    expect(html).toContain("Uncheck for independent segments");
  });

  it("shows the live summary with the literal per-segment length", () => {
    const html = renderPanel(pipeCfg());
    expect(html).toContain("Creates 1 new node and 1 new pipe");
    expect(html).toContain("each segment 0.5 m");
  });

  it("resolves an { expr } length for the summary rather than reading it raw", () => {
    const html = renderPanel(exprLengthCfg());
    expect(html).toContain("each segment 0.5 m");
  });

  it("scales the summary with the seeded count", () => {
    const html = renderSection(cfgWith({ ...PIPE, length: 3.05 }), "10");
    expect(html).toContain("Creates 9 new nodes and 9 new pipes");
    expect(html).toContain("each segment 0.305 m");
  });

  it("degrades gracefully when the length cannot be resolved (no NaN)", () => {
    const html = renderPanel(brokenLengthCfg());
    expect(html).toContain("Creates 1 new node and 1 new pipe.");
    expect(html).not.toContain("each segment");
    expect(html).not.toContain("NaN");
  });

  it("enables apply for a valid count and shows no error", () => {
    const html = renderPanel(pipeCfg());
    expect(tagOf(html, "split-apply")).not.toContain("disabled");
    expect(tagOf(html, "split-segments")).toContain('aria-invalid="false"');
  });

  it("disables apply and shows the message for an invalid count", () => {
    const low = renderSection(pipeCfg(), "1");
    expect(tagOf(low, "split-apply")).toContain("disabled");
    expect(tagOf(low, "split-segments")).toContain('aria-invalid="true"');
    expect(low).toContain("Split needs at least 2 segments");
    expect(low).toContain('role="alert"');

    const fractional = renderSection(pipeCfg(), "2.5");
    expect(tagOf(fractional, "split-apply")).toContain("disabled");
    expect(fractional).toContain("Segments must be an integer");
  });
});

/* ------------------------------------------------------------------ */
/* Apply flow against the store                                        */
/* ------------------------------------------------------------------ */

describe("apply flow against the store", () => {
  beforeEach(() => loadConfig(pipeCfg()));

  it("splitBranch accepts the section's default arguments verbatim", () => {
    const s = () => useStore.getState();
    const built = buildSplitArgs({
      segments: String(REPEAT_COUNT_MIN),
      linkParams: true,
    });
    expect(built).toEqual({
      ok: true,
      args: { segments: 2, linkParams: true },
    });
    if (!built.ok) return;
    const res = s().splitBranch("p1", built.args.segments, {
      linkParams: built.args.linkParams,
    });
    expect(res).toEqual({
      nodes: 1,
      solidNodes: 0,
      branches: 1,
      conductors: 0,
    });
    expect(s().duplicateNotice).toBe(
      "Split p1 into 2 segments: 1 node, 1 branch",
    );
    expect(s().past).toHaveLength(1);
  });

  it("a 1 m pipe split 10× gives 10 pipes + 9 nodes, preserves total length, validates", () => {
    const s = () => useStore.getState();
    const built = buildSplitArgs({ segments: "10", linkParams: true });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const res = s().splitBranch("p1", built.args.segments, {
      linkParams: built.args.linkParams,
    });
    expect(res).toEqual({
      nodes: 9,
      solidNodes: 0,
      branches: 9,
      conductors: 0,
    });
    expect(s().config.branches).toHaveLength(10);
    expect(s().config.nodes).toHaveLength(11);
    // linkParams: the mid segments bind their fields to the first segment,
    // so the total-length check must go through the RESOLVED parameters.
    const resolution = previewNetworkParameters(s().config);
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;
    const total = resolution.config.branches.reduce(
      (sum, b) => sum + (b.component as unknown as { length: number }).length,
      0,
    );
    expect(total).toBeCloseTo(1, 12);
    expect(validateNetwork(s().config)).toEqual([]);
  });

  it("preserves a heatedPipe's total length AND ua across the segments", () => {
    loadConfig(heatedCfg());
    const s = () => useStore.getState();
    const res = s().splitBranch("p1", 4, { linkParams: false });
    expect(res).toEqual({
      nodes: 3,
      solidNodes: 0,
      branches: 3,
      conductors: 0,
    });
    const resolution = previewNetworkParameters(s().config);
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;
    let length = 0;
    let ua = 0;
    for (const b of resolution.config.branches) {
      const c = b.component as unknown as { length: number; ua: number };
      length += c.length;
      ua += c.ua;
    }
    expect(length).toBeCloseTo(1, 12);
    expect(ua).toBeCloseTo(50, 12);
    expect(validateNetwork(s().config)).toEqual([]);
  });

  it("a failed split surfaces the error and leaves the model untouched", () => {
    // The panel never shows the section for an orifice, but the store action
    // is the real gate: a stale panel (type changed mid-edit) must fail safe.
    loadConfig(cfgWith({ type: "orifice", area: 1e-3, cd: 0.6 }));
    const s = () => useStore.getState();
    const before = s().config;
    const built = buildSplitArgs({ segments: "2", linkParams: true });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const res = s().splitBranch("p1", built.args.segments, {
      linkParams: built.args.linkParams,
    });
    expect(res).toBeNull();
    // What the section surfaces as its submit error (duplicateNotice).
    expect(s().duplicateNotice).toBe(
      "Cannot split branch: only pipe and heatedPipe branches can be split ('p1' is a orifice)",
    );
    expect(s().config).toBe(before);
    expect(validateNetwork(s().config)).toEqual([]);
    expect(s().past).toHaveLength(0);
    expect(s().dirty).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* splitUnclonedWarnings — the targeted "references see only the last  */
/* segment" caveat (a split branch KEEPS its id).                       */
/* ------------------------------------------------------------------ */

/** A controller sensing the split pipe's mass flow. */
const sensedCfg = (): NetworkConfig => ({
  ...pipeCfg(),
  settings: { ...pipeCfg().settings, mode: "transient" },
  controllers: [
    {
      id: "pid1",
      type: "pid",
      sense: { kind: "branch", id: "p1", quantity: "massFlow" },
      setpoint: 0.5,
      gains: { kp: 1, ki: 0, kd: 0 },
      output: { kind: "boundaryPressure", id: "A" },
    },
  ],
});

/** A logic rule reading the split pipe's length. */
const splitLogicCfg = (): NetworkConfig => ({
  ...pipeCfg(),
  logic: [{ id: "r1", when: "pipe('p1').length > 0.5" }],
});

describe("splitUnclonedWarnings", () => {
  it("warns when a controller or logic rule references the split branch", () => {
    expect(splitUnclonedWarnings(sensedCfg(), "p1")).toEqual([
      "Controller pid1 references this branch — after the split it sees only the last segment (which keeps the id); the new segments are not covered.",
    ]);
    expect(splitUnclonedWarnings(splitLogicCfg(), "p1")).toEqual([
      "Logic rule r1 references this branch — after the split it sees only the last segment (which keeps the id); the new segments are not covered.",
    ]);
  });

  it("stays silent when nothing references the branch", () => {
    expect(splitUnclonedWarnings(pipeCfg(), "p1")).toEqual([]);
    // References to OTHER entities do not fire it either.
    expect(splitUnclonedWarnings(sensedCfg(), "ghost")).toEqual([]);
  });
});

describe("SplitPipeSection uncloned-record warning", () => {
  it("shows the targeted warning when the branch is controller-referenced", () => {
    const html = renderSection(sensedCfg(), "2");
    expect(tagOf(html, "split-uncloned-warning")).toContain('role="note"');
    expect(html).toContain("Controller pid1 references this branch");
    expect(html).toContain("sees only the last segment");
  });

  it("renders no warning for an unreferenced branch", () => {
    const html = renderSection(pipeCfg(), "2");
    expect(html).not.toContain('data-testid="split-uncloned-warning"');
  });
});
