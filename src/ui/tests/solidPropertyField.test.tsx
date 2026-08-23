/**
 * SolidPropertyField / solidPropertyUi tests — the PropertyPanel mode
 * selector for solid-node cp and conduction k (Constant | Material |
 * Temperature table).
 *
 * Layers covered:
 *  - pure helpers (specMode / specForMode / specValueAt / summaries) —
 *    exact schema shapes on every mode switch;
 *  - SSR markup of PropertyPanel/ModelTableView per mode (vitest runs in
 *    node with no DOM renderer, so renderToString + markup assertions,
 *    matching convergenceDiarySection.test.tsx).  SSR caveat: zustand v5's
 *    useSyncExternalStore server snapshot is the store's INITIAL state, so
 *    setState() is invisible to renderToString — the SSR helpers below
 *    assign a fresh config/selection onto the initial-state object instead.
 *    Interaction itself (clicking the selector) is e2e territory; the
 *    committed shapes it would produce are covered by the pure/store tests.
 *  - store integration: mode commits land as exact SolidPropertySpec shapes,
 *    stay undoable, and keep modelText === serializeText(config);
 *  - text save/load round-trip of all three spec shapes alongside a formula
 *    binding (formula cache stays lossless).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { renderToString } from "react-dom/server";
import { useStore } from "../store";
import PropertyPanel from "../components/PropertyPanel";
import ModelTableView from "../components/ModelTableView";
import {
  SOLID_PROPERTY_INFO,
  materialLabel,
  specForMode,
  specMode,
  specSummaryShort,
  specValueAt,
  tableRangeK,
} from "../solidPropertyUi";
import {
  getSolidMaterialTable,
  SOLID_MATERIALS,
  type SolidPropertySpec,
} from "../../core";
import { serializeText, parseText } from "../../substrate/textProjection";
import type { NetworkConfig, Selection } from "../types";

/* ------------------------------------------------------------------ */
/* Pure helpers                                                        */
/* ------------------------------------------------------------------ */

