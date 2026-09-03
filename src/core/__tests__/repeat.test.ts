/**
 * repeat.ts — the repeatUnit primitive: clone a subgraph "unit" into a chain
 * of per-instance copies (Repeat-N with a seam branch; seamBranch: null gives
 * Duplicate).  Two composing parameter rules are under test:
 *
 *   Rule 1 (always): cloned `{ expr }` values are rewritten so references
 *   point at the instance's OWN members; non-member and reg('…') references
 *   are untouched.
 *   Rule 2 (linkParams): cloned plain-number fields on BINDABLE_* allowlist
 *   fields become `{ expr: "<accessor>('<templateId>').<field>" }`, binding
 *   the copy back to instance 1.  Canvas x/y, physical position.* and fields
 *   already holding `{ expr }` are skipped.
 *
 * The headline test rebuilds the shipped 20-segment cryogenic-line example
 * (ui/examples.ts sindaFluintCryoLineCooldown) from a ONE-segment template
 * and compares structure + RESOLVED physics against it (cross-import into
 * core tests follows the precedent of resultFindings.test.ts).  Conductor
 * labels match exactly (instanceLabel remaps the member ids inside them);
 * only physical position.x — i·segLen shipped vs x+(i−1)·offset here — is
 * compared to summation-order precision rather than exactly.
 */
import { describe, it, expect } from "vitest";
import type { Conductor, NetworkConfig } from "../schema";
import { repeatUnit, analyzeRepeatUnit } from "../repeat";
import type { RepeatOptions } from "../repeat";
import {
  isParameterExpression,
  resolveNetworkParameters,
} from "../paramBindings";
import { validateNetwork } from "../validate";
import { sindaFluintCryoLineCooldown } from "../../ui/examples";

type FluidNode = NetworkConfig["nodes"][number];
type Branch = NetworkConfig["branches"][number];

const PIPE = {
  type: "pipe",
  length: 1,
  diameter: 0.05,
  roughness: 1e-5,
} as const;

const branchById = (config: NetworkConfig, id: string): Branch =>
  config.branches.find((b) => b.id === id)!;
const nodeById = (config: NetworkConfig, id: string): FluidNode =>
  config.nodes.find((n) => n.id === id)!;
const solidById = (config: NetworkConfig, id: string) =>
  (config.solidNodes ?? []).find((s) => s.id === id)!;
const conductorById = (config: NetworkConfig, id: string): Conductor =>
  (config.conductors ?? []).find((c) => c.id === id)!;

/** Numeric fields of a (possibly resolved) pipe branch. */
function pipeFields(
  config: NetworkConfig,
  id: string,
): Record<string, unknown> {
  const b = branchById(config, id);
  if (b.component.type !== "pipe") throw new Error(`${id} is not a pipe`);
  return b.component as unknown as Record<string, unknown>;
}

/**
 * Global repeat invariant: after a successful repeat, NO member fluid node
 * of ANY instance — the template included — may have zero inflow.  Every
 * non-boundary member node keeps at least one incoming branch.  This guards
 * against orphaned clones (exit-crossing rewiring and seam-reachability
 * bugs).  `instances` is RepeatResult.instances: per the documented order
 * each entry leads with that generated instance's fluid node ids, so
 * slice(0, |members.nodes|) recovers them.
 */
function expectAllInstancesFed(
  config: NetworkConfig,
  opts: RepeatOptions,
  instances: string[][],
): void {
  const perInstance: string[][] = [opts.members.nodes];
  for (const createdIds of instances) {
    perInstance.push(createdIds.slice(0, opts.members.nodes.length));
  }
  perInstance.forEach((nodeIds, k) => {
    for (const id of nodeIds) {
      const node = config.nodes.find((n) => n.id === id);
      if (!node) throw new Error(`instance ${k + 1} member '${id}' missing`);
      if (node.type === "boundary") continue;
      const fed = config.branches.some((b) => b.to === id);
      expect(
        fed,
        `instance ${k + 1} node '${id}' must have an incoming branch`,
      ).toBe(true);
    }
  });
}

/* ------------------------------------------------------------------ */
/* Cryo golden fixtures                                                */
/* ------------------------------------------------------------------ */

const N = 20;
const SEG_LEN = 61 / N; // 3.05 m per segment
const DIAMETER = 0.0159; // 15.9 mm ID
const OUTER_DIAMETER = 0.019;
const ROUGHNESS = 1.5e-6;
const P_IN = 517000; // 75 psia
const P_OUT = 83000; // 0.82 atm
const WALL_MASS =
  8960 * (Math.PI / 4) * (OUTER_DIAMETER ** 2 - DIAMETER ** 2) * SEG_LEN;

const metres = (x: number, y = 0, z = 0) => ({ x, y, z });

/**
 * One segment of the cryogenic cooldown line, as a repeatable unit.  The
 * member node/wall/conductor fields that the shipped model binds by hand in
 * its post-pass are written as the SAME expressions here (volume ← feeding
 * pipe, conductor geometry ← pipe geometry), so Rule 1 alone reproduces the
 * per-instance bindings and Rule 2 reproduces the link-to-instance-1 ones.
 */
function cryoTemplate(): NetworkConfig {
  return {
    meta: { name: "Cryogenic line cooldown", version: 2 },
    settings: {
      mode: "transient",
      dt: 1,
      endTime: 80,
      timeStepping: "fixed",
      tolerance: 1e-6,
      maxIterations: 200,
      relaxation: 0.9,
    },
    fluid: { model: "realFluid", params: { fluidName: "Hydrogen" } },
    nodes: [
      {
        id: "inlet",
        type: "boundary",
        x: 2,
        y: 2,
        position: metres(0),
        pressure: P_IN,
        quality: 0,
        label: "LH₂ supply (75 psia)",
      },
      {
        id: "n1",
        type: "internal",
        x: 4 + 45,
        y: 4,
        position: metres(SEG_LEN),
        volume: { expr: "pipe('seg1').volume" },
        temperature: 300,
        pressure: P_OUT,
        label: "Segment 1",
      },
      {
        id: "outlet",
        type: "boundary",
        x: 947,
        y: 2,
        position: metres((N + 1) * SEG_LEN),
        pressure: P_OUT,
        temperature: 300,
        label: "Outlet (atm)",
      },
    ],
    branches: [
      {
        id: "seg1",
        from: "inlet",
        to: "n1",
        component: {
          type: "pipe",
          length: SEG_LEN,
          diameter: DIAMETER,
          roughness: ROUGHNESS,
        },
        label: "Segment 1",
      },
      {
        // Named seg21 (not seg2) so instances 2..20 allocate seg2..seg20
        // without colliding with the exit branch.
        id: "seg21",
        from: "n1",
        to: "outlet",
        component: {
          type: "pipe",
          length: SEG_LEN,
          diameter: DIAMETER,
          roughness: ROUGHNESS,
        },
        label: "Segment 21",
      },
    ],
    solidNodes: [
      {
        id: "wall1",
        type: "solid",
        x: 2 + 45,
        y: -73,
        position: metres(SEG_LEN, 0, (DIAMETER + OUTER_DIAMETER) / 4),
        temperature: 300,
        mass: WALL_MASS,
        cp: { material: "ofhc-copper" },
        label: "Wall 1",
      },
    ],
    conductors: [
      {
        id: "conv1",
        from: "wall1",
        to: "n1",
        type: {
          kind: "convection",
          area: { expr: "pipe('seg1').surfaceArea" },
          correlation: {
            model: "miropolskii",
            diameter: { expr: "pipe('seg1').diameter" },
            flowArea: { expr: "pipe('seg1').area" },
          },
        },
        label: "Conv wall1-n1",
      },
    ],
  };
}

const CRYO_OPTIONS: RepeatOptions = {
  members: { nodes: ["n1"], solidNodes: ["wall1"] },
  seamBranch: "seg1",
  count: 20,
  linkParams: true,
  crossingConductors: "share",
  canvasOffset: { x: 45, y: 0 },
  physicalOffset: { x: SEG_LEN, y: 0, z: 0 },
};

function cryoResult() {
  const r = repeatUnit(cryoTemplate(), CRYO_OPTIONS);
  if (!r.ok) throw new Error(`repeatUnit failed: ${r.error}`);
  return r;
}

/* ------------------------------------------------------------------ */
/* Small fixtures                                                      */
/* ------------------------------------------------------------------ */

/**
 * Two internal nodes chained by an induced branch, with one induced and one
 * crossing conductor — the fixture for Duplicate-mode and Rule 1/2 tests.
 */
function duplicateBase(): NetworkConfig {
  return {
    meta: { name: "dup", version: 2 },
    settings: { mode: "steady", tolerance: 1e-8, maxIterations: 100 },
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
        id: "n1",
        type: "internal",
        x: 100,
        y: 100,
        volume: 1e-3,
        pressure: 1.5e5,
        temperature: 300,
      },
      {
        id: "n2",
        type: "internal",
        x: 200,
        y: 100,
        volume: 2e-3,
        pressure: 1.2e5,
        temperature: 300,
      },
      {
        id: "b",
        type: "boundary",
        x: 300,
        y: 100,
        pressure: 1e5,
        temperature: 300,
      },
    ],
    solidNodes: [
      {
        id: "wall1",
        type: "solid",
        x: 150,
        y: 150,
        temperature: 350,
        mass: 2,
        cp: 385,
      },
      { id: "amb", type: "ambient", x: 0, y: 150, temperature: 290 },
    ],
    branches: [
      { id: "seg1", from: "a", to: "n1", component: { ...PIPE } }, // entry crossing
      { id: "p1", from: "n1", to: "n2", component: { ...PIPE } }, // induced
      { id: "seg2", from: "n2", to: "b", component: { ...PIPE } }, // exit crossing
    ],
    conductors: [
      {
        id: "w1", // induced (wall1 → n1)
        from: "wall1",
        to: "n1",
        type: { kind: "conduction", k: 200, area: 0.01, length: 0.05 },
      },
      {
        id: "cx", // crossing (wall1 → amb)
        from: "wall1",
        to: "amb",
        type: { kind: "conduction", k: 200, area: 0.01, length: 0.05 },
      },
    ],
  };
}

