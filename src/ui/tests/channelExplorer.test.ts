/**
 * channelExplorer.ts — unit-aware scalar formatting and channel search.
 *
 * The pinning / primary-channel / chart-composition policy this module used to
 * hold went away with the plot model (see resultPlots.test.ts): a plot owns its
 * channel list outright, so there is nothing to cap or derive.
 */
import { describe, it, expect } from "vitest";
import {
  formatChannelDelta,
  formatChannelValue,
  matchesQuery,
} from "../channelExplorer";
import { listChannels } from "../channels";
import type { NetworkConfig, TransientResult } from "../types";

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

function makeConfig(): NetworkConfig {
  return {
    meta: { name: "explorer-fixture", version: 2 },
    settings: {
      mode: "transient",
      tolerance: 1e-8,
      maxIterations: 60,
      dt: 0.5,
      endTime: 1,
    },
    fluid: { model: "incompressible", params: { rho: 1000 } },
    nodes: [
      {
        id: "n1",
        label: "Feed Tank",
        type: "boundary",
        x: 0,
        y: 0,
        group: "g1",
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
      {
        id: "s1",
        label: "Wall",
        type: "solid",
        x: 150,
        y: 80,
        temperature: 300,
      },
    ],
    conductors: [
      {
        id: "c1",
        from: "n2",
        to: "s1",
        type: { kind: "conduction", k: 400, area: 0.5, length: 0.005 },
      },
    ],
    groups: [{ id: "g1", label: "Feed", x: 0, y: 0 }],
  };
}

function makeTransient(): TransientResult {
  return {
    converged: true,
    times: [0, 0.5, 1],
    nodes: {
      n1: {
        pressure: [101325, 101300, 101250],
        temperature: [300, 301, 302],
        density: [1000, 999, 998],
      },
      n2: {
        pressure: [100000, 100100, 100200],
        temperature: [299, 299.5, 300],
        density: [1001, 1002, 1003],
      },
    },
    branches: { b1: { mdot: [0.1, 0.2, 0.3] } },
    solidNodes: { s1: { temperature: [300, 305, 310] } },
    conductors: { c1: { heatRate: [10, 20, 30] } },
  };
}

describe("formatChannelValue / formatChannelDelta", () => {
  const pressure = { quantity: "pressure" as const };
  const enthalpy = { quantity: "dimensionless" as const, rawUnit: "J/kg" };

  it("formats in preferred units, rawUnit channels never converted", () => {
    expect(formatChannelValue(200000, pressure, { pressure: "kPa" }, 4)).toBe(
      "200 kPa",
    );
    expect(formatChannelValue(100000, enthalpy, undefined, 4)).toBe(
      "100,000 J/kg",
    );
  });

  it("formats deltas with sign and clamps FP noise to +0", () => {
    expect(
      formatChannelDelta(201000, 200000, pressure, { pressure: "kPa" }, 4),
    ).toBe("+1 kPa");
    expect(
      formatChannelDelta(200000, 201000, pressure, { pressure: "kPa" }, 4),
    ).toBe("-1 kPa");
    // Sub-display-resolution difference between nominally identical runs.
    expect(
      formatChannelDelta(
        300,
        300.00000000000006,
        { quantity: "temperature" },
        { temperature: "K" },
        4,
      ),
    ).toBe("+0 K");
  });
});

/* ------------------------------------------------------------------ */
/* Search + context summary                                            */
/* ------------------------------------------------------------------ */

describe("matchesQuery", () => {
  const channels = listChannels(makeConfig(), makeTransient());
  const pipe = channels.find((c) => c.channel.id === "b1")!;
  it("matches label, element id, field and entity kind, case-insensitive", () => {
    expect(matchesQuery(pipe, "main pipe")).toBe(true);
    expect(matchesQuery(pipe, "B1")).toBe(true);
    expect(matchesQuery(pipe, "mdot")).toBe(true); // raw field name
    expect(matchesQuery(pipe, "mass flow")).toBe(true); // field label
    expect(matchesQuery(pipe, "branch")).toBe(true);
    expect(matchesQuery(pipe, "")).toBe(true);
    expect(matchesQuery(pipe, "zzz")).toBe(false);
  });
});
