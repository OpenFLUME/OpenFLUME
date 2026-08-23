/**
 * CanvasRail — the model-builder tool rail (canvas tools, node placement,
 * annotations, model views).  Extracted from FlowCanvas so shell layouts can
 * place the rail independently of the React Flow canvas; FlowCanvas remains
 * the default host (inside a top-left React Flow Panel).
 *
 * Purely presentational: every action arrives as a prop, so the rail never
 * touches the store or React Flow state directly.
 */
import React, { useEffect, useRef, useState } from "react";
import { DEFAULT_CANVAS_VISIBILITY, type CanvasVisibility } from "../utils";
import { startCanvasElementDrag } from "../canvasDnd";
import EntityGlyph from "./EntityGlyph";
import type { ModelViewDialogKind } from "./ModelViewDialog";

export type DraggableNodeKind =
  "fluid:internal" | "fluid:boundary" | "solid:solid" | "solid:ambient";

/**
 * Name that unfurls beside an icon-only rail button on hover/focus. The
 * button's aria-label carries the same text, so this stays aria-hidden.
 */
function RailTip({
  label,
  domain,
  hint,
}: {
  label: string;
  domain?: string;
  hint?: string;
}) {
  return (
    <span className="canvas-rail__tip" aria-hidden="true">
      <span className="canvas-rail__tip-line">
        <span className="canvas-rail__tip-label">{label}</span>
        {domain ? <span className="canvas-rail__tip-tag">{domain}</span> : null}
      </span>
      {hint ? <span className="canvas-rail__tip-hint">{hint}</span> : null}
    </span>
  );
}

export function RailButton({
  label,
  hint,
  testId,
  pressed,
  disabled,
  onClick,
  children,
}: {
  label: string;
  hint?: string;
  testId?: string;
  pressed?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className="canvas-rail__btn"
      data-testid={testId}
      aria-label={label}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
      <RailTip label={label} hint={hint} />
    </button>
  );
}

/** Which side of the drawing a visibility checkbox belongs to, purely for
 *  grouping the menu into "Elements" (nodes) and "Connections" (edges). */
const VIEW_OPTION_SECTIONS: Array<{
  heading: string;
  options: Array<{ key: keyof CanvasVisibility; label: string }>;
}> = [
  {
    heading: "Elements",
    options: [
      { key: "fluidNodes", label: "Fluid nodes" },
      { key: "thermalNodes", label: "Thermal nodes" },
    ],
  },
  {
    heading: "Connections",
    options: [
      { key: "fluidBranches", label: "Fluid branches" },
      { key: "conduction", label: "Conduction ties" },
      { key: "convection", label: "Convection ties" },
      { key: "radiation", label: "Radiation ties" },
    ],
  },
];

/**
 * "View" rail control — a checkbox menu that lets the user isolate one part
 * of the system (e.g. only the thermal network, or only radiation ties)
 * without touching the model. Unlike the labels toggle this is a menu, not a
 * single on/off button, so it manages its own open state and closes on an
 * outside click or Escape rather than the hover-only RailTip.
 */