/** One-segment line a → n1 → b; the exit branch keeps the given id. */
function oneSegment(exitBranchId = "seg2"): NetworkConfig {
  return {
    meta: { name: "line", version: 2 },
    settings: { mode: "steady", tolerance: 1e-8, maxIterations: 100 },
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
      { id: "n1", type: "internal", x: 1, y: 0, volume: 1e-3 },
      {
        id: "b",
        type: "boundary",
        x: 2,
        y: 0,
        pressure: 1e5,
        temperature: 300,
      },
    ],
    branches: [
      { id: "seg1", from: "a", to: "n1", component: { ...PIPE } },
      { id: exitBranchId, from: "n1", to: "b", component: { ...PIPE } },
    ],
  };
}

const DUP_OPTIONS: RepeatOptions = {
  members: { nodes: ["n1", "n2"], solidNodes: ["wall1"] },
  seamBranch: null,
  count: 2,
  linkParams: false,
  canvasOffset: { x: 30, y: 30 },
  crossingConductors: "drop",
};

/* ------------------------------------------------------------------ */
/* HEADLINE — cryo golden                                              */
/* ------------------------------------------------------------------ */

describe("repeatUnit cryo golden (one segment → sindaFluintCryoLineCooldown)", () => {
  it("repeats the one-segment template into the shipped 20-segment counts", () => {
    const { config: got, created, instances } = cryoResult();

    expect(got.nodes.filter((n) => n.type === "internal")).toHaveLength(20);
    expect(got.solidNodes).toHaveLength(20);
    expect(got.conductors).toHaveLength(20);
    expect(got.branches).toHaveLength(21);

    // Bookkeeping: every created id, in instance order (fluid, solid, seam
    // clone, induced conductor — the template has no induced branches).
    expect(created.nodes).toEqual(
      Array.from({ length: 19 }, (_, k) => `n${k + 2}`),
    );
    expect(created.solidNodes).toEqual(
      Array.from({ length: 19 }, (_, k) => `wall${k + 2}`),
    );
    expect(created.branches).toEqual(
      Array.from({ length: 19 }, (_, k) => `seg${k + 2}`),
    );
    expect(created.conductors).toEqual(
      Array.from({ length: 19 }, (_, k) => `conv${k + 2}`),
    );
    expect(instances).toHaveLength(19);
    expect(instances[0]).toEqual(["n2", "wall2", "seg2", "conv2"]);
    expect(instances[18]).toEqual(["n20", "wall20", "seg20", "conv20"]);
  });

  it("chains inlet → n1 → … → n20 → outlet with conv{i}: wall{i} → n{i}", () => {
    const { config: got, instances } = cryoResult();
    for (let i = 1; i <= 20; i++) {
      const seg = branchById(got, `seg${i}`);
      expect(seg.from, `seg${i}.from`).toBe(i === 1 ? "inlet" : `n${i - 1}`);
      expect(seg.to, `seg${i}.to`).toBe(`n${i}`);
      const conv = conductorById(got, `conv${i}`);
      expect([conv.from, conv.to], `conv${i}`).toEqual([`wall${i}`, `n${i}`]);
    }
    // The exit crossing is rewired to the LAST instance's exit node.
    expect(branchById(got, "seg21").from).toBe("n20");
    expect(branchById(got, "seg21").to).toBe("outlet");
    // The template (instance 1) is left in place.
    expect(branchById(got, "seg1").from).toBe("inlet");
    // Global invariant: no member node of any instance is starved of inflow.
    expectAllInstancesFed(got, CRYO_OPTIONS, instances);
  });

  it("matches the shipped model's resolved physics exactly", () => {
    const { config: got } = cryoResult();
    const want = sindaFluintCryoLineCooldown;
    const rGot = resolveNetworkParameters(got);
    const rWant = resolveNetworkParameters(want);
    expect(rGot.ok).toBe(true);
    expect(rWant.ok).toBe(true);
    if (!rGot.ok || !rWant.ok) return;
    const g = rGot.config;
    const w = rWant.config;

    for (let i = 1; i <= 21; i++) {
      const gb = pipeFields(g, `seg${i}`);
      const wb = pipeFields(w, `seg${i}`);
      for (const field of ["length", "diameter", "roughness"]) {
        expect(gb[field], `seg${i}.${field}`).toBe(wb[field]);
      }
    }
    for (let i = 1; i <= 20; i++) {
      const gn = nodeById(g, `n${i}`);
      const wn = nodeById(w, `n${i}`);
      expect(gn.volume, `n${i}.volume`).toBe(wn.volume);
      expect(gn.pressure, `n${i}.pressure`).toBe(wn.pressure);
      expect(gn.temperature, `n${i}.temperature`).toBe(wn.temperature);

      const gs = solidById(g, `wall${i}`);
      const ws = solidById(w, `wall${i}`);
      expect(gs.mass, `wall${i}.mass`).toBe(ws.mass);
      expect(gs.temperature, `wall${i}.temperature`).toBe(ws.temperature);

      const gc = conductorById(g, `conv${i}`);
      const wc = conductorById(w, `conv${i}`);
      if (
        gc.type.kind !== "convection" ||
        wc.type.kind !== "convection" ||
        !gc.type.correlation ||
        !wc.type.correlation
      ) {
        throw new Error("conv must stay a correlated convection conductor");
      }
      expect(gc.type.area, `conv${i}.area`).toBe(wc.type.area);
      expect(gc.type.correlation.diameter, `conv${i} corr diameter`).toBe(
        wc.type.correlation.diameter,
      );
      expect(gc.type.correlation.flowArea, `conv${i} corr flowArea`).toBe(
        wc.type.correlation.flowArea,
      );
    }
  });

  it("matches the shipped model structurally (raw entity identity)", () => {
    const { config: got } = cryoResult();
    const want = sindaFluintCryoLineCooldown;

    // Seam clones seg2..seg20 are byte-identical to the hand-built+post-passed
    // model: Rule 2 produces exactly `pipe('seg1').<field>` for i ≥ 2.
    for (let i = 2; i <= 20; i++) {
      expect(branchById(got, `seg${i}`)).toEqual(branchById(want, `seg${i}`));
    }
    // Walls: identical except physical position (see note below).
    for (let i = 2; i <= 20; i++) {
      const gs = { ...solidById(got, `wall${i}`) } as Record<string, unknown>;
      const ws = { ...solidById(want, `wall${i}`) } as Record<string, unknown>;
      delete gs.position;
      delete ws.position;
      expect(gs).toEqual(ws);
    }
    // Conductors: byte-identical INCLUDING the label — instanceLabel remaps
    // the member ids inside "Conv wall1-n1" through the instance id map,
    // landing exactly on the shipped "Conv wall{i}-n{i}".
    for (let i = 2; i <= 20; i++) {
      expect(conductorById(got, `conv${i}`)).toEqual(
        conductorById(want, `conv${i}`),
      );
      expect(conductorById(got, `conv${i}`).label).toBe(`Conv wall${i}-n${i}`);
    }
    // Nodes: volume matches the shipped `pipe('seg{i}').volume` (Rule 1);
    // pressure/temperature are linked to instance 1 (Rule 2) where the
    // shipped model keeps literals — resolved physics is identical.
    for (const i of [2, 10, 20]) {
      const gn = nodeById(got, `n${i}`);
      const wn = nodeById(want, `n${i}`);
      expect(gn.volume).toEqual(wn.volume);
      expect(gn.pressure).toEqual({ expr: "node('n1').pressure" });
      expect(gn.temperature).toEqual({ expr: "node('n1').temperature" });
      expect(gn.label).toBe(wn.label);
    }
    // The exit branch is REWIRED, never cloned: it stays literal where the
    // shipped post-pass bound it to pipe('seg1') — resolved-equal, raw-differs.
    expect(pipeFields(got, "seg21")).toMatchObject({
      length: SEG_LEN,
      diameter: DIAMETER,
      roughness: ROUGHNESS,
    });
    expect(isParameterExpression(pipeFields(want, "seg21").length)).toBe(true);
  });

  it("matches the shipped physical layout to summation-order precision", () => {
    const { config: got } = cryoResult();
    const want = sindaFluintCryoLineCooldown;
    // The shipped model computes position.x = i * segLen; repeatUnit adds
    // x + (i-1)·offset.  Both are 3.05·i up to one ulp of summation order
    // (e.g. 18.3 vs 18.299999999999997) — physically irrelevant, so compare
    // to 12 decimal digits rather than exactly.
    const axis = (v: unknown): number => {
      if (typeof v !== "number") throw new Error("expected a literal axis");
      return v;
    };
    for (let i = 1; i <= 20; i++) {
      const gp = nodeById(got, `n${i}`).position!;
      const wp = nodeById(want, `n${i}`).position!;
      expect(axis(gp.x), `n${i}.position.x`).toBeCloseTo(axis(wp.x), 12);
      expect(gp.y, `n${i}.position.y`).toBe(wp.y);
      expect(gp.z, `n${i}.position.z`).toBe(wp.z);
      const gs = solidById(got, `wall${i}`).position!;
      const ws = solidById(want, `wall${i}`).position!;
      expect(axis(gs.x), `wall${i}.position.x`).toBeCloseTo(axis(ws.x), 12);
      expect(gs.z, `wall${i}.position.z`).toBe(ws.z);
    }
    // Canvas offsets land exactly (integers): n{i} at 4+45i, wall{i} at 2+45i.
    for (const i of [2, 20]) {
      expect(nodeById(got, `n${i}`).x).toBe(nodeById(want, `n${i}`).x);
      expect(solidById(got, `wall${i}`).x).toBe(solidById(want, `wall${i}`).x);
      expect(solidById(got, `wall${i}`).y).toBe(solidById(want, `wall${i}`).y);
    }
  });

  it("produces a config that validateNetwork accepts with ZERO errors", () => {
    const { config: got } = cryoResult();
    expect(validateNetwork(got)).toEqual([]);
    // Guard the cross-import itself: the shipped model is healthy too.
    expect(validateNetwork(sindaFluintCryoLineCooldown)).toEqual([]);
  });

  it("classifies the cryo template via analyzeRepeatUnit", () => {
    const a = analyzeRepeatUnit(cryoTemplate(), CRYO_OPTIONS.members);
    expect(a).toEqual({
      ok: true,
      inducedBranches: [],
      inducedConductors: ["conv1"],
      entryCrossings: ["seg1"],
      exitCrossings: ["seg21"],
      crossingConductors: [],
      seamBranch: "seg1",
      seamError: null,
      exitNode: "n1",
      exitError: null,
    });
  });
});

