/**
 * Stage 2 tests for the NetworkConfig text projection
 * (src/substrate/textProjection.ts).
 *
 * Coverage:
 *  - every representative fixture (./fixtures.ts) round-trips through
 *    serializeText -> parseText with ZERO errors and exact
 *    (strict) deep equality — no skips, no normalization.
 *    (The full ui/examples library sweep lives in the UI layer at
 *    src/ui/tests/examplesTextRoundTrip.test.ts — substrate tests must not
 *    depend on the UI layer.);
 *  - stable (byte-identical) serialization after a parse, for a simple, a
 *    thermal, and a component-library/multiline-source fixture;
 *  - error / no-config cases (header, brace, ids, keywords, component types,
 *    coordinates, JSON, dangling endpoints incl. line attribution);
 *  - elevation: absent z stays absent, explicit z = 0 stays 0, and the
 *    hand-authoring "elevationChange": "derived" marker computes z_to-z_from;
 *  - the 'Metric engineering' unit preset accepted with SI values preserved
 *    bit-exactly;
 *  - lineMap shape (a Map) and range-to-line consistency;
 *  - presence metadata for optional empty entity arrays plus uncommon
 *    top-level/nested content fixtures;
 *  - parseText never throws on malformed / fuzz-like inputs.
 */

import { describe, it, expect } from "vitest";
import type { NetworkConfig } from "../../core";
import { fixtures } from "./fixtures";
import {
  parseText,
  serializeText,
  serializeTextWithLineMap,
  type LineMap,
  type ParseResult,
} from "../textProjection";

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/** Minimal valid v2 config used as a base for hand-crafted variants. */
function minimalConfig(): NetworkConfig {
  return {
    meta: { name: "mini", version: 2 },
    settings: { mode: "steady", tolerance: 1e-9, maxIterations: 100 },
    fluid: { model: "incompressible", preset: "water" },
    nodes: [
      {
        id: "a",
        type: "boundary",
        x: 0,
        y: 0,
        pressure: 200_000,
        temperature: 300,
      },
      {
        id: "b",
        type: "boundary",
        x: 100,
        y: 0,
        pressure: 100_000,
        temperature: 300,
      },
    ],
    branches: [
      {
        id: "p1",
        from: "a",
        to: "b",
        component: { type: "pipe", length: 1, diameter: 0.05, roughness: 1e-5 },
      },
    ],
  };
}

const HEADER = "// Fluid Network config v2";

function minimalText(body: string[] = []): string {
  return [
    HEADER,
    'network "mini" {',
    'settings: {"mode":"steady","tolerance":1e-9,"maxIterations":100}',
    'fluid: {"model":"incompressible","preset":"water"}',
    'node "a" boundary @ (0, 0) data: {"pressure":200000,"temperature":300}',
    'node "b" boundary @ (100, 0) data: {"pressure":100000,"temperature":300}',
    ...body,
    "}",
    "",
  ].join("\n");
}

function expectError(result: ParseResult, pattern: RegExp | string): void {
  expect(result.config).toBeUndefined();
  expect(result.errors.length).toBeGreaterThan(0);
  const hit = result.errors.some((e) =>
    typeof pattern === "string"
      ? e.message.includes(pattern)
      : pattern.test(e.message),
  );
  if (!hit) {
    throw new Error(
      `expected an error matching ${String(pattern)}, got: ${JSON.stringify(result.errors, null, 2)}`,
    );
  }
}

/** Parse and demand success + strict equality with the expected config. */
function expectRoundTrip(config: NetworkConfig): {
  text: string;
  lineMap: LineMap;
  parsed: NetworkConfig;
} {
  const { text, lineMap } = serializeTextWithLineMap(config);
  const result = parseText(text);
  expect(result.errors).toEqual([]);
  expect(result.config).toStrictEqual(config);
  return { text, lineMap, parsed: result.config! };
}

/* ------------------------------------------------------------------ */
/* 1. Representative fixture round trip (no skips)                     */
/* ------------------------------------------------------------------ */

