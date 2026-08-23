/**
 * FormulaUnitInput / formulaBinding tests — the formula-capable numeric
 * input wired to the v1 allowlist fields in the PropertyPanel
 * (core/schema.ts NumberOrExpression; core/paramBindings.ts resolves).
 *
 * Layers covered:
 *  - pure helpers (parseFormulaInput / expressionParseError /
 *    previewBoundField) — classification, parse errors, resolved previews
 *    and field-local error filtering;
 *  - SSR markup per state (literal / bound / broken) — badge, expression,
 *    resolved preview in the display unit, inline errors, "Use resolved
 *    value" action, scope help.  (SSR harness caveat documented in
 *    solidPropertyField.test.tsx: assign the initial-state object.)
 *  - store integration: formula commits land as exact { expr } objects,
 *    "use resolved value" writes a plain literal, each is ONE undo step,
 *    and modelText === serializeText(config) is preserved;
 *  - text save/load round-trip of formula-bound fields edited in the panel.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { renderToString } from "react-dom/server";
import { useStore } from "../store";
import PropertyPanel from "../components/PropertyPanel";
import {
  FORMULA_SCOPE_HELP,
  expressionParseError,
  isFormulaBound,
  parseFormulaInput,
  previewBoundField,
} from "../formulaBinding";
import { previewNetworkParameters } from "../../core";
import { serializeText, parseText } from "../../substrate/textProjection";
import type { NetworkConfig, Selection } from "../types";
import { threePipeJunction } from "../examples";
import { cloneConfig } from "../utils";

/* ------------------------------------------------------------------ */
/* Fixtures + harness                                                  */
/* ------------------------------------------------------------------ */

/** Steady pipe network with an internal node and a heated pipe. */
function makeConfig(): NetworkConfig {
  return {
    meta: { name: "Formula UI", version: 2 },
    settings: { mode: "steady", tolerance: 1e-8, maxIterations: 100 },
    fluid: { model: "incompressible", preset: "water" },
    nodes: [
      {
        id: "a",
        type: "boundary",
        x: 0,
        y: 0,
        pressure: 2e5,
        temperature: 300,
      },
      {
        id: "n1",
        type: "internal",
        x: 1,
        y: 0,
        pressure: 1.5e5,
        temperature: 300,
        volume: 1e-3,
      },
      {
        id: "b",
        type: "boundary",
        x: 2,
        y: 0,
        pressure: 1e5,
        temperature: 300,
      },
    ],
    branches: [
      {
        id: "seg1",
        from: "a",
        to: "n1",
        component: { type: "pipe", length: 2, diameter: 0.05, roughness: 1e-5 },
      },
      {
        id: "seg2",
        from: "n1",
        to: "b",
        component: { type: "pipe", length: 1, diameter: 0.05, roughness: 1e-5 },
      },
    ],
  };
}

/** Client-path store reset (mirrors solidPropertyField.test.tsx). */
function resetStore(config: NetworkConfig) {
  const text = serializeText(config);
  useStore.setState({
    config,
    baseConfig: config,
    selection: { kind: "none" },
    result: null,
    resultConfig: null,
    validationErrors: [],
    past: [],
    future: [],
    modelText: text,
    textDraft: text,
    textDiagnostics: [],
  });
}

function renderPanelSsr(config: NetworkConfig, selection: Selection): string {
  Object.assign(useStore.getInitialState(), {
    config,
    baseConfig: config,
    selection,
  });
  return renderToString(<PropertyPanel />).replace(/<!-- -->/g, "");
}

const nodeSel: Selection = { kind: "node", id: "n1" };
const branchSel: Selection = { kind: "branch", id: "seg1" };

/* ------------------------------------------------------------------ */
/* Pure helpers                                                        */
/* ------------------------------------------------------------------ */

describe("parseFormulaInput", () => {
  it("classifies empty, literal and formula text", () => {
    expect(parseFormulaInput("")).toEqual({ kind: "empty" });
    expect(parseFormulaInput("   ")).toEqual({ kind: "empty" });
    expect(parseFormulaInput("0.05")).toEqual({
      kind: "literal",
      text: "0.05",
    });
    expect(parseFormulaInput("1e-3")).toEqual({
      kind: "literal",
      text: "1e-3",
    });
    expect(parseFormulaInput("1e")).toEqual({ kind: "literal", text: "1e" });
    expect(parseFormulaInput("1e-")).toEqual({ kind: "literal", text: "1e-" });
    expect(parseFormulaInput("-.")).toEqual({ kind: "literal", text: "-." });
    expect(parseFormulaInput("pipe('seg1').surfaceArea")).toEqual({
      kind: "formula",
      expr: "pipe('seg1').surfaceArea",
    });
    expect(parseFormulaInput("2 * circleArea(0.05)")).toEqual({
      kind: "formula",
      expr: "2 * circleArea(0.05)",
    });
    expect(parseFormulaInput("=pipe('seg1').surfaceArea")).toEqual({
      kind: "formula",
      expr: "pipe('seg1').surfaceArea",
    });
    // Leading '=' with surrounding whitespace; inner whitespace preserved.
    expect(parseFormulaInput("  = 0.5 * 0.002 ")).toEqual({
      kind: "formula",
      expr: "0.5 * 0.002",
    });
    expect(parseFormulaInput("=")).toEqual({ kind: "formula", expr: "" });
  });
});

