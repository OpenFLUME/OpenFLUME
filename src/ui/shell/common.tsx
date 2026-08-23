/**
 * Shared shell building blocks.  Every shell layout composes the same
 * regions — workspace tabs, the center view (canvas / analysis / sweep), the
 * inspector — from here, so a prototype shell is only chrome and placement.
 */
import React from "react";
import FlowCanvas from "../components/FlowCanvas";
import ResultsView from "../components/ResultsPanel";
import SweepPanel from "../components/SweepPanel";
import ConfigurationView from "../components/ConfigurationView";
import ViewErrorBoundary from "../components/ViewErrorBoundary";
import type { ModelViewDialogKind } from "../components/ModelViewDialog";
import { useStore } from "../store";
import { viewName } from "./appBehavior";

export function TabButton({
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

/** The workspace tab strip: Model, any open subnetwork tabs, Configuration,
 *  Sweep, Runs. Identical markup/testids in every shell that shows tabs. */
export function WorkspaceTabs({ className }: { className?: string }) {
  const activeTab = useStore((s) => s.activeTab);
  const activeGroupTab = useStore((s) => s.activeGroupTab);
  const openGroupTabs = useStore((s) => s.openGroupTabs);
  const groups = useStore((s) => s.config.groups);
  const setActiveTab = useStore((s) => s.setActiveTab);
  const setActiveGroupTab = useStore((s) => s.setActiveGroupTab);
  const closeGroupTab = useStore((s) => s.closeGroupTab);

  return (
    <div
      className={className ?? "workspace-tabs tabs"}
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
        testid="config-tab"
        title="Global configuration: solver, physics, fluids, species, units, extensibility"
        active={activeTab === "config"}
        onClick={() => setActiveTab("config")}
      >
        Configuration
      </TabButton>
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
        title="Runs: plots, result tables, run history, solver diary"
        active={activeTab === "results"}
        onClick={() => setActiveTab("results")}
      >
        Runs
      </TabButton>
    </div>
  );
}

/** The center workspace view for the active tab (canvas / configuration /
 *  sweep / runs), wrapped in the per-view error boundary. */
export function CenterView({
  onOpenModelView,
}: {
  onOpenModelView: (view: ModelViewDialogKind) => void;
}) {
  const activeTab = useStore((s) => s.activeTab);
  const activeGroupTab = useStore((s) => s.activeGroupTab);

  return (
    <ViewErrorBoundary name={viewName(activeTab)}>
      {activeTab === "editor" && activeGroupTab === null && (
        <FlowCanvas onOpenModelView={onOpenModelView} />
      )}
      {activeTab === "editor" && activeGroupTab !== null && (
        <FlowCanvas
          groupId={activeGroupTab}
          onOpenModelView={onOpenModelView}
        />
      )}
      {activeTab === "config" && <ConfigurationView />}
      {activeTab === "results" && <ResultsView />}
      {activeTab === "sweep" && <SweepPanel />}
    </ViewErrorBoundary>
  );
}
