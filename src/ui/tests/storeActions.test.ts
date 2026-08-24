/**
 * Store-level tests: run-history ring buffer / selection / staleness and the
 * duplicate-selection action. These run against the real zustand store with
 * localStorage unavailable (utils catch the failure silently).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { useStore } from "../store";
import { RUN_HISTORY_CAP } from "../runHistory";
import type { NetworkConfig, SteadyResult } from "../types";
import { configHash } from "../provenance";
import { validateNetwork } from "../../core";
import { createDiaryCollector, type RunDiary } from "../convergenceDiary";
import {
  localComponentToolId,
  parseLocalComponent,
  refreshComponentLibrary,
} from "../componentLibrary";
import { vi } from "vitest";

const cfg = (name: string): NetworkConfig => ({
  meta: { name, version: 2 },
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
      component: { type: "pipe", length: 1, diameter: 0.02, roughness: 1e-5 },
      label: "Pipe",
    },
  ],
});

const steady = (p: number): SteadyResult => ({
  converged: true,
  iterations: 5,
  residual: 1e-9,
  nodes: {
    A: { pressure: p, temperature: 300, density: 1000 },
    B: { pressure: 1e5, temperature: 300, density: 1000 },
  },
  branches: { b1: { mdot: 0.5, velocity: 1, dP: 1000, reynolds: 9000 } },
});

function resetStore() {
  useStore.setState({
    config: cfg("Test"),
    baseConfig: cfg("Test"),
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
    preparingOperation: null,
  });
}

/** A converged live diary for `config`, with one progress milestone fed. */
function diaryFor(
  config: NetworkConfig,
  result: SteadyResult,
  residuals: number[] = [1e-2, 1e-5],
): RunDiary {
  const c = createDiaryCollector(config);
  residuals.forEach((residual, i) =>
    c.onProgress({ kind: "steady", iteration: i + 1, residual }),
  );
  return c.finalizeFromResult(result);
}

describe("run history store", () => {
  beforeEach(resetStore);

  it("pushRunRecord appends immutable records and never destroys prior results", () => {
    const s = () => useStore.getState();
    s().pushRunRecord({ result: steady(2e5), config: s().config });
    s().pushRunRecord({ result: steady(1.9e5), config: s().config });
    const h = s().runHistory;
    expect(h).toHaveLength(2);
    expect(h[0].name).toBe("Run 1");
    expect(h[1].name).toBe("Run 2");
    expect(s().selectedRunId).toBe(h[1].id);
    // Records are independent snapshots: mutating a local copy of the config
    // after the run must not change the record.
    expect(h[0].result.nodes["A"].pressure).toBe(2e5);
    expect(h[1].result.nodes["A"].pressure).toBe(1.9e5);
  });

  it("ring buffer caps at 10 and clears a dropped baseline pin", () => {
    const s = () => useStore.getState();
    for (let i = 0; i < RUN_HISTORY_CAP + 2; i++) {
      s().pushRunRecord({ result: steady(2e5 - i), config: s().config });
    }
    expect(s().runHistory).toHaveLength(RUN_HISTORY_CAP);
    // Names continue past the cap (Run 3 … Run 12 in the buffer)
    expect(s().runHistory[0].name).toBe("Run 3");
    // Pin the oldest then push it out
    s().setBaselineRunId(s().runHistory[0].id);
    s().pushRunRecord({ result: steady(1), config: s().config });
    expect(s().baselineRunId).toBeNull();
  });

  it("selectRun swaps the displayed result and flags staleness vs the live config", () => {
    const s = () => useStore.getState();
    s().pushRunRecord({ result: steady(2e5), config: s().config });
    const firstId = s().runHistory[0].id;
    // Edit the config so the historical record is stale
    s().updateNode("A", { pressure: 150000 });
    s().pushRunRecord({ result: steady(150000), config: s().config });
    s().selectRun(firstId);
    expect(s().result?.nodes["A"].pressure).toBe(2e5);
    expect(s().resultStale).toBe(true);
    expect(s().resultConfig?.nodes[0].pressure).toBe(2e5);
    // Selecting the latest run (same config) is not stale
    s().selectRun(s().runHistory[1].id);
    expect(s().resultStale).toBe(false);
  });

  it("renameRun and deleteRun behave; deleting the selected run clears the pointer", () => {
    const s = () => useStore.getState();
    s().pushRunRecord({ result: steady(2e5), config: s().config });
    const id = s().runHistory[0].id;
    s().renameRun(id, "  Baseline case  ");
    expect(s().runHistory[0].name).toBe("Baseline case");
    s().deleteRun(id);
    expect(s().runHistory).toHaveLength(0);
    expect(s().selectedRunId).toBeNull();
  });
});