describe("expressionParseError", () => {
  it("accepts valid expressions and rejects malformed ones", () => {
    expect(expressionParseError("pipe('seg1').volume")).toBeNull();
    expect(expressionParseError("0.5 * circleArea(0.05)")).toBeNull();
    expect(expressionParseError("")).toMatch(/non-empty/);
    expect(expressionParseError("pipe('seg1'")).toBeTruthy();
    expect(expressionParseError("1 +")).toBeTruthy();
  });
});

describe("previewBoundField", () => {
  it("resolves a committed formula in SI against the static model scope", () => {
    const config = makeConfig();
    config.nodes[1].volume = { expr: "pipe('seg1').volume" };
    const preview = previewBoundField(config, "node 'n1'.volume");
    expect(preview.status).toBe("ok");
    if (preview.status === "ok") {
      expect(preview.value).toBeCloseTo(2 * Math.PI * 0.05 * 0.05 * 0.25, 12);
    }
  });

  it("surfaces dependency errors attributed to this field only", () => {
    const config = makeConfig();
    config.nodes[1].volume = { expr: "pipe('ghost').volume" };
    const preview = previewBoundField(config, "node 'n1'.volume");
    expect(preview.status).toBe("error");
    if (preview.status === "error") {
      expect(preview.errors.join("; ")).toMatch(/unknown branch 'ghost'/);
      // Field-local: no "Parameter binding …" prefix leaks into the panel.
      expect(preview.errors.join("; ")).not.toMatch(/Parameter binding/);
    }
  });

  it("does not mask this field with another field’s error", () => {
    const config = makeConfig();
    config.nodes[1].volume = { expr: "0.002" };
    const branch = config.branches[0];
    if (branch.component.type === "pipe")
      branch.component.diameter = { expr: "1 +" };
    const preview = previewBoundField(config, "node 'n1'.volume");
    expect(preview.status).toBe("error");
    if (preview.status === "error") {
      expect(preview.errors.join("; ")).toMatch(/another formula/);
    }
    // …while the broken field itself reports its own parse error.
    const own = previewBoundField(config, "branch 'seg1'.diameter");
    expect(own.status).toBe("error");
    if (own.status === "error")
      expect(own.errors.join("; ")).toMatch(/Expected a value/);
  });

  it("never mutates the config (preview purity)", () => {
    const config = makeConfig();
    config.nodes[1].volume = { expr: "pipe('seg1').volume" };
    const before = serializeText(config);
    previewBoundField(config, "node 'n1'.volume");
    previewNetworkParameters(config);
    expect(serializeText(config)).toBe(before);
    expect(config.nodes[1].volume).toEqual({ expr: "pipe('seg1').volume" });
  });

  it("previews a committed formula even when the snapshot has already been resolved to literals", () => {
    const config = makeConfig();
    config.nodes[1].volume = { expr: "pipe('seg1').volume" };
    const resolved = previewNetworkParameters(config);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    const numeric = resolved.config as unknown as NetworkConfig;
    expect(previewBoundField(numeric, "node 'n1'.volume").status).toBe("error");
    const volumeBefore = numeric.nodes[1].volume;
    const recovered = previewBoundField(numeric, "node 'n1'.volume", {
      expr: "pipe('seg1').volume",
    });
    expect(recovered.status).toBe("ok");
    if (recovered.status === "ok") {
      expect(recovered.value).toBeCloseTo(2 * Math.PI * 0.05 * 0.05 * 0.25, 12);
    }
    expect(numeric.nodes[1].volume).toBe(volumeBefore);
  });
});

/* ------------------------------------------------------------------ */
/* SSR: panel markup per binding state                                 */
/* ------------------------------------------------------------------ */

