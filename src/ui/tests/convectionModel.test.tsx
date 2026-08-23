/**
 * ConvectionModelEditor / convectionModelUi tests — the PropertyPanel
 * "Heat-transfer model" selector for convection conductors (specified h,
 * Dittus–Boelter, Miropolskii, Darr–Hartwig, TT-WF).
 *
 * Specified h is ONE selector entry with ONE input box: a constant, a static
 * equation over the model scope, or a runtime equation over the solver's local
 * flow state all land in the schema form they belong to
 * (specifiedHOf / classifyHEquation / convectionTypeForSpecifiedH).
 *
 * Layers covered:
 *  - pure helpers (convectionModelOf / correlationForModel /
 *    convectionTypeForModel / the specified-h trio / parseParamsText): exact
 *    schema shapes per switch, compatible-input preservation, sensible valid
 *    defaults;
 *  - SSR markup per model (fields, concise requirement notes, the h box and
 *    its scope note, params editor, formula-capable diameter/flowArea) — with
 *    teaching prose (model summaries/theory) asserted ABSENT;
 *  - store integration: a model switch is ONE undoable update, clears the
 *    block the previous model owned, and keeps
 *    modelText === serializeText(config);
 *  - text save/load round-trip of every correlation shape.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { renderToString } from "react-dom/server";
import { useStore } from "../store";
import PropertyPanel from "../components/PropertyPanel";
import ModelTableView from "../components/ModelTableView";
import {
  CONVECTION_MODEL_INFO,
  classifyHEquation,
  convectionModelOf,
  convectionTypeForModel,
  convectionTypeForSpecifiedH,
  correlationForModel,
  parseParamsText,
  specifiedHOf,
  type ConvectionCorrelationConfig,
  type ConvectionType,
} from "../convectionModelUi";
import { validateNetwork } from "../../core";
import { serializeText, parseText } from "../../substrate/textProjection";
import type { NetworkConfig, Selection } from "../types";

/* ------------------------------------------------------------------ */
/* Fixtures + harness                                                  */
/* ------------------------------------------------------------------ */

type Convection = ConvectionType;

/** Convection type with a formula-bound h: `h` is in the static binding
 *  allowlist (core/formulaFields.ts) but declared a number in schema.ts, the
 *  same loose typing every bindable field carries. */
function boundH(expr: string): Convection {
  return {
    kind: "convection",
    h: { expr },
    area: 0.01,
  } as unknown as Convection;
}

function convectionOf(config: NetworkConfig): Convection {
  const t = config.conductors![0].type;
  if (t.kind !== "convection") throw new Error("fixture drift");
  return t;
}

function makeConfig(type?: Convection): NetworkConfig {
  return {
    meta: { name: "Convection UI", version: 2 },
    settings: {
      mode: "transient",
      dt: 0.1,
      endTime: 1,
      tolerance: 1e-6,
      maxIterations: 50,
    },
    fluid: { model: "incompressible", preset: "water" },
    nodes: [
      {
        id: "f1",
        type: "internal",
        x: 0,
        y: 200,
        pressure: 1e5,
        temperature: 300,
        volume: 1e-3,
      },
    ],
    solidNodes: [
      {
        id: "w1",
        type: "solid",
        x: 0,
        y: 100,
        temperature: 350,
        mass: 2,
        cp: 500,
      },
    ],
    conductors: [
      {
        id: "c1",
        from: "w1",
        to: "f1",
        type: type ?? { kind: "convection", h: 100, area: 0.01 },
      },
    ],
    branches: [],
  };
}

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

function renderSsr(
  view: "panel" | "table",
  config: NetworkConfig,
  selection: Selection,
): string {
  Object.assign(useStore.getInitialState(), {
    config,
    baseConfig: config,
    selection,
  });
  const html =
    view === "panel"
      ? renderToString(<PropertyPanel />)
      : renderToString(<ModelTableView />);
  return html.replace(/<!-- -->/g, "");
}

const conductorSel: Selection = { kind: "conductor", id: "c1" };

/* ------------------------------------------------------------------ */
/* Pure helpers                                                        */
/* ------------------------------------------------------------------ */

