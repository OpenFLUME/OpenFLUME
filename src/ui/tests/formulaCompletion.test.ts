/**
 * formulaCompletion.ts — config-aware autocomplete for formula bindings:
 * catalog scope/filters, value hints, context detection, deterministic
 * ranking, safe insertion/escaping, malformed-input tolerance, and parity
 * with core's previewNetworkParameters for every suggested reference.
 */
import { describe, it, expect } from "vitest";
import type { NetworkConfig } from "../../core/schema";
import { previewNetworkParameters, validateNetwork } from "../../core";
import { expressionBuiltinNames } from "../../core";
import { segmentFormula } from "../formulaTokens";
import {
  applyFormulaCompletion,
  buildFormulaCatalog,
  completionContext,
  escapeFormulaId,
  quoteFormulaId,
  referenceSource,
  type FormulaCatalog,
  type FormulaSuggestion,
} from "../formulaCompletion";

/* ------------------------------------------------------------------ */
/* Fixture                                                             */
/* ------------------------------------------------------------------ */

/**
 * Representative steady network: boundary a → n1 → n2 → boundary b with a
 * pipe, a heated pipe (formula-bound ua), an elevated pipe, a bend and a
 * valve in parallel, four conductor kinds (conduction with numeric k,
 * conduction with material k, convection with a correlation block,
 * radiation), two solid nodes, and two registers.
 */
function fixtureConfig(): NetworkConfig {
  return {
    meta: { name: "completion-fixture", version: 2 },
    settings: { mode: "steady", tolerance: 1e-8, maxIterations: 100 },
    fluid: { model: "incompressible", preset: "water" },
    registers: { gain: 2.5, setpoint: 1e5 },
    nodes: [
      {
        id: "a",
        type: "boundary",
        x: 0,
        y: 0,
        position: { z: 3 },
        pressure: 2e5,
        temperature: 300,
      },
      { id: "n1", type: "internal", x: 1, y: 0, volume: 1e-3 },
      { id: "n2", type: "internal", x: 1.5, y: 0, volume: 2e-3 },
      {
        id: "b",
        type: "boundary",
        x: 2,
        y: 0,
        pressure: 1e5,
        temperature: 300,
      },
    ],
    solidNodes: [
      {
        id: "wall",
        type: "solid",
        x: 1,
        y: 1,
        temperature: 350,
        mass: 2,
        cp: 385,
      },
      { id: "amb", type: "ambient", x: 0, y: 1, temperature: 290 },
    ],
    conductors: [
      {
        id: "c1",
        from: "wall",
        to: "amb",
        type: { kind: "conduction", k: 200, area: 0.01, length: 0.05 },
      },
      {
        id: "cm",
        from: "wall",
        to: "amb",
        type: {
          kind: "conduction",
          k: { material: "ofhc-copper" },
          area: 0.02,
          length: 0.1,
        },
      },
      {
        id: "cv",
        from: "a",
        to: "wall",
        type: {
          kind: "convection",
          h: 50,
          area: 0.02,
          correlation: {
            model: "custom",
            expression: "50",
            diameter: 0.05,
            axialPosition: 0.4,
          },
        },
      },
      {
        id: "rad",
        from: "wall",
        to: "amb",
        type: {
          kind: "radiation",
          emissivity: 0.8,
          area: 0.03,
          viewFactor: 0.5,
        },
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
        to: "n2",
        component: {
          type: "heatedPipe",
          length: 1,
          diameter: 0.05,
          roughness: 1e-5,
          ua: { expr: "pipe('seg1').diameter * 800" },
          wallTemperature: 350,
        },
      },
      {
        id: "seg3",
        from: "n2",
        to: "b",
        component: {
          type: "pipe",
          length: 1,
          diameter: 0.04,
          roughness: 1e-5,
          elevationChange: 0.5,
        },
      },
      {
        id: "elbow",
        from: "n2",
        to: "b",
        component: { type: "bend", diameter: 0.02, angle: 90, rOverD: 1.5 },
      },
      {
        id: "v1",
        from: "n2",
        to: "b",
        component: { type: "valve", area: 1e-3, cd: 0.8, position: 1 },
      },
    ],
  };
}

