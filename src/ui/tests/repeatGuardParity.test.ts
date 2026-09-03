/**
 * repeatGuardParity — the systematic proof that the Repeat/Split UI
 * enablement checks can never disagree with execution.
 *
 * THE INVARIANT (repeat): analyzeRepeatSelection reports canRepeat: true
 * for a selection IF AND ONLY IF repeatUnit — called with the derived
 * members/seam and the store action's "share" crossing mode — cannot
 * reject that unit for a topology reason.  Both sides run the single core
 * predicate validateRepeatUnit; this table pins ONE trigger config per
 * guard and asserts:
 *
 *   1. the UI predicts the outcome (canRepeat + reason),
 *   2. repeatUnit with the row's members/seam produces the same outcome,
 *   3. on "verbatim" rows the UI reason IS the execution error, character
 *      for character — proof there is exactly one predicate, not two.
 *
 * COVERAGE DISCIPLINE (read this when adding a guard): every
 * topology-level rejection validateRepeatUnit can produce MUST have a row
 * here whose config trips it.  The "each row trips a distinct guard"
 * meta-test fails when two rows collapse onto the same rejection — i.e.
 * when a row has rotted and no longer exercises anything — and the
 * canRepeat rows fail loudly if a guard is ever added to repeatUnitInner
 * directly (bypassing validateRepeatUnit) and an enabled selection hits
 * it.  UI-originated rejections that execution can never see (no/ambiguous
 * derived seam, contradictory multi-selection, empty/unknown members) are
 * marked uiOnly: the UI wording is pinned, and the execution side is
 * asserted through validateRepeatUnit where a parallel exists.
 *
 * Split gets the same treatment: analyzeSplitSelection must report the
 * verbatim error splitPipeBranch would return.
 */
import { describe, it, expect } from "vitest";
import type { NetworkConfig, RepeatMembers } from "../../core";
import { repeatUnit, splitPipeBranch, validateRepeatUnit } from "../../core";
import {
  analyzeRepeatSelection,
  analyzeSplitSelection,
} from "../repeatSelection";
import type { Selection } from "../types";

const PIPE = {
  type: "pipe",
  length: 1,
  diameter: 0.05,
  roughness: 1e-5,
} as const;

const SETTINGS = {
  mode: "steady",
  tolerance: 1e-8,
  maxIterations: 100,
} as const;
const FLUID = { model: "incompressible", preset: "water" } as const;

const boundary = (id: string, x = 0) =>
  ({
    id,
    type: "boundary",
    x,
    y: 0,
    pressure: 2e5,
    temperature: 300,
  }) as const;
const internal = (id: string, x = 0) =>
  ({ id, type: "internal", x, y: 0, volume: 1e-3 }) as const;
const pipe = (id: string, from: string, to: string) =>
  ({ id, from, to, component: { ...PIPE } }) as const;

/** a --seg1--> n1 --seg2--> b : the minimal chainable unit {n1}. */
function chainCfg(): NetworkConfig {
  return {
    meta: { name: "chain", version: 2 },
    settings: { ...SETTINGS },
    fluid: { ...FLUID },
    nodes: [boundary("a"), internal("n1", 1), boundary("b", 2)],
    branches: [pipe("seg1", "a", "n1"), pipe("seg2", "n1", "b")],
  } as NetworkConfig;
}

/** src --feed--> n1 --out--> out2(boundary): the unit {n1, out2}. */
function boundaryUnitCfg(): NetworkConfig {
  return {
    meta: { name: "boundary-unit", version: 2 },
    settings: { ...SETTINGS },
    fluid: { ...FLUID },
    nodes: [boundary("src"), internal("n1", 1), boundary("out2", 2)],
    branches: [pipe("feed", "src", "n1"), pipe("out", "n1", "out2")],
  } as NetworkConfig;
}

/** a --in1--> x --x--> y --out1--> b : induced branch 'x' meets node 'x'. */
function collidingCfg(): NetworkConfig {
  return {
    meta: { name: "collide", version: 2 },
    settings: { ...SETTINGS },
    fluid: { ...FLUID },
    nodes: [
      boundary("a"),
      internal("x", 1),
      internal("y", 2),
      boundary("b", 3),
    ],
    branches: [
      pipe("in1", "a", "x"),
      pipe("x", "x", "y"),
      pipe("out1", "y", "b"),
    ],
  } as NetworkConfig;
}

