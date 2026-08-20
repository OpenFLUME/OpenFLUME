import { describe, it, expect } from "vitest";
import {
  decodeNetworkConfig,
  decodeAndValidateNetwork,
  ConfigDecodeError,
  SUPPORTED_CONFIG_VERSION,
} from "../config";
import { validateNetwork } from "../validate";

/** A structurally complete, semantically valid config (as parsed JSON). */
function validConfig(): Record<string, unknown> {
  return {
    meta: { name: "decode-me", version: 2 },
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
    solidNodes: [
      { id: "wall", type: "solid", x: 50, y: 100, temperature: 300 },
    ],
    conductors: [
      {
        id: "cv",
        from: "a",
        to: "wall",
        type: { kind: "convection", h: 50, area: 0.01 },
      },
    ],
    branches: [
      {
        id: "p1",
        from: "a",
        to: "b",
        component: { type: "pipe", length: 1, diameter: 0.01, roughness: 1e-5 },
      },
    ],
    registers: { gain: 2 },
    logic: [{ id: "r1", when: "1 > 0", set: { gain: "gain" } }],
    componentLibrary: { softCheck: { code: "defineComponent({})" } },
  };
}

function expectDecodeError(
  input: unknown,
  code: string,
  pathPattern: RegExp,
): void {
  try {
    decodeNetworkConfig(input);
    expect.unreachable(`expected ConfigDecodeError (${code})`);
  } catch (err) {
    expect(err).toBeInstanceOf(ConfigDecodeError);
    const e = err as ConfigDecodeError;
    expect(e.code).toBe(code);
    expect(e.path).toMatch(pathPattern);
    expect(e.message).toContain(e.path);
  }
}