describe("solidPropertyUi helpers", () => {
  it("specMode derives the mode from the spec shape", () => {
    expect(specMode(undefined)).toBe("constant");
    expect(specMode(385)).toBe("constant");
    expect(specMode({ material: "ofhc-copper" })).toBe("material");
    expect(
      specMode({
        table: [
          [77, 190],
          [300, 385],
        ],
      }),
    ).toBe("table");
  });

  it("specForMode constant keeps a current constant verbatim", () => {
    expect(specForMode("constant", 385, "cp", 300)).toBe(385);
  });

  it("specForMode constant evaluates a table/material at the reference temperature", () => {
    // Linear table 200@100 K → 400@300 K: value at 150 K is 250.
    expect(
      specForMode(
        "constant",
        {
          table: [
            [100, 200],
            [300, 400],
          ],
        },
        "cp",
        150,
      ),
    ).toBe(250);
    // Below the knot range the table clamps to the end knot.
    expect(
      specForMode(
        "constant",
        {
          table: [
            [100, 200],
            [300, 400],
          ],
        },
        "cp",
        50,
      ),
    ).toBe(200);
    // Material constant seed ≈ OFHC copper cp(300 K) ≈ 385–390 J/(kg·K).
    const v = specForMode("constant", { material: "ofhc-copper" }, "cp", 300);
    expect(typeof v).toBe("number");
    expect(v as number).toBeGreaterThan(380);
    expect(v as number).toBeLessThan(395);
  });

  it("specForMode constant falls back to the property default when nothing derivable", () => {
    expect(specForMode("constant", undefined, "cp", 300)).toBe(
      SOLID_PROPERTY_INFO.cp.defaultConstant,
    );
    expect(specForMode("constant", undefined, "k", 300)).toBe(
      SOLID_PROPERTY_INFO.k.defaultConstant,
    );
    expect(specForMode("constant", { material: "nope" }, "cp", 300)).toBe(
      SOLID_PROPERTY_INFO.cp.defaultConstant,
    );
  });

  it("specForMode material writes exactly { material: key }", () => {
    expect(specForMode("material", 385, "cp", 300)).toEqual({
      material: "ofhc-copper",
    });
    expect(
      specForMode(
        "material",
        {
          table: [
            [100, 200],
            [300, 400],
          ],
        },
        "k",
        300,
      ),
    ).toEqual({ material: "ofhc-copper" });
    // A known current material survives; an unknown one is replaced.
    expect(
      specForMode("material", { material: "ofhc-copper" }, "cp", 300),
    ).toEqual({ material: "ofhc-copper" });
    expect(specForMode("material", { material: "nope" }, "cp", 300)).toEqual({
      material: "ofhc-copper",
    });
  });

  it("specForMode table from a constant seeds a flat 2-point table around the reference temperature", () => {
    expect(specForMode("table", 500, "cp", 300)).toEqual({
      table: [
        [150, 500],
        [600, 500],
      ],
    });
    expect(specForMode("table", 400, "k", 300)).toEqual({
      table: [
        [150, 400],
        [600, 400],
      ],
    });
    // Cryogenic reference temperature: window scales with it and stays positive.
    expect(specForMode("table", 8, "cp", 20)).toEqual({
      table: [
        [10, 8],
        [40, 8],
      ],
    });
    // Unset spec: property default value, 300 K fallback reference.
    expect(specForMode("table", undefined, "cp", NaN)).toEqual({
      table: [
        [150, SOLID_PROPERTY_INFO.cp.defaultConstant],
        [600, SOLID_PROPERTY_INFO.cp.defaultConstant],
      ],
    });
  });

  it("specForMode table from a material seeds the material curve endpoint knots", () => {
    const spec = specForMode("table", { material: "ofhc-copper" }, "cp", 300);
    const knots = getSolidMaterialTable("ofhc-copper", "cp");
    expect(spec).toEqual({
      table: [
        [knots[0][0], knots[0][1]],
        [knots[knots.length - 1][0], knots[knots.length - 1][1]],
      ],
    });
  });

  it("specForMode table keeps a current table (copied, not aliased)", () => {
    const current: SolidPropertySpec = {
      table: [
        [77, 190],
        [300, 385],
      ],
    };
    const next = specForMode("table", current, "cp", 300);
    expect(next).toEqual(current);
    expect(next).not.toBe(current);
    expect((next as { table: [number, number][] }).table[0]).not.toBe(
      (current as { table: [number, number][] }).table[0],
    );
  });

  it("specValueAt reads constants, tables (clamped) and materials", () => {
    expect(specValueAt(385, "cp", 300)).toBe(385);
    expect(
      specValueAt(
        {
          table: [
            [100, 200],
            [300, 400],
          ],
        },
        "cp",
        200,
      ),
    ).toBe(300);
    expect(
      specValueAt(
        {
          table: [
            [100, 200],
            [300, 400],
          ],
        },
        "cp",
        1000,
      ),
    ).toBe(400);
    const m = specValueAt({ material: "ofhc-copper" }, "k", 300);
    expect(m).toBeGreaterThan(390); // OFHC k(300 K) ≈ 396 W/(m·K)
    expect(m).toBeLessThan(405);
    expect(specValueAt({ material: "nope" }, "cp", 300)).toBeUndefined();
  });

  it("summaries and labels are unambiguous about the mode", () => {
    expect(specSummaryShort(385)).toBe("385");
    expect(specSummaryShort({ expr: "reg('hgThroat')" })).toBe("formula");
    expect(
      specSummaryShort({
        table: [
          [77, 190],
          [300, 385],
        ],
      }),
    ).toBe("2-pt table");
    expect(specSummaryShort({ material: "ofhc-copper" })).toBe("OFHC copper");
    expect(specSummaryShort(undefined)).toBe("—");
    expect(
      tableRangeK({
        table: [
          [77, 190],
          [300, 385],
        ],
      }),
    ).toEqual([77, 300]);
    expect(tableRangeK(385)).toBeNull();
    expect(materialLabel("ofhc-copper")).toBe("OFHC copper");
    expect(materialLabel("grcop-84")).toBe("GRCop-84");
    expect(materialLabel("unknown-key")).toBe("unknown-key");
    // Expanded catalogue labels (registry keys stay the stored value).
    expect(materialLabel("aluminum-6061-t6")).toBe("Aluminum 6061-T6");
    expect(materialLabel("stainless-steel-304")).toBe("Stainless steel 304");
    expect(materialLabel("stainless-steel-316")).toBe("Stainless steel 316");
    expect(materialLabel("inconel-718")).toBe("Inconel 718");
    expect(materialLabel("ptfe")).toBe("PTFE (Teflon)");
    expect(materialLabel("g10-cr-normal")).toBe("G-10 CR (normal direction)");
    expect(materialLabel("g10-cr-warp")).toBe("G-10 CR (warp direction)");
    // Every registry entry has a human-facing label (no raw-key fallback).
    for (const key of Object.keys(SOLID_MATERIALS)) {
      expect(materialLabel(key)).not.toBe(key);
    }
  });

  it("specValueAt honours each material’s own validity range (clamp at the ends)", () => {
    // Inconel 718 starts at 298 K: below that the 298 K value is returned.
    const inCp = specValueAt({ material: "inconel-718" }, "cp", 250);
    const inCp298 = specValueAt({ material: "inconel-718" }, "cp", 298);
    expect(inCp).toBe(inCp298);
    // GRCop-84 starts at 296 K.
    const gr = specValueAt({ material: "grcop-84" }, "k", 250);
    const gr296 = specValueAt({ material: "grcop-84" }, "k", 296);
    expect(gr).toBe(gr296);
    // Stainless 304 composite reaches 1600 K (ANL-75-55 above 300 K).
    const ss = specValueAt({ material: "stainless-steel-304" }, "k", 1200);
    expect(ss).toBeGreaterThan(25); // ANL-75-55 304L: k(1200 K) ≈ 27.4 W/(m·K) pre-blend level
    expect(ss).toBeLessThan(30);
  });
});

