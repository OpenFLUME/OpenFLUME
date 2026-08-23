/**
 * variants — apply/diff over sparse variant patches.
 *
 * The contract worth defending is the round trip: whatever the editor
 * produces while a variant is active must survive being recorded as a patch
 * and re-resolved. Everything else here guards the ways a patch can go stale
 * as the base network changes underneath it.
 */
import { describe, it, expect } from "vitest";
import {
  applyVariant,
  resolveVariant,
  diffVariant,
  countVariantChanges,
  describeVariantChanges,
} from "../variants";
import type { NetworkConfig, VariantSpec } from "../schema";

function base(): NetworkConfig {
  return {
    meta: { name: "variants", version: 2 },
    settings: {
      mode: "steady",
      tolerance: 1e-6,
      maxIterations: 200,
      relaxation: 0.9,
    },
    fluid: { model: "incompressible", preset: "water" },
    nodes: [
      {
        id: "in",
        type: "boundary",
        x: 0,
        y: 0,
        pressure: 2e5,
        temperature: 300,
      },
      {
        id: "mid",
        type: "internal",
        x: 50,
        y: 0,
        pressure: 1.5e5,
        temperature: 300,
        volume: 0.01,
      },
      {
        id: "out",
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
        from: "in",
        to: "mid",
        component: { type: "pipe", length: 2, diameter: 0.03, roughness: 1e-5 },
      },
      {
        id: "p2",
        from: "mid",
        to: "out",
        component: { type: "pipe", length: 3, diameter: 0.03, roughness: 1e-5 },
      },
    ],
    solidNodes: [
      {
        id: "w1",
        type: "solid",
        x: 0,
        y: 60,
        temperature: 350,
        mass: 1,
        cp: 500,
      },
    ],
    conductors: [
      {
        id: "c1",
        from: "w1",
        to: "mid",
        type: { kind: "convection", h: 1000, area: 0.1 },
      },
    ],
  };
}

/** Round-trip helper: record `next` as a patch, then resolve it back. */
function roundTrip(from: NetworkConfig, next: NetworkConfig): NetworkConfig {
  const patch = diffVariant(from, next);
  return applyVariant(from, { id: "v", name: "V", patch });
}

describe("resolveVariant", () => {
  it("returns the base network (minus variants) with no patch", () => {
    const b = base();
    b.variants = [{ id: "v", name: "V" }];
    const { config, danglingIds } = resolveVariant(b, null);
    expect(config.variants).toBeUndefined();
    expect(danglingIds).toEqual([]);
    expect(config.nodes).toEqual(b.nodes);
  });

  it("merges settings field-wise and replaces the fluid whole", () => {
    const spec: VariantSpec = {
      id: "v",
      name: "Cold",
      patch: {
        settings: { tolerance: 1e-9 },
        fluid: { model: "idealGas", preset: "air" },
      },
    };
    const out = applyVariant(base(), spec);
    expect(out.settings.tolerance).toBe(1e-9);
    // Untouched settings survive the merge.
    expect(out.settings.maxIterations).toBe(200);
    expect(out.fluid).toEqual({ model: "idealGas", preset: "air" });
  });

  it("overrides entity fields without disturbing the others", () => {
    const spec: VariantSpec = {
      id: "v",
      name: "V",
      patch: { nodes: { in: { temperature: 250 } } },
    };
    const out = applyVariant(base(), spec);
    expect(out.nodes[0].temperature).toBe(250);
    expect(out.nodes[0].pressure).toBe(2e5);
    expect(out.nodes[1]).toEqual(base().nodes[1]);
  });

  it("deletes a field when the patch records an explicit undefined", () => {
    const spec: VariantSpec = {
      id: "v",
      name: "V",
      patch: { nodes: { mid: { volume: undefined } } },
    };
    const out = applyVariant(base(), spec);
    expect("volume" in out.nodes[1]).toBe(false);
  });

  it("adds and removes elements", () => {
    const spec: VariantSpec = {
      id: "v",
      name: "V",
      patch: {
        removed: ["p2"],
        added: {
          branches: [
            {
              id: "bypass",
              from: "mid",
              to: "out",
              component: { type: "orifice", area: 1e-4, cd: 0.6 },
            },
          ],
        },
      },
    };
    const out = applyVariant(base(), spec);
    expect(out.branches.map((b) => b.id)).toEqual(["p1", "bypass"]);
  });

  it("removing a node takes its incident branches and conductors with it", () => {
    const spec: VariantSpec = {
      id: "v",
      name: "V",
      patch: { removed: ["mid"] },
    };
    const out = applyVariant(base(), spec);
    expect(out.nodes.map((n) => n.id)).toEqual(["in", "out"]);
    // p1 and p2 both touched `mid`; c1 tied a wall to it.
    expect(out.branches).toEqual([]);
    expect(out.conductors).toEqual([]);
  });

  it("skips dangling patch targets and reports them instead of throwing", () => {
    const spec: VariantSpec = {
      id: "v",
      name: "V",
      patch: {
        nodes: { ghost: { temperature: 250 }, in: { temperature: 260 } },
        removed: ["alsoGone"],
      },
    };
    const { config, danglingIds } = resolveVariant(base(), spec);
    expect(danglingIds).toContain("ghost");
    expect(danglingIds).toContain("alsoGone");
    // The reachable half of the patch still applies.
    expect(config.nodes[0].temperature).toBe(260);
  });

  it("never mutates the base config", () => {
    const b = base();
    const snapshot = structuredClone(b);
    applyVariant(b, {
      id: "v",
      name: "V",
      patch: { nodes: { in: { temperature: 1 } }, removed: ["p2"] },
    });
    expect(b).toEqual(snapshot);
  });
});