describe("graph removal invariants", () => {
  beforeEach(() => {
    resetStore();
    const graph: NetworkConfig = {
      ...cfg("Graph"),
      solidNodes: [
        {
          id: "S",
          type: "solid",
          x: 200,
          y: 0,
          temperature: 300,
          mass: 1,
          cp: 500,
        },
      ],
      conductors: [
        {
          id: "c1",
          from: "A",
          to: "S",
          type: { kind: "convection", h: 10, area: 1 },
        },
      ],
      groups: [{ id: "g1", label: "Group", x: 0, y: 0 }],
    };
    useStore.setState({ config: graph, baseConfig: graph });
  });

  it("removing a fluid node also removes attached conductors and their selection", () => {
    useStore.getState().setSelection({ kind: "conductor", id: "c1" });
    useStore.getState().removeNode("A");
    expect(useStore.getState().config.conductors).toEqual([]);
    expect(useStore.getState().selection).toEqual({ kind: "none" });
  });

  it("removing a solid node clears an attached conductor selection", () => {
    useStore.getState().setSelection({ kind: "conductor", id: "c1" });
    useStore.getState().removeSolidNode("S");
    expect(useStore.getState().config.conductors).toEqual([]);
    expect(useStore.getState().selection).toEqual({ kind: "none" });
  });

  it("removing a selected group clears the selection", () => {
    useStore.getState().setSelection({ kind: "group", id: "g1" });
    useStore.getState().removeGroup("g1");
    expect(useStore.getState().selection).toEqual({ kind: "none" });
  });
});