const catalog = (): FormulaCatalog => buildFormulaCatalog(fixtureConfig());

const labels = (suggestions: FormulaSuggestion[]): string[] =>
  suggestions.map((s) => s.label);

/** Property leaf paths of one catalog entity, in canonical order. */
function propPaths(
  cat: FormulaCatalog,
  accessor: keyof FormulaCatalog["entities"],
  id: string,
): string[] {
  const entity = cat.entities[accessor].find((e) => e.id === id);
  if (entity === undefined)
    throw new Error(`missing ${accessor} entity '${id}'`);
  return entity.properties.map((p) => p.path.join("."));
}

/* ------------------------------------------------------------------ */
/* Catalog scope + type filters                                        */
/* ------------------------------------------------------------------ */

describe("buildFormulaCatalog", () => {
  it("type-filters branch accessors: pipe excludes heatedPipe/bend/valve", () => {
    const cat = catalog();
    expect(cat.entities.pipe.map((e) => e.id)).toEqual(["seg1", "seg3"]);
    expect(cat.entities.heatedPipe.map((e) => e.id)).toEqual(["seg2"]);
    expect(cat.entities.bend.map((e) => e.id)).toEqual(["elbow"]);
    // The generic branch accessor sees every branch, sorted by id.
    expect(cat.entities.branch.map((e) => e.id)).toEqual([
      "elbow",
      "seg1",
      "seg2",
      "seg3",
      "v1",
    ]);
  });

  it("exposes pipe/heatedPipe/bend properties incl. derived geometry, in canonical order", () => {
    const cat = catalog();
    expect(propPaths(cat, "pipe", "seg1")).toEqual([
      "length",
      "diameter",
      "roughness",
      "area",
      "volume",
      "surfaceArea",
    ]);
    // elevationChange only when statically set.
    expect(propPaths(cat, "pipe", "seg3")).toEqual([
      "length",
      "diameter",
      "roughness",
      "elevationChange",
      "area",
      "volume",
      "surfaceArea",
    ]);
    expect(propPaths(cat, "heatedPipe", "seg2")).toEqual([
      "length",
      "diameter",
      "roughness",
      "area",
      "volume",
      "surfaceArea",
      "ua",
      "wallTemperature",
    ]);
    expect(propPaths(cat, "bend", "elbow")).toEqual([
      "diameter",
      "angle",
      "rOverD",
      "area",
    ]);
  });

  it("exposes stored numeric properties through branch() only", () => {
    const cat = catalog();
    expect(propPaths(cat, "branch", "v1")).toEqual(["area", "cd", "position"]);
    expect(propPaths(cat, "branch", "seg2")).toEqual([
      "length",
      "diameter",
      "roughness",
      "ua",
      "wallTemperature",
    ]);
  });

  it("exposes configured node properties when statically present", () => {
    const cat = catalog();
    expect(propPaths(cat, "node", "n1")).toEqual(["volume"]);
    expect(propPaths(cat, "node", "a")).toEqual([
      "pressure",
      "temperature",
      "position.z",
      "z",
    ]);
    expect(propPaths(cat, "node", "b")).toEqual(["pressure", "temperature"]);
  });

  it("exposes conductor properties kind-specifically, with correlation nested only where appropriate", () => {
    const cat = catalog();
    // Conduction with a plain-number k exposes k; the material-k form does not.
    expect(propPaths(cat, "conductor", "c1")).toEqual(["k", "area", "length"]);
    expect(propPaths(cat, "conductor", "cm")).toEqual(["area", "length"]);
    // Convection: area/h plus nested correlation leaves — only the fields
    // that are actually set (flowArea is not), and only on convection.
    expect(propPaths(cat, "conductor", "cv")).toEqual([
      "area",
      "h",
      "correlation.diameter",
      "correlation.axialPosition",
    ]);
    expect(propPaths(cat, "conductor", "rad")).toEqual([
      "emissivity",
      "area",
      "viewFactor",
    ]);
  });

  it("exposes solid mass/temperature and registers", () => {
    const cat = catalog();
    expect(propPaths(cat, "solid", "wall")).toEqual(["temperature", "mass"]);
    expect(propPaths(cat, "solid", "amb")).toEqual(["temperature"]);
    expect(cat.entities.reg.map((e) => e.id)).toEqual(["gain", "setpoint"]);
    expect(cat.entities.reg.every((e) => e.properties.length === 0)).toBe(true);
  });

  it("lists all accessors, helpers, and the expression builtins", () => {
    const cat = catalog();
    expect(cat.accessors.map((a) => a.name)).toEqual([
      "pipe",
      "heatedPipe",
      "bend",
      "branch",
      "node",
      "conductor",
      "solid",
      "reg",
    ]);
    expect(cat.helpers.map((h) => h.name)).toEqual([
      "circleArea",
      "circleDiameter",
      "cylinderVolume",
      "cylinderArea",
    ]);
    expect(cat.builtins.map((b) => b.name)).toEqual(expressionBuiltinNames());
    expect(cat.builtins.map((b) => b.name)).toContain("pi");
  });

  it("is deterministic: two builds are deep-equal", () => {
    expect(buildFormulaCatalog(fixtureConfig())).toEqual(
      buildFormulaCatalog(fixtureConfig()),
    );
  });
});

