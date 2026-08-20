/**
 * FormulaExpressionEditor tests — pure/SSR coverage of the visual formula
 * chip editor (interactive behaviour is covered by e2e/formula-chips.spec.ts;
 * vitest here runs in node without a DOM).
 *
 * Layers:
 *  - buildFormulaEditorHtml: chip/text markup, byte-exact source round-trip
 *    through data-chip-source, HTML escaping, invalid/selected styling,
 *    remove buttons and testid hooks;
 *  - isFormulaChipValid: catalog-driven validity per accessor (id known,
 *    property path in static scope, reg without properties);
 *  - SSR of the editor itself: role/ARIA wiring, the aria-live announcer,
 *    chip markup inside the contenteditable host.
 */
import { describe, it, expect } from "vitest";
import { renderToString } from "react-dom/server";
import FormulaExpressionEditor, {
  buildFormulaEditorHtml,
  escapeFormulaHtml,
  isFormulaChipValid,
} from "../components/FormulaExpressionEditor";
import { segmentFormula, sourceFromSegments } from "../formulaTokens";
import { buildFormulaCatalog } from "../formulaCompletion";
import type { NetworkConfig } from "../../core";

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

function makeConfig(): NetworkConfig {
  return {
    meta: { name: "Chips", version: 2 },
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
    ],
    registers: { gain: 2.5 },
  };
}

const catalog = buildFormulaCatalog(makeConfig());
const isValid = (chip: Parameters<typeof isFormulaChipValid>[1]) =>
  isFormulaChipValid(catalog, chip);

/* ------------------------------------------------------------------ */
/* buildFormulaEditorHtml                                              */
/* ------------------------------------------------------------------ */