describe("run history diaries (store lifecycle)", () => {
  beforeEach(resetStore);

  it("pushRunRecord stores an intake-cloned diary and makes it current", () => {
    const s = () => useStore.getState();
    const result = steady(2e5);
    const diary = diaryFor(s().config, result);
    s().pushRunRecord({ result, config: s().config, diary });

    const record = s().runHistory[0];
    expect(record.diary).toBeDefined();
    expect(record.diary).not.toBe(diary); // intake clone, not the caller's object
    expect(JSON.stringify(record.diary)).toBe(JSON.stringify(diary)); // content-identical
    expect(s().resultDiary).toBe(record.diary); // pushed record is selected

    // No alias mutation: mutating the caller's object afterwards must not
    // leak into the record (and vice versa).
    diary.events[0].message = "tampered";
    diary.summary.outcome = "error";
    expect(record.diary!.events[0].message).not.toBe("tampered");
    expect(record.diary!.summary.outcome).toBe("converged");
    (record.diary!.events[0] as any).message = "record-side edit";
    expect(diary.events[0].message).toBe("tampered");
  });

  it("pushRunRecord without a diary stays a valid legacy record with null current diary", () => {
    const s = () => useStore.getState();
    s().pushRunRecord({ result: steady(2e5), config: s().config });
    expect(s().runHistory[0].diary).toBeUndefined();
    expect(s().resultDiary).toBeNull();
  });

  it("selectRun restores the record diary; legacy records yield null", () => {
    const s = () => useStore.getState();
    const diary = diaryFor(s().config, steady(2e5));
    s().pushRunRecord({ result: steady(2e5), config: s().config, diary });
    s().pushRunRecord({ result: steady(1.9e5), config: s().config }); // legacy, no diary
    const [withDiary, legacy] = s().runHistory;

    // Pushing the legacy record made it current → diary cleared.
    expect(s().resultDiary).toBeNull();

    s().selectRun(withDiary.id);
    expect(s().resultDiary).toBe(withDiary.diary);
    expect(s().resultDiary?.summary.outcome).toBe("converged");

    s().selectRun(legacy.id);
    expect(s().resultDiary).toBeNull();
  });

  it("selectRun(null) keeps the displayed diary (pointer-only deselect)", () => {
    const s = () => useStore.getState();
    const result = steady(2e5);
    s().setResult(result);
    s().pushRunRecord({
      result,
      config: s().config,
      diary: diaryFor(s().config, result),
    });
    const diary = s().resultDiary;
    expect(s().result).toBe(result);
    s().selectRun(null);
    expect(s().selectedRunId).toBeNull();
    // Displayed result/config/diary are untouched by a pointer-only deselect.
    expect(s().result).toBe(result);
    expect(s().resultDiary).toBe(diary);
  });

  it("setResult clears the diary (fresh or cleared results never keep a stale one)", () => {
    const s = () => useStore.getState();
    s().pushRunRecord({
      result: steady(2e5),
      config: s().config,
      diary: diaryFor(s().config, steady(2e5)),
    });
    expect(s().resultDiary).not.toBeNull();
    s().setResult(steady(1.8e5));
    expect(s().resultDiary).toBeNull();
    s().setResultDiary(diaryFor(s().config, steady(1.8e5)));
    s().setResult(null);
    expect(s().resultDiary).toBeNull();
  });

  it("setResultDiary attaches a partial cancelled diary without a RunRecord", () => {
    const s = () => useStore.getState();
    const c = createDiaryCollector(s().config);
    c.onProgress({ kind: "steady", iteration: 4, residual: 3e-3 });
    const cancelled = c.finalizeCancelled();
    s().setResultDiary(cancelled);
    expect(s().resultDiary).toBe(cancelled);
    expect(s().resultDiary?.summary.outcome).toBe("cancelled");
    expect(s().runHistory).toHaveLength(0); // no fabricated record
  });

  it("newNetwork and loadExample clear the diary; model edits do NOT", () => {
    const s = () => useStore.getState();
    s().pushRunRecord({
      result: steady(2e5),
      config: s().config,
      diary: diaryFor(s().config, steady(2e5)),
    });
    const diary = s().resultDiary;

    // Model edit: result goes stale but the displayed result AND its diary stay.
    s().updateNode("A", { pressure: 150000 });
    expect(s().resultStale).toBe(true);
    expect(s().resultDiary).toBe(diary);

    s().newNetwork();
    expect(s().resultDiary).toBeNull();

    s().pushRunRecord({
      result: steady(2e5),
      config: s().config,
      diary: diaryFor(s().config, steady(2e5)),
    });
    s().loadExample("Three-pipe junction");
    expect(s().resultDiary).toBeNull();
  });

  it("loadExample and newNetwork clear a leftover CoolProp fluidError", () => {
    const s = () => useStore.getState();
    s().setFluidError("CoolProp init failed: boom");
    s().loadExample("LOX/RP-1 thruster (transient startup)");
    expect(s().fluidError).toBeNull();

    s().setFluidError("CoolProp init failed: boom");
    s().newNetwork();
    expect(s().fluidError).toBeNull();
  });

  it("rename/delete/baseline leave diaries intact; ring eviction drops them with the record", () => {
    const s = () => useStore.getState();
    s().pushRunRecord({
      result: steady(2e5),
      config: s().config,
      diary: diaryFor(s().config, steady(2e5)),
    });
    const id = s().runHistory[0].id;
    const diary = s().runHistory[0].diary!;

    s().renameRun(id, "Renamed");
    expect(s().runHistory[0].diary).toBe(diary); // rename copies the record shell only
    s().setBaselineRunId(id);
    expect(s().runHistory[0].diary).toBe(diary);

    // Deleting a non-selected run does not touch the current diary.
    s().pushRunRecord({
      result: steady(1.9e5),
      config: s().config,
      diary: diaryFor(s().config, steady(1.9e5)),
    });
    const secondDiary = s().resultDiary;
    s().deleteRun(s().runHistory[0].id);
    expect(s().resultDiary).toBe(secondDiary);

    // Ring eviction: fill past the cap — evicted records take their diaries.
    for (let i = 0; i < RUN_HISTORY_CAP; i++) {
      s().pushRunRecord({
        result: steady(1e5 - i),
        config: s().config,
        diary: diaryFor(s().config, steady(1e5 - i)),
      });
    }
    expect(s().runHistory).toHaveLength(RUN_HISTORY_CAP);
    expect(s().runHistory.some((r) => r.id === id)).toBe(false);
    // Every surviving record still carries its own diary.
    expect(
      s().runHistory.every((r) => r.diary?.summary.outcome === "converged"),
    ).toBe(true);
    expect(s().resultDiary).toBe(s().runHistory.at(-1)!.diary);
  });

  it("diary lifecycle never mutates canonical config, text, undo/redo, dirty, or hashes", () => {
    const s = () => useStore.getState();
    const configRef = s().config;
    const text = s().modelText;
    const hash = configHash(configRef);
    const result = steady(2e5);
    const diary = diaryFor(configRef, result);

    s().pushRunRecord({ result, config: configRef, diary });
    s().selectRun(s().runHistory[0].id);
    s().setResultDiary(diary);
    s().setResult(null);

    expect(s().config).toBe(configRef);
    expect(s().modelText).toBe(text);
    expect(s().textDraft).toBe(text);
    expect(s().past).toHaveLength(0);
    expect(s().future).toHaveLength(0);
    expect(s().dirty).toBe(false);
    expect(configHash(s().config)).toBe(hash);
    // The collector only READ the config: nothing was frozen or mutated.
    expect(Object.isFrozen(configRef)).toBe(false);
    expect(configRef.nodes[0].pressure).toBe(2e5);
  });
});