/* ------------------------------------------------------------------ */
/* Value hints                                                         */
/* ------------------------------------------------------------------ */

describe("catalog value hints", () => {
  it("hints literal stored values", () => {
    const cat = catalog();
    const seg1 = cat.entities.pipe.find((e) => e.id === "seg1")!;
    const length = seg1.properties.find((p) => p.name === "length")!;
    expect(length.value).toBe(2);
    expect(length.detail).toBe("= 2");
    expect(length.derived).toBe(false);
  });

  it("computes derived geometry hints from literal length/diameter", () => {
    const cat = catalog();
    const seg1 = cat.entities.pipe.find((e) => e.id === "seg1")!;
    const area = seg1.properties.find((p) => p.name === "area")!;
    expect(area.derived).toBe(true);
    expect(area.value).toBeCloseTo((Math.PI * 0.05 * 0.05) / 4, 15);
    const volume = seg1.properties.find((p) => p.name === "volume")!;
    expect(volume.value).toBeCloseTo(2 * ((Math.PI * 0.05 * 0.05) / 4), 15);
    const elbow = cat.entities.bend.find((e) => e.id === "elbow")!;
    expect(elbow.properties.find((p) => p.name === "area")!.value).toBeCloseTo(
      (Math.PI * 0.02 * 0.02) / 4,
      15,
    );
  });

  it("marks formula-bound fields without a literal value", () => {
    const cat = catalog();
    const seg2 = cat.entities.heatedPipe.find((e) => e.id === "seg2")!;
    const ua = seg2.properties.find((p) => p.name === "ua")!;
    expect(ua.value).toBeUndefined();
    expect(ua.detail).toContain("formula-bound");
    const wall = seg2.properties.find((p) => p.name === "wallTemperature")!;
    expect(wall.value).toBe(350);
  });
});

/* ------------------------------------------------------------------ */
/* Context detection + ranking                                         */
/* ------------------------------------------------------------------ */

