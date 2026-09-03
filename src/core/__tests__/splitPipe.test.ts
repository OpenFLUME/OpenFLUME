/**
 * splitPipeBranch — split one pipe/heatedPipe branch into N series segments
 * of equal length with N−1 new internal nodes, preserving total length (and
 * total elevationChange, and total heatedPipe ua — all EXTENSIVE).  A thin
 * wrapper over repeatUnit (repeat.ts): one
 * mid-node + seam pipe are inserted by hand, then the {mid-node} unit is
 * repeated N−1 times.  There is deliberately no second algorithm — these
 * tests pin the wrapper's physics equivalence, its structural contract, and
 * its error surface.
 *
 * HEADLINE — physics equivalence.  A single pipe between two pressure
 * boundaries is solved with solveSteady, split into 10 segments, and solved
 * again.  The pipe closure (core/components/pipe.ts) is
 *   ΔP = f·(L/D)·ρ·v|v|/2 + ρ·g·Δz
 * — LINEAR in L and Δz at fixed (f, ρ, v, D).  With incompressible water at
 * fixed boundary pressures, ρ is constant and the series chain enforces one
 * mdot, so v, Re and therefore f are identical in every segment: the sum of
 * segment drops telescopes to exactly the one-pipe drop.  Splitting is thus
 * NOT a discretization change for this model — there are no per-segment
 * minor-loss or momentum terms (settings.momentumFlux defaults off) — so the
 * two solves must agree to solver noise, not to some O(1/N) error.  The
 * asserted relative tolerance is 1e-9: equal to the solver's own convergence
 * tolerance, ~7 orders above the observed roundoff-level discrepancy
 * (~1e-16, pure floating-point summation order), yet ~9 orders tighter than
 * any genuine per-segment-loss bug would be (a spurious per-segment K factor
 * is an O(1) relative effect — it adds N× the minor loss).
 */
import { describe, it, expect } from "vitest";
import type { Conductor, NetworkConfig } from "../schema";
import { splitPipeBranch } from "../repeat";
import {
  isParameterExpression,
  resolveNetworkParameters,
} from "../paramBindings";
import { validateNetwork } from "../validate";
import { solveSteady } from "../solver";

type FluidNode = NetworkConfig["nodes"][number];
type Branch = NetworkConfig["branches"][number];

const branchById = (config: NetworkConfig, id: string): Branch =>
  config.branches.find((b) => b.id === id)!;
const nodeById = (config: NetworkConfig, id: string): FluidNode =>
  config.nodes.find((n) => n.id === id)!;
const conductorById = (config: NetworkConfig, id: string): Conductor =>
  (config.conductors ?? []).find((c) => c.id === id)!;

/** Component fields of a branch, as a plain record (pipe or heatedPipe). */
function componentFields(
  config: NetworkConfig,
  id: string,
): Record<string, unknown> {
  return branchById(config, id).component as unknown as Record<string, unknown>;
}

const relDiff = (a: number, b: number): number => Math.abs(a - b) / Math.abs(b);

/** Justified headline tolerance — see the file header. */
const EQUIV_TOL = 1e-9;

const P_IN = 2e5;
const P_OUT = 1e5;
const LENGTH = 1;
const DIAMETER = 0.05;

/**
 * The headline fixture: boundary inlet (fixed P, T) → ONE pipe → boundary
 * outlet (fixed P, T), incompressible water — fast and deterministic.
 */
function pressureLine(): NetworkConfig {
  return {
    meta: { name: "line", version: 2 },
    settings: {
      mode: "steady",
      tolerance: 1e-9,
      maxIterations: 200,
      relaxation: 1.0,
    },
    fluid: { model: "incompressible", preset: "water" },
    nodes: [
      {
        id: "inlet",
        type: "boundary",
        x: 0,
        y: 0,
        pressure: P_IN,
        temperature: 300,
      },
      {
        id: "outlet",
        type: "boundary",
        x: 100,
        y: 0,
        pressure: P_OUT,
        temperature: 300,
      },
    ],
    branches: [
      {
        id: "main",
        from: "inlet",
        to: "outlet",
        component: {
          type: "pipe",
          length: LENGTH,
          diameter: DIAMETER,
          roughness: 1e-5,
        },
      },
    ],
  };
}

