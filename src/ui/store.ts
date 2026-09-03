import { create } from "zustand";
import {
  NetworkConfig,
  Selection,
  SteadyResult,
  TransientResult,
} from "./types";
import {
  parseText,
  serializeText,
  type ParseError,
} from "../substrate/textProjection";
import {
  loadFromLocalStorage,
  saveToLocalStorage,
  cloneConfig,
  saveUnitPreferences,
  loadUnitPreferences,
  getDefaultUnitPreferences,
  saveSigFigs,
  loadSigFigs,
  loadShowLabels,
  saveShowLabels,
  createId,
  CanvasVisibility,
  loadCanvasVisibility,
  saveCanvasVisibility,
} from "./utils";
import { examples } from "./examples";
import { UnitPreferences, QuantityKind, UnitId, PRESETS } from "./units";
import type { RunStatus, ProgressPayload } from "./workerClient";
import {
  RunRecord,
  RUN_HISTORY_CAP,
  checkRunCompatibility,
  makeRunRecord,
} from "./runHistory";
import type { RunDiary } from "./convergenceDiary";
import { newPlot, type ResultPlot } from "./resultPlots";
import { configHash } from "./provenance";
import {
  saveRunsToLocalStorage,
  loadRunsFromLocalStorage,
  clearRunsLocalStorage,
} from "./runsFile";
import { applyVariant, diffVariant } from "../core/variants";
import type { VariantSpec } from "../core";
import { analyzeRepeatUnit, repeatUnit, splitPipeBranch } from "../core";
import {
  analyzeRepeatSelection,
  applyDuplicateCopyLabels,
  formatRepeatCounts,
  type RepeatCounts,
} from "./repeatSelection";
import { normalizeCanvasLayout } from "./canvasLayout";
import {
  getComponentLibrarySnapshot,
  resolveBranchTool,
  subscribeComponentLibrary,
} from "./componentLibrary";
import type { LocalComponent } from "./componentLibrary";
import type {
  AdvancedConfigSection,
  AdvancedConfigValue,
} from "./settingsJson";
import { DEFAULT_CAMERA, normalizeCamera, type Camera3D } from "./projection3d";
import type { ColorBy, ColorDomainOverrides } from "./colorData";

export type { ColorBy };

/** Workspace views, in tab-strip order. `config` is the Setup tab —
 *  a center view like the others, not a modal. */
export type AppTab = "editor" | "config" | "sweep" | "results";

/** Horizontal sections of the Setup workspace tab. `solver` is the
 *  landing section, so opening the tab always shows the basics first. */
export type SettingsTabId =
  "solver" | "physics" | "fluids" | "species" | "units" | "extensibility";

/** Addressable groups of `config.closureParams`. `solidCpScale` is a bare
 *  scalar (a material-property nuisance parameter, not a closure constant). */
export type ClosureParamGroup =
  "dittusBoelter" | "miropolskii" | "swameeJain" | "solidCpScale";

/** Schematic pixels (the P&ID) vs. projected physical metres (the 3D view). */
export type CanvasView = "2d" | "3d";

/** Undo/redo history entry. Config already carries canvas positions (x/y). */
interface HistoryEntry {
  /** The FILE config (base network carrying its variant list). */
  config: NetworkConfig;
  /** Which variant was active, so undo restores the view as well. */
  activeVariantId: string | null;
}

const HISTORY_CAP = 100;

/** One per-entity patch of a bulk edit (see updateEntities). */
export type EntityUpdate =
  | { kind: "node"; id: string; patch: Partial<NetworkConfig["nodes"][number]> }
  | {
      kind: "branch";
      id: string;
      patch: Partial<NetworkConfig["branches"][number]>;
    }
  | {
      kind: "solidNode";
      id: string;
      patch: Partial<NonNullable<NetworkConfig["solidNodes"]>[number]>;
    }
  | {
      kind: "conductor";
      id: string;
      patch: Partial<NonNullable<NetworkConfig["conductors"]>[number]>;
    };

