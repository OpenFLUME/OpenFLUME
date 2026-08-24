import React, { useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import { useStore } from "../store";
import { downloadModelText, parseModelFile, cloneConfig } from "../utils";
import {
  downloadRunsFile,
  isRunsFileText,
  parseRunsFile,
  RUNS_FILE_SUFFIX,
} from "../runsFile";
import { exampleGroups } from "../examples";
import {
  validateNetwork,
  initRealFluids,
  realFluidsReady,
  networkUsesRealFluid,
} from "../../core";
import { PRESETS, activeUnitPreset } from "../units";
import { formatSig } from "../format";
import { startRun, cancelRun } from "../runController";
import { matchSelectionFromError } from "../selectionFromError";
import { useSweepStore } from "../sweep/store";
import ConfirmDialog, { ConfirmRequest } from "./ConfirmDialog";
import NewModelDialog from "./NewModelDialog";
import type { Selection } from "../types";
import { configHash } from "../provenance";
import {
  compareEmbeddedComponents,
  embedReferencedComponents,
  isComponentSourceTrusted,
  refreshComponentLibrary,
  rememberComponentSourceTrust,
} from "../componentLibrary";

export default function Toolbar() {
  const config = useStore((s) => s.config);
  const setConfig = useStore((s) => s.setConfig);
  const loadExample = useStore((s) => s.loadExample);
  const setResult = useStore((s) => s.setResult);
  const setValidationErrors = useStore((s) => s.setValidationErrors);
  const fluidError = useStore((s) => s.fluidError);
  const setFluidError = useStore((s) => s.setFluidError);
  const setActiveTab = useStore((s) => s.setActiveTab);
  const setShowCommandPalette = useStore((s) => s.setShowCommandPalette);
  const result = useStore((s) => s.result);
  const resultStale = useStore((s) => s.resultStale);
  const validationErrors = useStore((s) => s.validationErrors);
  const running = useStore((s) => s.running);
  const runStatus = useStore((s) => s.runStatus);
  const runProgress = useStore((s) => s.runProgress);
  const unitPreferences = useStore((s) => s.unitPreferences);
  const setUnitPreset = useStore((s) => s.setUnitPreset);
  const setSelection = useStore((s) => s.setSelection);
  const updateMeta = useStore((s) => s.updateMeta);
  const dirty = useStore((s) => s.dirty);
  const markSaved = useStore((s) => s.markSaved);
  const preparingOperation = useStore((s) => s.preparingOperation);
  const beginPreparation = useStore((s) => s.beginPreparation);
  const endPreparation = useStore((s) => s.endPreparation);
  const undo = useStore((s) => s.undo);
  const redo = useStore((s) => s.redo);
  const canUndo = useStore((s) => s.past.length > 0);
  const canRedo = useStore((s) => s.future.length > 0);

  const fileRef = useRef<HTMLInputElement>(null);
  const [coolpropStatus, setCoolpropStatus] = React.useState<string | null>(
    null,
  );
  const [confirm, setConfirm] = React.useState<ConfirmRequest | null>(null);
  const pendingFileRef = useRef<File | null>(null);
  const importRuns = useStore((s) => s.importRuns);

  const activePreset = activeUnitPreset(unitPreferences);
  const usesRealFluid = networkUsesRealFluid(config);
  const hasRuns = useStore((s) => s.runHistory.length > 0);

  React.useEffect(() => {
    let active = true;
    let clearTimer: (() => void) | null = null;

    if (!usesRealFluid) {
      setCoolpropStatus(null);
      // A CoolProp failure belongs to the previous real-fluid model.
      // Leaving it up after switching to an analytic-EOS example (e.g. the
      // transient thruster) looks like that example itself failed to load.
      setFluidError(null);
      return;
    }

    if (realFluidsReady()) {
      if (active) {
        setFluidError(null);
        setCoolpropStatus("CoolProp ready");
      }
      const t = setTimeout(() => {
        if (active) setCoolpropStatus(null);
      }, 2000);
      clearTimer = () => clearTimeout(t);
    } else {
      if (active) setCoolpropStatus("Loading fluid properties…");
      initRealFluids()
        .then(() => {
          if (active) {
            setFluidError(null);
            setCoolpropStatus("CoolProp ready");
            const t = setTimeout(() => {
              if (active) setCoolpropStatus(null);
            }, 2000);
            clearTimer = () => clearTimeout(t);
          }
        })
        .catch((err) => {
          if (active) {
            setCoolpropStatus(null);
            // CoolProp failures live on their own channel — never clobber
            // network validation errors.
            setFluidError(`CoolProp init failed: ${err}`);
          }
        });
    }

    return () => {
      active = false;
      if (clearTimer) clearTimer();
    };
  }, [usesRealFluid, setFluidError]);

  const handleSave = async () => {
    if (!beginPreparation("save")) return;
    try {
      const library = await refreshComponentLibrary();
      // Save the FILE: the base network plus every variant, not just the
      // variant currently resolved onto the canvas.
      const current = useStore.getState().baseConfig;
      const savedHash = configHash(current);
      const saved = cloneConfig(current);
      const unavailable = embedReferencedComponents(saved, library.components);
      if (unavailable.length > 0) {
        setValidationErrors(
          unavailable.map(
            (key) =>
              `User component "${key}" is not embedded and is unavailable from the local component library.`,
          ),
        );
        return;
      }
      downloadModelText(saved);
      // Results ride along as the `<model>.runs.json` sidecar, so one Save
      // captures the whole session rather than leaving results behind in
      // browser storage. Two files because results are bulky and
      // regenerable — the `.fn` alone stays diffable and reviewable.
      const runs = useStore.getState().runHistory;
      if (runs.length > 0) downloadRunsFile(current, runs);
      markSaved(savedHash);
    } finally {
      endPreparation("save");
    }
  };

  const loadFile = useCallback(
    async (file: File) => {
      try {
        // A results sidecar attaches to the model already open rather than
        // replacing it — the two files are loaded through one control.
        const text = await file.text();
        if (isRunsFileText(text)) {
          try {
            const parsed = parseRunsFile(text);
            importRuns(parsed.runs);
            setValidationErrors([]);
          } catch (err) {
            setValidationErrors([
              `Failed to load results: ${err instanceof Error ? err.message : String(err)}`,
            ]);
          }
          return;
        }
        // Any parse failure throws here, leaving the current config
        // untouched (atomic load).
        const loaded = parseModelFile(text);
        const errs = validateNetwork(loaded);
        if (errs.length > 0) {
          setValidationErrors(errs);
          setResult(null);
          return;
        }
        const library = await refreshComponentLibrary();
        const untrusted = (
          await compareEmbeddedComponents(
            loaded.componentLibrary,
            library.components,
          )
        ).filter(
          (entry) =>
            entry.status !== "match" &&
            !isComponentSourceTrusted(entry.embeddedHash),
        );
        const finishLoad = () => {
          setConfig(loaded);
          setValidationErrors([]);
          setResult(null);
          setActiveTab("editor");
          markSaved();
        };
        if (untrusted.length === 0) {
          finishLoad();
          return;
        }
        const details = untrusted
          .map(
            (entry) =>
              `"${entry.key}" (${entry.status === "mismatch" ? "differs from local code" : "not in the local library"})`,
          )
          .join(", ");
        setConfirm({
          title: "Trust embedded component code?",
          message: `This file contains component code that can execute during a solve: ${details}. Only load code from a source you trust.`,
          acceptLabel: "Trust and load",
          onAccept: () => {
            rememberComponentSourceTrust(
              untrusted.map((entry) => entry.embeddedHash),
            );
            finishLoad();
          },
        });
      } catch (err) {
        setValidationErrors([`Failed to load file: ${err}`]);
      }
    },
    [
      setConfig,
      setValidationErrors,
      setResult,
      setActiveTab,
      markSaved,
      importRuns,
    ],
  );

  const handleLoad = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (fileRef.current) fileRef.current.value = "";
    if (!file) return;
    // A results sidecar adds to the open model, so it never needs the
    // "this replaces your unsaved work" confirmation.
    if (dirty && !file.name.endsWith(RUNS_FILE_SUFFIX)) {
      pendingFileRef.current = file;
      setConfirm({
        title: "Load network file",
        message: `Loading "${file.name}" replaces the current network, which has unsaved changes.`,
        acceptLabel: "Load file",
        onAccept: () => {
          const f = pendingFileRef.current;
          pendingFileRef.current = null;
          if (f) void loadFile(f);
        },
      });
      return;
    }
    await loadFile(file);
  };

  const [showNewModel, setShowNewModel] = React.useState(false);
  const requestNew = useCallback(() => setShowNewModel(true), []);

  const requestLoadExample = useCallback(
    (name: string) => {
      if (dirty) {
        setConfirm({
          title: "Load example",
          message: `Load the example "${name}"? The current network has unsaved changes that will be replaced.`,
          acceptLabel: "Load example",
          onAccept: () => loadExample(name),
        });
      } else {
        loadExample(name);
      }
    },
    [dirty, loadExample],
  );

  const isRunning = running;
  const isPreparingRun = preparingOperation === "run";
  const operationBusy = running || preparingOperation !== null;
  // A running sweep holds the shared solver worker: manual Run is locked out.
  const sweepRunning = useSweepStore((s) => s.activeJobId !== null);
  const runBlocked = operationBusy || sweepRunning;

  // Progress bar width for transient
  const transientProgress =
    runProgress && runProgress.kind === "transient" ? runProgress : null;
  const steadyProgress =
    runProgress && runProgress.kind === "steady" ? runProgress : null;
  const progressPercent = transientProgress
    ? Math.min(
        100,
        Math.round((transientProgress.time / transientProgress.endTime) * 100),
      )
    : 0;

  return (
    <div data-testid="toolbar" className="toolbar">
      <div className="toolbar__group toolbar-actions">
        <span className="toolbar-title">
          <img
            className="toolbar-title__full"
            src={`${import.meta.env.BASE_URL}logo.svg`}
            alt="OpenFLUME"
          />
          <img
            className="toolbar-title__short"
            src={`${import.meta.env.BASE_URL}favicon.svg`}
            alt="OpenFLUME"
          />
        </span>
        <NetworkNameInput
          value={config.meta.name}
          onCommit={(name) => updateMeta({ name: name || "Untitled network" })}
        />
        <ActiveVariantPill />
        <span className="toolbar__divider" aria-hidden="true" />
        <button
          data-testid="toolbar-new"
          className="btn"
          onClick={requestNew}
          title="New network"
        >
          <NewIcon />
          <span className="btn__label">New</span>
        </button>
        <button
          data-testid="toolbar-save"
          className="btn"
          onClick={handleSave}
          disabled={operationBusy}
          title={
            hasRuns
              ? "Save model (.fn) and results (.runs.json)"
              : "Save model (.fn)"
          }
        >
          <SaveIcon />
          <span className="btn__label">Save</span>
        </button>
        <button
          data-testid="toolbar-load-trigger"
          className="btn"
          onClick={() => fileRef.current?.click()}
          title="Load model (.fn) or results (.runs.json)"
        >
          <LoadIcon />
          <span className="btn__label">Load</span>
        </button>
        <input
          data-testid="toolbar-load-input"
          ref={fileRef}
          type="file"
          accept=".fn,.json"
          onChange={handleLoad}
          style={{ display: "none" }}
        />
        <button
          data-testid="toolbar-undo"
          className="btn btn--icon"
          onClick={undo}
          disabled={!canUndo}
          title="Undo (Ctrl/Cmd+Z)"
          aria-label="Undo"
        >
          <UndoIcon />
        </button>
        <button
          data-testid="toolbar-redo"
          className="btn btn--icon"
          onClick={redo}
          disabled={!canRedo}
          title="Redo (Ctrl/Cmd+Shift+Z)"
          aria-label="Redo"
        >
          <RedoIcon />
        </button>
        <span className="toolbar__divider" aria-hidden="true" />
        <select
          data-testid="toolbar-examples"
          className="select"
          aria-label="Load an example model"
          title="Load an example model"
          onChange={(e) => {
            if (e.target.value) requestLoadExample(e.target.value);
          }}
          value=""
        >
          <option value="" disabled>
            Examples ▾
          </option>
          {Object.entries(exampleGroups).map(([groupName, groupExamples]) => (
            <optgroup key={groupName} label={groupName}>
              {groupExamples.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        <select
          data-testid="toolbar-unit-preset"
          className="select"
          aria-label="Unit preset"
          title="Unit preset"
          value={activePreset}
          onChange={(e) => {
            if (e.target.value && e.target.value !== "Custom") {
              setUnitPreset(e.target.value);
            }
          }}
        >
          <option value="Custom" disabled>
            Units ▾
          </option>
          {Object.keys(PRESETS).map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
        <button
          data-testid="toolbar-commands"
          className="btn"
          onClick={() => setShowCommandPalette(true)}
          title="Command palette (Cmd/Ctrl+K)"
        >
          <CommandsIcon />
          <span className="btn__label">Commands</span>
        </button>
      </div>
      {/* Its own group: the actions group clips from the right, and these two
          are the last thing that may go. */}
      <div className="toolbar__group toolbar__run">
        <button
          data-testid="toolbar-run"
          onClick={runBlocked ? undefined : startRun}
          disabled={runBlocked}
          className={
            isRunning || isPreparingRun ? "btn btn--busy" : "btn btn--primary"
          }
          title={
            sweepRunning && !operationBusy
              ? "A parameter sweep is running — manual Run is paused (see the Sweep tab)"
              : isPreparingRun
                ? "Preparing simulation…"
                : isRunning
                  ? "Simulation running…"
                  : "Run simulation"
          }
        >
          {isPreparingRun ? "Preparing…" : isRunning ? "Running…" : "Run"}
        </button>
        {isRunning && (
          <button
            data-testid="toolbar-cancel"
            className="btn btn--danger"
            onClick={cancelRun}
          >
            Cancel
          </button>
        )}
      </div>
      <div className="toolbar__group toolbar__group--status">
        {coolpropStatus && (
          <span
            data-testid="toolbar-coolprop-status"
            className="pill pill--info pill--plain"
          >
            {coolpropStatus}
          </span>
        )}
        {fluidError && (
          <span
            data-testid="toolbar-fluid-error"
            className="pill pill--danger"
            role="alert"
            title={fluidError}
          >
            Fluid init failed
          </span>
        )}
        {isRunning && transientProgress && (
          <div data-testid="toolbar-progress-bar" className="progress">
            <div className="progress__track">
              <div
                className="progress__fill"
                style={{ width: `${progressPercent}%` }}
              />
            </div>
            <span>
              t = {formatSig(transientProgress.time, 3)} s /{" "}
              {formatSig(transientProgress.endTime, 4)} s
              {transientProgress.dt !== undefined && (
                <span className="progress__dt">
                  · dt = {formatSig(transientProgress.dt, 3)} s
                </span>
              )}
            </span>
          </div>
        )}
        {isRunning && steadyProgress && (
          <div data-testid="toolbar-progress-steady" className="progress">
            Iter {steadyProgress.iteration} · residual{" "}
            {formatSig(steadyProgress.residual, 2)}
          </div>
        )}
        <HealthPill
          validationErrors={validationErrors}
          result={result}
          runStatus={runStatus}
          resultStale={resultStale}
          onSelectElement={(sel) => {
            setSelection(sel);
            setActiveTab("editor");
          }}
        />
      </div>
      {confirm && (
        <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
      )}
      {showNewModel && (
        <NewModelDialog onClose={() => setShowNewModel(false)} />
      )}
    </div>
  );
}

/** Editable network name bound to config.meta.name (commit on blur/Enter). */
/** Shared frame for the toolbar's file/history icons. */
function ToolbarIcon({ children }: { children: React.ReactNode }) {
  return (
    <svg
      className="btn__glyph"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

// Blank document, floppy disk, open folder — the desktop-era file trio.
function NewIcon() {
  return (
    <ToolbarIcon>
      <path d="M14 3H6.5A1.5 1.5 0 0 0 5 4.5v15A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5V8Z" />
      <path d="M14 3v5h5" />
      <path d="M12 12.5v5M9.5 15h5" />
    </ToolbarIcon>
  );
}

function SaveIcon() {
  return (
    <ToolbarIcon>
      <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z" />
      <path d="M17 21v-8H7v8" />
      <path d="M7 3v5h8" />
    </ToolbarIcon>
  );
}

function LoadIcon() {
  return (
    <ToolbarIcon>
      <path d="m6 14 1.45-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.55 6a2 2 0 0 1-1.94 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.93a2 2 0 0 1 1.66.9l.82 1.2a2 2 0 0 0 1.66.9H18a2 2 0 0 1 2 2v2" />
    </ToolbarIcon>
  );
}

/**
 * Which variant is being edited, beside the model name.
 *
 * Only shown off Base: the outline's picker is the primary control, but it
 * can be hidden with Ctrl+\, and "I edited the wrong variant" is the failure
 * this qualifier exists to prevent.
 */
function ActiveVariantPill() {
  const activeVariantId = useStore((s) => s.activeVariantId);
  const variants = useStore((s) => s.baseConfig.variants);
  const setShowCommandPalette = useStore((s) => s.setShowCommandPalette);
  if (activeVariantId === null) return null;
  const variant = (variants ?? []).find((v) => v.id === activeVariantId);
  if (!variant) return null;
  return (
    <button
      type="button"
      className="pill pill--info toolbar-variant"
      data-testid="toolbar-variant"
      title="Editing a simulation variant — Ctrl+K to switch"
      onClick={() => setShowCommandPalette(true)}
    >
      {variant.name}
    </button>
  );
}

/** Terminal prompt chevron — the conventional "command" mark. */
function CommandsIcon() {
  return (
    <ToolbarIcon>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="m7 10 2.5 2L7 14" />
      <path d="M12.5 14.5h4" />
    </ToolbarIcon>
  );
}

// Arrow doubling back over its own path — the long-standing undo/redo mark.
function UndoIcon() {
  return (
    <ToolbarIcon>
      <path d="M9 14 4 9l5-5" />
      <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
    </ToolbarIcon>
  );
}

function RedoIcon() {
  return (
    <ToolbarIcon>
      <path d="m15 14 5-5-5-5" />
      <path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13" />
    </ToolbarIcon>
  );
}

function NetworkNameInput({
  value,
  onCommit,
}: {
  value: string;
  onCommit: (name: string) => void;
}) {
  const [raw, setRaw] = React.useState(value);
  const [focused, setFocused] = React.useState(false);
  const dirty = useStore((s) => s.dirty);

  React.useEffect(() => {
    if (!focused) setRaw(value);
  }, [value, focused]);

  const commit = () => {
    setFocused(false);
    const trimmed = raw.trim();
    if (trimmed && trimmed !== value) onCommit(trimmed);
    else setRaw(value);
  };

  return (
    <span className="network-name-wrap">
      <input
        data-testid="network-name"
        className="input network-name"
        type="text"
        value={focused ? raw : value}
        placeholder="Untitled network"
        aria-label="Network name"
        title="Network name (used as the save-file name)"
        onFocus={() => {
          setRaw(value);
          setFocused(true);
        }}
        onChange={(e) => setRaw(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            commit();
            (e.target as HTMLInputElement).blur();
          } else if (e.key === "Escape") {
            setRaw(value);
            (e.target as HTMLInputElement).blur();
          }
        }}
      />
      {dirty && (
        <span
          data-testid="network-name-dirty-dot"
          className="network-name-dirty"
          title="Unsaved changes"
          aria-label="Unsaved changes"
          role="status"
        />
      )}
    </span>
  );
}

function HealthPill({
  validationErrors,
  result,
  runStatus,
  resultStale,
  onSelectElement,
}: {
  validationErrors: string[];
  result: any;
  runStatus: string;
  resultStale: boolean;
  onSelectElement: (sel: Selection) => void;
}) {
  const config = useStore((s) => s.config);
  const [open, setOpen] = React.useState(false);
  const wrapRef = React.useRef<HTMLSpanElement>(null);
  const panelRef = React.useRef<HTMLDivElement>(null);
  // Fixed-position anchor for the portaled popover (viewport coordinates).
  const [anchor, setAnchor] = React.useState<{
    top: number;
    left: number;
  } | null>(null);

  // Position the popover under the pill, right-aligned to it and clamped
  // inside the viewport. Rendered via portal to document.body so no toolbar
  // stacking/overflow context can occlude it.
  const updateAnchor = React.useCallback(() => {
    const el = wrapRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const width = Math.min(420, window.innerWidth - 32);
    let left = rect.right - width;
    left = Math.max(8, Math.min(left, window.innerWidth - width - 8));
    let top = rect.bottom + 8;
    // Flip above the pill if the panel would overflow the viewport bottom.
    const panelH = panelRef.current?.offsetHeight ?? 0;
    if (panelH && top + panelH > window.innerHeight - 8) {
      top = Math.max(8, rect.top - 8 - panelH);
    }
    setAnchor({ top, left });
  }, []);

  React.useLayoutEffect(() => {
    if (!open) return;
    updateAnchor();
    window.addEventListener("resize", updateAnchor);
    return () => window.removeEventListener("resize", updateAnchor);
  }, [open, updateAnchor]);

  // Re-clamp once the panel has rendered (height known → bottom flip works).
  React.useLayoutEffect(() => {
    if (open && anchor) updateAnchor();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, anchor === null]);

  // Close the popover on outside click / Escape. The panel lives in a portal,
  // so both the pill wrapper and the panel count as "inside".
  React.useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target;
      if (!(t instanceof Node)) return;
      if (wrapRef.current?.contains(t)) return;
      if (panelRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const issueCount = validationErrors.length;

  let label = "Ready to solve";
  let variant = "pill pill--muted";
  let testid = "toolbar-health";
  let title = "No validation issues";
  if (issueCount) {
    label = `${issueCount} issue${issueCount === 1 ? "" : "s"} to fix`;
    variant = "pill pill--danger";
    title = `${issueCount} validation issue${issueCount === 1 ? "" : "s"} — click to review`;
  } else if (runStatus === "running" || runStatus === "loadingFluids") {
    label = "Solving…";
    variant = "pill pill--info";
    title = "Solver is running";
  } else if (runStatus === "cancelled") {
    label = "Cancelled";
    variant = "pill pill--warn";
    testid = "toolbar-status";
    title = "Run cancelled — partial results retained";
  } else if (result) {
    const converged = !!result.converged;
    if ("iterations" in result) {
      label = `${converged ? "Converged" : "Not converged"} · ${result.iterations} iter · ${formatSig(result.residual, 2)}`;
    } else if ("times" in result) {
      label = `${converged ? "Converged" : "Not converged"} · ${result.times.length} steps`;
    } else {
      label = converged ? "Converged" : "Not converged";
    }
    variant = converged ? "pill pill--ok" : "pill pill--danger";
    testid = "toolbar-status";
    title = resultStale
      ? "Model changed since this run — results are stale"
      : converged
        ? "Solve converged"
        : "Solve did not converge";
    if (resultStale) variant = "pill pill--warn";
    if (resultStale) label = `${label} · stale`;
  }

  const clickable = issueCount > 0;

  return (
    <span
      ref={wrapRef}
      role="status"
      aria-live="polite"
      style={{ position: "relative", display: "inline-flex" }}
    >
      {clickable ? (
        <button
          type="button"
          data-testid={testid}
          className={variant}
          title={title}
          aria-haspopup="true"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          <span data-testid="toolbar-error">{label}</span>
          <span aria-hidden="true">▾</span>
        </button>
      ) : (
        <span data-testid={testid} className={variant} title={title}>
          {label}
        </span>
      )}
      {open &&
        clickable &&
        anchor &&
        createPortal(
          <div
            ref={panelRef}
            className="chip issues-panel"
            data-testid="issues-panel"
            role="dialog"
            aria-label="Validation issues"
            style={{
              position: "fixed",
              top: anchor.top,
              left: anchor.left,
              zIndex: 100,
            }}
          >
            <div className="issues-panel__title">
              Validation issues ({issueCount})
            </div>
            <ul>
              {validationErrors.map((err, i) => (
                <li key={i} role="alert">
                  <button
                    type="button"
                    className="issue-item"
                    data-testid="issue-item"
                    onClick={() => {
                      const sel = matchSelectionFromError(err, config);
                      if (sel) onSelectElement(sel);
                      setOpen(false);
                    }}
                    title="Click to select the element in the editor"
                  >
                    {err}
                  </button>
                </li>
              ))}
            </ul>
          </div>,
          document.body,
        )}
    </span>
  );
}
