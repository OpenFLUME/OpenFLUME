/**
 * Shell building blocks — SSR smoke + behavior pins for the new assistance
 * surfaces (outline glyphs and hover cards, suggested settings, new-model
 * templates,
 * model outline, command palette).  renderToString keeps these fast and
 * DOM-free, matching the settingsTabs test approach.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { renderToString } from "react-dom/server";
import SuggestedSettings from "../components/SuggestedSettings";
import NewModelDialog from "../components/NewModelDialog";
import ModelOutline from "../shell/studio/ModelOutline";
import CommandPalette from "../shell/CommandPalette";
import { PROBLEM_TEMPLATES } from "../problemTemplates";
import { useStore } from "../store";
import type { NetworkConfig } from "../types";

function baseConfig(): NetworkConfig {
  return {
    meta: { name: "shell-components", version: 2 },
    settings: {
      mode: "steady",
      tolerance: 1e-6,
      maxIterations: 200,
      relaxation: 0.9,
    },
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
        x: 100,
        y: 0,
        pressure: 1e5,
        temperature: 300,
      },
    ],
    branches: [
      {
        id: "p1",
        from: "a",
        to: "b",
        component: {
          type: "pipe",
          length: 1,
          diameter: 0.02,
          roughness: 1e-5,
        },
      },
    ],
  };
}

/** renderToString reads the store's SSR snapshot (the initial state), so
 *  tests stage state by mutating getInitialState() — same approach as the
 *  settingsTabs suite. */
function stageState(patch: Record<string, unknown>): void {
  // Staging a config means staging the whole model session: `config` is the
  // resolved active variant and `baseConfig` is the file it came from, which
  // for a variant-free fixture are the same network.
  const withBase =
    "config" in patch ? { baseConfig: patch.config, ...patch } : patch;
  Object.assign(useStore.getInitialState(), withBase);
}

beforeEach(() => {
  stageState({
    config: baseConfig(),
    validationErrors: [],
    selection: { kind: "none" },
    running: false,
  });
});

describe("SuggestedSettings", () => {
  it("renders nothing when settings already match", () => {
    const html = renderToString(<SuggestedSettings />);
    expect(html).toBe("");
  });

  it("shows the transient suggestion for scheduled models", () => {
    const cfg = baseConfig();
    cfg.nodes[0].pressureSchedule = [
      [0, 2e5],
      [10, 1.5e5],
    ];
    stageState({ config: cfg });
    const html = renderToString(<SuggestedSettings />);
    expect(html).toContain("suggested-settings");
    expect(html).toContain("Transient");
    expect(html).toContain("Apply all");
  });
});

describe("NewModelDialog", () => {
  it("offers blank plus every problem template, blank preselected", () => {
    const html = renderToString(<NewModelDialog onClose={() => {}} />);
    expect(html).toContain("new-model-template-blank");
    for (const t of PROBLEM_TEMPLATES) {
      expect(html).toContain(`new-model-template-${t.id}`);
    }
    // Historical New contract: the accept button keeps its testid.
    expect(html).toContain("confirm-dialog-accept");
    expect(html).toMatch(
      /new-model-template-blank[^>]*aria-checked="true"|aria-checked="true"[^>]*new-model-template-blank/,
    );
  });
});

