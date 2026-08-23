/**
 * PropertyPanel handling of `customResistance.k` in its `{ kTable }` form.
 *
 * The scalar K input used to be rendered for both forms of `k`. With a table it
 * showed an EMPTY field — nothing said a Reynolds table was present — and its
 * onChange wrote a scalar, so a single keystroke silently discarded the table
 * and an emptied field wrote `k: 0`, a frictionless branch that `validateNetwork`
 * accepts. These tests pin the replacement: the table form gets its own summary
 * of the curve and the K in use, the scalar form keeps its editable input, and
 * collapsing a table to a constant is a deliberate action that preserves the K
 * the solver was using.
 *
 * Point editing itself lives in `propertyPanelGaps.test.tsx`.
 */
import { describe, it, expect } from "vitest";
import { renderToString } from "react-dom/server";
import { useStore } from "../store";
import PropertyPanel from "../components/PropertyPanel";
import { serializeText } from "../../substrate/textProjection";
import { CustomResistance } from "../../core/components";
import { formatSig } from "../format";
import type { NetworkConfig, Selection, SteadyResult } from "../types";

const K_TABLE: Array<[number, number]> = [
  [1e3, 1.58],
  [4e3, 1.04],
  [1e4, 0.82],
  [1e5, 0.55],
  [1e6, 0.42],
];

function makeConfig(
  k: number | { kTable: Array<[number, number]> },
): NetworkConfig {
  return {
    meta: { name: "kTable panel", version: 2 },
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
    branches: [
      {
        id: "ch",
        from: "a",
        to: "b",
        component: {
          type: "customResistance",
          k,
          area: 1.43548e-5,
          ...(typeof k === "number" ? {} : { diameter: 3.7832e-3 }),
        },
      },
    ],
  };
}

/** A steady result carrying just the one branch's Reynolds number. */
function resultWithRe(reynolds: number): SteadyResult {
  return {
    converged: true,
    iterations: 3,
    residual: 1e-10,
    nodes: {
      a: { pressure: 2e5, temperature: 300, density: 998 },
      b: { pressure: 1e5, temperature: 300, density: 998 },
    },
    branches: { ch: { mdot: 0.365, velocity: 27.1, dP: 1e5, reynolds } },
  };
}

function renderPanel(
  config: NetworkConfig,
  result: SteadyResult | null = null,
): string {
  const selection: Selection = { kind: "branch", id: "ch" };
  Object.assign(useStore.getInitialState(), {
    config,
    baseConfig: config,
    selection,
    result,
  });
  return renderToString(<PropertyPanel />).replace(/<!-- -->/g, "");
}

function resetStore(config: NetworkConfig) {
  const text = serializeText(config);
  useStore.setState({
    config,
    baseConfig: config,
    selection: { kind: "branch", id: "ch" },
    result: null,
    resultConfig: null,
    validationErrors: [],
    past: [],
    future: [],
    modelText: text,
    textDraft: text,
    textDiagnostics: [],
  });
}

const s = () => useStore.getState();

describe("customResistance kTable in the property panel", () => {
  it("summarises the table instead of rendering a blank scalar field", () => {
    const html = renderPanel(makeConfig({ kTable: K_TABLE }));
    expect(html).toContain("ktable-summary");
    expect(html).toContain("K(Re) table");
    // Point count and Reynolds span, so the field is self-describing.  The
    // numbers go through the panel's shared formatter, so derive them the same
    // way rather than hard-coding a separator style.
    expect(html).toContain(
      `5 points, Re ${formatSig(K_TABLE[0][0], 3)}–${formatSig(K_TABLE[K_TABLE.length - 1][0], 3)}`,
    );
  });

  it("keeps the editable scalar input for the constant-K form", () => {
    const html = renderPanel(makeConfig(0.5));
    expect(html).not.toContain("ktable-summary");
    expect(html).toContain("0.5");
  });

  it("reports the K the solver is using at the solved Reynolds number", () => {
    const html = renderPanel(
      makeConfig({ kTable: K_TABLE }),
      resultWithRe(5e4),
    );
    // Interpolated with the solver's own routine, not a second implementation.
    const expected = new CustomResistance({ kTable: K_TABLE }, 1).kAtRe(5e4);
    expect(expected).toBeGreaterThan(0.55);
    expect(expected).toBeLessThan(0.82);
    expect(html).toContain(`K at Re ${formatSig(5e4, 4)}`);
    expect(html).toContain(formatSig(expected, 4));
    expect(html).not.toContain("clamped");
  });

  it("flags a solved Reynolds number outside the table, where K is held flat", () => {
    const html = renderPanel(
      makeConfig({ kTable: K_TABLE }),
      resultWithRe(5e6),
    );
    expect(html).toContain("clamped");
  });

  it("omits the solved row entirely before a run", () => {
    const html = renderPanel(makeConfig({ kTable: K_TABLE }));
    expect(html).not.toContain("K at Re");
  });

  it("collapses to the K in use, and only when explicitly asked", () => {
    // The panel's collapse action is the ONLY path from table to scalar; it must
    // hand over the K the solve was actually using rather than 0.
    resetStore(makeConfig({ kTable: K_TABLE }));
    const before = s().config.branches[0].component;
    expect(before).toMatchObject({ k: { kTable: K_TABLE } });

    const inUse = new CustomResistance({ kTable: K_TABLE }, 1).kAtRe(5e4);
    s().updateBranch("ch", {
      component: {
        ...before,
        k: inUse,
      } as NetworkConfig["branches"][number]["component"],
    });
    const after = s().config.branches[0].component;
    expect(after).toMatchObject({ k: inUse });
    expect(inUse).not.toBe(0);
    // Reversible: the table is one undo away.
    s().undo();
    expect(s().config.branches[0].component).toMatchObject({
      k: { kTable: K_TABLE },
    });
  });
});
