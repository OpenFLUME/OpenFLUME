/**
 * RepeatDialog + RepeatMenuAction (Phase 4a).
 *
 * The repo has no DOM test environment (every .test.tsx renders with
 * react-dom/server), so these tests split the dialog along the same line the
 * implementation does: the interactive shell is asserted on its SSR HTML
 * (defaults, validation state, disabled reasons, tooltips), and everything
 * that would need a typed keystroke — count validation, the live summary's
 * count dependence, the exact confirm arguments — is pinned through the
 * pure helpers in ../repeatSelection.ts that the dialog's render/confirm
 * paths call directly.  Escape-closes / Enter-confirms follow the shared
 * ConfirmDialog keydown pattern and are covered by e2e, not here.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { renderToString } from "react-dom/server";
import type { ReactElement } from "react";
import RepeatDialog, { RepeatMenuAction } from "../components/RepeatDialog";
import {
  analyzeRepeatSelection,
  buildRepeatArgs,
  deriveRepeatDefaults,
  parseRepeatCount,
  perInstanceRepeatCounts,
  repeatSummaryText,
  repeatUnclonedWarnings,
  repeatUnitReferenceIds,
  unclonedUnitReferences,
  REPEAT_COUNT_MAX,
  REPEAT_COUNT_MIN,
  type RepeatDraft,
} from "../repeatSelection";
import { useStore } from "../store";
import type { NetworkConfig } from "../types";

const PIPE = {
  type: "pipe",
  length: 1,
  diameter: 0.02,
  roughness: 1e-5,
} as const;

/** a → n1 → b: one entry branch (seg1), one exit branch (seg2). */
const chainCfg = (): NetworkConfig => ({
  meta: { name: "Chain", version: 2 },
  settings: { mode: "steady", tolerance: 1e-6, maxIterations: 100 },
  fluid: { model: "incompressible", preset: "water" },
  nodes: [
    { id: "a", type: "boundary", x: 0, y: 0, pressure: 2e5, temperature: 300 },
    {
      id: "n1",
      type: "internal",
      x: 100,
      y: 0,
      volume: 1e-3,
      pressure: 1.5e5,
      temperature: 300,
    },
    {
      id: "b",
      type: "boundary",
      x: 200,
      y: 0,
      pressure: 1e5,
      temperature: 300,
    },
  ],
  branches: [
    { id: "seg1", from: "a", to: "n1", component: { ...PIPE } },
    { id: "seg2", from: "n1", to: "b", component: { ...PIPE } },
  ],
});

/** The chain with a wall node tied to n1 (induced) and ambient (crossing). */
const chainWithWallCfg = (): NetworkConfig => ({
  ...chainCfg(),
  solidNodes: [
    {
      id: "wall1",
      type: "solid",
      x: 100,
      y: 60,
      temperature: 350,
      mass: 2,
      cp: 385,
    },
    { id: "amb", type: "ambient", x: 0, y: 60, temperature: 290 },
  ],
  conductors: [
    {
      id: "conv1",
      from: "wall1",
      to: "n1",
      type: { kind: "convection", h: 100, area: 0.01 },
    },
    {
      id: "cx",
      from: "wall1",
      to: "amb",
      type: { kind: "conduction", k: 200, area: 0.01, length: 0.05 },
    },
  ],
});

/** Two branches ENTER n1: the seam is ambiguous without a multi selection. */
const ambiguousCfg = (): NetworkConfig => {
  const base = chainCfg();
  base.nodes.splice(1, 0, {
    id: "c",
    type: "boundary",
    x: 0,
    y: 200,
    pressure: 2e5,
    temperature: 300,
  });
  base.branches.splice(1, 0, {
    id: "segB",
    from: "c",
    to: "n1",
    component: { ...PIPE },
  });
  return base;
};

/** Seam pipe length behind an expression: must be RESOLVED, not read raw. */
const exprLengthCfg = (): NetworkConfig => {
  const base = chainCfg();
  base.branches[0]!.component = {
    ...PIPE,
    length: { expr: "2 * 0.5" },
  };
  return base;
};