describe("decodeNetworkConfig", () => {
  it("passes a canonical config through unchanged (non-destructive)", () => {
    const input = validConfig();
    const config = decodeNetworkConfig(input);
    expect(config.meta.name).toBe("decode-me");
    expect(config.meta.version).toBe(SUPPORTED_CONFIG_VERSION);
    // Decode is non-destructive when there is nothing to migrate: no
    // fields are added or dropped (position/gravity stay absent when absent).
    expect(config).toBe(input);
  });

  it("folds a legacy nodes[].z / solidNodes[].z into position.z and drops z", () => {
    const input = validConfig();
    const nodes = input.nodes as Record<string, unknown>[];
    const solids = input.solidNodes as Record<string, unknown>[];
    nodes[0]!.z = 4;
    solids[0]!.z = 1;
    const config = decodeNetworkConfig(input);
    expect(config.nodes[0].z).toBeUndefined();
    expect(config.nodes[0].position).toEqual({ z: 4 });
    expect(config.solidNodes![0].z).toBeUndefined();
    expect(config.solidNodes![0].position).toEqual({ z: 1 });
  });

  it("does not overwrite an existing position.z when migrating legacy z", () => {
    const input = validConfig();
    const nodes = input.nodes as Record<string, unknown>[];
    nodes[0]!.z = 4;
    nodes[0]!.position = { x: 1, z: 9 };
    const config = decodeNetworkConfig(input);
    expect(config.nodes[0].z).toBeUndefined();
    expect(config.nodes[0].position).toEqual({ x: 1, z: 9 });
  });

  it("accepts formula-bound physical coordinates", () => {
    const input = validConfig();
    const nodes = input.nodes as Record<string, unknown>[];
    const solids = input.solidNodes as Record<string, unknown>[];
    nodes[0]!.position = { x: { expr: "0" }, z: { expr: "reg('gain')" } };
    solids[0]!.position = { y: { expr: "node('a').position.x + 1" } };
    const config = decodeNetworkConfig(input);
    expect(config.nodes[0].position).toEqual({
      x: { expr: "0" },
      z: { expr: "reg('gain')" },
    });
    expect(config.solidNodes![0].position).toEqual({
      y: { expr: "node('a').position.x + 1" },
    });
  });

  it("rejects non-object top-level input", () => {
    for (const bad of [null, undefined, 42, "config", true, []]) {
      expectDecodeError(bad, "not-an-object", /^$/);
    }
  });

  it("rejects missing required fields with precise paths", () => {
    expectDecodeError({}, "missing-field", /^meta$/);
    expectDecodeError(
      { meta: { version: 2 } },
      "missing-field",
      /^meta\.name$/,
    );
    expectDecodeError(
      { meta: { name: "x" } },
      "missing-field",
      /^meta\.version$/,
    );
    const base = validConfig();
    for (const key of ["settings", "fluid", "nodes", "branches"] as const) {
      const broken = { ...base };
      delete (broken as Record<string, unknown>)[key];
      expectDecodeError(broken, "missing-field", new RegExp(`^${key}$`));
    }
  });

  it("rejects wrong-typed required fields", () => {
    const base = validConfig();
    expectDecodeError(
      { ...base, meta: { name: 7, version: 2 } },
      "invalid-type",
      /^meta\.name$/,
    );
    expectDecodeError({ ...base, settings: [] }, "invalid-type", /^settings$/);
    expectDecodeError({ ...base, fluid: "water" }, "invalid-type", /^fluid$/);
    expectDecodeError({ ...base, nodes: {} }, "invalid-type", /^nodes$/);
    expectDecodeError(
      { ...base, branches: "b1" },
      "invalid-type",
      /^branches$/,
    );
  });

  it("explicitly rejects unsupported versions", () => {
    const base = validConfig();
    expectDecodeError(
      { ...base, meta: { name: "x", version: 3 } },
      "unsupported-version",
      /^meta\.version$/,
    );
    expectDecodeError(
      { ...base, meta: { name: "x", version: 1 } },
      "unsupported-version",
      /^meta\.version$/,
    );
    expectDecodeError(
      { ...base, meta: { name: "x", version: 0 } },
      "unsupported-version",
      /^meta\.version$/,
    );
    // A string "2" is not the number 2 — still an explicit version rejection.
    expectDecodeError(
      { ...base, meta: { name: "x", version: "2" } },
      "unsupported-version",
      /^meta\.version$/,
    );
    try {
      decodeNetworkConfig({ ...base, meta: { name: "x", version: 3 } });
      expect.unreachable();
    } catch (err) {
      expect((err as ConfigDecodeError).message).toMatch(
        /unsupported config version 3/,
      );
      expect((err as ConfigDecodeError).message).toMatch(/supports version 2/);
    }
  });

  it("rejects malformed arrays and null elements", () => {
    const base = validConfig();
    expectDecodeError(
      { ...base, nodes: [null] },
      "invalid-type",
      /^nodes\[0\]$/,
    );
    expectDecodeError(
      { ...base, nodes: ["a"] },
      "invalid-type",
      /^nodes\[0\]$/,
    );
    expectDecodeError(
      { ...base, solidNodes: {} },
      "invalid-type",
      /^solidNodes$/,
    );
    expectDecodeError(
      { ...base, conductors: [null] },
      "invalid-type",
      /^conductors\[0\]$/,
    );
    expectDecodeError(
      { ...base, groups: [42] },
      "invalid-type",
      /^groups\[0\]$/,
    );
    expectDecodeError({ ...base, logic: {} }, "invalid-type", /^logic$/);
    expectDecodeError(
      { ...base, logic: [null] },
      "invalid-type",
      /^logic\[0\]$/,
    );
    expectDecodeError(
      { ...base, controllers: null },
      "invalid-type",
      /^controllers$/,
    );
    expectDecodeError({ ...base, species: "air" }, "invalid-type", /^species$/);
    expectDecodeError(
      { ...base, registers: null },
      "invalid-type",
      /^registers$/,
    );
    expectDecodeError(
      { ...base, closureParams: null },
      "invalid-type",
      /^closureParams$/,
    );
    expectDecodeError(
      { ...base, componentLibrary: { x: null } },
      "invalid-type",
      /^componentLibrary\.x$/,
    );
  });

  it("rejects nested shapes validate would crash on", () => {
    const base = validConfig();
    // branch.component is read unconditionally by validate.
    expectDecodeError(
      { ...base, branches: [{ id: "b", from: "a", to: "b" }] },
      "missing-field",
      /^branches\[0\]\.component$/,
    );
    expectDecodeError(
      { ...base, branches: [{ id: "b", from: "a", to: "b", component: null }] },
      "invalid-type",
      /^branches\[0\]\.component$/,
    );
    // conductor.type is read unconditionally by validate.
    expectDecodeError(
      { ...base, conductors: [{ id: "c", from: "a", to: "wall" }] },
      "missing-field",
      /^conductors\[0\]\.type$/,
    );
    // Schedule pairs are indexed ([i][0]); null entries would crash.
    expectDecodeError(
      {
        ...base,
        nodes: [
          {
            id: "a",
            type: "boundary",
            x: 0,
            y: 0,
            pressureSchedule: [null, null],
          },
        ],
      },
      "invalid-type",
      /^nodes\[0\]\.pressureSchedule\[0\]$/,
    );
    // Pump curve rows are indexed.
    expectDecodeError(
      {
        ...base,
        branches: [
          {
            id: "b",
            from: "a",
            to: "b",
            component: { type: "pump", curve: [[0, 1], 5] },
          },
        ],
      },
      "invalid-type",
      /^branches\[0\]\.component\.curve\[1\]$/,
    );
    // dpTable rows are destructured.
    expectDecodeError(
      {
        ...base,
        branches: [
          {
            id: "b",
            from: "a",
            to: "b",
            component: { type: "dpTable", points: [null, null] },
          },
        ],
      },
      "invalid-type",
      /^branches\[0\]\.component\.points\[0\]$/,
    );
    // Solid-property tables are destructured row-wise.
    expectDecodeError(
      {
        ...base,
        solidNodes: [
          {
            id: "w",
            type: "solid",
            x: 0,
            y: 0,
            temperature: 300,
            cp: { table: [null, null] },
          },
        ],
      },
      "invalid-type",
      /^solidNodes\[0\]\.cp\.table\[0\]$/,
    );
    // userComponent params are Object.entries'd without a null guard.
    expectDecodeError(
      {
        ...base,
        branches: [
          {
            id: "b",
            from: "a",
            to: "b",
            component: {
              type: "userComponent",
              component: "softCheck",
              params: null,
            },
          },
        ],
      },
      "invalid-type",
      /^branches\[0\]\.component\.params$/,
    );
    // Controller limits are dereferenced without a null guard.
    expectDecodeError(
      {
        ...base,
        controllers: [
          {
            id: "c1",
            type: "pid",
            sense: { kind: "node", id: "a", quantity: "pressure" },
            setpoint: 1,
            gains: { kp: 1, ki: 0, kd: 0 },
            output: { kind: "boundaryPressure", id: "a" },
            limits: null,
          },
        ],
      },
      "invalid-type",
      /^controllers\[0\]\.limits$/,
    );
    // species.reactions elements are dereferenced.
    expectDecodeError(
      {
        ...base,
        species: { names: ["a"], molecularWeights: [0.001], reactions: [null] },
      },
      "invalid-type",
      /^species\.reactions\[0\]$/,
    );
  });

  it("never lets validateNetwork crash on decoded input", () => {
    // Anything the decoder accepts must be safe for validateNetwork to walk.
    const accepted: unknown[] = [
      validConfig(),
      { ...validConfig(), nodes: [], branches: [] },
      {
        ...validConfig(),
        conductors: [
          {
            id: "c",
            from: "ghost",
            to: "wall",
            type: { kind: "conduction", k: 1, area: 1, length: 1 },
          },
        ],
      },
    ];
    for (const input of accepted) {
      const config = decodeNetworkConfig(input);
      let errors: string[] | null = null;
      expect(() => {
        errors = validateNetwork(config);
      }).not.toThrow();
      expect(Array.isArray(errors)).toBe(true);
    }
    expect(() =>
      decodeNetworkConfig({ ...validConfig(), nodes: [{}], branches: [] }),
    ).toThrow(/nodes\[0\]\.type/);
    expect(() =>
      decodeNetworkConfig({
        ...validConfig(),
        branches: [{ component: { type: "mystery" } }],
      }),
    ).toThrow(/component\.type/);
  });

  it("rejects malformed nested species fields before validation", () => {
    const badNames = validConfig() as any;
    badNames.species = { names: 7, molecularWeights: [0.028] };
    expect(() => decodeNetworkConfig(badNames)).toThrow(/species.names/);

    const badReaction = validConfig() as any;
    badReaction.species = {
      names: ["A"],
      molecularWeights: [0.028],
      reactions: [{ reactants: null, products: { A: 1 }, A: 1, b: 0, Ea: 0 }],
    };
    expect(() => decodeNetworkConfig(badReaction)).toThrow(
      /species.reactions\[0\].reactants/,
    );
  });

  it("accepts an optional fluids map and node.fluid names", () => {
    const input = validConfig();
    input.fluids = {
      oil: {
        model: "incompressible",
        params: { rho: 850, mu: 0.03, cp: 2000 },
      },
    };
    const nodes = input.nodes as Record<string, unknown>[];
    nodes[0]!.fluid = "oil";
    nodes[1]!.fluid = "oil";
    const config = decodeNetworkConfig(input);
    expect(config.fluids?.oil).toEqual({
      model: "incompressible",
      params: { rho: 850, mu: 0.03, cp: 2000 },
    });
    expect(config.nodes[0].fluid).toBe("oil");
  });

  it("rejects a non-object fluids map, non-object named spec, and non-string node.fluid", () => {
    expectDecodeError(
      { ...validConfig(), fluids: "oil" },
      "invalid-type",
      /^fluids$/,
    );
    expectDecodeError(
      { ...validConfig(), fluids: { oil: "water" } },
      "invalid-type",
      /^fluids\.oil$/,
    );
    const badNode = validConfig();
    (badNode.nodes as Record<string, unknown>[])[0]!.fluid = 3;
    expectDecodeError(badNode, "invalid-type", /^nodes\[0\]\.fluid$/);
  });
});

