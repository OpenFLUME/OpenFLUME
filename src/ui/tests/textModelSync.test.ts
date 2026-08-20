/**
 * Stage 5 tests for the text-model selection-sync helpers
 * (src/ui/textModelSync.ts) — the pure, DOM-free policy consumed by
 * TextModelView.
 *
 * Coverage:
 *  - line/offset math: lineStartOffsets / lineForOffset / offsetForLine /
 *    lineEndOffset, including empty text, trailing newlines, newline-char
 *    ownership, and clamping of out-of-range inputs;
 *  - entity key mapping both ways (lineMapKeyForSelection /
 *    selectionForLineMapKey) for node / branch / solidNode⇔`solid:` /
 *    conductor / group, plus unknown/malformed keys and the 'none'
 *    selection;
 *  - entityAtLine on a real serialized fixture (entity record lines resolve,
 *    chrome lines — header, network line, singleton fields, closing brace,
 *    trailing empty line — do not) and on synthetic multi-line ranges
 *    (inclusive start/end boundaries);
 *  - store→text reveal policy (revealTargetForSelection): ranges for every
 *    entity kind; suppression when non-canonical/dirty, when the selection
 *    is 'none' or unknown to the map, and when the selection is the echo of
 *    our own caret update (echo-loop prevention);
 *  - text→store policy (selectionForCaretLine): entity resolution per kind;
 *    suppression when non-canonical, on chrome lines, and when the entity is
 *    already the current selection (no redundant store churn).
 */

import { describe, it, expect } from "vitest";
import {
  serializeTextWithLineMap,
  type LineMap,
} from "../../substrate/textProjection";
import type { NetworkConfig, Selection } from "../types";
import {
  TEXT_LINE_HEIGHT,
  entityAtLine,
  lineEndOffset,
  lineForOffset,
  lineMapKeyForSelection,
  lineStartOffsets,
  offsetForLine,
  revealTargetForSelection,
  sameSelection,
  selectionForCaretLine,
  selectionForLineMapKey,
} from "../textModelSync";

/* ------------------------------------------------------------------ */
/* Fixture: one entity of every selectable kind                        */
/* ------------------------------------------------------------------ */

/**
 * Canonical text layout (verified against the serializer):
 *   1  header
 *   2  network line
 *   3  settings field
 *   4  fluid field
 *   5  node "n1"
 *   6  node "n2"
 *   7  solid "s1"
 *   8  branch "b1"
 *   9  conductor "c1"
 *  10  group "g1"
 *  11  closing brace
 *  12  trailing empty line (text ends with '\n')
 */
function fixtureConfig(): NetworkConfig {
  return {
    meta: { name: "sync-fixture", version: 2 },
    settings: { mode: "steady", tolerance: 1e-6, maxIterations: 100 },
    fluid: { model: "incompressible", preset: "water" },
    nodes: [
      {
        id: "n1",
        type: "boundary",
        x: 0,
        y: 0,
        pressure: 200_000,
        temperature: 300,
      },
      {
        id: "n2",
        type: "internal",
        x: 100,
        y: 0,
        pressure: 150_000,
        temperature: 300,
        volume: 0.01,
        group: "g1",
      },
    ],
    solidNodes: [
      {
        id: "s1",
        type: "solid",
        x: 0,
        y: 100,
        temperature: 300,
        mass: 1,
        cp: 500,
      },
    ],
    branches: [
      {
        id: "b1",
        from: "n1",
        to: "n2",
        component: { type: "pipe", length: 1, diameter: 0.05, roughness: 1e-5 },
      },
    ],
    conductors: [
      {
        id: "c1",
        from: "s1",
        to: "n2",
        type: { kind: "convection", h: 1000, area: 0.1 },
      },
    ],
    groups: [{ id: "g1", label: "Sub 1", x: 50, y: 50 }],
  };
}

function fixture() {
  const { text, lineMap } = serializeTextWithLineMap(fixtureConfig());
  return { text, lineMap, lines: text.split("\n") };
}

/* ------------------------------------------------------------------ */
/* Line/offset math                                                    */
/* ------------------------------------------------------------------ */

