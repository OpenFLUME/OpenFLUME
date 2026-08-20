/**
 * Stage 4 store tests: the text projection as a derived cache of the
 * canonical config.
 *
 * Invariants under test:
 *  - modelText === serializeText(config) at rest, initially and after every
 *    representative non-text mutation path (node edit, undo/redo, example
 *    load, direct setConfig, newNetwork);
 *  - a valid text edit wholesale-replaces config as exactly ONE history
 *    entry; undo/redo regenerate matching canonical text;
 *  - an invalid draft never touches config/history, is retained, and exposes
 *    parse diagnostics; revertModelText discards it;
 *  - selection (and open group tabs) survive wholesale replacement when the
 *    referenced entity still exists and are cleared when it vanishes.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { useStore } from "../store";
import { serializeText } from "../../substrate/textProjection";
import { uploadModelFile } from "../utils";
import type { NetworkConfig } from "../types";

/** Two-boundary-node, two-parallel-pipe config (valid when both branches exist). */
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
    {
      id: "b2",
      from: "A",
      to: "B",
      component: { type: "pipe", length: 2, diameter: 0.03, roughness: 1e-5 },
    },
  ],
});

function resetStore(config: NetworkConfig = cfg("Test")) {
  const text = serializeText(config);
  useStore.setState({
    config,
    selection: { kind: "none" },
    result: null,
    resultConfig: null,
    validationErrors: [],
    openGroupTabs: [],
    activeGroupTab: null,
    past: [],
    future: [],
    dirty: false,
    resultStale: false,
    preparingOperation: null,
    modelText: text,
    textDraft: text,
    textDiagnostics: [],
  });
}

const s = () => useStore.getState();