describe("buildFormulaEditorHtml", () => {
  it("renders model references as atomic chips and everything else as exact text", () => {
    const src = "=2 * pipe('seg1').surfaceArea + circleArea(0.05)";
    const html = buildFormulaEditorHtml(src, { isValid, testId: "f" });
    expect(html).toContain("=2 * ");
    expect(html).toContain(
      '<span class="formula-chip" contenteditable="false"',
    );
    expect(html).toContain(
      'data-chip-source="pipe(&#39;seg1&#39;).surfaceArea"',
    );
    expect(html).toContain(">seg1 · surfaceArea</span>");
    expect(html).toContain(">pipe</span>"); // accessor tag
    expect(html).toContain('data-testid="f-chip"');
    expect(html).toContain("data-chip-remove=");
    // Helpers/builtins/operators stay text — no chip around circleArea.
    expect(html).toContain(" + circleArea(0.05)");
    expect(html.match(/formula-chip"/g)).toHaveLength(1);
  });

  it("chip spans cover the exact source: text + data-chip-source rebuild the source", () => {
    const src = "=pipe('seg1').volume*2+reg('gain')";
    const segments = segmentFormula(src);
    // The segmenter invariant the editor relies on: byte-exact round-trip.
    expect(sourceFromSegments(src, segments)).toBe(src);
    const html = buildFormulaEditorHtml(src, { isValid });
    expect(html.match(/data-chip-source=/g)).toHaveLength(2);
    expect(html).toContain('data-chip-source="reg(&#39;gain&#39;)"');
    // reg('gain') has no property chain — label is just the id.
    expect(html).toContain(">gain</span>");
  });

  it("escapes HTML in ids, labels and text segments", () => {
    const src = `=pipe('a<b>"\\'').volume + 1<2`;
    const html = buildFormulaEditorHtml(src, { isValid: () => true });
    expect(html).not.toContain("<b>");
    expect(html).toContain("&lt;b&gt;");
    expect(escapeFormulaHtml(`<>&"'`)).toBe("&lt;&gt;&amp;&quot;&#39;");
    // Text segment with a raw '<' is escaped too.
    expect(html).toContain(" + 1&lt;2");
  });

  it("marks invalid and selected chips with dedicated classes", () => {
    const src = "=pipe('ghost').volume + pipe('seg1').volume";
    const segments = segmentFormula(src);
    const ghost = segments.find(
      (s) => s.type === "chip" && s.chip.id === "ghost",
    );
    const html = buildFormulaEditorHtml(src, {
      isValid,
      selectedChipStart: ghost?.start,
    });
    expect(html).toContain(
      "formula-chip formula-chip--invalid formula-chip--selected",
    );
    expect(html).toContain("not a valid static reference");
    // The valid chip keeps the plain class.
    expect(html).toContain(
      'class="formula-chip" contenteditable="false" data-chip-start="24"',
    );
    expect(html).toContain('data-chip-source="pipe(&#39;seg1&#39;).volume"');
  });
});

/* ------------------------------------------------------------------ */
/* isFormulaChipValid                                                  */
/* ------------------------------------------------------------------ */

describe("isFormulaChipValid", () => {
  const chipOf = (src: string) => {
    const seg = segmentFormula(src).find((s) => s.type === "chip");
    if (!seg || seg.type !== "chip") throw new Error(`no chip in ${src}`);
    return seg.chip;
  };

  it("accepts in-scope references and rejects unknown ids/properties", () => {
    expect(isValid(chipOf("pipe('seg1').volume"))).toBe(true);
    expect(isValid(chipOf("node('n1').volume"))).toBe(true);
    expect(isValid(chipOf("reg('gain')"))).toBe(true);
    expect(isValid(chipOf("pipe('ghost').volume"))).toBe(false);
    expect(isValid(chipOf("pipe('seg1').pressure"))).toBe(false);
    expect(isValid(chipOf("node('a').volume"))).toBe(false); // boundary node has no volume
    expect(isValid(chipOf("reg('missing')"))).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* SSR of the editor component                                         */
/* ------------------------------------------------------------------ */

describe("FormulaExpressionEditor (SSR)", () => {
  const renderEditor = (text: string) =>
    renderToString(
      <FormulaExpressionEditor
        text={text}
        catalog={catalog}
        ariaLabel="Volume (m³)"
        dataTestId="vol"
        onFocus={() => {}}
        onTextChange={() => {}}
        onCommit={() => {}}
      />,
    ).replace(/<!-- -->/g, "");

  it("renders the token surface with textbox semantics and the aria-live announcer", () => {
    const html = renderEditor("=pipe('seg1').volume");
    expect(html).toContain('role="textbox"');
    expect(html).toContain('aria-label="Volume (m³)"');
    expect(html).toContain('aria-multiline="false"');
    expect(html).toContain('aria-autocomplete="list"');
    expect(html).toContain('data-testid="vol-editor"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('data-testid="vol-announce"');
    // Display mode is not editable; chips render inside the surface.
    expect(html).toContain('contenteditable="false"');
    expect(html).toContain('data-testid="vol-chip"');
    expect(html).toContain(">seg1 · volume</span>");
  });

  it("renders a literal as plain text with no chips and no invalid styling", () => {
    const html = renderEditor("0.001");
    expect(html).toContain('data-testid="vol-editor">0.001</div>');
    expect(html).not.toContain("formula-chip");
  });

  it("renders malformed formula source as plain text (segmenter tolerance)", () => {
    const html = renderEditor("=pipe('seg1'. + ");
    expect(html).not.toContain('formula-chip"');
    expect(html).toContain("=pipe(&#39;seg1&#39;. + ");
  });

  it("forwards aria-invalid to the token surface", () => {
    const html = renderToString(
      <FormulaExpressionEditor
        text="=pipe('ghost').volume"
        catalog={catalog}
        ariaLabel="Volume"
        ariaInvalid
        dataTestId="vol"
        onFocus={() => {}}
        onTextChange={() => {}}
        onCommit={() => {}}
      />,
    ).replace(/<!-- -->/g, "");
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain("formula-chip--invalid");
  });

  it("disabled editors are neither editable nor focusable", () => {
    const html = renderToString(
      <FormulaExpressionEditor
        text="=1"
        catalog={catalog}
        ariaLabel="Volume"
        disabled
        dataTestId="vol"
        onFocus={() => {}}
        onTextChange={() => {}}
        onCommit={() => {}}
      />,
    ).replace(/<!-- -->/g, "");
    expect(html).toContain("formula-expression-editor--disabled");
    expect(html).not.toContain("tabindex");
  });
});