function split(config: NetworkConfig, branchId: string, segments: number) {
  const r = splitPipeBranch(config, branchId, segments);
  if (!r.ok) throw new Error(`splitPipeBranch failed: ${r.error}`);
  return r;
}

/* ------------------------------------------------------------------ */
/* HEADLINE — physics equivalence under 10-way split                   */
/* ------------------------------------------------------------------ */

describe("physics equivalence: one pipe vs ten segments (steady solve)", () => {
  it("mass flow and total pressure drop agree to solver tolerance", () => {
    const base = pressureLine();
    const unsplit = solveSteady(base);
    expect(unsplit.converged).toBe(true);

    const { config: got, created } = split(base, "main", 10);
    expect(validateNetwork(got)).toEqual([]);
    const resplit = solveSteady(got);
    expect(resplit.converged).toBe(true);

    // Structure: 10 pipes (the seam clones main_seg1..9 + the original
    // branch as the LAST segment), 9 new internal nodes m1..m9.
    expect(
      got.branches.filter((b) => b.component.type === "pipe"),
    ).toHaveLength(10);
    expect(got.nodes.filter((n) => n.type === "internal")).toHaveLength(9);
    expect(created.nodes).toEqual(
      Array.from({ length: 9 }, (_, k) => `m${k + 1}`),
    );
    expect(created.branches).toEqual(
      Array.from({ length: 9 }, (_, k) => `main_seg${k + 1}`),
    );

    // Mass flow: identical to relative 1e-9 (justified in the header).
    expect(
      relDiff(resplit.branches.main.mdot, unsplit.branches.main.mdot),
    ).toBeLessThan(EQUIV_TOL);
    for (const b of got.branches) {
      // Series chain: every segment carries the same mass flow.
      expect(
        relDiff(resplit.branches[b.id].mdot, unsplit.branches.main.mdot),
      ).toBeLessThan(EQUIV_TOL);
    }

    // Total pressure drop: sum of the ten segment drops telescopes to the
    // one-pipe drop (and to the imposed boundary difference P_IN − P_OUT).
    const sumDp = got.branches.reduce(
      (acc, b) => acc + resplit.branches[b.id].dP,
      0,
    );
    expect(relDiff(sumDp, unsplit.branches.main.dP)).toBeLessThan(EQUIV_TOL);
    expect(relDiff(unsplit.branches.main.dP, P_IN - P_OUT)).toBeLessThan(
      EQUIV_TOL,
    );

    // The drop divides UNIFORMLY: each segment loses (P_IN−P_OUT)/10, so the
    // new node pressures lie exactly on the linear inlet→outlet profile.
    for (const b of got.branches) {
      expect(
        relDiff(resplit.branches[b.id].dP, (P_IN - P_OUT) / 10),
      ).toBeLessThan(EQUIV_TOL);
    }
    for (let k = 1; k <= 9; k++) {
      const want = P_IN - ((P_IN - P_OUT) / 10) * k;
      expect(relDiff(resplit.nodes[`m${k}`].pressure, want)).toBeLessThan(
        EQUIV_TOL,
      );
    }

    // Total length is preserved: the ten resolved segments sum to LENGTH.
    const resolved = resolveNetworkParameters(got);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    const totalLength = resolved.config.branches.reduce(
      (acc, b) => acc + (b.component as { length: number }).length,
      0,
    );
    expect(Math.abs(totalLength - LENGTH)).toBeLessThan(1e-12);
  });
});

/* ------------------------------------------------------------------ */
/* Structure                                                           */
/* ------------------------------------------------------------------ */