function ViewOptionsControl({
  visibility,
  onChange,
}: {
  visibility: CanvasVisibility;
  onChange: (patch: Partial<CanvasVisibility>) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target;
      if (
        target instanceof globalThis.Node &&
        wrapRef.current &&
        !wrapRef.current.contains(target)
      ) {
        setOpen(false);
      }
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

  const allShown = Object.values(visibility).every(Boolean);

  return (
    <div className="canvas-rail__view-wrap" ref={wrapRef}>
      <button
        type="button"
        className="canvas-rail__btn"
        data-testid="canvas-view-options-toggle"
        aria-label="View options"
        aria-haspopup="true"
        aria-expanded={open}
        aria-pressed={!allShown}
        onClick={() => setOpen((o) => !o)}
      >
        <ViewOptionsIcon />
        <RailTip
          label="View options"
          hint="Show only one part of the system at a time"
        />
      </button>
      {open && (
        <div
          className="canvas-rail__view-menu"
          data-testid="canvas-view-options-menu"
          role="group"
          aria-label="View options"
        >
          {VIEW_OPTION_SECTIONS.map((section) => (
            <div
              className="canvas-rail__view-menu-section"
              key={section.heading}
            >
              <span className="canvas-rail__view-menu-heading">
                {section.heading}
              </span>
              {section.options.map((option) => (
                <label key={option.key}>
                  <input
                    type="checkbox"
                    checked={visibility[option.key]}
                    onChange={() =>
                      onChange({ [option.key]: !visibility[option.key] })
                    }
                  />
                  {option.label}
                </label>
              ))}
            </div>
          ))}
          {!allShown && (
            <button
              type="button"
              className="canvas-rail__view-menu-reset"
              data-testid="canvas-view-options-reset"
              onClick={() => onChange(DEFAULT_CANVAS_VISIBILITY)}
            >
              Show all
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function RailNodeTool({
  kind,
  label,
  domain,
  testId,
  onClick,
}: {
  kind: DraggableNodeKind;
  label: string;
  /** 'Fluid' or 'Thermal' — the rail has no room for section headings, so the
   *  network each node belongs to rides along in its name and tooltip. */
  domain: string;
  testId: string;
  onClick: () => void;
}) {
  const isFluid = kind.startsWith("fluid:");

  return (
    <button
      type="button"
      className="canvas-rail__btn canvas-rail__btn--element"
      data-testid={testId}
      draggable
      aria-label={`${label} — ${domain} network`}
      onDragStart={(event) => startCanvasElementDrag(event, kind)}
      onClick={onClick}
    >
      {/* Same shapes and fills the canvas uses, so the rail reads as a legend
          (EntityGlyph is shared with the project outline). */}
      {isFluid ? (
        <EntityGlyph
          className="canvas-rail__glyph"
          entity="node"
          type={kind === "fluid:boundary" ? "boundary" : "internal"}
        />
      ) : (
        <EntityGlyph
          className="canvas-rail__glyph"
          entity="solidNode"
          type={kind === "solid:ambient" ? "ambient" : "solid"}
        />
      )}
      <RailTip label={label} domain={domain} hint="Drag or click to place" />
    </button>
  );
}

/** Text-note tool. Deliberately no domain tag: a note belongs to neither the
 *  fluid nor the thermal network — it annotates the drawing. */
function RailNoteTool({
  testId,
  onClick,
}: {
  testId: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="canvas-rail__btn canvas-rail__btn--element"
      data-testid={testId}
      draggable
      aria-label="Text note — canvas annotation"
      onDragStart={(event) => startCanvasElementDrag(event, "note")}
      onClick={onClick}
    >
      {/* A lined card in the note's own paper and edge colors, so the rail
          keeps reading as a legend. */}
      <EntityGlyph className="canvas-rail__glyph" entity="note" />
      <RailTip label="Text note" hint="Drag or click to place" />
    </button>
  );
}

// Rail icons share a 24-unit box and a 1.8 stroke so they carry the same
// optical weight next to the filled node glyphs.
function RailIcon({ children }: { children: React.ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

function SelectToolIcon() {
  return (
    <RailIcon>
      <path d="M13 4h3a2 2 0 0 1 2 2v3" />
      <path d="M13 20h3a2 2 0 0 0 2-2v-3" />
      <path d="M4 13v3a2 2 0 0 0 2 2h3" />
      <path d="M4 11V6a2 2 0 0 1 2-2h3" />
      <path d="m9 9 5 12 1.8-5.2L21 14Z" />
    </RailIcon>
  );
}

function PanToolIcon() {
  return (
    <RailIcon>
      <path d="M18 11V6a2 2 0 0 0-4 0" />
      <path d="M14 10V4a2 2 0 0 0-4 0v2" />
      <path d="M10 10.5V6a2 2 0 0 0-4 0v8" />
      <path d="M18 8a2 2 0 0 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-6-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15" />
    </RailIcon>
  );
}

function InspectModeIcon() {
  return (
    <RailIcon>
      <path d="M4 4v15a1 1 0 0 0 1 1h15" />
      <path d="m19 9-5 5-3.5-3.5L7 14" />
    </RailIcon>
  );
}

/** A cube in three-quarter view: the axonometric box every CAD tool uses for
 *  "look at this in space". */
function View3DIcon() {
  return (
    <RailIcon>
      <path d="M12 3 3 7.5v9L12 21l9-4.5v-9L12 3Z" />
      <path d="M3 7.5 12 12l9-4.5" />
      <path d="M12 12v9" />
    </RailIcon>
  );
}

/** A name tag, struck through once the names are off. */
function LabelsIcon({ hidden }: { hidden: boolean }) {
  return (
    <RailIcon>
      <path d="M3.5 8.5a2 2 0 0 1 2-2h7l6 5.5-6 5.5h-7a2 2 0 0 1-2-2Z" />
      <path d="M7.5 12h.01" />
      {hidden && <path d="M4 20 20 4" />}
    </RailIcon>
  );
}

/** Stacked layers — isolating one part of the drawing reads as peeling a
 *  layer off the stack. */
function ViewOptionsIcon() {
  return (
    <RailIcon>
      <path d="m12 3.5 8.5 4.5-8.5 4.5-8.5-4.5L12 3.5Z" />
      <path d="m3.5 12 8.5 4.5 8.5-4.5" />
      <path d="m3.5 15.5 8.5 4.5 8.5-4.5" />
    </RailIcon>
  );
}

function TextViewIcon() {
  return (
    <RailIcon>
      <path d="M14 3H6.5A1.5 1.5 0 0 0 5 4.5v15A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5V8Z" />
      <path d="M14 3v5h5" />
      <path d="M8.5 13h7M8.5 17h4.5" />
    </RailIcon>
  );
}

function TableViewIcon() {
  return (
    <RailIcon>
      <rect x="3.5" y="4.5" width="17" height="15" rx="1.5" />
      <path d="M3.5 9.5h17M3.5 14.5h17M10 9.5v10" />
    </RailIcon>
  );
}

export interface CanvasRailProps {
  multiSelectActive: boolean;
  setMultiSelectActive: (active: boolean) => void;
  inspectMode: boolean;
  toggleInspectMode: () => void;
  canInspectResult: boolean;
  view3d: boolean;
  setCanvasView: (view: "2d" | "3d") => void;
  showLabels: boolean;
  setShowLabels: (show: boolean) => void;
  canvasVisibility: CanvasVisibility;
  setCanvasVisibility: (patch: Partial<CanvasVisibility>) => void;
  onAddNode: (type: "internal" | "boundary") => void;
  onAddSolidNode: (kind: "solid" | "ambient") => void;
  onAddNote: () => void;
  onOpenModelView: (view: ModelViewDialogKind) => void;
}

export default function CanvasRail({
  multiSelectActive,
  setMultiSelectActive,
  inspectMode,
  toggleInspectMode,
  canInspectResult,
  view3d,
  setCanvasView,
  showLabels,
  setShowLabels,
  canvasVisibility,
  setCanvasVisibility,
  onAddNode,
  onAddSolidNode,
  onAddNote,
  onOpenModelView,
}: CanvasRailProps) {
  return (
    <div
      id="canvas-node-actions"
      className="canvas-rail"
      role="group"
      aria-label="Model builder tools"
    >
      <div
        className="canvas-rail__group"
        role="group"
        aria-label="Canvas tools"
      >
        <RailButton
          label="Select"
          hint="Drag a marquee to multi-select"
          pressed={multiSelectActive}
          onClick={() => setMultiSelectActive(true)}
        >
          <SelectToolIcon />
        </RailButton>
        <RailButton
          label="Pan"
          hint="Drag to move the canvas"
          pressed={!multiSelectActive}
          onClick={() => setMultiSelectActive(false)}
        >
          <PanToolIcon />
        </RailButton>
        <RailButton
          label="Inspect properties"
          hint={
            canInspectResult
              ? "Read values off the selection"
              : "Needs a converged run"
          }
          pressed={inspectMode}
          disabled={!canInspectResult}
          onClick={toggleInspectMode}
        >
          <InspectModeIcon />
        </RailButton>
        <RailButton
          label={view3d ? "Schematic view" : "3D view"}
          hint={
            view3d
              ? "Back to the P&ID layout"
              : "Place elements by physical position"
          }
          testId="canvas-3d-toggle"
          pressed={view3d}
          onClick={() => setCanvasView(view3d ? "2d" : "3d")}
        >
          <View3DIcon />
        </RailButton>
        <RailButton
          label={showLabels ? "Hide labels" : "Show labels"}
          hint="All names and readouts on the drawing"
          testId="canvas-labels-toggle"
          pressed={!showLabels}
          onClick={() => setShowLabels(!showLabels)}
        >
          <LabelsIcon hidden={!showLabels} />
        </RailButton>
        <ViewOptionsControl
          visibility={canvasVisibility}
          onChange={setCanvasVisibility}
        />
      </div>
      <div className="canvas-rail__divider" />
      <div className="canvas-rail__group" role="group" aria-label="Fluid nodes">
        <RailNodeTool
          kind="fluid:internal"
          label="Internal node"
          domain="Fluid"
          testId="add-internal-node"
          onClick={() => onAddNode("internal")}
        />
        <RailNodeTool
          kind="fluid:boundary"
          label="Boundary node"
          domain="Fluid"
          testId="add-boundary-node"
          onClick={() => onAddNode("boundary")}
        />
      </div>
      <div className="canvas-rail__divider" />
      <div
        className="canvas-rail__group"
        role="group"
        aria-label="Thermal nodes"
      >
        <RailNodeTool
          kind="solid:solid"
          label="Solid node"
          domain="Thermal"
          testId="add-solid-node"
          onClick={() => onAddSolidNode("solid")}
        />
        <RailNodeTool
          kind="solid:ambient"
          label="Ambient node"
          domain="Thermal"
          testId="add-ambient-node"
          onClick={() => onAddSolidNode("ambient")}
        />
      </div>
      <div className="canvas-rail__divider" />
      <div className="canvas-rail__group" role="group" aria-label="Annotations">
        <RailNoteTool testId="add-note" onClick={onAddNote} />
      </div>
      <div className="canvas-rail__divider" />
      <div className="canvas-rail__group" role="group" aria-label="Model views">
        <RailButton
          label="Text view"
          testId="canvas-text-view"
          onClick={() => onOpenModelView("text")}
        >
          <TextViewIcon />
        </RailButton>
        <RailButton
          label="Table view"
          testId="canvas-table-view"
          onClick={() => onOpenModelView("table")}
        >
          <TableViewIcon />
        </RailButton>
      </div>
    </div>
  );
}