describe("duplicateSelection", () => {
  beforeEach(resetStore);

  it('duplicates selected nodes with internal edges, reminted ids, +30 offset, " copy" labels', () => {
    const s = () => useStore.getState();
    s().setCanvasSelection(["A", "B"]);
    const res = s().duplicateSelection();
    expect(res).toEqual({ nodes: 2, branches: 1, conductors: 0 });
    const c = s().config;
    expect(c.nodes).toHaveLength(4);
    expect(c.branches).toHaveLength(2);
    const copyA = c.nodes.find((n) => n.label === "In copy");
    const copyB = c.nodes.find((n) => n.label === "Out copy");
    expect(copyA).toBeDefined();
    expect(copyB).toBeDefined();
    expect(copyA!.x).toBe(130);
    expect(copyA!.y).toBe(130);
    expect(copyA!.id).not.toBe("A");
    const copiedBranch = c.branches.find((b) => b.id !== "b1");
    expect(copiedBranch!.from).toBe(copyA!.id);
    expect(copiedBranch!.to).toBe(copyB!.id);
    expect(copiedBranch!.label).toBe("Pipe copy");
    // The duplicates become the new canvas selection
    expect(new Set(s().canvasSelection)).toEqual(
      new Set([copyA!.id, copyB!.id]),
    );
  });

  it("partial selections do not duplicate dangling edges", () => {
    const s = () => useStore.getState();
    s().setCanvasSelection(["A"]);
    const res = s().duplicateSelection();
    expect(res).toEqual({ nodes: 1, branches: 0, conductors: 0 });
    expect(s().config.branches).toHaveLength(1);
  });

  it("a single selected branch duplicates as a parallel branch", () => {
    const s = () => useStore.getState();
    s().setSelection({ kind: "branch", id: "b1" });
    const res = s().duplicateSelection();
    expect(res).toEqual({ nodes: 0, branches: 1, conductors: 0 });
    const c = s().config;
    expect(c.branches).toHaveLength(2);
    const dup = c.branches.find((b) => b.id !== "b1")!;
    expect(dup.from).toBe("A");
    expect(dup.to).toBe("B");
    expect(dup.component).toEqual(c.branches[0].component);
    expect(s().selection).toEqual({ kind: "branch", id: dup.id });
  });

  it("returns null when nothing is selected", () => {
    const s = () => useStore.getState();
    expect(s().duplicateSelection()).toBeNull();
    expect(s().config.nodes).toHaveLength(2);
  });

  it("duplication is undoable", () => {
    const s = () => useStore.getState();
    s().setCanvasSelection(["A", "B"]);
    s().duplicateSelection();
    expect(s().config.nodes).toHaveLength(4);
    s().undo();
    expect(s().config.nodes).toHaveLength(2);
    expect(s().config.branches).toHaveLength(1);
  });
});

