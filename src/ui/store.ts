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
import { configHash } from "./provenance";
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

export type AppTab = "editor" | "results" | "sweep";

/** Schematic pixels (the P&ID) vs. projected physical metres (the 3D view). */
export type CanvasView = "2d" | "3d";

/** Undo/redo history entry. Config already carries canvas positions (x/y). */
interface HistoryEntry {
  config: NetworkConfig;
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
  showSettings: boolean;
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
   *  shortcut announce identically. */
  duplicateNotice: string;
  /** True when config differs from the last New/Load/Save baseline. */
  dirty: boolean;
  preparingOperation: "save" | "run" | null;
  past: HistoryEntry[];
  future: HistoryEntry[];
  undo: () => void;
  redo: () => void;
  markSaved: (savedHash?: string) => void;
  beginPreparation: (operation: "save" | "run") => boolean;
  endPreparation: (operation: "save" | "run") => void;
  loadExample: (name: string) => void;
  newNetwork: () => void;
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
  setShowSettings: (v: boolean) => void;
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
  /** Snapshot the pre-mutation config onto the undo stack. */
  const pushHistory = () => {
    const { past, config } = get();
    const next = [...past, { config: cloneConfig(config) }];
    if (next.length > HISTORY_CAP) next.shift();
    set({ past: next, future: [] });
  };

  /**
   * Derived-text sync, applied by EVERY successful config-mutation path
   * (centralized here and in the wholesale replacements below): the
   * canonical text is reserialized from the new config, and any pending
   * invalid text draft + its diagnostics are dropped as stale.
   */
  const syncText = (cfg: NetworkConfig) => {
    const text = serializeText(cfg);
    return {
      modelText: text,
      textDraft: text,
      textDiagnostics: [] as ParseError[],
    };
  };

  /**
   * Common tail for every config mutation: persist + dirty + stale + text sync.
   *
   * `stale: false` is reserved for annotation-only edits (canvas notes), which
   * provably cannot change a solver answer — the solver never reads them and
   * they are excluded from the provenance hash.  Marking results stale for a
   * typo fix would train users to ignore the staleness signal.
   */
  const commitConfig = (cfg: NetworkConfig, options?: { stale?: boolean }) => {
    const stale = options?.stale ?? true;
    set({
      config: cfg,
      dirty: true,
      ...(stale ? { resultStale: true } : {}),
      ...syncText(cfg),
    });
    saveToLocalStorage(cfg);
  };