/**
 * a --in--> n1 --out--> b with wall node w1 (member) tied to ambient by the
 * CROSSING conductor 'n1' — its id collides with the member node n1, which
 * only matters once the conductor enters the id map ("share" mode).
 */
function crossingCollisionCfg(): NetworkConfig {
  const cfg = chainCfg();
  cfg.branches = [pipe("in", "a", "n1"), pipe("out", "n1", "b")];
  cfg.solidNodes = [
    {
      id: "w1",
      type: "solid",
      x: 1,
      y: 60,
      temperature: 350,
      mass: 2,
      cp: 385,
    },
    { id: "amb", type: "ambient", x: 0, y: 60, temperature: 290 },
  ];
  cfg.conductors = [
    {
      id: "n1",
      from: "w1",
      to: "amb",
      type: { kind: "conduction", k: 200, area: 0.01, length: 0.05 },
    },
  ];
  return cfg;
}

/** src --seam--> y, x --xy--> y, x --exit--> sink : x is backfed. */
function backfedCfg(): NetworkConfig {
  return {
    meta: { name: "backfed", version: 2 },
    settings: { ...SETTINGS },
    fluid: { ...FLUID },
    nodes: [
      boundary("src"),
      internal("x", 1),
      internal("y", 2),
      boundary("sink", 3),
    ],
    branches: [
      pipe("seam", "src", "y"),
      pipe("xy", "x", "y"),
      pipe("exit", "x", "sink"),
    ],
  } as NetworkConfig;
}

/** a --entry--> n1 --o1--> b1 and n2 --o2--> b2 : two sinks, no unique exit. */
function ambiguousExitCfg(): NetworkConfig {
  return {
    meta: { name: "ambiguous-exit", version: 2 },
    settings: { ...SETTINGS },
    fluid: { ...FLUID },
    nodes: [
      boundary("a"),
      internal("n1", 1),
      internal("n2", 2),
      boundary("b1", 3),
      boundary("b2", 4),
    ],
    branches: [
      pipe("entry", "a", "n1"),
      pipe("o1", "n1", "b1"),
      pipe("o2", "n2", "b2"),
    ],
  } as NetworkConfig;
}

/** a --entry--> n1 <--> n2 : an induced cycle, so NO exit node exists. */
function cyclicCfg(): NetworkConfig {
  return {
    meta: { name: "cyclic", version: 2 },
    settings: { ...SETTINGS },
    fluid: { ...FLUID },
    nodes: [boundary("a"), internal("n1", 1), internal("n2", 2)],
    branches: [
      pipe("entry", "a", "n1"),
      pipe("f", "n1", "n2"),
      pipe("g", "n2", "n1"),
    ],
  } as NetworkConfig;
}

/** n1 alone, no branches at all: nothing enters the unit. */
function isolatedCfg(): NetworkConfig {
  return {
    meta: { name: "isolated", version: 2 },
    settings: { ...SETTINGS },
    fluid: { ...FLUID },
    nodes: [internal("n1")],
    branches: [],
  } as NetworkConfig;
}

/** a --seg1--> n1 <--segB-- c (merge): two branches enter the unit. */
function mergeCfg(): NetworkConfig {
  const cfg = chainCfg();
  cfg.nodes.push(boundary("c") as never);
  cfg.branches.push(pipe("segB", "c", "n1"));
  return cfg;
}

const NONE: Selection = { kind: "none" };

/** The store action's execution mode, mirrored exactly. */
const EXEC = {
  count: 2,
  linkParams: false,
  crossingConductors: "share",
} as const;