describe("maintainability regressions", () => {
  beforeEach(resetStore);

  it("records metadata edits in history and invalidates redo", () => {
    const s = () => useStore.getState();
    s().updateMeta({ name: "Renamed" });
    expect(s().past).toHaveLength(1);
    s().undo();
    expect(s().config.meta.name).toBe("Test");
    expect(s().future).toHaveLength(1);
    s().updateMeta({ name: "Other" });
    expect(s().future).toHaveLength(0);
    s().undo();
    expect(s().config.meta.name).toBe("Test");
  });

  it("only marks the exact saved config clean", () => {
    const s = () => useStore.getState();
    s().updateMeta({ name: "Save me" });
    const savingHash = configHash(s().config);
    s().updateMeta({ name: "Edited during save" });
    s().markSaved(savingHash);
    expect(s().dirty).toBe(true);
    s().markSaved(configHash(s().config));
    expect(s().dirty).toBe(false);
  });

  it("clears an active local tool when the refreshed library removes it", async () => {
    const source =
      "defineComponent({ metadata: { name: 'needle' }, pressureDrop() { return 0; } });";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        headers: { get: () => "application/json" },
        json: async () => ({
          components: [{ path: "needle.js", source, modifiedAt: 1 }],
        }),
      }),
    );
    await refreshComponentLibrary({ force: true });
    useStore.getState().setBranchTool(localComponentToolId("needle"));
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        headers: { get: () => "application/json" },
        json: async () => ({ components: [] }),
      }),
    );
    await refreshComponentLibrary({ force: true });
    expect(useStore.getState().branchTool).toBeNull();
    vi.unstubAllGlobals();
  });

  it("rejects stale encoded local tools instead of treating them as built-ins", () => {
    useStore.getState().setBranchTool(localComponentToolId("missing"));
    expect(useStore.getState().branchTool).toBeNull();
  });

  it("updates embedded source only through the explicit action", () => {
    const embedded =
      "defineComponent({ metadata: { name: 'needle', params: [{ name: 'K', default: 7 }] }, pressureDrop() { return 0; } });";
    const localSource =
      "defineComponent({ metadata: { name: 'needle', params: [{ name: 'K', default: 2 }, { name: 'C', default: 3 }] }, pressureDrop() { return 0; } });";
    const config = cfg("Test");
    config.branches[0].component = {
      type: "userComponent",
      component: "needle",
      params: { K: 9 },
    };
    config.componentLibrary = {
      needle: { code: embedded, format: "defineComponent" },
    };
    useStore.setState({ config, baseConfig: config, past: [], future: [] });
    const local = parseLocalComponent({
      path: "needle.js",
      source: localSource,
      modifiedAt: 1,
    });
    expect(useStore.getState().config.componentLibrary!.needle.code).toBe(
      embedded,
    );
    useStore.getState().updateEmbeddedComponentFromLocal("b1", local);
    expect(useStore.getState().config.componentLibrary!.needle.code).toBe(
      localSource,
    );
    expect(useStore.getState().config.branches[0].component).toMatchObject({
      params: { K: 9, C: 3 },
    });
  });

  it("migrates every branch sharing an updated embedded component", () => {
    const store = useStore.getState();
    const source = `defineComponent({ metadata: { name: 'shared', params: [{ name: 'K', default: 3 }] }, pressureDrop() { return 0; } });`;
    const local = parseLocalComponent({
      path: "shared.component.js",
      source,
      modifiedAt: 1,
    });
    const config = cfg("Shared");
    config.componentLibrary = {
      shared: { code: source.replace("default: 3", "default: 1") },
    };
    config.branches = [
      {
        id: "u1",
        from: "A",
        to: "B",
        component: {
          type: "userComponent",
          component: "shared",
          params: { old: 1 },
        },
      },
      {
        id: "u2",
        from: "A",
        to: "B",
        component: {
          type: "userComponent",
          component: "shared",
          params: { K: 7 },
        },
      },
    ];
    store.setConfig(config);
    useStore.getState().updateEmbeddedComponentFromLocal("u1", local);
    const branches = useStore.getState().config.branches;
    expect((branches[0].component as any).params).toEqual({ K: 3 });
    expect((branches[1].component as any).params).toEqual({ K: 7 });
  });

  it("applies an advanced section as one undoable config edit", () => {
    const s = () => useStore.getState();
    const epoch = s().configEpoch;
    s().updateAdvancedSection("registers", { gain: 2 });
    expect(s().config.registers).toEqual({ gain: 2 });
    expect(s().configEpoch).toBe(epoch);
    s().undo();
    expect(s().config.registers).toBeUndefined();
  });
});