describe("line/offset math", () => {
  it("TEXT_LINE_HEIGHT is a positive px constant shared by style and scroll math", () => {
    expect(TEXT_LINE_HEIGHT).toBeGreaterThan(0);
  });

  it("lineStartOffsets: empty text and newline handling", () => {
    expect(lineStartOffsets("")).toEqual([0]);
    expect(lineStartOffsets("abc")).toEqual([0]);
    expect(lineStartOffsets("ab\ncd")).toEqual([0, 3]);
    // A trailing newline starts a new (empty) line.
    expect(lineStartOffsets("ab\ncd\n")).toEqual([0, 3, 6]);
    expect(lineStartOffsets("\n\n")).toEqual([0, 1, 2]);
  });

  it("lineForOffset: 1-based line containing the offset", () => {
    const offsets = lineStartOffsets("ab\ncd\nef");
    expect(lineForOffset(offsets, 0)).toBe(1);
    expect(lineForOffset(offsets, 1)).toBe(1);
    // The newline character itself belongs to the line it terminates.
    expect(lineForOffset(offsets, 2)).toBe(1);
    // First character after the newline starts the next line.
    expect(lineForOffset(offsets, 3)).toBe(2);
    expect(lineForOffset(offsets, 6)).toBe(3);
    expect(lineForOffset(offsets, 7)).toBe(3);
  });

  it("lineForOffset: clamps out-of-range offsets", () => {
    const offsets = lineStartOffsets("ab\ncd");
    expect(lineForOffset(offsets, -10)).toBe(1);
    expect(lineForOffset(offsets, 10_000)).toBe(2);
    expect(lineForOffset(lineStartOffsets(""), 5)).toBe(1);
  });

  it("offsetForLine: first char of the 1-based line, clamped", () => {
    const offsets = lineStartOffsets("ab\ncd\nef");
    expect(offsetForLine(offsets, 1)).toBe(0);
    expect(offsetForLine(offsets, 2)).toBe(3);
    expect(offsetForLine(offsets, 3)).toBe(6);
    // Clamping: line 0 / negative → line 1; beyond the end → last line.
    expect(offsetForLine(offsets, 0)).toBe(0);
    expect(offsetForLine(offsets, -4)).toBe(0);
    expect(offsetForLine(offsets, 99)).toBe(6);
  });

  it("lineEndOffset: exclusive end, newline excluded, last line runs to text end", () => {
    const text = "ab\ncd\nef";
    const offsets = lineStartOffsets(text);
    expect(
      text.slice(offsetForLine(offsets, 1), lineEndOffset(text, offsets, 1)),
    ).toBe("ab");
    expect(
      text.slice(offsetForLine(offsets, 2), lineEndOffset(text, offsets, 2)),
    ).toBe("cd");
    expect(
      text.slice(offsetForLine(offsets, 3), lineEndOffset(text, offsets, 3)),
    ).toBe("ef");
    expect(lineEndOffset(text, offsets, 3)).toBe(text.length);
  });

  it("lineEndOffset: trailing newline yields an empty final line; clamps like offsetForLine", () => {
    const text = "ab\ncd\n";
    const offsets = lineStartOffsets(text); // [0, 3, 6]
    expect(lineEndOffset(text, offsets, 3)).toBe(6); // empty trailing line
    expect(lineEndOffset(text, offsets, 0)).toBe(
      lineEndOffset(text, offsets, 1),
    );
    expect(lineEndOffset(text, offsets, 99)).toBe(6); // clamped to last line
    expect(lineEndOffset("", [0], 1)).toBe(0);
  });

  it("round-trips against the real serialized fixture: every entity line resolves to its own offset range", () => {
    const { text, lineMap, lines } = fixture();
    const offsets = lineStartOffsets(text);
    for (const [key, range] of lineMap) {
      const start = offsetForLine(offsets, range.startLine);
      expect(lineForOffset(offsets, start)).toBe(range.startLine);
      // Every serialized record is a single line.
      expect(range.endLine).toBe(range.startLine);
      // The mapped line really is the entity's record line.
      expect(
        lines[range.startLine - 1].startsWith(key.split(":")[0] + " "),
      ).toBe(true);
    }
  });
});

/* ------------------------------------------------------------------ */
/* Selection ⇔ LineMap key mapping                                     */
/* ------------------------------------------------------------------ */

