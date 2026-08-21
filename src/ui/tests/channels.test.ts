import { describe, it, expect } from "vitest";
import {
  ChannelDescriptor,
  ChannelId,
  DEFAULT_CHANNEL_LIMIT,
  channelFieldInfo,
  channelKey,
  defaultChannels,
  filterChannels,
  groupChannelsByQuantity,
  listChannelFields,
  listChannels,
  parseChannelKey,
  primaryChannelForSelection,
  resolveChannel,
  resolveChannelAt,
  selectionForChannel,
} from "../channels";
import {
  NetworkConfig,
  Selection,
  SteadyResult,
  TransientResult,
} from "../types";
import type { QuantityKind } from "../units";

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

const config: NetworkConfig = {
  meta: { name: "channels-fixture", version: 2 },
  settings: { mode: "steady", tolerance: 1e-8, maxIterations: 60 },
  fluid: { model: "incompressible", params: { rho: 1000 } },
  nodes: [
    {
      id: "n1",
      label: "Feed Tank",
      type: "boundary",
      x: 0,
      y: 0,
      pressure: 101325,
      temperature: 300,
    },
    { id: "n2", type: "internal", x: 100, y: 0, volume: 0.01 },
  ],
  branches: [
    {
      id: "b1",
      label: "Main Pipe",
      from: "n1",
      to: "n2",
      component: { type: "pipe", length: 2, diameter: 0.05, roughness: 1e-5 },
    },
  ],
  solidNodes: [
    { id: "s1", label: "Wall", type: "solid", x: 50, y: 60, temperature: 300 },
  ],
  conductors: [
    {
      id: "c1",
      from: "n2",
      to: "s1",
      type: { kind: "conduction", k: 400, area: 0.5, length: 0.005 },
    },
  ],
};

const steady: SteadyResult = {
  converged: true,
  iterations: 5,
  residual: 1e-9,
  nodes: {
    // n1 stays minimal so "absent optionals are skipped" keeps being exercised.
    n1: { pressure: 101325, temperature: 300, density: 1000 },
    n2: {
      pressure: 100000,
      temperature: 299,
      density: 1001,
      quality: 0.5,
      enthalpy: 125e3,
      internalEnergy: 124e3,
      entropy: 430,
      specificHeat: 4182,
      viscosity: 8.5e-4,
      thermalConductivity: 0.6,
      speedOfSound: 1500,
    },
  },
  branches: {
    b1: {
      mdot: 0.5,
      velocity: 0.06,
      dP: 1325,
      reynolds: 6000,
      mach: 4e-5,
      volumetricFlow: 5e-4,
      massFlux: 255,
      dynamicPressure: 1.8,
    },
  },
  solidNodes: { s1: { temperature: 310 } },
  conductors: { c1: { heatRate: 42, heatTransferCoeff: 120, heatFlux: 84 } },
};

const transient: TransientResult = {
  converged: true,
  times: [0, 0.5, 1],
  nodes: {
    n1: {
      pressure: [101325, 101300, 101250],
      temperature: [300, 301, 302],
      density: [1000, 999, 998],
      gasVolume: [0.1, 0.2, 0.3],
      enthalpy: [100e3, 101e3, 102e3],
      viscosity: [9e-4, 8.8e-4, 8.6e-4],
    },
    n2: {
      pressure: [100000, 100100, 100200],
      temperature: [299, 299.5, 300],
      density: [1001, 1002, 1003],
      quality: [0, 0.5, 1],
    },
  },
  branches: {
    b1: {
      mdot: [0.1, 0.2, 0.3],
      velocity: [0.01, 0.02, 0.03],
      dP: [100, 200, 300],
      reynolds: [1000, 2000, 3000],
    },
  },
  solidNodes: { s1: { temperature: [300, 305, 310] } },
  conductors: {
    c1: {
      heatRate: [10, 20, 30],
      heatTransferCoeff: [100, 110, 120],
      heatFlux: [20, 40, 60],
    },
  },
  ttWf: {
    c1: {
      fWet: [0, 0.5, 1],
      rewetLatched: [false, false, true],
      regime: ["FB", "TB", "NB"],
    },
  },
  fluidFront: { n2: { fraction: [0, 0.25, 1] } },
};

/** `entity:id:field` tuples, in listing order. */
function tripletKeys(channels: readonly ChannelDescriptor[]): string[] {
  return channels.map(
    (c) => `${c.channel.entity}:${c.channel.id}:${c.channel.field}`,
  );
}

