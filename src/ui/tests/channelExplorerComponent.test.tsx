/**
 * The Runs tab frame and its first plot — SSR markup (vitest runs in node with
 * no DOM renderer, so we renderToString and assert on the output).
 *
 * The point of these is the FIRST PAINT: a fresh run must show a usable, EMPTY
 * plot — an axis and an invitation — without a blank frame flashing first.
 * That is why the first plot is derived during render rather than created in
 * an effect: effects do not run under renderToString, and a test that passed
 * only because an effect filled things in later would not catch the flash.
 *
 * Nothing is pre-selected on purpose. Seeding the plot with node pressures
 * would assume the analyst came to look at pressure.
 *
 * Plot editing itself is pinned purely in resultPlots.test.ts; interaction is
 * covered by the e2e specs.
 */
import { describe, it, expect } from "vitest";
import { renderToString as reactRenderToString } from "react-dom/server";
import ChannelExplorer from "../components/ChannelExplorer";

/** SSR splices comment markers around interpolations; they only obscure text. */
const renderToString = (node: Parameters<typeof reactRenderToString>[0]) =>
  reactRenderToString(node).replace(/<!-- -->/g, "");
import { listChannels } from "../channels";
import type { NetworkConfig, SteadyResult, TransientResult } from "../types";

/* ------------------------------------------------------------------ */
/* Fixtures (mirror channelExplorer.test.ts)                            */
/* ------------------------------------------------------------------ */

