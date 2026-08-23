/**
 * SolidPropertyField — the two NEW modes (Temperature equation and Time
 * table) on top of the legacy Constant | Material | Temperature table set
 * (solidPropertyField.test.tsx covers those three; this file covers the
 * `{ expression, tRange }` and `{ timeTable }` schema shapes).
 *
 * Layers covered:
 *  - pure helpers: specMode/specForMode/specValueAt/specSummaryShort for
 *    the new shapes (hand-authored specs no longer render blank);
 *  - SSR markup per mode (expression editor + tRange + preview; time-table
 *    grid + accepted-step/steady-rejection hint; inline core validation);
 *  - store integration: exact schema shapes, one undo step per switch,
 *    modelText === serializeText(config);
 *  - text save/load round-trip of the new shapes.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { renderToString } from "react-dom/server";
import { useStore } from "../store";
import PropertyPanel from "../components/PropertyPanel";
import ModelTableView from "../components/ModelTableView";
import {
  specForMode,
  specMode,
  specSummaryShort,
  specValueAt,
} from "../solidPropertyUi";
import { validateSolidPropertySpec, type SolidPropertySpec } from "../../core";
import { serializeText, parseText } from "../../substrate/textProjection";
import type { NetworkConfig, Selection } from "../types";

/* ------------------------------------------------------------------ */
/* Fixtures + harness (mirrors solidPropertyField.test.tsx)            */
/* ------------------------------------------------------------------ */

