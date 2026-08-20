import { describe, expect, it } from "vitest";
import type { NetworkConfig, SteadyResult, TransientResult } from "../types";
import {
  channelsForSelection,
  hasInspectableResult,
} from "../selectionInspect";

const config: NetworkConfig = {
  meta: { name: "inspect-fixture", version: 2 },
  settings: { mode: "steady", tolerance: 1e-8, maxIterations: 60 },
  fluid: { model: "incompressible", params: { rho: 1000 } },
  nodes: [
    {
      id: "n1",
      label: "Tank",
      type: "boundary",
      x: 0,
      y: 0,
      pressure: 101325,
      temperature: 300,
    },
  ],
  branches: [],
};

const steady: SteadyResult = {
  converged: true,
  iterations: 4,
  residual: 1e-9,
  nodes: {
    n1: {
      pressure: 101325,
      temperature: 300,
      density: 1000,
      enthalpy: 125000,
      viscosity: 0.001,
    },
  },
  branches: {},
};

describe("steady-state property inspection", () => {
  it("allows converged steady results", () => {
    expect(hasInspectableResult(steady)).toBe(true);
    expect(hasInspectableResult({ ...steady, converged: false })).toBe(false);
  });

  it("lists every available property for the selected element", () => {
    expect(
      channelsForSelection(config, steady, { kind: "node", id: "n1" }).map(
        (descriptor) => descriptor.channel.field,
      ),
    ).toEqual(["pressure", "temperature", "density", "enthalpy", "viscosity"]);
  });

  it("keeps transient inspection limited to plottable runs", () => {
    const transient = {
      converged: true,
      times: [0],
      nodes: {
        n1: {
          pressure: [101325],
          temperature: [300],
          density: [1000],
        },
      },
      branches: {},
    } satisfies TransientResult;

    expect(hasInspectableResult(transient)).toBe(false);
    expect(hasInspectableResult({ ...transient, times: [0, 1] })).toBe(true);
  });
});