describe("diffVariant round-trip", () => {
  it("returns undefined when nothing changed", () => {
    expect(diffVariant(base(), base())).toBeUndefined();
  });

  it("round-trips a settings edit", () => {
    const next = base();
    next.settings.mode = "transient";
    next.settings.dt = 0.01;
    next.settings.endTime = 5;
    expect(roundTrip(base(), next)).toEqual(next);
  });

  it("round-trips an entity field edit", () => {
    const next = base();
    next.nodes[0].temperature = 250;
    next.branches[1].component = {
      type: "pipe",
      length: 9,
      diameter: 0.05,
      roughness: 1e-5,
    };
    expect(roundTrip(base(), next)).toEqual(next);
  });

  it("round-trips a deleted optional field", () => {
    const next = base();
    delete next.nodes[1].volume;
    const out = roundTrip(base(), next);
    expect("volume" in out.nodes[1]).toBe(false);
    expect(out).toEqual(next);
  });

  it("round-trips added and removed elements", () => {
    const next = base();
    next.branches = [
      next.branches[0],
      {
        id: "bypass",
        from: "mid",
        to: "out",
        component: { type: "orifice", area: 1e-4, cd: 0.6 },
      },
    ];
    next.nodes.push({
      id: "extra",
      type: "internal",
      x: 150,
      y: 0,
      pressure: 1.2e5,
      temperature: 300,
      volume: 0.02,
    });
    expect(roundTrip(base(), next)).toEqual(next);
  });

  it("round-trips a thermal edit across solids and conductors", () => {
    const next = base();
    next.solidNodes![0].temperature = 400;
    next.conductors![0].type = {
      kind: "conduction",
      k: 50,
      area: 0.05,
      length: 0.1,
    };
    expect(roundTrip(base(), next)).toEqual(next);
  });

  it("records only what differs", () => {
    const next = base();
    next.nodes[0].temperature = 250;
    const patch = diffVariant(base(), next)!;
    expect(patch.nodes).toEqual({ in: { temperature: 250 } });
    expect(patch.branches).toBeUndefined();
    expect(patch.settings).toBeUndefined();
  });
});

describe("variant summaries", () => {
  it("counts and describes each change", () => {
    const spec: VariantSpec = {
      id: "v",
      name: "V",
      patch: {
        settings: { tolerance: 1e-9 },
        nodes: { in: { temperature: 250 } },
        removed: ["p2"],
      },
    };
    expect(countVariantChanges(spec)).toBe(3);
    const lines = describeVariantChanges(spec);
    expect(lines).toContain("settings.tolerance = 1e-9");
    expect(lines).toContain("in: temperature");
    expect(lines).toContain("removed p2");
  });

  it("reports an unmodified variant as zero changes", () => {
    expect(countVariantChanges({ id: "v", name: "V" })).toBe(0);
    expect(describeVariantChanges({ id: "v", name: "V" })).toEqual([]);
  });
});