describe("structure and id allocation", () => {
  it("segments: 2 (minimum) inserts exactly one node and one seam pipe", () => {
    const {
      config: got,
      created,
      instances,
    } = split(pressureLine(), "main", 2);

    expect(created).toEqual({
      nodes: ["m1"],
      solidNodes: [],
      branches: ["main_seg1"],
      conductors: [],
    });
    // count = segments−1 = 1 is repeatUnit's strict no-op: nothing chained.
    expect(instances).toEqual([]);

    // The seam covers inlet → m1; the ORIGINAL branch keeps its id and
    // becomes the last segment m1 → outlet.
    const seam = branchById(got, "main_seg1");
    expect([seam.from, seam.to]).toEqual(["inlet", "m1"]);
    const main = branchById(got, "main");
    expect([main.from, main.to]).toEqual(["m1", "outlet"]);
    expect(componentFields(got, "main").length).toBe(0.5);
    expect(componentFields(got, "main_seg1").length).toBe(0.5);
    expect(validateNetwork(got)).toEqual([]);
  });

  it("skips taken ids: an existing m1 / main_seg1 shift the new ids to m2 / main_seg2", () => {
    const config = pressureLine();
    config.nodes.push({
      id: "m1",
      type: "internal",
      x: 0,
      y: 50,
      volume: 1e-3,
      pressure: 1e5,
      temperature: 300,
    });
    config.branches.push({
      id: "main_seg1",
      from: "m1",
      to: "outlet",
      component: { type: "pipe", length: 1, diameter: 0.05, roughness: 1e-5 },
    });
    const { config: got, created } = split(config, "main", 2);
    expect(created.nodes).toEqual(["m2"]);
    expect(created.branches).toEqual(["main_seg2"]);
    expect([
      branchById(got, "main_seg2").from,
      branchById(got, "main_seg2").to,
    ]).toEqual(["inlet", "m2"]);
    expect(validateNetwork(got)).toEqual([]);
  });

  it("splits a pipe whose length is an {expr}: emits (<orig>) / N and resolves correctly", () => {
    const config = pressureLine();
    (branchById(config, "main").component as { length: unknown }).length = {
      expr: "2 + 1",
    };
    const { config: got } = split(config, "main", 3);

    for (const id of ["main", "main_seg1", "main_seg2"]) {
      expect(componentFields(got, id).length).toEqual({ expr: "(2 + 1) / 3" });
    }
    const resolved = resolveNetworkParameters(got);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    for (const b of resolved.config.branches) {
      expect((b.component as { length: number }).length).toBeCloseTo(1, 12);
    }
  });

  it("divides elevationChange by segments; the split values sum to the original", () => {
    const config = pressureLine();
    (
      branchById(config, "main").component as { elevationChange?: number }
    ).elevationChange = 0.6;
    const { config: got } = split(config, "main", 4);

    let sum = 0;
    for (const b of got.branches) {
      const dz = componentFields(got, b.id).elevationChange;
      expect(dz).toBe(0.6 / 4);
      sum += dz as number;
    }
    expect(Math.abs(sum - 0.6)).toBeLessThan(1e-12);

    // Elevation drop is linear in Δz too: the steady mass flow is unchanged
    // by the split.
    const unsplit = solveSteady(config);
    const resplit = solveSteady(got);
    expect(unsplit.converged && resplit.converged).toBe(true);
    expect(
      relDiff(resplit.branches.main.mdot, unsplit.branches.main.mdot),
    ).toBeLessThan(EQUIV_TOL);
  });
});

/* ------------------------------------------------------------------ */
/* New internal nodes                                                  */
/* ------------------------------------------------------------------ */