/* ------------------------------------------------------------------ */
/* Purity                                                              */
/* ------------------------------------------------------------------ */

describe("purity", () => {
  it("never mutates the input config and returns an independent clone", () => {
    const template = cryoTemplate();
    const snapshot = JSON.parse(JSON.stringify(template)) as unknown;
    const r = repeatUnit(template, { ...CRYO_OPTIONS, count: 3 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(template).toEqual(snapshot);
    expect(r.config).not.toBe(template);
    expect(nodeById(r.config, "n1")).not.toBe(template.nodes[1]);
    expect(branchById(r.config, "seg1")).not.toBe(template.branches[0]);
  });
});

/* ------------------------------------------------------------------ */
/* Duplicate mode (seamBranch: null) ≡ store duplicateSelection        */
/* ------------------------------------------------------------------ */

describe("duplicate mode (seamBranch: null)", () => {
  it("reproduces duplicateSelection topology: induced edges cloned, crossings dropped, +30/+30", () => {
    const r = repeatUnit(duplicateBase(), DUP_OPTIONS);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const got = r.config;

    // Mirrors ui/store.ts duplicateSelection with canvasSelection
    // [n1, n2, wall1]: members cloned at +30/+30.  The store passes
    // idStrategy: "firstFree" (the legacy createId naming); on this fixture
    // both strategies mint the same ids, so the default is exercised here.
    expect(nodeById(got, "n3").x).toBe(130);
    expect(nodeById(got, "n3").y).toBe(130);
    expect(nodeById(got, "n4").x).toBe(230);
    expect(nodeById(got, "n4").y).toBe(130);
    expect(solidById(got, "wall2").x).toBe(180);
    expect(solidById(got, "wall2").y).toBe(180);

    // Induced branch and conductor cloned with remapped endpoints.
    const p2 = branchById(got, "p2");
    expect([p2.from, p2.to]).toEqual(["n3", "n4"]);
    const w2 = conductorById(got, "w2");
    expect([w2.from, w2.to]).toEqual(["wall2", "n3"]);

    // Crossing branches AND the crossing conductor are NOT cloned (the
    // store's drop behaviour), and stay attached to the template members.
    // Totals: 3 original branches + 1 induced clone; 2 conductors + 1 clone.
    expect(got.branches).toHaveLength(4);
    expect(got.conductors).toHaveLength(3);
    expect([branchById(got, "seg1").from, branchById(got, "seg1").to]).toEqual([
      "a",
      "n1",
    ]);
    expect([branchById(got, "seg2").from, branchById(got, "seg2").to]).toEqual([
      "n2",
      "b",
    ]);
    expect([
      conductorById(got, "cx").from,
      conductorById(got, "cx").to,
    ]).toEqual(["wall1", "amb"]);

    // No exit rewiring without a seam; literal copies with linkParams: false.
    expect(nodeById(got, "n3").volume).toBe(1e-3);
    expect(solidById(got, "wall2").mass).toBe(2);
    expect(pipeFields(got, "p2").length).toBe(1);

    expect(r.created).toEqual({
      nodes: ["n3", "n4"],
      solidNodes: ["wall2"],
      branches: ["p2"],
      conductors: ["w2"],
    });
    expect(r.instances).toEqual([["n3", "n4", "wall2", "p2", "w2"]]);
  });

  it('ignores crossingConductors: "share" when the seam is null', () => {
    const r = repeatUnit(duplicateBase(), {
      ...DUP_OPTIONS,
      crossingConductors: "share",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.config.conductors).toHaveLength(3); // w1, cx + w2: cx not cloned
    expect(r.created.conductors).toEqual(["w2"]);
  });

  it("copies inherit the template's subnetwork group membership", () => {
    // Membership is the member node's own `group` field, so structuredClone
    // carries it onto every copy — pin that so it holds by DESIGN, not by
    // accident.  The group registry itself is untouched (the copies join
    // the EXISTING group), which the unknown-group validation confirms.
    const config = duplicateBase();
    config.groups = [{ id: "G1", label: "Unit", x: 0, y: 0 }];
    nodeById(config, "n1").group = "G1";
    nodeById(config, "n2").group = "G1";
    solidById(config, "wall1").group = "G1";
    const r = repeatUnit(config, DUP_OPTIONS);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(nodeById(r.config, "n3").group).toBe("G1");
    expect(nodeById(r.config, "n4").group).toBe("G1");
    expect(solidById(r.config, "wall2").group).toBe("G1");
    // No "unknown group" reference errors: every copy's membership resolves
    // against the untouched registry.
    expect(
      validateNetwork(r.config).filter((e) => e.includes("group")),
    ).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* Rule 1 — expression retargeting (always on)                          */
/* ------------------------------------------------------------------ */

describe("Rule 1 — expression ids are retargeted to the instance's own members", () => {
  it("rewrites member references, leaves external ids and reg('…') alone", () => {
    const config = duplicateBase();
    config.registers = { gain: 2 };
    nodeById(config, "n1").volume = {
      expr: "pipe('p1').volume + node('n2').volume + node('b').volume + reg('gain')",
    };
    nodeById(config, "n1").position = {
      x: { expr: "node('n2').position.x + 1" },
    };
    // linkParams: true on purpose — Rule 1 must still own { expr } fields.
    const r = repeatUnit(config, { ...DUP_OPTIONS, linkParams: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const n3 = nodeById(r.config, "n3");
    expect(n3.volume).toEqual({
      expr: "pipe('p2').volume + node('n4').volume + node('b').volume + reg('gain')",
    });
    expect(n3.position).toEqual({ x: { expr: "node('n4').position.x + 1" } });
  });

  it("retargets expressions on induced branches and conductors too", () => {
    const config = duplicateBase();
    const p1 = branchById(config, "p1");
    (p1.component as unknown as Record<string, unknown>).diameter = {
      expr: "pipe('seg1').diameter * 2",
    };
    const w1 = conductorById(config, "w1");
    (w1.type as unknown as Record<string, unknown>).area = {
      expr: "solid('wall1').mass / 100",
    };
    const r = repeatUnit(config, DUP_OPTIONS);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    // pipe('seg1') is NOT a member (entry crossing) → left alone.
    expect(pipeFields(r.config, "p2").diameter).toEqual({
      expr: "pipe('seg1').diameter * 2",
    });
    // solid('wall1') IS a member → retargeted to wall2.
    const w2 = conductorById(r.config, "w2");
    expect((w2.type as unknown as Record<string, unknown>).area).toEqual({
      expr: "solid('wall2').mass / 100",
    });
  });
});

/* ------------------------------------------------------------------ */
/* Rule 2 — literal linking (linkParams only)                           */
/* ------------------------------------------------------------------ */

describe("Rule 2 — cloned literals bind to instance 1 (linkParams)", () => {
  it("links allowlisted literals, skips exprs / positions / non-bindable fields", () => {
    const config = duplicateBase();
    nodeById(config, "n1").volume = { expr: "pipe('p1').volume" };
    nodeById(config, "n1").position = { x: 7 };
    const r = repeatUnit(config, { ...DUP_OPTIONS, linkParams: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const got = r.config;

    // Plain numbers on BINDABLE fields → linked back to the template.
    expect(nodeById(got, "n3").pressure).toEqual({
      expr: "node('n1').pressure",
    });
    expect(nodeById(got, "n3").temperature).toEqual({
      expr: "node('n1').temperature",
    });
    expect(solidById(got, "wall2").mass).toEqual({
      expr: "solid('wall1').mass",
    });
    expect(solidById(got, "wall2").temperature).toEqual({
      expr: "solid('wall1').temperature",
    });
    expect(pipeFields(got, "p2").length).toEqual({ expr: "pipe('p1').length" });
    expect(pipeFields(got, "p2").diameter).toEqual({
      expr: "pipe('p1').diameter",
    });
    const w2 = conductorById(got, "w2").type as unknown as Record<
      string,
      unknown
    >;
    expect(w2.area).toEqual({ expr: "conductor('w1').area" });
    expect(w2.length).toEqual({ expr: "conductor('w1').length" });

    // An existing { expr } is Rule 1's job — Rule 2 never rewrites it.
    expect(nodeById(got, "n3").volume).toEqual({ expr: "pipe('p2').volume" });
    // Conduction k is a SolidPropertySpec: Rule 1 only, never linked.
    expect(w2.k).toBe(200);
    // Canvas x/y and physical position.* are offsets' business — never linked.
    expect(typeof nodeById(got, "n3").x).toBe("number");
    expect(nodeById(got, "n3").position).toEqual({ x: 7 });
  });

  it("never touches dpTable points or a pump curve", () => {
    const config: NetworkConfig = {
      meta: { name: "dp", version: 2 },
      settings: { mode: "steady", tolerance: 1e-8, maxIterations: 100 },
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
        { id: "n1", type: "internal", x: 1, y: 0, volume: 1e-3 },
        { id: "n2", type: "internal", x: 2, y: 0, volume: 1e-3 },
        {
          id: "b",
          type: "boundary",
          x: 3,
          y: 0,
          pressure: 1e5,
          temperature: 300,
        },
      ],
      branches: [
        {
          id: "pump1",
          from: "a",
          to: "n1",
          component: {
            type: "pump",
            curve: [
              [0, 1e5],
              [0.1, 0],
            ],
          },
        },
        {
          id: "dp1",
          from: "n1",
          to: "n2",
          component: {
            type: "dpTable",
            points: [
              [0, 0],
              [1, 1e5],
            ],
          },
        },
        { id: "seg2", from: "n2", to: "b", component: { ...PIPE } },
      ],
    };
    const r = repeatUnit(config, {
      members: { nodes: ["n1", "n2"], solidNodes: [] },
      seamBranch: "pump1",
      count: 2,
      linkParams: true,
      canvasOffset: { x: 10, y: 0 },
      crossingConductors: "drop",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    // dp1 is induced, pump1 is the seam — both are cloned, both allowlists
    // are EMPTY, so tables/curves stay literal arrays.
    const dp2 = branchById(r.config, "dp2");
    expect(dp2.component).toEqual({
      type: "dpTable",
      points: [
        [0, 0],
        [1, 1e5],
      ],
    });
    const pump2 = branchById(r.config, "pump2");
    expect(pump2.component).toEqual({
      type: "pump",
      curve: [
        [0, 1e5],
        [0.1, 0],
      ],
    });
    // …and the chain is still wired through the new instance.
    expect([pump2.from, pump2.to]).toEqual(["n2", "n3"]);
    expect([dp2.from, dp2.to]).toEqual(["n3", "n4"]);
    expect(branchById(r.config, "seg2").from).toBe("n4");
  });

  it("linkParams: false produces literal copies", () => {
    const config = duplicateBase();
    nodeById(config, "n1").volume = { expr: "pipe('p1').volume" };
    const r = repeatUnit(config, DUP_OPTIONS); // linkParams: false
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const got = r.config;

    expect(nodeById(got, "n3").pressure).toBe(1.5e5);
    expect(nodeById(got, "n3").temperature).toBe(300);
    expect(solidById(got, "wall2").mass).toBe(2);
    expect(pipeFields(got, "p2").length).toBe(1);
    // Rule 1 still applies with linkParams: false.
    expect(nodeById(got, "n3").volume).toEqual({ expr: "pipe('p2').volume" });
  });
});

/* ------------------------------------------------------------------ */
/* Id allocation + labels                                              */
/* ------------------------------------------------------------------ */

describe("id allocation and labels", () => {
  it("falls back past collisions: an exit branch already named seg2 still yields unique ids", () => {
    const r = repeatUnit(oneSegment("seg2"), {
      members: { nodes: ["n1"], solidNodes: [] },
      seamBranch: "seg1",
      count: 2,
      linkParams: false,
      canvasOffset: { x: 10, y: 0 },
      crossingConductors: "drop",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const got = r.config;

    // seg2 is taken (exit branch) → the seam clone skips to seg3.
    const ids = [
      ...got.nodes.map((n) => n.id),
      ...got.branches.map((b) => b.id),
    ];
    expect(new Set(ids).size).toBe(ids.length);
    const seg3 = branchById(got, "seg3");
    expect([seg3.from, seg3.to]).toEqual(["n1", "n2"]);
    expect(branchById(got, "seg2").from).toBe("n2"); // rewired to the clone
    expect(branchById(got, "seg2").to).toBe("b");
    expect(validateNetwork(got)).toEqual([]);
  });

  it("derives _2-style ids for base ids without a trailing integer", () => {
    const config: NetworkConfig = {
      meta: { name: "nn", version: 2 },
      settings: { mode: "steady", tolerance: 1e-8, maxIterations: 100 },
      fluid: { model: "incompressible", preset: "water" },
      nodes: [
        {
          id: "feed",
          type: "boundary",
          x: 0,
          y: 0,
          pressure: 2e5,
          temperature: 300,
        },
        { id: "nA", type: "internal", x: 1, y: 0, volume: 1e-3, label: "Feed" },
        {
          id: "drain",
          type: "boundary",
          x: 2,
          y: 0,
          pressure: 1e5,
          temperature: 300,
        },
      ],
      branches: [
        {
          id: "inletPipe",
          from: "feed",
          to: "nA",
          component: { ...PIPE },
          label: "Feed",
        },
        { id: "outletPipe", from: "nA", to: "drain", component: { ...PIPE } },
      ],
    };
    const r = repeatUnit(config, {
      members: { nodes: ["nA"], solidNodes: [] },
      seamBranch: "inletPipe",
      count: 2,
      linkParams: false,
      canvasOffset: { x: 10, y: 0 },
      crossingConductors: "drop",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const seam = branchById(r.config, "inletPipe_2");
    expect([seam.from, seam.to]).toEqual(["nA", "nA_2"]);
    expect(branchById(r.config, "outletPipe").from).toBe("nA_2");
    // Labels: trailing-int bump / append " 2"; undefined stays undefined.
    expect(nodeById(r.config, "nA_2").label).toBe("Feed 2");
    expect(seam.label).toBe("Feed 2");
    expect(branchById(r.config, "outletPipe").label).toBeUndefined();
    expect(nodeById(r.config, "drain").label).toBeUndefined();
  });

  it('bumps a trailing integer in labels ("Segment 1" → "Segment 2")', () => {
    // Exit branch named segOut so the seam clones take seg2 / seg3.
    const config = oneSegment("segOut");
    nodeById(config, "n1").label = "Segment 1";
    branchById(config, "seg1").label = "Segment 1";
    const r = repeatUnit(config, {
      members: { nodes: ["n1"], solidNodes: [] },
      seamBranch: "seg1",
      count: 3,
      linkParams: false,
      canvasOffset: { x: 10, y: 0 },
      crossingConductors: "drop",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(nodeById(r.config, "n2").label).toBe("Segment 2");
    expect(nodeById(r.config, "n3").label).toBe("Segment 3");
    expect(branchById(r.config, "seg2").label).toBe("Segment 2");
    expect(branchById(r.config, "seg3").label).toBe("Segment 3");
  });
});

/* ------------------------------------------------------------------ */
/* idStrategy: "firstFree" — the legacy Duplicate naming               */
/* ------------------------------------------------------------------ */

describe('idStrategy: "firstFree" (legacy Duplicate naming)', () => {
  /**
   * src → j → n12 → 9up → sink with the three internal nodes as the unit
   * (induced branches p, p12).  Chosen to distinguish the strategies: `j`
   * has no trailing integer, `n12` has one, and `9up` starts with a digit
   * (the "N" prefix fallback).
   */
  function firstFreeBase(): NetworkConfig {
    return {
      meta: { name: "ff", version: 2 },
      settings: { mode: "steady", tolerance: 1e-8, maxIterations: 100 },
      fluid: { model: "incompressible", preset: "water" },
      nodes: [
        {
          id: "src",
          type: "boundary",
          x: 0,
          y: 0,
          pressure: 2e5,
          temperature: 300,
        },
        { id: "j", type: "internal", x: 1, y: 0, volume: 1e-3 },
        { id: "n12", type: "internal", x: 2, y: 0, volume: 1e-3 },
        { id: "9up", type: "internal", x: 3, y: 0, volume: 1e-3 },
        {
          id: "sink",
          type: "boundary",
          x: 4,
          y: 0,
          pressure: 1e5,
          temperature: 300,
        },
      ],
      branches: [
        { id: "in", from: "src", to: "j", component: { ...PIPE } },
        { id: "p", from: "j", to: "n12", component: { ...PIPE } },
        { id: "p12", from: "n12", to: "9up", component: { ...PIPE } },
        { id: "out", from: "9up", to: "sink", component: { ...PIPE } },
      ],
    };
  }
  const FF_BASE: RepeatOptions = {
    members: { nodes: ["j", "n12", "9up"], solidNodes: [] },
    seamBranch: null,
    count: 2,
    linkParams: false,
    canvasOffset: { x: 30, y: 30 },
    crossingConductors: "drop",
  };

  it("mints the first free id for the letter prefix (j → j1, n12 → n1)", () => {
    const r = repeatUnit(firstFreeBase(), {
      ...FF_BASE,
      idStrategy: "firstFree",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // j: no trailing integer → prefix "j" → j1.  n12: the trailing integer
    // is DROPPED — prefix "n", first free is n1.  9up starts with a digit →
    // the "N" fallback prefix → N1.  Branches take the FIXED "b" prefix the
    // pre-repeat store used (createId("b", …)): p → b1, p12 → b2 — NOT
    // p1/p2 (this assertion used to pin that bug).
    expect(r.created.nodes).toEqual(["j1", "n1", "N1"]);
    expect(r.created.branches).toEqual(["b1", "b2"]);
    const b1 = branchById(r.config, "b1");
    expect([b1.from, b1.to]).toEqual(["j1", "n1"]);
    const b2 = branchById(r.config, "b2");
    expect([b2.from, b2.to]).toEqual(["n1", "N1"]);
    // Crossing branches stay attached to the templates.
    expect(branchById(r.config, "in").to).toBe("j");
    expect(branchById(r.config, "out").from).toBe("9up");
    expect(validateNetwork(r.config)).toEqual([]);
  });

  it('mints cloned edges with the FIXED "b"/"c" prefixes regardless of the source id', () => {
    // The merge-base duplicateSelection minted cloned branches via
    // createId("b", allIds) and conductors via createId("c", allIds) — a
    // fixed prefix, never derived from the source id.  Duplicating a pair
    // joined by 'myPipe1' therefore mints 'b1', not 'myPipe2'.
    const config: NetworkConfig = {
      meta: { name: "ff-edges", version: 2 },
      settings: { mode: "steady", tolerance: 1e-8, maxIterations: 100 },
      fluid: { model: "incompressible", preset: "water" },
      nodes: [
        {
          id: "src",
          type: "boundary",
          x: 0,
          y: 0,
          pressure: 2e5,
          temperature: 300,
        },
        { id: "n1", type: "internal", x: 1, y: 0, volume: 1e-3 },
        { id: "n2", type: "internal", x: 2, y: 0, volume: 1e-3 },
        {
          id: "snk",
          type: "boundary",
          x: 3,
          y: 0,
          pressure: 1e5,
          temperature: 300,
        },
      ],
      solidNodes: [
        {
          id: "wall1",
          type: "solid",
          x: 1,
          y: 1,
          temperature: 350,
          mass: 2,
          cp: 385,
        },
      ],
      branches: [
        { id: "feed", from: "src", to: "n1", component: { ...PIPE } },
        { id: "myPipe1", from: "n1", to: "n2", component: { ...PIPE } },
        { id: "drain", from: "n2", to: "snk", component: { ...PIPE } },
      ],
      conductors: [
        {
          id: "heatLeak1",
          from: "wall1",
          to: "n2",
          type: { kind: "convection", h: 100, area: 0.01 },
        },
      ],
    };
    const r = repeatUnit(config, {
      members: { nodes: ["n1", "n2"], solidNodes: ["wall1"] },
      seamBranch: null,
      count: 2,
      linkParams: false,
      canvasOffset: { x: 30, y: 30 },
      crossingConductors: "drop",
      idStrategy: "firstFree",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Nodes keep prefixOf(oldId) (n1 → n3 since n2 is a member, n2 → n4,
    // wall1 → wall2); the induced branch/conductor take the fixed prefixes.
    expect(r.created.nodes).toEqual(["n3", "n4"]);
    expect(r.created.solidNodes).toEqual(["wall2"]);
    expect(r.created.branches).toEqual(["b1"]);
    expect(r.created.conductors).toEqual(["c1"]);
    expect([
      branchById(r.config, "b1").from,
      branchById(r.config, "b1").to,
    ]).toEqual(["n3", "n4"]);
    expect([
      conductorById(r.config, "c1").from,
      conductorById(r.config, "c1").to,
    ]).toEqual(["wall2", "n4"]);
    expect(r.config.branches.some((b) => b.id === "myPipe2")).toBe(false);
    expect(validateNetwork(r.config)).toEqual([]);
  });

  it('skips pre-existing ids under the "N" fallback prefix', () => {
    const config = firstFreeBase();
    config.nodes.push({ id: "N1", type: "internal", x: 9, y: 9, volume: 1e-3 });
    const r = repeatUnit(config, { ...FF_BASE, idStrategy: "firstFree" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.created.nodes).toEqual(["j1", "n1", "N2"]);
  });

  it("allocates the next free id per generated instance when count > 2", () => {
    // Two generated instances mint j1/j2, n1/n2, N1/N2 — the same sequence
    // two successive legacy duplicate calls produced.
    const r = repeatUnit(firstFreeBase(), {
      ...FF_BASE,
      count: 3,
      idStrategy: "firstFree",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.instances[0]!.slice(0, 3)).toEqual(["j1", "n1", "N1"]);
    expect(r.instances[1]!.slice(0, 3)).toEqual(["j2", "n2", "N2"]);
  });

  it('"instance" stays the default when idStrategy is omitted', () => {
    const r = repeatUnit(firstFreeBase(), FF_BASE); // no idStrategy
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.created.nodes).toEqual(["j_2", "n13", "9up_2"]);
    expect(r.created.branches).toEqual(["p_2", "p13"]);
  });
});

/* ------------------------------------------------------------------ */
/* Labels remap member ids                                             */
/* ------------------------------------------------------------------ */

describe("labels remap member ids (longest-first, token-bounded)", () => {
  /**
   * a → n1 → b with wall1 and conv1 (wall1 → n1) labelled "Conv wall1-n1" —
   * the shipped cryo-line conductor-label shape.  Instance 2 allocates
   * n2 / wall2 / conv2 and seam seg3 (seg2 is the exit branch).
   */
  function labelBase(): NetworkConfig {
    return {
      meta: { name: "lbl", version: 2 },
      settings: { mode: "steady", tolerance: 1e-8, maxIterations: 100 },
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
        { id: "n1", type: "internal", x: 1, y: 0, volume: 1e-3 },
        {
          id: "b",
          type: "boundary",
          x: 2,
          y: 0,
          pressure: 1e5,
          temperature: 300,
        },
      ],
      solidNodes: [
        {
          id: "wall1",
          type: "solid",
          x: 1,
          y: 1,
          temperature: 350,
          mass: 2,
          cp: 385,
        },
      ],
      branches: [
        { id: "seg1", from: "a", to: "n1", component: { ...PIPE } },
        { id: "seg2", from: "n1", to: "b", component: { ...PIPE } },
      ],
      conductors: [
        {
          id: "conv1",
          from: "wall1",
          to: "n1",
          type: { kind: "conduction", k: 200, area: 0.01, length: 0.05 },
          label: "Conv wall1-n1",
        },
      ],
    };
  }

  const LABEL_OPTIONS: RepeatOptions = {
    members: { nodes: ["n1"], solidNodes: ["wall1"] },
    seamBranch: "seg1",
    count: 2,
    linkParams: false,
    canvasOffset: { x: 10, y: 0 },
    crossingConductors: "drop",
  };

  it('remaps every member id in the label ("Conv wall1-n1" → "Conv wall2-n2")', () => {
    const r = repeatUnit(labelBase(), LABEL_OPTIONS);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // A trailing-int bump would give the misleading "Conv wall1-n2".
    expect(conductorById(r.config, "conv2").label).toBe("Conv wall2-n2");
    expect(conductorById(r.config, "conv1").label).toBe("Conv wall1-n1");
  });

  it("protects longer look-alike tokens: n10 / wall10 survive while n1 / wall1 remap", () => {
    const config = labelBase();
    nodeById(config, "n1").label = "n10 wall10 n1 wall1";
    const r = repeatUnit(config, LABEL_OPTIONS);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Token boundaries ([A-Za-z0-9_] on either side block a match) keep the
    // n1 inside n10 and the wall1 inside wall10 untouched.
    expect(nodeById(r.config, "n2").label).toBe("n10 wall10 n2 wall2");
  });

  it("matches longest ids first when BOTH n1 and n10 are members", () => {
    const config: NetworkConfig = {
      meta: { name: "lbl2", version: 2 },
      settings: { mode: "steady", tolerance: 1e-8, maxIterations: 100 },
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
        { id: "n1", type: "internal", x: 1, y: 0, volume: 1e-3 },
        { id: "n10", type: "internal", x: 2, y: 0, volume: 1e-3 },
        {
          id: "b",
          type: "boundary",
          x: 3,
          y: 0,
          pressure: 1e5,
          temperature: 300,
        },
      ],
      branches: [
        { id: "seg1", from: "a", to: "n1", component: { ...PIPE } },
        {
          id: "p1",
          from: "n1",
          to: "n10",
          component: { ...PIPE },
          label: "Link n1-n10",
        },
        { id: "seg2", from: "n10", to: "b", component: { ...PIPE } },
      ],
    };
    const r = repeatUnit(config, {
      members: { nodes: ["n1", "n10"], solidNodes: [] },
      seamBranch: "seg1",
      count: 2,
      linkParams: false,
      canvasOffset: { x: 10, y: 0 },
      crossingConductors: "drop",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // n1→n2 and n10→n11 — never a partial "n2…0" corruption of the n10 token.
    expect(branchById(r.config, "p2").label).toBe("Link n2-n11");
    expect([
      branchById(r.config, "p2").from,
      branchById(r.config, "p2").to,
    ]).toEqual(["n2", "n11"]);
  });

  it("falls back to the trailing-int bump when no member id appears in the label", () => {
    const config = labelBase();
    nodeById(config, "n1").label = "Segment 1";
    branchById(config, "seg1").label = "Segment 1";
    solidById(config, "wall1").label = "Wall 1";
    const r = repeatUnit(config, LABEL_OPTIONS);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // None of n1 / wall1 / seg1 / conv1 appear as tokens in these labels.
    expect(nodeById(r.config, "n2").label).toBe("Segment 2");
    expect(branchById(r.config, "seg3").label).toBe("Segment 2"); // seam clone
    expect(solidById(r.config, "wall2").label).toBe("Wall 2");
  });

  it("keeps undefined labels undefined", () => {
    const r = repeatUnit(labelBase(), LABEL_OPTIONS);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(nodeById(r.config, "n2").label).toBeUndefined();
    expect(solidById(r.config, "wall2").label).toBeUndefined();
    expect(branchById(r.config, "seg3").label).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/* Crossing conductors                                                 */
/* ------------------------------------------------------------------ */

describe('crossingConductors: "share"', () => {
  it("clones crossing conductors so every instance ties to the SAME external node", () => {
    const config: NetworkConfig = {
      meta: { name: "sh", version: 2 },
      settings: { mode: "steady", tolerance: 1e-8, maxIterations: 100 },
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
        { id: "n1", type: "internal", x: 1, y: 0, volume: 1e-3 },
        {
          id: "b",
          type: "boundary",
          x: 2,
          y: 0,
          pressure: 1e5,
          temperature: 300,
        },
      ],
      solidNodes: [
        {
          id: "wall1",
          type: "solid",
          x: 1,
          y: 1,
          temperature: 350,
          mass: 2,
          cp: 385,
        },
        { id: "amb", type: "ambient", x: 0, y: 1, temperature: 290 },
      ],
      branches: [
        { id: "seg1", from: "a", to: "n1", component: { ...PIPE } },
        { id: "seg2", from: "n1", to: "b", component: { ...PIPE } },
      ],
      conductors: [
        {
          id: "conv1",
          from: "wall1",
          to: "n1",
          type: {
            kind: "convection",
            area: 0.01,
            correlation: { model: "dittusBoelter", diameter: 0.05 },
          },
        },
        {
          id: "cx",
          from: "wall1",
          to: "amb",
          type: { kind: "conduction", k: 200, area: 0.01, length: 0.05 },
        },
      ],
    };
    const r = repeatUnit(config, {
      members: { nodes: ["n1"], solidNodes: ["wall1"] },
      seamBranch: "seg1",
      count: 3,
      linkParams: false,
      canvasOffset: { x: 10, y: 0 },
      crossingConductors: "share",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const got = r.config;

    // N tubes → ONE ambient: each instance's crossing clone keeps the
    // external endpoint; only the member endpoint is remapped.
    const cx2 = conductorById(got, "cx_2");
    expect([cx2.from, cx2.to]).toEqual(["wall2", "amb"]);
    const cx3 = conductorById(got, "cx_3");
    expect([cx3.from, cx3.to]).toEqual(["wall3", "amb"]);
    // The template's own crossing conductor is untouched.
    expect([
      conductorById(got, "cx").from,
      conductorById(got, "cx").to,
    ]).toEqual(["wall1", "amb"]);
    // Induced conductors still clone per instance with both ends remapped.
    expect([
      conductorById(got, "conv2").from,
      conductorById(got, "conv2").to,
    ]).toEqual(["wall2", "n2"]);
    expect([
      conductorById(got, "conv3").from,
      conductorById(got, "conv3").to,
    ]).toEqual(["wall3", "n3"]);
    expect(got.conductors).toHaveLength(6);
  });
});

/* ------------------------------------------------------------------ */
/* Exit-node inference                                                 */
/* ------------------------------------------------------------------ */

describe("exit-node inference", () => {
  it("(a) derives the exit node from a single exit crossing", () => {
    const a = analyzeRepeatUnit(oneSegment(), {
      nodes: ["n1"],
      solidNodes: [],
    });
    expect(a).toMatchObject({
      ok: true,
      seamBranch: "seg1",
      exitNode: "n1",
      exitError: null,
    });
  });

  it("(b) falls back to the unique sink when there is no exit crossing", () => {
    const config: NetworkConfig = {
      meta: { name: "sink", version: 2 },
      settings: { mode: "steady", tolerance: 1e-8, maxIterations: 100 },
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
        { id: "n1", type: "internal", x: 1, y: 0, volume: 1e-3 },
        { id: "n2", type: "internal", x: 2, y: 0, volume: 1e-3 },
      ],
      branches: [
        { id: "seg1", from: "a", to: "n1", component: { ...PIPE } },
        { id: "p1", from: "n1", to: "n2", component: { ...PIPE } },
      ],
    };
    const analysis = analyzeRepeatUnit(config, {
      nodes: ["n1", "n2"],
      solidNodes: [],
    });
    expect(analysis).toMatchObject({
      ok: true,
      exitNode: "n2",
      exitError: null,
    });

    const opts: RepeatOptions = {
      members: { nodes: ["n1", "n2"], solidNodes: [] },
      seamBranch: "seg1",
      count: 3,
      linkParams: false,
      canvasOffset: { x: 10, y: 0 },
      crossingConductors: "drop",
    };
    const r = repeatUnit(config, opts);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // The chain still forms: each seam clone leaves from the previous
    // instance's sink (n2), even with nothing to rewire downstream.
    const wiring = r.config.branches.map((b) => `${b.id}:${b.from}->${b.to}`);
    expect(wiring).toEqual([
      "seg1:a->n1",
      "p1:n1->n2",
      "p2:n3->n4",
      "seg2:n2->n3",
      "p3:n5->n6",
      "seg3:n4->n5",
    ]);
    expectAllInstancesFed(r.config, opts, r.instances);
  });

  it("(c) errors when the sink is ambiguous", () => {
    const config: NetworkConfig = {
      meta: { name: "amb", version: 2 },
      settings: { mode: "steady", tolerance: 1e-8, maxIterations: 100 },
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
        { id: "n1", type: "internal", x: 1, y: 0, volume: 1e-3 },
        { id: "n2", type: "internal", x: 2, y: 0, volume: 1e-3 },
      ],
      branches: [
        { id: "seg1", from: "a", to: "n1", component: { ...PIPE } },
        // No induced branch: n1 and n2 are both sinks.
      ],
    };
    const analysis = analyzeRepeatUnit(config, {
      nodes: ["n1", "n2"],
      solidNodes: [],
    });
    expect(analysis).toMatchObject({
      ok: true,
      exitNode: null,
      exitError:
        "cannot determine the unit's exit node: ambiguous candidates n1, n2",
    });
    const r = repeatUnit(config, {
      members: { nodes: ["n1", "n2"], solidNodes: [] },
      seamBranch: "seg1",
      count: 2,
      linkParams: false,
      canvasOffset: { x: 10, y: 0 },
      crossingConductors: "drop",
    });
    expect(r).toEqual({
      ok: false,
      error:
        "cannot determine the unit's exit node: ambiguous candidates n1, n2",
    });
  });
});

/* ------------------------------------------------------------------ */
/* Seam validation                                                     */
/* ------------------------------------------------------------------ */

describe("seam validation", () => {
  it("reports zero entry crossings", () => {
    const config: NetworkConfig = {
      meta: { name: "iso", version: 2 },
      settings: { mode: "steady", tolerance: 1e-8, maxIterations: 100 },
      fluid: { model: "incompressible", preset: "water" },
      nodes: [
        { id: "n1", type: "internal", x: 1, y: 0, volume: 1e-3 },
        { id: "n2", type: "internal", x: 2, y: 0, volume: 1e-3 },
      ],
      branches: [{ id: "p1", from: "n1", to: "n2", component: { ...PIPE } }],
    };
    const analysis = analyzeRepeatUnit(config, {
      nodes: ["n1"],
      solidNodes: [],
    });
    expect(analysis).toMatchObject({
      ok: true,
      seamBranch: null,
      seamError: "no branch enters the unit",
    });
    const r = repeatUnit(config, {
      members: { nodes: ["n1"], solidNodes: [] },
      seamBranch: "p1", // induced, not an entry crossing
      count: 2,
      linkParams: false,
      canvasOffset: { x: 10, y: 0 },
      crossingConductors: "drop",
    });
    expect(r).toEqual({
      ok: false,
      error:
        "seam branch 'p1' is not a branch entering the unit (entry crossings: none — no branch enters the unit)",
    });
  });

  it("reports multiple entry crossings and accepts an explicit seam among them", () => {
    const config: NetworkConfig = {
      meta: { name: "multi-entry", version: 2 },
      settings: { mode: "steady", tolerance: 1e-8, maxIterations: 100 },
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
          id: "c",
          type: "boundary",
          x: 0,
          y: 2,
          pressure: 2e5,
          temperature: 300,
        },
        { id: "n1", type: "internal", x: 1, y: 0, volume: 1e-3 },
        {
          id: "b",
          type: "boundary",
          x: 3,
          y: 0,
          pressure: 1e5,
          temperature: 300,
        },
      ],
      branches: [
        { id: "seg1", from: "a", to: "n1", component: { ...PIPE } },
        { id: "segB", from: "c", to: "n1", component: { ...PIPE } },
        { id: "seg2", from: "n1", to: "b", component: { ...PIPE } },
      ],
    };
    const analysis = analyzeRepeatUnit(config, {
      nodes: ["n1"],
      solidNodes: [],
    });
    expect(analysis).toMatchObject({
      ok: true,
      entryCrossings: ["seg1", "segB"],
      seamBranch: null,
      seamError:
        "multiple branches enter the unit: seg1, segB — pass seamBranch explicitly",
    });

    const r = repeatUnit(config, {
      members: { nodes: ["n1"], solidNodes: [] },
      seamBranch: "segB",
      count: 2,
      linkParams: false,
      canvasOffset: { x: 10, y: 0 },
      crossingConductors: "drop",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Only the seam is chained; the other entry crossing stays on instance 1.
    const seamClone = branchById(r.config, "segB_2");
    expect([seamClone.from, seamClone.to]).toEqual(["n1", "n2"]);
    expect([
      branchById(r.config, "seg1").from,
      branchById(r.config, "seg1").to,
    ]).toEqual(["a", "n1"]);
    expect(branchById(r.config, "seg2").from).toBe("n2");
  });

  it("rejects an explicit seamBranch that is not an entry crossing", () => {
    const r = repeatUnit(oneSegment(), {
      members: { nodes: ["n1"], solidNodes: [] },
      seamBranch: "seg2", // the EXIT crossing
      count: 2,
      linkParams: false,
      canvasOffset: { x: 10, y: 0 },
      crossingConductors: "drop",
    });
    expect(r).toEqual({
      ok: false,
      error:
        "seam branch 'seg2' is not a branch entering the unit (entry crossings: seg1)",
    });
    const unknown = repeatUnit(oneSegment(), {
      members: { nodes: ["n1"], solidNodes: [] },
      seamBranch: "ghost",
      count: 2,
      linkParams: false,
      canvasOffset: { x: 10, y: 0 },
      crossingConductors: "drop",
    });
    expect(unknown.ok).toBe(false);
    if (unknown.ok) return;
    expect(unknown.error).toContain("seam branch 'ghost'");
  });
});

/* ------------------------------------------------------------------ */
/* count + member validation                                           */
/* ------------------------------------------------------------------ */

describe("count validation", () => {
  const base = () => oneSegment();
  const opts = (count: number): RepeatOptions => ({
    members: { nodes: ["n1"], solidNodes: [] },
    seamBranch: "seg1",
    count,
    linkParams: false,
    canvasOffset: { x: 0, y: 0 },
    crossingConductors: "drop",
  });

  it("rejects 0, negative and non-integer counts", () => {
    for (const bad of [0, -1, 2.5, NaN]) {
      const r = repeatUnit(base(), opts(bad));
      expect(r.ok).toBe(false);
      if (r.ok) continue;
      expect(r.error).toBe(
        `count must be a positive integer (got ${String(bad)})`,
      );
    }
  });

  it("count: 1 is a strict no-op (and needs no valid seam)", () => {
    const config = base();
    const r = repeatUnit(config, { ...opts(1), seamBranch: "bogus" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.config).toEqual(config); // unchanged contents
    expect(r.config).not.toBe(config); // …but still an independent clone
    expect(r.created).toEqual({
      nodes: [],
      solidNodes: [],
      branches: [],
      conductors: [],
    });
    expect(r.instances).toEqual([]);
  });
});

describe("member validation", () => {
  const config = oneSegment();
  const run = (members: RepeatOptions["members"]) =>
    repeatUnit(config, {
      members,
      seamBranch: "seg1",
      count: 2,
      linkParams: false,
      canvasOffset: { x: 0, y: 0 },
      crossingConductors: "drop",
    });

  it("rejects an empty unit", () => {
    expect(run({ nodes: [], solidNodes: [] })).toEqual({
      ok: false,
      error: "no member ids given — the unit is empty",
    });
  });

  it("rejects unknown fluid and solid member ids", () => {
    expect(run({ nodes: ["nope"], solidNodes: [] })).toEqual({
      ok: false,
      error: "unknown fluid node member id(s): nope",
    });
    expect(run({ nodes: ["n1"], solidNodes: ["nope"] })).toEqual({
      ok: false,
      error: "unknown solid node member id(s): nope",
    });
  });

  it("rejects duplicate member ids", () => {
    expect(run({ nodes: ["n1", "n1"], solidNodes: [] })).toEqual({
      ok: false,
      error: "duplicate member id 'n1'",
    });
  });
});

/* ------------------------------------------------------------------ */
/* Multi-node unit                                                     */
/* ------------------------------------------------------------------ */

describe("multi-node unit", () => {
  it("chains a two-node unit 3×, cloning the induced branch per instance", () => {
    const config: NetworkConfig = {
      meta: { name: "multi", version: 2 },
      settings: { mode: "steady", tolerance: 1e-8, maxIterations: 100 },
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
          id: "n1",
          type: "internal",
          x: 1,
          y: 0,
          volume: 1e-3,
          pressure: 1.5e5,
          temperature: 300,
        },
        {
          id: "n2",
          type: "internal",
          x: 2,
          y: 0,
          volume: 1e-3,
          pressure: 1.2e5,
          temperature: 300,
        },
        {
          id: "b",
          type: "boundary",
          x: 3,
          y: 0,
          pressure: 1e5,
          temperature: 300,
        },
      ],
      branches: [
        { id: "seg1", from: "a", to: "n1", component: { ...PIPE } },
        { id: "p1", from: "n1", to: "n2", component: { ...PIPE } },
        { id: "seg2", from: "n2", to: "b", component: { ...PIPE } },
      ],
    };
    const opts: RepeatOptions = {
      members: { nodes: ["n1", "n2"], solidNodes: [] },
      seamBranch: "seg1",
      count: 3,
      linkParams: false,
      canvasOffset: { x: 10, y: 0 },
      crossingConductors: "drop",
    };
    const r = repeatUnit(config, opts);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    // Member ids n1/n2 collide with each other's bumps, so allocation walks
    // upward: instance 2 → n3/n4, instance 3 → n5/n6; the induced branch
    // p1 is cloned per instance (p2, p3) and the seam clones skip the taken
    // seg2 (seg3, seg4).
    expect(r.created).toEqual({
      nodes: ["n3", "n4", "n5", "n6"],
      solidNodes: [],
      branches: ["p2", "seg3", "p3", "seg4"],
      conductors: [],
    });
    expect(r.instances).toEqual([
      ["n3", "n4", "p2", "seg3"],
      ["n5", "n6", "p3", "seg4"],
    ]);

    const wiring = Object.fromEntries(
      r.config.branches.map((b) => [b.id, [b.from, b.to]]),
    );
    expect(wiring).toEqual({
      seg1: ["a", "n1"],
      p1: ["n1", "n2"],
      seg2: ["n6", "b"], // exit crossing rewired to the last instance
      p2: ["n3", "n4"],
      seg3: ["n2", "n3"],
      p3: ["n5", "n6"],
      seg4: ["n4", "n5"],
    });
    expectAllInstancesFed(r.config, opts, r.instances);
    expect(validateNetwork(r.config)).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* Solid-only unit                                                     */
/* ------------------------------------------------------------------ */

describe("solid-only unit (nodes: [])", () => {
  function solidBase(): NetworkConfig {
    return {
      meta: { name: "solids", version: 2 },
      settings: { mode: "steady", tolerance: 1e-8, maxIterations: 100 },
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
          x: 2,
          y: 0,
          pressure: 1e5,
          temperature: 300,
        },
      ],
      branches: [{ id: "seg1", from: "a", to: "b", component: { ...PIPE } }],
      solidNodes: [
        {
          id: "wall1",
          type: "solid",
          x: 1,
          y: 1,
          temperature: 350,
          mass: 2,
          cp: 385,
        },
        {
          id: "wall2",
          type: "solid",
          x: 1.5,
          y: 1,
          temperature: 340,
          mass: 1,
          cp: 385,
        },
        { id: "amb", type: "ambient", x: 0, y: 1, temperature: 290 },
      ],
      conductors: [
        {
          id: "c1",
          from: "wall1",
          to: "wall2",
          type: { kind: "conduction", k: 200, area: 0.01, length: 0.05 },
        },
        {
          id: "c2",
          from: "wall2",
          to: "amb",
          type: { kind: "conduction", k: 200, area: 0.01, length: 0.05 },
        },
      ],
    };
  }
  const SOLID_MEMBERS = { nodes: [], solidNodes: ["wall1", "wall2"] };

  it("has no derivable seam or exit node (analysis reports both)", () => {
    const a = analyzeRepeatUnit(solidBase(), SOLID_MEMBERS);
    expect(a).toEqual({
      ok: true,
      inducedBranches: [],
      inducedConductors: ["c1"],
      entryCrossings: [],
      exitCrossings: [],
      crossingConductors: ["c2"],
      seamBranch: null,
      seamError: "no branch enters the unit",
      exitNode: null,
      exitError:
        "cannot determine the unit's exit node: no exit crossing and every fluid member has an outgoing internal branch",
    });
  });

  it("repeats fine in Duplicate mode (seamBranch: null)", () => {
    const r = repeatUnit(solidBase(), {
      members: SOLID_MEMBERS,
      seamBranch: null,
      count: 3,
      linkParams: false,
      canvasOffset: { x: 30, y: 30 },
      crossingConductors: "share", // ignored without a seam: crossings drop
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const got = r.config;

    // wall2 the member id collides with wall1's bump, so instance 2 lands on
    // wall3/wall4; c2 the crossing conductor blocks c1's first bump → c3, c4.
    expect(r.created).toEqual({
      nodes: [],
      solidNodes: ["wall3", "wall4", "wall5", "wall6"],
      branches: [],
      conductors: ["c3", "c4"],
    });
    expect(got.solidNodes).toHaveLength(7);
    expect(solidById(got, "wall3").x).toBe(31);
    expect(solidById(got, "wall4").x).toBe(31.5);
    // The induced conduction conductor is cloned per instance, remapped.
    expect([
      conductorById(got, "c3").from,
      conductorById(got, "c3").to,
    ]).toEqual(["wall3", "wall4"]);
    expect([
      conductorById(got, "c4").from,
      conductorById(got, "c4").to,
    ]).toEqual(["wall5", "wall6"]);
    // The crossing conductor c2 is NOT cloned (Duplicate drops crossings).
    expect(got.conductors).toHaveLength(4);
    expect(validateNetwork(got)).toEqual([]);
  });

  it("cannot chain a solid-only unit (no entry crossing exists)", () => {
    const r = repeatUnit(solidBase(), {
      members: SOLID_MEMBERS,
      seamBranch: "seg1",
      count: 2,
      linkParams: false,
      canvasOffset: { x: 30, y: 30 },
      crossingConductors: "drop",
    });
    expect(r).toEqual({
      ok: false,
      error:
        "seam branch 'seg1' is not a branch entering the unit (entry crossings: none — no branch enters the unit)",
    });
  });
});

/* ------------------------------------------------------------------ */
/* Exit crossings leaving from DIFFERENT member nodes (B1)             */
/* ------------------------------------------------------------------ */

describe("exit crossings from different member nodes", () => {
  /**
   * src --feed--> n1 --p1--> n2 --out--> sink, plus a SIDE TAP tapb:
   * n1 → tap leaving from n1.  The two exit crossings leave from DIFFERENT
   * members, so the exit node comes from the unique-sink rule (n2).  Only
   * 'out' may be rewired to the last instance; 'tapb' describes instance
   * 1's side tap and must stay on n1 — the bug being pinned here migrated
   * it to the end of the chain.
   */
  function sideTapBase(): NetworkConfig {
    return {
      meta: { name: "side-tap", version: 2 },
      settings: { mode: "steady", tolerance: 1e-8, maxIterations: 100 },
      fluid: { model: "incompressible", preset: "water" },
      nodes: [
        {
          id: "src",
          type: "boundary",
          x: 0,
          y: 0,
          pressure: 2e5,
          temperature: 300,
        },
        { id: "n1", type: "internal", x: 1, y: 0, volume: 1e-3 },
        { id: "n2", type: "internal", x: 2, y: 0, volume: 1e-3 },
        {
          id: "tap",
          type: "boundary",
          x: 1,
          y: 1,
          pressure: 1.2e5,
          temperature: 300,
        },
        {
          id: "sink",
          type: "boundary",
          x: 3,
          y: 0,
          pressure: 1e5,
          temperature: 300,
        },
      ],
      branches: [
        { id: "feed", from: "src", to: "n1", component: { ...PIPE } },
        { id: "p1", from: "n1", to: "n2", component: { ...PIPE } },
        { id: "tapb", from: "n1", to: "tap", component: { ...PIPE } },
        { id: "out", from: "n2", to: "sink", component: { ...PIPE } },
      ],
    };
  }

  const SIDE_TAP_OPTIONS: RepeatOptions = {
    members: { nodes: ["n1", "n2"], solidNodes: [] },
    seamBranch: "feed",
    count: 3,
    linkParams: false,
    canvasOffset: { x: 10, y: 0 },
    crossingConductors: "drop",
  };

  it("analysis: exit node from the unique-sink rule, both crossings listed", () => {
    const a = analyzeRepeatUnit(sideTapBase(), SIDE_TAP_OPTIONS.members);
    expect(a).toMatchObject({
      ok: true,
      seamBranch: "feed",
      exitCrossings: ["tapb", "out"],
      exitNode: "n2",
      exitError: null,
    });
  });

  it("rewires ONLY the crossing leaving from the exit node; the side tap stays on instance 1", () => {
    const r = repeatUnit(sideTapBase(), SIDE_TAP_OPTIONS);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const got = r.config;

    // Instances: n1/n2 → n3/n4 → n5/n6 (allocation walks past collisions).
    // The outflow crossing follows the chain to the LAST instance's n2…
    expect([branchById(got, "out").from, branchById(got, "out").to]).toEqual([
      "n6",
      "sink",
    ]);
    // …but the side tap left from n1 — a DIFFERENT member — so it stays
    // attached to instance 1, and it is still the ONLY branch feeding tap.
    expect([branchById(got, "tapb").from, branchById(got, "tapb").to]).toEqual([
      "n1",
      "tap",
    ]);
    expect(got.branches.filter((b) => b.to === "tap").map((b) => b.id)).toEqual(
      ["tapb"],
    );
    // The seam chain itself is intact.
    expect([
      branchById(got, "feed_2").from,
      branchById(got, "feed_2").to,
    ]).toEqual(["n2", "n3"]);
    expect([
      branchById(got, "feed_3").from,
      branchById(got, "feed_3").to,
    ]).toEqual(["n4", "n5"]);

    expectAllInstancesFed(got, SIDE_TAP_OPTIONS, r.instances);
    expect(validateNetwork(got)).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* Boundary fluid members (B2)                                         */
/* ------------------------------------------------------------------ */

describe("boundary fluid members", () => {
  /**
   * src --feed--> n1 --out--> sink with the unit {n1, sink}: 'out' is an
   * INDUCED branch (both endpoints members), 'feed' the entry crossing, and
   * the unique sink — hence the exit node — is the boundary node itself.
   */
  function boundaryUnit(): NetworkConfig {
    return {
      meta: { name: "boundary-unit", version: 2 },
      settings: { mode: "steady", tolerance: 1e-8, maxIterations: 100 },
      fluid: { model: "incompressible", preset: "water" },
      nodes: [
        {
          id: "src",
          type: "boundary",
          x: 0,
          y: 0,
          pressure: 2e5,
          temperature: 300,
        },
        { id: "n1", type: "internal", x: 1, y: 0, volume: 1e-3 },
        {
          id: "sink",
          type: "boundary",
          x: 2,
          y: 0,
          pressure: 1e5,
          temperature: 300,
        },
      ],
      branches: [
        { id: "feed", from: "src", to: "n1", component: { ...PIPE } },
        { id: "out", from: "n1", to: "sink", component: { ...PIPE } },
      ],
    };
  }
  const MEMBERS = { nodes: ["n1", "sink"], solidNodes: [] };

  it("Repeat (seam set) rejects a unit containing a boundary node, naming it", () => {
    const r = repeatUnit(boundaryUnit(), {
      members: MEMBERS,
      seamBranch: "feed",
      count: 2,
      linkParams: false,
      canvasOffset: { x: 10, y: 0 },
      crossingConductors: "drop",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("boundary");
    expect(r.error).toContain("sink");
  });

  it("Duplicate (seamBranch: null) still copies the boundary node", () => {
    const r = repeatUnit(boundaryUnit(), {
      members: MEMBERS,
      seamBranch: null,
      count: 2,
      linkParams: false,
      canvasOffset: { x: 10, y: 10 },
      crossingConductors: "drop",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // n1 → n2, sink → sink_2 (boundary copies are still fluid nodes), and
    // the induced branch out → out_2 remapped onto the copies; the crossing
    // 'feed' is dropped (Duplicate).
    expect(r.created).toEqual({
      nodes: ["n2", "sink_2"],
      solidNodes: [],
      branches: ["out_2"],
      conductors: [],
    });
    const copy = nodeById(r.config, "sink_2");
    expect(copy.type).toBe("boundary");
    expect(copy.pressure).toBe(1e5);
    expect([
      branchById(r.config, "out_2").from,
      branchById(r.config, "out_2").to,
    ]).toEqual(["n2", "sink_2"]);
    expect(validateNetwork(r.config)).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* Cross-namespace id collisions (S1)                                  */
/* ------------------------------------------------------------------ */

describe("cross-namespace id collisions", () => {
  /**
   * a --in1--> x --x--> y --out1--> b: the induced branch 'x' shares its id
   * with the member fluid node 'x'.  Ids are unique only PER KIND, but the
   * per-instance id map keys by plain id across every accessor, so one
   * entry would overwrite the other — reject instead.
   */
  function collidingBase(): NetworkConfig {
    return {
      meta: { name: "collide", version: 2 },
      settings: { mode: "steady", tolerance: 1e-8, maxIterations: 100 },
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
        { id: "x", type: "internal", x: 1, y: 0, volume: 1e-3 },
        { id: "y", type: "internal", x: 2, y: 0, volume: 1e-3 },
        {
          id: "b",
          type: "boundary",
          x: 3,
          y: 0,
          pressure: 1e5,
          temperature: 300,
        },
      ],
      branches: [
        { id: "in1", from: "a", to: "x", component: { ...PIPE } },
        { id: "x", from: "x", to: "y", component: { ...PIPE } },
        { id: "out1", from: "y", to: "b", component: { ...PIPE } },
      ],
    };
  }
  const MEMBERS = { nodes: ["x", "y"], solidNodes: [] };

  it("analyzeRepeatUnit rejects, naming the id and both kinds", () => {
    const a = analyzeRepeatUnit(collidingBase(), MEMBERS);
    expect(a.ok).toBe(false);
    if (a.ok) return;
    expect(a.error).toContain("'x'");
    expect(a.error).toContain("fluid node");
    expect(a.error).toContain("branch");
  });

  it("repeatUnit rejects in Repeat AND Duplicate modes (the map hazard is mode-independent)", () => {
    const base = {
      members: MEMBERS,
      count: 2,
      linkParams: false,
      canvasOffset: { x: 10, y: 0 },
      crossingConductors: "drop" as const,
    };
    const chained = repeatUnit(collidingBase(), { ...base, seamBranch: "in1" });
    expect(chained.ok).toBe(false);
    if (!chained.ok) {
      expect(chained.error).toContain("'x'");
    }
    const duplicated = repeatUnit(collidingBase(), {
      ...base,
      seamBranch: null,
    });
    expect(duplicated.ok).toBe(false);
    if (!duplicated.ok) {
      expect(duplicated.error).toContain("'x'");
    }
  });

  it("a seam branch id colliding with a member node id is rejected too", () => {
    // Rename the ENTRY branch to 'x': it joins the id map as the seam
    // clone, so the same overwrite hazard applies even though 'x' the
    // branch is not induced.
    const config = collidingBase();
    config.branches[0]!.id = "x"; // seam candidate 'x', node 'x' a member
    config.branches[1]!.id = "p1"; // induced branch no longer collides
    const r = repeatUnit(config, {
      members: MEMBERS,
      seamBranch: "x",
      count: 2,
      linkParams: false,
      canvasOffset: { x: 10, y: 0 },
      crossingConductors: "drop",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("seam");
      expect(r.error).toContain("'x'");
    }
  });
});

/* ------------------------------------------------------------------ */
/* Members unreachable from the seam target (S2)                       */
/* ------------------------------------------------------------------ */

describe("members unreachable from the seam target", () => {
  /**
   * src --seam--> y, with the induced branch xy: x → y running UPSTREAM-to-
   * downstream of the seam target and the exit crossing exit: x → sink
   * leaving from x.  The exit-node rule picks x (all exit crossings leave
   * from it), but x is NOT reachable from the seam's target y, so instance
   * copies of x would have no inflow at all — orphaned nodes.
   */
  function backfedBase(): NetworkConfig {
    return {
      meta: { name: "backfed", version: 2 },
      settings: { mode: "steady", tolerance: 1e-8, maxIterations: 100 },
      fluid: { model: "incompressible", preset: "water" },
      nodes: [
        {
          id: "src",
          type: "boundary",
          x: 0,
          y: 0,
          pressure: 2e5,
          temperature: 300,
        },
        { id: "x", type: "internal", x: 1, y: 0, volume: 1e-3 },
        { id: "y", type: "internal", x: 2, y: 0, volume: 1e-3 },
        {
          id: "sink",
          type: "boundary",
          x: 3,
          y: 0,
          pressure: 1e5,
          temperature: 300,
        },
      ],
      branches: [
        { id: "seam", from: "src", to: "y", component: { ...PIPE } },
        { id: "xy", from: "x", to: "y", component: { ...PIPE } },
        { id: "exit", from: "x", to: "sink", component: { ...PIPE } },
      ],
    };
  }

  it("rejects, naming the unreachable member and the seam target", () => {
    const r = repeatUnit(backfedBase(), {
      members: { nodes: ["x", "y"], solidNodes: [] },
      seamBranch: "seam",
      count: 2,
      linkParams: false,
      canvasOffset: { x: 10, y: 0 },
      crossingConductors: "drop",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("'x'");
    expect(r.error).toContain("'y'");
    expect(r.error).toContain("not reachable");
    expect(r.error).toContain("no inflow");
  });
});
