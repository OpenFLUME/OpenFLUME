/**
 * Cross-shell app behavior: global keyboard shortcuts and live validation.
 * Non-component exports live here (not in common.tsx) so every shell module
 * stays fast-refreshable.
 */
import React from "react";
import { useStore, type AppTab } from "../store";
import { validateNetwork } from "../../core";

function isEditableTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  const tag = t.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    t.isContentEditable
  );
}

/** Global undo/redo (Ctrl/Cmd+Z, +Shift) and duplicate (Ctrl/Cmd+D) —
 *  never while typing. Shared by every shell. */
export function useGlobalShortcuts(): void {
  const undo = useStore((s) => s.undo);
  const redo = useStore((s) => s.redo);
  const duplicateSelection = useStore((s) => s.duplicateSelection);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key.toLowerCase() !== "z") return;
      if (isEditableTarget(e.target)) return;
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo]);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key.toLowerCase() !== "d") return;
      if (isEditableTarget(e.target)) return;
      const res = duplicateSelection();
      if (res) e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [duplicateSelection]);
}

/**
 * Live validation: re-validate (debounced) on every config change so the
 * issues pill is current without requiring a Run. Validation is synchronous
 * and local — no worker involvement. The first run is also debounced (300 ms)
 * so the pill never flashes during hydration. A fresh, untouched model (no
 * nodes/branches/conductors yet) is NOT validated: "No branches defined" on
 * an empty Untitled canvas is noise, not feedback. As soon as anything is
 * authored, validation stays live.
 */
export function useLiveValidation(): void {
  const config = useStore((s) => s.config);
  const setValidationErrors = useStore((s) => s.setValidationErrors);

  React.useEffect(() => {
    const t = window.setTimeout(() => {
      const authored =
        config.nodes.length +
          (config.solidNodes?.length ?? 0) +
          config.branches.length +
          (config.conductors?.length ?? 0) >
        0;
      setValidationErrors(authored ? validateNetwork(config) : []);
    }, 300);
    return () => window.clearTimeout(t);
  }, [config, setValidationErrors]);
}

/** Display name of the main workspace view, for the error boundary. */
export function viewName(tab: AppTab): string {
  switch (tab) {
    case "results":
      return "Results view";
    case "sweep":
      return "Sweep view";
    case "config":
      return "Setup view";
    default:
      return "Canvas view";
  }
}