function b64urlJson(payload: unknown): string {
  return `ch1.${Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")}`;
}

/* ------------------------------------------------------------------ */
/* listChannels: full inventory, every field / entity / mode           */
/* ------------------------------------------------------------------ */

describe("listChannels", () => {
  it("enumerates the full steady inventory in deterministic config order", () => {
    expect(tripletKeys(listChannels(config, steady))).toEqual([
      "node:n1:pressure",
      "node:n1:temperature",
      "node:n1:density",
      "node:n2:pressure",
      "node:n2:temperature",
      "node:n2:density",
      "node:n2:enthalpy",
      "node:n2:internalEnergy",
      "node:n2:entropy",
      "node:n2:specificHeat",
      "node:n2:viscosity",
      "node:n2:thermalConductivity",
      "node:n2:speedOfSound",
      "node:n2:quality",
      "branch:b1:mdot",
      "branch:b1:dP",
      "branch:b1:velocity",
      "branch:b1:volumetricFlow",
      "branch:b1:massFlux",
      "branch:b1:dynamicPressure",
      "branch:b1:reynolds",
      "branch:b1:mach",
      "solidNode:s1:temperature",
      "conductor:c1:heatRate",
      "conductor:c1:heatFlux",
      "conductor:c1:heatTransferCoeff",
    ]);
  });

  it("enumerates the full transient inventory including optional and side-table channels", () => {
    expect(tripletKeys(listChannels(config, transient))).toEqual([
      "node:n1:pressure",
      "node:n1:temperature",
      "node:n1:density",
      "node:n1:enthalpy",
      "node:n1:viscosity",
      "node:n1:gasVolume",
      "node:n2:pressure",
      "node:n2:temperature",
      "node:n2:density",
      "node:n2:quality",
      "node:n2:fluidFront",
      "branch:b1:mdot",
      "branch:b1:dP",
      "branch:b1:velocity",
      "branch:b1:reynolds",
      "solidNode:s1:temperature",
      "conductor:c1:heatRate",
      "conductor:c1:heatFlux",
      "conductor:c1:heatTransferCoeff",
      "conductor:c1:fWet",
    ]);
  });

  it("excludes transient-only channels from a steady inventory", () => {
    const steadyKeys = tripletKeys(listChannels(config, steady));
    for (const f of ["gasVolume", "fluidFront", "fWet"]) {
      expect(steadyKeys.some((k) => k.endsWith(`:${f}`))).toBe(false);
    }
  });

  it("skips optional fields that are absent (gasVolume/quality/enthalpy/heatTransferCoeff/fWet/fluidFront)", () => {
    const minimal: TransientResult = {
      converged: true,
      times: [0, 1],
      nodes: { n1: { pressure: [1, 2], temperature: [3, 4], density: [5, 6] } },
      branches: { b1: { mdot: [0.1, 0.2] } },
      solidNodes: { s1: { temperature: [300, 301] } },
      conductors: { c1: { heatRate: [7, 8] } },
    };
    expect(tripletKeys(listChannels(config, minimal))).toEqual([
      "node:n1:pressure",
      "node:n1:temperature",
      "node:n1:density",
      "branch:b1:mdot",
      "solidNode:s1:temperature",
      "conductor:c1:heatRate",
    ]);

    const steadyMinimal: SteadyResult = {
      converged: true,
      iterations: 1,
      residual: 0,
      nodes: { n1: { pressure: 1, temperature: 2, density: 3 } },
      branches: { b1: { mdot: 0.1, velocity: 0.2, dP: 5, reynolds: 10 } },
      solidNodes: { s1: { temperature: 300 } },
      conductors: { c1: { heatRate: 7 } },
    };
    const keys = tripletKeys(listChannels(config, steadyMinimal));
    expect(keys).not.toContain("node:n1:quality");
    expect(keys).not.toContain("conductor:c1:heatTransferCoeff");
  });

  it("returns [] for null/undefined/garbage results and never throws", () => {
    expect(listChannels(config, null)).toEqual([]);
    expect(listChannels(config, undefined)).toEqual([]);
    expect(listChannels(config, 42 as unknown as SteadyResult)).toEqual([]);
    expect(
      listChannels(config, { times: "nope" } as unknown as TransientResult),
    ).toEqual([]);
    expect(
      listChannels(null as unknown as NetworkConfig, steady).length,
    ).toBeGreaterThan(0);
  });

  it("skips transient fields present only as an empty array (phantom quality: [])", () => {
    // The solver packs `quality: []` for non-real-fluid runs (never
    // populated): a zero-sample series must not surface as a channel.
    const idealGas: TransientResult = {
      converged: true,
      times: [0, 0.5, 1],
      nodes: {
        n1: {
          pressure: [101325, 101300, 101250],
          temperature: [300, 301, 302],
          density: [1000, 999, 998],
          quality: [],
        },
        n2: {
          pressure: [100000, 100100, 100200],
          temperature: [299, 299.5, 300],
          density: [1001, 1002, 1003],
          quality: [],
        },
      },
      branches: { b1: { mdot: [0.1, 0.2, 0.3] } },
      solidNodes: { s1: { temperature: [300, 305, 310] } },
      conductors: { c1: { heatRate: [10, 20, 30] } },
    };
    const keys = tripletKeys(listChannels(config, idealGas));
    expect(keys).toEqual([
      "node:n1:pressure",
      "node:n1:temperature",
      "node:n1:density",
      "node:n2:pressure",
      "node:n2:temperature",
      "node:n2:density",
      "branch:b1:mdot",
      "solidNode:s1:temperature",
      "conductor:c1:heatRate",
    ]);
    expect(keys.some((k) => k.endsWith(":quality"))).toBe(false);
  });

  it("falls back to ids for unlabeled elements and for result elements missing from config", () => {
    // c1 has no label in the fixture config → elementLabel falls back to id.
    const steadyChannels = listChannels(config, steady);
    const c1Heat = steadyChannels.find(
      (c) => c.channel.entity === "conductor",
    )!;
    expect(c1Heat.elementLabel).toBe("c1");

    // Result element not present in the config snapshot: still listed, after
    // the config-ordered channels, labeled by id.
    const ghostSteady: SteadyResult = {
      ...steady,
      nodes: {
        ...steady.nodes,
        ghost: { pressure: 1, temperature: 2, density: 3 },
      },
    };
    const keys = tripletKeys(listChannels(config, ghostSteady));
    const ghostIdx = keys.indexOf("node:ghost:pressure");
    expect(ghostIdx).toBeGreaterThan(-1);
    expect(keys.indexOf("node:n2:density")).toBeLessThan(ghostIdx);
    const ghost = listChannels(config, ghostSteady).find(
      (c) => c.channel.id === "ghost",
    )!;
    expect(ghost.elementLabel).toBe("ghost");
  });

  it("takes element labels from the supplied config snapshot", () => {
    const channels = listChannels(config, steady);
    const byTriplet = new Map(
      channels.map((c) => [
        `${c.channel.entity}:${c.channel.id}:${c.channel.field}`,
        c,
      ]),
    );
    expect(byTriplet.get("node:n1:pressure")!.label).toBe(
      "Feed Tank · Pressure",
    );
    expect(byTriplet.get("node:n1:pressure")!.elementLabel).toBe("Feed Tank");
    expect(byTriplet.get("branch:b1:mdot")!.label).toBe(
      "Main Pipe · Mass flow",
    );
    expect(byTriplet.get("solidNode:s1:temperature")!.label).toBe(
      "Wall · Temperature",
    );
    expect(byTriplet.get("node:n2:pressure")!.label).toBe("n2 · Pressure");

    // A historical config snapshot with renamed labels relabels the same channels.
    const historical: NetworkConfig = {
      ...config,
      nodes: config.nodes.map((n) =>
        n.id === "n1" ? { ...n, label: "Old Supply" } : n,
      ),
    };
    const renamed = listChannels(historical, steady);
    expect(
      renamed.find(
        (c) => c.channel.id === "n1" && c.channel.field === "pressure",
      )!.label,
    ).toBe("Old Supply · Pressure");
  });

  it("reports quantity/rawUnit/availability/signed honestly", () => {
    const channels = listChannels(config, transient);
    const byTriplet = new Map(
      channels.map((c) => [
        `${c.channel.entity}:${c.channel.id}:${c.channel.field}`,
        c,
      ]),
    );

    expect(byTriplet.get("node:n1:gasVolume")!.quantity).toBe("volume");
    expect(byTriplet.get("conductor:c1:heatTransferCoeff")!.quantity).toBe(
      "heatTransferCoeff",
    );
    expect(byTriplet.get("conductor:c1:heatRate")!.quantity).toBe("power");
    expect(byTriplet.get("conductor:c1:heatFlux")!.quantity).toBe("heatFlux");
    expect(byTriplet.get("branch:b1:mdot")!.quantity).toBe("massFlow");

    expect(byTriplet.get("branch:b1:mdot")!.signed).toBe(true);
    expect(byTriplet.get("branch:b1:velocity")!.signed).toBe(true);
    expect(byTriplet.get("conductor:c1:heatRate")!.signed).toBe(true);
    expect(byTriplet.get("conductor:c1:heatFlux")!.signed).toBe(true);
    expect(byTriplet.get("node:n1:pressure")!.signed).toBe(false);

    expect(byTriplet.get("node:n1:gasVolume")!.availability).toBe("transient");
    expect(byTriplet.get("conductor:c1:fWet")!.availability).toBe("transient");
    expect(byTriplet.get("node:n2:fluidFront")!.availability).toBe("transient");
    expect(byTriplet.get("node:n1:pressure")!.availability).toBe("both");

    const steadyChannels = listChannels(config, steady);
    const steadyByTriplet = new Map(
      steadyChannels.map((c) => [
        `${c.channel.entity}:${c.channel.id}:${c.channel.field}`,
        c,
      ]),
    );
    expect(steadyByTriplet.get("branch:b1:dP")!.signed).toBe(true);
    expect(steadyByTriplet.get("branch:b1:dynamicPressure")!.signed).toBe(
      false,
    );
    expect(steadyByTriplet.get("node:n2:quality")!.availability).toBe("both");
  });

  it("gives every thermodynamic property an honest, convertible quantity kind", () => {
    const byTriplet = new Map(
      listChannels(config, steady).map((c) => [
        `${c.channel.entity}:${c.channel.id}:${c.channel.field}`,
        c,
      ]),
    );
    const expected: Record<string, QuantityKind> = {
      "node:n2:enthalpy": "specificEnergy",
      "node:n2:internalEnergy": "specificEnergy",
      "node:n2:entropy": "specificEntropy",
      "node:n2:specificHeat": "specificHeat",
      "node:n2:viscosity": "viscosity",
      "node:n2:thermalConductivity": "thermalConductivity",
      "node:n2:speedOfSound": "velocity",
      "branch:b1:volumetricFlow": "volumetricFlow",
      "branch:b1:massFlux": "massFlux",
      "branch:b1:dynamicPressure": "pressure",
      "branch:b1:mach": "dimensionless",
      "conductor:c1:heatFlux": "heatFlux",
    };
    for (const [triplet, quantity] of Object.entries(expected)) {
      const descriptor = byTriplet.get(triplet);
      expect(descriptor, triplet).toBeDefined();
      expect(descriptor!.quantity, triplet).toBe(quantity);
      // An honest kind means the value is unit-convertible, never raw SI.
      expect(descriptor!.rawUnit, triplet).toBeUndefined();
    }
  });
});