describe("fixture round-trip", () => {
  it("covers exactly 4 fixtures", () => {
    expect(Object.keys(fixtures)).toHaveLength(4);
  });

  const failures: string[] = [];
  for (const [name, fixture] of Object.entries(fixtures)) {
    it(`round-trips exactly: ${name}`, () => {
      try {
        const { text } = serializeTextWithLineMap(fixture);
        const result = parseText(text);
        expect(result.errors).toEqual([]);
        expect(result.config).toStrictEqual(fixture);
      } catch (e) {
        failures.push(name);
        throw e;
      }
    });
  }

  it("has zero named failures", () => {
    expect(failures).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* 1b. Formula bindings ({ expr }) round-trip naturally as JSON        */
/* ------------------------------------------------------------------ */

describe("formula bindings (NumberOrExpression)", () => {
  it("round-trips formula objects in node / branch / conductor payloads exactly", () => {
    const config = minimalConfig();
    config.nodes.push({
      id: "n1",
      type: "internal",
      x: 50,
      y: 0,
      position: { x: { expr: "pipe('p1').length" } },
      volume: { expr: "pipe('p1').volume" },
    });
    const p1 = config.branches[0].component;
    if (p1.type === "pipe") p1.diameter = { expr: "0.04 + 0.01" };
    config.solidNodes = [
      {
        id: "amb",
        type: "ambient",
        x: 50,
        y: 20,
        position: { x: { expr: "node('n1').position.x" } },
        temperature: 290,
      },
    ];
    config.conductors = [
      {
        id: "cv",
        from: "n1",
        to: "amb",
        type: {
          kind: "convection",
          h: 25,
          area: { expr: "pipe('p1').surfaceArea" },
        },
      },
    ];
    // The parser runs decode + validate: formulas resolve cleanly here, so
    // the round trip succeeds and the CONFIG (with formula objects, not
    // resolved numbers) is preserved exactly.
    expectRoundTrip(config);
  });

  it("serializes formulas as ordinary JSON inside data payloads (no grammar change)", () => {
    const config = minimalConfig();
    config.nodes.push({
      id: "n1",
      type: "internal",
      x: 50,
      y: 0,
      volume: { expr: "pipe('p1').volume" },
    });
    const { text } = serializeTextWithLineMap(config);
    expect(text).toContain('data: {"volume":{"expr":"pipe(\'p1\').volume"}}');
  });

  it("surfaces formula resolution errors as parse errors (validation phase)", () => {
    const config = minimalConfig();
    config.nodes.push({
      id: "n1",
      type: "internal",
      x: 50,
      y: 0,
      volume: { expr: "pipe('ghost').volume" },
    });
    const result = parseText(serializeText(config));
    expect(result.config).toBeUndefined();
    expect(
      result.errors.some((e) =>
        e.message.includes("pipe('ghost') references unknown branch"),
      ),
    ).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* 2. Stable serialization after parse                                 */
/* ------------------------------------------------------------------ */

describe("stable serialization after parse", () => {
  const representative = [
    "Three-pipe junction", // simple
    "Heated pipe with radiating wall (conjugate HT)", // thermal (solids/conductors)
    "Extension: embedded K resistance", // component library with multiline source
  ] as const;
  for (const name of representative) {
    it(`serialize(parse(serialize(x))) === serialize(x): ${name}`, () => {
      const migrated = fixtures[name];
      const first = serializeTextWithLineMap(migrated);
      const parsed = parseText(first.text);
      expect(parsed.errors).toEqual([]);
      const second = serializeTextWithLineMap(parsed.config!);
      expect(second.text).toBe(first.text);
      expect([...second.lineMap.entries()]).toEqual([
        ...first.lineMap.entries(),
      ]);
      // The multiline user code survives on a single (escaped) line.
      if (name === "Extension: embedded K resistance") {
        expect(first.text).toContain("defineComponent({");
        expect(first.text).toContain("\\n");
        expect(parsed.config!.componentLibrary!["embedded-k"].code).toBe(
          migrated.componentLibrary!["embedded-k"].code,
        );
      }
    });
  }
});

/* ------------------------------------------------------------------ */
/* 3. Error / no-config cases                                          */
/* ------------------------------------------------------------------ */

describe("error cases (no config, no throw)", () => {
  it("rejects a malformed header", () => {
    const text = minimalText().replace(HEADER, "// fluid network config v2");
    expectError(parseText(text), /missing or malformed header/);
  });

  it("rejects a missing header (empty input)", () => {
    expectError(parseText(""), /missing or malformed header/);
    expectError(
      parseText('network "mini" {\n}\n'),
      /missing or malformed header/,
    );
  });

  it("rejects a missing network line", () => {
    expectError(parseText(`${HEADER}\n`), /missing network line/);
  });

  it("rejects a malformed network line", () => {
    expectError(
      parseText(`${HEADER}\nnetwork mini {\n}\n`),
      /malformed network line/,
    );
    expectError(
      parseText(`${HEADER}\nnetwork "mini"\n}\n`),
      /malformed network line/,
    );
  });

  it("rejects a missing closing brace", () => {
    const text = minimalText([
      'branch "p1": "a" -> "b" pipe data: {"length":1,"diameter":0.05,"roughness":1e-5}',
    ]);
    const unterminated = text.replace(/\}\n$/, "");
    expectError(parseText(unterminated), /missing closing brace/);
  });

  it("rejects content after the closing brace", () => {
    const text = minimalText([
      'branch "p1": "a" -> "b" pipe data: {"length":1,"diameter":0.05,"roughness":1e-5}',
    ]);
    expectError(
      parseText(text + 'node "z" boundary @ (0, 0, 0) data: {}\n'),
      /unexpected content after closing brace/,
    );
  });

  it("rejects a missing node id", () => {
    expectError(
      parseText(
        minimalText([
          'node boundary @ (0, 0, 0) data: {"pressure":1,"temperature":2}',
        ]),
      ),
      /node record: expected JSON-quoted id/,
    );
  });

  it("rejects an unknown record keyword", () => {
    expectError(
      parseText(minimalText(['widget "x" data: {}'])),
      /unknown record keyword "widget"/,
    );
  });

  it("rejects an unrecognized line", () => {
    expectError(
      parseText(minimalText(["!!! not a record"])),
      /unrecognized line/,
    );
  });

  it("rejects an unknown component type", () => {
    expectError(
      parseText(
        minimalText(['branch "p1": "a" -> "b" fluxCapacitor data: {}']),
      ),
      /unknown component type "fluxCapacitor"/,
    );
  });

  it("rejects an unknown node type / solid type / conductor kind", () => {
    expectError(
      parseText(minimalText(['node "n" mystery @ (0, 0, 0) data: {}'])),
      /unknown node type "mystery"/,
    );
    expectError(
      parseText(
        minimalText(['solid "s" mystery @ (0, 0) data: {"temperature":300}']),
      ),
      /unknown solid node type "mystery"/,
    );
    expectError(
      parseText(minimalText(['conductor "c": "a" -> "b" teleport data: {}'])),
      /unknown conductor kind "teleport"/,
    );
  });

  it("rejects malformed coordinates", () => {
    expectError(
      parseText(minimalText(['node "n" boundary @ (0, , 0) data: {}'])),
      /malformed coordinates/,
    );
    expectError(
      parseText(minimalText(['node "n" boundary @ (0, 0, NaN) data: {}'])),
      /malformed coordinates/,
    );
    expectError(
      parseText(minimalText(['group "g" @ (0) data: {"label":"g"}'])),
      /malformed coordinates/,
    );
  });

  it("rejects malformed JSON payloads", () => {
    expectError(
      parseText(minimalText(['branch "p1": "a" -> "b" pipe data: {oops'])),
      /malformed data JSON/,
    );
    expectError(
      parseText(minimalText(["registers: {oops"])),
      /'registers' field: malformed JSON/,
    );
  });

  it("rejects non-object and reserved-key data payloads", () => {
    expectError(
      parseText(minimalText(['node "n" boundary @ (0, 0, 0) data: [1,2]'])),
      /data payload must be a JSON object/,
    );
    expectError(
      parseText(minimalText(['node "n" boundary @ (0, 0) data: {"x":4}'])),
      /reserved key "x"/,
    );
  });

  it("rejects duplicate singleton blocks", () => {
    expectError(
      parseText(
        minimalText([
          'settings: {"mode":"steady","tolerance":1e-9,"maxIterations":100}',
        ]),
      ),
      /duplicate singleton block 'settings'/,
    );
  });

  it("reports a dangling endpoint and attributes it to the branch line", () => {
    const branchLine =
      'branch "p1": "a" -> "ghost" pipe data: {"length":1,"diameter":0.05,"roughness":1e-5}';
    const text = minimalText([branchLine]);
    const result = parseText(text);
    expectError(result, /Branch p1 references missing node: ghost/);
    const semantic = result.errors.find((e) =>
      /references missing node/.test(e.message),
    )!;
    const expectedLine = text.split("\n").indexOf(branchLine) + 1;
    expect(semantic.line).toBe(expectedLine);
    expect(result.lineMap.get("branch:p1")).toEqual({
      startLine: expectedLine,
      endLine: expectedLine,
    });
  });

  it("attributes a dangling conductor endpoint to the conductor line", () => {
    const line =
      'conductor "c1": "a" -> "nowhere" conduction data: {"k":10,"area":0.1,"length":0.2}';
    const text = minimalText([line]);
    const result = parseText(text);
    expectError(result, /Conductor c1 references missing node: nowhere/);
    const semantic = result.errors.find((e) =>
      /references missing node/.test(e.message),
    )!;
    expect(semantic.line).toBe(text.split("\n").indexOf(line) + 1);
  });

  it("leaves line undefined for whole-document semantic errors", () => {
    // Valid structure, but no boundary node -> whole-document semantic error.
    const text = [
      HEADER,
      'network "mini" {',
      'settings: {"mode":"steady","tolerance":1e-9,"maxIterations":100}',
      'fluid: {"model":"incompressible","preset":"water"}',
      'node "a" internal @ (0, 0, 0) data: {"pressure":200000,"temperature":300}',
      'node "b" internal @ (1, 0, 0) data: {"pressure":100000,"temperature":300}',
      'branch "p1": "a" -> "b" pipe data: {"length":1,"diameter":0.05,"roughness":1e-5}',
      "}",
      "",
    ].join("\n");
    const result = parseText(text);
    expectError(result, /No boundary nodes defined/);
    const semantic = result.errors.find((e) =>
      /No boundary nodes/.test(e.message),
    )!;
    expect(semantic.line).toBeUndefined();
  });

  it("rejects structural decode failures and attributes them to the entity line", () => {
    // pressureSchedule pairs must be arrays: decode rejects nodes[2]-style paths.
    const nodeLine =
      'node "n2" boundary @ (5, 0, 0) data: {"pressure":1,"temperature":2,"pressureSchedule":[5]}';
    const result = parseText(minimalText([nodeLine]));
    expectError(result, /config decode failed/);
    const decodeErr = result.errors.find((e) =>
      /config decode failed/.test(e.message),
    )!;
    expect(decodeErr.line).toBe(result.lineMap.get("node:n2")!.startLine);
  });
});

/* ------------------------------------------------------------------ */
/* 4. Elevation (z) handling                                           */
/* ------------------------------------------------------------------ */

describe("elevation", () => {
  it("absent position.z remains absent; explicit zero remains zero", () => {
    const config = minimalConfig();
    config.nodes[1].position = { z: 0 };
    const { text, parsed } = expectRoundTrip(config);
    const lines = text.split("\n");
    const lineA = lines.find((l) => l.startsWith('node "a" '))!;
    const lineB = lines.find((l) => l.startsWith('node "b" '))!;
    expect(lineA).toContain("@ (0, 0)");
    expect(lineA).not.toContain('"position"');
    expect(lineB).toContain('"position":{"z":0}');
    expect(parsed.nodes[0].position).toBeUndefined();
    expect(parsed.nodes[1].position).toEqual({ z: 0 });
  });

  it("accepts a legacy third @ coordinate as position.z", () => {
    const text = serializeText(minimalConfig()).replace(
      'node "a" boundary @ (0, 0)',
      'node "a" boundary @ (0, 0, 4.5)',
    );
    const result = parseText(text);
    expect(result.errors).toEqual([]);
    const a = result.config!.nodes.find((n) => n.id === "a")!;
    expect(a.z).toBeUndefined();
    expect(a.position).toEqual({ z: 4.5 });
  });

  it('computes "elevationChange": "derived" as z_to - z_from from a hand-edited payload', () => {
    const config = minimalConfig();
    config.nodes[0].position = { z: 2 };
    config.nodes[1].position = { z: 5 };
    config.branches[0].component = {
      type: "pipe",
      length: 1,
      diameter: 0.05,
      roughness: 1e-5,
      elevationChange: 3,
    };
    const { text } = serializeTextWithLineMap(config);
    const edited = text.replace(
      '"elevationChange":3',
      '"elevationChange":"derived"',
    );
    expect(edited).not.toBe(text);
    const result = parseText(edited);
    expect(result.errors).toEqual([]);
    const comp = result.config!.branches[0].component as {
      elevationChange?: number;
    };
    expect(comp.elevationChange).toBe(5 - 2);
  });

  it("treats a missing z as 0 for the derived marker", () => {
    const config = minimalConfig();
    config.nodes[1].position = { z: 7 };
    config.branches[0].component = {
      type: "pipe",
      length: 1,
      diameter: 0.05,
      roughness: 1e-5,
      elevationChange: 1,
    };
    const { text } = serializeTextWithLineMap(config);
    const edited = text.replace(
      '"elevationChange":1',
      '"elevationChange":"derived"',
    );
    const result = parseText(edited);
    expect(result.errors).toEqual([]);
    expect(
      (result.config!.branches[0].component as { elevationChange?: number })
        .elevationChange,
    ).toBe(7);
  });

  it("leaves the derived marker in place on unknown endpoints (dangling ref reported)", () => {
    const text = minimalText([
      'branch "p1": "a" -> "ghost" pipe data: {"length":1,"diameter":0.05,"roughness":1e-5,"elevationChange":"derived"}',
    ]);
    const result = parseText(text);
    expectError(result, /Branch p1 references missing node: ghost/);
  });
});

/* ------------------------------------------------------------------ */
/* 5. Unit-preset compatibility (SI-only core)                         */
/* ------------------------------------------------------------------ */

describe("unit presets", () => {
  it("the 'Metric engineering' preset is accepted and SI values round-trip bit-exactly (no unit labels)", () => {
    // The preset is passed BY NAME (a UnitPresetReference string), so this
    // suite needs no import from the UI layer (ui/units METRIC_PRESET).
    const metric = "Metric engineering";
    const migrated = fixtures["Water distribution network"];
    const siText = serializeText(migrated);
    const metricText = serializeText(migrated, { preset: metric });
    // No conversion and no display-unit decoration: byte-identical output.
    expect(metricText).toBe(siText);
    expect(metricText).not.toMatch(/bar|°C|\bmm\b|kg\/h/);
    const result = parseText(metricText, { preset: metric });
    expect(result.errors).toEqual([]);
    expect(result.config).toStrictEqual(migrated);
  });

  it("showGeometry remains compatibility-only (geometry always emitted)", () => {
    const config = minimalConfig();
    const withFlag = serializeText(config, { showGeometry: false });
    expect(withFlag).toBe(serializeText(config));
    expect(withFlag).toContain("@ (0, 0)");
    const parsed = parseText(withFlag, { showGeometry: false });
    expect(parsed.errors).toEqual([]);
    expect(parsed.config).toStrictEqual(config);
  });
});

/* ------------------------------------------------------------------ */
/* 6. lineMap                                                          */
/* ------------------------------------------------------------------ */

describe("lineMap", () => {
  it("is a Map whose ranges point at the matching entity lines", () => {
    const migrated = fixtures["Heated pipe with radiating wall (conjugate HT)"];
    const { text, lineMap } = serializeTextWithLineMap(migrated);
    expect(lineMap).toBeInstanceOf(Map);
    const lines = text.split("\n");
    const keywords: Record<string, string> = {
      node: "node",
      solid: "solid",
      branch: "branch",
      conductor: "conductor",
      group: "group",
    };
    let checked = 0;
    for (const [key, range] of lineMap) {
      const sep = key.indexOf(":");
      const kind = key.slice(0, sep);
      const id = key.slice(sep + 1);
      expect(keywords[kind]).toBeDefined();
      expect(range.startLine).toBeGreaterThanOrEqual(1);
      expect(range.endLine).toBe(range.startLine); // single-line records
      const line = lines[range.startLine - 1];
      expect(line.startsWith(`${keywords[kind]} ${JSON.stringify(id)}`)).toBe(
        true,
      );
      checked++;
    }
    const expectedCount =
      migrated.nodes.length +
      (migrated.solidNodes?.length ?? 0) +
      migrated.branches.length +
      (migrated.conductors?.length ?? 0) +
      (migrated.groups?.length ?? 0);
    expect(checked).toBe(expectedCount);
    expect(checked).toBeGreaterThan(0);

    // Parse-side line map agrees exactly.
    const parsed = parseText(text);
    expect(parsed.errors).toEqual([]);
    expect(parsed.lineMap).toBeInstanceOf(Map);
    expect([...parsed.lineMap.entries()]).toEqual([...lineMap.entries()]);
  });
});

/* ------------------------------------------------------------------ */
/* 7. Presence metadata + uncommon content fixtures                    */
/* ------------------------------------------------------------------ */

describe("optional empty entity arrays", () => {
  function withEmptyArrays(): NetworkConfig {
    return {
      meta: { name: "empty-arrays", version: 2 },
      settings: { mode: "steady", tolerance: 1e-9, maxIterations: 50 },
      fluid: { model: "incompressible", preset: "water" },
      nodes: [
        {
          id: "a",
          type: "boundary",
          x: 0,
          y: 0,
          pressure: 200_000,
          temperature: 300,
        },
        {
          id: "b",
          type: "boundary",
          x: 10,
          y: 0,
          pressure: 100_000,
          temperature: 300,
        },
      ],
      solidNodes: [],
      conductors: [],
      groups: [],
      notes: [],
      logic: [],
      registers: {},
      branches: [
        {
          id: "p",
          from: "a",
          to: "b",
          component: { type: "pipe", length: 1, diameter: 0.05, roughness: 0 },
        },
      ],
    };
  }

  it("present-but-empty solidNodes/conductors/groups/notes survive the round trip", () => {
    const config = withEmptyArrays();
    const { text, parsed } = expectRoundTrip(config);
    // Compact deterministic presence metadata is emitted...
    expect(text).toContain("\nsolidNodes: []\n");
    expect(text).toContain("\nconductors: []\n");
    expect(text).toContain("\ngroups: []\n");
    expect(text).toContain("\nnotes: []\n");
    // ...and reconstructs the present-empty arrays exactly.
    expect(parsed.solidNodes).toEqual([]);
    expect(parsed.conductors).toEqual([]);
    expect(parsed.groups).toEqual([]);
    expect(parsed.notes).toEqual([]);
    expect(parsed.logic).toEqual([]);
    expect(parsed.registers).toEqual({});
  });

  it("absent optional arrays remain absent", () => {
    const config = withEmptyArrays();
    delete config.solidNodes;
    delete config.conductors;
    delete config.groups;
    delete config.notes;
    const { text, parsed } = expectRoundTrip(config);
    expect(text).not.toContain("solidNodes:");
    expect(text).not.toContain("conductors:");
    expect(text).not.toContain("groups:");
    expect(text).not.toContain("notes:");
    expect("solidNodes" in parsed).toBe(false);
    expect("conductors" in parsed).toBe(false);
    expect("groups" in parsed).toBe(false);
    expect("notes" in parsed).toBe(false);
  });

  it("rejects a marker that conflicts with records of the same category", () => {
    const text = minimalText([
      "solidNodes: []",
      'solid "s1" solid @ (0, 0) data: {"temperature":300}',
    ]);
    expectError(parseText(text), /'solidNodes' declared empty/);
  });

  it("round-trips canvas notes, including multiline text and a group pin", () => {
    const config = minimalConfig();
    config.groups = [{ id: "G1", label: "Core", x: 0, y: 0 }];
    config.notes = [
      {
        id: "NOTE1",
        text: "Orifice Cd from Idelchik §4.\nRe-check above Re 1e5.",
        x: 60,
        y: -45,
      },
      {
        id: "NOTE2",
        text: 'Ω: quoted "review" note',
        x: 15,
        y: 90,
        width: 240,
        height: 120,
        group: "G1",
      },
    ];
    const { text, parsed } = expectRoundTrip(config);
    // Newlines and quotes ride inside the single-line JSON payload.
    expect(text).toContain(
      'note "NOTE1" @ (60, -45) data: {"text":"Orifice Cd from Idelchik §4.\\nRe-check above Re 1e5."}',
    );
    expect(parsed.notes?.[0].text).toContain("\n");
    // An auto-sized note stays auto-sized; a resized one keeps its exact box.
    expect("width" in parsed.notes![0]).toBe(false);
    expect(parsed.notes?.[1]).toMatchObject({
      width: 240,
      height: 120,
      group: "G1",
    });
  });

  it("rejects a note size that could not be rendered", () => {
    expectError(
      parseText(
        minimalText(['note "NOTE1" @ (0, 0) data: {"text":"hi","width":0}']),
      ),
      /notes\[0\]\.width/,
    );
    expectError(
      parseText(
        minimalText([
          'note "NOTE1" @ (0, 0) data: {"text":"hi","height":"tall"}',
        ]),
      ),
      /notes\[0\]\.height/,
    );
  });

  it("rejects a note record whose data payload repeats a record-line key", () => {
    expectError(
      parseText(
        minimalText(['note "NOTE1" @ (0, 0) data: {"text":"hi","x":5}']),
      ),
      /data payload contains reserved key "x"/,
    );
  });

  it("rejects a note without text at the decode boundary", () => {
    expectError(
      parseText(minimalText(['note "NOTE1" @ (0, 0) data: {}'])),
      /notes\[0\]\.text/,
    );
  });

  it("rejects a non-empty or duplicate marker", () => {
    expectError(
      parseText(minimalText(['groups: [{"id":"g"}]'])),
      /'groups' marker must be the empty array literal/,
    );
    expectError(
      parseText(minimalText(["conductors: []", "conductors: []"])),
      /duplicate 'conductors' marker/,
    );
  });
});

describe("uncommon top-level and nested content", () => {
  function uncommonConfig(): NetworkConfig {
    return {
      meta: { name: 'Fixture: uncommon content "Ω"', version: 2 },
      closureParams: { solidCpScale: 1.05 },
      settings: {
        mode: "transient",
        dt: 0.05,
        endTime: 1,
        tolerance: 1e-9,
        maxIterations: 100,
        relaxation: 0.9,
        gravity: { x: 0, y: -9.80665, z: 0 },
        timeStepping: "fixed",
        steadySolver: "ptc",
        globalization: "trustRegion",
        jacobian: "hybrid",
      },
      fluid: {
        model: "idealGas",
        params: { R: 296.8, gamma: 1.4, mu: 2.2e-5, cp: 1040 },
      },
      species: {
        names: ["N2", "O2"],
        molecularWeights: [0.028, 0.032],
        cp: [1040, 918],
        formationEnthalpy: [0, 0],
        viscosity: [1.8e-5, 2.0e-5],
        reactions: [
          {
            reactants: { N2: 1 },
            products: { O2: 1 },
            A: 0,
            b: 0,
            Ea: 0,
            heatOfReaction: 0,
          },
        ],
      },
      registers: { throttle: 0.5 },
      logic: [
        {
          id: "bump",
          on: "stepAccepted",
          when: "1",
          set: { throttle: "throttle + 0" },
        },
      ],
      controllers: [
        {
          id: "pid1",
          type: "pid",
          sense: { kind: "branch", id: "b2", quantity: "massFlow" },
          setpoint: 0.2,
          gains: { kp: 0.1, ki: 0.01, kd: 0 },
          output: { kind: "flowRate", id: "b1" },
          limits: { min: 0, max: 1 },
          initialOutput: 0.1,
        },
      ],
      componentLibrary: {
        "my-k": {
          format: "defineComponent",
          description: "K-factor resistance with\nmultiline description",
          metadata: {
            name: "my-k",
            label: "My K",
            params: [{ name: "K", default: 1, min: 0 }],
          },
          code: "defineComponent({\n  metadata: { name: 'my-k', label: 'My K', params: [{ name: 'K', default: 1, min: 0 }] },\n  pressureDrop(args) { return args.params.K; }\n});",
        },
      },
      groups: [{ id: "G1", label: "Core Ω group", x: 10, y: 20 }],
      nodes: [
        {
          id: "in",
          type: "boundary",
          group: "G1",
          x: 0,
          y: 0,
          position: { z: 0 },
          pressure: 300_000,
          temperature: 300,
          massFractions: { N2: 0.8, O2: 0.2 },
          pressureSchedule: [[0, 300_000]],
          label: 'Inlet "A"',
        },
        {
          id: "mid",
          type: "internal",
          x: 100,
          y: 0,
          pressure: 250_000,
          temperature: 300,
          volume: 0.01,
        },
        {
          id: "out",
          type: "boundary",
          x: 200,
          y: 0,
          position: { z: -2.5 },
          pressure: 100_000,
          temperature: 280,
        },
      ],
      solidNodes: [
        {
          id: "wall",
          type: "solid",
          x: 100,
          y: 50,
          temperature: 350,
          mass: 0.5,
          cp: {
            table: [
              [200, 400],
              [400, 500],
            ],
          },
          heatInput: 10,
        },
        {
          id: "amb",
          type: "ambient",
          x: 100,
          y: -50,
          temperature: 290,
          temperatureSchedule: [
            [0, 290],
            [1, 295],
          ],
        },
      ],
      branches: [
        {
          id: "b1",
          from: "in",
          to: "mid",
          component: {
            type: "flowSource",
            massFlow: 0.1,
            massFlowSchedule: [
              [0, 0.1],
              [1, 0.2],
            ],
          },
        },
        {
          id: "b2",
          from: "mid",
          to: "out",
          component: {
            type: "dpTable",
            points: [
              [0, 0],
              [0.1, 50_000],
              [0.2, 120_000],
            ],
            extrapolate: "clamp",
          },
          label: "Tabulated ΔP",
        },
        {
          id: "b3",
          from: "in",
          to: "out",
          component: {
            type: "userComponent",
            component: "my-k",
            params: { K: 1.5 },
            area: 1e-4,
          },
        },
      ],
      conductors: [
        {
          id: "cd1",
          from: "wall",
          to: "amb",
          type: {
            kind: "conduction",
            k: { material: "ofhc-copper" },
            area: 0.01,
            length: 0.2,
          },
        },
        {
          id: "cv1",
          from: "wall",
          to: "mid",
          type: { kind: "convection", h: 25, area: 0.05 },
        },
        {
          id: "r1",
          from: "wall",
          to: "amb",
          type: {
            kind: "radiation",
            emissivity: 0.5,
            area: 0.02,
            viewFactor: 0.5,
          },
          label: "rad",
        },
      ],
    };
  }

  it("round-trips exactly with zero errors", () => {
    expectRoundTrip(uncommonConfig());
  });

  it("serialization is stable after parse", () => {
    const config = uncommonConfig();
    const first = serializeTextWithLineMap(config);
    const parsed = parseText(first.text);
    expect(parsed.errors).toEqual([]);
    const second = serializeTextWithLineMap(parsed.config!);
    expect(second.text).toBe(first.text);
  });
});

describe("named fluids map", () => {
  it("round-trips fluids: and node.fluid in data JSON", () => {
    const config = minimalConfig();
    config.fluids = {
      oil: {
        model: "incompressible",
        params: { rho: 850, mu: 0.03, cp: 2000 },
      },
    };
    config.nodes = config.nodes.map((n) => ({ ...n, fluid: "oil" }));
    const { text } = serializeTextWithLineMap(config);
    expect(text).toContain("fluids: ");
    expect(text).toContain('"oil"');
    expect(text).toContain('"fluid":"oil"');
    const parsed = parseText(text);
    expect(parsed.errors).toEqual([]);
    expect(parsed.config).toStrictEqual(config);
  });
});

/* ------------------------------------------------------------------ */
/* 8. Never-throw robustness                                           */
/* ------------------------------------------------------------------ */

describe("parseText never throws", () => {
  const base = serializeText(fixtures["Three-pipe junction"]);

  it("handles degenerate and binary-ish inputs", () => {
    const samples = [
      "",
      "\n",
      " ",
      "}",
      "{",
      '"',
      "\\",
      "a\u0000b\u0001",
      HEADER,
      `${HEADER}\nnetwork "x" {`,
      `${HEADER}\nnetwork "x" {\n}\n}\n`,
      `${HEADER}\nnetwork "x" {\nnode "n" boundary @ (0, 0, 0) data: }\n}\n`,
      `${HEADER}\nnetwork "x" {\nnode "" boundary @ (0, 0, 0) data: {}\n}\n`,
      `${HEADER}\nnetwork "\\u00e9" {\n}\n`,
      "\uFEFF" + base, // BOM-prefixed
      base.replace(/\n/g, "\r\n"), // CRLF
      "x".repeat(100_000),
    ];
    for (const s of samples) {
      let result: ParseResult | undefined;
      expect(() => {
        result = parseText(s);
      }).not.toThrow();
      expect(result).toBeDefined();
      expect(Array.isArray(result!.errors)).toBe(true);
      expect(result!.lineMap).toBeInstanceOf(Map);
    }
  });

  it("handles every line-boundary truncation of a valid document", () => {
    const lines = base.split("\n");
    for (let i = 0; i <= lines.length; i++) {
      const prefix = lines.slice(0, i).join("\n");
      let result: ParseResult | undefined;
      expect(() => {
        result = parseText(prefix);
      }).not.toThrow();
      expect(Array.isArray(result!.errors)).toBe(true);
    }
  });

  it("handles deterministic pseudo-random mutations of a valid document", () => {
    // Seeded LCG — no unseeded randomness in tests.
    let state = 0x2f6e2b1;
    const rand = (): number => {
      state = (state * 1103515245 + 12345) & 0x7fffffff;
      return state / 0x7fffffff;
    };
    const alphabet = '{}[]",:->@data nodbrchq0123456789.eE\\\t';
    for (let iter = 0; iter < 300; iter++) {
      const chars = base.split("");
      const mutations = 1 + Math.floor(rand() * 6);
      for (let m = 0; m < mutations; m++) {
        const pos = Math.floor(rand() * chars.length);
        const op = rand();
        if (op < 0.4 && chars.length > 1) {
          chars.splice(pos, 1); // delete
        } else if (op < 0.8) {
          chars.splice(pos, 0, alphabet[Math.floor(rand() * alphabet.length)]); // insert
        } else {
          chars[pos] = alphabet[Math.floor(rand() * alphabet.length)]; // replace
        }
      }
      const mutated = chars.join("");
      let result: ParseResult | undefined;
      expect(() => {
        result = parseText(mutated);
      }).not.toThrow();
      expect(result).toBeDefined();
      expect(Array.isArray(result!.errors)).toBe(true);
      for (const err of result!.errors) {
        expect(typeof err.message).toBe("string");
        expect(err.severity).toBe("error");
        if (err.line !== undefined) {
          expect(Number.isInteger(err.line)).toBe(true);
          expect(err.line).toBeGreaterThanOrEqual(1);
        }
      }
    }
  });
});