interface StoreState {
  config: NetworkConfig;
  selection: Selection;
  result: SteadyResult | TransientResult | null;
  /** Config the displayed `result` was produced from (snapshot; = current
   *  config for a fresh run, the record's config for a historical run). */
  resultConfig: NetworkConfig | null;
  validationErrors: string[];
  /** CoolProp/init failures live on their own channel so they never
   *  clobber network validation errors. */
  fluidError: string | null;
  running: boolean;
  activeTab: AppTab;
  settingsTab: SettingsTabId;
  /**
   * The Results tab's plots, one per tab, and which is showing.
   *
   * Session UI state, not model data: it lives here rather than in the Results
   * view so switching to the canvas and back does not throw away the plots the
   * user built. Cleared with the rest of the session when a different model is
   * loaded, because a plot names channels of the model it was made for.
   */
  resultPlots: ResultPlot[];
  activePlotId: string | null;
  addResultPlot: (mode: "steady" | "transient") => string;
  removeResultPlot: (id: string) => void;
  setActiveResultPlot: (id: string) => void;
  /** Patch one plot; unknown ids are ignored. */
  updateResultPlot: (id: string, patch: Partial<ResultPlot>) => void;
  /** Seed the first plot from the displayed result's inventory. */
  seedResultPlot: (plot: ResultPlot) => void;
  /** Command palette visibility. In the store rather than the shell so any
   *  surface (toolbar button, Cmd/Ctrl+K, a command itself) can drive it. */
  showCommandPalette: boolean;
  branchTool: string | null; // component type when adding a branch
  conductorTool: string | null; // conductor kind when adding a conductor
  pendingSourceNodeId: string | null; // for click-click branch creation
  pendingConductorSourceId: string | null; // for click-click conductor creation
  openGroupTabs: string[];
  activeGroupTab: string | null;
  unitPreferences: UnitPreferences;
  // Worker-based run state
  runStatus: RunStatus;
  runProgress: ProgressPayload | null;
  liveResult: TransientResult | null;
  colorBy: ColorBy;
  /**
   * User-pinned legend [min, max] (SI units) per `ColorBy` kind, overriding
   * the auto-computed data range. Session-only, like `colorBy` itself — a
   * pinned scale is a viewing choice, not part of the model.
   */
  colorDomainOverrides: ColorDomainOverrides;
  timeIndex: number | null;
  resultStale: boolean;
  /** Significant figures used across all result tables (persisted). */
  resultSigFigs: number;
  /** Last known canvas viewport (screen→flow placement of new nodes). */
  canvasViewport: { x: number; y: number; zoom: number };
  /**
   * Whether element text is drawn on the canvas at all: node and branch names
   * plus every readout riding on them — solved pressures/temperatures/flows and
   * the pre-run boundary-condition chips. Off leaves a pure P&ID of glyphs and
   * runs; values are still read from the property panel and results views.
   * Persisted: re-hiding labels on every reload would be a chore.
   */
  showLabels: boolean;
  setShowLabels: (show: boolean) => void;
  /**
   * Which element/connection kinds the canvas draws — a pure viewing filter
   * so the user can isolate one part of the system (e.g. only the thermal
   * network, or only radiation ties) without touching the model. Persisted
   * like `showLabels`.
   */
  canvasVisibility: CanvasVisibility;
  setCanvasVisibility: (patch: Partial<CanvasVisibility>) => void;
  /* ── Canvas 3D view (session-only) ────────────────────────────────────
   * The 3D view is a projection of the SAME model, not a second model: it
   * re-places the existing canvas elements by their physical `position`
   * (see physicalLayout.ts) instead of their schematic pixels. Both fields
   * are view state — deliberately outside `config`, undo history, and the
   * `.fn` save format, so toggling the view never dirties the model. */
  canvasView: CanvasView;
  camera3d: Camera3D;
  setCanvasView: (view: CanvasView) => void;
  /** Yaw is wrapped and pitch clamped on the way in, so orbit callers can
   *  pass raw accumulated drag deltas. */
  setCamera3d: (camera: Camera3D) => void;
  /** React Flow multi-selection (node ids) on the main canvas — drives the
   *  "Create subnetwork" action. Separate from the single PropertyPanel
   *  `selection`. */
  canvasSelection: string[];
  setCanvasSelection: (ids: string[]) => void;
  /* ── Text projection (Stage 4) ────────────────────────────────────────
   * `config` is the ONLY source of truth.  `modelText` is its derived
   * canonical text cache — invariant: modelText === serializeText(config),
   * refreshed centrally by every config-mutation path.  `textDraft` is the
   * text-editor buffer: it equals modelText except while an INVALID text
   * edit is pending (the typed draft is retained so the user can fix it).
   * `textDiagnostics` carries the parse/validation errors of the latest
   * text edit attempt (empty ⇔ no pending invalid draft). */
  modelText: string;
  textDraft: string;
  textDiagnostics: ParseError[];
  /**
   * Text-edit entry point.  Always retains `text` as the draft.  When the
   * text parses AND validates, the parsed config wholesale-replaces the
   * current one as exactly ONE undoable history entry and the canonical
   * text is reserialized from it (so a formatting-only edit is a no-op for
   * config/history).  When it does not, config and history are left
   * untouched and the diagnostics are exposed.  Returns true iff the text
   * was applied (or already matched the current config).
   */
  setModelText: (text: string) => boolean;
  /** Discard any pending invalid draft: reset the draft to the canonical
   *  serialized config and clear diagnostics. */
  revertModelText: () => void;
  /** Bumped on every wholesale config replacement (New / Load / example).
   *  The canvas fits the view once per epoch — never on incremental edits. */
  configEpoch: number;
  /** Completed-run ring buffer (newest last, cap RUN_HISTORY_CAP). */
  runHistory: RunRecord[];
  /** Monotonic counter for default run names (survives deletions). */
  runSeq: number;
  /** Run whose result is currently displayed. */
  selectedRunId: string | null;
  /** Pinned comparison baseline run id. */
  baselineRunId: string | null;
  /**
   * Convergence diary of the currently displayed result/run selection:
   *   - a fresh manual run attaches its diary via pushRunRecord (which
   *     selects the new record);
   *   - a cancelled/errored run attaches its PARTIAL diary via
   *     setResultDiary (no RunRecord is fabricated for those);
   *   - selectRun restores the selected record's diary (null for legacy
   *     records without one);
   *   - setResult / New / Load / starting a new run clear it.
   * Model edits do NOT touch it: a stale displayed result keeps its diary,
   * exactly like it keeps its result/resultConfig.
   */
  resultDiary: RunDiary | null;
  /** Pending canvas pan/zoom-to-element request (Model Table navigation). */
  canvasFocusRequest: {
    kind: Selection["kind"];
    id: string;
    nonce: number;
  } | null;
  pushRunRecord: (input: {
    result: SteadyResult | TransientResult;
    config: NetworkConfig;
    diary?: RunDiary;
  }) => void;
  selectRun: (id: string | null) => void;
  renameRun: (id: string, name: string) => void;
  deleteRun: (id: string) => void;
  /** Drop every recorded run and the displayed result with them. */
  discardRuns: () => void;
  setBaselineRunId: (id: string | null) => void;
  requestCanvasFocus: (kind: Selection["kind"], id: string) => void;
  clearCanvasFocusRequest: () => void;
  /** Duplicate selected nodes (+ internal edges) or a single branch.
   *  Returns duplicate counts for announcements, or null when nothing applied. */
  duplicateSelection: () => {
    nodes: number;
    branches: number;
    conductors: number;
  } | null;
  /** Screen-reader announcement of the last duplication ("" when none). Set
   *  inside the store action so the toolbar button AND the Ctrl/Cmd+D global
   *  shortcut announce identically.  repeatSelection / splitBranch reuse the
   *  same channel so every canvas-mutating action announces alike. */
  duplicateNotice: string;
  /**
   * Repeat the selected subgraph unit into `count` TOTAL chained instances:
   * the seam branch (the single branch entering the unit — derived, or
   * disambiguated by including it in a `multi` selection) is cloned per
   * instance and the unit's exit crossings rewire to the last instance.
   * Crossing conductors are cloned "share"-style so every instance ties to
   * the same external node.  Returns the created counts, or null when the
   * selection is not a repeatable unit — the reason is announced via
   * `duplicateNotice` and NO undo entry is created for a failed no-op.  A
   * success is exactly one undo step and selects the created node ids.
   */
  repeatSelection: (opts: {
    count: number;
    linkParams: boolean;
    canvasOffset?: { x: number; y: number };
    physicalOffset?: { x: number; y: number; z: number };
  }) => RepeatCounts | null;
  /**
   * Split one pipe/heatedPipe branch into `segments` equal series segments
   * (core splitPipeBranch).  Same single-undo-step, canvas-selection and
   * notice conventions as repeatSelection; failures return null without
   * touching history.
   */
  splitBranch: (
    branchId: string,
    segments: number,
    opts?: { linkParams?: boolean },
  ) => RepeatCounts | null;
  /** True when config differs from the last New/Load/Save baseline. */
  dirty: boolean;
  preparingOperation: "save" | "run" | null;
  /**
   * The file as saved: the base network plus its variant list.
   *
   * `config` is the RESOLVED active variant — what the canvas, panels and
   * solver all read and edit. Editing while a variant is active is recorded
   * back into that variant's patch rather than into the base, so the base
   * only changes when Base is the active variant. See core/variants.ts.
   */
  baseConfig: NetworkConfig;
  /** Null means the implicit Base variant (the file body itself). */
  activeVariantId: string | null;
  /** Switch which variant `config` resolves to. */
  setActiveVariant: (id: string | null) => void;
  /** Attach runs loaded from a `<model>.runs.json` sidecar. */
  importRuns: (runs: RunRecord[]) => void;
  /** New variant seeded from the active one; returns its id. */
  createVariant: (name: string) => string;
  /**
   * New variant whose patch is the difference between the base network and
   * `config` — how a promoted sweep point becomes a saved variant.
   * Activates it, so a following pushRunRecord files the run under it.
   */
  createVariantFrom: (name: string, config: NetworkConfig) => string;
  renameVariant: (id: string, name: string) => void;
  /** Copy an existing variant (or Base when id is null). */
  duplicateVariant: (id: string | null) => string;
  deleteVariant: (id: string) => void;
  past: HistoryEntry[];
  future: HistoryEntry[];
  undo: () => void;
  redo: () => void;
  markSaved: (savedHash?: string) => void;
  beginPreparation: (operation: "save" | "run") => boolean;
  endPreparation: (operation: "save" | "run") => void;
  loadExample: (name: string) => void;
  newNetwork: () => void;
  /** Replace the model with a freshly built problem-template config (same
   *  lifecycle as newNetwork: history push, clean dirty state, autosave). */
  newNetworkFrom: (config: NetworkConfig) => void;
  setConfig: (config: NetworkConfig) => void;
  updateMeta: (patch: Partial<NetworkConfig["meta"]>) => void;
  updateNode: (
    id: string,
    patch: Partial<NetworkConfig["nodes"][number]>,
  ) => void;
  updateBranch: (
    id: string,
    patch: Partial<NetworkConfig["branches"][number]>,
  ) => void;
  updateSolidNode: (
    id: string,
    patch: Partial<NonNullable<NetworkConfig["solidNodes"]>[number]>,
  ) => void;
  updateConductor: (
    id: string,
    patch: Partial<NonNullable<NetworkConfig["conductors"]>[number]>,
  ) => void;
  /** Create or replace the reacting junction attached to `junction.node`
   *  (junctions are keyed by their node: one per node, enforced by
   *  validate/junctions.ts). One undoable edit. */
  upsertJunction: (
    junction: NonNullable<NetworkConfig["junctions"]>[number],
  ) => void;
  /** Remove the reacting junction attached to a node (no-op when absent).
   *  Dropping the last junction removes the `junctions` field entirely. */
  removeJunction: (nodeId: string) => void;
  /** Apply many per-entity patches as ONE undoable edit (one history entry,
   *  one commit) — the multi-selection PropertyPanel's commit path. Updates
   *  whose id no longer exists are skipped; when none apply, nothing is
   *  committed and no undo step is burned. */
  updateEntities: (updates: EntityUpdate[]) => void;
  updateSettings: (patch: Partial<NetworkConfig["settings"]>) => void;
  /** Set or clear ONE closure-calibration constant. Clearing the last member
   *  of a group drops the group, and dropping the last group removes
   *  `closureParams` entirely — an unspecified config must stay bit-identical
   *  to one that never carried the field (core/closureParams.ts). */
  setClosureParam: (
    group: ClosureParamGroup,
    key: string | null,
    value: number | undefined,
  ) => void;
  /** Replace `config.species`. Passing undefined (or an empty roster) removes
   *  the block and every node `massFractions` that named its species. */
  updateSpecies: (species: NetworkConfig["species"] | undefined) => void;
  updateFluid: (patch: Partial<NetworkConfig["fluid"]>) => void;
  /** Create or replace the named fluid `name` (multi-fluid networks). */
  setNamedFluid: (name: string, fluid: NetworkConfig["fluid"]) => void;
  /** Rename a named fluid and retarget every node reference in the same
   *  undoable edit. No-op when the source is missing or the target name is
   *  empty / already taken. */
  renameNamedFluid: (name: string, nextName: string) => void;
  /** Delete a named fluid and clear the reference from any node using it
   *  (those nodes fall back to the default fluid). Deleting the last entry
   *  removes the `fluids` map entirely. */
  removeNamedFluid: (name: string) => void;
  updateAdvancedSection: (
    section: AdvancedConfigSection,
    value: AdvancedConfigValue,
  ) => void;
  updateEmbeddedComponentFromLocal: (
    branchId: string,
    component: LocalComponent,
  ) => void;
  addNode: (node: NetworkConfig["nodes"][number]) => void;
  addBranch: (
    branch: NetworkConfig["branches"][number],
    libraryEntry?: {
      key: string;
      entry: NonNullable<NetworkConfig["componentLibrary"]>[string];
    },
  ) => void;
  addSolidNode: (
    node: NonNullable<NetworkConfig["solidNodes"]>[number],
  ) => void;
  addConductor: (
    conductor: NonNullable<NetworkConfig["conductors"]>[number],
  ) => void;
  removeNode: (id: string) => void;
  removeBranch: (id: string) => void;
  removeSolidNode: (id: string) => void;
  removeConductor: (id: string) => void;
  setSelection: (sel: Selection) => void;
  setResult: (res: SteadyResult | TransientResult | null) => void;
  /** Attach/replace the diary of the currently displayed result (used by the
   *  manual-run path for cancelled/errored runs, which push no RunRecord). */
  setResultDiary: (diary: RunDiary | null) => void;
  setValidationErrors: (errs: string[]) => void;
  setFluidError: (msg: string | null) => void;
  setRunning: (v: boolean) => void;
  setActiveTab: (tab: AppTab) => void;
  setSettingsTab: (tab: SettingsTabId) => void;
  setShowCommandPalette: (v: boolean) => void;
  setBranchTool: (t: string | null) => void;
  setConductorTool: (t: string | null) => void;
  setPendingSourceNodeId: (id: string | null) => void;
  setPendingConductorSourceId: (id: string | null) => void;
  openGroupTab: (groupId: string) => void;
  closeGroupTab: (groupId: string) => void;
  setActiveGroupTab: (groupId: string | null) => void;
  addGroup: (
    group: NonNullable<NetworkConfig["groups"]>[number],
    nodeIds?: string[],
  ) => void;
  removeGroup: (groupId: string) => void;
  updateGroup: (
    id: string,
    patch: Partial<NonNullable<NetworkConfig["groups"]>[number]>,
  ) => void;
  addNote: (note: NonNullable<NetworkConfig["notes"]>[number]) => void;
  removeNote: (id: string) => void;
  updateNote: (
    id: string,
    patch: Partial<NonNullable<NetworkConfig["notes"]>[number]>,
  ) => void;
  /**
   * Move one element within its own array (project-outline drag-reorder).
   * Presentation only: array order round-trips through the `.fn` text and is
   * undoable, but it is canonicalized out of the provenance hash, so a
   * reorder never marks results stale.
   */
  reorderEntity: (
    kind: "node" | "branch" | "solidNode" | "conductor" | "note",
    fromIndex: number,
    toIndex: number,
  ) => void;
  moveNodesToGroup: (nodeIds: string[], groupId: string | undefined) => void;
  moveSolidNodesToGroup: (
    nodeIds: string[],
    groupId: string | undefined,
  ) => void;
  setUnitPreferences: (prefs: UnitPreferences) => void;
  setUnitPreference: (kind: QuantityKind, unitId: UnitId) => void;
  setUnitPreset: (presetName: string) => void;
  persist: () => void;
  setRunStatus: (status: RunStatus) => void;
  setRunProgress: (progress: ProgressPayload | null) => void;
  setLiveResult: (result: TransientResult | null) => void;
  setColorBy: (colorBy: ColorBy) => void;
  /** Pin a legend range for a `ColorBy` kind; pass `null` to revert to auto. */
  setColorDomainOverride: (
    colorBy: ColorBy,
    domain: [number, number] | null,
  ) => void;
  setTimeIndex: (index: number | null) => void;
  setResultSigFigs: (n: number) => void;
  setCanvasViewport: (vp: { x: number; y: number; zoom: number }) => void;
}