describe("selection synchronization", () => {
  beforeEach(resetStore);

  it("clears stale canvas multi-selection when selecting one entity", () => {
    useStore.setState({
      canvasSelection: ["A", "B"],
      selection: {
        kind: "multi",
        items: [
          { kind: "node", id: "A" },
          { kind: "node", id: "B" },
        ],
      },
    });

    useStore.getState().setSelection({ kind: "node", id: "A" });
    expect(useStore.getState().selection).toEqual({ kind: "node", id: "A" });
    expect(useStore.getState().canvasSelection).toEqual(["A"]);

    useStore.getState().setSelection({ kind: "branch", id: "b1" });
    expect(useStore.getState().canvasSelection).toEqual([]);
  });
});

describe("canvas notes", () => {
  beforeEach(resetStore);

  it("adds, edits, moves, and removes a note through undoable steps", () => {
    const s = () => useStore.getState();
    s().addNote({ id: "NOTE1", text: "", x: 0, y: 0 });
    expect(s().config.notes).toEqual([{ id: "NOTE1", text: "", x: 0, y: 0 }]);

    s().updateNote("NOTE1", { text: "Cd from Idelchik" });
    s().updateNote("NOTE1", { x: 45, y: 90 });
    expect(s().config.notes![0]).toMatchObject({
      text: "Cd from Idelchik",
      x: 45,
      y: 90,
    });

    s().undo();
    expect(s().config.notes![0]).toMatchObject({
      text: "Cd from Idelchik",
      x: 0,
      y: 0,
    });

    s().removeNote("NOTE1");
    expect(s().config.notes).toEqual([]);
  });

  it("ignores a no-op text patch so a keystroke cannot burn an undo slot", () => {
    const s = () => useStore.getState();
    s().addNote({ id: "NOTE1", text: "same", x: 0, y: 0 });
    const depth = s().past.length;
    s().updateNote("NOTE1", { text: "same" });
    expect(s().past).toHaveLength(depth);
    s().updateNote("missing", { text: "anything" });
    expect(s().past).toHaveLength(depth);
  });

  it("stores an explicit size on resize and drops it again when cleared", () => {
    const s = () => useStore.getState();
    s().addNote({ id: "NOTE1", text: "sized", x: 0, y: 0 });
    // Auto-sized until the user resizes: no size keys at all.
    expect(s().config.notes![0]).toEqual({
      id: "NOTE1",
      text: "sized",
      x: 0,
      y: 0,
    });

    s().updateNote("NOTE1", { width: 240, height: 120 });
    expect(s().config.notes![0]).toMatchObject({ width: 240, height: 120 });

    // Clearing the field means "fit the text", so the keys must be gone rather
    // than present-and-undefined (which would survive into the saved file).
    s().updateNote("NOTE1", { height: undefined });
    expect("height" in s().config.notes![0]).toBe(false);
    expect(s().config.notes![0].width).toBe(240);

    s().undo();
    expect(s().config.notes![0].height).toBe(120);
  });

  it("clears the selection when the selected note is removed", () => {
    const s = () => useStore.getState();
    s().addNote({ id: "NOTE1", text: "note", x: 0, y: 0 });
    s().setSelection({ kind: "note", id: "NOTE1" });
    s().removeNote("NOTE1");
    expect(s().selection).toEqual({ kind: "none" });
  });

  it("leaves displayed results trustworthy: notes change neither staleness nor the config hash", () => {
    const s = () => useStore.getState();
    const before = configHash(s().config);
    s().addNote({ id: "NOTE1", text: "Reviewed 2026-08-17", x: 0, y: 0 });
    s().updateNote("NOTE1", { text: "Reviewed and signed off" });
    expect(s().resultStale).toBe(false);
    expect(configHash(s().config)).toBe(before);
    // Still an unsaved change to the file, though.
    expect(s().dirty).toBe(true);
    // A real model edit must behave the opposite way.
    s().updateNode("A", { pressure: 3e5 });
    expect(s().resultStale).toBe(true);
    expect(configHash(s().config)).not.toBe(before);
  });

  it("unpins notes from a dissolved subnetwork instead of leaving a dangling reference", () => {
    const s = () => useStore.getState();
    s().addGroup({ id: "G1", label: "Core", x: 0, y: 0 });
    s().addNote({ id: "NOTE1", text: "inside", x: 15, y: 15, group: "G1" });
    s().removeGroup("G1");
    expect(s().config.notes![0].group).toBeUndefined();
    expect(validateNetwork(s().config)).toEqual([]);
  });
});

