import React from "react";
import Toolbar from "./ui/components/Toolbar";
import FlowCanvas from "./ui/components/FlowCanvas";
import PropertyPanel from "./ui/components/PropertyPanel";
import ResultsView from "./ui/components/ResultsPanel";
import ModelViewDialog, {
  type ModelViewDialogKind,
} from "./ui/components/ModelViewDialog";
import SweepPanel from "./ui/components/SweepPanel";
import SettingsDialog from "./ui/components/SettingsDialog";
import ViewErrorBoundary from "./ui/components/ViewErrorBoundary";
import { useStore, type AppTab } from "./ui/store";
import { showCanvasSidebars } from "./ui/workspaceLayout";
import { validateNetwork } from "./core";

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

export default function App(): React.ReactElement {
  const [modelViewDialog, setModelViewDialog] =
    React.useState<ModelViewDialogKind | null>(null);
  const activeTab = useStore((s) => s.activeTab);
  const activeGroupTab = useStore((s) => s.activeGroupTab);
  const openGroupTabs = useStore((s) => s.openGroupTabs);
  const groups = useStore((s) => s.config.groups);
  const config = useStore((s) => s.config);
  const selection = useStore((s) => s.selection);
  const setActiveTab = useStore((s) => s.setActiveTab);
  const setActiveGroupTab = useStore((s) => s.setActiveGroupTab);
  const closeGroupTab = useStore((s) => s.closeGroupTab);
  const undo = useStore((s) => s.undo);
  const redo = useStore((s) => s.redo);
  const setValidationErrors = useStore((s) => s.setValidationErrors);
  const duplicateSelection = useStore((s) => s.duplicateSelection);

  // Global undo/redo: Ctrl/Cmd+Z and Ctrl/Cmd+Shift+Z (never while typing).
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

  // Global duplicate: Ctrl/Cmd+D (never while typing).
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

  // Live validation: re-validate (debounced) on every config change so the
  // issues pill is current without requiring a Run. Validation is
  // synchronous and local — no worker involvement. The first run is also
  // debounced (300 ms) so the pill never flashes during hydration.
  // A fresh, untouched model (no nodes/branches/conductors yet) is NOT
  // validated: "No branches defined" on an empty Untitled canvas is noise,
  // not feedback. As soon as anything is authored, validation stays live.
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

  // The contextual properties panel belongs to Diagram views only. It floats
  // over the full-width canvas and mounts after an element is selected.
  // Sidebar state survives the unmount: selection, active tool and palette
  // section collapse live in the store / localStorage, not in these
  // components.
  const showSidebars = showCanvasSidebars(activeTab);

  // Layout contract: the tab strip is a FULL-WIDTH sibling ABOVE the
  // workspace row (sidebars + center content), never a child of that row.
  // The sidebars mount/unmount with the active view; if the strip sat inside
  // the row (or inside the center column beside the rails), hiding the rails
  // would shift the tabs.  As a sibling above the row the strip is
  // pixel-stable across every tab switch — only the row below it changes.
  return (
    <div
      className="app-shell"
      style={{
        width: "100vw",
        height: "100vh",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <Toolbar />
      <div
        className="workspace-tabs tabs"
        data-testid="workspace-tabs"
        role="tablist"
        aria-label="Workspace"
      >
        <TabButton
          testid="editor-tab"
          title="Model / P&ID canvas (default view)"
          active={activeTab === "editor" && activeGroupTab === null}
          onClick={() => {
            setActiveTab("editor");
            setActiveGroupTab(null);
          }}
        >
          Model
        </TabButton>
        {openGroupTabs.map((gid) => {
          const g = (groups ?? []).find((gr) => gr.id === gid);
          const label = g?.label || gid;
          const active = activeTab === "editor" && activeGroupTab === gid;
          return (
            <TabButton
              key={gid}
              testid={`group-tab-${gid}`}
              active={active}
              onClick={() => {
                setActiveTab("editor");
                setActiveGroupTab(gid);
              }}
              closable
              onClose={() => closeGroupTab(gid)}
            >
              {label}
            </TabButton>
          );
        })}
        <TabButton
          testid="sweep-tab"
          title="Parameter sweep workspace (session-only Exploration)"
          active={activeTab === "sweep"}
          onClick={() => setActiveTab("sweep")}
        >
          Sweep
        </TabButton>
        <TabButton
          testid="results-tab"
          title="Analysis view: plots, result tables, run history, solver diary"
          active={activeTab === "results"}
          onClick={() => setActiveTab("results")}
        >
          Results
        </TabButton>
      </div>
      <div
        className="workspace"
        style={{ flex: 1, display: "flex", overflow: "hidden" }}
      >
        <div
          className="workspace-center"
          data-testid="workspace-center"
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
          }}
        >
          <div style={{ flex: 1, overflow: "hidden" }}>
            <ViewErrorBoundary name={viewName(activeTab)}>
              {activeTab === "editor" && activeGroupTab === null && (
                <FlowCanvas onOpenModelView={setModelViewDialog} />
              )}
              {activeTab === "editor" && activeGroupTab !== null && (
                <FlowCanvas
                  groupId={activeGroupTab}
                  onOpenModelView={setModelViewDialog}
                />
              )}
              {activeTab === "results" && <ResultsView />}
              {activeTab === "sweep" && <SweepPanel />}
            </ViewErrorBoundary>
          </div>
          {showSidebars && selection.kind !== "none" && (
            <div className="canvas-sidebar canvas-sidebar--right">
              <FloatingCanvasPanel label="Properties">
                <ViewErrorBoundary name="Property panel">
                  <PropertyPanel />
                </ViewErrorBoundary>
              </FloatingCanvasPanel>
            </div>
          )}
        </div>
      </div>
      <SettingsDialog />
      {modelViewDialog && (
        <ModelViewDialog
          view={modelViewDialog}
          onClose={() => setModelViewDialog(null)}
        />
      )}
    </div>
  );
}

function FloatingCanvasPanel({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(true);
  const contentId = React.useId();

  return (
    <>
      <button
        type="button"
        className="canvas-sidebar__toggle"
        aria-expanded={open}
        aria-controls={contentId}
        onClick={() => setOpen((value) => !value)}
      >
        <span>{label}</span>
        <span aria-hidden="true">{open ? "−" : "+"}</span>
      </button>
      {open && (
        <div className="canvas-sidebar__content" id={contentId}>
          {children}
        </div>
      )}
    </>
  );
}

/** Display name of the main workspace view, for the error boundary. */
function viewName(tab: AppTab): string {
  switch (tab) {
    case "results":
      return "Analysis view";
    case "sweep":
      return "Sweep view";
    default:
      return "Canvas view";
  }
}

function TabButton({
  active,
  onClick,
  children,
  testid,
  title,
  closable,
  onClose,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  testid: string;
  title?: string;
  closable?: boolean;
  onClose?: () => void;
}) {
  return (
    <div
      data-testid={testid}
      role="tab"
      aria-selected={active}
      tabIndex={0}
      title={title}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          if (e.target !== e.currentTarget) return; // let the close button handle its own keys
          e.preventDefault();
          onClick();
        }
      }}
      className="tab"
    >
      {children}
      {closable && (
        <button
          type="button"
          aria-label={`Close tab ${typeof children === "string" ? children : ""}`}
          className="tab__close"
          onClick={(e) => {
            e.stopPropagation();
            onClose?.();
          }}
        >
          ×
        </button>
      )}
    </div>
  );
}