describe("convectionModelUi helpers", () => {
  it("convectionModelOf derives the key from the stored shape", () => {
    expect(convectionModelOf({ kind: "convection", h: 100, area: 0.01 })).toBe(
      "specified",
    );
    expect(
      convectionModelOf({
        kind: "convection",
        area: 0.01,
        correlation: { model: "dittusBoelter", diameter: 0.05 },
      }),
    ).toBe("dittusBoelter");
    // A runtime h equation is still the user specifying h: same entry.
    expect(
      convectionModelOf({
        kind: "convection",
        area: 0.01,
        correlation: { model: "custom", expression: "100" },
      }),
    ).toBe("specified");
  });

  it("the selector offers no separate custom-equation entry", () => {
    expect(Object.keys(CONVECTION_MODEL_INFO)).toEqual([
      "specified",
      "dittusBoelter",
      "miropolskii",
      "darrHartwig",
      "ttWf",
    ]);
  });

  it("correlationForModel seeds valid defaults per model", () => {
    const db = correlationForModel("dittusBoelter", undefined);
    expect(db).toEqual({ model: "dittusBoelter", diameter: 0.05 });
    const dh = correlationForModel("darrHartwig", undefined);
    expect(dh).toMatchObject({
      model: "darrHartwig",
      diameter: 0.05,
      axialPosition: 1,
    });
    const tt = correlationForModel("ttWf", undefined);
    expect(tt).toMatchObject({
      model: "ttWf",
      diameter: 0.05,
      axialPosition: 1,
      segmentLength: 1,
    });
  });

  it("switches preserve compatible inputs and drop inapplicable ones", () => {
    const start: ConvectionCorrelationConfig = {
      model: "darrHartwig",
      diameter: { expr: "pipe('seg1').diameter" },
      flowArea: 7e-4,
      axialPosition: 2.5,
      inletLiquidReynolds: 40000,
    };
    // Chilldown → single-phase: geometry and axialPosition survive so a later
    // model sweep can still validate darrHartwig. inlet Re is chilldown-only.
    const db = correlationForModel("dittusBoelter", start);
    expect(db).toEqual({
      model: "dittusBoelter",
      diameter: { expr: "pipe('seg1').diameter" },
      flowArea: 7e-4,
      axialPosition: 2.5,
    });
    // Single-phase → ttWf: preserved z, seeded segmentLength.
    const tt = correlationForModel("ttWf", db);
    expect(tt).toMatchObject({
      model: "ttWf",
      diameter: { expr: "pipe('seg1').diameter" },
      flowArea: 7e-4,
      axialPosition: 2.5,
      segmentLength: 1,
    });
    // A named model drops the custom expression/params it cannot run with.
    const custom: ConvectionCorrelationConfig = {
      model: "custom",
      expression: "param('C') * 2",
      params: { C: 3 },
    };
    expect(correlationForModel("dittusBoelter", custom)).toEqual({
      model: "dittusBoelter",
      diameter: 0.05,
    });
  });

  it("convectionTypeForModel keeps h as fallback and area verbatim (incl. formulas)", () => {
    const current: Convection = {
      kind: "convection",
      h: 250,
      area: { expr: "pipe('seg1').surfaceArea" },
    };
    const next = convectionTypeForModel("dittusBoelter", current);
    expect(next.h).toBe(250);
    expect(next.area).toEqual({ expr: "pipe('seg1').surfaceArea" });
    expect(next.correlation).toEqual({
      model: "dittusBoelter",
      diameter: 0.05,
    });
    // Back to specified h: correlation dropped, h kept.
    const back = convectionTypeForModel("specified", next);
    expect(back).toEqual({
      kind: "convection",
      h: 250,
      area: { expr: "pipe('seg1').surfaceArea" },
    });
    // The cleared key is present-and-undefined so a patching caller removes it.
    expect("correlation" in back).toBe(true);
    expect(back.correlation).toBeUndefined();
  });

  it("specified h re-seeds h when the correlation-only conductor had none", () => {
    const current: Convection = {
      kind: "convection",
      area: 0.01,
      correlation: { model: "dittusBoelter", diameter: 0.05 },
    };
    expect(convectionTypeForModel("specified", current)).toEqual({
      kind: "convection",
      area: 0.01,
      h: 100,
    });
  });

  it("selecting specified h leaves an existing runtime equation alone", () => {
    const current: Convection = {
      kind: "convection",
      area: 0.01,
      correlation: { model: "custom", expression: "Re * 0.1" },
    };
    expect(convectionTypeForModel("specified", current)).toBe(current);
  });

  it("seeded defaults produce zero validate.ts errors for the named models (realFluid aside)", () => {
    // Dittus–Boelter on the incompressible fixture: the ONLY error is the
    // documented realFluid requirement — geometry defaults are valid.
    const config = makeConfig(
      convectionTypeForModel("dittusBoelter", convectionOf(makeConfig())),
    );
    const errors = validateNetwork(config);
    expect(
      errors
        .filter((e) => e.includes("correlation"))
        .map((e) => e.replace(/^Conductor c1 /, "")),
    ).toEqual(["correlation requires realFluid fluid model"]);
  });

  it("specifiedHOf reads the box contents out of each stored form", () => {
    expect(specifiedHOf({ kind: "convection", h: 100, area: 0.01 })).toEqual({
      kind: "constant",
      value: 100,
    });
    expect(specifiedHOf({ kind: "convection", area: 0.01 })).toEqual({
      kind: "constant",
      value: undefined,
    });
    expect(specifiedHOf(boundH("reg('hScale') * 50"))).toEqual({
      kind: "static",
      expr: "reg('hScale') * 50",
    });
    expect(
      specifiedHOf({
        kind: "convection",
        area: 0.01,
        correlation: { model: "custom", expression: "Re * 0.1" },
      }),
    ).toEqual({ kind: "runtime", expr: "Re * 0.1" });
  });

  it("classifyHEquation routes by the scope the equation actually reads", () => {
    // Local flow/thermal state ⇒ only the solver can evaluate it.
    expect(classifyHEquation("0.023 * Re^0.8 * Pr^0.4 * k / D")).toBe(
      "runtime",
    );
    expect(classifyHEquation("100 + t")).toBe("runtime");
    expect(classifyHEquation("param('C') * G")).toBe("runtime");
    // Model scope (or no identifiers at all) ⇒ an ordinary static binding.
    expect(classifyHEquation("250")).toBe("static");
    expect(classifyHEquation("circleArea(0.05) * 1e4")).toBe("static");
    expect(classifyHEquation("50 / pipe('seg1').diameter")).toBe("static");
    expect(classifyHEquation("reg('hScale') * 50")).toBe("static");
    // A string-literal id that happens to spell a scope name is not a read.
    expect(classifyHEquation("reg('k')")).toBe("static");
    // Mixed scopes and typos stay static, where resolution REPORTS the
    // unknown identifier instead of failing over to the h floor in silence.
    expect(classifyHEquation("Re * pipe('seg1').diameter")).toBe("static");
    expect(classifyHEquation("Reynolds * 2")).toBe("static");
    // Half-typed source belongs to neither form.
    expect(classifyHEquation("1 +")).toBe("unparseable");
  });

  it("a half-typed equation keeps its form and the inputs it reads", () => {
    const runtime: Convection = {
      kind: "convection",
      area: 0.01,
      correlation: {
        model: "custom",
        expression: "Re * 0.1",
        diameter: 0.03,
        params: { C: 3 },
      },
    };
    // Mid-edit source stays in the correlation: the geometry and params the
    // finished equation reads survive the typo (validate.ts reports it).
    expect(
      convectionTypeForSpecifiedH({ expr: "Re * 0.1 +" }, runtime).correlation,
    ).toEqual({
      model: "custom",
      expression: "Re * 0.1 +",
      diameter: 0.03,
      params: { C: 3 },
    });
    // From a constant there is no correlation to keep it in.
    const fromConstant = convectionTypeForSpecifiedH(
      { expr: "Re * 0.1 +" },
      { kind: "convection", h: 100, area: 0.01 },
    );
    expect(fromConstant).toEqual({
      kind: "convection",
      area: 0.01,
      h: { expr: "Re * 0.1 +" },
    });
  });

  it("convectionTypeForSpecifiedH stores each committed value in its own form", () => {
    const start: Convection = { kind: "convection", h: 100, area: 0.01 };
    // Constant: plain h, no correlation.
    expect(convectionTypeForSpecifiedH(250, start)).toEqual({
      kind: "convection",
      h: 250,
      area: 0.01,
    });
    // Static equation: an ordinary parameter binding on h.
    expect(
      convectionTypeForSpecifiedH({ expr: "reg('hScale') * 50" }, start),
    ).toEqual({
      kind: "convection",
      h: { expr: "reg('hScale') * 50" },
      area: 0.01,
    });
    // Runtime equation: the custom correlation, and h is cleared so the box
    // the user typed into is the only place h comes from.
    const runtime = convectionTypeForSpecifiedH({ expr: "Re * 0.1" }, start);
    expect(runtime).toEqual({
      kind: "convection",
      area: 0.01,
      correlation: { model: "custom", expression: "Re * 0.1" },
    });
    expect("h" in runtime).toBe(true);
    expect(runtime.h).toBeUndefined();
    // Clearing the box leaves h unset (validate.ts then requires a value).
    expect(convectionTypeForSpecifiedH(undefined, runtime)).toEqual({
      kind: "convection",
      area: 0.01,
    });
  });

  it("an h equation keeps the scope inputs it needs, and never seeds them", () => {
    const start: Convection = {
      kind: "convection",
      area: 0.01,
      correlation: {
        model: "custom",
        expression: "Re * 0.1",
        diameter: { expr: "pipe('seg1').diameter" },
        flowArea: 7e-4,
        axialPosition: 2.5,
        params: { C: 3 },
      },
    };
    // Editing the equation preserves geometry, params and z.
    expect(
      convectionTypeForSpecifiedH({ expr: "param('C') * Re^0.8" }, start)
        .correlation,
    ).toEqual({
      model: "custom",
      expression: "param('C') * Re^0.8",
      diameter: { expr: "pipe('seg1').diameter" },
      flowArea: 7e-4,
      axialPosition: 2.5,
      params: { C: 3 },
    });
    // Writing a first equation exposes nothing implicitly: no diameter means
    // no D, and therefore no G/Re, until the user opts in.
    const fresh = convectionTypeForSpecifiedH(
      { expr: "Tw - Tf" },
      { kind: "convection", h: 100, area: 0.01 },
    );
    expect(fresh.correlation).toEqual({
      model: "custom",
      expression: "Tw - Tf",
    });
  });

  it("parseParamsText accepts finite-number objects and rejects junk", () => {
    expect(parseParamsText("")).toEqual({ ok: true, params: undefined });
    expect(parseParamsText("  ")).toEqual({ ok: true, params: undefined });
    expect(parseParamsText('{"C": 0.023, "n": 0.4}')).toEqual({
      ok: true,
      params: { C: 0.023, n: 0.4 },
    });
    expect(parseParamsText("not json").ok).toBe(false);
    expect(parseParamsText("[1,2]").ok).toBe(false);
    expect(parseParamsText('{"C": "big"}').ok).toBe(false);
    const bad = parseParamsText('{"C": "big"}');
    if (!bad.ok) expect(bad.error).toContain('"C"');
  });

  it("every model has a label; warnings state only concise hard requirements", () => {
    for (const key of Object.keys(CONVECTION_MODEL_INFO)) {
      const info =
        CONVECTION_MODEL_INFO[key as keyof typeof CONVECTION_MODEL_INFO];
      expect(info.label.length).toBeGreaterThan(0);
      // No explanatory summaries: model theory lives in the docs.
      expect("summary" in info).toBe(false);
    }
    // Specified h runs as-is — no requirement note.
    expect(CONVECTION_MODEL_INFO.specified.warning).toBeUndefined();
    expect(CONVECTION_MODEL_INFO.specified.label).toMatch(
      /constant or equation/,
    );
    // The named correlations cannot run without the realFluid model.
    for (const key of [
      "dittusBoelter",
      "miropolskii",
      "darrHartwig",
      "ttWf",
    ] as const) {
      expect(CONVECTION_MODEL_INFO[key].warning).toMatch(
        /^Requires the realFluid fluid model/,
      );
    }
    // TT-WF's other hard requirements are not panel fields — keep them stated.
    expect(CONVECTION_MODEL_INFO.ttWf.warning).toMatch(/transient mode/);
    expect(CONVECTION_MODEL_INFO.ttWf.warning).toMatch(
      /solid \(non-ambient\) wall endpoint/,
    );
  });
});

