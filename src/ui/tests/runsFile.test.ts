/**
 * runsFile.ts and the discard paths that must reach it.
 *
 * The sidecar is mirrored into localStorage on every change to run history,
 * which makes discarding a two-part operation: the store state AND the mirror.
 * Miss the mirror and a reload resurrects a run the user deleted, which is the
 * regression these tests exist to prevent.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { useStore } from "../store";
import {
  isRunsFileText,
  loadRunsFromLocalStorage,
  parseRunsFile,
  RunsFileParseError,
  runsFileName,
  saveRunsToLocalStorage,
  serializeRunsFile,
} from "../runsFile";
import type { NetworkConfig, SteadyResult } from "../types";

const cfg = (name: string): NetworkConfig => ({
  meta: { name, version: 2 },
  settings: { mode: "steady", tolerance: 1e-6, maxIterations: 100 },
  fluid: { model: "incompressible", preset: "water" },
  nodes: [
    { id: "A", type: "boundary", x: 0, y: 0, pressure: 2e5, temperature: 300 },
    {
      id: "B",
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
      from: "A",
      to: "B",
      component: { type: "pipe", length: 1, diameter: 0.02, roughness: 1e-5 },
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

/** In-memory localStorage: the store's mirror calls read it at call time. */
function stubStorage(): Map<string, string> {
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
    },
    configurable: true,
    writable: true,
  });
  return store;
}

function resetStore() {
  useStore.setState({
    config: cfg("Test"),
    baseConfig: cfg("Test"),
    activeVariantId: null,
    result: null,
    resultConfig: null,
    resultDiary: null,
    runHistory: [],
    runSeq: 0,
    selectedRunId: null,
    baselineRunId: null,
    resultStale: false,
    past: [],
    future: [],
  });
}

describe("runs sidecar format", () => {
  it("names the file after the model", () => {
    expect(runsFileName(cfg("Tank blowdown"))).toBe("Tank_blowdown.runs.json");
  });

  it("round-trips through serialize/parse and is recognizable", () => {
    const base = cfg("Test");
    useStore.setState({ config: base, baseConfig: base, runHistory: [] });
    useStore.getState().pushRunRecord({ result: steady(2e5), config: base });
    const runs = useStore.getState().runHistory;

    const text = serializeRunsFile(base, runs);
    expect(isRunsFileText(text)).toBe(true);
    const parsed = parseRunsFile(text);
    expect(parsed.modelName).toBe("Test");
    expect(parsed.runs).toHaveLength(1);
    expect(parsed.runs[0].id).toBe(runs[0].id);
  });

  it("rejects other files rather than mistaking them for results", () => {
    expect(isRunsFileText('network "x"')).toBe(false);
    expect(isRunsFileText('{"format":"something/else"}')).toBe(false);
    expect(() => parseRunsFile("not json")).toThrow(RunsFileParseError);
    expect(() => parseRunsFile('{"format":"openflume.runs/1"}')).toThrow(
      RunsFileParseError,
    );
  });

  it("only reattaches the mirror to the model that produced it", () => {
    stubStorage();
    const base = cfg("Test");
    useStore.setState({ config: base, baseConfig: base, runHistory: [] });
    useStore.getState().pushRunRecord({ result: steady(2e5), config: base });

    saveRunsToLocalStorage(base, useStore.getState().runHistory);
    expect(loadRunsFromLocalStorage(base)).toHaveLength(1);
    expect(loadRunsFromLocalStorage(cfg("Other model"))).toEqual([]);
  });
});

describe("discarding results", () => {
  let storage: Map<string, string>;

  beforeEach(() => {
    storage = stubStorage();
    resetStore();
  });

  afterEach(() => {
    storage.clear();
  });

  it("discardRuns drops every run, the displayed result, and the mirror", () => {
    const s = () => useStore.getState();
    s().pushRunRecord({ result: steady(2e5), config: s().config });
    s().pushRunRecord({ result: steady(1.9e5), config: s().config });
    s().setBaselineRunId(s().runHistory[0].id);
    expect(s().runHistory).toHaveLength(2);
    expect(loadRunsFromLocalStorage(s().baseConfig)).toHaveLength(2);

    s().discardRuns();

    expect(s().runHistory).toEqual([]);
    expect(s().selectedRunId).toBeNull();
    expect(s().baselineRunId).toBeNull();
    // The displayed result goes with the records that backed it.
    expect(s().result).toBeNull();
    expect(s().resultConfig).toBeNull();
    expect(s().resultStale).toBe(false);
    // And a reload finds nothing to restore.
    expect(loadRunsFromLocalStorage(s().baseConfig)).toEqual([]);
  });

  it("discardRuns leaves the model alone", () => {
    const s = () => useStore.getState();
    s().pushRunRecord({ result: steady(2e5), config: s().config });
    const before = s().modelText;

    s().discardRuns();

    expect(s().config.nodes).toHaveLength(2);
    expect(s().modelText).toBe(before);
  });

  it("deleteRun removes one run from the mirror as well as the state", () => {
    const s = () => useStore.getState();
    s().pushRunRecord({ result: steady(2e5), config: s().config });
    s().pushRunRecord({ result: steady(1.9e5), config: s().config });
    const keep = s().runHistory[0].id;
    const drop = s().runHistory[1].id;

    s().deleteRun(drop);

    expect(s().runHistory.map((r) => r.id)).toEqual([keep]);
    // Without the mirror write, a reload would bring the deleted run back.
    expect(loadRunsFromLocalStorage(s().baseConfig).map((r) => r.id)).toEqual([
      keep,
    ]);
  });

  it("deleting the last run clears the mirror rather than storing an empty file", () => {
    const s = () => useStore.getState();
    s().pushRunRecord({ result: steady(2e5), config: s().config });

    s().deleteRun(s().runHistory[0].id);

    expect(s().runHistory).toEqual([]);
    expect(loadRunsFromLocalStorage(s().baseConfig)).toEqual([]);
    expect([...storage.keys()]).not.toContain("fluids-network-runs-v1");
  });

  it("renameRun survives a reload", () => {
    const s = () => useStore.getState();
    s().pushRunRecord({ result: steady(2e5), config: s().config });
    s().renameRun(s().runHistory[0].id, "Baseline case");

    expect(loadRunsFromLocalStorage(s().baseConfig)[0].name).toBe(
      "Baseline case",
    );
  });
});