interface RepeatCase {
  name: string;
  config: () => NetworkConfig;
  selection: Selection;
  canvasSelection: string[];
  /** What the UI must report. */
  ui:
    | { canRepeat: true; seamBranch: string }
    | {
        canRepeat: false;
        reasonContains: string;
        seamBranch?: string | null;
      };
  /**
   * The execution-side outcome for the members/seam the row names.
   * `errorContains` set → repeatUnit must reject with that fragment;
   * omitted → repeatUnit must succeed.  `verbatim: true` additionally
   * requires the UI reason to BE the execution error (single-predicate
   * proof).
   */
  exec: {
    members: RepeatMembers;
    seamBranch: string | null;
    errorContains?: string;
  };
  verbatim?: boolean;
  /**
   * UI-originated rejection (selection shape / seam derivation) that
   * execution cannot be asked to reproduce as-is; the exec side then
   * probes validateRepeatUnit with the closest seam instead of expecting
   * wording parity.
   */
  uiOnly?: boolean;
}

const REPEAT_CASES: RepeatCase[] = [
  // ── Happy paths: canRepeat ⇒ repeatUnit MUST succeed ──────────────────
  {
    name: "happy path: single-node unit with derived seam",
    config: chainCfg,
    selection: NONE,
    canvasSelection: ["n1"],
    ui: { canRepeat: true, seamBranch: "seg1" },
    exec: { members: { nodes: ["n1"], solidNodes: [] }, seamBranch: "seg1" },
  },
  {
    name: "happy path: multi selection disambiguates an ambiguous seam",
    config: mergeCfg,
    selection: {
      kind: "multi",
      items: [
        { kind: "node", id: "n1" },
        { kind: "branch", id: "segB" },
      ],
    },
    canvasSelection: ["n1"],
    ui: { canRepeat: true, seamBranch: "segB" },
    exec: { members: { nodes: ["n1"], solidNodes: [] }, seamBranch: "segB" },
  },
  // ── The guards added in the review pass (B2, S1, S2 + id-map extents) ──
  {
    name: "B2: unit containing a boundary node",
    config: boundaryUnitCfg,
    selection: NONE,
    canvasSelection: ["n1", "out2"],
    ui: {
      canRepeat: false,
      reasonContains: "boundary node(s) out2",
      seamBranch: "feed",
    },
    exec: {
      members: { nodes: ["n1", "out2"], solidNodes: [] },
      seamBranch: "feed",
      errorContains: "boundary node(s) out2",
    },
    verbatim: true,
  },
  {
    name: "S1: cross-namespace id collision among unit entities",
    config: collidingCfg,
    selection: NONE,
    canvasSelection: ["x", "y"],
    ui: { canRepeat: false, reasonContains: "share the id 'x'" },
    exec: {
      members: { nodes: ["x", "y"], solidNodes: [] },
      seamBranch: "in1",
      errorContains: "share the id 'x'",
    },
    verbatim: true,
  },
  {
    name: "S1 (seam): the seam branch's id collides with a member node",
    config: () => {
      const cfg = collidingCfg();
      cfg.branches[0]!.id = "x"; // the ENTRY branch now shares node x's id
      cfg.branches[1]!.id = "p1"; // induced branch no longer collides
      return cfg;
    },
    selection: NONE,
    canvasSelection: ["x", "y"],
    ui: {
      canRepeat: false,
      reasonContains: "the seam branch 'x' shares its id",
      seamBranch: "x",
    },
    exec: {
      members: { nodes: ["x", "y"], solidNodes: [] },
      seamBranch: "x",
      errorContains: "the seam branch 'x' shares its id",
    },
    verbatim: true,
  },
  {
    name: "S1 (share): a shared crossing conductor's id collides with a member",
    config: crossingCollisionCfg,
    selection: NONE,
    canvasSelection: ["n1", "w1"],
    ui: {
      canRepeat: false,
      reasonContains: "the crossing conductor 'n1' shares its id",
      seamBranch: "in",
    },
    exec: {
      members: { nodes: ["n1"], solidNodes: ["w1"] },
      seamBranch: "in",
      errorContains: "the crossing conductor 'n1' shares its id",
    },
    verbatim: true,
  },
  {
    name: "S2: a member node is not reachable from the seam's target",
    config: backfedCfg,
    selection: NONE,
    canvasSelection: ["x", "y"],
    ui: {
      canRepeat: false,
      reasonContains: "not reachable from the seam's target 'y'",
      seamBranch: "seam",
    },
    exec: {
      members: { nodes: ["x", "y"], solidNodes: [] },
      seamBranch: "seam",
      errorContains: "'x'",
    },
    verbatim: true,
  },
  {
    name: "ambiguous exit node (multiple sinks, divergent exit crossings)",
    config: ambiguousExitCfg,
    selection: NONE,
    canvasSelection: ["n1", "n2"],
    ui: {
      canRepeat: false,
      reasonContains: "ambiguous candidates",
      seamBranch: "entry",
    },
    exec: {
      members: { nodes: ["n1", "n2"], solidNodes: [] },
      seamBranch: "entry",
      errorContains: "ambiguous candidates",
    },
    verbatim: true,
  },
  {
    name: "no exit node (induced cycle: every member has an outgoing branch)",
    config: cyclicCfg,
    selection: NONE,
    canvasSelection: ["n1", "n2"],
    ui: {
      canRepeat: false,
      reasonContains: "cannot determine the unit's exit node",
      seamBranch: "entry",
    },
    exec: {
      members: { nodes: ["n1", "n2"], solidNodes: [] },
      seamBranch: "entry",
      errorContains: "cannot determine the unit's exit node",
    },
    verbatim: true,
  },
  {
    name: "explicit seam pick that does NOT enter the unit",
    config: chainCfg,
    selection: {
      kind: "multi",
      items: [
        { kind: "node", id: "n1" },
        { kind: "branch", id: "seg2" }, // the EXIT branch
      ],
    },
    canvasSelection: ["n1"],
    ui: {
      canRepeat: false,
      reasonContains:
        "seam branch 'seg2' is not a branch entering the unit (entry crossings: seg1)",
    },
    exec: {
      members: { nodes: ["n1"], solidNodes: [] },
      seamBranch: "seg2",
      errorContains: "is not a branch entering the unit",
    },
    verbatim: true,
  },
  // ── Member-set guards ──────────────────────────────────────────────────
  {
    name: "duplicate member id",
    config: chainCfg,
    selection: NONE,
    canvasSelection: ["n1", "n1"],
    ui: { canRepeat: false, reasonContains: "duplicate member id 'n1'" },
    exec: {
      members: { nodes: ["n1", "n1"], solidNodes: [] },
      seamBranch: "seg1",
      errorContains: "duplicate member id 'n1'",
    },
    verbatim: true,
  },
  // ── UI-originated rejections (no verbatim execution equivalent) ───────
  {
    name: "empty selection (uiOnly — execution equivalent: the empty unit)",
    config: chainCfg,
    selection: NONE,
    canvasSelection: [],
    ui: {
      canRepeat: false,
      reasonContains: "select the nodes of the unit to repeat",
    },
    exec: {
      members: { nodes: [], solidNodes: [] },
      seamBranch: null,
      errorContains: "the unit is empty",
    },
    uiOnly: true,
  },
  {
    name: "unknown member ids are filtered out before analysis (uiOnly)",
    config: chainCfg,
    selection: NONE,
    canvasSelection: ["ghost"],
    ui: {
      canRepeat: false,
      reasonContains: "select the nodes of the unit to repeat",
    },
    exec: {
      members: { nodes: ["ghost"], solidNodes: [] },
      seamBranch: null,
      errorContains: "unknown fluid node member id(s): ghost",
    },
    uiOnly: true,
  },
  {
    name: "zero entry crossings: no seam can be derived (uiOnly)",
    config: isolatedCfg,
    selection: NONE,
    canvasSelection: ["n1"],
    ui: {
      canRepeat: false,
      reasonContains: "no branch enters the unit",
      seamBranch: null,
    },
    exec: {
      members: { nodes: ["n1"], solidNodes: [] },
      seamBranch: "anything",
      errorContains: "not a branch entering the unit",
    },
    uiOnly: true,
  },
  {
    name: "multiple entry crossings: the seam is ambiguous (uiOnly)",
    config: mergeCfg,
    selection: NONE,
    canvasSelection: ["n1"],
    ui: {
      canRepeat: false,
      reasonContains: "multiple branches enter the unit: seg1, segB",
      seamBranch: null,
    },
    // With an explicit valid seam the unit WOULD execute — the ambiguity
    // is a selection-level problem, resolved by the multi-selection row.
    exec: {
      members: { nodes: ["n1"], solidNodes: [] },
      seamBranch: "seg1",
    },
    uiOnly: true,
  },
  {
    name: "multiple SELECTED entry branches contradict each other (uiOnly)",
    config: mergeCfg,
    selection: {
      kind: "multi",
      items: [
        { kind: "node", id: "n1" },
        { kind: "branch", id: "seg1" },
        { kind: "branch", id: "segB" },
      ],
    },
    canvasSelection: ["n1"],
    ui: {
      canRepeat: false,
      reasonContains: "multiple selected branches enter the unit: seg1, segB",
    },
    exec: {
      members: { nodes: ["n1"], solidNodes: [] },
      seamBranch: "seg1",
    },
    uiOnly: true,
  },
];

