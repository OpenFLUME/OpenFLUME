/**
 * modelAdvisor.ts — deterministic, explainable model assistance.
 *
 * Two pure functions over a NetworkConfig, with NO solver involvement:
 *
 *   - suggestSolverSettings(): inspect the model (fluids, components,
 *     schedules, chemistry) and propose solver settings with a
 *     human-readable rationale per suggestion.  Never silently applied —
 *     the UI shows the rationale and the user applies with one click.
 *
 *   - assessModelReadiness(): advisory pre-run checklist (boundary
 *     conditions, connectivity, solve settings) that complements
 *     validateNetwork(): validation says "this is illegal", readiness says
 *     "you probably have not finished setting this up yet".
 *
 * Both are heuristics: they must never claim physics the solver does not
 * have (no shock capture, no acoustics) and must stay cheap enough to run
 * on every config edit.
 */
import type { NetworkConfig } from "./schema";
import { resolveFluidSpec } from "./fluidAssignment";

type Settings = NetworkConfig["settings"];

export interface SettingsSuggestion {
  /** Patch to merge over config.settings (only the fields worth changing). */
  patch: Partial<Settings>;
  /** One entry per suggested field group: what and why. */
  rationale: { field: string; suggestion: string; reason: string }[];
}

/** True when any node/branch carries a time schedule. */
function hasSchedules(config: NetworkConfig): boolean {
  return (
    config.nodes.some(
      (n) =>
        (n.pressureSchedule?.length ?? 0) > 0 ||
        (n.temperatureSchedule?.length ?? 0) > 0,
    ) ||
    (config.solidNodes ?? []).some(
      (n) => (n.temperatureSchedule?.length ?? 0) > 0,
    ) ||
    config.branches.some((b) => {
      const t = b.component as Record<string, unknown>;
      return (
        Array.isArray(t.positionSchedule) || Array.isArray(t.massFlowSchedule)
      );
    })
  );
}

/** Last time point across all schedules, for an endTime suggestion.
 *  Schedules are `[t, value]` tuples throughout the schema. */
function scheduleHorizon(config: NetworkConfig): number | undefined {
  let max: number | undefined;
  const scan = (rows?: Array<[number, number]>) => {
    if (!Array.isArray(rows)) return;
    for (const row of rows) {
      const t = row?.[0];
      if (typeof t === "number" && Number.isFinite(t)) {
        max = max === undefined ? t : Math.max(max, t);
      }
    }
  };
  for (const n of config.nodes) {
    scan(n.pressureSchedule);
    scan(n.temperatureSchedule);
  }
  for (const n of config.solidNodes ?? []) {
    scan(n.temperatureSchedule);
  }
  for (const b of config.branches) {
    const t = b.component as {
      positionSchedule?: Array<[number, number]>;
      massFlowSchedule?: Array<[number, number]>;
    };
    scan(t.positionSchedule);
    scan(t.massFlowSchedule);
  }
  return max;
}

/** Any node resolves to a gas-capable fluid model. */
function usesGas(config: NetworkConfig): boolean {
  const specs = [
    config.fluid,
    ...Object.values(config.fluids ?? {}),
    ...config.nodes.map((n) => resolveFluidSpec(config, n)),
  ];
  return specs.some((s) => s.model === "idealGas" || s.model === "realFluid");
}

/** Two-phase-prone setup: real fluid plus quality-specified nodes or
 *  boiling-capable components. */
function twoPhaseProne(config: NetworkConfig): boolean {
  const realFluid =
    config.fluid.model === "realFluid" ||
    Object.values(config.fluids ?? {}).some((f) => f.model === "realFluid");
  if (!realFluid) return false;
  return (
    config.nodes.some((n) => n.quality !== undefined) ||
    config.branches.some(
      (b) =>
        b.component.type === "heatedPipe" ||
        b.component.type === "cavitatingVenturi",
    )
  );
}

/** Components that make transients numerically stiff. */
function stiffTransient(config: NetworkConfig): boolean {
  return (
    config.branches.some(
      (b) =>
        b.component.type === "dynamicCheckValve" ||
        b.component.type === "reliefValve",
    ) ||
    (config.species?.reactions?.length ?? 0) > 0 ||
    (config.controllers?.length ?? 0) > 0
  );
}

/** Compressible-duct physics is worth enabling: gas plus components whose
 *  behavior depends on momentum flux / kinetic energy. A gas-fluid `orifice`
 *  is not included: its mass-flow law already applies the expansibility
 *  factor Y(r,κ) (choking included) from the branch EOS, and does not need
 *  momentumFlux/kineticEnergy to be correct on its own. Those settings
 *  matter for multi-station duct/nozzle chains, not a single restriction. */
function compressibleDuctRelevant(config: NetworkConfig): boolean {
  if (!usesGas(config)) return false;
  return config.branches.some(
    (b) =>
      b.component.type === "cavitatingVenturi" ||
      b.component.type === "areaChange" ||
      (b.component.type === "pipe" &&
        (b.component as { diameterOut?: number }).diameterOut !== undefined),
  );
}