function makeConfig(): NetworkConfig {
  return {
    meta: { name: "explorer-ssr", version: 2 },
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

function makeSteadyConfig(): NetworkConfig {
  const c = makeConfig();
  c.settings = { mode: "steady", tolerance: 1e-8, maxIterations: 60 };
  return c;
}

function makeSteady(): SteadyResult {
  return {
    converged: true,
    iterations: 5,
    residual: 1e-9,
    nodes: {
      n1: { pressure: 101325, temperature: 300, density: 1000 },
      n2: { pressure: 100000, temperature: 299, density: 1001 },
    },
    branches: { b1: { mdot: 0.5, velocity: 0.06, dP: 1325, reynolds: 6000 } },
    solidNodes: { s1: { temperature: 310 } },
    conductors: { c1: { heatRate: 42 } },
  };
}

/* ------------------------------------------------------------------ */
/* SSR smoke                                                           */
/* ------------------------------------------------------------------ */

describe("Runs tab frame (SSR)", () => {
  it("opens a transient result on an empty plot with a time axis", () => {
    const html = renderToString(
      <ChannelExplorer
        displayConfig={makeConfig()}
        result={makeTransient()}
        run={{
          runName: "Run 1",
          mode: "transient",
          outcome: "converged",
          outcomeDetail: "3 steps",
          runs: [{ id: "r1", name: "Run 1" }],
          selectedRunId: "r1",
          onSelectRun: () => {},
        }}
        configHash="abc123"
      />,
    );
    // Frame: title, mode, run context, exports.
    expect(html).toContain("channel-explorer");
    // The heading IS the run selector: no separate strip repeating it.
    expect(html).toContain('data-testid="run-title-select"');
    expect(html).toContain("Run 1");
    expect(html).toContain('data-testid="run-title-outcome"');
    expect(html).toContain("converged");
    expect(html).toContain('data-testid="run-title-detail"');
    expect(html).toContain("3 steps");
    expect(html).toContain('data-testid="channel-explorer-export-csv"');
    expect(html).toContain('data-testid="channel-explorer-export-all-csv"');

    // One plot, active, with no close button (the last plot cannot be closed)
    // and a + to add another.
    expect(html).toContain('data-testid="result-plots"');
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain("New plot");
    expect(html).not.toContain('data-testid="plot-close-');
    expect(html).toContain('data-testid="plot-add"');

    // Plot tabs are the app's ordinary tabs, not a bespoke control.
    expect(html).toContain('role="tab"');
    expect(html).toContain('class="tab"');

    // Nothing is plotted until the analyst says what they came for.
    expect(html).toContain('data-testid="plot-no-channels"');
    expect(html).toContain("Pick channels on the left");
    expect(html).not.toContain('data-testid="plot-chart"');

    // The axis is a plain choice, defaulting to time for a transient result.
    expect(html).toContain('data-testid="plot-x-axis"');
    expect(html).toContain(
      '<option value="time" title="The transient sample axis"',
    );
    expect(html).toContain('value="station"');
    expect(html).toContain('value="positionX"');
    expect(html).toContain('value="index"');

    // No time bar: hovering a chart reads any instant.
    expect(html).not.toContain('data-testid="channel-explorer-time"');
    expect(html).not.toContain("channel-explorer-time-slider");
  });

  it("drops the time axis for a steady result", () => {
    const config = makeSteadyConfig();
    const html = renderToString(
      <ChannelExplorer displayConfig={config} result={makeSteady()} />,
    );
    // A steady result has no sample axis to plot against.
    expect(html).not.toContain('<option value="time"');
    expect(html).toContain('value="station"');
    expect(html).toContain('value="index"');
    expect(html).toContain('data-testid="plot-no-channels"');
  });

  it("lists the whole inventory in the picker, filterable three ways", () => {
    const html = renderToString(
      <ChannelExplorer displayConfig={makeConfig()} result={makeTransient()} />,
    );
    expect(html).toContain('data-testid="plot-channel-picker"');
    // Search, sort and filter on one line, with the familiar glyphs behind
    // the two menus rather than a row of bare toggles.
    expect(html).toContain('data-testid="plot-channel-search"');
    expect(html).toContain('data-testid="plot-channel-sort"');
    expect(html).toContain('data-testid="plot-channel-filter"');
    // Grouping defaults to quantity, filtering to everything.
    expect(html).toContain("Group by: Quantity");
    expect(html).toContain("Filter by element type: All types");
    // What is plotted is stated up front, not buried in the list.
    expect(html).toContain("Plotted (0)");
    // Every channel of the inventory is addressable from the picker.
    const channels = listChannels(makeConfig(), makeTransient());
    expect(channels.length).toBeGreaterThan(5);
    for (const d of channels)
      expect(html).toContain(`data-testid="plot-channel-${d.key}"`);
    // Presets are a compact shortcut, not a wall of chips above the list.
    expect(html).toContain('data-testid="plot-channel-preset"');
    expect(html).toContain("Node pressure");
  });

  it("renders the empty state without a result", () => {
    const html = renderToString(
      <ChannelExplorer displayConfig={makeConfig()} result={null} />,
    );
    expect(html).toContain('data-testid="channel-explorer-empty"');
    expect(html).toContain("Run a simulation to plot its channels.");
    expect(html).not.toContain("result-plots");
    expect(html).not.toContain("plot-channel-picker");
  });

  it("shows the stale banner and live badge when flagged", () => {
    const html = renderToString(
      <ChannelExplorer
        displayConfig={makeConfig()}
        result={makeTransient()}
        stale
        live
      />,
    );
    expect(html).toContain('data-testid="channel-explorer-stale"');
    expect(html).toContain("Results are from an earlier model state");
    expect(html).toContain('data-testid="channel-explorer-live"');
  });

  it("reports the deterministic findings alongside the plot", () => {
    // 0.5 kg/s in and nothing out: the internal node cannot conserve mass.
    const html = renderToString(
      <ChannelExplorer
        displayConfig={makeSteadyConfig()}
        result={makeSteady()}
      />,
    );
    expect(html).toContain('data-testid="findings-strip"');
    expect(html).toContain('data-testid="finding-mass-imbalance"');
  });

  it("offers the other recorded runs as overlays on the plot", () => {
    // A design study asks "which one was better?", which no amount of
    // flipping between two runs a second apart can answer.
    const html = renderToString(
      <ChannelExplorer
        displayConfig={makeConfig()}
        result={makeTransient()}
        run={{ runName: "Run 2", selectedRunId: "r2" }}
        comparableRuns={[
          {
            id: "r1",
            name: "Baseline orifice",
            config: makeConfig(),
            result: makeTransient(),
          },
        ]}
      />,
    );
    expect(html).toContain('data-testid="plot-compare"');
    // The displayed run is named as the plot's own, and cannot be removed.
    expect(html).toContain('data-testid="plot-compare-primary"');
    expect(html).toContain("Run 2");
    expect(html).toContain('data-testid="plot-compare-add"');
    expect(html).toContain("Baseline orifice");
    expect(html).not.toContain('data-testid="plot-compare-remove-r1"');
  });

  it("hides the run comparison entirely when there is nothing to compare", () => {
    const html = renderToString(
      <ChannelExplorer
        displayConfig={makeConfig()}
        result={makeTransient()}
        run={{ runName: "Run 1" }}
      />,
    );
    expect(html).not.toContain('data-testid="plot-compare"');
  });
});
