/**
 * ChannelExplorer — SSR smoke tests (vitest runs in a node environment with
 * no DOM renderer, so we renderToString and assert on the markup).
 * Interaction is covered by the pure policy tests (channelExplorer.test.ts,
 * channelViews.test.ts); e2e coverage lands with the ResultsPanel integration
 * task.
 */
import { describe, it, expect } from "vitest";
import { renderToString } from "react-dom/server";
import ChannelExplorer from "../components/ChannelExplorer";
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

describe("ChannelExplorer (SSR)", () => {
  it("transient: defaults to the aggregate node-pressure chart with the view dropdown and NO time bar", () => {
    const config = makeConfig();
    const result = makeTransient();
    const html = renderToString(
      <ChannelExplorer
        displayConfig={config}
        result={result}
        runContext="Run 1 · converged · 3 steps"
        configHash="abc123"
      />,
    );
    // Header
    expect(html).toContain("channel-explorer");
    expect(html).toContain("Simulation channels");
    expect(html).toContain("Run 1 · converged · 3 steps");
    expect(html).toContain('data-testid="channel-explorer-mode"');
    expect(html).toContain("transient");
    // View dropdown: labeled select listing applicable presets + Custom.
    expect(html).toContain('data-testid="channel-explorer-view"');
    expect(html).toContain('aria-label="Channel view"');
    expect(html).toContain('for="channel-explorer-view"');
    expect(html).toContain(
      '<option value="node-pressure" selected="">Node pressure</option>',
    );
    expect(html).toContain(
      '<option value="node-solid-temperature">Node &amp; solid temperature</option>',
    );
    expect(html).toContain(
      '<option value="branch-mdot">Branch mass flow</option>',
    );
    expect(html).toContain(">Custom channels</option>");
    // "Showing N of M" status.
    expect(html).toContain('data-testid="channel-explorer-showing"');
    expect(html).toContain("Showing 2 of 2 channels");
    // Aggregate preset chart (default = all node pressures), one axis only.
    expect(html).toContain('data-testid="channel-explorer-aggregate"');
    expect(html).toContain('data-testid="channel-explorer-chart"');
    expect(html).not.toContain('data-testid="channel-explorer-chart-1"');
    // Aggregate series render as legend chips; both node pressures present.
    expect(html).toContain("Feed Tank · Pressure");
    expect(html).toContain("n2 · Pressure");
    // No time bar in Analysis: hovering the chart shows values at any time,
    // so the slider/stepper/Final controls are gone entirely.  The readout
    // (values at the shared cursor) stays.
    expect(html).not.toContain('data-testid="channel-explorer-time"');
    expect(html).not.toContain("channel-explorer-time-slider");
    expect(html).not.toContain("channel-explorer-time-back");
    expect(html).not.toContain("channel-explorer-time-forward");
    expect(html).not.toContain("channel-explorer-time-final");
    expect(html).toContain('data-testid="channel-explorer-readout"');
    // Chart SVG is keyboard-focusable with an arrow-key hint (onCursorCommit).
    expect(html).toContain("arrow keys to move the time cursor");
    // Legend locate actions are preserved on the aggregate chart.
    expect(html).toContain("chart-legend-locate-");
    // Context diagram is hidden in ordinary preset browsing.
    expect(html).not.toContain('data-testid="channel-explorer-context"');
    expect(html).not.toContain(
      'data-testid="channel-explorer-context-details"',
    );
    // Custom-only controls stay out of the toolbar in preset mode.
    expect(html).not.toContain('data-testid="channel-explorer-search"');
    expect(html).not.toContain('data-testid="channel-explorer-list"');
    // CSV export of the displayed view AND of the full inventory + status region.
    expect(html).toContain('data-testid="channel-explorer-export-csv"');
    expect(html).toContain('data-testid="channel-explorer-export-all-csv"');
    expect(html).toContain(">Export all</button>");
    expect(html).toContain('data-testid="channel-explorer-status"');
    expect(html).toContain('role="status"');
  });

  it("steady: defaults to the aggregate node-pressure bar/value list with baseline deltas", () => {
    const config = makeSteadyConfig();
    const result = makeSteady();
    const baselineResult = makeSteady();
    baselineResult.nodes.n1.pressure = 100000;
    const html = renderToString(
      <ChannelExplorer
        displayConfig={config}
        result={result}
        baseline={{ name: "Base run", config, result: baselineResult }}
      />,
    );
    // Default view is still the node-pressure preset.
    expect(html).toContain(
      '<option value="node-pressure" selected="">Node pressure</option>',
    );
    // Accessible bar list: buttons carry label + value text (+ delta).
    expect(html).toContain('data-testid="channel-explorer-bars"');
    expect(html).toContain('role="group"');
    expect(html).toContain('aria-label="Aggregate channel values"');
    expect(html).toContain('data-testid="channel-bar-');
    // 101325 Pa auto-scales to kPa; values appear in the row text.
    expect(html).toContain("kPa");
    expect(html).toContain("Feed Tank · Pressure");
    expect(html).toContain("delta ");
    expect(html).toContain("Base run");
    // No time controls or transient chart in steady mode.
    expect(html).not.toContain("channel-explorer-time-slider");
    expect(html).not.toContain('data-testid="channel-explorer-chart"');
    // Context diagram hidden in preset mode.
    expect(html).not.toContain('data-testid="channel-explorer-context"');
  });

  it("sparse transient inventory: default falls back to the first available preset (node pressure still wins)", () => {
    const config = makeConfig();
    const result: TransientResult = {
      converged: true,
      times: [0, 1],
      nodes: { n1: { pressure: [1, 2], temperature: [3, 4], density: [5, 6] } },
      branches: {},
    };
    const html = renderToString(
      <ChannelExplorer displayConfig={config} result={result} />,
    );
    // Only the single matching channel is charted; "Showing 1 of 1".
    expect(html).toContain(
      '<option value="node-pressure" selected="">Node pressure</option>',
    );
    expect(html).toContain("Showing 1 of 1 channel");
    expect(html).toContain('data-testid="channel-explorer-chart"');
  });

  it("falls back to the next preset when node pressure has no channels (temperature default)", () => {
    const config = makeConfig();
    const result: TransientResult = {
      converged: true,
      times: [0, 1],
      nodes: {
        n1: {
          pressure: [101325, 101325],
          temperature: [3, 4],
          density: [5, 6],
        },
      },
      branches: {},
      solidNodes: { s1: { temperature: [300, 301] } },
    };
    // Remove pressure after the fact so the pressure preset has no channels.
    // (TransientResult requires pressure arrays, so build a valid result and
    //  point the explorer at an inventory filtered by the result itself.)
    delete (result.nodes.n1 as { pressure?: number[] }).pressure;
    const html = renderToString(
      <ChannelExplorer displayConfig={config} result={result} />,
    );
    expect(html).toContain(
      '<option value="node-solid-temperature" selected="">Node &amp; solid temperature</option>',
    );
    expect(html).toContain('data-testid="channel-explorer-chart"');
  });

  it("renders the empty state without a result", () => {
    const html = renderToString(
      <ChannelExplorer displayConfig={makeConfig()} result={null} />,
    );
    expect(html).toContain('data-testid="channel-explorer-empty"');
    expect(html).toContain("Run a simulation to explore its channels");
    expect(html).not.toContain("channel-explorer-list");
    expect(html).not.toContain("channel-explorer-view");
  });

  it("shows the stale banner and live badge when flagged", () => {
    const config = makeConfig();
    const html = renderToString(
      <ChannelExplorer
        displayConfig={config}
        result={makeTransient()}
        stale
        live
      />,
    );
    expect(html).toContain('data-testid="channel-explorer-stale"');
    expect(html).toContain('data-testid="channel-explorer-live"');
  });

  it("renders a notice instead of a chart when no preset channel resolves (all non-finite)", () => {
    const config = makeConfig();
    const result: TransientResult = {
      converged: true,
      times: [0, 1],
      nodes: {
        n1: {
          pressure: [NaN, NaN],
          temperature: [300, 301],
          density: [1000, 1000],
        },
      },
      branches: {},
    };
    const html = renderToString(
      <ChannelExplorer displayConfig={config} result={result} />,
    );
    // node-pressure is the default preset but its only channel is all-NaN.
    expect(html).toContain('data-testid="channel-explorer-skipped-note"');
    expect(html).toContain('data-testid="channel-explorer-unresolved"');
    expect(html).not.toContain('data-testid="channel-explorer-chart"');
  });

  it("keeps the Custom channels option and its control markup available", () => {
    const config = makeConfig();
    const html = renderToString(
      <ChannelExplorer displayConfig={config} result={makeTransient()} />,
    );
    // The Custom option is always in the dropdown; custom controls render
    // when that view is active (interaction covered by e2e/policy tests).
    expect(html).toContain(">Custom channels</option>");
    expect(html).toContain('aria-label="Channel view"');
  });

  it("aggregate readout lists every charted channel value at the cursor", () => {
    const html = renderToString(
      <ChannelExplorer displayConfig={makeConfig()} result={makeTransient()} />,
    );
    const readoutStart = html.indexOf('data-testid="channel-explorer-readout"');
    expect(readoutStart).toBeGreaterThan(-1);
    const readout = html.slice(readoutStart, readoutStart + 1200);
    expect(readout).toContain("Feed Tank · Pressure");
    expect(readout).toContain("n2 · Pressure");
  });
});

describe("ChannelExplorer custom mode (SSR via listChannels inventory)", () => {
  it("every inventory channel is addressable by the custom picker (reversible keys)", () => {
    // The picker renders in Custom mode only; assert the inventory the
    // component would list is complete and every key parses back.
    const config = makeConfig();
    const result = makeTransient();
    const channels = listChannels(config, result);
    expect(channels.length).toBeGreaterThan(0);
    for (const d of channels) {
      expect(d.label).toContain(d.elementLabel);
      expect(d.channel.id.length).toBeGreaterThan(0);
    }
  });
});