describe("inserted internal nodes", () => {
  it("bind each node's volume to its OWN upstream segment and inherit initial P/T", () => {
    const { config: got } = split(pressureLine(), "main", 10);

    for (let k = 1; k <= 9; k++) {
      const node = nodeById(got, `m${k}`);
      // m{k}'s upstream pipe is main_seg{k} (the original 'main' is the
      // LAST segment, downstream of m9 — never an upstream pipe here).
      expect(node.volume).toEqual({
        expr: `pipe('main_seg${k}').volume`,
      });
      // Both endpoints are boundary nodes, so the initial state falls back
      // to the upstream (from) endpoint: the inlet's P and T.
      expect(node.pressure).toBe(P_IN);
      expect(node.temperature).toBe(300);
    }

    // The volume binding resolves to the segment's geometric volume.
    const resolved = resolveNetworkParameters(got);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    const wantVolume = (LENGTH / 10) * (Math.PI / 4) * DIAMETER ** 2;
    for (let k = 1; k <= 9; k++) {
      const v = nodeById(resolved.config, `m${k}`).volume;
      expect(typeof v).toBe("number");
      expect(relDiff(v as number, wantVolume)).toBeLessThan(1e-12);
    }
  });

  it("prefers an internal endpoint for the initial state over a boundary one", () => {
    const config: NetworkConfig = {
      ...pressureLine(),
      nodes: [
        {
          id: "inlet",
          type: "boundary",
          x: 0,
          y: 0,
          pressure: P_IN,
          temperature: 300,
        },
        {
          id: "hub",
          type: "internal",
          x: 50,
          y: 0,
          volume: 1e-3,
          pressure: 1.6e5,
          temperature: 295,
        },
        {
          id: "outlet",
          type: "boundary",
          x: 100,
          y: 0,
          pressure: P_OUT,
          temperature: 300,
        },
      ],
      branches: [
        {
          id: "feed",
          from: "inlet",
          to: "hub",
          component: {
            type: "pipe",
            length: 1,
            diameter: 0.05,
            roughness: 1e-5,
          },
        },
        {
          id: "main",
          from: "hub",
          to: "outlet",
          component: {
            type: "pipe",
            length: 1,
            diameter: 0.05,
            roughness: 1e-5,
          },
        },
      ],
    };
    const { config: got } = split(config, "main", 3);
    for (const id of ["m1", "m2"]) {
      // 'main' runs hub → outlet: the internal hub is the IC source.
      expect(nodeById(got, id).pressure).toBe(1.6e5);
      expect(nodeById(got, id).temperature).toBe(295);
    }
  });
});

/* ------------------------------------------------------------------ */
/* heatedPipe                                                          */
/* ------------------------------------------------------------------ */

