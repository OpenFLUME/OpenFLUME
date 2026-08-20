import { describe, it, expect } from "vitest";
import type { NetworkConfig } from "../schema";
import { derivedAxialPosition, withDerivedGeometry } from "../geometry";
import { validateNetwork } from "../validate";

function lineConfig(args?: { tee?: boolean; axial?: number }): NetworkConfig {
  const nodes: NetworkConfig["nodes"] = [
    {
      id: "in",
      type: "boundary",
      x: 0,
      y: 0,
      position: { x: 0, z: 1 },
      pressure: 2e5,
      temperature: 300,
    },
    {
      id: "mid",
      type: "internal",
      x: 50,
      y: 0,
      position: { x: 1, z: 1 },
      pressure: 1.5e5,
      temperature: 300,
      volume: 1e-3,
    },
    {
      id: "out",
      type: "boundary",
      x: 100,
      y: 0,
      position: { x: 2, z: 4 },
      pressure: 1e5,
      temperature: 300,
    },
  ];
  const branches: NetworkConfig["branches"] = [
    {
      id: "p1",
      from: "in",
      to: "mid",
      component: { type: "pipe", length: 1, diameter: 0.02, roughness: 1e-5 },
    },
    {
      id: "p2",
      from: "mid",
      to: "out",
      component: { type: "pipe", length: 1, diameter: 0.02, roughness: 1e-5 },
    },
  ];
  if (args?.tee) {
    nodes.push({
      id: "side",
      type: "boundary",
      x: 50,
      y: 80,
      position: { x: 1, y: 1 },
      pressure: 1e5,
      temperature: 300,
    });
    branches.push({
      id: "p3",
      from: "mid",
      to: "side",
      component: { type: "pipe", length: 1, diameter: 0.02, roughness: 1e-5 },
    });
  }
  return {
    meta: { name: "geom", version: 2 },
    settings: {
      mode: "transient",
      dt: 0.1,
      endTime: 1,
      tolerance: 1e-6,
      maxIterations: 50,
    },
    fluid: { model: "realFluid", params: { fluidName: "Nitrogen" } },
    nodes,
    solidNodes: [
      {
        id: "wall",
        type: "solid",
        x: 50,
        y: 40,
        position: { x: 1 },
        temperature: 300,
        mass: 2,
        cp: 385,
      },
    ],
    conductors: [
      {
        id: "conv",
        from: "mid",
        to: "wall",
        type: {
          kind: "convection",
          area: 0.05,
          correlation: {
            model: "darrHartwig",
            diameter: 0.02,
            ...(args?.axial !== undefined ? { axialPosition: args.axial } : {}),
          },
        },
      },
    ],
    branches,
  };
}

describe("withDerivedGeometry", () => {
  it("fills pipe elevationChange from position.z when unset", () => {
    const next = withDerivedGeometry(lineConfig());
    const p2 = next.branches.find((b) => b.id === "p2")!.component;
    expect(p2.type === "pipe" && p2.elevationChange).toBe(3);
    const p1 = next.branches.find((b) => b.id === "p1")!.component;
    expect(p1.type === "pipe" && p1.elevationChange).toBe(0);
  });

  it("fills convection axialPosition from the unique pipe path", () => {
    const cfg = lineConfig();
    expect(derivedAxialPosition(cfg, "conv")).toBe(1);
    const next = withDerivedGeometry(cfg);
    const t = next.conductors![0].type;
    expect(t.kind === "convection" && t.correlation?.axialPosition).toBe(1);
    // validateNetwork resolves geometry first, so a sweep that only writes
    // correlation.model can still run Darr–Hartwig on a positioned line.
    expect(validateNetwork(cfg).filter((e) => /axialPosition/.test(e))).toEqual(
      [],
    );
  });

  it("fills ttWf segmentLength from the unique incident pipe hop", () => {
    const cfg = lineConfig();
    const t = cfg.conductors![0].type;
    if (t.kind !== "convection" || !t.correlation) throw new Error("fixture");
    t.correlation.model = "ttWf";
    const next = withDerivedGeometry(cfg);
    const nt = next.conductors![0].type;
    expect(nt.kind === "convection" && nt.correlation?.segmentLength).toBe(1);
  });

  it("does not invent axialPosition on a tee", () => {
    const cfg = lineConfig({ tee: true });
    expect(derivedAxialPosition(cfg, "conv")).toBeUndefined();
    expect(withDerivedGeometry(cfg).conductors![0]).toEqual(cfg.conductors![0]);
    expect(validateNetwork(cfg).some((e) => /axialPosition/.test(e))).toBe(
      true,
    );
  });

  it("keeps an explicit axialPosition", () => {
    const cfg = lineConfig({ axial: 0.25 });
    const next = withDerivedGeometry(cfg);
    const t = next.conductors![0].type;
    expect(t.kind === "convection" && t.correlation?.axialPosition).toBe(0.25);
  });

  it("returns the same reference when nothing is derived", () => {
    const cfg = lineConfig({ axial: 1 });
    cfg.branches[0].component = {
      type: "pipe",
      length: 1,
      diameter: 0.02,
      roughness: 1e-5,
      elevationChange: 0,
    };
    cfg.branches[1].component = {
      type: "pipe",
      length: 1,
      diameter: 0.02,
      roughness: 1e-5,
      elevationChange: 3,
    };
    expect(withDerivedGeometry(cfg)).toBe(cfg);
  });
});