/* ------------------------------------------------------------------ */
/* SSR: per-model panel markup                                         */
/* ------------------------------------------------------------------ */

describe("PropertyPanel convection model editor (SSR)", () => {
  it("specified h keeps the legacy h + area UI and labels the select", () => {
    const html = renderSsr("panel", makeConfig(), conductorSel);
    expect(html).toContain('data-testid="convection-model"');
    expect(html).toContain('<option value="specified" selected=""');
    expect(html).toContain("Specified h (constant or equation)");
    expect(html).toContain(">100</div>"); // formula-capable h editor
    expect(html).toContain('data-testid="convection-area"');
    // The box advertises that an equation is welcome in the same field.
    expect(html).toContain('data-testid="convection-h-help"');
    expect(html).toContain("A constant, or an equation for h.");
    // No second h field, and no correlation chrome until one is needed.
    expect(html).not.toContain("h (fallback floor)");
    expect(html).not.toContain("convection-diameter");
    expect(html).not.toContain("convection-params");
    // The old separate menu entry and its textarea are gone.
    expect(html).not.toContain('value="custom"');
    expect(html).not.toContain("convection-expression");
    // No teaching prose / requirement note for a user-supplied h.
    expect(html).not.toContain("convection-summary");
    expect(html).not.toContain("convection-warning");
  });

  it("Dittus–Boelter shows fallback h, diameter, optional flow area and the realFluid requirement", () => {
    const config = makeConfig(
      convectionTypeForModel("dittusBoelter", convectionOf(makeConfig())),
    );
    const html = renderSsr("panel", config, conductorSel);
    expect(html).toContain('<option value="dittusBoelter" selected=""');
    expect(html).toContain('data-testid="convection-diameter"');
    expect(html).toContain('data-testid="convection-flow-area"');
    expect(html).toContain("h (fallback floor)");
    // Concise requirement note; the equation summary is gone (see docs).
    expect(html).toContain('data-testid="convection-warning"');
    expect(html).toContain("Requires the realFluid fluid model.");
    expect(html).not.toContain("convection-summary");
    expect(html).not.toContain("Nu = 0.023");
    // Axial position is optional here so a later Darr–Hartwig/TT-WF sweep
    // can pick it up; chilldown-only extras stay hidden.
    expect(html).toContain('data-testid="convection-axial-position"');
    expect(html).toContain("Axial position z (optional)");
    expect(html).not.toContain("convection-inlet-re");
    expect(html).not.toContain("convection-expression");
  });

  it("shows a derived axial-position hint when the pipe path can supply z", () => {
    const config: NetworkConfig = {
      ...makeConfig({
        kind: "convection",
        area: 0.01,
        correlation: { model: "dittusBoelter", diameter: 0.02 },
      }),
      nodes: [
        {
          id: "in",
          type: "boundary",
          x: 0,
          y: 0,
          position: { x: 0 },
          pressure: 2e5,
          temperature: 300,
        },
        {
          id: "f1",
          type: "internal",
          x: 50,
          y: 0,
          position: { x: 1 },
          pressure: 1.5e5,
          temperature: 300,
          volume: 1e-3,
        },
        {
          id: "out",
          type: "boundary",
          x: 100,
          y: 0,
          position: { x: 2 },
          pressure: 1e5,
          temperature: 300,
        },
      ],
      solidNodes: [
        {
          id: "w1",
          type: "solid",
          x: 50,
          y: 40,
          position: { x: 1 },
          temperature: 350,
          mass: 2,
          cp: 500,
        },
      ],
      branches: [
        {
          id: "p1",
          from: "in",
          to: "f1",
          component: {
            type: "pipe",
            length: 1,
            diameter: 0.02,
            roughness: 1e-5,
          },
        },
        {
          id: "p2",
          from: "f1",
          to: "out",
          component: {
            type: "pipe",
            length: 1,
            diameter: 0.02,
            roughness: 1e-5,
          },
        },
      ],
    };
    const html = renderSsr("panel", config, conductorSel);
    expect(html).toContain('data-testid="convection-axial-position-derived"');
    expect(html).toContain("from path, 1 m");
  });

  it("Darr–Hartwig exposes diameter, axial position and optional inlet Re / flow area", () => {
    const config = makeConfig(
      convectionTypeForModel("darrHartwig", convectionOf(makeConfig())),
    );
    const html = renderSsr("panel", config, conductorSel);
    expect(html).toContain('<option value="darrHartwig" selected=""');
    expect(html).toContain('data-testid="convection-diameter"');
    expect(html).toContain('data-testid="convection-axial-position"');
    expect(html).toContain("Axial position z");
    expect(html).not.toContain("Axial position z (optional)");
    expect(html).toContain('data-testid="convection-inlet-re"');
    expect(html).toContain('data-testid="convection-flow-area"');
    // Literature/fit-envelope prose removed (see docs).
    expect(html).not.toContain("convection-summary");
    expect(html).not.toContain("NTRS");
    // ttWf-only fields stay hidden.
    expect(html).not.toContain("Segment length");
    expect(html).not.toContain("convection-fluid-front");
  });

  it("TT-WF exposes the full subcell-front parameter set with bounds and hard requirements", () => {
    const config = makeConfig(
      convectionTypeForModel("ttWf", convectionOf(makeConfig())),
    );
    const html = renderSsr("panel", config, conductorSel);
    expect(html).toContain('<option value="ttWf" selected=""');
    expect(html).toContain("Segment length");
    expect(html).toContain('data-testid="convection-front-energy"');
    expect(html).toContain('data-testid="convection-rewet-hysteresis"');
    expect(html).toContain('data-testid="convection-fluid-front"');
    // Concise requirement note covers the non-panel requirements.
    expect(html).toContain('data-testid="convection-warning"');
    expect(html).toContain("transient mode");
    expect(html).not.toContain("convection-summary");
  });

  it("an h equation stays in the h box, with the solver scope and params under it", () => {
    const config = makeConfig({
      kind: "convection",
      area: 0.01,
      correlation: {
        model: "custom",
        expression: "0.023 * (G * D / mu)^0.8 * Pr^0.4 * k / D",
        params: { scale: 1 },
      },
    });
    const html = renderSsr("panel", config, conductorSel);
    // Still the specified-h entry: an equation is not a different model.
    expect(html).toContain('<option value="specified" selected=""');
    expect(html).toContain('data-testid="convection-h"');
    expect(html).toContain("0.023 * (G * D / mu)^0.8 * Pr^0.4 * k / D");
    // The scope note replaces the removed standalone expression editor.
    expect(html).toContain("Evaluated in SI at every h refresh.");
    expect(html).toContain("Re, quality");
    expect(html).not.toContain("convection-expression");
    expect(html).not.toContain("h (fallback floor)");
    expect(html).toContain('data-testid="convection-params"');
    expect(html).toContain("{&quot;scale&quot;:1}");
    expect(html).toContain("param(&#x27;name&#x27;)"); // params label format note
    // No static preview: the solver alone can resolve this source.
    expect(html).not.toContain("convection-h-preview");
    expect(html).not.toContain("convection-scope-help");
    expect(html).not.toContain("convection-summary");
    expect(html).not.toContain("convection-warning");
    // Diameter is opt-in: toggle shown, field hidden until set.
    expect(html).toContain('data-testid="convection-diameter-toggle"');
    expect(html).not.toContain('data-testid="convection-diameter"');
  });

  it("an h equation with a diameter set shows the formula-capable diameter field", () => {
    const config = makeConfig({
      kind: "convection",
      area: 0.01,
      correlation: {
        model: "custom",
        expression: "Re * 0.1",
        diameter: { expr: "pipe('seg1').diameter" },
      },
    });
    const html = renderSsr("panel", config, conductorSel);
    expect(html).toContain('data-testid="convection-diameter"');
    expect(html).not.toContain("convection-diameter-formula-badge");
  });

  it("a static h equation previews in the same box, with no correlation chrome", () => {
    const config = makeConfig(boundH("2 * 125"));
    const html = renderSsr("panel", config, conductorSel);
    expect(html).toContain('<option value="specified" selected=""');
    expect(html).toContain('data-testid="convection-h-preview"');
    expect(html).not.toContain("convection-params");
    expect(html).not.toContain("convection-diameter");
  });

  it("a malformed stored equation is shown (never blank) and flagged", () => {
    const config = makeConfig({
      kind: "convection",
      area: 0.01,
      correlation: { model: "custom", expression: "Re +" },
    });
    const html = renderSsr("panel", config, conductorSel);
    expect(html).toContain("Re +");
    expect(html).toContain('data-testid="convection-h-equation-error"');
    expect(html).toContain('role="alert"');
  });

  it("Model Table names the correlation model", () => {
    const config = makeConfig({
      kind: "convection",
      area: 0.01,
      correlation: { model: "dittusBoelter", diameter: 0.05 },
    });
    const html = renderSsr("table", config, { kind: "none" });
    expect(html).toContain("Dittus–Boelter");
    expect(html).toContain("h floor");
  });

  it("Model Table keeps the legacy constant-h summary", () => {
    const html = renderSsr("table", makeConfig(), { kind: "none" });
    expect(html).toContain("h 100");
  });

  it("Model Table shows a specified h equation as the h it is", () => {
    const runtime = renderSsr(
      "table",
      makeConfig({
        kind: "convection",
        area: 0.01,
        correlation: { model: "custom", expression: "Re * 0.1" },
      }),
      { kind: "none" },
    );
    expect(runtime).toContain("h ƒRe * 0.1");
    expect(runtime).not.toContain("custom h");
    const staticH = renderSsr("table", makeConfig(boundH("2 * 125")), {
      kind: "none",
    });
    expect(staticH).toContain("h ƒ2 * 125");
  });
});