describe("heatedPipe support", () => {
  it("divides the extensive fields (length, elevationChange, ua) but copies intensive ones verbatim", () => {
    const config = pressureLine();
    config.branches = [
      {
        id: "hp",
        from: "inlet",
        to: "outlet",
        component: {
          type: "heatedPipe",
          length: 2,
          diameter: 0.05,
          roughness: 1e-5,
          elevationChange: 0.8,
          ua: 25,
          wallTemperature: 350,
        },
      },
    ];
    const { config: got } = split(config, "hp", 4);

    expect(got.branches).toHaveLength(4);
    for (const b of got.branches) {
      const c = componentFields(got, b.id);
      expect(c.type).toBe("heatedPipe");
      expect(c.length).toBe(0.5);
      expect(c.elevationChange).toBe(0.2);
      // ua is EXTENSIVE (U·A ∝ π·D·L): it divides like length so the split
      // preserves the model's total wall heat leak.  wallTemperature,
      // diameter and roughness are intensive and copy verbatim.
      expect(c.ua).toBe(6.25);
      expect(c.wallTemperature).toBe(350);
      expect(c.diameter).toBe(0.05);
      expect(c.roughness).toBe(1e-5);
    }
    // The inserted nodes bind volume through the heatedPipe accessor.
    expect(nodeById(got, "m1").volume).toEqual({
      expr: "heatedPipe('hp_seg1').volume",
    });
    expect(validateNetwork(got)).toEqual([]);
  });

  it("conserves total UA across the split, for numeric and {expr} ua alike", () => {
    const config = pressureLine();
    config.branches = [
      {
        id: "hp",
        from: "inlet",
        to: "outlet",
        component: {
          type: "heatedPipe",
          length: 2,
          diameter: 0.05,
          roughness: 1e-5,
          ua: 25,
          wallTemperature: 350,
        },
      },
    ];
    const { config: got } = split(config, "hp", 4);
    let sum = 0;
    for (const b of got.branches)
      sum += componentFields(got, b.id).ua as number;
    expect(Math.abs(sum - 25)).toBeLessThan(1e-12);

    // {expr} ua becomes "(<orig>) / N" per segment and resolves to the same
    // conserved total.
    (branchById(config, "hp").component as { ua: unknown }).ua = {
      expr: "20 + 5",
    };
    const { config: gotExpr } = split(config, "hp", 4);
    for (const b of gotExpr.branches) {
      expect(componentFields(gotExpr, b.id).ua).toEqual({
        expr: "(20 + 5) / 4",
      });
    }
    const resolved = resolveNetworkParameters(gotExpr);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    let resolvedSum = 0;
    for (const b of resolved.config.branches) {
      resolvedSum += (b.component as { ua: number }).ua;
    }
    expect(Math.abs(resolvedSum - 25)).toBeLessThan(1e-12);
  });

  it("solves to the SAME outlet temperature before and after a 4-way split", () => {
    // The single-phase heat closure is ε-NTU per segment:
    //   T_out = T_wall − (T_wall − T_up)·exp(−UA/(ṁ·cp))
    // Chaining N segments of UA/N telescopes EXACTLY —
    //   Π exp(−(UA/N)/(ṁ·cp)) = exp(−UA/(ṁ·cp))
    // — because each segment's upstream temperature is the previous
    // segment's outlet and cp is constant for incompressible water.  With
    // ua divided (extensive), splitting a heated pipe is therefore NOT a
    // discretization change on this branch, just like the hydraulic headline
    // above: before/after outlet temperatures must agree to solver noise.
    //
    // This exactness does NOT extend to the two-phase fallback branch
    // (ua·(T_wall − T_up), heatedPipe.ts): that term is linear in the LOCAL
    // ΔT, so a lumped pipe applies the whole UA at the largest (inlet) ΔT
    // while a split applies UA/N at shrinking ΔT down the chain — a genuine
    // discretization effect where the split model picks up less heat.  This
    // test deliberately exercises the single-phase ε-NTU path only.
    const config: NetworkConfig = {
      ...pressureLine(),
      nodes: [
        {
          id: "inlet",
          type: "boundary",
          x: 0,
          y: 0,
          pressure: P_IN,
          temperature: 300,
        },
        {
          id: "hub",
          type: "internal",
          x: 100,
          y: 0,
          volume: 1e-3,
          pressure: 1.5e5,
          temperature: 300,
        },
        {
          id: "outlet",
          type: "boundary",
          x: 200,
          y: 0,
          pressure: P_OUT,
          temperature: 300,
        },
      ],
      branches: [
        {
          id: "hp",
          from: "inlet",
          to: "hub",
          component: {
            type: "heatedPipe",
            length: 2,
            diameter: 0.05,
            roughness: 1e-5,
            ua: 1e5,
            wallTemperature: 350,
          },
        },
        {
          id: "tail",
          from: "hub",
          to: "outlet",
          component: {
            type: "pipe",
            length: 1,
            diameter: 0.05,
            roughness: 1e-5,
          },
        },
      ],
    };
    const unsplit = solveSteady(config);
    expect(unsplit.converged).toBe(true);
    const { config: got } = split(config, "hp", 4);
    expect(validateNetwork(got)).toEqual([]);
    const resplit = solveSteady(got);
    expect(resplit.converged).toBe(true);

    // Hydraulics unchanged → same mass flow (as for the plain-pipe headline).
    expect(
      relDiff(resplit.branches.hp.mdot, unsplit.branches.hp.mdot),
    ).toBeLessThan(EQUIV_TOL);

    // Non-vacuous heat pickup, then the telescoping equality.
    const tBefore = unsplit.nodes.hub.temperature;
    const tAfter = resplit.nodes.hub.temperature;
    expect(tBefore).toBeGreaterThan(310); // wall at 350 K clearly heats 300 K inflow
    expect(tBefore).toBeLessThan(350);
    expect(relDiff(tAfter, tBefore)).toBeLessThan(EQUIV_TOL);
  });
});

