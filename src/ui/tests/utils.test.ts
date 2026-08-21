import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  saveToLocalStorage,
  loadFromLocalStorage,
  loadUnitPreferences,
  cloneConfig,
  modelFileName,
  serializeModelFile,
  parseModelFile,
  uploadModelFile,
  ModelFileParseError,
  MODEL_FILE_EXTENSION,
} from "../utils";
import { SI_PRESET, type UnitPreferences } from "../units";
import { examples } from "../examples";
import { parseText, serializeText } from "../../substrate/textProjection";
import { validateNetwork } from "../../core";
import { NetworkConfig } from "../types";

const CONFIG_STORAGE_KEY = "fluids-network-config-v1";

describe("utils", () => {
  let store: Record<string, string> = {};
  beforeEach(() => {
    store = {};
    Object.defineProperty(globalThis, "localStorage", {
      value: {
        getItem: (k: string) => store[k] ?? null,
        setItem: (k: string, v: string) => {
          store[k] = v;
        },
        removeItem: (k: string) => {
          delete store[k];
        },
      },
      writable: true,
    });
  });
  afterEach(() => {
    // Mirror the defineProperty mock in beforeEach (the property is
    // non-configurable but writable, so redefining the value is allowed).
    Object.defineProperty(globalThis, "localStorage", {
      value: undefined,
      writable: true,
    });
  });
  it("cloneConfig produces deep equal copy", () => {
    const cfg: NetworkConfig = {
      meta: { name: "test", version: 2 },
      settings: { mode: "steady", tolerance: 1e-6, maxIterations: 100 },
      fluid: { model: "incompressible", preset: "water" },
      nodes: [
        {
          id: "A",
          type: "boundary",
          x: 0,
          y: 0,
          pressure: 1e5,
          temperature: 300,
        },
      ],
      branches: [],
    };
    const copy = cloneConfig(cfg);
    expect(copy).toEqual(cfg);
    expect(copy).not.toBe(cfg);
    expect(copy.nodes[0]).not.toBe(cfg.nodes[0]);
  });

  it("round-trips config through localStorage", () => {
    const cfg: NetworkConfig = {
      meta: { name: "roundtrip", version: 2 },
      settings: {
        mode: "transient",
        dt: 0.01,
        endTime: 1,
        tolerance: 1e-4,
        maxIterations: 50,
        relaxation: 0.8,
      },
      fluid: { model: "idealGas", preset: "air" },
      nodes: [
        {
          id: "tank",
          type: "internal",
          x: 0,
          y: 0,
          pressure: 5e5,
          temperature: 300,
          volume: 0.1,
        },
        {
          id: "amb",
          type: "boundary",
          x: 100,
          y: 0,
          pressure: 101325,
          temperature: 300,
        },
      ],
      branches: [
        {
          id: "o1",
          from: "tank",
          to: "amb",
          component: { type: "orifice", area: 0.001, cd: 0.6 },
        },
      ],
    };
    saveToLocalStorage(cfg);
    const loaded = loadFromLocalStorage();
    expect(loaded).toEqual(cfg);
  });

  it("loadUnitPreferences keeps stored choices and defaults kinds an older build lacked", () => {
    // Simulate prefs persisted before the specificHeat kind existed.
    const legacy = {
      ...SI_PRESET,
      pressure: "psi",
    } as Partial<UnitPreferences>;
    delete legacy.specificHeat;
    localStorage.setItem("fluids-network-units-v1", JSON.stringify(legacy));
    const loaded = loadUnitPreferences();
    expect(loaded).not.toBeNull();
    expect(loaded!.pressure).toBe("psi"); // stored choice preserved
    expect(loaded!.specificHeat).toBe(SI_PRESET.specificHeat); // new kind defaulted
  });

  /* ── Model files (.fn text projection) ──────────────────────────────── */

  const modelCfg = (): NetworkConfig => ({
    meta: { name: "My model", version: 2 },
    settings: { mode: "steady", tolerance: 1e-6, maxIterations: 100 },
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
        id: "b",
        type: "boundary",
        x: 100,
        y: 0,
        pressure: 1e5,
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
  });

  it("serializeModelFile is the canonical text projection and modelFileName is a safe .fn name", () => {
    const cfg = modelCfg();
    expect(serializeModelFile(cfg)).toBe(serializeText(cfg));
    expect(
      serializeModelFile(cfg).startsWith("// Fluid Network config v2\n"),
    ).toBe(true);
    expect(modelFileName(cfg)).toBe(`My_model${MODEL_FILE_EXTENSION}`);
    expect(modelFileName({ ...cfg, meta: { ...cfg.meta, name: "***" } })).toBe(
      `network${MODEL_FILE_EXTENSION}`,
    );
  });

  it("parseModelFile round-trips the text projection exactly", () => {
    const cfg = modelCfg();
    const parsed = parseModelFile(serializeModelFile(cfg));
    expect(parsed).toStrictEqual(cfg);
  });

  it("parseModelFile rejects invalid text with a ModelFileParseError carrying line diagnostics", () => {
    expect.assertions(4);
    try {
      parseModelFile("nonsense");
    } catch (err) {
      expect(err).toBeInstanceOf(ModelFileParseError);
      expect((err as Error).message).toMatch(/invalid model file/);
      expect((err as Error).message).toMatch(/line 1:.*header/);
      expect((err as ModelFileParseError).diagnostics.length).toBeGreaterThan(
        0,
      );
    }
  });

  it("parseModelFile rejects semantically invalid text (dangling reference) atomically", () => {
    const text = serializeText(modelCfg()).replace(
      'branch "p1": "a" -> "b"',
      'branch "p1": "a" -> "nope"',
    );
    expect(() => parseModelFile(text)).toThrow(ModelFileParseError);
  });

  it("parseModelFile rejects JSON content (only the .fn text projection is supported)", () => {
    expect(() => parseModelFile(JSON.stringify(modelCfg()))).toThrow(
      ModelFileParseError,
    );
  });

  it("uploadModelFile parses a .fn file and rejects garbage", async () => {
    const cfg = modelCfg();
    const good = new File([serializeModelFile(cfg)], "model.fn");
    expect(await uploadModelFile(good)).toStrictEqual(cfg);
    await expect(
      uploadModelFile(new File(["garbage"], "bad.fn")),
    ).rejects.toThrow(ModelFileParseError);
  });

  it("every bundled example serializes to a .fn file that parses back exactly", () => {
    for (const example of Object.values(examples)) {
      const text = serializeModelFile(example);
      const result = parseText(text);
      expect(result.errors).toEqual([]);
      expect(parseModelFile(text)).toStrictEqual(example);
    }
  });

  it("loadFromLocalStorage returns null for malformed or unsupported persisted configs", () => {
    // Invalid JSON.
    localStorage.setItem(CONFIG_STORAGE_KEY, "{ nope");
    expect(loadFromLocalStorage()).toBeNull();
    // Valid JSON, wrong shape (missing settings/fluid/nodes/branches).
    localStorage.setItem(
      CONFIG_STORAGE_KEY,
      JSON.stringify({ meta: { name: "x", version: 2 } }),
    );
    expect(loadFromLocalStorage()).toBeNull();
    // Unsupported versions (other builds).
    for (const version of [1, 3]) {
      localStorage.setItem(
        CONFIG_STORAGE_KEY,
        JSON.stringify({
          meta: { name: "x", version },
          settings: { mode: "steady", tolerance: 1e-6, maxIterations: 100 },
          fluid: { model: "incompressible", preset: "water" },
          nodes: [],
          branches: [],
        }),
      );
      expect(loadFromLocalStorage()).toBeNull();
    }
    // Malformed arrays (hand-edited storage).
    localStorage.setItem(
      CONFIG_STORAGE_KEY,
      JSON.stringify({
        meta: { name: "x", version: 2 },
        settings: { mode: "steady", tolerance: 1e-6, maxIterations: 100 },
        fluid: { model: "incompressible", preset: "water" },
        nodes: [null],
        branches: [],
      }),
    );
    expect(loadFromLocalStorage()).toBeNull();
  });

  it("round-trips every bundled example through localStorage unchanged", () => {
    for (const example of Object.values(examples)) {
      saveToLocalStorage(example);
      expect(loadFromLocalStorage()).toEqual(example);
    }
  });

  it("round-trips config with schedules and pump curves through localStorage", () => {
    const cfg: NetworkConfig = {
      meta: { name: "schedules", version: 2 },
      settings: {
        mode: "transient",
        dt: 0.01,
        endTime: 1,
        tolerance: 1e-4,
        maxIterations: 50,
        relaxation: 0.8,
      },
      fluid: { model: "idealGas", preset: "air" },
      nodes: [
        {
          id: "b1",
          type: "boundary",
          x: 0,
          y: 0,
          pressure: 200000,
          temperature: 300,
          pressureSchedule: [
            [0, 200000],
            [0.5, 150000],
            [1, 100000],
          ],
          temperatureSchedule: [
            [0, 300],
            [1, 350],
          ],
        },
        {
          id: "int",
          type: "internal",
          x: 100,
          y: 0,
          pressure: 150000,
          temperature: 300,
          volume: 0.1,
        },
      ],
      branches: [
        {
          id: "v1",
          from: "b1",
          to: "int",
          component: {
            type: "valve",
            area: 0.001,
            cd: 0.6,
            position: 1,
            positionSchedule: [
              [0, 1],
              [0.5, 0.5],
              [1, 0],
            ],
          },
        },
        {
          id: "p1",
          from: "int",
          to: "b1",
          component: {
            type: "pump",
            curve: [
              [0, 50000],
              [0.001, 40000],
              [0.002, 30000],
            ],
          },
        },
      ],
    };
    saveToLocalStorage(cfg);
    const loaded = loadFromLocalStorage();
    expect(loaded).toEqual(cfg);
  });
});

describe("examples", () => {
  it("Three-pipe junction passes validation", () => {
    const errs = validateNetwork(examples["Three-pipe junction"]);
    expect(errs).toEqual([]);
  });

  it("Tank blowdown passes validation", () => {
    const errs = validateNetwork(examples["Tank blowdown"]);
    expect(errs).toEqual([]);
  });
});
