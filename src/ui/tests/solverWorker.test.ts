/**
 * Unit tests for the solver worker's pure run-preparation helper.  The
 * worker module guards its `self.onmessage` installation, so importing it
 * from a main-thread (node) test context is safe.
 */
import { describe, it, expect } from "vitest";
import { prepareWorkerRun } from "../solverWorker";

const validConfig = {
  meta: { name: "worker", version: 2 },
  settings: { mode: "steady", tolerance: 1e-6, maxIterations: 50 },
  fluid: { model: "incompressible", preset: "water" },
  nodes: [
    { id: "a", type: "boundary", x: 0, y: 0, pressure: 2e5, temperature: 300 },
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
      id: "o1",
      from: "a",
      to: "b",
      component: { type: "orifice", area: 1e-3, cd: 0.6 },
    },
  ],
};

describe("prepareWorkerRun", () => {
  it("accepts a valid run message and derives mode from the config", () => {
    const prepared = prepareWorkerRun({
      type: "run",
      config: validConfig,
      mode: "steady",
    });
    expect(prepared.ok).toBe(true);
    if (prepared.ok) {
      expect(prepared.run.mode).toBe("steady");
      expect(prepared.run.config.meta.name).toBe("worker");
    }
  });

  it("rejects an unknown message mode", () => {
    const prepared = prepareWorkerRun({
      type: "run",
      config: validConfig,
      mode: "sideways",
    });
    expect(prepared.ok).toBe(false);
  });

  it("rejects a message mode that disagrees with config.settings.mode", () => {
    expect(
      prepareWorkerRun({ type: "run", config: validConfig, mode: "transient" }),
    ).toEqual({
      ok: false,
      message:
        'Run mode "transient" does not match config.settings.mode "steady"',
    });
  });

  it("rejects malformed messages", () => {
    for (const bad of [null, undefined, 42, "run"]) {
      const prepared = prepareWorkerRun(bad);
      expect(prepared.ok).toBe(false);
      if (!prepared.ok)
        expect(prepared.message).toMatch(/Malformed run message/);
    }
  });

  it("rejects structurally invalid configs with a decode message", () => {
    const prepared = prepareWorkerRun({
      type: "run",
      config: { meta: { name: "x", version: 2 } },
      mode: "steady",
    });
    expect(prepared.ok).toBe(false);
    if (!prepared.ok) {
      expect(prepared.message).toMatch(/Invalid network config/);
      expect(prepared.message).toMatch(/settings/);
    }
  });

  it("rejects unsupported config versions explicitly", () => {
    const prepared = prepareWorkerRun({
      type: "run",
      config: { ...validConfig, meta: { name: "worker", version: 3 } },
      mode: "steady",
    });
    expect(prepared.ok).toBe(false);
    if (!prepared.ok)
      expect(prepared.message).toMatch(/unsupported config version 3/);
  });

  it("rejects semantically invalid configs with the validation errors", () => {
    const noPressure = {
      ...validConfig,
      nodes: [
        { id: "a", type: "boundary", x: 0, y: 0, temperature: 300 },
        {
          id: "b",
          type: "boundary",
          x: 100,
          y: 0,
          pressure: 1e5,
          temperature: 300,
        },
      ],
    };
    const prepared = prepareWorkerRun({
      type: "run",
      config: noPressure,
      mode: "steady",
    });
    expect(prepared.ok).toBe(false);
    if (!prepared.ok) {
      expect(prepared.message).toMatch(/missing pressure/);
      expect(prepared.message).not.toMatch(/Invalid network config/);
    }
  });
});
