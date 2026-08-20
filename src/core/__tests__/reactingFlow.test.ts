import { describe, it, expect } from "vitest";
import { NetworkConfig } from "../schema";
import { solveTransient } from "../transient";

describe("Reacting flow (transient only)", () => {
  it("well-mixed reactor A→B at fixed T: Y_A(t) = Y_A0·exp(-k·t) within 1%", () => {
    const T = 300;
    const P = 2e5;
    const V = 0.001;
    const k = 10; // s⁻¹ (Arrhenius A=10, b=0, Ea=0)
    const endTime = 0.5;
    const dt = 0.002; // dt·k = 0.02 → IE error < 2%

    const config: NetworkConfig = {
      meta: { name: "test", version: 2 },
      settings: {
        mode: "transient",
        dt,
        endTime,
        tolerance: 1e-6,
        maxIterations: 200,
        relaxation: 0.9,
      },
      fluid: { model: "idealGas", preset: "air" },
      species: {
        names: ["A", "B"],
        molecularWeights: [0.028, 0.028],
        cp: [1000, 1000],
        reactions: [
          {
            reactants: { A: 1 },
            products: { B: 1 },
            A: k,
            b: 0,
            Ea: 0,
          },
        ],
      },
      nodes: [
        {
          id: "in",
          type: "boundary",
          x: 0,
          y: 0,
          pressure: P,
          temperature: T,
          massFractions: { A: 1, B: 0 },
        },
        {
          id: "tank",
          type: "internal",
          x: 1,
          y: 0,
          pressure: P,
          temperature: T,
          volume: V,
          massFractions: { A: 1, B: 0 },
        },
        {
          id: "out",
          type: "boundary",
          x: 2,
          y: 0,
          pressure: P,
          temperature: T,
          massFractions: { A: 1, B: 0 },
        },
      ],
      branches: [
        {
          id: "s1",
          from: "in",
          to: "tank",
          component: { type: "flowSource", massFlow: 0 },
        },
        {
          id: "s2",
          from: "tank",
          to: "out",
          component: { type: "flowSource", massFlow: 0 },
        },
      ],
    };

    const res = solveTransient(config);
    const idx = Math.round(endTime / dt);
    const Y_A = res.nodes.tank.massFractions!.A[idx];
    const expected = Math.exp(-k * endTime);
    expect(Math.abs(Y_A - expected) / expected).toBeLessThan(0.01);
  });

  it("heat-release variant: ΔT at completion matches Y_A0·Δh_rxn/cp within 2%", () => {
    const T0 = 300;
    const P = 2e5;
    const V = 0.001;
    const k = 10;
    const dt = 0.002;
    const endTime = 0.5;
    const dh = 1e5; // J/kg
    const cp = 1000; // J/kg/K

    const config: NetworkConfig = {
      meta: { name: "test", version: 2 },
      settings: {
        mode: "transient",
        dt,
        endTime,
        tolerance: 1e-6,
        maxIterations: 200,
        relaxation: 0.9,
      },
      fluid: { model: "idealGas", preset: "air" },
      species: {
        names: ["A", "B"],
        molecularWeights: [0.028, 0.028],
        cp: [cp, cp],
        reactions: [
          {
            reactants: { A: 1 },
            products: { B: 1 },
            A: k,
            b: 0,
            Ea: 0,
            heatOfReaction: dh,
          },
        ],
      },
      nodes: [
        {
          id: "in",
          type: "boundary",
          x: 0,
          y: 0,
          pressure: P,
          temperature: T0,
          massFractions: { A: 1, B: 0 },
        },
        {
          id: "tank",
          type: "internal",
          x: 1,
          y: 0,
          pressure: P,
          temperature: T0,
          volume: V,
          massFractions: { A: 1, B: 0 },
        },
        {
          id: "out",
          type: "boundary",
          x: 2,
          y: 0,
          pressure: P,
          temperature: T0,
          massFractions: { A: 1, B: 0 },
        },
      ],
      branches: [
        {
          id: "s1",
          from: "in",
          to: "tank",
          component: { type: "flowSource", massFlow: 0 },
        },
        {
          id: "s2",
          from: "tank",
          to: "out",
          component: { type: "flowSource", massFlow: 0 },
        },
      ],
    };

    const res = solveTransient(config);
    const idx = Math.round(endTime / dt);
    const T_final = res.nodes.tank.temperature[idx];
    const expectedDT = (1.0 * dh) / cp; // Y_A0 = 1.0
    expect(Math.abs(T_final - (T0 + expectedDT)) / expectedDT).toBeLessThan(
      0.02,
    );
  });
});