describe("selection ⇔ lineMap key mapping", () => {
  it("lineMapKeyForSelection maps every entity kind; solidNode uses the solid: prefix", () => {
    expect(lineMapKeyForSelection({ kind: "node", id: "n1" })).toBe("node:n1");
    expect(lineMapKeyForSelection({ kind: "branch", id: "b1" })).toBe(
      "branch:b1",
    );
    expect(lineMapKeyForSelection({ kind: "solidNode", id: "s1" })).toBe(
      "solid:s1",
    );
    expect(lineMapKeyForSelection({ kind: "conductor", id: "c1" })).toBe(
      "conductor:c1",
    );
    expect(lineMapKeyForSelection({ kind: "group", id: "g1" })).toBe(
      "group:g1",
    );
    expect(lineMapKeyForSelection({ kind: "none" })).toBeNull();
  });

  it("selectionForLineMapKey inverts the mapping for every kind", () => {
    expect(selectionForLineMapKey("node:n1")).toEqual({
      kind: "node",
      id: "n1",
    });
    expect(selectionForLineMapKey("branch:b1")).toEqual({
      kind: "branch",
      id: "b1",
    });
    expect(selectionForLineMapKey("solid:s1")).toEqual({
      kind: "solidNode",
      id: "s1",
    });
    expect(selectionForLineMapKey("conductor:c1")).toEqual({
      kind: "conductor",
      id: "c1",
    });
    expect(selectionForLineMapKey("group:g1")).toEqual({
      kind: "group",
      id: "g1",
    });
  });

  it("selectionForLineMapKey round-trips lineMapKeyForSelection for all entity kinds", () => {
    const selections: Selection[] = [
      { kind: "node", id: "x" },
      { kind: "branch", id: "y" },
      { kind: "solidNode", id: "z" },
      { kind: "conductor", id: "w" },
      { kind: "group", id: "g" },
    ];
    for (const sel of selections) {
      expect(selectionForLineMapKey(lineMapKeyForSelection(sel)!)).toEqual(sel);
    }
  });

  it("selectionForLineMapKey rejects unknown prefixes and malformed keys", () => {
    expect(selectionForLineMapKey("entity:n1")).toBeNull();
    expect(selectionForLineMapKey("nodes:n1")).toBeNull();
    expect(selectionForLineMapKey("nocolon")).toBeNull();
    expect(selectionForLineMapKey(":noPrefix")).toBeNull();
    expect(selectionForLineMapKey("")).toBeNull();
    // Ids may themselves contain colons: split happens at the FIRST colon.
    expect(selectionForLineMapKey("node:a:b")).toEqual({
      kind: "node",
      id: "a:b",
    });
  });

  it("sameSelection compares kind + id, with none matching none", () => {
    expect(sameSelection({ kind: "none" }, { kind: "none" })).toBe(true);
    expect(
      sameSelection({ kind: "node", id: "a" }, { kind: "node", id: "a" }),
    ).toBe(true);
    expect(
      sameSelection({ kind: "node", id: "a" }, { kind: "node", id: "b" }),
    ).toBe(false);
    expect(
      sameSelection({ kind: "node", id: "a" }, { kind: "branch", id: "a" }),
    ).toBe(false);
    // The LineMap prefix asymmetry (solidNode ⇔ solid:) must not leak here.
    expect(
      sameSelection(
        { kind: "solidNode", id: "s1" },
        { kind: "node", id: "s1" },
      ),
    ).toBe(false);
    expect(sameSelection({ kind: "none" }, { kind: "node", id: "a" })).toBe(
      false,
    );
  });
});

/* ------------------------------------------------------------------ */
/* entityAtLine                                                        */
/* ------------------------------------------------------------------ */