/* ------------------------------------------------------------------ */
/* Field registry (drives canvas coloring and the result tables)       */
/* ------------------------------------------------------------------ */

describe("listChannelFields", () => {
  it("lists every field once, merging the entity kinds that share one", () => {
    const fields = listChannelFields();
    const names = fields.map((f) => f.field);
    expect(new Set(names).size).toBe(names.length);

    const temperature = fields.find((f) => f.field === "temperature")!;
    expect(temperature.entities).toEqual(["node", "solidNode"]);
    expect(fields.find((f) => f.field === "mach")!.entities).toEqual([
      "branch",
    ]);
    expect(fields.find((f) => f.field === "heatFlux")!.entities).toEqual([
      "conductor",
    ]);
  });

  it("carries the same metadata the channel descriptors report", () => {
    const enthalpy = channelFieldInfo("enthalpy")!;
    expect(enthalpy.label).toBe("Enthalpy");
    expect(enthalpy.quantity).toBe("specificEnergy");
    expect(enthalpy.signed).toBe(false);
    expect(channelFieldInfo("nonsense")).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/* channelKey / parseChannelKey round-trip                             */
/* ------------------------------------------------------------------ */

describe("channelKey / parseChannelKey", () => {
  it("round-trips arbitrary ids including punctuation, unicode and empty strings", () => {
    const ids = [
      "n1",
      "a.b/c:d e",
      "タンク①",
      "🚀 cryo",
      "",
      "  spaces  ",
      "line\nbreak",
      'quote"back\\slash',
    ];
    const entities: Array<ChannelId> = ids.flatMap((id) => [
      { entity: "node", id, field: "pressure" } as ChannelId,
      { entity: "branch", id, field: "mdot" } as ChannelId,
      { entity: "solidNode", id, field: "temperature" } as ChannelId,
      { entity: "conductor", id, field: "fWet" } as ChannelId,
    ]);
    for (const channel of entities) {
      expect(parseChannelKey(channelKey(channel))).toEqual(channel);
    }
  });

  it("round-trips every listed channel of both fixtures", () => {
    for (const c of [
      ...listChannels(config, steady),
      ...listChannels(config, transient),
    ]) {
      expect(parseChannelKey(c.key)).toEqual(c.channel);
    }
  });

  it("produces URL-safe keys with the versioned prefix", () => {
    const key = channelKey({
      entity: "node",
      id: "a/b+c=d",
      field: "pressure",
    });
    expect(key).toMatch(/^ch1\.[A-Za-z0-9\-_]+$/);
  });

  it("returns null (never throws) for malformed keys", () => {
    const bad: unknown[] = [
      null,
      undefined,
      42,
      "",
      "node:n1:pressure",
      "ch1.",
      "ch1.###",
      "ch2." +
        channelKey({ entity: "node", id: "n1", field: "pressure" }).slice(4),
      b64urlJson({ not: "an array" }),
      b64urlJson(["node", "n1"]),
      b64urlJson(["node", "n1", "mdot"]), // field not valid for entity
      b64urlJson(["planet", "n1", "pressure"]), // unknown entity
      b64urlJson(["node", 42, "pressure"]), // non-string id
      b64urlJson("just a string"),
    ];
    for (const k of bad) {
      expect(() => parseChannelKey(k as string)).not.toThrow();
      expect(parseChannelKey(k as string)).toBeNull();
    }
  });
});

/* ------------------------------------------------------------------ */
/* resolveChannel / resolveChannelAt                                   */
/* ------------------------------------------------------------------ */

describe("resolveChannel", () => {
  const nodePressure: ChannelId = {
    entity: "node",
    id: "n1",
    field: "pressure",
  };

  it("resolves steady scalars, including optional steady quality", () => {
    expect(resolveChannel(steady, nodePressure)).toEqual({
      kind: "scalar",
      value: 101325,
    });
    expect(
      resolveChannel(steady, { entity: "node", id: "n2", field: "quality" }),
    ).toEqual({
      kind: "scalar",
      value: 0.5,
    });
    expect(
      resolveChannel(steady, { entity: "branch", id: "b1", field: "reynolds" }),
    ).toEqual({
      kind: "scalar",
      value: 6000,
    });
    expect(
      resolveChannel(steady, {
        entity: "conductor",
        id: "c1",
        field: "heatTransferCoeff",
      }),
    ).toEqual({
      kind: "scalar",
      value: 120,
    });
  });

  it("resolves transient series including side-table channels (fluidFront, fWet)", () => {
    expect(resolveChannel(transient, nodePressure)).toEqual({
      kind: "series",
      times: [0, 0.5, 1],
      values: [101325, 101300, 101250],
    });
    expect(
      resolveChannel(transient, {
        entity: "node",
        id: "n2",
        field: "fluidFront",
      }),
    ).toEqual({
      kind: "series",
      times: [0, 0.5, 1],
      values: [0, 0.25, 1],
    });
    expect(
      resolveChannel(transient, {
        entity: "conductor",
        id: "c1",
        field: "fWet",
      }),
    ).toEqual({
      kind: "series",
      times: [0, 0.5, 1],
      values: [0, 0.5, 1],
    });
  });

  it("truncates mismatched series to the aligned length", () => {
    const mismatch: TransientResult = {
      converged: true,
      times: [0, 1, 2, 3],
      nodes: {},
      branches: { b1: { mdot: [5, 6] } },
    };
    expect(
      resolveChannel(mismatch, { entity: "branch", id: "b1", field: "mdot" }),
    ).toEqual({
      kind: "series",
      times: [0, 1],
      values: [5, 6],
    });
    const valuesLonger: TransientResult = {
      converged: true,
      times: [0, 1],
      nodes: {},
      branches: { b1: { mdot: [5, 6, 7, 8] } },
    };
    expect(
      resolveChannel(valuesLonger, {
        entity: "branch",
        id: "b1",
        field: "mdot",
      }),
    ).toEqual({
      kind: "series",
      times: [0, 1],
      values: [5, 6],
    });
  });

  it("drops pairs with a non-finite time or value", () => {
    const dirty: TransientResult = {
      converged: true,
      times: [0, NaN, 2, 3],
      nodes: {},
      branches: { b1: { mdot: [1, 2, Infinity, 4] } },
    };
    expect(
      resolveChannel(dirty, { entity: "branch", id: "b1", field: "mdot" }),
    ).toEqual({
      kind: "series",
      times: [0, 3],
      values: [1, 4],
    });
  });

  it("returns an empty series for a present-but-empty field", () => {
    const empty: TransientResult = {
      converged: true,
      times: [],
      nodes: {},
      branches: { b1: { mdot: [] } },
    };
    expect(
      resolveChannel(empty, { entity: "branch", id: "b1", field: "mdot" }),
    ).toEqual({
      kind: "series",
      times: [],
      values: [],
    });
  });

  it("returns null for absent elements/fields, wrong mode, non-finite scalars and garbage", () => {
    expect(
      resolveChannel(steady, {
        entity: "node",
        id: "ghost",
        field: "pressure",
      }),
    ).toBeNull();
    // transient-only field in steady mode
    expect(
      resolveChannel(steady, { entity: "node", id: "n1", field: "gasVolume" }),
    ).toBeNull();
    expect(
      resolveChannel(steady, { entity: "conductor", id: "c1", field: "fWet" }),
    ).toBeNull();
    // optional field absent on this element
    expect(
      resolveChannel(transient, {
        entity: "node",
        id: "n2",
        field: "gasVolume",
      }),
    ).toBeNull();
    expect(
      resolveChannel(transient, { entity: "branch", id: "b1", field: "mach" }),
    ).toBeNull();
    // non-finite steady scalar
    const nan: SteadyResult = {
      ...steady,
      nodes: { n1: { pressure: NaN, temperature: 300, density: 1000 } },
    };
    expect(resolveChannel(nan, nodePressure)).toBeNull();
    // garbage — never throws
    const garbage: unknown[] = [
      null,
      undefined,
      42,
      "x",
      {},
      { times: "nope" },
      { times: [0], nodes: { n1: 7 } },
      { times: [0], nodes: { n1: { pressure: "x" } } },
    ];
    for (const g of garbage) {
      expect(() =>
        resolveChannel(g as SteadyResult, nodePressure),
      ).not.toThrow();
      expect(resolveChannel(g as SteadyResult, nodePressure)).toBeNull();
    }
    expect(resolveChannel(steady, null)).toBeNull();
    expect(
      resolveChannel(steady, {
        entity: "planet",
        id: "n1",
        field: "pressure",
      } as unknown as ChannelId),
    ).toBeNull();
    expect(
      resolveChannel(steady, {
        entity: "node",
        id: "n1",
        field: "mdot",
      } as unknown as ChannelId),
    ).toBeNull();
  });
});

describe("resolveChannelAt", () => {
  const mdot: ChannelId = { entity: "branch", id: "b1", field: "mdot" };

  it("null / non-finite timeIndex selects the last sample; index clamps to range", () => {
    expect(resolveChannelAt(transient, mdot, null)).toBe(0.3);
    expect(resolveChannelAt(transient, mdot, NaN)).toBe(0.3);
    expect(resolveChannelAt(transient, mdot, 0)).toBe(0.1);
    expect(resolveChannelAt(transient, mdot, 1)).toBe(0.2);
    expect(resolveChannelAt(transient, mdot, 99)).toBe(0.3);
    expect(resolveChannelAt(transient, mdot, -10)).toBe(0.1);
  });

  it("rounds fractional indices", () => {
    expect(resolveChannelAt(transient, mdot, 1.4)).toBe(0.2);
    expect(resolveChannelAt(transient, mdot, 1.6)).toBe(0.3);
  });

  it("indexes the aligned (truncated) raw series when lengths mismatch", () => {
    const mismatch: TransientResult = {
      converged: true,
      times: [0, 1, 2, 3],
      nodes: {},
      branches: { b1: { mdot: [5, 6] } },
    };
    expect(resolveChannelAt(mismatch, mdot, null)).toBe(6);
    expect(resolveChannelAt(mismatch, mdot, 0)).toBe(5);
    expect(resolveChannelAt(mismatch, mdot, 99)).toBe(6);
  });

  it("returns null for empty series and for non-finite samples at the addressed index", () => {
    const empty: TransientResult = {
      converged: true,
      times: [],
      nodes: {},
      branches: { b1: { mdot: [] } },
    };
    expect(resolveChannelAt(empty, mdot, null)).toBeNull();

    const dirty: TransientResult = {
      converged: true,
      times: [0, 1, 2, 3],
      nodes: {},
      branches: { b1: { mdot: [1, NaN, Infinity, 4] } },
    };
    expect(resolveChannelAt(dirty, mdot, 1)).toBeNull();
    expect(resolveChannelAt(dirty, mdot, 2)).toBeNull();
    expect(resolveChannelAt(dirty, mdot, 0)).toBe(1);
    expect(resolveChannelAt(dirty, mdot, null)).toBe(4);
  });

  it("ignores timeIndex for steady scalars and never throws on garbage", () => {
    expect(
      resolveChannelAt(
        steady,
        { entity: "node", id: "n1", field: "pressure" },
        0,
      ),
    ).toBe(101325);
    expect(
      resolveChannelAt(
        steady,
        { entity: "node", id: "n1", field: "pressure" },
        null,
      ),
    ).toBe(101325);
    expect(resolveChannelAt(null, mdot, null)).toBeNull();
    expect(
      resolveChannelAt(
        { times: [0], nodes: { n1: 9 } } as unknown as TransientResult,
        mdot,
        null,
      ),
    ).toBeNull();
    expect(() => resolveChannelAt(undefined, undefined, null)).not.toThrow();
  });
});

/* ------------------------------------------------------------------ */
/* filterChannels / groupChannelsByQuantity                            */
/* ------------------------------------------------------------------ */

describe("filterChannels / groupChannelsByQuantity", () => {
  const channels = listChannels(config, transient); // 20 channels

  it("filters by entity, quantity, field, id, availability and signed (AND across criteria)", () => {
    expect(filterChannels(channels, { entity: "node" })).toHaveLength(11);
    expect(
      filterChannels(channels, { entity: ["branch", "conductor"] }),
    ).toHaveLength(8);
    expect(filterChannels(channels, { quantity: "pressure" })).toHaveLength(3);
    expect(
      filterChannels(channels, { field: ["heatRate", "fWet"] }),
    ).toHaveLength(2);
    expect(filterChannels(channels, { id: "c1" })).toHaveLength(4);
    expect(
      filterChannels(channels, { availability: "transient" }),
    ).toHaveLength(3);
    expect(
      filterChannels(channels, { signed: true }).map((c) => c.channel.field),
    ).toEqual(["mdot", "dP", "velocity", "heatRate", "heatFlux"]);
    expect(filterChannels(channels, { signed: false })).toHaveLength(15);
    // AND across criteria
    expect(
      filterChannels(channels, {
        entity: "node",
        quantity: "dimensionless",
      }).map((c) => c.channel.field),
    ).toEqual(["quality", "fluidFront"]);
    // empty filter is the identity
    expect(filterChannels(channels, {})).toEqual(channels);
    expect(filterChannels(channels)).toEqual(channels);
  });

  it("filters availability on the steady inventory", () => {
    const steadyChannels = listChannels(config, steady);
    expect(
      filterChannels(steadyChannels, { availability: "transient" }),
    ).toEqual([]);
    expect(filterChannels(steadyChannels, { availability: "both" })).toEqual(
      steadyChannels,
    );
  });

  it("groups by quantity in first-appearance order", () => {
    const groups = groupChannelsByQuantity(channels);
    expect(groups.map((g) => g.quantity)).toEqual([
      "pressure",
      "temperature",
      "density",
      "specificEnergy",
      "viscosity",
      "volume",
      "dimensionless",
      "massFlow",
      "velocity",
      "power",
      "heatFlux",
      "heatTransferCoeff",
    ]);
    const counts = Object.fromEntries(
      groups.map((g) => [g.quantity, g.channels.length]),
    );
    expect(counts).toEqual({
      pressure: 3,
      temperature: 3,
      density: 2,
      specificEnergy: 1,
      viscosity: 1,
      volume: 1,
      dimensionless: 4,
      massFlow: 1,
      velocity: 1,
      power: 1,
      heatFlux: 1,
      heatTransferCoeff: 1,
    });
    // Empty input → empty groups
    expect(groupChannelsByQuantity([])).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* defaultChannels / selection mapping                                 */
/* ------------------------------------------------------------------ */

describe("defaultChannels", () => {
  const channels = listChannels(config, transient); // 15 channels

  it("defaults to the first DEFAULT_CHANNEL_LIMIT (8) channels, deterministically", () => {
    expect(DEFAULT_CHANNEL_LIMIT).toBe(8);
    const picked = defaultChannels(channels);
    expect(picked).toEqual(channels.slice(0, 8));
    expect(defaultChannels(channels).map((c) => c.key)).toEqual(
      picked.map((c) => c.key),
    );
  });

  it("honors limit (floored, clamped at ≥ 0)", () => {
    expect(defaultChannels(channels, { limit: 3 })).toEqual(
      channels.slice(0, 3),
    );
    expect(defaultChannels(channels, { limit: 0 })).toEqual([]);
    expect(defaultChannels(channels, { limit: -2 })).toEqual([]);
    expect(defaultChannels(channels, { limit: 99 })).toEqual(channels);
    expect(defaultChannels(channels, { limit: 2.7 })).toEqual(
      channels.slice(0, 2),
    );
  });

  it("prioritizes the selected element: primary channel first, then its other channels", () => {
    const picked = defaultChannels(channels, {
      selection: { kind: "node", id: "n2" },
    });
    expect(tripletKeys(picked)).toEqual([
      "node:n2:pressure",
      "node:n2:temperature",
      "node:n2:density",
      "node:n2:quality",
      "node:n2:fluidFront",
      "node:n1:pressure",
      "node:n1:temperature",
      "node:n1:density",
    ]);
  });

  it("treats none/group/unknown selections as no priority", () => {
    const first8 = channels.slice(0, 8);
    expect(defaultChannels(channels, { selection: { kind: "none" } })).toEqual(
      first8,
    );
    expect(
      defaultChannels(channels, { selection: { kind: "group", id: "g1" } }),
    ).toEqual(first8);
    expect(
      defaultChannels(channels, { selection: { kind: "node", id: "ghost" } }),
    ).toEqual(first8);
    expect(defaultChannels(channels, { selection: null })).toEqual(first8);
  });
});

describe("selectionForChannel / primaryChannelForSelection", () => {
  const channels = listChannels(config, transient);

  it("maps every entity kind to a UI selection (descriptor or raw id input)", () => {
    const cases: Array<[ChannelId, Selection]> = [
      [
        { entity: "node", id: "n1", field: "pressure" },
        { kind: "node", id: "n1" },
      ],
      [
        { entity: "branch", id: "b1", field: "mdot" },
        { kind: "branch", id: "b1" },
      ],
      [
        { entity: "solidNode", id: "s1", field: "temperature" },
        { kind: "solidNode", id: "s1" },
      ],
      [
        { entity: "conductor", id: "c1", field: "heatRate" },
        { kind: "conductor", id: "c1" },
      ],
    ];
    for (const [channel, selection] of cases) {
      expect(selectionForChannel(channel)).toEqual(selection);
      expect(
        selectionForChannel(
          channels.find((c) => c.key === channelKey(channel))!,
        ),
      ).toEqual(selection);
    }
  });

  it("primaryChannelForSelection picks the canonical primary field per entity", () => {
    const triplets = (s: Selection) => {
      const c = primaryChannelForSelection(channels, s);
      return c
        ? `${c.channel.entity}:${c.channel.id}:${c.channel.field}`
        : undefined;
    };
    expect(triplets({ kind: "node", id: "n2" })).toBe("node:n2:pressure");
    expect(triplets({ kind: "branch", id: "b1" })).toBe("branch:b1:mdot");
    expect(triplets({ kind: "solidNode", id: "s1" })).toBe(
      "solidNode:s1:temperature",
    );
    expect(triplets({ kind: "conductor", id: "c1" })).toBe(
      "conductor:c1:heatRate",
    );
    expect(
      primaryChannelForSelection(channels, { kind: "none" }),
    ).toBeUndefined();
    expect(
      primaryChannelForSelection(channels, { kind: "group", id: "g1" }),
    ).toBeUndefined();
    expect(
      primaryChannelForSelection(channels, { kind: "node", id: "ghost" }),
    ).toBeUndefined();
    expect(primaryChannelForSelection(channels, null)).toBeUndefined();
  });

  it("falls back to the element's first channel when the primary field is absent", () => {
    const onlyMdot = channels.filter((c) => c.channel.entity === "branch");
    expect(
      primaryChannelForSelection(onlyMdot, { kind: "branch", id: "b1" })!
        .channel.field,
    ).toBe("mdot");
    const noPressure = channels.filter(
      (c) => !(c.channel.entity === "node" && c.channel.field === "pressure"),
    );
    const primary = primaryChannelForSelection(noPressure, {
      kind: "node",
      id: "n2",
    })!;
    expect(primary.channel.entity).toBe("node");
    expect(primary.channel.id).toBe("n2");
    expect(primary.channel.field).toBe("temperature"); // first remaining n2 channel
  });
});