describe("color legend domain overrides", () => {
  beforeEach(resetStore);

  it("pins a per-kind range and clears it independently of other kinds", () => {
    const s = () => useStore.getState();
    s().setColorDomainOverride("pressure", [0, 500000]);
    s().setColorDomainOverride("temperature", [280, 420]);
    expect(s().colorDomainOverrides).toEqual({
      pressure: [0, 500000],
      temperature: [280, 420],
    });

    s().setColorDomainOverride("pressure", null);
    expect(s().colorDomainOverrides).toEqual({ temperature: [280, 420] });
  });

  it("is session-only view state: never touches config, dirty, or resultStale", () => {
    const s = () => useStore.getState();
    const before = configHash(s().config);
    s().setColorDomainOverride("pressure", [0, 500000]);
    expect(configHash(s().config)).toBe(before);
    expect(s().dirty).toBe(false);
    expect(s().resultStale).toBe(false);
  });
});

describe("simulation variants", () => {
  beforeEach(resetStore);

  it("creates a variant seeded from what is on screen and activates it", () => {
    const s = () => useStore.getState();
    const id = s().createVariant("Cold day");
    expect(s().activeVariantId).toBe(id);
    expect(s().baseConfig.variants).toHaveLength(1);
    expect(s().baseConfig.variants![0].name).toBe("Cold day");
    // Seeded from an unmodified Base, so it starts with no patch at all.
    expect(s().baseConfig.variants![0].patch).toBeUndefined();
  });

  it("routes edits into the active variant, leaving the base untouched", () => {
    const s = () => useStore.getState();
    const id = s().createVariant("Cold day");
    s().updateNode("A", { temperature: 250 });

    // What you see is the variant.
    expect(s().config.nodes[0].temperature).toBe(250);
    // The file's base network still says 300.
    expect(s().baseConfig.nodes[0].temperature).toBe(300);
    // …and the difference is recorded as this variant's patch.
    expect(s().baseConfig.variants![0].patch).toEqual({
      nodes: { A: { temperature: 250 } },
    });

    // Switching back to Base shows the unmodified network again.
    s().setActiveVariant(null);
    expect(s().config.nodes[0].temperature).toBe(300);
    s().setActiveVariant(id);
    expect(s().config.nodes[0].temperature).toBe(250);
  });

  it("propagates base edits into variants that do not override them", () => {
    const s = () => useStore.getState();
    const id = s().createVariant("V");
    s().updateNode("A", { temperature: 250 });
    s().setActiveVariant(null);
    // Change something the variant does NOT patch.
    s().updateNode("B", { pressure: 5e4 });
    s().setActiveVariant(id);
    expect(s().config.nodes[1].pressure).toBe(5e4);
    expect(s().config.nodes[0].temperature).toBe(250);
  });

  it("writes variants into the .fn text so they travel with the model", () => {
    const s = () => useStore.getState();
    s().createVariant("Cold day");
    s().updateNode("A", { temperature: 250 });
    expect(s().modelText).toContain("variants: ");
    expect(s().modelText).toContain('"Cold day"');
    // The base node line is unchanged — only the patch carries 250.
    const nodeLine = s()
      .modelText.split("\n")
      .find((l) => l.startsWith('node "A"'))!;
    expect(nodeLine).toContain('"temperature":300');
  });

  it("undo restores both the file and the active variant", () => {
    const s = () => useStore.getState();
    const id = s().createVariant("V");
    s().updateNode("A", { temperature: 250 });
    s().undo();
    expect(s().config.nodes[0].temperature).toBe(300);
    expect(s().activeVariantId).toBe(id);
    s().undo();
    expect(s().baseConfig.variants).toBeUndefined();
    expect(s().activeVariantId).toBeNull();
  });

  it("adding a variant does not stale another variant's results", () => {
    const s = () => useStore.getState();
    s().pushRunRecord({ result: steady(2e5), config: s().config });
    expect(s().resultStale).toBe(false);
    s().createVariant("V");
    // Switching variants clears the displayed result rather than staling it.
    expect(s().result).toBeNull();
    s().setActiveVariant(null);
    s().selectRun(s().runHistory[0].id);
    expect(s().resultStale).toBe(false);
  });

  it("stamps runs with their variant and keeps the cap per variant", () => {
    const s = () => useStore.getState();
    s().pushRunRecord({ result: steady(2e5), config: s().config });
    const id = s().createVariant("V");
    s().pushRunRecord({ result: steady(3e5), config: s().config });

    expect(s().runHistory.map((r) => r.variantId)).toEqual([null, id]);

    // Fill this variant past the cap; the Base run must survive.
    for (let i = 0; i < RUN_HISTORY_CAP + 2; i++)
      s().pushRunRecord({ result: steady(1e5 + i), config: s().config });
    const own = s().runHistory.filter((r) => r.variantId === id);
    expect(own).toHaveLength(RUN_HISTORY_CAP);
    expect(s().runHistory.some((r) => r.variantId === null)).toBe(true);
  });

  it("deleting a variant removes its runs and falls back to Base", () => {
    const s = () => useStore.getState();
    const id = s().createVariant("V");
    s().pushRunRecord({ result: steady(3e5), config: s().config });
    expect(s().runHistory).toHaveLength(1);

    s().deleteVariant(id);
    expect(s().activeVariantId).toBeNull();
    expect(s().baseConfig.variants).toBeUndefined();
    expect(s().runHistory).toHaveLength(0);
  });

  it("renames and duplicates variants", () => {
    const s = () => useStore.getState();
    const id = s().createVariant("V");
    s().renameVariant(id, "Renamed");
    expect(s().baseConfig.variants![0].name).toBe("Renamed");

    s().updateNode("A", { temperature: 250 });
    const copy = s().duplicateVariant(id);
    expect(s().baseConfig.variants).toHaveLength(2);
    expect(s().activeVariantId).toBe(copy);
    expect(s().config.nodes[0].temperature).toBe(250);
    // The copy is independent: editing it leaves the original alone.
    s().updateNode("A", { temperature: 200 });
    s().setActiveVariant(id);
    expect(s().config.nodes[0].temperature).toBe(250);
  });

  it("clears runs and variants when a different model is loaded", () => {
    const s = () => useStore.getState();
    s().createVariant("V");
    s().pushRunRecord({ result: steady(2e5), config: s().config });

    s().setConfig(cfg("Other model"));
    expect(s().runHistory).toEqual([]);
    expect(s().selectedRunId).toBeNull();
    expect(s().activeVariantId).toBeNull();
    expect(s().config.meta.name).toBe("Other model");
  });
});