/* ------------------------------------------------------------------ */
/* Fixtures + SSR harness                                              */
/* ------------------------------------------------------------------ */

function makeConfig(over: {
  cp?: SolidPropertySpec;
  k?: SolidPropertySpec;
  solidType?: "solid" | "ambient";
}): NetworkConfig {
  const { cp = 500, k = 400, solidType = "solid" } = over;
  return {
    meta: { name: "Solid property UI", version: 2 },
    settings: {
      mode: "transient",
      dt: 1,
      endTime: 10,
      tolerance: 1e-6,
      maxIterations: 50,
    },
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
      {
        id: "s1",
        type: solidType,
        x: 0,
        y: 100,
        temperature: 300,
        mass: 2,
        cp,
      },
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

/** Client-path store reset (store integration tests drive real actions). */
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

/**
 * SSR-path store setup: renderToString resolves useStore selectors against
 * the store's INITIAL state (zustand v5 getServerSnapshot), so the initial
 * state object is assigned (never mutated piecemeal) per render.
 */
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
  // React SSR splits adjacent text nodes with <!-- --> separators; strip
  // them so assertions can match natural text ("2 points, 77–300 K").
  return html.replace(/<!-- -->/g, "");
}

const solidSel: Selection = { kind: "solidNode", id: "s1" };
const conductorSel: Selection = { kind: "conductor", id: "c1" };

/* ------------------------------------------------------------------ */
/* SSR: per-mode PropertyPanel markup                                  */
/* ------------------------------------------------------------------ */

describe("PropertyPanel solid cp modes (SSR)", () => {
  it("constant mode keeps the legacy numeric field unchanged", () => {
    const html = renderSsr("panel", makeConfig({ cp: 500 }), solidSel);
    expect(html).toContain('data-testid="solid-cp-mode"');
    expect(html).toContain('<option value="constant" selected=""');
    // Legacy NumberField: same label, unit note and committed value as before.
    expect(html).toContain("J/kg·K");
    expect(html).toContain('value="500"');
    // No material/table chrome in constant mode.
    expect(html).not.toContain("solid-cp-material");
    expect(html).not.toContain("solid-cp-table");
    expect(html).not.toContain('role="alert"');
  });

  it("material mode shows the dropdown, provenance, validity range and clamping", () => {
    const html = renderSsr(
      "panel",
      makeConfig({ cp: { material: "ofhc-copper" } }),
      solidSel,
    );
    expect(html).toContain('<option value="material" selected=""');
    expect(html).toContain('data-testid="solid-cp-material"');
    expect(html).toContain("OFHC copper");
    const info = html.split('data-testid="solid-cp-material-info"')[1] ?? "";
    expect(info).toContain("NIST");
    expect(info).toContain("4–300 K");
    expect(info).toContain("clamped");
    // cp is RRR-independent: the RRR caveat belongs to the k view only.
    expect(info).not.toContain("RRR");
    // The old empty numeric field for non-constant cp is gone entirely.
    expect(html).not.toContain("J/kg·K");
    expect(html).not.toContain('role="alert"');
  });

  it("material mode for k adds the RRR caveat", () => {
    const html = renderSsr(
      "panel",
      makeConfig({ k: { material: "ofhc-copper" } }),
      conductorSel,
    );
    expect(html).toContain('data-testid="conductor-k-material"');
    const info = html.split('data-testid="conductor-k-material-info"')[1] ?? "";
    expect(info).toContain("4–300 K");
    expect(info).toContain(
      `RRR = ${SOLID_MATERIALS["ofhc-copper"].provenance.rrrAssumed}`,
    );
  });

  it("material mode displays the expanded catalogue with per-material ranges and sources", () => {
    const html = renderSsr(
      "panel",
      makeConfig({ cp: { material: "stainless-steel-304" } }),
      solidSel,
    );
    // All catalogue entries are selectable with human-facing labels.
    for (const label of [
      "GRCop-84",
      "Aluminum 6061-T6",
      "Stainless steel 304",
      "Stainless steel 316",
      "Inconel 718",
      "PTFE (Teflon)",
      "G-10 CR (normal direction)",
      "G-10 CR (warp direction)",
    ]) {
      expect(html).toContain(label);
    }
    // Composite material: provenance names both sources and the full 4–1600 K range.
    const info = html.split('data-testid="solid-cp-material-info"')[1] ?? "";
    expect(info).toContain("NIST");
    expect(info).toContain("ANL-75-55");
    expect(info).toContain("4–1600 K");
    expect(info).toContain("clamped");

    const inHtml = renderSsr(
      "panel",
      makeConfig({ cp: { material: "inconel-718" } }),
      solidSel,
    );
    const inInfo =
      inHtml.split('data-testid="solid-cp-material-info"')[1] ?? "";
    expect(inInfo).toContain("Agazhanov");
    expect(inInfo).toContain("298–1375 K");

    const grHtml = renderSsr(
      "panel",
      makeConfig({ cp: { material: "grcop-84" } }),
      solidSel,
    );
    const grInfo =
      grHtml.split('data-testid="solid-cp-material-info"')[1] ?? "";
    expect(grInfo).toContain("NASA/CR-2000-210055");
    expect(grInfo).toContain("296–1173 K");

    const g10Html = renderSsr(
      "panel",
      makeConfig({ cp: { material: "g10-cr-warp" } }),
      solidSel,
    );
    const g10Info =
      g10Html.split('data-testid="solid-cp-material-info"')[1] ?? "";
    expect(g10Info).toContain("WARP");
    expect(g10Info).toContain("12–300 K");
  });

  it("unknown material from hand-edited text is surfaced, not silently shown as valid", () => {
    const html = renderSsr(
      "panel",
      makeConfig({ cp: { material: "nope" } }),
      solidSel,
    );
    expect(html).toContain("nope (unknown)");
    expect(html).toContain('role="alert"');
    expect(html).toContain("nope");
  });

  it("table mode renders the temperature×cp grid with SI unit headers and a clamping hint", () => {
    const html = renderSsr(
      "panel",
      makeConfig({
        cp: {
          table: [
            [77, 190],
            [300, 385],
          ],
        },
      }),
      solidSel,
    );
    expect(html).toContain('<option value="table" selected=""');
    expect(html).toContain('data-testid="solid-cp-table"');
    expect(html).toContain('data-testid="solid-cp-table-head-x"');
    expect(html).toContain("Temperature (K)");
    expect(html).toContain("cp (J/(kg·K))");
    expect(html).toContain('data-testid="solid-cp-table-add-row"');
    expect(html).toContain('data-testid="solid-cp-table-paste"');
    expect(html).toContain("2 points, 77–300 K");
    expect(html).toContain("clamped");
    expect(html).not.toContain('role="alert"');
  });

  it("table mode surfaces core validation constraints inline", () => {
    // < 2 points
    let html = renderSsr(
      "panel",
      makeConfig({ cp: { table: [[300, 385]] } }),
      solidSel,
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain("at least 2");

    // Not strictly increasing
    html = renderSsr(
      "panel",
      makeConfig({
        cp: {
          table: [
            [300, 385],
            [77, 190],
          ],
        },
      }),
      solidSel,
    );
    expect(html).toContain("strictly increasing");

    // Non-positive value
    html = renderSsr(
      "panel",
      makeConfig({
        cp: {
          table: [
            [77, -5],
            [300, 385],
          ],
        },
      }),
      solidSel,
    );
    expect(html).toContain("positive");

    // Non-positive temperature
    html = renderSsr(
      "panel",
      makeConfig({
        cp: {
          table: [
            [0, 190],
            [300, 385],
          ],
        },
      }),
      solidSel,
    );
    expect(html).toContain("positive finite K");
  });

  it("conduction k supports the same three modes; constant keeps a formula-capable k field", () => {
    // Constant: FormulaUnitInput with the thermal-conductivity unit label.
    let html = renderSsr("panel", makeConfig({ k: 400 }), conductorSel);
    expect(html).toContain('data-testid="conductor-k-mode"');
    expect(html).toContain('<option value="constant" selected=""');
    expect(html).toContain('data-testid="conductor-k-value"');
    expect(html).toContain(">400</div>");
    expect(html).toContain("W/(m·K)");
    expect(html).not.toContain("conductor-k-table");

    // Table: temperature × k grid.
    html = renderSsr(
      "panel",
      makeConfig({
        k: {
          table: [
            [4, 1000],
            [300, 396],
          ],
        },
      }),
      conductorSel,
    );
    expect(html).toContain('data-testid="conductor-k-table"');
    expect(html).toContain("k (W/(m·K))");
    expect(html).toContain("2 points, 4–300 K");
    expect(html).not.toContain('role="alert"');
  });

  it("ambient solid nodes show no cp editor at all (unchanged behaviour)", () => {
    const html = renderSsr(
      "panel",
      makeConfig({ cp: 500, solidType: "ambient" }),
      { kind: "solidNode", id: "s1" },
    );
    expect(html).not.toContain("solid-cp");
  });
});

/* ------------------------------------------------------------------ */
/* Store integration: exact schema shape, undo, text-cache sync        */
/* ------------------------------------------------------------------ */

describe("mode commits through the store", () => {
  beforeEach(() => resetStore(makeConfig({ cp: 500, k: 400 })));
  const s = () => useStore.getState();
  const solidCp = () => s().config.solidNodes![0].cp;
  const conductorK = () => {
    const t = s().config.conductors![0].type;
    return t.kind === "conduction" ? t.k : undefined;
  };

  it("selecting Material stores exactly { material: key } and is undoable", () => {
    s().updateSolidNode("s1", {
      cp: specForMode("material", solidCp(), "cp", 300),
    });
    expect(solidCp()).toEqual({ material: "ofhc-copper" });
    // Text cache stays a faithful serialization of the config.
    expect(s().modelText).toBe(serializeText(s().config));
    expect(s().modelText).toContain('"cp":{"material":"ofhc-copper"}');
    s().undo();
    expect(solidCp()).toBe(500);
    s().redo();
    expect(solidCp()).toEqual({ material: "ofhc-copper" });
  });

  it("selecting Temperature table stores exactly { table: [[T, v], …] }", () => {
    s().updateSolidNode("s1", {
      cp: specForMode("table", solidCp(), "cp", 300),
    });
    expect(solidCp()).toEqual({
      table: [
        [150, 500],
        [600, 500],
      ],
    });
    s().undo();
    expect(solidCp()).toBe(500);
  });

  it("selecting Constant from a table evaluates at the reference temperature (explicit switch, one undo step)", () => {
    s().updateSolidNode("s1", {
      cp: {
        table: [
          [100, 200],
          [300, 400],
        ],
      },
    });
    s().updateSolidNode("s1", {
      cp: specForMode("constant", solidCp(), "cp", 300),
    });
    expect(solidCp()).toBe(400);
    s().undo();
    expect(solidCp()).toEqual({
      table: [
        [100, 200],
        [300, 400],
      ],
    });
  });

  it("table edits (add/remove rows) write back the same { table } shape", () => {
    s().updateSolidNode("s1", {
      cp: specForMode("table", solidCp(), "cp", 300),
    });
    const current = solidCp() as { table: [number, number][] };
    // ScheduleEditor onChange contract: full replacement row array.
    const appended: [number, number][] = [...current.table, [900, 500]];
    s().updateSolidNode("s1", { cp: { table: appended } });
    expect(solidCp()).toEqual({
      table: [
        [150, 500],
        [600, 500],
        [900, 500],
      ],
    });
  });

  it("conductor k mode commits keep area/length untouched", () => {
    s().updateConductor("c1", {
      type: {
        kind: "conduction",
        k: specForMode("material", conductorK(), "k", 295),
        area: 0.01,
        length: 0.1,
      },
    });
    expect(conductorK()).toEqual({ material: "ofhc-copper" });
    const t = s().config.conductors![0].type;
    expect(t.kind === "conduction" && t.area).toBe(0.01);
    s().undo();
    expect(conductorK()).toBe(400);
  });
});

/* ------------------------------------------------------------------ */
/* Text save/load round-trip (incl. formula cache losslessness)        */
/* ------------------------------------------------------------------ */

describe("text round-trip of solid property specs", () => {
  it("constant/material/table cp and k plus a formula binding round-trip exactly", () => {
    const config: NetworkConfig = {
      meta: { name: "Round trip", version: 2 },
      settings: {
        mode: "transient",
        dt: 1,
        endTime: 2,
        tolerance: 1e-6,
        maxIterations: 50,
        gravity: { x: 0, y: -9.80665, z: 0 },
      },
      fluid: { model: "incompressible", preset: "water" },
      nodes: [
        {
          id: "f1",
          type: "boundary",
          x: 0,
          y: 0,
          pressure: 1e5,
          temperature: 300,
        },
        {
          id: "f2",
          type: "boundary",
          x: 100,
          y: 0,
          pressure: 1e5,
          temperature: 300,
          volume: { expr: "0.5 * 0.002" },
        },
      ],
      solidNodes: [
        {
          id: "sConst",
          type: "solid",
          x: 0,
          y: 80,
          temperature: 300,
          mass: 1,
          cp: 500,
        },
        {
          id: "sMat",
          type: "solid",
          x: 100,
          y: 80,
          temperature: 300,
          mass: 1,
          cp: { material: "ofhc-copper" },
        },
        {
          id: "sTab",
          type: "solid",
          x: 200,
          y: 80,
          temperature: 300,
          mass: 1,
          cp: {
            table: [
              [77, 190],
              [300, 385],
            ],
          },
        },
      ],
      conductors: [
        {
          id: "cTab",
          from: "sConst",
          to: "sMat",
          type: {
            kind: "conduction",
            k: {
              table: [
                [4, 1000],
                [300, 396],
              ],
            },
            area: 0.01,
            length: 0.1,
          },
        },
        {
          id: "cMat",
          from: "sMat",
          to: "sTab",
          type: {
            kind: "conduction",
            k: { material: "ofhc-copper" },
            area: 0.01,
            length: 0.1,
          },
        },
      ],
      branches: [
        {
          id: "b1",
          from: "f1",
          to: "f2",
          component: { type: "flowSource", massFlow: 0 },
        },
      ],
    };
    const text = serializeText(config);
    // The text carries the spec objects verbatim (JSON payloads).
    expect(text).toContain('"cp":{"material":"ofhc-copper"}');
    expect(text).toContain('"cp":{"table":[[77,190],[300,385]]}');
    expect(text).toContain('"k":{"table":[[4,1000],[300,396]]}');
    expect(text).toContain('"expr":"0.5 * 0.002"');
    const result = parseText(text);
    expect(result.errors).toEqual([]);
    expect(result.config).toStrictEqual(config);
  });
});

/* ------------------------------------------------------------------ */
/* ModelTableView summaries (SSR)                                      */
/* ------------------------------------------------------------------ */

describe("ModelTableView solid-property summaries (SSR)", () => {
  it("shows the cp mode unambiguously and the conductor k material by name", () => {
    const config = makeConfig({
      cp: {
        table: [
          [77, 190],
          [200, 320],
          [300, 385],
        ],
      },
      k: { material: "ofhc-copper" },
    });
    const html = renderSsr("table", config, { kind: "none" });
    expect(html).toContain("3-pt table");
    expect(html).toContain("OFHC copper");
  });

  it("constant cp renders as a bare number as before", () => {
    const html = renderSsr("table", makeConfig({ cp: 500, k: 400 }), {
      kind: "none",
    });
    expect(html).toContain(">500</td>");
    expect(html).toContain("k 400");
  });
});