describe("completionContext toplevel", () => {
  it("offers accessors, then helpers, then builtins at an empty position", () => {
    const c = completionContext("", 0, catalog());
    expect(c.kind).toBe("toplevel");
    expect(c.prefix).toBe("");
    expect(c.replaceStart).toBe(0);
    expect(c.replaceEnd).toBe(0);
    expect(labels(c.suggestions).slice(0, 12)).toEqual([
      "pipe",
      "heatedPipe",
      "bend",
      "branch",
      "node",
      "conductor",
      "solid",
      "reg",
      "circleArea",
      "circleDiameter",
      "cylinderVolume",
      "cylinderArea",
    ]);
    expect(c.suggestions.find((s) => s.label === "sqrt")?.kind).toBe("builtin");
  });

  it("filters and ranks deterministically: exact match first, then catalog order", () => {
    const c = completionContext("pi", 2, catalog());
    expect(c.prefix).toBe("pi");
    // 'pi' (exact builtin) floats above the accessor prefix-match 'pipe'.
    expect(labels(c.suggestions)).toEqual(["pi", "pipe"]);

    const s = completionContext("s", 1, catalog());
    // accessor 'solid' before builtins; builtins keep core's declared order.
    expect(labels(s.suggestions)).toEqual([
      "solid",
      "sqrt",
      "sin",
      "smoothstep",
    ]);

    const cyl = completionContext("cyl", 3, catalog());
    expect(labels(cyl.suggestions)).toEqual(["cylinderVolume", "cylinderArea"]);
    expect(cyl.suggestions.every((x) => x.kind === "helper")).toBe(true);
  });

  it("replaces the whole identifier around the caret", () => {
    const src = "1 + cyl";
    const c = completionContext(src, src.length, catalog());
    expect(c.replaceStart).toBe(4);
    expect(c.replaceEnd).toBe(7);
    const applied = applyFormulaCompletion(src, c, c.suggestions[0]);
    expect(applied.source).toBe("1 + cylinderVolume");
    expect(applied.caret).toBe("1 + cylinderVolume".length);
  });
});

describe("completionContext id strings", () => {
  it("suggests type-filtered ids inside an open string", () => {
    const src = "pipe('";
    const c = completionContext(src, src.length, catalog());
    expect(c.kind).toBe("id");
    expect(c.accessor).toBe("pipe");
    expect(c.prefix).toBe("");
    expect(labels(c.suggestions)).toEqual(["seg1", "seg3"]);
    // Already inside a string: insertion is the bare (escaped) id.
    expect(c.suggestions[0].insertText).toBe("seg1");
    const applied = applyFormulaCompletion(src, c, c.suggestions[0]);
    expect(applied.source).toBe("pipe('seg1");
  });

  it("filters ids by the typed prefix", () => {
    const src = "conductor('c";
    const c = completionContext(src, src.length, catalog());
    expect(c.kind).toBe("id");
    expect(c.prefix).toBe("c");
    expect(labels(c.suggestions)).toEqual(["c1", "cm", "cv"]); // 'rad' filtered out
    // The whole partial id text is replaced.
    expect(c.replaceStart).toBe(src.indexOf("'") + 1);
    expect(c.replaceEnd).toBe(src.length);
  });

  it("inserts a fully quoted id when no quote has been typed yet", () => {
    const src = "pipe(";
    const c = completionContext(src, src.length, catalog());
    expect(c.kind).toBe("id");
    expect(c.suggestions[0].insertText).toBe("'seg1'");
    const applied = applyFormulaCompletion(src, c, c.suggestions[0]);
    expect(applied.source).toBe("pipe('seg1'");
    expect(applied.caret).toBe(applied.source.length);
  });

  it("replaces the whole existing id when the caret is inside it", () => {
    const src = "pipe('seg1').diameter";
    const caret = src.indexOf("g");
    const c = completionContext(src, caret, catalog());
    expect(c.kind).toBe("id");
    expect(c.prefix).toBe("se");
    const applied = applyFormulaCompletion(
      src,
      c,
      c.suggestions.find((s) => s.label === "seg3")!,
    );
    expect(applied.source).toBe("pipe('seg3').diameter");
  });

  it("suggests registers for reg()", () => {
    const c = completionContext("reg('", 5, catalog());
    expect(c.kind).toBe("id");
    expect(labels(c.suggestions)).toEqual(["gain", "setpoint"]);
  });
});