describe("decodeAndValidateNetwork", () => {
  it("returns config + empty errors for a runnable config", () => {
    const { config, errors } = decodeAndValidateNetwork(validConfig());
    expect(config.meta.name).toBe("decode-me");
    expect(errors).toEqual([]);
  });

  it("returns semantic validation errors for well-formed but invalid configs", () => {
    const broken = validConfig();
    (broken.nodes as Array<Record<string, unknown>>)[0] = {
      id: "a",
      type: "boundary",
      x: 0,
      y: 0,
    };
    const { errors } = decodeAndValidateNetwork(broken);
    expect(errors.some((e) => /missing pressure/.test(e))).toBe(true);
  });

  it("throws ConfigDecodeError for malformed input instead of returning errors", () => {
    expect(() =>
      decodeAndValidateNetwork({ meta: { name: "x", version: 2 } }),
    ).toThrow(ConfigDecodeError);
    expect(() => decodeAndValidateNetwork(null)).toThrow(ConfigDecodeError);
  });
});

describe("validateNetwork component-library and component-type guards", () => {
  function configWithUserComponent(
    component: unknown,
    library: unknown,
  ): Record<string, unknown> {
    return {
      ...validConfig(),
      branches: [
        {
          id: "u1",
          from: "a",
          to: "b",
          component: { type: "userComponent", component },
        },
      ],
      componentLibrary: library,
    };
  }

  it('rejects prototype keys ("toString", "constructor") as library entries', () => {
    // `'toString' in {}` is true via Object.prototype — the lookup must use
    // an own-property check so these surface as unknown entries.
    for (const key of ["toString", "constructor", "hasOwnProperty"]) {
      const errors = validateNetwork(
        decodeNetworkConfig(configWithUserComponent(key, {})),
      );
      expect(
        errors.some((e) =>
          e.includes(`unknown componentLibrary entry: ${key}`),
        ),
      ).toBe(true);
    }
  });

  it('accepts a library entry that genuinely owns the key "toString"', () => {
    // JSON.parse creates an own property named "toString".
    const library = JSON.parse('{"toString":{"code":"defineComponent({})"}}');
    const errors = validateNetwork(
      decodeNetworkConfig(configWithUserComponent("toString", library)),
    );
    expect(errors.some((e) => /unknown componentLibrary entry/.test(e))).toBe(
      false,
    );
  });

  it("rejects an unknown component type at the decode boundary", () => {
    const input = {
      ...validConfig(),
      branches: [
        {
          id: "x1",
          from: "a",
          to: "b",
          component: { type: "fluxCapacitor", area: -1 },
        },
      ],
    };
    expect(() => decodeNetworkConfig(input)).toThrow(
      /unknown branch component type/,
    );
  });

  it("reports an unknown conductor kind", () => {
    const cfg = validConfig() as any;
    cfg.solidNodes = [
      { id: "s1", type: "solid", x: 0, y: 0, temperature: 300 },
      { id: "s2", type: "solid", x: 1, y: 0, temperature: 300 },
    ];
    cfg.conductors = [
      { id: "c1", from: "s1", to: "s2", type: { kind: "banana" } },
    ];
    expect(validateNetwork(cfg)).toContain(
      'Conductor c1 has unknown kind: "banana"',
    );
  });

  it("rejects a missing component type at the decode boundary", () => {
    const input = {
      ...validConfig(),
      branches: [{ id: "x2", from: "a", to: "b", component: {} }],
    };
    expect(() => decodeNetworkConfig(input)).toThrow(/component\.type/);
  });
});