describe("PropertyPanel formula fields (SSR)", () => {
  it("literal node volume renders the chip editor as plain text (no badge, no preview, no chips)", () => {
    const html = renderPanelSsr(makeConfig(), nodeSel);
    expect(html).toContain('data-testid="node-volume"');
    expect(html).toContain('data-testid="node-volume-editor"');
    // The literal is the editor's plain text content (no value attribute,
    // no chip markup, and the '=' formula leader is absent).
    expect(html).toContain('data-testid="node-volume-editor">0.001</div>');
    expect(html).not.toContain("node-volume-chip");
    expect(html).not.toContain("node-volume-formula-badge");
    expect(html).not.toContain("node-volume-preview");
    // The plain-text fallback toggle is always available.
    expect(html).toContain('data-testid="node-volume-plain-toggle"');
    expect(html).toContain('aria-pressed="false"');
  });

  it("formula-bound node volume shows a reference chip and the resolved preview", () => {
    const config = makeConfig();
    config.nodes[1].volume = { expr: "pipe('seg1').volume" };
    const html = renderPanelSsr(config, nodeSel);
    expect(html).not.toContain("node-volume-formula-badge");
    expect(html).not.toContain("ƒ formula");
    // The reference renders as an atomic chip carrying its exact source span;
    // the '=' leader stays plain text.
    expect(html).toContain(
      'data-testid="node-volume-editor">=<span class="formula-chip"',
    );
    expect(html).toContain('data-testid="node-volume-chip"');
    expect(html).toContain('data-chip-source="pipe(&#39;seg1&#39;).volume"');
    expect(html).toContain(">seg1 · volume</span>");
    // aria-live announcer for chip add/remove.
    expect(html).toContain('data-testid="node-volume-announce"');
    // Resolved preview: 2 m × π × (0.05 m)² / 4 = 0.0039270 m³.
    const expected = 2 * Math.PI * 0.05 * 0.05 * 0.25;
    expect(html).toContain(`→ ${expected.toPrecision(6)}`);
    expect(html).toContain("node-volume-use-resolved");
    expect(html).not.toContain('role="alert"');
  });

  it("physical coordinates accept formulas and show resolved previews", () => {
    const config = makeConfig();
    config.nodes[1].position = { x: { expr: "pipe('seg1').length" } };
    const html = renderPanelSsr(config, nodeSel);
    expect(html).toContain('data-testid="node-position-x"');
    expect(html).toContain('data-testid="node-position-x-chip"');
    expect(html).toContain(">seg1 · length</span>");
    expect(html).toContain('data-testid="node-position-x-preview"');
    expect(html).toContain("→ 2");
  });

  it("a broken formula keeps the source, warns on the chip and shows the error inline", () => {
    const config = makeConfig();
    config.nodes[1].volume = { expr: "pipe('ghost').volume" };
    const html = renderPanelSsr(config, nodeSel);
    expect(html).not.toContain("node-volume-formula-badge");
    expect(html).toContain('role="alert"');
    expect(html).toContain("unknown branch &#x27;ghost&#x27;");
    // The stored formula is still shown for editing (never deleted): the
    // invalid chip keeps its exact source and carries the warning style.
    expect(html).toContain("formula-chip formula-chip--invalid");
    expect(html).toContain('data-chip-source="pipe(&#39;ghost&#39;).volume"');
    expect(html).toContain('aria-invalid="true"');
    expect(html).not.toContain("node-volume-use-resolved");
  });

  it("a formula resolving to a non-positive value raises a range warning", () => {
    const config = makeConfig();
    config.nodes[1].volume = { expr: "-0.5" };
    const html = renderPanelSsr(config, nodeSel);
    expect(html).toContain("node-volume-range-warning");
    expect(html).toContain("must be positive");
  });

  it("branch pipe length/diameter are formula-capable with a branch path preview", () => {
    const config = makeConfig();
    if (config.branches[0].component.type === "pipe") {
      config.branches[0].component.length = { expr: "pipe('seg2').length * 2" };
    }
    const html = renderPanelSsr(config, branchSel);
    expect(html).toContain('data-testid="pipe-length"');
    expect(html).not.toContain("pipe-length-formula-badge");
    expect(html).toContain("→ 2"); // 1 m × 2
    expect(html).toContain("pipe-length-use-resolved");
    // The chip wraps only the reference; ' * 2' stays plain text.
    expect(html).toContain('data-chip-source="pipe(&#39;seg2&#39;).length"');
    expect(html).toContain(">seg2 · length</span>");
  });

  it("three-pipe junction roughness formulas preview instead of a false missing-binding error", () => {
    const html = renderPanelSsr(cloneConfig(threePipeJunction), {
      kind: "branch",
      id: "b3",
    });
    expect(html).toContain("Roughness");
    expect(html).not.toContain("no formula binding is stored here");
    expect(html).toContain("pipe(&#39;b1&#39;).roughness");
    expect(html).toContain("→ 0.00001");
    expect(html).toContain("Use resolved value");
  });

  it("the formula scope documents accessors and helpers, with no obsolete = instruction", () => {
    expect(FORMULA_SCOPE_HELP).toContain("node('id').volume");
    // The "type = to enter a formula" instruction is gone; the Options button is
    // the advertised entry point.
    expect(FORMULA_SCOPE_HELP).not.toContain("Start with =");
    expect(FORMULA_SCOPE_HELP).toContain("f(x)");
  });

  it("renders the formula browser button and the Text formula escape hatch", () => {
    const html = renderPanelSsr(makeConfig(), nodeSel);
    expect(html).toContain('data-testid="node-volume-insert-variable"');
    expect(html).toContain('aria-label="Browse formula options for Volume"');
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain(">f(x)</button>");
    // The plain-text escape hatch keeps the capability under its own label.
    expect(html).toContain('data-testid="node-volume-plain-toggle"');
    expect(html).toContain('aria-label="Text formula"');
    expect(html).toContain(">Aa</button>");
    expect(html).not.toMatch(/plain-toggle[^>]*>f\(x\)/);
  });
});