function makeConfig(over: {
  cp?: SolidPropertySpec;
  k?: SolidPropertySpec;
  mode?: "steady" | "transient";
}): NetworkConfig {
  const { cp = 500, k = 400, mode = "transient" } = over;
  return {
    meta: { name: "Solid property modes", version: 2 },
    settings:
      mode === "transient"
        ? { mode, dt: 1, endTime: 10, tolerance: 1e-6, maxIterations: 50 }
        : { mode, tolerance: 1e-6, maxIterations: 50 },
    fluid: { model: "incompressible", preset: "water" },
    nodes: [
      {
        id: "f1",
        type: "boundary",
        x: 0,
        y: 200,
        pressure: 1e5,
        temperature: 300,
      },
    ],
    solidNodes: [
      { id: "s1", type: "solid", x: 0, y: 100, temperature: 300, mass: 2, cp },
      { id: "amb", type: "ambient", x: 200, y: 100, temperature: 290 },
    ],
    conductors: [
      {
        id: "c1",
        from: "s1",
        to: "amb",
        type: { kind: "conduction", k, area: 0.01, length: 0.1 },
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

const solidSel: Selection = { kind: "solidNode", id: "s1" };
const conductorSel: Selection = { kind: "conductor", id: "c1" };

/* ------------------------------------------------------------------ */
/* Pure helpers                                                        */
/* ------------------------------------------------------------------ */

describe("solidPropertyUi — new modes", () => {
  it("specMode maps every nonnumeric schema shape to its own mode (never blank)", () => {
    expect(specMode({ expression: "385", tRange: [100, 400] })).toBe(
      "expression",
    );
    expect(
      specMode({
        timeTable: [
          [0, 500],
          [100, 500],
        ],
      }),
    ).toBe("timeTable");
    // Legacy shapes unchanged.
    expect(specMode(385)).toBe("constant");
    expect(
      specMode({
        table: [
          [77, 190],
          [300, 385],
        ],
      }),
    ).toBe("table");
    expect(specMode({ material: "ofhc-copper" })).toBe("material");
    expect(specMode(undefined)).toBe("constant");
  });

  it("specForMode expression keeps a current expression (copied)", () => {
    const current: SolidPropertySpec = {
      expression: "T * 2",
      tRange: [4, 300],
    };
    const next = specForMode("expression", current, "cp", 300);
    expect(next).toEqual(current);
    expect(next).not.toBe(current);
  });

  it("specForMode expression seeds a constant expression from the derivable value", () => {
    expect(specForMode("expression", 385, "cp", 300)).toEqual({
      expression: "385",
      tRange: [150, 600],
    });
    // From a table: value at the reference temperature.
    expect(
      specForMode(
        "expression",
        {
          table: [
            [100, 200],
            [300, 400],
          ],
        },
        "cp",
        300,
      ),
    ).toEqual({
      expression: "400",
      tRange: [150, 600],
    });
    // Cryogenic reference keeps the window positive.
    expect(specForMode("expression", 8, "cp", 20)).toEqual({
      expression: "8",
      tRange: [10, 40],
    });
    // Nothing derivable: property default.
    expect(specForMode("expression", undefined, "k", NaN)).toEqual({
      expression: "1",
      tRange: [150, 600],
    });
  });

  it("specForMode timeTable seeds a flat 2-point curve and keeps an existing one", () => {
    expect(specForMode("timeTable", 500, "cp", 300)).toEqual({
      timeTable: [
        [0, 500],
        [100, 500],
      ],
    });
    const current: SolidPropertySpec = {
      timeTable: [
        [0, 190],
        [50, 385],
      ],
    };
    const next = specForMode("timeTable", current, "cp", 300);
    expect(next).toEqual(current);
    expect(next).not.toBe(current);
  });

  it("specValueAt evaluates an expression spec at T and stays undefined for time tables", () => {
    expect(
      specValueAt({ expression: "100 + T", tRange: [1, 1000] }, "cp", 300),
    ).toBe(400);
    expect(
      specValueAt(
        {
          timeTable: [
            [0, 500],
            [100, 500],
          ],
        },
        "cp",
        300,
      ),
    ).toBeUndefined();
  });

  it("summaries name every mode unambiguously", () => {
    expect(specSummaryShort({ expression: "385", tRange: [100, 400] })).toBe(
      "T equation",
    );
    expect(
      specSummaryShort({
        timeTable: [
          [0, 500],
          [100, 500],
        ],
      }),
    ).toBe("2-pt time table");
  });

  it("seeded defaults pass core validation (transient for timeTable)", () => {
    const expr = specForMode("expression", 385, "cp", 300);
    expect(validateSolidPropertySpec(expr, "cp", "Solid node s1")).toEqual([]);
    const tt = specForMode("timeTable", 500, "cp", 300);
    expect(validateSolidPropertySpec(tt, "cp", "Solid node s1")).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* SSR: per-mode panel markup                                          */
/* ------------------------------------------------------------------ */

describe("PropertyPanel solid cp — new modes (SSR)", () => {
  it("the mode selector offers all five modes", () => {
    const html = renderSsr("panel", makeConfig({ cp: 500 }), solidSel);
    for (const option of [
      "Constant",
      "Material",
      "Temperature table",
      "Temperature equation",
      "Time table",
    ]) {
      expect(html).toContain(`>${option}</option>`);
    }
  });

  it("expression mode renders the editor, tRange inputs, scope help and a value preview", () => {
    const html = renderSsr(
      "panel",
      makeConfig({ cp: { expression: "100 + T", tRange: [150, 600] } }),
      solidSel,
    );
    expect(html).toContain('<option value="expression" selected=""');
    expect(html).toContain('data-testid="solid-cp-expression"');
    expect(html).toContain('value="100 + T"');
    expect(html).toContain('data-testid="solid-cp-trange-min"');
    expect(html).toContain('data-testid="solid-cp-trange-max"');
    expect(html).toContain('value="150"');
    expect(html).toContain('value="600"');
    // Scope help + preview at the reference T (node temperature 300 K).
    expect(html).toContain("Scope: T [K]");
    expect(html).toContain('data-testid="solid-cp-expression-preview"');
    expect(html).toContain("≈ 400 J/(kg·K)");
    expect(html).not.toContain('role="alert"');
  });

  it("expression mode surfaces core validation inline (parse, tRange, sampling)", () => {
    // Parse error
    let html = renderSsr(
      "panel",
      makeConfig({ cp: { expression: "1 +", tRange: [150, 600] } }),
      solidSel,
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain("failed to parse");

    // Inverted range
    html = renderSsr(
      "panel",
      makeConfig({ cp: { expression: "385", tRange: [600, 150] } }),
      solidSel,
    );
    expect(html).toContain("tRange must be increasing");

    // Non-positive over the range (sampler probes the whole window)
    html = renderSsr(
      "panel",
      makeConfig({ cp: { expression: "T - 400", tRange: [150, 600] } }),
      solidSel,
    );
    expect(html).toContain("finite and positive");
  });

  it("time-table mode renders the time×property grid with the endpoint-freeze hint", () => {
    const html = renderSsr(
      "panel",
      makeConfig({
        cp: {
          timeTable: [
            [0, 500],
            [100, 400],
          ],
        },
      }),
      solidSel,
    );
    expect(html).toContain('<option value="timeTable" selected=""');
    expect(html).toContain('data-testid="solid-cp-time-table"');
    expect(html).toContain('data-testid="solid-cp-time-table-head-x"');
    expect(html).toContain("Time (s)");
    expect(html).toContain("cp (J/(kg·K))");
    const hint = html.split('data-testid="solid-cp-time-table-info"')[1] ?? "";
    expect(hint).toContain("accepted step");
    expect(hint).toContain("steady solves reject time tables");
    expect(html).not.toContain('role="alert"');
  });

  it("time-table mode surfaces core time-domain validation inline", () => {
    const html = renderSsr(
      "panel",
      makeConfig({
        cp: {
          timeTable: [
            [100, 500],
            [50, 400],
          ],
        },
      }),
      solidSel,
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain("strictly increasing");
  });

  it("conduction k supports the equation mode with the k unit labels", () => {
    const html = renderSsr(
      "panel",
      makeConfig({
        k: { expression: "400 * (T / 300)^0.5", tRange: [4, 600] },
      }),
      conductorSel,
    );
    expect(html).toContain('data-testid="conductor-k-expression"');
    expect(html).toContain("k(T) expression");
    expect(html).toContain("(W/(m·K), T in K)");
    expect(html).not.toContain('role="alert"');
  });

  it("Model Table names the new modes", () => {
    let html = renderSsr(
      "table",
      makeConfig({ cp: { expression: "385", tRange: [100, 400] } }),
      { kind: "none" },
    );
    expect(html).toContain("T equation");
    html = renderSsr(
      "table",
      makeConfig({
        cp: {
          timeTable: [
            [0, 500],
            [50, 400],
            [100, 385],
          ],
        },
      }),
      { kind: "none" },
    );
    expect(html).toContain("3-pt time table");
  });
});

/* ------------------------------------------------------------------ */
/* Store integration                                                   */
/* ------------------------------------------------------------------ */

describe("new-mode commits through the store", () => {
  beforeEach(() => resetStore(makeConfig({ cp: 500, k: 400 })));
  const s = () => useStore.getState();
  const solidCp = () => s().config.solidNodes![0].cp;

  it("selecting Temperature equation stores exactly { expression, tRange } and is undoable", () => {
    s().updateSolidNode("s1", {
      cp: specForMode("expression", solidCp(), "cp", 300),
    });
    expect(solidCp()).toEqual({ expression: "500", tRange: [150, 600] });
    expect(s().modelText).toBe(serializeText(s().config));
    expect(s().modelText).toContain(
      '"cp":{"expression":"500","tRange":[150,600]}',
    );
    s().undo();
    expect(solidCp()).toBe(500);
  });

  it("selecting Time table stores exactly { timeTable } and is undoable", () => {
    s().updateSolidNode("s1", {
      cp: specForMode("timeTable", solidCp(), "cp", 300),
    });
    expect(solidCp()).toEqual({
      timeTable: [
        [0, 500],
        [100, 500],
      ],
    });
    s().undo();
    expect(solidCp()).toBe(500);
    s().redo();
    expect(solidCp()).toEqual({
      timeTable: [
        [0, 500],
        [100, 500],
      ],
    });
  });

  it("expression edits keep the shape and stay text-synced", () => {
    s().updateSolidNode("s1", {
      cp: specForMode("expression", solidCp(), "cp", 300),
    });
    const cur = solidCp() as { expression: string; tRange: [number, number] };
    s().updateSolidNode("s1", {
      cp: { expression: "480 + 0.1 * T", tRange: cur.tRange },
    });
    expect(solidCp()).toEqual({
      expression: "480 + 0.1 * T",
      tRange: [150, 600],
    });
    expect(s().modelText).toBe(serializeText(s().config));
  });
});

/* ------------------------------------------------------------------ */
/* Text save/load round-trip                                           */
/* ------------------------------------------------------------------ */

describe("new-shape persistence", () => {
  it("expression and timeTable specs round-trip through the text format unchanged", () => {
    const seed = makeConfig({
      cp: { expression: "385 * (T / 300)^0.1", tRange: [4, 300] },
    });
    const c1 = seed.conductors![0];
    if (c1.type.kind === "conduction") {
      c1.type.k = {
        timeTable: [
          [0, 400],
          [50, 350],
          [100, 320],
        ],
      };
    }
    // validate.ts (inside parseText) requires at least one branch.
    seed.nodes.push({
      id: "f2",
      type: "boundary",
      x: 100,
      y: 200,
      pressure: 1e5,
      temperature: 300,
    });
    seed.branches.push({
      id: "b1",
      from: "f1",
      to: "f2",
      component: { type: "flowSource", massFlow: 0 },
    });
    const config = parseText(serializeText(seed)).config!;
    const text = serializeText(config);
    expect(text).toContain(
      '"cp":{"expression":"385 * (T / 300)^0.1","tRange":[4,300]}',
    );
    expect(text).toContain('"k":{"timeTable":[[0,400],[50,350],[100,320]]}');
    const result = parseText(text);
    expect(result.errors).toEqual([]);
    expect(result.config).toStrictEqual(config);
  });
});