describe("reorderEntity", () => {
  beforeEach(resetStore);

  it("moves an element within its array and is undoable", () => {
    const s = () => useStore.getState();
    expect(s().config.nodes.map((n) => n.id)).toEqual(["A", "B"]);

    s().reorderEntity("node", 0, 1);
    expect(s().config.nodes.map((n) => n.id)).toEqual(["B", "A"]);

    s().undo();
    expect(s().config.nodes.map((n) => n.id)).toEqual(["A", "B"]);
  });

  it("marks the file dirty but never stales results", () => {
    const s = () => useStore.getState();
    // A run whose config is the current one: reordering must not unpin it.
    const before = configHash(s().config);
    s().pushRunRecord({ result: steady(2e5), config: s().config });
    expect(s().resultStale).toBe(false);

    s().reorderEntity("node", 0, 1);
    expect(s().dirty).toBe(true);
    expect(s().resultStale).toBe(false);
    // Same model, different listing order → same provenance identity.
    expect(configHash(s().config)).toBe(before);
  });

  it("round-trips through the .fn text projection in the new order", () => {
    const s = () => useStore.getState();
    s().reorderEntity("node", 0, 1);
    const lines = s()
      .modelText.split("\n")
      .filter((l) => l.startsWith("node "));
    expect(lines[0]).toContain('"B"');
    expect(lines[1]).toContain('"A"');
  });

  it("ignores out-of-range and no-op moves", () => {
    const s = () => useStore.getState();
    const historyBefore = s().past.length;
    s().reorderEntity("node", 0, 0);
    s().reorderEntity("node", 0, 5);
    s().reorderEntity("node", -1, 1);
    s().reorderEntity("conductor", 0, 1); // no conductors on this model
    expect(s().config.nodes.map((n) => n.id)).toEqual(["A", "B"]);
    expect(s().past.length).toBe(historyBefore);
  });
});