/**
 * Propose solver settings for the model as authored.  Deterministic and
 * explainable; returns an empty patch when the current settings already
 * match every suggestion.
 */
export function suggestSolverSettings(
  config: NetworkConfig,
): SettingsSuggestion {
  const s = config.settings;
  const patch: Partial<Settings> = {};
  const rationale: SettingsSuggestion["rationale"] = [];

  // --- Mode ------------------------------------------------------------
  const scheduled = hasSchedules(config);
  const controllers = (config.controllers?.length ?? 0) > 0;
  const wantsTransient = scheduled || controllers;
  if (wantsTransient && s.mode !== "transient") {
    patch.mode = "transient";
    rationale.push({
      field: "mode",
      suggestion: "Transient",
      reason: scheduled
        ? "The model contains time schedules, which only act in a transient solve."
        : "PID controllers only run in transient mode.",
    });
  }
  const mode = patch.mode ?? s.mode;

  // --- Transient time window -------------------------------------------
  if (mode === "transient") {
    const horizon = scheduleHorizon(config);
    if (s.endTime === undefined && horizon !== undefined && horizon > 0) {
      patch.endTime = horizon;
      rationale.push({
        field: "endTime",
        suggestion: `${horizon} s`,
        reason: "Matches the last scheduled time point in the model.",
      });
    }
    const endTime = patch.endTime ?? s.endTime;
    if (s.dt === undefined && s.timeStepping !== "adaptive") {
      if (endTime !== undefined && endTime > 0) {
        // ~200 saved steps over the window: fine enough to resolve schedule
        // ramps, coarse enough to stay fast in the browser.
        const dt = endTime / 200;
        patch.dt = dt;
        rationale.push({
          field: "dt",
          suggestion: `${dt} s`,
          reason: "About 200 steps across the simulated window.",
        });
      }
    }
    if (stiffTransient(config) && s.timeStepping !== "adaptive") {
      patch.timeStepping = "adaptive";
      const dtMax = (patch.endTime ?? s.endTime ?? 1) / 50;
      if (!s.adaptive) {
        patch.adaptive = {
          dtMin: dtMax / 1e6,
          dtMax,
          relTol: 1e-4,
        };
      }
      rationale.push({
        field: "timeStepping",
        suggestion: "Adaptive",
        reason:
          "Fast-acting components (valve dynamics, reactions, or controllers) need small steps only during events — adaptive stepping keeps the rest of the run fast.",
      });
    }
  }

  // --- Compressible duct physics ----------------------------------------
  if (compressibleDuctRelevant(config)) {
    if (!s.momentumFlux) {
      patch.momentumFlux = true;
      rationale.push({
        field: "momentumFlux",
        suggestion: "On",
        reason:
          "Gas flow through area changes or compressible orifices: momentum-flux terms capture the acceleration pressure drop.",
      });
    }
    if (!s.kineticEnergy) {
      patch.kineticEnergy = true;
      rationale.push({
        field: "kineticEnergy",
        suggestion: "On",
        reason:
          "Pairs with momentum flux so stagnation-to-static conversion is consistent in the energy equation.",
      });
    }
  }

  // --- Newton knobs -----------------------------------------------------
  const relaxed = twoPhaseProne(config);
  if (relaxed && (s.relaxation === undefined || s.relaxation > 0.7)) {
    patch.relaxation = 0.7;
    rationale.push({
      field: "relaxation",
      suggestion: "0.7",
      reason:
        "Two-phase property slopes are steep; extra under-relaxation avoids overshooting the saturation dome.",
    });
  }

  const elementCount = config.nodes.length + config.branches.length;
  if (elementCount > 60 && s.maxIterations < 400) {
    patch.maxIterations = 400;
    rationale.push({
      field: "maxIterations",
      suggestion: "400",
      reason: `Larger network (${elementCount} elements) — allow more Newton iterations before declaring failure.`,
    });
  }

  return { patch, rationale };
}

// ---------------------------------------------------------------------------
// Readiness checklist
// ---------------------------------------------------------------------------

export type ReadinessStatus = "ok" | "todo" | "warning";

export interface ReadinessTarget {
  kind: "node" | "branch" | "solidNode" | "conductor";
  id: string;
}

export interface ReadinessCheck {
  id: string;
  label: string;
  status: ReadinessStatus;
  /** One-line explanation of what is missing / what was verified. */
  detail: string;
  /** Elements to select when the user clicks the item (click-to-fix). */
  targets?: ReadinessTarget[];
}

/**
 * Advisory pre-run checklist.  Complements validateNetwork(): these checks
 * are about setup completeness, not legality, and each maps to a concrete
 * next action.  Order is the natural authoring order (topology → boundary
 * conditions → fluids → solve settings).
 */