/** Non-pipe seam: no length to derive the physical spacing from. */
const orificeSeamCfg = (): NetworkConfig => {
  const base = chainCfg();
  base.branches[0]!.component = { type: "orifice", area: 3e-4, cd: 0.62 };
  return base;
};

/** Seam source and exit sit on the same spot: no natural pitch, so the
 *  canvas default must fall back to the member bounding box. */
const degeneratePitchCfg = (): NetworkConfig => {
  const base = chainCfg();
  base.nodes[0]!.x = 100; // a sits on top of n1
  return base;
};

const okChain = () =>
  analyzeRepeatSelection(chainCfg(), { kind: "none" }, ["n1"]);

/** SSR inserts `<!-- -->` separators between adjacent text nodes. */
const render = (el: ReactElement) =>
  renderToString(el).replace(/<!-- -->/g, "");

const tagOf = (html: string, testid: string) => {
  const match = html.match(
    new RegExp(`<[a-z]+[^>]*data-testid="${testid}"[^>]*>`),
  );
  expect(match, `tag for ${testid}`).not.toBeNull();
  return match![0];
};

function loadConfig(config: NetworkConfig) {
  useStore.setState({
    config,
    baseConfig: structuredClone(config),
    activeVariantId: null,
    selection: { kind: "none" },
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

/* ------------------------------------------------------------------ */
/* parseRepeatCount                                                    */
/* ------------------------------------------------------------------ */

describe("parseRepeatCount", () => {
  it("rejects an empty field, non-numbers, and non-integers", () => {
    for (const raw of ["", "   ", "abc", "2.5", "1e0.5", "NaN"]) {
      const parsed = parseRepeatCount(raw);
      expect(parsed.ok, raw).toBe(false);
    }
    for (const [raw, message] of [
      ["", "total number of instances"],
      ["abc", "integer"],
      ["2.5", "integer"],
    ] as const) {
      const parsed = parseRepeatCount(raw);
      if (!parsed.ok) expect(parsed.error).toContain(message);
      else expect.unreachable(`${raw} should not parse`);
    }
  });

  it("rejects counts below the minimum and above the maximum", () => {
    for (const raw of ["1", "0", "-3"]) {
      const parsed = parseRepeatCount(raw);
      expect(parsed.ok, raw).toBe(false);
      if (!parsed.ok) expect(parsed.error).toContain("at least 2");
    }
    const over = parseRepeatCount(String(REPEAT_COUNT_MAX + 1));
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.error).toContain(String(REPEAT_COUNT_MAX));
  });

  it("accepts the boundaries and trims whitespace", () => {
    expect(parseRepeatCount(String(REPEAT_COUNT_MIN))).toEqual({
      ok: true,
      value: REPEAT_COUNT_MIN,
    });
    expect(parseRepeatCount(String(REPEAT_COUNT_MAX))).toEqual({
      ok: true,
      value: REPEAT_COUNT_MAX,
    });
    expect(parseRepeatCount(" 3 ")).toEqual({ ok: true, value: 3 });
  });
});

/* ------------------------------------------------------------------ */
/* deriveRepeatDefaults                                                */
/* ------------------------------------------------------------------ */

describe("deriveRepeatDefaults", () => {
  it("derives the canvas pitch from the seam and exit, snapped to the grid", () => {
    // Seam a→n1 enters at the exit node itself: pitch = (100, 0), snapped
    // to the 15 px canvas grid → 105.  Not a hard-coded round number.
    const defaults = deriveRepeatDefaults(chainCfg(), okChain());
    expect(defaults.canvasOffset).toEqual({ x: 105, y: 0 });
  });

  it("derives the physical spacing from the seam pipe's resolved length", () => {
    const defaults = deriveRepeatDefaults(chainCfg(), okChain());
    expect(defaults.physicalOffset).toEqual({ x: 1, y: 0, z: 0 });
  });

  it("resolves an { expr } seam length instead of assuming a literal", () => {
    const cfg = exprLengthCfg();
    const repeatable = analyzeRepeatSelection(cfg, { kind: "none" }, ["n1"]);
    expect(repeatable.canRepeat).toBe(true);
    const defaults = deriveRepeatDefaults(cfg, repeatable);
    expect(defaults.physicalOffset).toEqual({ x: 1, y: 0, z: 0 });
  });

  it("falls back to zero physical spacing for a non-pipe seam", () => {
    const cfg = orificeSeamCfg();
    const repeatable = analyzeRepeatSelection(cfg, { kind: "none" }, ["n1"]);
    expect(repeatable.canRepeat).toBe(true);
    expect(deriveRepeatDefaults(cfg, repeatable).physicalOffset).toEqual({
      x: 0,
      y: 0,
      z: 0,
    });
  });

  it("falls back to the member bounding box when the seam gives no pitch", () => {
    const cfg = degeneratePitchCfg();
    const repeatable = analyzeRepeatSelection(cfg, { kind: "none" }, ["n1"]);
    expect(repeatable.canRepeat).toBe(true);
    // Member n1 renders 22 px wide; width + a two-cell gap (52 px) snapped
    // to the 15 px grid → 45 px of horizontal tiling, no overlap.
    expect(deriveRepeatDefaults(cfg, repeatable).canvasOffset).toEqual({
      x: 45,
      y: 0,
    });
  });

  it("returns inert defaults when the selection cannot repeat", () => {
    const nothing = analyzeRepeatSelection(chainCfg(), { kind: "none" }, []);
    expect(nothing.canRepeat).toBe(false);
    expect(deriveRepeatDefaults(chainCfg(), nothing)).toEqual({
      canvasOffset: { x: 30, y: 0 },
      physicalOffset: { x: 0, y: 0, z: 0 },
    });
  });
});

/* ------------------------------------------------------------------ */
/* perInstanceRepeatCounts + repeatSummaryText (the live summary)      */
/* ------------------------------------------------------------------ */

describe("live summary derivation", () => {
  it("counts one instance's created entities, seam clone included", () => {
    expect(perInstanceRepeatCounts(chainCfg(), okChain())).toEqual({
      nodes: 1,
      solidNodes: 0,
      branches: 1,
      conductors: 0,
    });
  });

  it("counts solid nodes and induced + crossing conductors", () => {
    const cfg = chainWithWallCfg();
    const repeatable = analyzeRepeatSelection(cfg, { kind: "none" }, [
      "n1",
      "wall1",
    ]);
    expect(perInstanceRepeatCounts(cfg, repeatable)).toEqual({
      nodes: 1,
      solidNodes: 1,
      branches: 1,
      conductors: 2,
    });
  });

  it("is null when the selection cannot repeat", () => {
    const cfg = ambiguousCfg();
    const blocked = analyzeRepeatSelection(cfg, { kind: "none" }, ["n1"]);
    expect(perInstanceRepeatCounts(cfg, blocked)).toBeNull();
  });

  it("scales the summary with the count (the dialog's live text)", () => {
    const per = perInstanceRepeatCounts(chainCfg(), okChain())!;
    expect(repeatSummaryText(2, per)).toBe(
      "Creates 1 more instance: 1 node, 1 branch.",
    );
    expect(repeatSummaryText(20, per)).toBe(
      "Creates 19 more instances: 19 nodes, 19 branches.",
    );
  });
});

/* ------------------------------------------------------------------ */
/* buildRepeatArgs — exactly what confirm hands to the store           */
/* ------------------------------------------------------------------ */

/** The draft the dialog initializes from its derived defaults. */
const defaultDraft = (config: NetworkConfig): RepeatDraft => {
  const defaults = deriveRepeatDefaults(
    config,
    analyzeRepeatSelection(config, { kind: "none" }, ["n1"]),
  );
  return {
    count: String(REPEAT_COUNT_MIN),
    linkParams: true,
    canvasX: String(defaults.canvasOffset.x),
    canvasY: String(defaults.canvasOffset.y),
    physX: String(defaults.physicalOffset.x),
    physY: String(defaults.physicalOffset.y),
    physZ: String(defaults.physicalOffset.z),
  };
};

describe("buildRepeatArgs", () => {
  it("folds the default draft into exact store arguments", () => {
    const built = buildRepeatArgs(defaultDraft(chainCfg()));
    expect(built).toEqual({
      ok: true,
      args: {
        count: 2,
        linkParams: true,
        canvasOffset: { x: 105, y: 0 },
        physicalOffset: { x: 1, y: 0, z: 0 },
      },
    });
  });

  it("fails on an invalid count before looking at spacing", () => {
    const built = buildRepeatArgs({ ...defaultDraft(chainCfg()), count: "1" });
    expect(built.ok).toBe(false);
    if (!built.ok) expect(built.error).toContain("at least 2");
  });

  it("requires finite canvas spacing and treats blank physical fields as 0", () => {
    const badCanvas = buildRepeatArgs({
      ...defaultDraft(chainCfg()),
      canvasX: "",
    });
    expect(badCanvas.ok).toBe(false);
    const blankPhysical = buildRepeatArgs({
      ...defaultDraft(chainCfg()),
      physX: "",
      physY: "",
      physZ: "",
    });
    expect(blankPhysical).toMatchObject({
      ok: true,
      args: { physicalOffset: { x: 0, y: 0, z: 0 } },
    });
    const badPhysical = buildRepeatArgs({
      ...defaultDraft(chainCfg()),
      physY: "soon",
    });
    expect(badPhysical.ok).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* RepeatDialog rendering (react-dom/server)                           */
/* ------------------------------------------------------------------ */

describe("RepeatDialog", () => {
  const renderDialog = (
    config: NetworkConfig = chainCfg(),
    repeatability = analyzeRepeatSelection(config, { kind: "none" }, ["n1"]),
  ) =>
    render(
      <RepeatDialog
        config={config}
        repeatability={repeatability}
        onClose={() => {}}
      />,
    );

  it("renders a labelled modal dialog with the expected test ids", () => {
    const html = renderDialog();
    expect(tagOf(html, "repeat-dialog")).toContain('role="dialog"');
    expect(tagOf(html, "repeat-dialog")).toContain('aria-modal="true"');
    expect(tagOf(html, "repeat-dialog")).toContain("aria-labelledby");
    for (const testid of [
      "repeat-count",
      "repeat-link-params",
      "repeat-canvas-x",
      "repeat-canvas-y",
      "repeat-physical-x",
      "repeat-physical-y",
      "repeat-physical-z",
      "repeat-summary",
      "repeat-dialog-cancel",
      "repeat-dialog-accept",
    ]) {
      expect(html).toContain(`data-testid="${testid}"`);
    }
  });

  it("labels the count as the TOTAL including the original, bounded 2…200", () => {
    const html = renderDialog();
    expect(html).toContain("Total instances (including the original)");
    const count = tagOf(html, "repeat-count");
    expect(count).toContain('value="2"');
    expect(count).toContain(`min="${REPEAT_COUNT_MIN}"`);
    expect(count).toContain(`max="${REPEAT_COUNT_MAX}"`);
  });

  it("defaults link-parameters ON with the independence hint", () => {
    const html = renderDialog();
    expect(tagOf(html, "repeat-link-params")).toContain("checked");
    expect(html).toContain("Link parameters to the first instance");
    expect(html).toContain("Uncheck for independent copies");
  });

  it("pre-fills spacing from derived defaults, not hard-coded zeros", () => {
    const html = renderDialog();
    expect(tagOf(html, "repeat-canvas-x")).toContain('value="105"');
    expect(tagOf(html, "repeat-canvas-y")).toContain('value="0"');
    // Seam pipe length 1 m resolved → physical Δx default 1.
    expect(tagOf(html, "repeat-physical-x")).toContain('value="1"');
    expect(tagOf(html, "repeat-physical-y")).toContain('value="0"');
    expect(tagOf(html, "repeat-physical-z")).toContain('value="0"');
  });

  it("shows the live summary for the current count", () => {
    const html = renderDialog();
    expect(html).toContain("Creates 1 more instance: 1 node, 1 branch.");
  });

  it("enables confirm for a repeatable selection", () => {
    const html = renderDialog();
    expect(tagOf(html, "repeat-dialog-accept")).not.toContain("disabled");
    expect(html).not.toContain('data-testid="repeat-reason"');
  });

  it("shows the reason and disables confirm when the selection cannot repeat", () => {
    const cfg = ambiguousCfg();
    const html = renderDialog(
      cfg,
      analyzeRepeatSelection(cfg, { kind: "none" }, ["n1"]),
    );
    expect(tagOf(html, "repeat-dialog-accept")).toContain("disabled");
    const reason = tagOf(html, "repeat-reason");
    expect(reason).toContain('role="alert"');
    expect(html).toContain("Cannot repeat: multiple branches enter the unit");
  });
});

/* ------------------------------------------------------------------ */
/* RepeatMenuAction — the FlowCanvas selection-menu entry point        */
/* ------------------------------------------------------------------ */

describe("RepeatMenuAction", () => {
  it("is enabled with an affirmative tooltip for a repeatable selection", () => {
    const html = render(
      <RepeatMenuAction repeatability={okChain()} onClick={() => {}} />,
    );
    const tag = tagOf(html, "repeat-menu-action");
    expect(tag).not.toContain("disabled");
    expect(tag).toContain("Chain the selected unit");
    expect(html).toContain("Repeat…");
  });

  it("is disabled with the reason as tooltip when no seam can be derived", () => {
    const cfg = ambiguousCfg();
    const blocked = analyzeRepeatSelection(cfg, { kind: "none" }, ["n1"]);
    const html = render(
      <RepeatMenuAction repeatability={blocked} onClick={() => {}} />,
    );
    const tag = tagOf(html, "repeat-menu-action");
    expect(tag).toContain("disabled");
    expect(tag).toContain("Cannot repeat: multiple branches enter the unit");
  });

  it("says what is missing when no nodes are selected", () => {
    const empty = analyzeRepeatSelection(chainCfg(), { kind: "none" }, []);
    const html = render(
      <RepeatMenuAction repeatability={empty} onClick={() => {}} />,
    );
    const tag = tagOf(html, "repeat-menu-action");
    expect(tag).toContain("disabled");
    expect(tag).toContain("select the nodes of the unit to repeat");
  });
});

/* ------------------------------------------------------------------ */
/* Confirm arguments drive the store action exactly                    */
/* ------------------------------------------------------------------ */

describe("confirm flow against the store", () => {
  beforeEach(() => loadConfig(chainCfg()));

  it("repeatSelection accepts the dialog's default arguments verbatim", () => {
    const s = () => useStore.getState();
    s().setCanvasSelection(["n1"]);
    const built = buildRepeatArgs(defaultDraft(s().config));
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.args).toEqual({
      count: 2,
      linkParams: true,
      canvasOffset: { x: 105, y: 0 },
      physicalOffset: { x: 1, y: 0, z: 0 },
    });
    const res = s().repeatSelection(built.args);
    expect(res).toEqual({
      nodes: 1,
      solidNodes: 0,
      branches: 1,
      conductors: 0,
    });
    expect(s().duplicateNotice).toBe("Repeated unit 2×: 1 node, 1 branch");
    // The dialog's canvas offset is what actually places the clone.
    const clone = s().config.nodes.find((n) => n.id === "n2")!;
    expect([clone.x, clone.y]).toEqual([205, 0]);
    expect(s().past).toHaveLength(1);
  });

  it("advances physical positions by the derived physical offset", () => {
    const cfg = chainCfg();
    for (const node of cfg.nodes)
      node.position = { x: node.x / 100, y: 0, z: 0 };
    loadConfig(cfg);
    const s = () => useStore.getState();
    s().setCanvasSelection(["n1"]);
    const built = buildRepeatArgs(defaultDraft(cfg));
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    s().repeatSelection(built.args);
    const clone = s().config.nodes.find((n) => n.id === "n2")!;
    // Instance 2 sits one seam length (1 m) past the original's x = 1.
    expect(clone.position).toEqual({ x: 2, y: 0, z: 0 });
  });
});

/* ------------------------------------------------------------------ */
/* Uncloned-record warnings (controllers / junctions / logic rules)    */
/*                                                                     */
/* repeatUnit never clones controllers, junctions or logic rules       */
/* (user manual §3.13): the helpers below detect when the selected     */
/* unit is actually referenced by one of them, so the dialog warns     */
/* exactly then — and stays quiet otherwise.                           */
/* ------------------------------------------------------------------ */

/** The chain with a PID controller sensing AND heating member n1. */
const controlledCfg = (): NetworkConfig => {
  const base = chainCfg();
  base.nodes[1]!.label = "Segment 1";
  return {
    ...base,
    settings: { ...base.settings, mode: "transient" },
    controllers: [
      {
        id: "pid1",
        type: "pid",
        sense: { kind: "node", id: "n1", quantity: "pressure" },
        setpoint: 1.5e5,
        gains: { kp: 1, ki: 0, kd: 0 },
        output: { kind: "heatInput", id: "n1" },
      },
    ],
  };
};

/** The chain with a reacting junction on member n1 fed by the seam seg1. */
const junctionCfg = (): NetworkConfig => ({
  ...chainCfg(),
  junctions: [
    {
      id: "j1",
      node: "n1",
      inlets: [{ branch: "seg1", role: "fuel" }],
      model: { type: "ceaTable", propellants: "lox-rp1" },
      productFluid: "exhaust",
    },
  ],
});

/** The chain with a logic rule reading member n1 and the seam in `set`. */
const logicCfg = (): NetworkConfig => ({
  ...chainCfg(),
  logic: [
    {
      id: "r1",
      when: "node('n1').pressure > 1e5",
      set: { reg1: "pipe('seg1').length" },
    },
  ],
});

describe("unclonedUnitReferences", () => {
  it("finds controllers referencing a unit node (sense and output)", () => {
    const refs = unclonedUnitReferences(controlledCfg(), {
      nodes: ["n1"],
      branches: [],
    });
    expect(refs).toEqual([
      { source: "controller", id: "pid1", targets: ["n1"] },
    ]);
  });

  it("finds controllers referencing a unit branch (valve output)", () => {
    const cfg = controlledCfg();
    cfg.controllers = [
      {
        id: "reg1",
        type: "register",
        register: "r",
        output: { kind: "valvePosition", id: "seg1" },
      },
    ];
    expect(
      unclonedUnitReferences(cfg, { nodes: [], branches: ["seg1"] }),
    ).toEqual([{ source: "controller", id: "reg1", targets: ["seg1"] }]);
  });

  it("finds junctions by member node and by inlet branch", () => {
    // junction.node = n1 (member) and inlets → seg1 (the seam): both are
    // unit references, deduplicated into one record.
    expect(
      unclonedUnitReferences(junctionCfg(), {
        nodes: ["n1"],
        branches: ["seg1"],
      }),
    ).toEqual([{ source: "junction", id: "j1", targets: ["n1", "seg1"] }]);
    // Only the inlet branch inside the id set still flags the junction.
    expect(
      unclonedUnitReferences(junctionCfg(), {
        nodes: [],
        branches: ["seg1"],
      }),
    ).toEqual([{ source: "junction", id: "j1", targets: ["seg1"] }]);
  });

  it("finds logic-rule references in `when` and `set` expressions", () => {
    const refs = unclonedUnitReferences(logicCfg(), {
      nodes: ["n1"],
      branches: ["seg1"],
    });
    expect(refs).toEqual([
      { source: "logic rule", id: "r1", targets: ["n1", "seg1"] },
    ]);
  });

  it("ignores reg() reads, malformed references and non-unit ids", () => {
    const cfg: NetworkConfig = {
      ...chainCfg(),
      logic: [
        // A REGISTER named like a member id is not an entity reference.
        { id: "r-reg", when: "reg('n1') > 1" },
        // Syntactically incomplete references stay plain text (tolerant
        // segmenter): no chip, no match.
        { id: "r-broken", when: "pipe('n1'" },
        // A well-formed reference to an entity OUTSIDE the unit.
        { id: "r-outside", when: "pipe('seg2').length > 0.5" },
      ],
    };
    expect(
      unclonedUnitReferences(cfg, { nodes: ["n1"], branches: ["seg1"] }),
    ).toEqual([]);
    expect(
      unclonedUnitReferences(cfg, { nodes: [], branches: ["seg2"] }),
    ).toEqual([{ source: "logic rule", id: "r-outside", targets: ["seg2"] }]);
  });

  it("returns nothing when no record references the unit (no noise)", () => {
    expect(
      unclonedUnitReferences(chainCfg(), { nodes: ["n1"], branches: ["seg1"] }),
    ).toEqual([]);
  });
});

describe("repeatUnitReferenceIds", () => {
  it("covers members, induced + crossing conductors and the seam", () => {
    const cfg = chainWithWallCfg();
    const repeatable = analyzeRepeatSelection(cfg, { kind: "none" }, [
      "n1",
      "wall1",
    ]);
    expect(repeatUnitReferenceIds(cfg, repeatable)).toEqual({
      nodes: ["n1", "wall1"],
      branches: ["seg1"],
      conductors: ["conv1", "cx"],
    });
  });

  it("is empty when the selection cannot repeat (the reason shows instead)", () => {
    const cfg = ambiguousCfg();
    const blocked = analyzeRepeatSelection(cfg, { kind: "none" }, ["n1"]);
    expect(blocked.canRepeat).toBe(false);
    expect(repeatUnitReferenceIds(cfg, blocked)).toEqual({
      nodes: [],
      branches: [],
      conductors: [],
    });
  });
});

describe("repeatUnclonedWarnings", () => {
  it("words the controller warning plainly, using the entity label", () => {
    const cfg = controlledCfg();
    const repeatable = analyzeRepeatSelection(cfg, { kind: "none" }, ["n1"]);
    expect(repeatUnclonedWarnings(cfg, repeatable)).toEqual([
      "Controller pid1 references Segment 1 and will not be copied — the new instances will be uncontrolled.",
    ]);
  });

  it("words the junction and logic-rule warnings", () => {
    const jcfg = junctionCfg();
    const jrep = analyzeRepeatSelection(jcfg, { kind: "none" }, ["n1"]);
    expect(repeatUnclonedWarnings(jcfg, jrep)).toEqual([
      "Junction j1 references n1, seg1 and will not be copied — the copies will be plain internal nodes.",
    ]);
    const lcfg = logicCfg();
    const lrep = analyzeRepeatSelection(lcfg, { kind: "none" }, ["n1"]);
    expect(repeatUnclonedWarnings(lcfg, lrep)).toEqual([
      "Logic rule r1 references n1, seg1 and will not be copied — it keeps referencing the original instance only.",
    ]);
  });

  it("stays silent for an unreferenced unit", () => {
    const cfg = chainCfg();
    expect(repeatUnclonedWarnings(cfg, okChain())).toEqual([]);
  });
});

describe("RepeatDialog uncloned-record warning", () => {
  it("shows the targeted warning when a controller references the unit", () => {
    const cfg = controlledCfg();
    const html = render(
      <RepeatDialog
        config={cfg}
        repeatability={analyzeRepeatSelection(cfg, { kind: "none" }, ["n1"])}
        onClose={() => {}}
      />,
    );
    const banner = tagOf(html, "repeat-uncloned-warning");
    expect(banner).toContain('role="note"');
    expect(html).toContain("Controller pid1 references Segment 1");
    expect(html).toContain("the new instances will be uncontrolled");
  });

  it("renders no warning when nothing references the unit", () => {
    const html = render(
      <RepeatDialog
        config={chainCfg()}
        repeatability={okChain()}
        onClose={() => {}}
      />,
    );
    expect(html).not.toContain('data-testid="repeat-uncloned-warning"');
  });
});