/* ------------------------------------------------------------------ */
/* Store integration: one undoable update per switch                   */
/* ------------------------------------------------------------------ */

describe("convection model switches through the store", () => {
  beforeEach(() => resetStore(makeConfig()));
  const s = () => useStore.getState();
  const type = () => convectionOf(s().config);

  /** The panel's own patch semantics: a key set to undefined is REMOVED. */
  const patchType = (patch: Record<string, unknown>) => {
    const merged: Record<string, unknown> = { ...type(), ...patch };
    for (const key of Object.keys(merged)) {
      if (merged[key] === undefined) delete merged[key];
    }
    s().updateConductor("c1", { type: merged as ConvectionType });
  };

  it("specified h → Dittus–Boelter is one undo step with valid defaults", () => {
    patchType(convectionTypeForModel("dittusBoelter", type()));
    expect(type().correlation).toEqual({
      model: "dittusBoelter",
      diameter: 0.05,
    });
    expect(type().h).toBe(100); // preserved as the fallback floor
    expect(s().modelText).toBe(serializeText(s().config));
    s().undo();
    expect(type()).toEqual({ kind: "convection", h: 100, area: 0.01 });
    s().redo();
    expect(type().correlation?.model).toBe("dittusBoelter");
  });

  it("Dittus–Boelter → specified h clears the correlation the panel patched in", () => {
    patchType(convectionTypeForModel("dittusBoelter", type()));
    expect(type().correlation?.model).toBe("dittusBoelter");
    // Selecting specified h used to leave the correlation behind (the patch
    // merged over it), so the selector snapped back to the old model.
    patchType(convectionTypeForModel("specified", type()));
    expect(type()).toEqual({ kind: "convection", h: 100, area: 0.01 });
    expect(convectionModelOf(type())).toBe("specified");
    expect(s().modelText).toBe(serializeText(s().config));
    s().undo();
    expect(type().correlation?.model).toBe("dittusBoelter");
  });

  it("an h equation typed in the box replaces h with a custom correlation, and back", () => {
    patchType(convectionTypeForSpecifiedH({ expr: "0.023 * Re^0.8" }, type()));
    expect(type()).toEqual({
      kind: "convection",
      area: 0.01,
      correlation: { model: "custom", expression: "0.023 * Re^0.8" },
    });
    expect(convectionModelOf(type())).toBe("specified");
    expect(s().modelText).toBe(serializeText(s().config));
    // Typing a plain number again leaves no correlation behind.
    patchType(convectionTypeForSpecifiedH(750, type()));
    expect(type()).toEqual({ kind: "convection", h: 750, area: 0.01 });
    s().undo();
    expect(type().correlation?.expression).toBe("0.023 * Re^0.8");
  });

  it("axialPosition set on Dittus–Boelter is kept when switching to Darr–Hartwig", () => {
    s().updateConductor("c1", {
      type: convectionTypeForModel("dittusBoelter", type()),
    });
    const dbCorr = type().correlation!;
    s().updateConductor("c1", {
      type: { ...type(), correlation: { ...dbCorr, axialPosition: 3.25 } },
    });
    expect(type().correlation).toMatchObject({
      model: "dittusBoelter",
      axialPosition: 3.25,
      diameter: 0.05,
    });
    s().updateConductor("c1", {
      type: convectionTypeForModel("darrHartwig", type()),
    });
    expect(type().correlation).toMatchObject({
      model: "darrHartwig",
      axialPosition: 3.25,
      diameter: 0.05,
    });
  });
});