export function assessModelReadiness(config: NetworkConfig): ReadinessCheck[] {
  const checks: ReadinessCheck[] = [];
  const nodes = config.nodes;
  const solids = config.solidNodes ?? [];
  const branches = config.branches;
  const conductors = config.conductors ?? [];

  // 1. Topology exists.
  const elementCount =
    nodes.length + solids.length + branches.length + conductors.length;
  const hasConnections = branches.length + conductors.length > 0;
  checks.push({
    id: "topology",
    label: "Build the network",
    status: elementCount === 0 ? "todo" : hasConnections ? "ok" : "todo",
    detail:
      elementCount === 0
        ? "Place nodes on the canvas and connect them with branches."
        : hasConnections
          ? `${nodes.length + solids.length} nodes, ${branches.length + conductors.length} connections.`
          : "Nodes are placed but nothing is connected yet.",
  });

  // 2. Boundary conditions anchor the fluid network.
  if (nodes.length > 0) {
    const boundaries = nodes.filter((n) => n.type === "boundary");
    const incomplete = boundaries.filter(
      (n) =>
        n.pressure === undefined ||
        (n.temperature === undefined && n.quality === undefined),
    );
    checks.push({
      id: "boundaries",
      label: "Anchor boundary conditions",
      status:
        boundaries.length === 0
          ? "todo"
          : incomplete.length > 0
            ? "todo"
            : "ok",
      detail:
        boundaries.length === 0
          ? "No boundary nodes: a steady network needs at least one node with known pressure."
          : incomplete.length > 0
            ? `${incomplete.length} boundary node${incomplete.length === 1 ? "" : "s"} missing pressure or temperature.`
            : `${boundaries.length} boundary node${boundaries.length === 1 ? "" : "s"} fully specified.`,
      targets:
        incomplete.length > 0
          ? incomplete.map((n) => ({ kind: "node" as const, id: n.id }))
          : undefined,
    });
  }

  // 3. Everything connected (no orphan elements).
  if (elementCount > 0) {
    const touched = new Set<string>();
    for (const b of branches) {
      touched.add(b.from);
      touched.add(b.to);
    }
    for (const c of conductors) {
      touched.add(c.from);
      touched.add(c.to);
    }
    const orphanNodes = nodes.filter((n) => !touched.has(n.id));
    const orphanSolids = solids.filter((n) => !touched.has(n.id));
    const orphans = orphanNodes.length + orphanSolids.length;
    checks.push({
      id: "connectivity",
      label: "Connect every node",
      status: orphans > 0 ? "warning" : "ok",
      detail:
        orphans > 0
          ? `${orphans} node${orphans === 1 ? "" : "s"} not attached to any branch or conductor.`
          : "No orphan nodes.",
      targets:
        orphans > 0
          ? [
              ...orphanNodes.map((n) => ({ kind: "node" as const, id: n.id })),
              ...orphanSolids.map((n) => ({
                kind: "solidNode" as const,
                id: n.id,
              })),
            ]
          : undefined,
    });
  }

  // 4. Fluid choice is explicit.
  {
    const named = Object.keys(config.fluids ?? {});
    const label =
      config.fluid.preset ??
      (config.fluid.model === "realFluid"
        ? String(
            (config.fluid.params as { fluidName?: string } | undefined)
              ?.fluidName ?? "real fluid",
          )
        : config.fluid.model);
    checks.push({
      id: "fluid",
      label: "Choose the working fluid",
      status: "ok",
      detail:
        named.length > 0
          ? `Default ${label}; ${named.length} named fluid${named.length === 1 ? "" : "s"}.`
          : `Default fluid: ${label} (${config.fluid.model}).`,
    });
  }

  // 5. Solve settings complete for the chosen mode.
  {
    const s = config.settings;
    const missing: string[] = [];
    if (s.mode === "transient") {
      if (s.timeStepping === "adaptive") {
        if (!s.adaptive) missing.push("adaptive stepping parameters");
      } else if (s.dt === undefined) {
        missing.push("time step dt");
      }
      if (s.endTime === undefined) missing.push("end time");
      const missingVolumes = nodes.filter(
        (n) => n.type === "internal" && n.volume === undefined,
      );
      if (missingVolumes.length > 0)
        missing.push(
          `volumes on ${missingVolumes.length} internal node${missingVolumes.length === 1 ? "" : "s"}`,
        );
    }
    checks.push({
      id: "solve-settings",
      label:
        s.mode === "transient"
          ? "Set up the transient solve"
          : "Set up the steady solve",
      status: missing.length > 0 ? "todo" : "ok",
      detail:
        missing.length > 0
          ? `Missing ${missing.join(", ")}.`
          : s.mode === "transient"
            ? `Transient to ${s.endTime ?? "?"} s.`
            : `Steady solve, tolerance ${s.tolerance}.`,
    });
  }

  return checks;
}
