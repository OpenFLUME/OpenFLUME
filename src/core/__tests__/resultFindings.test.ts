/**
 * resultFindings.ts — deterministic reading of a solved result.
 *
 * Every rule must be explainable and must not fire on a healthy answer: a
 * findings strip that cries wolf on the shipped examples is worse than no
 * strip. The last block therefore solves real models and asserts that nothing
 * alarming is reported.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { assessResult } from "../resultFindings";
import { initRealFluids, solveSteady } from "../index";
import { examples } from "../../ui/examples";
import type { NetworkConfig, SteadyResult } from "../schema";

const config = (
  branches: Array<{ id: string; from: string; to: string; label?: string }>,
  nodes: Array<{ id: string; type: "boundary" | "internal" }>,
): NetworkConfig =>
  ({
    meta: { name: "fixture", version: 2 },
    settings: { mode: "steady", tolerance: 1e-6, maxIterations: 100 },
    fluid: { model: "incompressible", preset: "water" },
    nodes: nodes.map((n) => ({
      ...n,
      x: 0,
      y: 0,
      pressure: 1e5,
      temperature: 300,
    })),
    branches: branches.map((b) => ({
      ...b,
      component: { type: "pipe", length: 1, diameter: 0.02, roughness: 1e-5 },
    })),
  }) as unknown as NetworkConfig;

const result = (
  branches: Record<string, Record<string, number>>,
  extra: Partial<SteadyResult> = {},
): SteadyResult =>
  ({
    converged: true,
    iterations: 3,
    residual: 1e-10,
    nodes: {},
    branches: Object.fromEntries(
      Object.entries(branches).map(([id, fields]) => [
        id,
        { mdot: 0, velocity: 1, dP: 0, reynolds: 9000, ...fields },
      ]),
    ),
    ...extra,
  }) as unknown as SteadyResult;

const ids = (findings: ReturnType<typeof assessResult>) =>
  findings.map((f) => f.id);

describe("assessResult", () => {
  it("says nothing about a clean, balanced result", () => {
    const cfg = config(
      [
        { id: "b1", from: "in", to: "m" },
        { id: "b2", from: "m", to: "out" },
      ],
      [
        { id: "in", type: "boundary" },
        { id: "m", type: "internal" },
        { id: "out", type: "boundary" },
      ],
    );
    const res = result({
      b1: { mdot: 1, dP: 1000 },
      b2: { mdot: 1, dP: 1000 },
    });
    expect(assessResult(cfg, res)).toEqual([]);
  });

  it("reports reverse flow and names the branches", () => {
    const cfg = config(
      [{ id: "b1", from: "in", to: "out", label: "Return leg" }],
      [
        { id: "in", type: "boundary" },
        { id: "out", type: "boundary" },
      ],
    );
    const findings = assessResult(cfg, result({ b1: { mdot: -1 } }));
    expect(ids(findings)).toContain("reverse-flow");
    const f = findings.find((x) => x.id === "reverse-flow")!;
    expect(f.detail).toContain("Return leg");
    expect(f.targets).toEqual([{ kind: "branch", id: "b1" }]);
  });

  it("escalates near-sonic to sonic at Mach 1", () => {
    const cfg = config(
      [{ id: "b1", from: "in", to: "out", label: "Nozzle" }],
      [
        { id: "in", type: "boundary" },
        { id: "out", type: "boundary" },
      ],
    );
    const near = assessResult(cfg, result({ b1: { mdot: 1, mach: 0.85 } }));
    expect(near.find((f) => f.id === "near-sonic")?.severity).toBe("info");

    const sonic = assessResult(cfg, result({ b1: { mdot: 1, mach: 1.4 } }));
    const f = sonic.find((x) => x.id === "near-sonic")!;
    expect(f.severity).toBe("warn");
    expect(f.label).toBe("Sonic flow");
    expect(f.detail).toContain("Nozzle");
  });

  it("does not flag comfortably subsonic flow", () => {
    const cfg = config(
      [{ id: "b1", from: "in", to: "out" }],
      [
        { id: "in", type: "boundary" },
        { id: "out", type: "boundary" },
      ],
    );
    expect(
      ids(assessResult(cfg, result({ b1: { mdot: 1, mach: 0.2 } }))),
    ).not.toContain("near-sonic");
  });

  it("names the component that dominates the pressure drop", () => {
    const cfg = config(
      [
        { id: "b1", from: "in", to: "m", label: "Feed" },
        { id: "b2", from: "m", to: "out", label: "Control valve" },
      ],
      [
        { id: "in", type: "boundary" },
        { id: "m", type: "internal" },
        { id: "out", type: "boundary" },
      ],
    );
    const findings = assessResult(
      cfg,
      result({ b1: { mdot: 1, dP: 500 }, b2: { mdot: 1, dP: 9500 } }),
    );
    const f = findings.find((x) => x.id === "dominant-loss")!;
    expect(f.detail).toContain("Control valve");
    expect(f.detail).toContain("95%");
    expect(f.targets).toEqual([{ kind: "branch", id: "b2" }]);
  });

  it("stays quiet when the loss is spread evenly", () => {
    const cfg = config(
      [
        { id: "b1", from: "in", to: "m" },
        { id: "b2", from: "m", to: "out" },
      ],
      [
        { id: "in", type: "boundary" },
        { id: "m", type: "internal" },
        { id: "out", type: "boundary" },
      ],
    );
    expect(
      ids(
        assessResult(
          cfg,
          result({ b1: { mdot: 1, dP: 1000 }, b2: { mdot: 1, dP: 1000 } }),
        ),
      ),
    ).not.toContain("dominant-loss");
  });

  it("reports a steady mass imbalance as an error", () => {
    const cfg = config(
      [
        { id: "b1", from: "in", to: "j" },
        { id: "b2", from: "j", to: "out" },
      ],
      [
        { id: "in", type: "boundary" },
        { id: "j", type: "internal" },
        { id: "out", type: "boundary" },
      ],
    );
    // 1 kg/s in, 0.5 out: the junction is inventing or losing mass.
    const findings = assessResult(
      cfg,
      result({ b1: { mdot: 1, dP: 100 }, b2: { mdot: 0.5, dP: 100 } }),
    );
    const f = findings.find((x) => x.id === "mass-imbalance")!;
    expect(f.severity).toBe("error");
    expect(f.targets).toEqual([{ kind: "node", id: "j" }]);
    // Severity ordering puts it first.
    expect(findings[0].id).toBe("mass-imbalance");
  });

  it("does not apply the mass-balance rule to a transient run", () => {
    const cfg = config(
      [
        { id: "b1", from: "in", to: "j" },
        { id: "b2", from: "j", to: "out" },
      ],
      [
        { id: "in", type: "boundary" },
        { id: "j", type: "internal" },
        { id: "out", type: "boundary" },
      ],
    );
    // A transient node legitimately accumulates.
    const transient = {
      converged: true,
      times: [0, 1],
      nodes: {},
      branches: {
        b1: { mdot: [1, 1], dP: [100, 100] },
        b2: { mdot: [0.5, 0.5], dP: [100, 100] },
      },
    } as unknown as SteadyResult;
    expect(ids(assessResult(cfg, transient))).not.toContain("mass-imbalance");
  });

  it("passes solver advisories through verbatim", () => {
    const cfg = config(
      [{ id: "b1", from: "in", to: "out" }],
      [
        { id: "in", type: "boundary" },
        { id: "out", type: "boundary" },
      ],
    );
    const findings = assessResult(
      cfg,
      result({ b1: { mdot: 1 } }, {
        warnings: [
          "Second-law audit: branch b1 violates the entropy condition",
        ],
      } as Partial<SteadyResult>),
    );
    expect(findings[0].label).toBe("Solver advisory");
    expect(findings[0].detail).toContain("entropy condition");
  });

  it("never throws on absent or malformed input", () => {
    expect(assessResult(null, null)).toEqual([]);
    expect(assessResult(undefined, undefined)).toEqual([]);
    expect(assessResult({} as NetworkConfig, {} as SteadyResult)).toEqual([]);
  });
});

describe("shipped examples stay quiet", () => {
  beforeAll(async () => {
    await initRealFluids();
  });

  // A converged shipped model must not produce an error-level finding: those
  // mean "do not trust these numbers", and these numbers are trustworthy.
  const steadyExamples = [
    "Sanity: orifice hand-calc",
    "Three-pipe junction",
    "Water distribution network",
    "Heated pipe with radiating wall (conjugate HT)",
    "Water-water counterflow heat exchanger",
  ];

  for (const name of steadyExamples) {
    it(`reports no error for ${name}`, () => {
      const cfg = examples[name] as NetworkConfig;
      const res = solveSteady(cfg);
      expect(res.converged).toBe(true);
      const errors = assessResult(cfg, res).filter(
        (f) => f.severity === "error",
      );
      expect(errors.map((f) => `${f.id}: ${f.detail}`)).toEqual([]);
    });
  }
});