/* ------------------------------------------------------------------ */
/* Text save/load round-trip                                           */
/* ------------------------------------------------------------------ */

describe("convection correlation persistence", () => {
  it("every model shape round-trips through the text format unchanged", () => {
    const shapes: Convection[] = [
      { kind: "convection", h: 100, area: 0.01 },
      {
        kind: "convection",
        h: 25,
        area: { expr: "pipe('seg1').surfaceArea" },
        correlation: { model: "dittusBoelter", diameter: 0.05 },
      },
      {
        kind: "convection",
        area: 0.01,
        correlation: { model: "miropolskii", diameter: 0.05, flowArea: 2e-3 },
      },
      {
        kind: "convection",
        h: 10,
        area: 0.01,
        correlation: {
          model: "darrHartwig",
          diameter: 0.05,
          axialPosition: 1.5,
          inletLiquidReynolds: 4e4,
        },
      },
      {
        kind: "convection",
        area: 0.01,
        correlation: {
          model: "ttWf",
          diameter: 0.05,
          axialPosition: 1.5,
          segmentLength: 0.5,
          frontEnergyFactor: 1,
          rewetHysteresisOffsetK: 2,
          fluidFront: true,
        },
      },
      {
        kind: "convection",
        h: 50,
        area: 0.01,
        correlation: {
          model: "custom",
          expression: "0.023 * (G * D / mu)^0.8 * Pr^0.4 * k / D",
          params: { scale: 1 },
          diameter: { expr: "0.04 + 0.01" },
        },
      },
    ];
    for (const shape of shapes) {
      // realFluid fixture so the named models pass validate.ts inside
      // parseText (static name check only — no WASM needed); round-trip
      // once so the comparison shape matches what parseText produces.
      const seed = makeConfig(shape);
      seed.fluid = { model: "realFluid", params: { fluidName: "Nitrogen" } };
      // A pipe for the area formula's surfaceArea reference to resolve.
      seed.nodes.push({
        id: "f2",
        type: "boundary",
        x: 200,
        y: 200,
        pressure: 1e5,
        temperature: 300,
      });
      seed.branches.push({
        id: "seg1",
        from: "f1",
        to: "f2",
        component: { type: "pipe", length: 1, diameter: 0.05, roughness: 1e-5 },
      });
      const config = parseText(serializeText(seed)).config!;
      const text = serializeText(config);
      const result = parseText(text);
      expect(result.errors).toEqual([]);
      expect(result.config).toStrictEqual(config);
      // The correlation object survives VERBATIM in the text payload.
      if (shape.correlation !== undefined) {
        expect(text).toContain(`"model":"${shape.correlation.model}"`);
      }
    }
  });
});