/* ------------------------------------------------------------------ */
/* linkParams                                                          */
/* ------------------------------------------------------------------ */

describe("linkParams", () => {
  it("defaults to false: literal segment copies", () => {
    const { config: got } = split(pressureLine(), "main", 3);
    for (const b of got.branches) {
      for (const field of ["length", "diameter", "roughness"]) {
        expect(typeof componentFields(got, b.id)[field]).toBe("number");
      }
    }
  });

  it("linkParams: true binds ALL non-first segments (the original included) back to segment 1 and resolves identically", () => {
    const config = pressureLine();
    const linked = splitPipeBranch(config, "main", 4, { linkParams: true });
    expect(linked.ok).toBe(true);
    if (!linked.ok) return;

    // Segment 1 (main_seg1) holds the ONLY literal.  The repeatUnit clones
    // main_seg2/main_seg3 bind every BINDABLE pipe field to segment 1
    // (repeat.ts Rule 2), and so does the original 'main' — the LAST
    // segment is never cloned, so splitPipeBranch links it explicitly.
    // Until the last segment was linked this test pinned the asymmetry
    // (main literal at 0.25), which made the panel hint "editing the first
    // segment updates them all" false for the resolved total.
    expect(componentFields(linked.config, "main_seg1").length).toBe(0.25);
    for (const id of ["main_seg2", "main_seg3", "main"]) {
      const c = componentFields(linked.config, id);
      expect(c.length).toEqual({ expr: "pipe('main_seg1').length" });
      expect(c.diameter).toEqual({ expr: "pipe('main_seg1').diameter" });
      expect(c.roughness).toEqual({ expr: "pipe('main_seg1').roughness" });
    }
    // Node Rule-2 linking rides along: m2/m3 take their initial P/T from m1.
    expect(nodeById(linked.config, "m2").pressure).toEqual({
      expr: "node('m1').pressure",
    });
    // …but volume stays a Rule-1 binding to the node's OWN upstream pipe.
    expect(nodeById(linked.config, "m2").volume).toEqual({
      expr: "pipe('main_seg2').volume",
    });

    // Linked and literal outputs resolve to identical physics.
    const literals = split(config, "main", 4);
    const rLinked = resolveNetworkParameters(linked.config);
    const rLiteral = resolveNetworkParameters(literals.config);
    expect(rLinked.ok && rLiteral.ok).toBe(true);
    if (!rLinked.ok || !rLiteral.ok) return;
    const paramsOf = (cfg: NetworkConfig) =>
      cfg.branches.map((b) => {
        const c = b.component as Record<string, unknown>;
        return [c.length, c.diameter, c.roughness];
      });
    expect(paramsOf(rLinked.config)).toEqual(paramsOf(rLiteral.config));
  });

  it("editing segment 1's length after a split scales the RESOLVED total by exactly the segment count", () => {
    // The panel hint promises "editing the first segment then updates them
    // all".  With the last segment linked too, doubling segment 1 (0.25 →
    // 0.5) doubles the resolved total to exactly 4 × 0.5 = 2; the old
    // asymmetry would have left 'main' behind at 0.25 (total 1.75).
    const linked = splitPipeBranch(pressureLine(), "main", 4, {
      linkParams: true,
    });
    expect(linked.ok).toBe(true);
    if (!linked.ok) return;
    (
      componentFields(linked.config, "main_seg1") as { length: unknown }
    ).length = 0.5;

    const resolved = resolveNetworkParameters(linked.config);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    const perSegment = resolved.config.branches.map(
      (b) => (b.component as { length: number }).length,
    );
    expect(perSegment).toHaveLength(4);
    for (const length of perSegment) expect(length).toBe(0.5);
    const total = perSegment.reduce((acc, length) => acc + length, 0);
    // Exactly N × the edited segment length — i.e. the total moved by the
    // full factor of the edit (2×), not by (N−1)/N of it.
    expect(total).toBe(2 * LENGTH);
  });
});