const defaultConfig: NetworkConfig = {
  meta: { name: "Untitled network", version: 2 },
  settings: {
    mode: "steady",
    tolerance: 1e-6,
    maxIterations: 200,
    relaxation: 0.9,
  },
  fluid: { model: "incompressible", preset: "water" },
  nodes: [],
  branches: [],
};

// Normalize at hydration too (idempotent): an earlier autosave of a
// physically-scaled chilldown model gets the same readable layout.
const persisted = loadFromLocalStorage();
const initialConfig = persisted
  ? normalizeCanvasLayout(persisted)
  : defaultConfig;
const initialUnitPreferences =
  loadUnitPreferences() ?? getDefaultUnitPreferences();
const initialModelText = serializeText(initialConfig);
/** Mirrored results, reattached only when they belong to this model. */
const initialRuns = loadRunsFromLocalStorage(initialConfig);

/**
 * Session state for the newest restored run, so a reload lands where the last
 * solve left off. Staleness is judged against the run's own snapshot hash, as
 * `selectRun` does — the autosaved model may have moved on since.
 */
function restoredSelection(runs: readonly RunRecord[]) {
  const latest = runs[runs.length - 1];
  if (!latest) {
    return {
      selectedRunId: null,
      baselineRunId: null,
      result: null,
      resultConfig: null,
      resultStale: false,
    };
  }
  return {
    selectedRunId: latest.id,
    baselineRunId: null,
    result: latest.result,
    resultConfig: latest.config,
    resultStale: latest.configHash !== configHash(initialConfig),
  };
}

/**
 * Copy of `value` with every `undefined`-valued key dropped, at any depth.
 *
 * Optional config fields are absent or set, never present-and-undefined: a
 * patch merge that clears a field has to remove the key. The persisted form
 * already works this way — `cloneConfig` is a JSON round-trip and the text
 * projection writes strict JSON — so doing it at the edit rather than at the
 * next clone keeps the in-memory config equal to what a reload would produce.
 * Nested payloads (a branch `component`, a conductor `type`, a node
 * `gasCushion`) follow the same rule, hence the recursion.
 */
function withoutUndefined<T>(value: T): T {
  if (Array.isArray(value)) return value.map(withoutUndefined) as T;
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, member] of Object.entries(
    value as Record<string, unknown>,
  )) {
    if (member !== undefined) out[key] = withoutUndefined(member);
  }
  return out as T;
}

/** True when a selection still refers to an entity present in `cfg`. */
function selectionExistsIn(sel: Selection, cfg: NetworkConfig): boolean {
  switch (sel.kind) {
    case "node":
      return cfg.nodes.some((n) => n.id === sel.id);
    case "branch":
      return cfg.branches.some((b) => b.id === sel.id);
    case "solidNode":
      return (cfg.solidNodes ?? []).some((n) => n.id === sel.id);
    case "conductor":
      return (cfg.conductors ?? []).some((c) => c.id === sel.id);
    case "group":
      return (cfg.groups ?? []).some((g) => g.id === sel.id);
    case "note":
      return (cfg.notes ?? []).some((n) => n.id === sel.id);
    case "multi":
      // The multi panel filters stale ids itself; keep the selection alive
      // while at least one member survives the replacement.
      return sel.items.some((item) => selectionExistsIn(item, cfg));
    case "none":
      return true;
  }
}