describe("completionContext property chains", () => {
  it("suggests config-filtered properties after a dot", () => {
    const src = "pipe('seg1').";
    const c = completionContext(src, src.length, catalog());
    expect(c.kind).toBe("property");
    expect(c.accessor).toBe("pipe");
    expect(c.id).toBe("seg1");
    expect(c.propertyChain).toEqual([]);
    expect(labels(c.suggestions)).toEqual([
      "length",
      "diameter",
      "roughness",
      "area",
      "volume",
      "surfaceArea",
    ]);
    const applied = applyFormulaCompletion(src, c, c.suggestions[1]);
    expect(applied.source).toBe("pipe('seg1').diameter");
  });

  it("filters by partial property text", () => {
    const src = "pipe('seg1').surf";
    const c = completionContext(src, src.length, catalog());
    expect(c.prefix).toBe("surf");
    expect(labels(c.suggestions)).toEqual(["surfaceArea"]);
    const applied = applyFormulaCompletion(src, c, c.suggestions[0]);
    expect(applied.source).toBe("pipe('seg1').surfaceArea");
  });

  it("flattens nested correlation leaves at the root and expands inside the chain", () => {
    const root = completionContext(
      "conductor('cv').",
      "conductor('cv').".length,
      catalog(),
    );
    expect(labels(root.suggestions)).toEqual([
      "area",
      "h",
      "correlation.diameter",
      "correlation.axialPosition",
    ]);
    // Root suggestions insert the full nested path — always a complete reference.
    const applied = applyFormulaCompletion(
      "conductor('cv').",
      root,
      root.suggestions.find((s) => s.label === "correlation.diameter")!,
    );
    expect(applied.source).toBe("conductor('cv').correlation.diameter");

    const nested = completionContext(
      "conductor('cv').correlation.",
      "conductor('cv').correlation.".length,
      catalog(),
    );
    expect(nested.propertyChain).toEqual(["correlation"]);
    expect(labels(nested.suggestions)).toEqual(["diameter", "axialPosition"]);

    const filtered = completionContext(
      "conductor('cv').correlation.a",
      "conductor('cv').correlation.a".length,
      catalog(),
    );
    expect(labels(filtered.suggestions)).toEqual(["axialPosition"]);
  });

  it("adds the leading dot when the caret sits right after the call", () => {
    const src = "node('n1')";
    const c = completionContext(src, src.length, catalog());
    expect(c.kind).toBe("property");
    expect(labels(c.suggestions)).toEqual(["volume"]);
    expect(c.suggestions[0].insertText).toBe(".volume");
    const applied = applyFormulaCompletion(src, c, c.suggestions[0]);
    expect(applied.source).toBe("node('n1').volume");
  });

  it("returns no property suggestions for unknown ids or entity-less accessors", () => {
    expect(
      completionContext("pipe('nope').", "pipe('nope').".length, catalog())
        .suggestions,
    ).toEqual([]);
    expect(
      completionContext("node('nope').", "node('nope').".length, catalog())
        .suggestions,
    ).toEqual([]);
    // reg() has no properties at all.
    const reg = completionContext(
      "reg('gain').",
      "reg('gain').".length,
      catalog(),
    );
    expect(reg.kind).toBe("property");
    expect(reg.suggestions).toEqual([]);
  });

  it("decodes escaped ids when looking the entity up", () => {
    const config = fixtureConfig();
    config.branches.push({
      id: "we'ird",
      from: "n2",
      to: "b",
      component: { type: "pipe", length: 1, diameter: 0.03, roughness: 1e-5 },
    });
    const cat = buildFormulaCatalog(config);
    const src = "pipe('we\\'ird').";
    const c = completionContext(src, src.length, cat);
    expect(c.kind).toBe("property");
    expect(c.id).toBe("we'ird");
    expect(labels(c.suggestions)).toContain("volume");
  });
});