describe("repeat guard parity: the UI predicts every execution rejection", () => {
  for (const row of REPEAT_CASES) {
    it(row.name, () => {
      const config = row.config();
      const ui = analyzeRepeatSelection(
        config,
        row.selection,
        row.canvasSelection,
      );

      // 1. The UI prediction.
      expect(ui.canRepeat, `UI canRepeat for: ${row.name}`).toBe(
        row.ui.canRepeat,
      );
      if (!row.ui.canRepeat) {
        expect(ui.reason).toBeDefined();
        expect(ui.reason).toContain(row.ui.reasonContains);
      }
      if ("seamBranch" in row.ui && row.ui.seamBranch !== undefined) {
        expect(ui.seamBranch).toBe(row.ui.seamBranch);
      }

      // 2. Execution agrees, called the way the store action calls it.
      const exec = repeatUnit(config, {
        members: row.exec.members,
        seamBranch: row.exec.seamBranch,
        ...EXEC,
      });
      if (row.exec.errorContains === undefined) {
        expect(exec.ok, `execution must succeed for: ${row.name}`).toBe(true);
      } else {
        expect(exec.ok, `execution must reject for: ${row.name}`).toBe(false);
        if (!exec.ok) {
          expect(exec.error).toContain(row.exec.errorContains);
          // 3. Verbatim rows: the UI reason IS the execution error.
          if (row.verbatim) {
            expect(ui.canRepeat).toBe(false);
            if (!ui.canRepeat) {
              expect(
                ui.reason,
                `UI reason must equal the repeatUnit error for: ${row.name}`,
              ).toBe(exec.error);
            }
          }
        }
      }

      // 4. The invariant proper: whatever the UI decided, executing ITS
      //    derived members + seam agrees with it.
      if (ui.canRepeat) {
        const run = repeatUnit(config, {
          members: ui.members,
          seamBranch: ui.seamBranch,
          ...EXEC,
        });
        expect(
          run.ok,
          `canRepeat: true but repeatUnit rejected: ${
            run.ok ? "" : run.error
          } (${row.name})`,
        ).toBe(true);
      } else if (ui.seamBranch !== null && !row.uiOnly) {
        const run = repeatUnit(config, {
          members: ui.members,
          seamBranch: ui.seamBranch,
          ...EXEC,
        });
        expect(
          run.ok,
          `canRepeat: false but repeatUnit accepted the UI's members/seam (${row.name})`,
        ).toBe(false);
      }
    });
  }

  it("each exec-rejecting row trips a DISTINCT guard (no rotted rows)", () => {
    const errors: string[] = [];
    for (const row of REPEAT_CASES) {
      if (row.exec.errorContains === undefined) continue;
      const exec = repeatUnit(row.config(), {
        members: row.exec.members,
        seamBranch: row.exec.seamBranch,
        ...EXEC,
      });
      expect(exec.ok, `row stopped rejecting: ${row.name}`).toBe(false);
      if (!exec.ok) errors.push(exec.error);
    }
    // If two rows produce the SAME error string, one of them no longer
    // exercises a distinct guard — or a guard was removed without removing
    // its row.  Either way the table needs attention.
    expect(new Set(errors).size).toBe(errors.length);
    // Sanity: the table covers every chained-mode guard review added —
    // boundary (B2), the three id-collision guards (S1 × 3), reachability
    // (S2), the two exit-node failures, and the non-entry-seam guard.
    expect(errors.length).toBeGreaterThanOrEqual(9);
  });

  it("the user-reported case: selecting a boundary node disables Repeat", () => {
    // The exact report: a boundary node selected on its own.
    const config = boundaryUnitCfg();
    const ui = analyzeRepeatSelection(config, NONE, ["out2"]);
    expect(ui.canRepeat).toBe(false);
    expect(ui.seamBranch).toBe("out");
    expect(ui.reason).toContain("boundary node(s) out2");
    expect(ui.reason).toContain("use Duplicate instead");
    // …and the reason is verbatim what repeatUnit would have failed with.
    const exec = repeatUnit(config, {
      members: ui.members,
      seamBranch: ui.seamBranch,
      ...EXEC,
    });
    expect(exec.ok).toBe(false);
    if (!exec.ok) expect(ui.reason).toBe(exec.error);
  });

  it("Duplicate mode stays legal for boundary units (seamBranch: null)", () => {
    const validation = validateRepeatUnit(
      boundaryUnitCfg(),
      { nodes: ["n1", "out2"], solidNodes: [] },
      null,
      "share",
    );
    expect(validation.ok).toBe(true);
  });

  it("the share-mode crossing collision is mode-dependent (drop still repeats)", () => {
    // Documents WHY the UI validates in "share": it is the mode the store
    // action executes.  In "drop" mode the same unit is legal.
    const config = crossingCollisionCfg();
    const members = { nodes: ["n1"], solidNodes: ["w1"] };
    const drop = repeatUnit(config, {
      members,
      seamBranch: "in",
      count: 2,
      linkParams: false,
      crossingConductors: "drop",
    });
    expect(drop.ok).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* Split parity — analyzeSplitSelection vs splitPipeBranch             */
/* ------------------------------------------------------------------ */

/** A --p1--> B with the named component override. */
function splitCfg(
  component: Record<string, unknown> = { ...PIPE },
): NetworkConfig {
  return {
    meta: { name: "split", version: 2 },
    settings: { ...SETTINGS },
    fluid: { ...FLUID },
    nodes: [boundary("A"), boundary("B", 1)],
    branches: [{ id: "p1", from: "A", to: "B", component }],
  } as NetworkConfig;
}

describe("split guard parity: the UI predicts every execution rejection", () => {
  const splitCases: Array<{
    name: string;
    config: () => NetworkConfig;
    branchId: string;
    expectEnabled: boolean;
  }> = [
    {
      name: "pipe branch: enabled, and the split succeeds",
      config: () => splitCfg(),
      branchId: "p1",
      expectEnabled: true,
    },
    {
      name: "non-pipe component: disabled with the verbatim core error",
      config: () => splitCfg({ type: "orifice", area: 1e-3, cd: 0.6 }),
      branchId: "p1",
      expectEnabled: false,
    },
    {
      name: "dangling endpoint: disabled with the verbatim core error",
      config: () => {
        const cfg = splitCfg();
        cfg.branches[0]!.to = "ghost";
        return cfg;
      },
      branchId: "p1",
      expectEnabled: false,
    },
    {
      name: "unknown branch id: disabled with the verbatim core error",
      config: () => splitCfg(),
      branchId: "ghost",
      expectEnabled: false,
    },
  ];

  for (const row of splitCases) {
    it(row.name, () => {
      const config = row.config();
      const ui = analyzeSplitSelection(
        config,
        { kind: "branch", id: row.branchId },
        [],
      );
      const exec = splitPipeBranch(config, row.branchId, 2);
      if (row.expectEnabled) {
        expect(ui.branchId).toBe(row.branchId);
        expect(
          exec.ok,
          `enabled but splitPipeBranch rejected: ${exec.ok ? "" : exec.error}`,
        ).toBe(true);
      } else {
        expect(ui.branchId).toBeNull();
        expect(exec.ok).toBe(false);
        if (!exec.ok) {
          // One predicate: the tooltip reason IS the execution error.
          expect(ui.reason).toBe(exec.error);
        }
      }
    });
  }
});
