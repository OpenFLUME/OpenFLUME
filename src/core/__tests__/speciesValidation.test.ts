import { describe, it, expect } from "vitest";
import { NetworkConfig } from "../schema";
import { validateNetwork } from "../validate";

function makeConfig(overrides: Partial<NetworkConfig> = {}): NetworkConfig {
  return {
    meta: { name: "test", version: 2 },
    settings: {
      mode: "steady",
      tolerance: 1e-6,
      maxIterations: 200,
      relaxation: 0.9,
    },
    fluid: { model: "idealGas", preset: "air" },
    nodes: [
      {
        id: "A",
        type: "boundary",
        x: 0,
        y: 0,
        pressure: 1e5,
        temperature: 300,
      },
      {
        id: "B",
        type: "boundary",
        x: 1,
        y: 0,
        pressure: 1e5,
        temperature: 300,
      },
    ],
    branches: [
      {
        id: "b1",
        from: "A",
        to: "B",
        component: { type: "orifice", area: 0.001, cd: 0.6 },
      },
    ],
    ...overrides,
  } as NetworkConfig;
}

describe("Species validation", () => {
  it("passes with valid species config and mass fractions", () => {
    const config = makeConfig({
      species: {
        names: ["N2", "O2"],
        molecularWeights: [0.028, 0.032],
        cp: [1040, 920],
      },
      nodes: [
        {
          id: "A",
          type: "boundary",
          x: 0,
          y: 0,
          pressure: 1e5,
          temperature: 300,
          massFractions: { N2: 0.767, O2: 0.233 },
        },
        {
          id: "B",
          type: "boundary",
          x: 1,
          y: 0,
          pressure: 1e5,
          temperature: 300,
          massFractions: { N2: 0.767, O2: 0.233 },
        },
      ],
    });
    const errors = validateNetwork(config);
    expect(errors).toHaveLength(0);
  });

  it("rejects species with realFluid", () => {
    const config = makeConfig({
      fluid: { model: "realFluid", params: { fluidName: "Water" } },
      species: {
        names: ["N2"],
        molecularWeights: [0.028],
      },
    });
    const errors = validateNetwork(config);
    expect(
      errors.some((e) =>
        e.includes("Species transport is only supported for idealGas"),
      ),
    ).toBe(true);
  });

  it("rejects species with incompressible", () => {
    const config = makeConfig({
      fluid: { model: "incompressible", preset: "water" },
      species: {
        names: ["N2"],
        molecularWeights: [0.028],
      },
    });
    const errors = validateNetwork(config);
    expect(
      errors.some((e) =>
        e.includes("Species transport is only supported for idealGas"),
      ),
    ).toBe(true);
  });

  it("rejects mismatched array lengths", () => {
    const config = makeConfig({
      species: {
        names: ["N2", "O2"],
        molecularWeights: [0.028],
      },
    });
    const errors = validateNetwork(config);
    expect(errors.some((e) => e.includes("same length"))).toBe(true);
  });

  it("rejects unknown species in node massFractions", () => {
    const config = makeConfig({
      species: {
        names: ["N2"],
        molecularWeights: [0.028],
      },
      nodes: [
        {
          id: "A",
          type: "boundary",
          x: 0,
          y: 0,
          pressure: 1e5,
          temperature: 300,
          massFractions: { N2: 0.5, O2: 0.5 },
        },
        {
          id: "B",
          type: "boundary",
          x: 1,
          y: 0,
          pressure: 1e5,
          temperature: 300,
          massFractions: { N2: 1.0 },
        },
      ],
    });
    const errors = validateNetwork(config);
    expect(errors.some((e) => e.includes("unknown species"))).toBe(true);
  });

  it("rejects mass fractions that do not sum to 1", () => {
    const config = makeConfig({
      species: {
        names: ["N2", "O2"],
        molecularWeights: [0.028, 0.032],
      },
      nodes: [
        {
          id: "A",
          type: "boundary",
          x: 0,
          y: 0,
          pressure: 1e5,
          temperature: 300,
          massFractions: { N2: 0.5, O2: 0.4 },
        },
        {
          id: "B",
          type: "boundary",
          x: 1,
          y: 0,
          pressure: 1e5,
          temperature: 300,
          massFractions: { N2: 0.5, O2: 0.5 },
        },
      ],
    });
    const errors = validateNetwork(config);
    expect(errors.some((e) => e.includes("sum to 1"))).toBe(true);
  });

  it("rejects negative mass fraction", () => {
    const config = makeConfig({
      species: {
        names: ["N2", "O2"],
        molecularWeights: [0.028, 0.032],
      },
      nodes: [
        {
          id: "A",
          type: "boundary",
          x: 0,
          y: 0,
          pressure: 1e5,
          temperature: 300,
          massFractions: { N2: -0.1, O2: 1.1 },
        },
        {
          id: "B",
          type: "boundary",
          x: 1,
          y: 0,
          pressure: 1e5,
          temperature: 300,
          massFractions: { N2: 0.5, O2: 0.5 },
        },
      ],
    });
    const errors = validateNetwork(config);
    expect(errors.some((e) => e.includes("must be in [0,1]"))).toBe(true);
  });

  it("rejects non-positive molecular weight", () => {
    const config = makeConfig({
      species: {
        names: ["N2"],
        molecularWeights: [0],
      },
    });
    const errors = validateNetwork(config);
    expect(
      errors.some((e) => e.includes("molecularWeights must be positive")),
    ).toBe(true);
  });
});