describe("deterministic ranking", () => {
  it("repeated calls produce identical results", () => {
    const cat = catalog();
    for (const [src, pos] of [
      ["pi", 2],
      ["conductor('cv').", "conductor('cv').".length],
      ["pipe('", 6],
      ["", 0],
    ] as Array<[string, number]>) {
      expect(completionContext(src, pos, cat)).toEqual(
        completionContext(src, pos, cat),
      );
    }
  });
});

/* ------------------------------------------------------------------ */
/* Escaping + insertion                                                */
/* ------------------------------------------------------------------ */

describe("escaping", () => {
  it("escapes backslashes, the active quote, newlines and tabs", () => {
    expect(escapeFormulaId("plain")).toBe("plain");
    expect(escapeFormulaId("we'ird")).toBe("we\\'ird");
    expect(escapeFormulaId("back\\slash")).toBe("back\\\\slash");
    expect(escapeFormulaId("tab\there")).toBe("tab\\there");
    expect(escapeFormulaId("line\nbreak")).toBe("line\\nbreak");
    // The other quote needs no escaping; the active one does.
    expect(escapeFormulaId('a"b', "'")).toBe('a"b');
    expect(quoteFormulaId('a"b', '"')).toBe('"a\\"b"');
    expect(quoteFormulaId("we'ird")).toBe("'we\\'ird'");
  });

  it("round-trips escaped ids through the formula tokenizer", () => {
    for (const id of [
      "we'ird",
      "back\\slash",
      "tab\there",
      "line\nbreak",
      'a"b',
    ]) {
      const ref = referenceSource("pipe", id, ["volume"]);
      const chips = segmentFormula(ref).filter((s) => s.type === "chip");
      expect(chips).toHaveLength(1);
      if (chips[0].type === "chip") {
        expect(chips[0].chip.id).toBe(id);
        expect(chips[0].chip.properties).toEqual(["volume"]);
      }
    }
    // reg with no property chain is also a complete chip.
    const regChips = segmentFormula(referenceSource("reg", "gain")).filter(
      (s) => s.type === "chip",
    );
    expect(regChips).toHaveLength(1);
  });

  it("escapes id suggestions inside strings and quotes them after the paren", () => {
    const config = fixtureConfig();
    config.branches.push({
      id: "we'ird",
      from: "n2",
      to: "b",
      component: { type: "pipe", length: 1, diameter: 0.03, roughness: 1e-5 },
    });
    const cat = buildFormulaCatalog(config);

    const inString = completionContext("pipe('we", "pipe('we".length, cat);
    const s = inString.suggestions.find((x) => x.label === "we'ird")!;
    expect(s.insertText).toBe("we\\'ird");
    expect(applyFormulaCompletion("pipe('we", inString, s).source).toBe(
      "pipe('we\\'ird",
    );

    const afterParen = completionContext("pipe(", 5, cat);
    expect(
      afterParen.suggestions.find((x) => x.label === "we'ird")!.insertText,
    ).toBe("'we\\'ird'");
  });
});

/* ------------------------------------------------------------------ */
/* Malformed input tolerance                                           */
/* ------------------------------------------------------------------ */