describe("model text projection (derived cache)", () => {
  beforeEach(() => resetStore());

  it("initializes modelText/textDraft from the config and keeps them in sync across non-text edits", () => {
    expect(s().modelText).toBe(serializeText(s().config));
    expect(s().textDraft).toBe(s().modelText);
    expect(s().textDiagnostics).toEqual([]);

    const before = s().modelText;
    s().updateNode("A", { pressure: 150000 });
    expect(s().modelText).toBe(serializeText(s().config));
    expect(s().modelText).not.toBe(before);
    expect(s().modelText).toContain("150000");
    expect(s().textDraft).toBe(s().modelText);
    expect(s().textDiagnostics).toEqual([]);

    s().updateMeta({ name: "Renamed" });
    expect(s().modelText).toBe(serializeText(s().config));
    expect(s().modelText).toContain('network "Renamed" {');
  });

  it("a valid text edit wholesale-replaces config as exactly one history entry", () => {
    const edited = s().modelText.replace(
      '"pressure":200000',
      '"pressure":123456',
    );
    expect(edited).not.toBe(s().modelText);

    const applied = s().setModelText(edited);
    expect(applied).toBe(true);
    expect(s().config.nodes[0].pressure).toBe(123456);
    expect(s().past).toHaveLength(1);
    expect(s().dirty).toBe(true);
    expect(s().resultStale).toBe(true);
    // Canonical text is reserialized from the parsed config.
    expect(s().modelText).toBe(serializeText(s().config));
    expect(s().textDraft).toBe(s().modelText);
    expect(s().textDiagnostics).toEqual([]);
  });

  it("undo/redo around a text edit restore config and regenerate matching text", () => {
    const originalText = s().modelText;
    const edited = originalText.replace(
      '"pressure":200000',
      '"pressure":123456',
    );
    s().setModelText(edited);
    expect(s().config.nodes[0].pressure).toBe(123456);

    s().undo();
    expect(s().config.nodes[0].pressure).toBe(2e5);
    expect(s().modelText).toBe(originalText);
    expect(s().modelText).toBe(serializeText(s().config));
    expect(s().textDraft).toBe(s().modelText);
    expect(s().textDiagnostics).toEqual([]);

    s().redo();
    expect(s().config.nodes[0].pressure).toBe(123456);
    expect(s().modelText).toBe(serializeText(s().config));
    expect(s().modelText).toContain("123456");
    expect(s().textDraft).toBe(s().modelText);
  });

  it("a text edit can add an entity; undo removes it; redo re-applies it", () => {
    const withNode = s().modelText.replace(
      'branch "b1"',
      'node "C" boundary @ (500, 100, null) data: {"pressure":100000,"temperature":300}\nbranch "b1"',
    );
    expect(s().setModelText(withNode)).toBe(true);
    expect(s().config.nodes.map((n) => n.id)).toEqual(["A", "B", "C"]);
    expect(s().past).toHaveLength(1);
    s().undo();
    expect(s().config.nodes.map((n) => n.id)).toEqual(["A", "B"]);
    expect(s().modelText).toBe(serializeText(s().config));
    s().redo();
    expect(s().config.nodes.map((n) => n.id)).toEqual(["A", "B", "C"]);
  });

  it("a formatting-only text edit is a no-op for config and history", () => {
    const padded = s().modelText.replace(
      'node "A" boundary',
      'node   "A"    boundary',
    );
    const configBefore = s().config;
    expect(s().setModelText(padded)).toBe(true);
    expect(s().config).toBe(configBefore); // untouched, not even replaced
    expect(s().past).toHaveLength(0);
    // Draft collapses back to the canonical form; no pending diagnostics.
    expect(s().textDraft).toBe(s().modelText);
    expect(s().textDiagnostics).toEqual([]);
  });

  it("an invalid draft never touches config/history, is retained, and exposes diagnostics", () => {
    const configBefore = s().config;
    const applied = s().setModelText("this is not a model");
    expect(applied).toBe(false);
    expect(s().config).toBe(configBefore);
    expect(s().past).toHaveLength(0);
    expect(s().modelText).toBe(serializeText(configBefore));
    expect(s().textDraft).toBe("this is not a model");
    expect(s().textDiagnostics.length).toBeGreaterThan(0);
    expect(s().textDiagnostics[0].severity).toBe("error");
    expect(s().textDiagnostics[0].message).toMatch(/header/);
  });

  it("semantic (validation) failures also leave config/history untouched and are reported with lines", () => {
    // Structurally fine, but branch b1's "to" endpoint dangles.
    const dangling = s().modelText.replace(
      'branch "b1": "A" -> "B"',
      'branch "b1": "A" -> "ZZ"',
    );
    expect(dangling).not.toBe(s().modelText);
    const configBefore = s().config;
    expect(s().setModelText(dangling)).toBe(false);
    expect(s().config).toBe(configBefore);
    expect(s().past).toHaveLength(0);
    expect(s().textDraft).toBe(dangling);
    expect(s().textDiagnostics.length).toBeGreaterThan(0);
    const hit = s().textDiagnostics.find((e) =>
      /references missing node/.test(e.message),
    );
    expect(hit).toBeDefined();
    // Dangling references are attributed to the referencing entity's line.
    expect(hit!.line).toBeGreaterThan(0);
  });

  it("revertModelText discards the invalid draft and clears diagnostics", () => {
    s().setModelText("garbage");
    expect(s().textDiagnostics.length).toBeGreaterThan(0);
    s().revertModelText();
    expect(s().textDraft).toBe(s().modelText);
    expect(s().textDraft).toBe(serializeText(s().config));
    expect(s().textDiagnostics).toEqual([]);
  });

  it("a subsequent non-text edit reserializes and drops a stale invalid draft", () => {
    s().setModelText("garbage");
    expect(s().textDraft).toBe("garbage");
    s().updateNode("A", { pressure: 111111 });
    expect(s().modelText).toBe(serializeText(s().config));
    expect(s().textDraft).toBe(s().modelText);
    expect(s().textDiagnostics).toEqual([]);
  });

  it("undo/redo drop a stale invalid draft as well", () => {
    s().updateNode("A", { pressure: 150000 });
    s().setModelText("garbage");
    s().undo();
    expect(s().textDraft).toBe(s().modelText);
    expect(s().textDiagnostics).toEqual([]);
    s().redo();
    expect(s().textDraft).toBe(s().modelText);
    expect(s().textDiagnostics).toEqual([]);
  });

  it("selection survives a wholesale text replacement that keeps the entity", () => {
    s().setSelection({ kind: "branch", id: "b1" });
    const edited = s().modelText.replace(
      '"pressure":200000',
      '"pressure":123456',
    );
    expect(s().setModelText(edited)).toBe(true);
    expect(s().selection).toEqual({ kind: "branch", id: "b1" });
  });

  it("selection is cleared when a wholesale text replacement removes the entity", () => {
    s().setSelection({ kind: "branch", id: "b2" });
    const withoutB2 = s()
      .modelText.split("\n")
      .filter((line) => !line.startsWith('branch "b2"'))
      .join("\n");
    expect(s().setModelText(withoutB2)).toBe(true);
    expect(s().config.branches.map((b) => b.id)).toEqual(["b1"]);
    expect(s().selection).toEqual({ kind: "none" });
  });

  it("open group tabs are reconciled when a text edit removes the group", () => {
    const withGroup = cfg("Grouped");
    withGroup.groups = [{ id: "g1", label: "Group 1", x: 0, y: 0 }];
    withGroup.nodes[0].group = "g1";
    resetStore(withGroup);
    useStore.setState({ openGroupTabs: ["g1"], activeGroupTab: "g1" });

    // Text without the group record and without the node's group reference.
    const text = s()
      .modelText.split("\n")
      .filter((line) => !line.startsWith('group "g1"'))
      .join("\n")
      .replace(',"group":"g1"', "");
    expect(s().setModelText(text)).toBe(true);
    expect(s().config.groups).toBeUndefined();
    expect(s().openGroupTabs).toEqual([]);
    expect(s().activeGroupTab).toBeNull();
  });

  it("loadExample refreshes the canonical text and clears stale draft state", () => {
    s().setModelText("garbage");
    s().loadExample("Three-pipe junction");
    expect(s().config.meta.name).toBe("Three-pipe junction");
    expect(s().modelText).toBe(serializeText(s().config));
    expect(s().textDraft).toBe(s().modelText);
    expect(s().textDiagnostics).toEqual([]);
    // The refreshed text itself parses back cleanly.
    expect(s().modelText).toContain('network "Three-pipe junction" {');
  });

  it("newNetwork refreshes the canonical text", () => {
    s().updateNode("A", { pressure: 150000 });
    s().newNetwork();
    expect(s().config.meta.name).toBe("Untitled network");
    expect(s().modelText).toBe(serializeText(s().config));
    expect(s().textDraft).toBe(s().modelText);
    expect(s().textDiagnostics).toEqual([]);
  });

  it("a direct setConfig refreshes the canonical text", () => {
    const external: NetworkConfig = {
      meta: { name: "external", version: 2 },
      settings: { mode: "steady", tolerance: 1e-6, maxIterations: 100 },
      fluid: { model: "incompressible", preset: "water" },
      nodes: [
        {
          id: "x",
          type: "boundary",
          x: 0,
          y: 0,
          pressure: 1e5,
          temperature: 300,
        },
      ],
      branches: [],
    };
    s().setModelText("garbage");
    s().setConfig(external);
    expect(s().modelText).toBe(serializeText(s().config));
    expect(s().modelText).toContain('network "external" {');
    expect(s().textDraft).toBe(s().modelText);
    expect(s().textDiagnostics).toEqual([]);
  });

  it("an example load round-trips through its own model text without drift", () => {
    s().loadExample("Tank blowdown");
    // Applying the canonical text is a formatting-only no-op: no history.
    const pastLen = s().past.length;
    expect(s().setModelText(s().modelText)).toBe(true);
    expect(s().past).toHaveLength(pastLen);
    expect(s().config.meta.name).toBe("Tank blowdown");
  });
});

describe("model file load atomicity (store level)", () => {
  beforeEach(() => resetStore());

  it("a failing .fn upload never replaces the current config", async () => {
    const before = s().config;
    await expect(
      uploadModelFile(new File(["total garbage"], "broken.fn")),
    ).rejects.toThrow(/invalid model file/);
    // The Toolbar catch-path never calls setConfig on failure.
    expect(s().config).toBe(before);
    expect(s().modelText).toBe(serializeText(before));
    expect(s().past).toHaveLength(0);
  });

  it("a successful .fn upload feeds setConfig and refreshes text", async () => {
    const target = cfg("From file");
    const file = new File([serializeText(target)], "from-file.fn");
    const loaded = await uploadModelFile(file);
    s().setConfig(loaded);
    expect(s().config.meta.name).toBe("From file");
    expect(s().modelText).toBe(serializeText(s().config));
    expect(s().config.nodes.map((n) => n.id)).toEqual(["A", "B"]);
    // One history entry for the load.
    expect(s().past).toHaveLength(1);
  });
});