describe("entityAtLine", () => {
  it("resolves every entity record line of the serialized fixture", () => {
    const { lineMap } = fixture();
    expect(entityAtLine(lineMap, 5)).toEqual({ kind: "node", id: "n1" });
    expect(entityAtLine(lineMap, 6)).toEqual({ kind: "node", id: "n2" });
    expect(entityAtLine(lineMap, 7)).toEqual({ kind: "solidNode", id: "s1" });
    expect(entityAtLine(lineMap, 8)).toEqual({ kind: "branch", id: "b1" });
    expect(entityAtLine(lineMap, 9)).toEqual({ kind: "conductor", id: "c1" });
    expect(entityAtLine(lineMap, 10)).toEqual({ kind: "group", id: "g1" });
  });

  it("returns null on chrome lines (header, network, fields, brace, trailing empty line)", () => {
    const { lineMap } = fixture();
    for (const chromeLine of [1, 2, 3, 4, 11, 12]) {
      expect(
        entityAtLine(lineMap, chromeLine),
        `line ${chromeLine} should be chrome`,
      ).toBeNull();
    }
    expect(entityAtLine(lineMap, 0)).toBeNull();
    expect(entityAtLine(lineMap, 999)).toBeNull();
  });

  it("treats range boundaries as inclusive (synthetic multi-line ranges)", () => {
    const multi: LineMap = new Map([
      ["node:a", { startLine: 3, endLine: 5 }],
      ["branch:b", { startLine: 7, endLine: 9 }],
    ]);
    expect(entityAtLine(multi, 2)).toBeNull();
    expect(entityAtLine(multi, 3)).toEqual({ kind: "node", id: "a" });
    expect(entityAtLine(multi, 4)).toEqual({ kind: "node", id: "a" });
    expect(entityAtLine(multi, 5)).toEqual({ kind: "node", id: "a" });
    expect(entityAtLine(multi, 6)).toBeNull();
    expect(entityAtLine(multi, 7)).toEqual({ kind: "branch", id: "b" });
    expect(entityAtLine(multi, 9)).toEqual({ kind: "branch", id: "b" });
    expect(entityAtLine(multi, 10)).toBeNull();
  });

  it("returns null for an empty line map", () => {
    expect(entityAtLine(new Map(), 1)).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* Store → text reveal policy                                          */
/* ------------------------------------------------------------------ */

describe("revealTargetForSelection (store → text)", () => {
  it("returns the record range for every entity kind when canonical", () => {
    const { lineMap } = fixture();
    const opts = { canonical: true, caretEcho: null };
    expect(
      revealTargetForSelection({ kind: "node", id: "n2" }, lineMap, opts),
    ).toEqual({ startLine: 6, endLine: 6 });
    expect(
      revealTargetForSelection({ kind: "solidNode", id: "s1" }, lineMap, opts),
    ).toEqual({ startLine: 7, endLine: 7 });
    expect(
      revealTargetForSelection({ kind: "branch", id: "b1" }, lineMap, opts),
    ).toEqual({ startLine: 8, endLine: 8 });
    expect(
      revealTargetForSelection({ kind: "conductor", id: "c1" }, lineMap, opts),
    ).toEqual({ startLine: 9, endLine: 9 });
    expect(
      revealTargetForSelection({ kind: "group", id: "g1" }, lineMap, opts),
    ).toEqual({ startLine: 10, endLine: 10 });
  });

  it("is suppressed while the buffer is dirty / non-canonical", () => {
    const { lineMap } = fixture();
    expect(
      revealTargetForSelection({ kind: "node", id: "n1" }, lineMap, {
        canonical: false,
        caretEcho: null,
      }),
    ).toBeNull();
  });

  it("is suppressed for the empty selection and for entities absent from the map", () => {
    const { lineMap } = fixture();
    const opts = { canonical: true, caretEcho: null };
    expect(
      revealTargetForSelection({ kind: "none" }, lineMap, opts),
    ).toBeNull();
    expect(
      revealTargetForSelection({ kind: "node", id: "ghost" }, lineMap, opts),
    ).toBeNull();
    expect(
      revealTargetForSelection({ kind: "branch", id: "nope" }, lineMap, opts),
    ).toBeNull();
  });

  it("is suppressed for the echo of our own caret-driven selection (echo-loop prevention)", () => {
    const { lineMap } = fixture();
    const caret: Selection = { kind: "branch", id: "b1" };
    expect(
      revealTargetForSelection(caret, lineMap, {
        canonical: true,
        caretEcho: caret,
      }),
    ).toBeNull();
    // A DIFFERENT selection is not an echo and must reveal.
    expect(
      revealTargetForSelection({ kind: "branch", id: "b1" }, lineMap, {
        canonical: true,
        caretEcho: { kind: "node", id: "n1" },
      }),
    ).toEqual({ startLine: 8, endLine: 8 });
    // Same kind, different id: still not an echo.
    expect(
      revealTargetForSelection({ kind: "branch", id: "b1" }, lineMap, {
        canonical: true,
        caretEcho: { kind: "branch", id: "other" },
      }),
    ).toEqual({ startLine: 8, endLine: 8 });
  });

  it("echo suppression never overrides the dirty-buffer gate", () => {
    const { lineMap } = fixture();
    expect(
      revealTargetForSelection({ kind: "node", id: "n1" }, lineMap, {
        canonical: false,
        caretEcho: { kind: "none" },
      }),
    ).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* Text → store caret policy                                           */
/* ------------------------------------------------------------------ */

describe("selectionForCaretLine (text → store)", () => {
  it("maps the caret line to the entity for every kind when canonical", () => {
    const { lineMap } = fixture();
    const current: Selection = { kind: "none" };
    const opts = { canonical: true };
    expect(selectionForCaretLine(5, lineMap, current, opts)).toEqual({
      kind: "node",
      id: "n1",
    });
    expect(selectionForCaretLine(7, lineMap, current, opts)).toEqual({
      kind: "solidNode",
      id: "s1",
    });
    expect(selectionForCaretLine(8, lineMap, current, opts)).toEqual({
      kind: "branch",
      id: "b1",
    });
    expect(selectionForCaretLine(9, lineMap, current, opts)).toEqual({
      kind: "conductor",
      id: "c1",
    });
    expect(selectionForCaretLine(10, lineMap, current, opts)).toEqual({
      kind: "group",
      id: "g1",
    });
  });

  it("is suppressed while the buffer is dirty / non-canonical, even on an entity line", () => {
    const { lineMap } = fixture();
    expect(
      selectionForCaretLine(8, lineMap, { kind: "none" }, { canonical: false }),
    ).toBeNull();
  });

  it("leaves the store selection alone on chrome lines (no clearing)", () => {
    const { lineMap } = fixture();
    const current: Selection = { kind: "node", id: "n1" };
    for (const chromeLine of [1, 2, 3, 4, 11, 12]) {
      expect(
        selectionForCaretLine(chromeLine, lineMap, current, {
          canonical: true,
        }),
      ).toBeNull();
    }
  });

  it("returns null when the entity is already selected (no redundant store churn)", () => {
    const { lineMap } = fixture();
    expect(
      selectionForCaretLine(
        8,
        lineMap,
        { kind: "branch", id: "b1" },
        { canonical: true },
      ),
    ).toBeNull();
    // Same line, different current selection → the new entity is adopted.
    expect(
      selectionForCaretLine(
        8,
        lineMap,
        { kind: "node", id: "n1" },
        { canonical: true },
      ),
    ).toEqual({
      kind: "branch",
      id: "b1",
    });
  });
});

/* ------------------------------------------------------------------ */
/* End-to-end policy walk (pure): select → reveal → caret → reselect   */
/* ------------------------------------------------------------------ */

describe("selection-sync policy walk", () => {
  it("an external selection reveals; the echoed caret does not re-trigger the store", () => {
    const { lineMap } = fixture();
    const external: Selection = { kind: "conductor", id: "c1" };

    // 1. Diagram selects c1 → the view reveals line 9.
    const target = revealTargetForSelection(external, lineMap, {
      canonical: true,
      caretEcho: null,
    });
    expect(target).toEqual({ startLine: 9, endLine: 9 });

    // 2. The reveal placed the caret on line 9; the caret policy reports the
    //    same entity, but it is already the current selection → no store
    //    update (the two directions settle instead of oscillating).
    expect(
      selectionForCaretLine(9, lineMap, external, { canonical: true }),
    ).toBeNull();

    // 3. The store-selection effect then sees its own echo and stays put.
    expect(
      revealTargetForSelection(external, lineMap, {
        canonical: true,
        caretEcho: external,
      }),
    ).toBeNull();
  });

  it("a caret move to another entity adopts it exactly once", () => {
    const { lineMap } = fixture();
    const current: Selection = { kind: "conductor", id: "c1" };
    const next = selectionForCaretLine(6, lineMap, current, {
      canonical: true,
    });
    expect(next).toEqual({ kind: "node", id: "n2" });
    // After adoption the same caret position is a no-op.
    expect(
      selectionForCaretLine(6, lineMap, next!, { canonical: true }),
    ).toBeNull();
  });
});