/* ------------------------------------------------------------------ */
/* Store integration: commit shapes, undo, text sync                   */
/* ------------------------------------------------------------------ */

describe("formula commits through the store", () => {
  beforeEach(() => resetStore(makeConfig()));
  const s = () => useStore.getState();
  const nodeVolume = () => s().config.nodes[1].volume;

  it("a formula commit stores exactly { expr } as ONE undoable update", () => {
    // What FormulaUnitInput commits when the user types =… and blurs.
    s().updateNode("n1", { volume: { expr: "pipe('seg1').volume" } });
    expect(nodeVolume()).toEqual({ expr: "pipe('seg1').volume" });
    expect(isFormulaBound(nodeVolume())).toBe(true);
    // Text cache stays a faithful serialization (lossless formula).
    expect(s().modelText).toBe(serializeText(s().config));
    expect(s().modelText).toContain('"expr":"pipe(\'seg1\').volume"');
    s().undo();
    expect(nodeVolume()).toBe(1e-3);
    s().redo();
    expect(nodeVolume()).toEqual({ expr: "pipe('seg1').volume" });
  });

  it('reverting to a literal ("use resolved value") is one ordinary undo step', () => {
    s().updateNode("n1", { volume: { expr: "pipe('seg1').volume" } });
    const preview = previewBoundField(s().config, "node 'n1'.volume");
    expect(preview.status).toBe("ok");
    if (preview.status !== "ok") return;
    s().updateNode("n1", { volume: preview.value });
    expect(nodeVolume()).toBeCloseTo(2 * Math.PI * 0.05 * 0.05 * 0.25, 12);
    expect(typeof nodeVolume()).toBe("number");
    s().undo();
    expect(nodeVolume()).toEqual({ expr: "pipe('seg1').volume" });
  });

  it("a committed formula resolves through the full solve-entry path", () => {
    s().updateNode("n1", {
      volume: { expr: "pipe('seg1').volume + pipe('seg2').volume" },
    });
    const result = previewNetworkParameters(s().config);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.resolved["node 'n1'.volume"]).toBeCloseTo(
        3 * Math.PI * 0.05 * 0.05 * 0.25,
        12,
      );
      // The user's config keeps the formula untouched.
      expect(nodeVolume()).toEqual({
        expr: "pipe('seg1').volume + pipe('seg2').volume",
      });
    }
  });
});

/* ------------------------------------------------------------------ */
/* Text save/load round-trip of panel-edited formulas                  */
/* ------------------------------------------------------------------ */

describe("formula persistence", () => {
  it("formula-bound fields round-trip through the text format unchanged", () => {
    // Round-trip through the text projection once so the comparison shape
    // matches what parseText produces.
    const config = parseText(serializeText(makeConfig())).config!;
    config.nodes[1].volume = { expr: "pipe('seg1').volume" };
    const seg1 = config.branches[0];
    if (seg1.component.type === "pipe") {
      seg1.component.diameter = { expr: "0.04 + 0.01" };
    }
    const text = serializeText(config);
    expect(text).toContain('"volume":{"expr":"pipe(\'seg1\').volume"}');
    expect(text).toContain('"diameter":{"expr":"0.04 + 0.01"}');
    const result = parseText(text);
    expect(result.errors).toEqual([]);
    expect(result.config).toStrictEqual(config);
  });
});