/* ------------------------------------------------------------------ */
/* Error surface (never throws)                                        */
/* ------------------------------------------------------------------ */

describe("validation errors", () => {
  it("rejects segments 1, 0, negative and non-integer", () => {
    for (const bad of [1, 0, -2, 2.5, NaN]) {
      const r = splitPipeBranch(pressureLine(), "main", bad);
      expect(r).toEqual({
        ok: false,
        error: `segments must be an integer ≥ 2 (got ${String(bad)})`,
      });
    }
  });

  it("rejects an unknown branch id", () => {
    expect(splitPipeBranch(pressureLine(), "ghost", 2)).toEqual({
      ok: false,
      error: "unknown branch 'ghost'",
    });
  });

  it("rejects branches that are not pipe/heatedPipe", () => {
    const config = pressureLine();
    config.branches = [
      {
        id: "o1",
        from: "inlet",
        to: "outlet",
        component: { type: "orifice", area: 1e-3, cd: 0.6 },
      },
    ];
    expect(splitPipeBranch(config, "o1", 2)).toEqual({
      ok: false,
      error:
        "only pipe and heatedPipe branches can be split ('o1' is a orifice)",
    });

    config.branches = [
      {
        id: "v1",
        from: "inlet",
        to: "outlet",
        component: { type: "valve", area: 1e-3, cd: 0.6, position: 1 },
      },
    ];
    expect(splitPipeBranch(config, "v1", 2)).toEqual({
      ok: false,
      error: "only pipe and heatedPipe branches can be split ('v1' is a valve)",
    });
  });
});

/* ------------------------------------------------------------------ */
/* Purity                                                              */
/* ------------------------------------------------------------------ */

describe("purity", () => {
  it("never mutates the input config and returns an independent clone", () => {
    const config = pressureLine();
    const snapshot = JSON.parse(JSON.stringify(config)) as unknown;
    const r = split(config, "main", 5);
    expect(config).toEqual(snapshot);
    expect(r.config).not.toBe(config);
    expect(branchById(r.config, "main")).not.toBe(config.branches[0]);
  });
});

/* ------------------------------------------------------------------ */
/* validateNetwork on the split output                                 */
/* ------------------------------------------------------------------ */

