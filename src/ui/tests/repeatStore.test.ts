/**
 * Store-level tests for the repeat/discretize wiring (Phase 3):
 *
 *   repeatSelection — chain the selected subgraph unit N× via core
 *     repeatUnit, as exactly ONE undo step, announcing through the shared
 *     duplicateNotice channel and selecting the created node ids.
 *   splitBranch — split a pipe into N equal segments (core splitPipeBranch)
 *     with the same undo/notice conventions.
 *   duplicateSelection — now delegates to repeatUnit in Duplicate mode
 *     (seamBranch: null, idStrategy: "firstFree").  Duplicate keeps its
 *     legacy naming: the first free integer for the id's letter prefix
 *     (A → A1, b1 → b2, j → j1) and " copy" labels.  The bug fix is that
 *     `{ expr }` fields on copies are retargeted to the copied members
 *     (Rule 1).
 *
 * analyzeRepeatSelection (src/ui/repeatSelection.ts) is the pure helper a
 * Repeat button uses to enable/disable without duplicating the seam logic.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { useStore } from "../store";
import { analyzeRepeatSelection } from "../repeatSelection";
import type { NetworkConfig } from "../types";
import { applyVariant, validateNetwork } from "../../core";
import { parseText } from "../../substrate/textProjection";

const PIPE = {
  type: "pipe",
  length: 1,
  diameter: 0.02,
  roughness: 1e-5,
} as const;

/** a → n1 → b: one entry branch (seg1), one exit branch (seg2). */
const chainCfg = (name = "Chain"): NetworkConfig => ({
  meta: { name, version: 2 },
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

/** The chain plus a wall node tied to n1 (induced) and ambient (crossing). */
const chainWithWallCfg = (): NetworkConfig => ({
  ...chainCfg("Wall"),
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

/** Two branches ENTER n1 (seg1 and segB): the seam is ambiguous unless the
 *  user includes one of them in a multi selection. */
const ambiguousCfg = (): NetworkConfig => {
  const base = chainCfg("Ambiguous");
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

/** a → n1 → n2 → b, with n1.volume bound by expression to the INDUCED p1. */
const exprCfg = (): NetworkConfig => ({
  meta: { name: "Expr", version: 2 },
  settings: { mode: "steady", tolerance: 1e-6, maxIterations: 100 },
  fluid: { model: "incompressible", preset: "water" },
  nodes: [
    { id: "a", type: "boundary", x: 0, y: 0, pressure: 2e5, temperature: 300 },
    {
      id: "n1",
      type: "internal",
      x: 100,
      y: 0,
      volume: { expr: "pipe('p1').volume" },
      pressure: 1.5e5,
      temperature: 300,
    },
    {
      id: "n2",
      type: "internal",
      x: 200,
      y: 0,
      volume: 1e-3,
      pressure: 1.2e5,
      temperature: 300,
    },
    {
      id: "b",
      type: "boundary",
      x: 300,
      y: 0,
      pressure: 1e5,
      temperature: 300,
    },
  ],
  branches: [
    { id: "seg1", from: "a", to: "n1", component: { ...PIPE } },
    { id: "p1", from: "n1", to: "n2", component: { ...PIPE } },
    { id: "seg2", from: "n2", to: "b", component: { ...PIPE } },
  ],
});

/** The storeActions duplicate fixture: boundary A → boundary B, pipe b1. */
const dupCfg = (): NetworkConfig => ({
  meta: { name: "Dup", version: 2 },
  settings: { mode: "steady", tolerance: 1e-6, maxIterations: 100 },
  fluid: { model: "incompressible", preset: "water" },
  nodes: [
    {
      id: "A",
      type: "boundary",
      x: 100,
      y: 100,
      pressure: 2e5,
      temperature: 300,
      label: "In",
    },
    {
      id: "B",
      type: "boundary",
      x: 300,
      y: 100,
      pressure: 1e5,
      temperature: 300,
      label: "Out",
    },
  ],
  branches: [
    {
      id: "b1",
      from: "A",
      to: "B",
      component: { ...PIPE },
      label: "Pipe",
    },
  ],
});

/** a → j → n12 → b: pins the legacy duplicate id naming (j → j1, n12 → n1). */
const legacyNamingCfg = (): NetworkConfig => ({
  meta: { name: "Legacy", version: 2 },
  settings: { mode: "steady", tolerance: 1e-6, maxIterations: 100 },
  fluid: { model: "incompressible", preset: "water" },
  nodes: [
    { id: "a", type: "boundary", x: 0, y: 0, pressure: 2e5, temperature: 300 },
    {
      id: "j",
      type: "internal",
      x: 100,
      y: 0,
      volume: 1e-3,
      pressure: 1.5e5,
      temperature: 300,
    },
    {
      id: "n12",
      type: "internal",
      x: 200,
      y: 0,
      volume: 1e-3,
      pressure: 1.2e5,
      temperature: 300,
    },
    {
      id: "b",
      type: "boundary",
      x: 300,
      y: 0,
      pressure: 1e5,
      temperature: 300,
    },
  ],
  branches: [
    { id: "in", from: "a", to: "j", component: { ...PIPE } },
    { id: "p9", from: "j", to: "n12", component: { ...PIPE } },
    { id: "out", from: "n12", to: "b", component: { ...PIPE } },
  ],
});

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

const wiring = (c: NetworkConfig) =>
  Object.fromEntries(c.branches.map((b) => [b.id, [b.from, b.to]]));

/* ------------------------------------------------------------------ */
/* repeatSelection                                                     */
/* ------------------------------------------------------------------ */

describe("repeatSelection", () => {
  beforeEach(() => loadConfig(chainCfg()));

  it("repeats a one-node unit 3× with the right counts and wiring", () => {
    const s = () => useStore.getState();
    s().setCanvasSelection(["n1"]);
    const res = s().repeatSelection({ count: 3, linkParams: false });
    expect(res).toEqual({
      nodes: 2,
      solidNodes: 0,
      branches: 2,
      conductors: 0,
    });
    const c = s().config;
    expect(c.nodes).toHaveLength(5);
    expect(c.branches).toHaveLength(4);
    // seg2 (the exit crossing) holds the seg2 id, so the seam clones
    // allocate seg3 / seg4; the exit crossing rewires to the LAST instance.
    expect(wiring(c)).toEqual({
      seg1: ["a", "n1"],
      seg2: ["n3", "b"],
      seg3: ["n1", "n2"],
      seg4: ["n2", "n3"],
    });
    expect(validateNetwork(c)).toEqual([]);
  });

  it("a 20× repeat is exactly ONE undo step", () => {
    const s = () => useStore.getState();
    s().setCanvasSelection(["n1"]);
    const res = s().repeatSelection({ count: 20, linkParams: false });
    expect(res).toEqual({
      nodes: 19,
      solidNodes: 0,
      branches: 19,
      conductors: 0,
    });
    expect(s().config.nodes).toHaveLength(22);
    expect(s().config.branches).toHaveLength(21);
    expect(s().past).toHaveLength(1);
    s().undo();
    expect(s().config.nodes).toHaveLength(3);
    expect(s().config.branches).toHaveLength(2);
    expect(s().future).toHaveLength(1);
    s().redo();
    expect(s().config.nodes).toHaveLength(22);
    expect(s().config.branches).toHaveLength(21);
  });

  it("a failed repeat announces, mutates nothing and burns no undo entry", () => {
    const s = () => useStore.getState();
    loadConfig(ambiguousCfg());
    const before = s().config;
    // Ambiguous seam: two branches enter the unit, none selected.
    s().setCanvasSelection(["n1"]);
    expect(s().repeatSelection({ count: 2, linkParams: false })).toBeNull();
    expect(s().duplicateNotice).toContain("multiple branches enter the unit");
    // Absent seam: a boundary source has no entering branch.
    s().setCanvasSelection(["a"]);
    expect(s().repeatSelection({ count: 2, linkParams: false })).toBeNull();
    expect(s().duplicateNotice).toContain("no branch enters the unit");
    // A degenerate count is rejected before anything is derived.
    expect(s().repeatSelection({ count: 1, linkParams: false })).toBeNull();
    expect(s().duplicateNotice).toContain("at least 2");
    expect(s().config).toBe(before);
    expect(s().past).toHaveLength(0);
    expect(s().dirty).toBe(false);
  });

  it("sets dirty and resultStale like any other config mutation", () => {
    const s = () => useStore.getState();
    s().setCanvasSelection(["n1"]);
    expect(s().dirty).toBe(false);
    expect(s().resultStale).toBe(false);
    s().repeatSelection({ count: 2, linkParams: false });
    expect(s().dirty).toBe(true);
    expect(s().resultStale).toBe(true);
  });

  it("selects exactly the created node ids and announces the repeat", () => {
    const s = () => useStore.getState();
    s().setCanvasSelection(["n1"]);
    s().repeatSelection({ count: 3, linkParams: false });
    expect(s().canvasSelection).toEqual(["n2", "n3"]);
    expect(s().duplicateNotice).toBe("Repeated unit 3×: 2 nodes, 2 branches");
  });

  it("clones crossing conductors share-style and selects created solids too", () => {
    loadConfig(chainWithWallCfg());
    const s = () => useStore.getState();
    s().setCanvasSelection(["n1", "wall1"]);
    const res = s().repeatSelection({ count: 2, linkParams: false });
    expect(res).toEqual({
      nodes: 1,
      solidNodes: 1,
      branches: 1,
      conductors: 2,
    });
    const c = s().config;
    expect(c.solidNodes).toHaveLength(3);
    expect(c.conductors).toHaveLength(4);
    const byId = (id: string) => c.conductors!.find((x) => x.id === id)!;
    // Induced conductor cloned with both endpoints remapped…
    expect([byId("conv2").from, byId("conv2").to]).toEqual(["wall2", "n2"]);
    // …while the crossing clone keeps the SAME external ambient endpoint.
    expect([byId("cx_2").from, byId("cx_2").to]).toEqual(["wall2", "amb"]);
    expect(s().canvasSelection).toEqual(["n2", "wall2"]);
    expect(s().duplicateNotice).toBe(
      "Repeated unit 2×: 1 node, 1 solid node, 1 branch, 2 conductors",
    );
    expect(validateNetwork(c)).toEqual([]);
  });

  it("honours a branch inside a multi selection as the explicit seam", () => {
    loadConfig(ambiguousCfg());
    const s = () => useStore.getState();
    s().setCanvasSelection(["n1"]);
    s().setSelection({
      kind: "multi",
      items: [
        { kind: "node", id: "n1" },
        { kind: "branch", id: "segB" },
      ],
    });
    const res = s().repeatSelection({ count: 2, linkParams: false });
    expect(res).toEqual({
      nodes: 1,
      solidNodes: 0,
      branches: 1,
      conductors: 0,
    });
    // Only the selected seam chains; the other entry stays on instance 1.
    expect(wiring(s().config)).toEqual({
      seg1: ["a", "n1"],
      segB: ["c", "n1"],
      seg2: ["n2", "b"],
      segB_2: ["n1", "n2"],
    });
  });

  it("derives members from a multi selection even with an empty canvas selection", () => {
    const s = () => useStore.getState();
    s().setSelection({
      kind: "multi",
      items: [
        { kind: "node", id: "n1" },
        { kind: "branch", id: "seg1" },
      ],
    });
    const res = s().repeatSelection({ count: 2, linkParams: false });
    expect(res).toEqual({
      nodes: 1,
      solidNodes: 0,
      branches: 1,
      conductors: 0,
    });
    expect(wiring(s().config)["seg3"]).toEqual(["n1", "n2"]);
  });

  it("round-trips through serializeText → parseText exactly", () => {
    const s = () => useStore.getState();
    s().setCanvasSelection(["n1"]);
    // linkParams: true also exercises { expr } fields in the text format.
    s().repeatSelection({ count: 5, linkParams: true });
    const parsed = parseText(s().modelText);
    expect(parsed.errors).toEqual([]);
    expect(parsed.config).toStrictEqual(s().config);
  });

  it("with a variant active, the repeat diffs into the variant patch and survives switching away and back", () => {
    const s = () => useStore.getState();
    const id = s().createVariant("Cold day");
    expect(s().activeVariantId).toBe(id);
    s().setCanvasSelection(["n1"]);
    const res = s().repeatSelection({ count: 3, linkParams: false });
    expect(res).toEqual({
      nodes: 2,
      solidNodes: 0,
      branches: 2,
      conductors: 0,
    });

    // The whole structural diff lands in the VARIANT patch: the created
    // entities as `added` and the rewired exit crossing as a field override.
    const variant = s().baseConfig.variants!.find((v) => v.id === id)!;
    expect(variant.patch?.added?.nodes?.map((n) => n.id)).toEqual(["n2", "n3"]);
    expect(variant.patch?.added?.branches?.map((b) => b.id)).toEqual([
      "seg3",
      "seg4",
    ]);
    expect(variant.patch?.branches).toEqual({ seg2: { from: "n3" } });

    // The patch round-trips exactly: base + patch IS the resolved chain…
    const resolved = applyVariant(s().baseConfig, variant);
    expect(resolved).toStrictEqual(s().config);
    // …and the file text still parses back to the same base (variants
    // included).
    const parsed = parseText(s().modelText);
    expect(parsed.errors).toEqual([]);
    expect(parsed.config).toStrictEqual(s().baseConfig);

    // Switching to Base hides the chain (Base was never touched)…
    s().setActiveVariant(null);
    expect(s().config.nodes).toHaveLength(3);
    expect(s().config.branches).toHaveLength(2);
    // …and switching back restores it exactly.
    s().setActiveVariant(id);
    expect(s().config.nodes.map((n) => n.id)).toEqual([
      "a",
      "n1",
      "b",
      "n2",
      "n3",
    ]);
    expect(wiring(s().config)).toEqual({
      seg1: ["a", "n1"],
      seg2: ["n3", "b"],
      seg3: ["n1", "n2"],
      seg4: ["n2", "n3"],
    });
    expect(validateNetwork(s().config)).toEqual([]);
  });

  it("a single-copy repeat also selects the copy in the property panel (like Duplicate)", () => {
    const s = () => useStore.getState();
    s().setCanvasSelection(["n1"]);
    expect(s().selection).toEqual({ kind: "none" });
    s().repeatSelection({ count: 2, linkParams: false });
    // Exactly one node was created: the panel selection follows it, exactly
    // as duplicateSelection's single-copy case does.  Multi-instance
    // repeats (count > 2) leave the panel on the template — instance 1 is
    // the sweepable/editable one when parameters are linked.
    expect(s().selection).toEqual({ kind: "node", id: "n2" });
    expect(s().canvasSelection).toEqual(["n2"]);
  });
});

/* ------------------------------------------------------------------ */
/* splitBranch                                                         */
/* ------------------------------------------------------------------ */

describe("splitBranch", () => {
  beforeEach(() => loadConfig(dupCfg()));

  it("splits a pipe into 3 equal segments as ONE undo step", () => {
    const s = () => useStore.getState();
    const res = s().splitBranch("b1", 3);
    expect(res).toEqual({
      nodes: 2,
      solidNodes: 0,
      branches: 2,
      conductors: 0,
    });
    const c = s().config;
    expect(c.nodes).toHaveLength(4);
    expect(c.branches).toHaveLength(3);
    expect(wiring(c)).toEqual({
      b1: ["m2", "B"],
      b1_seg1: ["A", "m1"],
      b1_seg2: ["m1", "m2"],
    });
    // The extensive length is divided, preserving the total.
    for (const id of ["b1", "b1_seg1", "b1_seg2"]) {
      expect(c.branches.find((b) => b.id === id)!.component).toMatchObject({
        length: 1 / 3,
      });
    }
    expect(s().canvasSelection).toEqual(["m1", "m2"]);
    expect(s().duplicateNotice).toBe(
      "Split b1 into 3 segments: 2 nodes, 2 branches",
    );
    expect(validateNetwork(c)).toEqual([]);
    expect(s().dirty).toBe(true);
    expect(s().resultStale).toBe(true);
    expect(s().past).toHaveLength(1);
    s().undo();
    expect(s().config.nodes).toHaveLength(2);
    expect(s().config.branches).toHaveLength(1);
    s().redo();
    expect(s().config.branches).toHaveLength(3);
  });

  it("failed splits announce and leave no undo entry", () => {
    const s = () => useStore.getState();
    const before = s().config;
    expect(s().splitBranch("b1", 1)).toBeNull();
    expect(s().duplicateNotice).toContain("segments must be an integer");
    expect(s().splitBranch("ghost", 2)).toBeNull();
    expect(s().duplicateNotice).toBe(
      "Cannot split branch: unknown branch 'ghost'",
    );
    expect(s().config).toBe(before);
    expect(s().past).toHaveLength(0);
    expect(s().dirty).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* duplicateSelection — delegation to repeatUnit                       */
/* ------------------------------------------------------------------ */

describe("duplicateSelection via repeatUnit", () => {
  beforeEach(() => loadConfig(dupCfg()));

  it('pins the legacy first-free naming (A → A1, B → B1, b1 → b2) with " copy" labels', () => {
    const s = () => useStore.getState();
    s().setCanvasSelection(["A", "B"]);
    const res = s().duplicateSelection();
    expect(res).toEqual({ nodes: 2, branches: 1, conductors: 0 });
    const c = s().config;
    const copyA = c.nodes.find((n) => n.id === "A1")!;
    const copyB = c.nodes.find((n) => n.id === "B1")!;
    expect(copyA.label).toBe("In copy");
    expect(copyB.label).toBe("Out copy");
    expect([copyA.x, copyA.y]).toEqual([130, 130]);
    expect([copyB.x, copyB.y]).toEqual([330, 130]);
    const copyBranch = c.branches.find((b) => b.id === "b2")!;
    expect([copyBranch.from, copyBranch.to]).toEqual(["A1", "B1"]);
    expect(copyBranch.label).toBe("Pipe copy");
    expect(s().canvasSelection).toEqual(["A1", "B1"]);
    expect(s().duplicateNotice).toBe("Duplicated 2 nodes, 1 branch");
  });

  it("pins the restored naming: j → j1 and n12 → the first free n<k>", () => {
    // A digitless id takes prefix+1 (j → j1); an id with a trailing integer
    // DROPS it and takes the first free integer for the letter prefix
    // (n12 → n1 while n1 is free) — the pre-repeat createId semantics that
    // delegating to repeatUnit must not change (e2e network.spec test 33).
    loadConfig(legacyNamingCfg());
    const s = () => useStore.getState();
    s().setCanvasSelection(["j", "n12"]);
    const res = s().duplicateSelection();
    expect(res).toEqual({ nodes: 2, branches: 1, conductors: 0 });
    const c = s().config;
    expect(c.nodes.map((n) => n.id)).toEqual([
      "a",
      "j",
      "n12",
      "b",
      "j1",
      "n1",
    ]);
    // The induced branch p9 takes the legacy FIXED branch prefix — the
    // pre-repeat store minted cloned branches via createId("b", allIds), so
    // p9 → b1 here, never p1.
    const b1 = c.branches.find((br) => br.id === "b1")!;
    expect([b1.from, b1.to]).toEqual(["j1", "n1"]);
    // A second duplicate of j takes the next free integer (j2), exactly as
    // repeated legacy duplicates did.
    s().setCanvasSelection(["j"]);
    s().duplicateSelection();
    expect(s().config.nodes.some((n) => n.id === "j2")).toBe(true);
  });

  it("retargets { expr } references on copies to the copied members (Rule 1 regression)", () => {
    // Previously a duplicated node whose volume was pipe('p1').volume kept
    // pointing at the ORIGINAL p1; the copy must reference the copied pipe.
    loadConfig(exprCfg());
    const s = () => useStore.getState();
    s().setCanvasSelection(["n1", "n2"]);
    const res = s().duplicateSelection();
    expect(res).toEqual({ nodes: 2, branches: 1, conductors: 0 });
    const c = s().config;
    // n1 → n3 (n2 is itself a member) and p1 → b1 (the legacy fixed branch
    // prefix — pre-repeat createId("b", …), not a prefix from the source id).
    const copyN1 = c.nodes.find((n) => n.id === "n3")!;
    expect(copyN1.volume).toEqual({ expr: "pipe('b1').volume" });
    const b1 = c.branches.find((b) => b.id === "b1")!;
    expect([b1.from, b1.to]).toEqual(["n3", "n4"]);
    // The originals are untouched.
    expect(c.nodes.find((n) => n.id === "n1")!.volume).toEqual({
      expr: "pipe('p1').volume",
    });
  });
});

/* ------------------------------------------------------------------ */
/* analyzeRepeatSelection — the Phase-4 button-state helper            */
/* ------------------------------------------------------------------ */

describe("analyzeRepeatSelection (Phase-4 helper)", () => {
  beforeEach(() => loadConfig(ambiguousCfg()));

  it("reports canRepeat / seamBranch / reason for the current selection", () => {
    const s = () => useStore.getState();
    const none = analyzeRepeatSelection(s().config, { kind: "none" }, []);
    expect(none.canRepeat).toBe(false);
    expect(none.seamBranch).toBeNull();
    expect(none.reason).toBeDefined();

    // Nodes only: the seam is ambiguous between seg1 and segB.
    const ambiguous = analyzeRepeatSelection(s().config, { kind: "none" }, [
      "n1",
    ]);
    expect(ambiguous.canRepeat).toBe(false);
    expect(ambiguous.seamBranch).toBeNull();
    expect(ambiguous.reason).toContain("multiple branches enter the unit");
    expect(ambiguous.members).toEqual({ nodes: ["n1"], solidNodes: [] });

    // A multi selection carrying the seam branch resolves it.
    const resolved = analyzeRepeatSelection(
      s().config,
      {
        kind: "multi",
        items: [
          { kind: "node", id: "n1" },
          { kind: "branch", id: "segB" },
        ],
      },
      ["n1"],
    );
    expect(resolved).toMatchObject({ canRepeat: true, seamBranch: "segB" });
  });

  it("derives the seam without help when exactly one branch enters", () => {
    loadConfig(chainCfg());
    const s = () => useStore.getState();
    const ok = analyzeRepeatSelection(s().config, { kind: "none" }, ["n1"]);
    expect(ok).toMatchObject({ canRepeat: true, seamBranch: "seg1" });
  });
});