describe("malformed source/caret tolerance", () => {
  it("never throws on malformed sources", () => {
    const cat = catalog();
    const sources = [
      "",
      "(",
      ")",
      ",",
      ".",
      "'unterminated",
      '"',
      "\\",
      "1e",
      "..",
      "pipe('x",
      "pipe(",
      "pipe)",
      "pipe('a').",
      "pipe('a').vol",
      "pipe(a').b",
      "pipe('a', 'b').c",
      "#$%",
      "conductor('cv').correlation.",
      "node('n1').volume +",
      "9999",
    ];
    for (const src of sources) {
      for (const pos of [0, 1, Math.floor(src.length / 2), src.length]) {
        expect(
          () => completionContext(src, pos, cat),
          `${src} @ ${pos}`,
        ).not.toThrow();
      }
    }
  });

  it("clamps out-of-range and non-finite carets", () => {
    const cat = catalog();
    for (const caret of [-5, Number.NaN, Number.POSITIVE_INFINITY, 1e9, 2.7]) {
      expect(() => completionContext("pipe('", caret, cat)).not.toThrow();
    }
    expect(completionContext("pipe('", 1e9, cat).kind).toBe("id");
    expect(completionContext("", -1, cat).replaceStart).toBe(0);
    // A non-finite caret clamps to the end of the source.
    const nan = completionContext("pi", Number.NaN, cat);
    expect(nan.kind).toBe("toplevel");
    expect(nan.prefix).toBe("pi");
  });

  it("offers nothing inside non-accessor strings or for unknown chains", () => {
    const cat = catalog();
    expect(completionContext("min('ab", 7, cat).suggestions).toEqual([]);
    expect(
      completionContext("pipe('seg1').volume.extra", 24, cat).suggestions,
    ).toEqual([]);
  });

  it("never throws from applyFormulaCompletion with bad ranges", () => {
    expect(() =>
      applyFormulaCompletion(
        "abc",
        { replaceStart: -10, replaceEnd: 99 },
        { insertText: "x" },
      ),
    ).not.toThrow();
    expect(
      applyFormulaCompletion(
        "abc",
        { replaceStart: 1, replaceEnd: 2 },
        { insertText: "X" },
      ),
    ).toEqual({
      source: "aXc",
      caret: 2,
    });
  });
});

/* ------------------------------------------------------------------ */
/* Core parity: every suggested reference resolves                     */
/* ------------------------------------------------------------------ */

describe("suggested-reference parity with previewNetworkParameters", () => {
  it("the fixture itself is valid", () => {
    expect(validateNetwork(fixtureConfig())).toEqual([]);
  });

  it("every catalog leaf reference is accepted in a formula-bound node volume", () => {
    const cat = catalog();
    const checked: string[] = [];
    for (const accessor of Object.keys(cat.entities) as Array<
      keyof FormulaCatalog["entities"]
    >) {
      for (const entity of cat.entities[accessor]) {
        // reg('name') stands alone; every other accessor needs a leaf
        // property (entities without static properties — e.g. a boundary
        // node with no volume/z — have no completable reference).
        if (entity.properties.length === 0 && accessor !== "reg") continue;
        const leaves: readonly (readonly string[])[] =
          accessor === "reg" ? [[]] : entity.properties.map((p) => p.path);
        for (const path of leaves) {
          const expr = referenceSource(accessor, entity.id, path);
          const config = fixtureConfig();
          // Avoid a self-dependency cycle when the reference IS the bound field.
          const target =
            accessor === "node" && entity.id === "n1" ? "n2" : "n1";
          config.nodes.find((n) => n.id === target)!.volume = { expr };
          const result = previewNetworkParameters(config);
          expect(
            result.ok,
            `${expr} → ${result.ok ? "ok" : result.errors.join("; ")}`,
          ).toBe(true);
          if (result.ok) {
            const value = result.resolved[`node '${target}'.volume`];
            expect(Number.isFinite(value), expr).toBe(true);
          }
          checked.push(expr);
        }
      }
    }
    // Sanity: the sweep really covered every accessor including nested
    // correlation leaves and registers.
    expect(checked.length).toBeGreaterThan(30);
    expect(checked).toContain("pipe('seg1').volume");
    expect(checked).toContain("heatedPipe('seg2').ua");
    expect(checked).toContain("conductor('cv').correlation.axialPosition");
    expect(checked).toContain("node('a').z");
    expect(checked).toContain("node('a').position.z");
    expect(checked).toContain("reg('gain')");
  });
});
