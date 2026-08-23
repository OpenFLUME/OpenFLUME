/**
 * StudioShell — OpenFLUME's docked-IDE layout (COMSOL / FLACS style).
 *
 *   ┌ Toolbar ───────────────────────────────────────────────┐
 *   ├ outline │ tabs + center view              │ inspector ─┤
 *   │  tree   │ (Model / Configuration /        │ (docked    │
 *   │         │  Sweep / Runs)                  │  props)    │
 *   └─────────┴─────────────────────────────────┴────────────┘
 *
 * The project outline (left, Ctrl+\ to toggle) covers configuration, model
 * entities, and run history with status icons; the Properties panel is a
 * dock that mounts on selection; every workspace — Configuration included —
 * is a tab in the center; Cmd/Ctrl+K opens the command palette.
 *
 * There is deliberately no bottom drawer: run outcome lives in the toolbar's
 * status pill, and model readiness is reported per element by the outline's
 * status icons, so a third copy of both would only cost the canvas height.
 */
import React from "react";
import Toolbar from "../../components/Toolbar";
import PropertyPanel from "../../components/PropertyPanel";
import ModelViewDialog, {
  type ModelViewDialogKind,
} from "../../components/ModelViewDialog";
import ViewErrorBoundary from "../../components/ViewErrorBoundary";
import { useStore } from "../../store";
import { showCanvasSidebars } from "../../workspaceLayout";
import { CenterView, WorkspaceTabs } from "../common";
import CommandPalette from "../CommandPalette";
import ModelOutline from "./ModelOutline";

const INSPECTOR_MIN = 240;
const INSPECTOR_MAX = 560;

export default function StudioShell(): React.ReactElement {
  const [modelViewDialog, setModelViewDialog] =
    React.useState<ModelViewDialogKind | null>(null);
  const [outlineOpen, setOutlineOpen] = React.useState(true);
  const activeTab = useStore((s) => s.activeTab);
  const paletteOpen = useStore((s) => s.showCommandPalette);
  const setPaletteOpen = useStore((s) => s.setShowCommandPalette);

  // Ctrl/Cmd+\ toggles the project outline (the panel advertises the
  // shortcut in its footer, FLACS-style).
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key !== "\\") return;
      e.preventDefault();
      setOutlineOpen((v) => !v);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Cmd/Ctrl+K opens the command palette (folded in from the canvas-first
  // prototype: run, place elements, open views, jump to any element).
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key.toLowerCase() !== "k") return;
      e.preventDefault();
      setPaletteOpen(!useStore.getState().showCommandPalette);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setPaletteOpen]);

  // The inspector is contextual: it mounts on selection and gives the width
  // back to the canvas otherwise, so an empty "select something" panel never
  // occupies a permanent column.
  const selection = useStore((s) => s.selection);
  const showInspector =
    showCanvasSidebars(activeTab) && selection.kind !== "none";

  const [inspectorWidth, setInspectorWidth] = React.useState(300);
  const dragState = React.useRef<{ startX: number; startWidth: number } | null>(
    null,
  );
  const onResizeDown = React.useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      dragState.current = { startX: e.clientX, startWidth: inspectorWidth };
      const onMove = (ev: PointerEvent) => {
        const st = dragState.current;
        if (!st) return;
        const next = Math.min(
          INSPECTOR_MAX,
          Math.max(INSPECTOR_MIN, st.startWidth + (st.startX - ev.clientX)),
        );
        setInspectorWidth(next);
      };
      const onUp = () => {
        dragState.current = null;
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [inspectorWidth],
  );

  return (
    <div className="app-shell shell-studio" data-testid="shell-studio">
      <Toolbar />
      <div className="shell-studio__body">
        {outlineOpen ? (
          <aside
            className="shell-studio__outline"
            aria-label="Project outline"
            data-testid="studio-outline"
          >
            <div className="shell-studio__panel-header">
              <span>Project outline</span>
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                data-testid="studio-outline-hide"
                aria-label="Hide the project outline (Ctrl+\)"
                title="Hide the project outline (Ctrl+\)"
                onClick={() => setOutlineOpen(false)}
              >
                ◂
              </button>
            </div>
            <ModelOutline />
          </aside>
        ) : (
          <button
            type="button"
            className="shell-studio__outline-reopen"
            data-testid="studio-outline-show"
            aria-label="Show the project outline (Ctrl+\)"
            title="Show the project outline (Ctrl+\)"
            onClick={() => setOutlineOpen(true)}
          >
            ▸
          </button>
        )}
        <main className="shell-studio__main">
          <WorkspaceTabs />
          <div className="shell-studio__center">
            <CenterView onOpenModelView={setModelViewDialog} />
          </div>
        </main>
        {showInspector && (
          <aside
            className="shell-studio__inspector"
            style={{ width: inspectorWidth }}
            aria-label="Properties"
            data-testid="studio-inspector"
          >
            <div
              className="shell-studio__inspector-resize"
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize properties panel"
              onPointerDown={onResizeDown}
            />
            <div className="shell-studio__panel-header">
              <span>Properties</span>
            </div>
            <div className="shell-studio__inspector-scroll">
              <ViewErrorBoundary name="Property panel">
                <PropertyPanel />
              </ViewErrorBoundary>
            </div>
          </aside>
        )}
      </div>
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
      />
      {modelViewDialog && (
        <ModelViewDialog
          view={modelViewDialog}
          onClose={() => setModelViewDialog(null)}
        />
      )}
    </div>
  );
}