export const useStore = create<StoreState>((set, get) => {
  /** Snapshot the pre-mutation FILE onto the undo stack. */
  const pushHistory = () => {
    const { past, baseConfig, activeVariantId } = get();
    const next = [
      ...past,
      { config: cloneConfig(baseConfig), activeVariantId },
    ];
    if (next.length > HISTORY_CAP) next.shift();
    set({ past: next, future: [] });
  };

  /** The active variant's spec, or null when Base is active. */
  const activeVariant = (
    base: NetworkConfig,
    id: string | null,
  ): VariantSpec | null =>
    id === null
      ? null
      : ((base.variants ?? []).find((v) => v.id === id) ?? null);

  /** Resolve the network the UI should be editing for a given file+variant. */
  const resolveActive = (
    base: NetworkConfig,
    id: string | null,
  ): NetworkConfig => applyVariant(base, activeVariant(base, id));

  /**
   * Derived-text sync, applied by EVERY successful config-mutation path
   * (centralized here and in the wholesale replacements below): the
   * canonical text is reserialized from the new config, and any pending
   * invalid text draft + its diagnostics are dropped as stale.
   */
  const syncText = (fileCfg: NetworkConfig) => {
    const text = serializeText(fileCfg);
    return {
      modelText: text,
      textDraft: text,
      textDiagnostics: [] as ParseError[],
    };
  };

  /**
   * Replace the whole session: a new file becomes the base, Base becomes the
   * active variant, and the derived text/persistence follow.  Used by every
   * wholesale replacement (new / load / example / template).
   */
  const adoptFile = (fileCfg: NetworkConfig) => {
    saveToLocalStorage(fileCfg);
    return {
      baseConfig: fileCfg,
      activeVariantId: null as string | null,
      config: resolveActive(fileCfg, null),
      ...syncText(fileCfg),
    };
  };

  /**
   * Everything a new model must forget.  Run history is scoped to the loaded
   * model: leaving it alone used to mix runs from the previous file into the
   * new one's Results tab, which is indistinguishable from a wrong answer.
   */
  const clearedSession = () => {
    clearRunsLocalStorage();
    return clearedSessionState();
  };

  /** The results half of a cleared session, shared with `discardRuns`. */
  const clearedRunState = () => ({
    result: null,
    resultConfig: null,
    resultDiary: null,
    resultStale: false,
    runHistory: [] as RunRecord[],
    runSeq: 0,
    selectedRunId: null as string | null,
    baselineRunId: null as string | null,
  });

  const clearedSessionState = () => ({
    ...clearedRunState(),
    // A plot names channels of the model it was built for.
    resultPlots: [] as ResultPlot[],
    activePlotId: null as string | null,
    selection: { kind: "none" } as Selection,
    validationErrors: [] as string[],
    openGroupTabs: [] as string[],
    activeGroupTab: null as string | null,
    activeTab: "editor" as AppTab,
    dirty: false,
    // CoolProp init is per-model: a failure on the previous file must not
    // follow a New / Load / Example replacement onto a model that may not
    // even use real fluids.
    fluidError: null as string | null,
  });

  /**
   * Mirror history after any edit to it, so the browser-storage copy can never
   * resurrect a run the user deleted or restore a stale name.  An empty
   * history removes the key rather than writing an empty file.
   */
  const persistRuns = (base: NetworkConfig, history: readonly RunRecord[]) => {
    if (history.length === 0) clearRunsLocalStorage();
    else saveRunsToLocalStorage(base, history);
  };

  /**
   * Common tail for every config mutation: persist + dirty + stale + text sync.
   *
   * `cfg` is the RESOLVED network being edited. When a variant is active the
   * edit is diffed back into that variant's patch, leaving the base network
   * untouched; when Base is active it becomes the new base. Either way the
   * `.fn` text and the autosave always describe the whole file.
   *
   * `stale: false` is reserved for edits that provably cannot change a solver
   * answer — canvas notes, and pure reordering, both of which are excluded
   * from the provenance hash. Marking results stale for those would train
   * users to ignore the staleness signal.
   */
  const commitConfig = (cfg: NetworkConfig, options?: { stale?: boolean }) => {
    const stale = options?.stale ?? true;
    const { baseConfig, activeVariantId } = get();
    let nextBase: NetworkConfig;

    if (activeVariantId === null) {
      // Editing Base: the edited network IS the new file body; carry the
      // variant list across (it is not part of the resolved config).
      nextBase = cfg;
      if (baseConfig.variants !== undefined)
        nextBase.variants = baseConfig.variants;
    } else {
      // Editing a variant: re-record its patch against the unchanged base.
      const baseOnly = applyVariant(baseConfig, null);
      const patch = diffVariant(baseOnly, cfg);
      nextBase = cloneConfig(baseConfig);
      nextBase.variants = (nextBase.variants ?? []).map((v) =>
        v.id === activeVariantId
          ? patch === undefined
            ? { id: v.id, name: v.name }
            : { ...v, patch }
          : v,
      );
    }

    set({
      baseConfig: nextBase,
      config: cfg,
      dirty: true,
      ...(stale ? { resultStale: true } : {}),
      ...syncText(nextBase),
    });
    saveToLocalStorage(nextBase);
  };

  return {
    baseConfig: initialConfig,
    activeVariantId: null,
    // Boot on Base, so the resolved config is the file body itself.
    config: applyVariant(initialConfig, null),
    selection: { kind: "none" },
    validationErrors: [],
    fluidError: null,
    running: false,
    runStatus: "idle",
    runProgress: null,
    liveResult: null,
    activeTab: "editor",
    settingsTab: "solver",
    showCommandPalette: false,
    branchTool: null,
    conductorTool: null,
    pendingSourceNodeId: null,
    pendingConductorSourceId: null,
    openGroupTabs: [],
    activeGroupTab: null,
    unitPreferences: initialUnitPreferences,
    colorBy: "none",
    colorDomainOverrides: {},
    timeIndex: null,
    resultSigFigs: loadSigFigs() ?? 4,
    canvasViewport: { x: 0, y: 0, zoom: 1 },
    showLabels: loadShowLabels(),
    canvasVisibility: loadCanvasVisibility(),
    canvasView: "2d",
    camera3d: DEFAULT_CAMERA,
    canvasSelection: [],
    modelText: initialModelText,
    textDraft: initialModelText,
    textDiagnostics: [],
    configEpoch: 0,
    // Rehydrate the mirrored results alongside the autosaved model, so a
    // reload resumes the session rather than discarding its runs.
    runHistory: initialRuns,
    runSeq: initialRuns.length,
    // Plots are seeded by the Results view from the displayed result's inventory,
    // which is not known here.
    resultPlots: [],
    activePlotId: null,
    // Resume on the newest restored run, exactly as finishing a solve leaves
    // it selected. Leaving nothing selected showed a list whose rows all
    // looked inert: pinning a comparison baseline needs a displayed run to
    // compare against, so the pin silently did nothing after every reload.
    ...restoredSelection(initialRuns),
    resultDiary: null,
    canvasFocusRequest: null,
    duplicateNotice: "",
    dirty: false,
    preparingOperation: null,
    past: [],
    future: [],

    undo: () => {
      const { past, future, baseConfig, activeVariantId } = get();
      if (past.length === 0) return;
      const prev = past[past.length - 1];
      set({
        past: past.slice(0, -1),
        future: [
          { config: cloneConfig(baseConfig), activeVariantId },
          ...future,
        ].slice(0, HISTORY_CAP),
        baseConfig: prev.config,
        activeVariantId: prev.activeVariantId,
        config: resolveActive(prev.config, prev.activeVariantId),
        selection: { kind: "none" },
        resultStale: true,
        dirty: true,
        ...syncText(prev.config),
      });
      saveToLocalStorage(prev.config);
    },

    redo: () => {
      const { past, future, baseConfig, activeVariantId } = get();
      if (future.length === 0) return;
      const next = future[0];
      set({
        past: [
          ...past,
          { config: cloneConfig(baseConfig), activeVariantId },
        ].slice(-HISTORY_CAP),
        future: future.slice(1),
        baseConfig: next.config,
        activeVariantId: next.activeVariantId,
        config: resolveActive(next.config, next.activeVariantId),
        selection: { kind: "none" },
        resultStale: true,
        dirty: true,
        ...syncText(next.config),
      });
      saveToLocalStorage(next.config);
    },

    markSaved: (savedHash) => {
      if (savedHash === undefined || configHash(get().baseConfig) === savedHash)
        set({ dirty: false });
    },

    importRuns: (runs) => {
      if (runs.length === 0) return;
      const existing = new Set(get().runHistory.map((r) => r.id));
      const incoming = runs.filter((r) => !existing.has(r.id));
      if (incoming.length === 0) return;
      const history = [...get().runHistory, ...incoming].sort(
        (a, b) => a.timestamp - b.timestamp,
      );
      set({
        runHistory: history,
        // Highest sequence seen, so new runs keep unique default names.
        runSeq: Math.max(
          get().runSeq,
          ...history.map((r) => {
            const m = /^Run (\d+)$/.exec(r.name);
            return m ? Number(m[1]) : 0;
          }),
        ),
      });
      persistRuns(get().baseConfig, history);
    },

    setActiveVariant: (id) => {
      const { baseConfig, activeVariantId } = get();
      if (id === activeVariantId) return;
      if (id !== null && !(baseConfig.variants ?? []).some((v) => v.id === id))
        return;
      const config = resolveActive(baseConfig, id);
      set({
        activeVariantId: id,
        config,
        // The displayed result belongs to whichever variant produced it, so
        // switching clears it rather than showing another variant's numbers
        // against this network.
        result: null,
        resultConfig: null,
        resultDiary: null,
        selectedRunId: null,
        resultStale: false,
        selection: selectionExistsIn(get().selection, config)
          ? get().selection
          : { kind: "none" },
        configEpoch: get().configEpoch + 1,
      });
    },

    createVariant: (name) => {
      pushHistory();
      const { baseConfig, activeVariantId, config } = get();
      const id = createId(
        "VAR",
        new Set((baseConfig.variants ?? []).map((v) => v.id)),
      );
      // Seeded from what is on screen: creating a variant while one is
      // active branches from that variant, not from Base.
      const patch = diffVariant(applyVariant(baseConfig, null), config);
      const next = cloneConfig(baseConfig);
      next.variants = [
        ...(next.variants ?? []),
        { id, name, ...(patch ? { patch } : {}) },
      ];
      set({
        baseConfig: next,
        activeVariantId: id,
        config: resolveActive(next, id),
        dirty: true,
        result: null,
        resultConfig: null,
        resultDiary: null,
        selectedRunId: null,
        resultStale: false,
        ...syncText(next),
      });
      saveToLocalStorage(next);
      void activeVariantId;
      return id;
    },

    createVariantFrom: (name, config) => {
      pushHistory();
      const { baseConfig } = get();
      const id = createId(
        "VAR",
        new Set((baseConfig.variants ?? []).map((v) => v.id)),
      );
      const patch = diffVariant(applyVariant(baseConfig, null), config);
      const next = cloneConfig(baseConfig);
      next.variants = [
        ...(next.variants ?? []),
        { id, name, ...(patch ? { patch } : {}) },
      ];
      set({
        baseConfig: next,
        activeVariantId: id,
        config: resolveActive(next, id),
        dirty: true,
        ...syncText(next),
      });
      saveToLocalStorage(next);
      return id;
    },

    renameVariant: (id, name) => {
      const trimmed = name.trim();
      const { baseConfig } = get();
      const existing = (baseConfig.variants ?? []).find((v) => v.id === id);
      if (!existing || trimmed.length === 0 || trimmed === existing.name)
        return;
      pushHistory();
      const next = cloneConfig(baseConfig);
      next.variants = (next.variants ?? []).map((v) =>
        v.id === id ? { ...v, name: trimmed } : v,
      );
      set({ baseConfig: next, dirty: true, ...syncText(next) });
      saveToLocalStorage(next);
    },

    duplicateVariant: (id) => {
      pushHistory();
      const { baseConfig } = get();
      const source = (baseConfig.variants ?? []).find((v) => v.id === id);
      const newId = createId(
        "VAR",
        new Set((baseConfig.variants ?? []).map((v) => v.id)),
      );
      const next = cloneConfig(baseConfig);
      next.variants = [
        ...(next.variants ?? []),
        {
          id: newId,
          name: `${source?.name ?? "Base"} copy`,
          ...(source?.patch ? { patch: structuredClone(source.patch) } : {}),
        },
      ];
      set({
        baseConfig: next,
        activeVariantId: newId,
        config: resolveActive(next, newId),
        dirty: true,
        result: null,
        resultConfig: null,
        resultDiary: null,
        selectedRunId: null,
        resultStale: false,
        ...syncText(next),
      });
      saveToLocalStorage(next);
      return newId;
    },

    deleteVariant: (id) => {
      const { baseConfig, activeVariantId, runHistory } = get();
      if (!(baseConfig.variants ?? []).some((v) => v.id === id)) return;
      pushHistory();
      const next = cloneConfig(baseConfig);
      const remaining = (next.variants ?? []).filter((v) => v.id !== id);
      if (remaining.length > 0) next.variants = remaining;
      else delete next.variants;
      // Its runs go with it: a run whose variant no longer exists cannot be
      // reproduced or meaningfully compared.
      const history = runHistory.filter((r) => r.variantId !== id);
      const wasActive = activeVariantId === id;
      const nextActive = wasActive ? null : activeVariantId;
      set({
        baseConfig: next,
        activeVariantId: nextActive,
        config: resolveActive(next, nextActive),
        runHistory: history,
        selectedRunId: history.some((r) => r.id === get().selectedRunId)
          ? get().selectedRunId
          : null,
        baselineRunId: history.some((r) => r.id === get().baselineRunId)
          ? get().baselineRunId
          : null,
        ...(wasActive
          ? {
              result: null,
              resultConfig: null,
              resultDiary: null,
              resultStale: false,
            }
          : {}),
        dirty: true,
        ...syncText(next),
      });
      saveToLocalStorage(next);
    },
    beginPreparation: (operation) => {
      if (get().preparingOperation || get().running) return false;
      set({ preparingOperation: operation });
      return true;
    },
    endPreparation: (operation) => {
      if (get().preparingOperation === operation)
        set({ preparingOperation: null });
    },

    loadExample: (name) => {
      const ex = examples[name];
      if (!ex) return;
      pushHistory();
      // Presentation-only: stretch physically-scaled layouts (chilldown
      // validation models carry meters in x) to a readable canvas pitch.
      const cloned = normalizeCanvasLayout(cloneConfig(ex));
      set({
        ...adoptFile(cloned),
        ...clearedSession(),
        configEpoch: get().configEpoch + 1,
      });
    },

    newNetwork: () => {
      pushHistory();
      const cfg = cloneConfig(defaultConfig);
      set({
        ...adoptFile(cfg),
        ...clearedSession(),
        configEpoch: get().configEpoch + 1,
      });
    },

    newNetworkFrom: (config) => {
      pushHistory();
      const cfg = normalizeCanvasLayout(cloneConfig(config));
      set({
        ...adoptFile(cfg),
        ...clearedSession(),
        configEpoch: get().configEpoch + 1,
      });
    },

    setConfig: (config) => {
      pushHistory();
      // Presentation-only layout normalization (idempotent — see
      // canvasLayout.ts); fixes legacy saved files with physical-scale x.
      const laidOut = normalizeCanvasLayout(config);
      set({
        ...adoptFile(laidOut),
        // Loading a file is a new model session: its runs are the only ones
        // that belong in Analysis.
        ...clearedSession(),
        dirty: true,
        configEpoch: get().configEpoch + 1,
      });
    },

    setModelText: (text) => {
      const result = parseText(text);
      const parsed = result.config;
      if (parsed === undefined || result.errors.length > 0) {
        // Invalid in-progress text: retain the typed draft and expose the
        // diagnostics, but NEVER mutate config or history.
        set({ textDraft: text, textDiagnostics: result.errors });
        return false;
      }
      const canonical = serializeText(parsed);
      if (canonical === get().modelText) {
        // Formatting-only edit: the text already denotes the current config.
        set({ textDraft: get().modelText, textDiagnostics: [] });
        return true;
      }
      // Wholesale replacement as exactly one undoable history entry.  The
      // canonical text is reserialized from the parsed config (not the raw
      // input), preserving the modelText === serializeText(config) invariant.
      pushHistory();
      const patch: Partial<StoreState> = {};
      if (!selectionExistsIn(get().selection, parsed)) {
        patch.selection = { kind: "none" };
      }
      // Wholesale replacement can remove groups with open tabs; reconcile
      // exactly like removeGroup does.
      const tabs = get().openGroupTabs.filter((id) =>
        (parsed.groups ?? []).some((g) => g.id === id),
      );
      let activeGroupTab = get().activeGroupTab;
      if (activeGroupTab && !tabs.includes(activeGroupTab)) {
        activeGroupTab = tabs.length > 0 ? tabs[tabs.length - 1] : null;
      }
      if (
        tabs.length !== get().openGroupTabs.length ||
        activeGroupTab !== get().activeGroupTab
      ) {
        patch.openGroupTabs = tabs;
        patch.activeGroupTab = activeGroupTab;
      }
      // The text IS the file, so it replaces the base network and its
      // variant list. Keep the active variant only if the new text still
      // defines it; run history survives (staleness is judged by hash).
      const activeVariantId =
        get().activeVariantId !== null &&
        (parsed.variants ?? []).some((v) => v.id === get().activeVariantId)
          ? get().activeVariantId
          : null;
      set({
        baseConfig: parsed,
        activeVariantId,
        config: resolveActive(parsed, activeVariantId),
        resultStale: true,
        dirty: true,
        modelText: canonical,
        textDraft: canonical,
        textDiagnostics: [],
        ...patch,
      });
      saveToLocalStorage(parsed);
      return true;
    },

    revertModelText: () => {
      set({ textDraft: get().modelText, textDiagnostics: [] });
    },

    updateMeta: (patch) => {
      if (
        Object.entries(patch).every(
          ([key, value]) =>
            get().config.meta[key as keyof NetworkConfig["meta"]] === value,
        )
      )
        return;
      pushHistory();
      const cfg = cloneConfig(get().config);
      cfg.meta = { ...cfg.meta, ...patch };
      commitConfig(cfg);
    },

    updateNode: (id, patch) => {
      if (!get().config.nodes.some((n) => n.id === id)) return;
      pushHistory();
      const cfg = cloneConfig(get().config);
      const idx = cfg.nodes.findIndex((n) => n.id === id);
      cfg.nodes[idx] = withoutUndefined({ ...cfg.nodes[idx], ...patch });
      commitConfig(cfg);
    },

    updateBranch: (id, patch) => {
      if (!get().config.branches.some((b) => b.id === id)) return;
      pushHistory();
      const cfg = cloneConfig(get().config);
      const idx = cfg.branches.findIndex((b) => b.id === id);
      cfg.branches[idx] = withoutUndefined({ ...cfg.branches[idx], ...patch });
      commitConfig(cfg);
    },

    updateSolidNode: (id, patch) => {
      if (!(get().config.solidNodes ?? []).some((n) => n.id === id)) return;
      pushHistory();
      const cfg = cloneConfig(get().config);
      if (!cfg.solidNodes) cfg.solidNodes = [];
      const idx = cfg.solidNodes.findIndex((n) => n.id === id);
      cfg.solidNodes[idx] = withoutUndefined({
        ...cfg.solidNodes[idx],
        ...patch,
      });
      commitConfig(cfg);
    },

    updateConductor: (id, patch) => {
      if (!(get().config.conductors ?? []).some((c) => c.id === id)) return;
      pushHistory();
      const cfg = cloneConfig(get().config);
      if (!cfg.conductors) cfg.conductors = [];
      const idx = cfg.conductors.findIndex((c) => c.id === id);
      cfg.conductors[idx] = withoutUndefined({
        ...cfg.conductors[idx],
        ...patch,
      });
      commitConfig(cfg);
    },

    upsertJunction: (junction) => {
      if (!get().config.nodes.some((n) => n.id === junction.node)) return;
      pushHistory();
      const cfg = cloneConfig(get().config);
      const list = cfg.junctions ?? [];
      const idx = list.findIndex((j) => j.node === junction.node);
      if (idx >= 0) list[idx] = junction;
      else list.push(junction);
      cfg.junctions = list;
      commitConfig(cfg);
    },

    removeJunction: (nodeId) => {
      if (!(get().config.junctions ?? []).some((j) => j.node === nodeId))
        return;
      pushHistory();
      const cfg = cloneConfig(get().config);
      cfg.junctions = (cfg.junctions ?? []).filter((j) => j.node !== nodeId);
      if (cfg.junctions.length === 0) delete cfg.junctions;
      commitConfig(cfg);
    },

    updateEntities: (updates) => {
      const current = get().config;
      const exists = (u: EntityUpdate): boolean => {
        switch (u.kind) {
          case "node":
            return current.nodes.some((n) => n.id === u.id);
          case "branch":
            return current.branches.some((b) => b.id === u.id);
          case "solidNode":
            return (current.solidNodes ?? []).some((n) => n.id === u.id);
          case "conductor":
            return (current.conductors ?? []).some((c) => c.id === u.id);
        }
      };
      const applicable = updates.filter(exists);
      if (applicable.length === 0) return;
      pushHistory();
      const cfg = cloneConfig(get().config);
      for (const u of applicable) {
        if (u.kind === "node") {
          const idx = cfg.nodes.findIndex((n) => n.id === u.id);
          cfg.nodes[idx] = { ...cfg.nodes[idx], ...u.patch };
        } else if (u.kind === "branch") {
          const idx = cfg.branches.findIndex((b) => b.id === u.id);
          cfg.branches[idx] = { ...cfg.branches[idx], ...u.patch };
        } else if (u.kind === "solidNode") {
          const idx = cfg.solidNodes!.findIndex((n) => n.id === u.id);
          cfg.solidNodes![idx] = { ...cfg.solidNodes![idx], ...u.patch };
        } else {
          const idx = cfg.conductors!.findIndex((c) => c.id === u.id);
          cfg.conductors![idx] = { ...cfg.conductors![idx], ...u.patch };
        }
      }
      commitConfig(cfg);
    },

    updateSettings: (patch) => {
      pushHistory();
      const cfg = cloneConfig(get().config);
      // A cleared control drops the key so the text projection, the provenance
      // hash, and solver defaulting all see the same config a network that
      // never carried the field would produce.
      cfg.settings = withoutUndefined({ ...cfg.settings, ...patch });
      commitConfig(cfg);
    },

    setClosureParam: (group, key, value) => {
      if (group !== "solidCpScale" && key === null) return;
      pushHistory();
      const cfg = cloneConfig(get().config);
      const closure: Record<string, unknown> = { ...(cfg.closureParams ?? {}) };
      if (group === "solidCpScale") {
        if (value === undefined) delete closure.solidCpScale;
        else closure.solidCpScale = value;
      } else {
        const members: Record<string, number> = {
          ...((closure[group] as Record<string, number> | undefined) ?? {}),
        };
        if (value === undefined) delete members[key!];
        else members[key!] = value;
        if (Object.keys(members).length === 0) delete closure[group];
        else closure[group] = members;
      }
      if (Object.keys(closure).length === 0) delete cfg.closureParams;
      else cfg.closureParams = closure as NetworkConfig["closureParams"];
      commitConfig(cfg);
    },

    updateSpecies: (species) => {
      pushHistory();
      const cfg = cloneConfig(get().config);
      // Node mass fractions name species by key, so a removed or renamed
      // species must not leave an orphaned fraction behind.
      const known =
        species && species.names.length > 0 ? new Set(species.names) : null;
      if (known) cfg.species = species;
      else delete cfg.species;
      cfg.nodes = cfg.nodes.map((node) => {
        if (!node.massFractions) return node;
        const next = { ...node };
        const kept = known
          ? Object.fromEntries(
              Object.entries(node.massFractions).filter(([name]) =>
                known.has(name),
              ),
            )
          : {};
        if (Object.keys(kept).length === 0) delete next.massFractions;
        else next.massFractions = kept;
        return next;
      });
      commitConfig(cfg);
    },

    updateFluid: (patch) => {
      pushHistory();
      const cfg = cloneConfig(get().config);
      cfg.fluid = { ...cfg.fluid, ...patch };
      commitConfig(cfg);
    },

    setNamedFluid: (name, fluid) => {
      const trimmed = name.trim();
      if (!trimmed) return;
      pushHistory();
      const cfg = cloneConfig(get().config);
      cfg.fluids = { ...cfg.fluids, [trimmed]: fluid };
      commitConfig(cfg);
    },

    renameNamedFluid: (name, nextName) => {
      const src = name.trim();
      const dest = nextName.trim();
      if (!src || !dest || src === dest) return;
      const cfg0 = get().config;
      if (!cfg0.fluids?.[src] || cfg0.fluids[dest]) return;
      pushHistory();
      const cfg = cloneConfig(get().config);
      const fluids = { ...cfg.fluids };
      fluids[dest] = fluids[src];
      delete fluids[src];
      cfg.fluids = fluids;
      cfg.nodes = cfg.nodes.map((n) =>
        n.fluid === src ? { ...n, fluid: dest } : n,
      );
      commitConfig(cfg);
    },

    removeNamedFluid: (name) => {
      const key = name.trim();
      if (!key || !get().config.fluids?.[key]) return;
      pushHistory();
      const cfg = cloneConfig(get().config);
      const fluids = { ...cfg.fluids };
      delete fluids[key];
      if (Object.keys(fluids).length === 0) delete cfg.fluids;
      else cfg.fluids = fluids;
      cfg.nodes = cfg.nodes.map((n) => {
        if (n.fluid !== key) return n;
        const next = { ...n };
        delete next.fluid;
        return next;
      });
      commitConfig(cfg);
    },

    updateAdvancedSection: (section, value) => {
      pushHistory();
      const cfg = cloneConfig(get().config);
      if (section === "registers")
        cfg.registers = value as NetworkConfig["registers"];
      else if (section === "logic") cfg.logic = value as NetworkConfig["logic"];
      else cfg.controllers = value as NetworkConfig["controllers"];
      commitConfig(cfg);
    },

    updateEmbeddedComponentFromLocal: (branchId, component) => {
      const branch = get().config.branches.find((item) => item.id === branchId);
      if (
        !branch ||
        branch.component.type !== "userComponent" ||
        branch.component.component !== component.key
      )
        return;
      pushHistory();
      const cfg = cloneConfig(get().config);
      cfg.componentLibrary ??= {};
      cfg.componentLibrary[component.key] = {
        code: component.source,
        format: "defineComponent",
        metadata: component.metadata,
      };
      for (const next of cfg.branches) {
        if (
          next.component.type !== "userComponent" ||
          next.component.component !== component.key
        )
          continue;
        const current = next.component;
        current.params = Object.fromEntries(
          (component.metadata.params ?? []).map((param) => [
            param.name,
            current.params?.[param.name] ?? param.default,
          ]),
        );
      }
      commitConfig(cfg);
    },

    addNode: (node) => {
      pushHistory();
      const cfg = cloneConfig(get().config);
      cfg.nodes.push(node);
      commitConfig(cfg);
    },

    addBranch: (branch, libraryEntry) => {
      pushHistory();
      const cfg = cloneConfig(get().config);
      if (libraryEntry) {
        cfg.componentLibrary ??= {};
        cfg.componentLibrary[libraryEntry.key] = libraryEntry.entry;
      }
      cfg.branches.push(branch);
      commitConfig(cfg);
    },

    addSolidNode: (node) => {
      pushHistory();
      const cfg = cloneConfig(get().config);
      if (!cfg.solidNodes) cfg.solidNodes = [];
      cfg.solidNodes.push(node);
      commitConfig(cfg);
    },

    addConductor: (conductor) => {
      pushHistory();
      const cfg = cloneConfig(get().config);
      if (!cfg.conductors) cfg.conductors = [];
      cfg.conductors.push(conductor);
      commitConfig(cfg);
    },

    removeNode: (id) => {
      pushHistory();
      const cfg = cloneConfig(get().config);
      cfg.nodes = cfg.nodes.filter((n) => n.id !== id);
      cfg.branches = cfg.branches.filter((b) => b.from !== id && b.to !== id);
      if (cfg.conductors) {
        cfg.conductors = cfg.conductors.filter(
          (c) => c.from !== id && c.to !== id,
        );
      }
      const sel = get().selection;
      if (
        (sel.kind === "node" && sel.id === id) ||
        (sel.kind === "branch" && cfg.branches.every((b) => b.id !== sel.id)) ||
        (sel.kind === "conductor" &&
          (cfg.conductors ?? []).every((c) => c.id !== sel.id))
      ) {
        set({ selection: { kind: "none" } });
      }
      commitConfig(cfg);
    },

    removeBranch: (id) => {
      pushHistory();
      const cfg = cloneConfig(get().config);
      cfg.branches = cfg.branches.filter((b) => b.id !== id);
      const sel = get().selection;
      if (sel.kind === "branch" && sel.id === id) {
        set({ selection: { kind: "none" } });
      }
      commitConfig(cfg);
    },

    removeSolidNode: (id) => {
      pushHistory();
      const cfg = cloneConfig(get().config);
      if (cfg.solidNodes) {
        cfg.solidNodes = cfg.solidNodes.filter((n) => n.id !== id);
      }
      if (cfg.conductors) {
        cfg.conductors = cfg.conductors.filter(
          (c) => c.from !== id && c.to !== id,
        );
      }
      const sel = get().selection;
      if (sel.kind === "solidNode" && sel.id === id) {
        set({ selection: { kind: "none" } });
      }
      if (
        sel.kind === "conductor" &&
        (cfg.conductors ?? []).every((c) => c.id !== sel.id)
      ) {
        set({ selection: { kind: "none" } });
      }
      commitConfig(cfg);
    },

    removeConductor: (id) => {
      pushHistory();
      const cfg = cloneConfig(get().config);
      if (cfg.conductors) {
        cfg.conductors = cfg.conductors.filter((c) => c.id !== id);
      }
      const sel = get().selection;
      if (sel.kind === "conductor" && sel.id === id) {
        set({ selection: { kind: "none" } });
      }
      commitConfig(cfg);
    },

    setSelection: (sel) =>
      set((state) => ({
        selection: sel,
        canvasSelection:
          sel.kind === "multi"
            ? state.canvasSelection
            : sel.kind === "node" || sel.kind === "solidNode"
              ? [sel.id]
              : [],
      })),
    setResult: (res) =>
      set({
        result: res,
        resultStale: false,
        // A fresh result belongs to the current config; null keeps historical
        // selections (selectRun) in control of resultConfig.
        resultConfig: res ? cloneConfig(get().config) : null,
        // A fresh/cleared result has no diary yet — never let a previous
        // run's diary alias onto a different result.  The run paths
        // re-attach the new diary right after (pushRunRecord/setResultDiary).
        resultDiary: null,
      }),
    setResultDiary: (diary) => set({ resultDiary: diary }),
    setValidationErrors: (errs) => set({ validationErrors: errs }),
    setFluidError: (msg) => set({ fluidError: msg }),
    setRunning: (v) => set({ running: v }),
    setActiveTab: (tab) =>
      set({
        activeTab: tab,
        activeGroupTab: null,
        // Leaving Setup returns it to its landing section, so it
        // always opens on Solver rather than wherever you last were.
        ...(tab === "config" ? {} : { settingsTab: "solver" as SettingsTabId }),
      }),
    setSettingsTab: (tab) => set({ settingsTab: tab }),

    addResultPlot: (mode) => {
      const plot = newPlot(mode);
      set({
        resultPlots: [...get().resultPlots, plot],
        activePlotId: plot.id,
      });
      return plot.id;
    },

    removeResultPlot: (id) => {
      const plots = get().resultPlots;
      const index = plots.findIndex((p) => p.id === id);
      if (index < 0) return;
      const next = plots.filter((p) => p.id !== id);
      // Closing the active tab lands on its neighbour, not on nothing.
      const active =
        get().activePlotId === id
          ? ((next[index] ?? next[index - 1])?.id ?? null)
          : get().activePlotId;
      set({ resultPlots: next, activePlotId: active });
    },

    setActiveResultPlot: (id) => {
      if (!get().resultPlots.some((p) => p.id === id)) return;
      set({ activePlotId: id });
    },

    updateResultPlot: (id, patch) =>
      set({
        resultPlots: get().resultPlots.map((p) =>
          p.id === id ? { ...p, ...patch, id: p.id } : p,
        ),
      }),

    seedResultPlot: (plot) => {
      if (get().resultPlots.length > 0) return;
      set({ resultPlots: [plot], activePlotId: plot.id });
    },
    setShowCommandPalette: (v) => set({ showCommandPalette: v }),
    setBranchTool: (t) =>
      set({
        branchTool:
          resolveBranchTool(t, getComponentLibrarySnapshot().components)
            .kind === "stale-local"
            ? null
            : t,
        pendingSourceNodeId: null,
      }),
    setConductorTool: (t) =>
      set({ conductorTool: t, pendingConductorSourceId: null }),
    setPendingSourceNodeId: (id) => set({ pendingSourceNodeId: id }),
    setPendingConductorSourceId: (id) => set({ pendingConductorSourceId: id }),
    setColorBy: (colorBy) => set({ colorBy }),
    setColorDomainOverride: (colorBy, domain) => {
      const overrides = { ...get().colorDomainOverrides };
      if (domain === null) delete overrides[colorBy];
      else overrides[colorBy] = domain;
      set({ colorDomainOverrides: overrides });
    },
    setTimeIndex: (timeIndex) => set({ timeIndex }),
    setResultSigFigs: (n) => {
      set({ resultSigFigs: n });
      saveSigFigs(n);
    },
    setCanvasViewport: (vp) => set({ canvasViewport: vp }),
    setShowLabels: (showLabels) => {
      set({ showLabels });
      saveShowLabels(showLabels);
    },
    setCanvasVisibility: (patch) => {
      const next = { ...get().canvasVisibility, ...patch };
      set({ canvasVisibility: next });
      saveCanvasVisibility(next);
    },
    setCanvasView: (canvasView) => set({ canvasView }),
    setCamera3d: (camera) => set({ camera3d: normalizeCamera(camera) }),
    setCanvasSelection: (ids) => set({ canvasSelection: ids }),

    openGroupTab: (groupId) => {
      const tabs = get().openGroupTabs;
      if (!tabs.includes(groupId)) {
        set({
          openGroupTabs: [...tabs, groupId],
          activeGroupTab: groupId,
          activeTab: "editor",
        });
      } else {
        set({ activeGroupTab: groupId, activeTab: "editor" });
      }
    },

    closeGroupTab: (groupId) => {
      const tabs = get().openGroupTabs.filter((id) => id !== groupId);
      let active = get().activeGroupTab;
      if (active === groupId) {
        active = tabs.length > 0 ? tabs[tabs.length - 1] : null;
      }
      set({ openGroupTabs: tabs, activeGroupTab: active });
    },

    setActiveGroupTab: (groupId) => {
      set({ activeGroupTab: groupId });
    },

    addGroup: (group, nodeIds) => {
      pushHistory();
      const cfg = cloneConfig(get().config);
      if (!cfg.groups) cfg.groups = [];
      cfg.groups.push(group);
      if (nodeIds) {
        for (const nid of nodeIds) {
          const n = cfg.nodes.find((n) => n.id === nid);
          if (n) n.group = group.id;
          const s = cfg.solidNodes?.find((n) => n.id === nid);
          if (s) s.group = group.id;
        }
      }
      commitConfig(cfg);
    },

    removeGroup: (groupId) => {
      pushHistory();
      const cfg = cloneConfig(get().config);
      cfg.groups = (cfg.groups ?? []).filter((g) => g.id !== groupId);
      for (const n of cfg.nodes) {
        if (n.group === groupId) delete n.group;
      }
      for (const n of cfg.solidNodes ?? []) {
        if (n.group === groupId) delete n.group;
      }
      for (const note of cfg.notes ?? []) {
        if (note.group === groupId) delete note.group;
      }
      const tabs = get().openGroupTabs.filter((id) => id !== groupId);
      let active = get().activeGroupTab;
      if (active === groupId)
        active = tabs.length > 0 ? tabs[tabs.length - 1] : null;
      const selection = get().selection;
      set({
        openGroupTabs: tabs,
        activeGroupTab: active,
        ...(selection.kind === "group" && selection.id === groupId
          ? { selection: { kind: "none" } as Selection }
          : {}),
      });
      commitConfig(cfg);
    },

    updateGroup: (id, patch) => {
      if (!(get().config.groups ?? []).some((g) => g.id === id)) return;
      pushHistory();
      const cfg = cloneConfig(get().config);
      const idx = (cfg.groups ?? []).findIndex((g) => g.id === id);
      cfg.groups![idx] = { ...cfg.groups![idx], ...patch };
      commitConfig(cfg);
    },

    // Notes are annotations: every note path commits with stale: false so
    // writing documentation never invalidates displayed results.
    addNote: (note) => {
      pushHistory();
      const cfg = cloneConfig(get().config);
      if (!cfg.notes) cfg.notes = [];
      cfg.notes.push(note);
      commitConfig(cfg, { stale: false });
    },

    removeNote: (id) => {
      pushHistory();
      const cfg = cloneConfig(get().config);
      cfg.notes = (cfg.notes ?? []).filter((n) => n.id !== id);
      const sel = get().selection;
      if (sel.kind === "note" && sel.id === id) {
        set({ selection: { kind: "none" } });
      }
      commitConfig(cfg, { stale: false });
    },

    updateNote: (id, patch) => {
      const current = (get().config.notes ?? []).find((n) => n.id === id);
      if (!current) return;
      // Committing an identical value would burn an undo slot per keystroke
      // for a field the user edits character by character.
      if (
        Object.entries(patch).every(
          ([key, value]) => current[key as keyof typeof current] === value,
        )
      )
        return;
      pushHistory();
      const cfg = cloneConfig(get().config);
      const idx = (cfg.notes ?? []).findIndex((n) => n.id === id);
      const next = { ...cfg.notes![idx], ...patch };
      // An explicit `undefined` in the patch means "unset" (clearing the width
      // or height field returns the card to auto-sizing), not "store undefined".
      for (const key of Object.keys(patch) as Array<keyof typeof patch>) {
        if (patch[key] === undefined) delete next[key];
      }
      cfg.notes![idx] = next;
      commitConfig(cfg, { stale: false });
    },

    reorderEntity: (kind, fromIndex, toIndex) => {
      const key = (
        {
          node: "nodes",
          branch: "branches",
          solidNode: "solidNodes",
          conductor: "conductors",
          note: "notes",
        } as const
      )[kind];
      const current = get().config[key];
      if (!Array.isArray(current)) return;
      if (
        fromIndex === toIndex ||
        fromIndex < 0 ||
        toIndex < 0 ||
        fromIndex >= current.length ||
        toIndex >= current.length
      )
        return;
      pushHistory();
      const cfg = cloneConfig(get().config);
      const list = cfg[key] as unknown[];
      const [moved] = list.splice(fromIndex, 1);
      list.splice(toIndex, 0, moved);
      commitConfig(cfg, { stale: false });
    },

    moveNodesToGroup: (nodeIds, groupId) => {
      pushHistory();
      const cfg = cloneConfig(get().config);
      for (const nid of nodeIds) {
        const n = cfg.nodes.find((n) => n.id === nid);
        if (n) {
          if (groupId === undefined) {
            delete n.group;
          } else {
            n.group = groupId;
          }
        }
      }
      commitConfig(cfg);
    },

    moveSolidNodesToGroup: (nodeIds, groupId) => {
      pushHistory();
      const cfg = cloneConfig(get().config);
      for (const nid of nodeIds) {
        const n = cfg.solidNodes?.find((n) => n.id === nid);
        if (n) {
          if (groupId === undefined) {
            delete n.group;
          } else {
            n.group = groupId;
          }
        }
      }
      commitConfig(cfg);
    },

    setUnitPreferences: (prefs) => {
      set({ unitPreferences: prefs });
      saveUnitPreferences(prefs);
    },
    setUnitPreference: (kind, unitId) => {
      const prefs = { ...get().unitPreferences, [kind]: unitId };
      set({ unitPreferences: prefs });
      saveUnitPreferences(prefs);
    },
    setUnitPreset: (presetName) => {
      const preset = PRESETS[presetName];
      if (!preset) return;
      const prefs = { ...preset };
      set({ unitPreferences: prefs });
      saveUnitPreferences(prefs);
    },
    persist: () => saveToLocalStorage(get().baseConfig),
    setRunStatus: (status) => {
      const running = status === "loadingFluids" || status === "running";
      set({ runStatus: status, running });
    },
    setRunProgress: (progress) => set({ runProgress: progress }),
    setLiveResult: (result) => set({ liveResult: result }),

    // ── Run history (ring buffer, newest last) ─────────────────────────
    pushRunRecord: ({ result, config, diary }) => {
      const seq = get().runSeq + 1;
      // Deep-clone the diary on intake (diaries are plain JSON data), same
      // intake-clone semantics as the config snapshot: later caller-side
      // mutation can never alias into the record.
      const variantId = get().activeVariantId;
      const record = makeRunRecord(
        seq,
        cloneConfig(config),
        result,
        Date.now(),
        diary ? (structuredClone(diary) as RunDiary) : undefined,
        variantId,
      );
      let history = [...get().runHistory, record];
      let baselineRunId = get().baselineRunId;
      // The cap is per variant: a variant you are iterating on hard must not
      // evict the runs of the variant you are comparing it against.
      const ownRuns = history.filter((r) => r.variantId === variantId);
      if (ownRuns.length > RUN_HISTORY_CAP) {
        const dropped = new Set(
          ownRuns.slice(0, ownRuns.length - RUN_HISTORY_CAP).map((r) => r.id),
        );
        history = history.filter((r) => !dropped.has(r.id));
        if (baselineRunId && dropped.has(baselineRunId)) baselineRunId = null;
      }
      const baseline = baselineRunId
        ? history.find((item) => item.id === baselineRunId)
        : null;
      if (baseline && !checkRunCompatibility(record, baseline).ok)
        baselineRunId = null;
      set({
        runHistory: history,
        runSeq: seq,
        selectedRunId: record.id,
        baselineRunId,
        resultConfig: record.config,
        // Pushing selects the new record — its diary becomes current.
        resultDiary: record.diary ?? null,
      });
      // Mirror to localStorage so a reload keeps the session's results; the
      // portable copy is the `.runs.json` file that Save writes.
      persistRuns(get().baseConfig, history);
    },

    selectRun: (id) => {
      if (id === null) {
        // Deselect only clears the pointer; the displayed result (and its
        // diary) stay, exactly like result/resultConfig today.
        set({ selectedRunId: null });
        return;
      }
      const record = get().runHistory.find((r) => r.id === id);
      if (!record) return;
      const baseline = get().baselineRunId
        ? get().runHistory.find((r) => r.id === get().baselineRunId)
        : null;
      // Staleness is judged against the record's OWN variant as it stands
      // now, not against whatever variant happens to be active: viewing a
      // run from another variant for comparison must not brand it stale.
      const owningConfig = resolveActive(get().baseConfig, record.variantId);
      set({
        selectedRunId: id,
        result: record.result,
        resultConfig: record.config,
        // Restore the record's diary (legacy records have none → null).
        resultDiary: record.diary ?? null,
        resultStale: record.configHash !== configHash(owningConfig),
        baselineRunId:
          baseline && checkRunCompatibility(record, baseline).ok
            ? baseline.id
            : null,
      });
    },

    renameRun: (id, name) => {
      const trimmed = name.trim();
      if (!trimmed) return;
      const history = get().runHistory.map((r) =>
        r.id === id ? { ...r, name: trimmed } : r,
      );
      set({ runHistory: history });
      persistRuns(get().baseConfig, history);
    },

    deleteRun: (id) => {
      const { runHistory, selectedRunId, baselineRunId } = get();
      const history = runHistory.filter((r) => r.id !== id);
      const replacement =
        selectedRunId === id ? (history[history.length - 1] ?? null) : null;
      set({
        runHistory: history,
        selectedRunId:
          replacement?.id ?? (selectedRunId === id ? null : selectedRunId),
        baselineRunId: baselineRunId === id ? null : baselineRunId,
        ...(selectedRunId === id
          ? {
              result: replacement?.result ?? null,
              resultConfig: replacement?.config ?? null,
              resultDiary: replacement?.diary ?? null,
              resultStale: replacement
                ? replacement.configHash !== configHash(get().config)
                : false,
            }
          : {}),
      });
      persistRuns(get().baseConfig, history);
    },

    /**
     * Discard every run. Results are regenerable and now survive a reload, so
     * without this the only way to clear an accumulated history was to load a
     * different model. The displayed result goes too: leaving it on screen
     * with no record behind it is the confusing half-state.
     */
    discardRuns: () => {
      clearRunsLocalStorage();
      set(clearedRunState());
    },

    setBaselineRunId: (id) => {
      if (id === null) return set({ baselineRunId: null });
      const current = get().runHistory.find(
        (run) => run.id === get().selectedRunId,
      );
      const candidate = get().runHistory.find((run) => run.id === id);
      if (current && candidate && checkRunCompatibility(current, candidate).ok)
        set({ baselineRunId: id });
    },

    requestCanvasFocus: (kind, id) =>
      set({
        canvasFocusRequest: {
          kind,
          id,
          nonce: (get().canvasFocusRequest?.nonce ?? 0) + 1,
        },
      }),
    clearCanvasFocusRequest: () => set({ canvasFocusRequest: null }),

    // ── Duplication (Ctrl/Cmd+D) ────────────────────────────────────────
    repeatSelection: (opts) => {
      const { config, selection, canvasSelection } = get();
      if (!Number.isInteger(opts.count) || opts.count < 2) {
        set({
          duplicateNotice: `Cannot repeat: count must be an integer of at least 2 (got ${String(opts.count)})`,
        });
        return null;
      }
      const repeatable = analyzeRepeatSelection(
        config,
        selection,
        canvasSelection,
      );
      if (!repeatable.canRepeat) {
        set({
          duplicateNotice: `Cannot repeat: ${repeatable.reason ?? "the selection is not a repeatable unit"}`,
        });
        return null;
      }
      const result = repeatUnit(config, {
        members: repeatable.members,
        seamBranch: repeatable.seamBranch,
        count: opts.count,
        linkParams: opts.linkParams,
        canvasOffset: opts.canvasOffset ?? { x: 30, y: 30 },
        ...(opts.physicalOffset ? { physicalOffset: opts.physicalOffset } : {}),
        crossingConductors: "share",
      });
      if (!result.ok) {
        // A failed no-op burns no undo entry.
        set({ duplicateNotice: `Cannot repeat: ${result.error}` });
        return null;
      }
      pushHistory();
      commitConfig(result.config);
      const counts: RepeatCounts = {
        nodes: result.created.nodes.length,
        solidNodes: result.created.solidNodes.length,
        branches: result.created.branches.length,
        conductors: result.created.conductors.length,
      };
      // Panel selection mirrors duplicateSelection: exactly one created node
      // selects it (the count: 2 single-member case IS a duplicate); a
      // multi-instance repeat keeps the panel on the template, which is the
      // sweepable/editable instance 1 whenever parameters are linked.
      const newNodeIds = [
        ...result.created.nodes,
        ...result.created.solidNodes,
      ];
      const only = newNodeIds.length === 1 ? newNodeIds[0] : undefined;
      set({
        canvasSelection: newNodeIds,
        duplicateNotice: `Repeated unit ${opts.count}×: ${formatRepeatCounts(counts)}`,
        ...(only
          ? {
              selection: {
                kind: result.config.nodes.some((n) => n.id === only)
                  ? ("node" as const)
                  : ("solidNode" as const),
                id: only,
              },
            }
          : {}),
      });
      return counts;
    },

    splitBranch: (branchId, segments, opts) => {
      const result = splitPipeBranch(get().config, branchId, segments, opts);
      if (!result.ok) {
        // A failed no-op burns no undo entry.
        set({ duplicateNotice: `Cannot split branch: ${result.error}` });
        return null;
      }
      pushHistory();
      commitConfig(result.config);
      const counts: RepeatCounts = {
        nodes: result.created.nodes.length,
        solidNodes: result.created.solidNodes.length,
        branches: result.created.branches.length,
        conductors: result.created.conductors.length,
      };
      set({
        canvasSelection: [
          ...result.created.nodes,
          ...result.created.solidNodes,
        ],
        duplicateNotice: `Split ${branchId} into ${segments} segments: ${formatRepeatCounts(counts)}`,
      });
      return counts;
    },

    duplicateSelection: () => {
      const { config, canvasSelection, selection } = get();
      const nodeIdSet = new Set(config.nodes.map((n) => n.id));
      const solidIdSet = new Set((config.solidNodes ?? []).map((n) => n.id));

      // Targets: canvas multi-selection, else a single panel-selected node.
      let targetIds = canvasSelection.filter(
        (id) => nodeIdSet.has(id) || solidIdSet.has(id),
      );
      if (
        targetIds.length === 0 &&
        (selection.kind === "node" || selection.kind === "solidNode") &&
        (nodeIdSet.has(selection.id) || solidIdSet.has(selection.id))
      ) {
        targetIds = [selection.id];
      }

      // Single selected branch: duplicate as a parallel branch (endpoints are
      // explicit by construction — safe).
      if (targetIds.length === 0) {
        if (selection.kind !== "branch") return null;
        const src = config.branches.find((b) => b.id === selection.id);
        if (!src) return null;
        pushHistory();
        const cfg = cloneConfig(config);
        const newId = createId("b", new Set(cfg.branches.map((b) => b.id)));
        cfg.branches.push({
          ...src,
          component: JSON.parse(JSON.stringify(src.component)),
          id: newId,
          label: `${src.label || src.id} copy`,
        });
        commitConfig(cfg);
        set({
          selection: { kind: "branch", id: newId },
          duplicateNotice: "Duplicated 1 branch",
        });
        return { nodes: 0, branches: 1, conductors: 0 };
      }

      // Node duplication delegates to the core repeat primitive in Duplicate
      // mode (seamBranch: null): induced edges are cloned, crossings dropped,
      // +30/+30 canvas offset, literal copies (linkParams: false).  Rule 1
      // expression remapping now also retargets `{ expr }` references on the
      // copies to the copied members — previously a duplicated node whose
      // volume was e.g. `pipe('p1').volume` kept pointing at the ORIGINAL.
      // idStrategy: "firstFree" keeps Duplicate's long-established id naming
      // (j → j1, n12 → first free n<k>) rather than repeatUnit's per-instance
      // trailing-int bump, which is Repeat/Split's naming.
      const members = {
        nodes: targetIds.filter((id) => nodeIdSet.has(id)),
        solidNodes: targetIds.filter((id) => solidIdSet.has(id)),
      };
      const analysis = analyzeRepeatUnit(config, members);
      const result = repeatUnit(config, {
        members,
        seamBranch: null,
        count: 2,
        linkParams: false,
        canvasOffset: { x: 30, y: 30 },
        crossingConductors: "drop",
        idStrategy: "firstFree",
      });
      // Members were just validated against the config, so Duplicate mode
      // (which needs no seam) cannot fail — but never throw from an action.
      if (!analysis.ok || !result.ok) return null;
      pushHistory();
      const cfg = result.config;
      // Duplicate keeps its legacy "<label> copy" naming rather than
      // repeatUnit's id-remapping / trailing-int labels.
      applyDuplicateCopyLabels(config, cfg, members, analysis, result.created);
      commitConfig(cfg);
      const newNodeIds = [
        ...result.created.nodes,
        ...result.created.solidNodes,
      ];
      const branchCount = result.created.branches.length;
      const conductorCount = result.created.conductors.length;
      const parts: string[] = [];
      if (newNodeIds.length)
        parts.push(
          `${newNodeIds.length} node${newNodeIds.length === 1 ? "" : "s"}`,
        );
      if (branchCount)
        parts.push(`${branchCount} branch${branchCount === 1 ? "" : "es"}`);
      if (conductorCount)
        parts.push(
          `${conductorCount} conductor${conductorCount === 1 ? "" : "s"}`,
        );
      const only = newNodeIds.length === 1 ? newNodeIds[0] : undefined;
      set({
        canvasSelection: newNodeIds,
        duplicateNotice: `Duplicated ${parts.join(", ")}`,
        ...(only
          ? {
              selection: {
                kind: cfg.nodes.some((n) => n.id === only)
                  ? ("node" as const)
                  : ("solidNode" as const),
                id: only,
              },
            }
          : {}),
      });
      return {
        nodes: newNodeIds.length,
        branches: branchCount,
        conductors: conductorCount,
      };
    },
  };
});

// Keep encoded local tools valid synchronously with library publications. This
// prevents consumers that only understand built-in tools from seeing a stale ID.
subscribeComponentLibrary(() => {
  const state = useStore.getState();
  if (
    resolveBranchTool(
      state.branchTool,
      getComponentLibrarySnapshot().components,
    ).kind === "stale-local"
  ) {
    state.setBranchTool(null);
  }
});