  return {
    config: initialConfig,
    selection: { kind: "none" },
    result: null,
    resultConfig: null,
    validationErrors: [],
    fluidError: null,
    running: false,
    runStatus: "idle",
    runProgress: null,
    liveResult: null,
    activeTab: "editor",
    showSettings: false,
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
    resultStale: false,
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
    runHistory: [],
    runSeq: 0,
    selectedRunId: null,
    baselineRunId: null,
    resultDiary: null,
    canvasFocusRequest: null,
    duplicateNotice: "",
    dirty: false,
    preparingOperation: null,
    past: [],
    future: [],

    undo: () => {
      const { past, future, config } = get();
      if (past.length === 0) return;
      const prev = past[past.length - 1];
      set({
        past: past.slice(0, -1),
        future: [{ config: cloneConfig(config) }, ...future].slice(
          0,
          HISTORY_CAP,
        ),
        config: prev.config,
        selection: { kind: "none" },
        resultStale: true,
        dirty: true,
        ...syncText(prev.config),
      });
      saveToLocalStorage(prev.config);
    },

    redo: () => {
      const { past, future, config } = get();
      if (future.length === 0) return;
      const next = future[0];
      set({
        past: [...past, { config: cloneConfig(config) }].slice(-HISTORY_CAP),
        future: future.slice(1),
        config: next.config,
        selection: { kind: "none" },
        resultStale: true,
        dirty: true,
        ...syncText(next.config),
      });
      saveToLocalStorage(next.config);
    },

    markSaved: (savedHash) => {
      if (savedHash === undefined || configHash(get().config) === savedHash)
        set({ dirty: false });
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
        config: cloned,
        selection: { kind: "none" },
        result: null,
        resultConfig: null,
        resultDiary: null,
        selectedRunId: null,
        validationErrors: [],
        openGroupTabs: [],
        activeGroupTab: null,
        activeTab: "editor",
        resultStale: false,
        dirty: false,
        configEpoch: get().configEpoch + 1,
        ...syncText(cloned),
      });
      saveToLocalStorage(cloned);
    },

    newNetwork: () => {
      pushHistory();
      const cfg = cloneConfig(defaultConfig);
      set({
        config: cfg,
        selection: { kind: "none" },
        result: null,
        resultConfig: null,
        resultDiary: null,
        validationErrors: [],
        openGroupTabs: [],
        activeGroupTab: null,
        activeTab: "editor",
        resultStale: false,
        dirty: false,
        configEpoch: get().configEpoch + 1,
        ...syncText(cfg),
      });
      saveToLocalStorage(cfg);
    },

    setConfig: (config) => {
      pushHistory();
      // Presentation-only layout normalization (idempotent — see
      // canvasLayout.ts); fixes legacy saved files with physical-scale x.
      const laidOut = normalizeCanvasLayout(config);
      set({
        config: laidOut,
        resultStale: true,
        dirty: true,
        configEpoch: get().configEpoch + 1,
        ...syncText(laidOut),
      });
      saveToLocalStorage(laidOut);
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
      set({
        config: parsed,
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
      cfg.nodes[idx] = { ...cfg.nodes[idx], ...patch };
      commitConfig(cfg);
    },

    updateBranch: (id, patch) => {
      if (!get().config.branches.some((b) => b.id === id)) return;
      pushHistory();
      const cfg = cloneConfig(get().config);
      const idx = cfg.branches.findIndex((b) => b.id === id);
      cfg.branches[idx] = { ...cfg.branches[idx], ...patch };
      commitConfig(cfg);
    },

    updateSolidNode: (id, patch) => {
      if (!(get().config.solidNodes ?? []).some((n) => n.id === id)) return;
      pushHistory();
      const cfg = cloneConfig(get().config);
      if (!cfg.solidNodes) cfg.solidNodes = [];
      const idx = cfg.solidNodes.findIndex((n) => n.id === id);
      cfg.solidNodes[idx] = { ...cfg.solidNodes[idx], ...patch };
      commitConfig(cfg);
    },

    updateConductor: (id, patch) => {
      if (!(get().config.conductors ?? []).some((c) => c.id === id)) return;
      pushHistory();
      const cfg = cloneConfig(get().config);
      if (!cfg.conductors) cfg.conductors = [];
      const idx = cfg.conductors.findIndex((c) => c.id === id);
      cfg.conductors[idx] = { ...cfg.conductors[idx], ...patch };
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
      cfg.settings = { ...cfg.settings, ...patch };
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
    setActiveTab: (tab) => set({ activeTab: tab, activeGroupTab: null }),
    setShowSettings: (v) => set({ showSettings: v }),
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
    persist: () => saveToLocalStorage(get().config),
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
      const record = makeRunRecord(
        seq,
        cloneConfig(config),
        result,
        Date.now(),
        diary ? (structuredClone(diary) as RunDiary) : undefined,
      );
      let history = [...get().runHistory, record];
      let baselineRunId = get().baselineRunId;
      if (history.length > RUN_HISTORY_CAP) {
        const dropped = history.slice(0, history.length - RUN_HISTORY_CAP);
        history = history.slice(-RUN_HISTORY_CAP);
        if (baselineRunId && dropped.some((r) => r.id === baselineRunId))
          baselineRunId = null;
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
      set({
        selectedRunId: id,
        result: record.result,
        resultConfig: record.config,
        // Restore the record's diary (legacy records have none → null).
        resultDiary: record.diary ?? null,
        // Stale when the historical run's config differs from the live one.
        resultStale: record.configHash !== configHash(get().config),
        baselineRunId:
          baseline && checkRunCompatibility(record, baseline).ok
            ? baseline.id
            : null,
      });
    },

    renameRun: (id, name) => {
      const trimmed = name.trim();
      if (!trimmed) return;
      set({
        runHistory: get().runHistory.map((r) =>
          r.id === id ? { ...r, name: trimmed } : r,
        ),
      });
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
        (selection.kind === "node" || selection.kind === "solidNode")
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

      pushHistory();
      const cfg = cloneConfig(config);
      const allIds = new Set<string>([
        ...cfg.nodes.map((n) => n.id),
        ...(cfg.solidNodes ?? []).map((n) => n.id),
        ...cfg.branches.map((b) => b.id),
        ...(cfg.conductors ?? []).map((c) => c.id),
      ]);
      const prefixOf = (id: string) => {
        const m = /^[A-Za-z]+/.exec(id);
        return m ? m[0] : "N";
      };
      const idMap = new Map<string, string>();
      for (const oldId of targetIds) {
        const newId = createId(prefixOf(oldId), allIds);
        allIds.add(newId);
        idMap.set(oldId, newId);
      }
      let branchCount = 0;
      let conductorCount = 0;
      for (const [oldId, newId] of idMap) {
        const fluid = cfg.nodes.find((n) => n.id === oldId);
        if (fluid) {
          cfg.nodes.push({
            ...fluid,
            id: newId,
            x: fluid.x + 30,
            y: fluid.y + 30,
            label: `${fluid.label || fluid.id} copy`,
          });
          continue;
        }
        const solid = (cfg.solidNodes ?? []).find((n) => n.id === oldId);
        if (solid) {
          cfg.solidNodes!.push({
            ...solid,
            id: newId,
            x: solid.x + 30,
            y: solid.y + 30,
            label: `${solid.label || solid.id} copy`,
          });
        }
      }
      // Internal edges: both endpoints duplicated → clone with remapped ids.
      for (const b of [...cfg.branches]) {
        const from = idMap.get(b.from);
        const to = idMap.get(b.to);
        if (!from || !to) continue;
        const newId = createId("b", allIds);
        allIds.add(newId);
        cfg.branches.push({
          ...b,
          id: newId,
          from,
          to,
          label: `${b.label || b.id} copy`,
        });
        branchCount++;
      }
      if (cfg.conductors) {
        for (const c of [...cfg.conductors]) {
          const from = idMap.get(c.from);
          const to = idMap.get(c.to);
          if (!from || !to) continue;
          const newId = createId("c", allIds);
          allIds.add(newId);
          cfg.conductors.push({
            ...c,
            id: newId,
            from,
            to,
            label: `${c.label || c.id} copy`,
          });
          conductorCount++;
        }
      }
      commitConfig(cfg);
      const newNodeIds = [...idMap.values()];
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
