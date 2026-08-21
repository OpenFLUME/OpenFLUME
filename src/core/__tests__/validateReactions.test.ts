import { describe, it, expect } from "vitest";
import { NetworkConfig } from "../schema";
import { validateNetwork } from "../validate";

function makeConfig(overrides: Partial<NetworkConfig> = {}): NetworkConfig {
  return {
    meta: { name: "test", version: 2 },
    settings: {
      mode: "steady",
      tolerance: 1e-9,
      maxIterations: 500,
      relaxation: 0.9,
    },
    fluid: { model: "idealGas", preset: "air" },
    nodes: [],
    branches: [],
    ...overrides,
  } as NetworkConfig;
}

describe("Reactions validation", () => {
  it("passes for a valid reacting config", () => {
    const config = makeConfig({
      species: {
        names: ["A", "B"],
        molecularWeights: [0.028, 0.056],
        cp: [1000, 800],
        reactions: [
          {
            reactants: { A: 1 },
            products: { B: 1 },
            A: 1e3,
            b: 0,
            Ea: 50000,
          },
        ],
      },
      nodes: [
        {
          id: "in",
          type: "boundary",
          x: 0,
          y: 0,
          pressure: 2e5,
          temperature: 300,
          massFractions: { A: 1.0, B: 0.0 },
        },
        {
          id: "mix",
          type: "internal",
          x: 1,
          y: 0,
          pressure: 1.9e5,
          temperature: 300,
          volume: 0.001,
          massFractions: { A: 0.5, B: 0.5 },
        },
      ],
      branches: [
        {
          id: "b1",
          from: "in",
          to: "mix",
          component: { type: "orifice", area: 0.001, cd: 0.6 },
        },
      ],
    });
    expect(validateNetwork(config)).toHaveLength(0);
  });

  const minimalNodes = [
    {
      id: "in",
      type: "boundary" as const,
      x: 0,
      y: 0,
      pressure: 2e5,
      temperature: 300,
    },
    {
      id: "out",
      type: "boundary" as const,
      x: 1,
      y: 0,
      pressure: 1e5,
      temperature: 300,
    },
  ];
  const minimalBranches = [
    {
      id: "b1",
      from: "in",
      to: "out",
      component: { type: "orifice" as const, area: 0.001, cd: 0.6 },
    },
  ];

  it("errors on unknown species in reactants", () => {
    const config = makeConfig({
      species: {
        names: ["A", "B"],
        molecularWeights: [0.028, 0.056],
        reactions: [
          {
            reactants: { C: 1 },
            products: { B: 1 },
            A: 1e3,
            b: 0,
            Ea: 50000,
          },
        ],
      },
      nodes: minimalNodes,
      branches: minimalBranches,
    });
    const errors = validateNetwork(config);
    expect(errors).toContain('Reaction 0 references unknown species "C"');
  });

  it("errors on unknown species in products", () => {
    const config = makeConfig({
      species: {
        names: ["A", "B"],
        molecularWeights: [0.028, 0.056],
        reactions: [
          {
            reactants: { A: 1 },
            products: { D: 1 },
            A: 1e3,
            b: 0,
            Ea: 50000,
          },
        ],
      },
      nodes: minimalNodes,
      branches: minimalBranches,
    });
    const errors = validateNetwork(config);
    expect(errors).toContain('Reaction 0 references unknown species "D"');
  });

  it("errors on negative stoichiometry in reactants", () => {
    const config = makeConfig({
      species: {
        names: ["A", "B"],
        molecularWeights: [0.028, 0.056],
        reactions: [
          {
            reactants: { A: -1 },
            products: { B: 1 },
            A: 1e3,
            b: 0,
            Ea: 50000,
          },
        ],
      },
      nodes: minimalNodes,
      branches: minimalBranches,
    });
    const errors = validateNetwork(config);
    expect(errors).toContain(
      'Reaction 0: reactant "A" stoichiometry must be positive (got -1)',
    );
  });

  it("errors on zero stoichiometry in products", () => {
    const config = makeConfig({
      species: {
        names: ["A", "B"],
        molecularWeights: [0.028, 0.056],
        reactions: [
          {
            reactants: { A: 1 },
            products: { B: 0 },
            A: 1e3,
            b: 0,
            Ea: 50000,
          },
        ],
      },
      nodes: minimalNodes,
      branches: minimalBranches,
    });
    const errors = validateNetwork(config);
    expect(errors).toContain(
      'Reaction 0: product "B" stoichiometry must be positive (got 0)',
    );
  });

  it("errors on negative pre-exponential factor A", () => {
    const config = makeConfig({
      species: {
        names: ["A", "B"],
        molecularWeights: [0.028, 0.056],
        reactions: [
          {
            reactants: { A: 1 },
            products: { B: 1 },
            A: -1,
            b: 0,
            Ea: 50000,
          },
        ],
      },
      nodes: minimalNodes,
      branches: minimalBranches,
    });
    const errors = validateNetwork(config);
    expect(errors).toContain("Reaction 0: A must be non-negative");
  });
});