describe("validateNetwork on split output", () => {
  it("steady model validates with ZERO errors", () => {
    const { config: got } = split(pressureLine(), "main", 4);
    expect(validateNetwork(got)).toEqual([]);
  });

  it("transient model validates with ZERO errors — the volume binding is why", () => {
    // Transient requires every internal node to carry a POSITIVE volume plus
    // initial pressure and temperature.  The inserted nodes get all three:
    // volume bound to their upstream pipe's geometric volume, P/T inherited
    // from the (internal) upstream endpoint.
    const config: NetworkConfig = {
      ...pressureLine(),
      settings: {
        mode: "transient",
        dt: 0.01,
        endTime: 1,
        tolerance: 1e-9,
        maxIterations: 200,
      },
      nodes: [
        {
          id: "inlet",
          type: "boundary",
          x: 0,
          y: 0,
          pressure: P_IN,
          temperature: 300,
        },
        {
          id: "hub",
          type: "internal",
          x: 50,
          y: 0,
          volume: 1e-3,
          pressure: 1.6e5,
          temperature: 295,
        },
        {
          id: "outlet",
          type: "boundary",
          x: 100,
          y: 0,
          pressure: P_OUT,
          temperature: 300,
        },
      ],
      branches: [
        {
          id: "feed",
          from: "inlet",
          to: "hub",
          component: {
            type: "pipe",
            length: 1,
            diameter: 0.05,
            roughness: 1e-5,
          },
        },
        {
          id: "main",
          from: "hub",
          to: "outlet",
          component: {
            type: "pipe",
            length: 1,
            diameter: 0.05,
            roughness: 1e-5,
          },
        },
      ],
    };
    const { config: got, created } = split(config, "main", 4);
    expect(created.nodes).toEqual(["m1", "m2", "m3"]);

    for (let k = 1; k <= 3; k++) {
      const node = nodeById(got, `m${k}`);
      expect(isParameterExpression(node.volume)).toBe(true);
      expect(node.volume).toEqual({ expr: `pipe('main_seg${k}').volume` });
      expect(node.pressure).toBe(1.6e5);
      expect(node.temperature).toBe(295);
    }
    expect(validateNetwork(got)).toEqual([]);

    // And the bound volumes resolve to positive numbers (segment volume).
    const resolved = resolveNetworkParameters(got);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    for (let k = 1; k <= 3; k++) {
      const v = nodeById(resolved.config, `m${k}`).volume;
      expect(typeof v).toBe("number");
      expect(v as number).toBeGreaterThan(0);
    }
  });
});

/* ------------------------------------------------------------------ */
/* Downstream attachments stay on the ORIGINAL node                    */
/* ------------------------------------------------------------------ */

describe("downstream node attachments", () => {
  it("leaves a conductor and a second outgoing branch on the original downstream node", () => {
    const config: NetworkConfig = {
      ...pressureLine(),
      nodes: [
        {
          id: "inlet",
          type: "boundary",
          x: 0,
          y: 0,
          pressure: P_IN,
          temperature: 300,
        },
        {
          id: "J",
          type: "internal",
          x: 100,
          y: 0,
          volume: 1e-3,
          pressure: 1.5e5,
          temperature: 300,
        },
        {
          id: "outlet",
          type: "boundary",
          x: 200,
          y: 0,
          pressure: P_OUT,
          temperature: 300,
        },
      ],
      branches: [
        {
          id: "main",
          from: "inlet",
          to: "J",
          component: {
            type: "pipe",
            length: 1,
            diameter: 0.05,
            roughness: 1e-5,
          },
        },
        {
          id: "other",
          from: "J",
          to: "outlet",
          component: {
            type: "pipe",
            length: 1,
            diameter: 0.05,
            roughness: 1e-5,
          },
        },
      ],
      solidNodes: [
        {
          id: "wall1",
          type: "solid",
          x: 100,
          y: 50,
          temperature: 350,
          mass: 2,
          cp: 385,
        },
      ],
      conductors: [
        {
          id: "c1",
          from: "wall1",
          to: "J",
          type: { kind: "convection", area: 0.01, h: 100 },
        },
      ],
    };
    const { config: got } = split(config, "main", 3);

    // The split inserts m1/m2 between inlet and J; the original branch is
    // the last segment m2 → J.  J's OTHER attachments are untouched.
    expect([branchById(got, "main").from, branchById(got, "main").to]).toEqual([
      "m2",
      "J",
    ]);
    expect(branchById(got, "other").from).toBe("J");
    expect(conductorById(got, "c1").to).toBe("J");
    // …and none of the new nodes picked up a stray attachment.
    for (const b of got.branches) {
      if (b.id === "main" || b.id.startsWith("main_seg")) continue;
      expect(b.from === "m1" || b.from === "m2").toBe(false);
      expect(b.to === "m1" || b.to === "m2").toBe(false);
    }
    expect(validateNetwork(got)).toEqual([]);
  });
});