describe("ModelOutline", () => {
  it("lists nodes and branches with canvas-matching glyphs", () => {
    const html = renderToString(<ModelOutline />);
    expect(html).toContain("outline-item-a");
    expect(html).toContain("outline-item-b");
    expect(html).toContain("outline-item-p1");
    // Glyphs replace the old text badges: an accessible <title> names the
    // element type, and the node shapes carry the canvas fill colors.
    expect(html).toContain("Boundary node");
    expect(html).toContain("Pipe");
    expect(html).toContain("model-outline__item-glyph");
  });

  it("marks the current selection", () => {
    stageState({ selection: { kind: "node", id: "a" } });
    const html = renderToString(<ModelOutline />);
    expect(html).toContain("model-outline__item--selected");
  });

  it("shows configuration rows with value annotations", () => {
    const cfg = baseConfig();
    cfg.fluids = { coolant: { model: "incompressible", preset: "water" } };
    stageState({ config: cfg });
    const html = renderToString(<ModelOutline />);
    expect(html).toContain("outline-config-solver");
    expect(html).toContain("steady · tol 0.000001");
    expect(html).toContain("outline-config-physics");
    expect(html).toContain("outline-config-fluids");
    // Named fluid renders as an indented child leaf.
    expect(html).toContain("outline-config-fluid-coolant");
    expect(html).toContain("model-outline__item--child");
    expect(html).toContain("outline-config-units");
    // Search box and hide-panel hint are part of the tree chrome.
    expect(html).toContain("outline-filter");
    expect(html).toContain("to hide the panel");
  });

  it("marks elements named by validation errors with an error icon", () => {
    stageState({
      validationErrors: ["Boundary node a missing pressure"],
    });
    const html = renderToString(<ModelOutline />);
    expect(html).toContain("model-outline__status--error");
  });

  it("lists run history under Runs and leaves a converged run unmarked", () => {
    stageState({
      runHistory: [
        {
          id: "r1",
          name: "Run 1",
          timestamp: 0,
          mode: "steady",
          configHash: "x",
          config: baseConfig(),
          result: { converged: true, iterations: 3, residual: 1e-9 },
          converged: true,
          summary: "converged · 3 iter",
        },
      ],
      selectedRunId: "r1",
    });
    const html = renderToString(<ModelOutline />);
    expect(html).toContain("outline-section-results");
    expect(html).toContain("outline-run-r1");
    expect(html).toContain("converged · 3 iter");
    // Healthy is the default state: only trouble gets an icon.
    expect(html).not.toContain("model-outline__status");
  });

  it("marks a run that did not converge with an error icon", () => {
    stageState({
      runHistory: [
        {
          id: "r1",
          name: "Run 1",
          timestamp: 0,
          mode: "steady",
          configHash: "x",
          config: baseConfig(),
          result: { converged: false, iterations: 500, residual: 1 },
          converged: false,
          summary: "did not converge",
        },
      ],
      selectedRunId: "r1",
    });
    const html = renderToString(<ModelOutline />);
    expect(html).toContain("model-outline__status--error");
  });

  it("offers save and discard for the run list, and discard per run", () => {
    stageState({
      runHistory: [
        {
          id: "r1",
          name: "Run 1",
          timestamp: 0,
          mode: "steady",
          configHash: "x",
          config: baseConfig(),
          result: { converged: true, iterations: 3, residual: 1e-9 },
          converged: true,
          summary: "converged · 3 iter",
        },
      ],
      selectedRunId: "r1",
    });
    const html = renderToString(<ModelOutline />);
    expect(html).toContain("outline-save-runs");
    expect(html).toContain("outline-discard-runs");
    expect(html).toContain("outline-discard-run-r1");
  });

  it("offers no run actions before anything has been run", () => {
    stageState({ runHistory: [], selectedRunId: null });
    const html = renderToString(<ModelOutline />);
    expect(html).not.toContain("outline-save-runs");
    expect(html).not.toContain("outline-discard-runs");
  });
});

describe("CommandPalette", () => {
  it("renders nothing while closed", () => {
    const html = renderToString(
      <CommandPalette open={false} onClose={() => {}} />,
    );
    expect(html).toBe("");
  });

  it("lists run, placement, view, and go-to commands when open", () => {
    const html = renderToString(
      <CommandPalette open={true} onClose={() => {}} />,
    );
    expect(html).toContain("command-run");
    expect(html).toContain("command-place-internal");
    expect(html).toContain("command-tab-results");
    expect(html).toContain("command-goto-node-a");
    expect(html).toContain("command-goto-branch-p1");
  });
});
