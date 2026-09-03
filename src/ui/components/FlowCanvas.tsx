import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ReactFlow,
  Controls,
  Background,
  MiniMap,
  useNodesState,
  useEdgesState,
  useNodes,
  useReactFlow,
  Connection,
  Edge,
  Node,
  Panel,
  ConnectionMode,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useStore } from "../store";
import { createId, loadGlobalMapOpen, saveGlobalMapOpen } from "../utils";
import { canvasDropPosition } from "../dropPosition";
import {
  LabelLayoutContext,
  layoutLabels,
  LabelItem,
  EMPTY_LAYOUT,
} from "../labelLayout";
import { DENSE_ELEMENT_COUNT, zoomTier } from "../zoomTiers";
import { NetworkConfig, MultiSelectionItem } from "../types";
import { resolveScale, formatSig, formatWithUnit } from "../format";
import { convertToSI } from "../units";
import {
  resolveColorData,
  resolveSnapshot,
  colorByGroups,
  ColorBy,
  rampGradientStops,
  rampEndColors,
  fillForCanvas,
  sliderValueFromFraction,
  moveSliderEdge,
} from "../colorData";
import {
  GRID_MAJOR,
  GRID_MINOR,
  GROUP_FILL,
  NODE_GHOST,
  NOTE_MINIMAP,
  fluidNodeColor,
  solidNodeColor,
} from "../canvasPalette";
import {
  BRANCH_COMPONENTS,
  CONDUCTORS,
  componentLabel,
  defaultComponent,
  conductorLabel,
  defaultConductor,
} from "../componentRegistry";
import {
  componentInstanceDefaults,
  localComponentForTool,
  localComponentToolId,
  refreshComponentLibrary,
  resolveBranchTool,
  type LocalComponent,
  useComponentLibrary,
} from "../componentLibrary";
import {
  connectionOrientation,
  DEFAULT_ORIENTATION,
  ConnectionOrientation,
  CanvasPoint,
} from "../connectionGeometry";
import {
  SOLID_NODE_LABEL_OFFSET_Y,
  EDGE_INTERACTION_WIDTH,
  fluidNodeCenter,
  fluidNodeSize,
  gridOriginForCenter,
  fluidNodeLabelOffsetY,
  GROUP_HEIGHT,
  GROUP_WIDTH,
  NOTE_MIN_HEIGHT,
  NOTE_WIDTH,
  noteSize,
  snapPointToGrid,
  solidNodeCenter,
  snapOriginToGrid,
  SOLID_NODE_SIZE,
  groupCenter,
  groupOriginForCenter,
} from "../canvasGeometry";
import {
  canStartConductor,
  canStartFluidBranch,
  conductorEndpointError,
  fluidBranchEndpointError,
  topologyOf,
} from "../connectionRules";
import { arrayMin, arrayMax } from "../arrayMinMax";
import { canvasElementFromDrop } from "../canvasDnd";
import { physicalLayout, projectLayout } from "../physicalLayout";
import {
  DEFAULT_CAMERA,
  depthOpacity,
  depthZIndex,
  type Camera3D,
} from "../projection3d";
import Canvas3DControls from "./Canvas3DControls";
import CanvasRail from "./CanvasRail";
import CustomNode from "./CustomNode";
import CustomEdge from "./CustomEdge";
import CustomSolidNode from "./CustomSolidNode";
import ConductorEdge from "./ConductorEdge";
import GroupContainer from "./GroupContainer";
import CanvasNote from "./CanvasNote";
import PidSymbol from "./PidSymbol";
import ComponentEditorDialog from "./ComponentEditorDialog";
import RepeatDialog, { RepeatMenuAction } from "./RepeatDialog";
import { analyzeRepeatSelection } from "../repeatSelection";
import InteractiveChart, { type Series } from "./InteractiveChart";
import { resolveChannel } from "../channels";
import { formatChannelValue } from "../channelExplorer";
import {
  channelsForSelection,
  hasInspectableResult,
} from "../selectionInspect";

type NodeConfig = NetworkConfig["nodes"][number];
type BranchConfig = NetworkConfig["branches"][number];
type SolidNodeConfig = NonNullable<NetworkConfig["solidNodes"]>[number];
type ConductorConfig = NonNullable<NetworkConfig["conductors"]>[number];

const EMPTY_GROUPS: NonNullable<NetworkConfig["groups"]> = [];
const EMPTY_SOLID_NODES: NonNullable<NetworkConfig["solidNodes"]> = [];
const EMPTY_CONDUCTORS: NonNullable<NetworkConfig["conductors"]> = [];
const EMPTY_NOTES: NonNullable<NetworkConfig["notes"]> = [];

/** React Flow id prefix for note nodes — note ids live in their own namespace,
 *  so the prefix keeps them from ever colliding with a node id. */
const NOTE_NODE_PREFIX = "note-";

// Rail chrome (RailButton, node tools, view-options menu, icons) lives in
// CanvasRail.tsx so shells can host the rail outside the canvas.

// Rendered node sizes and the centers derived from them live in
// canvasGeometry.ts (shared with CustomNode / CustomSolidNode /
// GroupContainer) so edge sides are chosen from the same centers the user
// sees.

const nodeTypes = {
  fluidNode: CustomNode,
  solidNode: CustomSolidNode,
  groupContainer: GroupContainer,
  canvasNote: CanvasNote,
};
const edgeTypes = { fluidEdge: CustomEdge, conductorEdge: ConductorEdge };

function groupIdFromNode(node: Node): string | null {
  const groupId =
    node.data && typeof node.data.groupId === "string"
      ? node.data.groupId
      : null;
  return groupId;
}

/** Config note id behind a React Flow note node (data first, prefix as fallback). */
function noteIdFromNode(node: Node): string {
  if (node.data && typeof node.data.noteId === "string")
    return node.data.noteId;
  return node.id.startsWith(NOTE_NODE_PREFIX)
    ? node.id.slice(NOTE_NODE_PREFIX.length)
    : node.id;
}

interface FlowCanvasProps {
  groupId?: string;
  onOpenModelView: (view: "text" | "table") => void;
}

/**
 * Fit the view once per config epoch (New / Load / example load), AFTER the
 * freshly rendered nodes have been measured. Retries a few frames until at
 * least one node reports real measurements, then stops — user pans/zooms are
 * never overridden afterwards.
 */
function FitOnLoad({ epoch }: { epoch: string }) {
  const rf = useReactFlow();
  useEffect(() => {
    let cancelled = false;
    let timer = 0;
    let attempts = 0;
    const tryFit = () => {
      if (cancelled) return;
      const measured = rf.getNodes().some((n) => (n.measured?.width ?? 0) > 0);
      if (measured || attempts >= 8) {
        // Cap the fit zoom: a two-node model must not land at scale(2).
        void rf.fitView({ padding: 0.15, duration: 0, maxZoom: 1.25 });
        return;
      }
      attempts++;
      timer = window.setTimeout(tryFit, 60);
    };
    const raf = requestAnimationFrame(() => requestAnimationFrame(tryFit));
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      clearTimeout(timer);
    };
  }, [epoch, rf]);
  return null;
}

/**
 * Refits the frame after something re-places the whole graph (view toggle,
 * camera preset).
 *
 * Timing is the whole point. Node positions reach React Flow's store one
 * commit after the change that caused them, so fitting from the triggering
 * click — even behind a double requestAnimationFrame — can measure the
 * PREVIOUS layout and leave the model half off-screen. Keying the fit on the
 * store's own nodes guarantees the new positions are in place, and the
 * nonce/served pair makes it fire exactly once per request rather than on
 * every unrelated store change (selection, hover, measurement).
 */
function RefitOnRequest({ nonce }: { nonce: number }) {
  const rf = useReactFlow();
  const nodes = useNodes();
  const served = useRef(nonce);
  useEffect(() => {
    if (served.current === nonce) return;
    // Unmeasured nodes have no bounds to fit; wait for the measurement pass.
    if (!nodes.some((n) => (n.measured?.width ?? 0) > 0)) return;
    served.current = nonce;
    void rf.fitView({ padding: 0.15, duration: 0, maxZoom: 1.25 });
  }, [nodes, nonce, rf]);
  return null;
}

/** Pans/zooms the canvas to a requested element (Model Table navigation). */
function FocusRequestHandler() {
  const rf = useReactFlow();
  const req = useStore((s) => s.canvasFocusRequest);
  const clear = useStore((s) => s.clearCanvasFocusRequest);
  useEffect(() => {
    if (!req) return;
    const cfg = useStore.getState().config;
    const groupPos = (gid: string): { x: number; y: number } | null => {
      const g = (cfg.groups ?? []).find((gr) => gr.id === gid);
      return g ? groupCenter(g) : null;
    };
    const posOf = (id: string): { x: number; y: number } | null => {
      const f = cfg.nodes.find((n) => n.id === id);
      if (f)
        return f.group
          ? (groupPos(f.group) ?? fluidNodeCenter(f))
          : fluidNodeCenter(f);
      const s = (cfg.solidNodes ?? []).find((n) => n.id === id);
      if (s)
        return s.group
          ? (groupPos(s.group) ?? solidNodeCenter(s))
          : solidNodeCenter(s);
      const g = (cfg.groups ?? []).find((gr) => gr.id === id);
      if (g) return groupCenter(g);
      const note = (cfg.notes ?? []).find((n) => n.id === id);
      if (!note) return null;
      const { width, height } = noteSize(note);
      return { x: note.x + width / 2, y: note.y + height / 2 };
    };
    let center: { x: number; y: number } | null = null;
    if (req.kind === "branch" || req.kind === "conductor") {
      const e =
        req.kind === "branch"
          ? cfg.branches.find((b) => b.id === req.id)
          : (cfg.conductors ?? []).find((c) => c.id === req.id);
      if (e) {
        const a = posOf(e.from);
        const b = posOf(e.to);
        if (a && b) center = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      }
    } else {
      center = posOf(req.id);
    }
    if (!center) {
      clear();
      return;
    }
    const target = center;
    const raf = requestAnimationFrame(() => {
      const vp = useStore.getState().canvasViewport;
      void rf.setCenter(target.x, target.y, {
        zoom: Math.max(vp.zoom, 0.9),
        duration: 300,
      });
      clear();
    });
    return () => cancelAnimationFrame(raf);
  }, [req, rf, clear]);
  return null;
}

export default function FlowCanvas({
  groupId,
  onOpenModelView,
}: FlowCanvasProps) {
  const componentLibrary = useComponentLibrary();
  // A11y: do NOT auto-focus the canvas on mount — the first Tab press must
  // start at the toolbar, not jump past it. The canvas stays focusable via
  // tabIndex and takes focus on click/keyboard interaction as usual.
  const canvasRef = React.useRef<HTMLDivElement>(null);

  const config = useStore((s) => s.config);
  const selection = useStore((s) => s.selection);
  const result = useStore((s) => s.result);
  const unitPreferences = useStore((s) => s.unitPreferences);
  const resultSigFigs = useStore((s) => s.resultSigFigs);
  const liveResult = useStore((s) => s.liveResult);
  const runStatus = useStore((s) => s.runStatus);
  const colorBy = useStore((s) => s.colorBy);
  const colorDomainOverrides = useStore((s) => s.colorDomainOverrides);
  const timeIndex = useStore((s) => s.timeIndex);
  const resultStale = useStore((s) => s.resultStale);
  const setColorBy = useStore((s) => s.setColorBy);
  const setTimeIndex = useStore((s) => s.setTimeIndex);
  const branchTool = useStore((s) => s.branchTool);
  const conductorTool = useStore((s) => s.conductorTool);
  const pendingSourceNodeId = useStore((s) => s.pendingSourceNodeId);
  const pendingConductorSourceId = useStore((s) => s.pendingConductorSourceId);
  const setSelection = useStore((s) => s.setSelection);
  const addNode = useStore((s) => s.addNode);
  const addBranch = useStore((s) => s.addBranch);
  const addSolidNode = useStore((s) => s.addSolidNode);
  const addNote = useStore((s) => s.addNote);
  const addConductor = useStore((s) => s.addConductor);
  const removeNode = useStore((s) => s.removeNode);
  const removeBranch = useStore((s) => s.removeBranch);
  const removeSolidNode = useStore((s) => s.removeSolidNode);
  const removeConductor = useStore((s) => s.removeConductor);
  const setBranchTool = useStore((s) => s.setBranchTool);
  const setConductorTool = useStore((s) => s.setConductorTool);
  const setPendingSourceNodeId = useStore((s) => s.setPendingSourceNodeId);
  const setPendingConductorSourceId = useStore(
    (s) => s.setPendingConductorSourceId,
  );
  const updateNode = useStore((s) => s.updateNode);
  const updateSolidNode = useStore((s) => s.updateSolidNode);
  const openGroupTab = useStore((s) => s.openGroupTab);
  const setActiveTab = useStore((s) => s.setActiveTab);
  const setActiveGroupTab = useStore((s) => s.setActiveGroupTab);
  const setCanvasViewport = useStore((s) => s.setCanvasViewport);
  const canvasSelection = useStore((s) => s.canvasSelection);
  const setCanvasSelection = useStore((s) => s.setCanvasSelection);
  const configEpoch = useStore((s) => s.configEpoch);
  const canvasViewport = useStore((s) => s.canvasViewport);
  const duplicateSelection = useStore((s) => s.duplicateSelection);
  const nodeIds = useMemo(
    () => new Set(config.nodes.map((n) => n.id)),
    [config.nodes],
  );
  const solidNodeIds = useMemo(
    () => new Set((config.solidNodes ?? []).map((n) => n.id)),
    [config.solidNodes],
  );
  const allNodeIds = useMemo(
    () => new Set([...nodeIds, ...solidNodeIds]),
    [nodeIds, solidNodeIds],
  );
  const groups = config.groups ?? EMPTY_GROUPS;
  const canvasSelectionSet = useMemo(
    () => new Set(canvasSelection),
    [canvasSelection],
  );
  /** Ids in the panel's multi-selection. Edges need this to keep their
   *  React Flow `selected` flag across the initialEdges rebuild: nodes
   *  survive rebuilds via canvasSelection, but edges have no equivalent
   *  store — without this, entering multi-selection rebuilds every edge
   *  with selected: false and instantly collapses a tie multi-selection. */
  const multiSelectionSet = useMemo(
    () =>
      selection.kind === "multi"
        ? new Set(selection.items.map((item) => item.id))
        : new Set<string>(),
    [selection],
  );
  const nodesArr = config.nodes;
  const branchesArr = config.branches;
  const solidNodesArr = config.solidNodes ?? EMPTY_SOLID_NODES;
  const conductorsArr = config.conductors ?? EMPTY_CONDUCTORS;
  const notesArr = config.notes ?? EMPTY_NOTES;
  const noteIds = useMemo(() => new Set(notesArr.map((n) => n.id)), [notesArr]);

  const snapshot = useMemo(
    () => resolveSnapshot(config, result, liveResult, runStatus, timeIndex),
    [config, result, liveResult, runStatus, timeIndex],
  );

  const colorData = useMemo(
    () =>
      resolveColorData(
        config,
        result,
        liveResult,
        runStatus,
        colorBy,
        timeIndex,
        resultStale,
        colorDomainOverrides[colorBy],
      ),
    [
      config,
      result,
      liveResult,
      runStatus,
      colorBy,
      timeIndex,
      resultStale,
      colorDomainOverrides,
    ],
  );

  // Dense-graph policy escalates the names→sparse zoom threshold.
  const dense = useMemo(
    () =>
      nodesArr.length +
        solidNodesArr.length +
        branchesArr.length +
        conductorsArr.length +
        groups.length >=
      DENSE_ELEMENT_COUNT,
    [nodesArr, solidNodesArr, branchesArr, conductorsArr, groups],
  );

  /* ── Projected 3D view ───────────────────────────────────────────────────
   * The 3D view is the SAME React Flow graph re-placed by physical position:
   * every element keeps its id, so selection, the property panel, hover,
   * result coloring and the connection tools work untouched. Only the
   * positions, stacking order and depth fade are derived here.
   *
   * The layout spans the whole model rather than just the active tab, so a
   * subnetwork stays anchored where it physically sits relative to the rest
   * of the plant instead of being re-centred on its own members.
   */
  const canvasView = useStore((s) => s.canvasView);
  const camera3d = useStore((s) => s.camera3d);
  const setCanvasView = useStore((s) => s.setCanvasView);
  const setCamera3d = useStore((s) => s.setCamera3d);
  const view3d = canvasView === "3d";
  const showLabels = useStore((s) => s.showLabels);
  const setShowLabels = useStore((s) => s.setShowLabels);
  const canvasVisibility = useStore((s) => s.canvasVisibility);
  const setCanvasVisibility = useStore((s) => s.setCanvasVisibility);
  // Hoisted so the node/edge/label memos below can all read the same
  // primitives without each re-deriving them from the visibility object.
  const showFluidNodes = canvasVisibility.fluidNodes;
  const showThermalNodes = canvasVisibility.thermalNodes;
  const showFluidBranches = canvasVisibility.fluidBranches;

  /**
   * A camera is only meaningful for the model it was framed against: carrying
   * a steep orbit into a freshly loaded model can open the 3D view edge-on,
   * collapsing it to a line. Wholesale config replacement (Load, New, an
   * example) bumps configEpoch, so the camera resets with it — while merely
   * toggling the view does not, letting an orbit survive a round trip through
   * the schematic.
   */
  useEffect(() => {
    setCamera3d(DEFAULT_CAMERA);
  }, [configEpoch, setCamera3d]);

  /**
   * Refit requests for changes that re-place the whole graph. Orbiting
   * deliberately does NOT request one — refitting on every drag frame would
   * pull the model around under the pointer.
   */
  const [refitNonce, setRefitNonce] = useState(0);
  const requestRefit = useCallback(
    () => setRefitNonce((nonce) => nonce + 1),
    [],
  );

  /**
   * Entering or leaving 3D, and swapping the model while in 3D, all re-place
   * every element while the nodes are ALREADY measured — the one case
   * FitOnLoad cannot detect, since it fits as soon as anything has bounds and
   * would measure the outgoing layout.
   */
  useEffect(() => {
    requestRefit();
  }, [view3d, configEpoch, requestRefit]);

  const layout3d = useMemo(
    () =>
      view3d
        ? physicalLayout({ nodes: nodesArr, solidNodes: solidNodesArr })
        : null,
    [view3d, nodesArr, solidNodesArr],
  );
  const projected3d = useMemo(
    () => (layout3d ? projectLayout(layout3d, camera3d) : null),
    [layout3d, camera3d],
  );

  const applyCameraPreset = useCallback(
    (camera: Camera3D) => {
      setCamera3d(camera);
      requestRefit();
    },
    [setCamera3d, requestRefit],
  );

  /** Projected centre of a rendered node id, for 3D edge anchor selection. */
  const projectedCenter = useCallback(
    (rfNodeId: string): CanvasPoint | null => {
      if (!projected3d) return null;
      const realId = rfNodeId.startsWith("ghost-")
        ? rfNodeId.slice("ghost-".length)
        : rfNodeId;
      const placed = projected3d.get(realId);
      return placed ? { x: placed.x, y: placed.y } : null;
    },
    [projected3d],
  );

  /**
   * Screen-space label declutter. Runs over the labels that the current zoom
   * tier would render; identical adjacent labels aggregate to `Name ×N`
   * (names tier and below), and survivors are greedy-culled so no two chips
   * overlap. Selection always survives. Provided via context so pan/zoom
   * doesn't rebuild node objects. Edge readouts are hover-only and are not
   * part of persistent label collision planning.
   */
  const labelLayout = useMemo(() => {
    if (!showLabels) return EMPTY_LAYOUT;
    const tier = zoomTier(canvasViewport.zoom, dense);
    if (tier === "sparse" || tier === "hidden") return EMPTY_LAYOUT;
    const { x: panX, y: panY, zoom } = canvasViewport;
    const items: LabelItem[] = [];
    // Declutter must run on the coordinates actually drawn: fed schematic
    // positions while the view is projected, it would cull the wrong labels
    // and leave the surviving ones overlapping.
    const originOf = (id: string, x: number, y: number, half: number) => {
      const placed = projected3d?.get(id);
      return placed ? { x: placed.x - half, y: placed.y - half } : { x, y };
    };
    const fluidShown = !showFluidNodes
      ? []
      : view3d
        ? nodesArr
        : groupId
          ? nodesArr.filter((n) => n.group === groupId)
          : nodesArr.filter((n) => !n.group);
    for (const n of fluidShown) {
      const origin = originOf(n.id, n.x, n.y, fluidNodeSize(n.type) / 2);
      items.push({
        id: n.id,
        x: origin.x * zoom + panX,
        y: (origin.y + fluidNodeLabelOffsetY(n.type)) * zoom + panY,
        text: n.label || n.id,
        kind: "node",
        alwaysShow: selection.kind === "node" && selection.id === n.id,
      });
    }
    const solidShown = !showThermalNodes
      ? []
      : view3d
        ? solidNodesArr
        : groupId
          ? solidNodesArr.filter((n) => n.group === groupId)
          : solidNodesArr.filter((n) => !n.group);
    for (const n of solidShown) {
      const origin = originOf(n.id, n.x, n.y, SOLID_NODE_SIZE / 2);
      items.push({
        id: n.id,
        x: origin.x * zoom + panX,
        y: (origin.y + SOLID_NODE_LABEL_OFFSET_Y) * zoom + panY,
        text: n.label || n.id,
        kind: "node",
        alwaysShow: selection.kind === "solidNode" && selection.id === n.id,
      });
    }
    return layoutLabels(items, { aggregate: tier !== "full" });
  }, [
    nodesArr,
    solidNodesArr,
    canvasViewport,
    groupId,
    selection,
    dense,
    view3d,
    projected3d,
    showLabels,
    showFluidNodes,
    showThermalNodes,
  ]);

  const connectionToolActiveFor = (id: string): boolean => {
    const topology = connectionTopology;
    if (!topology) return false;
    if (connectionSourceId) {
      const source = connectionSourceId.startsWith("ghost-")
        ? connectionSourceId.slice(6)
        : connectionSourceId;
      const target = id.startsWith("ghost-") ? id.slice(6) : id;
      if (source === target) return false;
      return (
        fluidBranchEndpointError(config, source, target, topology) === null ||
        CONDUCTORS.some(
          (item) =>
            conductorEndpointError(
              config,
              item.id,
              source,
              target,
              topology,
            ) === null,
        )
      );
    }
    if (branchTool) return canStartFluidBranch(config, id, topology);
    if (conductorTool) {
      return canStartConductor(
        config,
        conductorTool as "conduction" | "convection" | "radiation",
        id,
        topology,
      );
    }
    return false;
  };

  // Member picker state for connecting into a group container
  const [memberPicker, setMemberPicker] = useState<{
    x: number;
    y: number;
    members: Array<NodeConfig | SolidNodeConfig>;
    onPick: (nodeId: string) => void;
  } | null>(null);

  const [connectError, setConnectError] = useState<string | null>(null);
  const [connectionSourceId, setConnectionSourceId] = useState<string | null>(
    null,
  );
  // One topology model per rebuild while a connect tool is armed, shared by
  // every connectionToolActiveFor call; null (and never built) otherwise.
  const connectionTopology = useMemo(
    () =>
      connectionSourceId || branchTool || conductorTool
        ? topologyOf(config)
        : null,
    [connectionSourceId, branchTool, conductorTool, config],
  );
  const pointerRef = useRef({ x: 0, y: 0 });
  const shiftSelectingRef = useRef(false);
  const marqueeSelectingRef = useRef(false);

  /* ── Orbit (3D view only) ────────────────────────────────────────────────
   * Left-drag on empty canvas spins the camera. React Flow keeps panning on
   * the middle and right buttons while 3D is active (see panOnDrag), which
   * frees button 0 without costing the user pan or zoom. The drag is armed
   * from the wrapper but tracked on the window, so the camera keeps following
   * a pointer that leaves the canvas.
   */
  const ORBIT_DEG_PER_PX = 0.4;
  const orbitRef = useRef<{
    x: number;
    y: number;
    yaw: number;
    pitch: number;
  } | null>(null);
  /** Set once a drag actually rotated, so the trailing pane click that React
   *  Flow synthesizes cannot clear the selection behind the orbit. */
  const orbitMovedRef = useRef(false);

  const beginOrbit = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!view3d || event.button !== 0) return;
      const target = event.target instanceof Element ? event.target : null;
      // Nodes and edges keep their own click/selection behaviour, and the
      // overlays (rail, controls, minimap) are chrome, not canvas.
      if (
        target?.closest(
          ".react-flow__node, .react-flow__edge, .react-flow__panel, .react-flow__controls, .react-flow__minimap",
        )
      ) {
        return;
      }
      orbitRef.current = {
        x: event.clientX,
        y: event.clientY,
        yaw: camera3d.yaw,
        pitch: camera3d.pitch,
      };
      orbitMovedRef.current = false;
    },
    [view3d, camera3d],
  );

  useEffect(() => {
    if (!view3d) return;
    const onMove = (event: PointerEvent) => {
      const start = orbitRef.current;
      if (!start) return;
      const dx = event.clientX - start.x;
      const dy = event.clientY - start.y;
      // A few pixels of slop keeps a plain click on empty canvas a click.
      if (!orbitMovedRef.current && Math.hypot(dx, dy) < 3) return;
      orbitMovedRef.current = true;
      setCamera3d({
        yaw: start.yaw + dx * ORBIT_DEG_PER_PX,
        pitch: start.pitch + dy * ORBIT_DEG_PER_PX,
      });
    };
    const endOrbit = () => {
      orbitRef.current = null;
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", endOrbit);
    window.addEventListener("pointercancel", endOrbit);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", endOrbit);
      window.removeEventListener("pointercancel", endOrbit);
      orbitRef.current = null;
    };
  }, [view3d, setCamera3d]);
  const [connectionChooser, setConnectionChooser] = useState<{
    source: string;
    target: string;
    x: number;
    y: number;
    branches: string[];
    conductors: string[];
  } | null>(null);
  const [connectionChooserDrag, setConnectionChooserDrag] = useState<{
    offsetX: number;
    offsetY: number;
  } | null>(null);
  const [componentEditorConnection, setComponentEditorConnection] = useState<{
    source: string;
    target: string;
  } | null>(null);
  const [selectionPlotProperties, setSelectionPlotProperties] = useState<
    string[]
  >([]);
  const [selectionPlotPosition, setSelectionPlotPosition] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const [selectionPlotDrag, setSelectionPlotDrag] = useState<{
    offsetX: number;
    offsetY: number;
  } | null>(null);

  useEffect(() => {
    if (!connectionChooserDrag) return;
    const onMove = (event: MouseEvent) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const bounds = canvas.getBoundingClientRect();
      // Keep the header and Cancel action within the canvas even near edges.
      const x = Math.max(
        8,
        Math.min(
          bounds.width - 308,
          event.clientX - bounds.left - connectionChooserDrag.offsetX,
        ),
      );
      const y = Math.max(
        8,
        Math.min(
          bounds.height - 280,
          event.clientY - bounds.top - connectionChooserDrag.offsetY,
        ),
      );
      setConnectionChooser((current) =>
        current ? { ...current, x, y } : current,
      );
    };
    const onUp = () => setConnectionChooserDrag(null);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp, { once: true });
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [connectionChooserDrag]);

  useEffect(() => {
    if (!selectionPlotDrag) return;
    const onMove = (event: MouseEvent) => {
      const bounds = canvasRef.current?.getBoundingClientRect();
      if (!bounds) return;
      setSelectionPlotPosition({
        x: Math.max(
          8,
          Math.min(
            bounds.width - 300,
            event.clientX - bounds.left - selectionPlotDrag.offsetX,
          ),
        ),
        y: Math.max(
          8,
          Math.min(
            bounds.height - 120,
            event.clientY - bounds.top - selectionPlotDrag.offsetY,
          ),
        ),
      });
    };
    const onUp = () => setSelectionPlotDrag(null);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp, { once: true });
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [selectionPlotDrag]);

  // Collapsible global map (MiniMap) — expanded by default, persisted.
  const [globalMapOpen, setGlobalMapOpen] = useState<boolean>(() =>
    loadGlobalMapOpen(),
  );
  const [multiSelectActive, setMultiSelectActive] = useState(false);
  const [inspectMode, setInspectMode] = useState(false);
  const toggleGlobalMap = useCallback(() => {
    setGlobalMapOpen((prev) => {
      saveGlobalMapOpen(!prev);
      return !prev;
    });
  }, []);

  // Screen-reader announcement for subnetwork creation.
  const [subnetworkNotice, setSubnetworkNotice] = useState("");
  // Screen-reader announcement for duplication — set inside the store action
  // so the toolbar button and the global Ctrl/Cmd+D shortcut announce alike.
  const duplicateNotice = useStore((s) => s.duplicateNotice);

  const canDuplicate =
    canvasSelection.length > 0 ||
    selection.kind === "node" ||
    selection.kind === "solidNode" ||
    selection.kind === "branch";

  const handleDuplicate = useCallback(() => {
    duplicateSelection();
  }, [duplicateSelection]);

  // ── Repeat-N (chain the selected unit) ────────────────────────────────
  // analyzeRepeatSelection returns a fresh object per call, so it must be
  // memoized here rather than used as a bare zustand selector.
  const repeatability = useMemo(
    () => analyzeRepeatSelection(config, selection, canvasSelection),
    [config, selection, canvasSelection],
  );
  const [repeatDialogOpen, setRepeatDialogOpen] = useState(false);

  const deleteSelected = useCallback(() => {
    if (selection.kind === "multi") {
      // Nodes first (their removal cascades attached edges), then any
      // still-existing selected edges — skipping already-cascaded ones so
      // no undo entry is burned on a no-op removal.
      const rank = (item: MultiSelectionItem) =>
        item.kind === "node" || item.kind === "solidNode" ? 0 : 1;
      const items = [...selection.items].sort((a, b) => rank(a) - rank(b));
      for (const item of items) {
        const cfg = useStore.getState().config;
        if (item.kind === "node" && cfg.nodes.some((n) => n.id === item.id))
          removeNode(item.id);
        else if (
          item.kind === "solidNode" &&
          (cfg.solidNodes ?? []).some((n) => n.id === item.id)
        )
          removeSolidNode(item.id);
        else if (
          item.kind === "branch" &&
          cfg.branches.some((b) => b.id === item.id)
        )
          removeBranch(item.id);
        else if (
          item.kind === "conductor" &&
          (cfg.conductors ?? []).some((c) => c.id === item.id)
        )
          removeConductor(item.id);
      }
      setCanvasSelection([]);
      setSelection({ kind: "none" });
      return;
    }
    if (canvasSelection.length > 0) {
      for (const id of canvasSelection) {
        if (config.nodes.some((node) => node.id === id)) removeNode(id);
        else if ((config.solidNodes ?? []).some((node) => node.id === id))
          removeSolidNode(id);
      }
      setCanvasSelection([]);
      setSelection({ kind: "none" });
      return;
    }
    if (selection.kind === "node") removeNode(selection.id);
    else if (selection.kind === "branch") removeBranch(selection.id);
    else if (selection.kind === "solidNode") removeSolidNode(selection.id);
    else if (selection.kind === "note")
      useStore.getState().removeNote(selection.id);
    else if (selection.kind === "conductor") removeConductor(selection.id);
    else if (selection.kind === "group")
      useStore.getState().removeGroup(selection.id);
    setSelection({ kind: "none" });
  }, [
    canvasSelection,
    config.nodes,
    config.solidNodes,
    removeNode,
    removeBranch,
    removeSolidNode,
    removeConductor,
    selection,
    setCanvasSelection,
    setSelection,
  ]);

  // Build React Flow nodes
  const initialNodes: Node[] = useMemo(() => {
    const nodes: Node[] = [];

    if (groupId) {
      // Group tab: member nodes + ghost nodes for external endpoints
      const fluidMembers = nodesArr.filter((n) => n.group === groupId);
      const solidMembers = solidNodesArr.filter((n) => n.group === groupId);
      const memberIds = new Set([
        ...fluidMembers.map((n) => n.id),
        ...solidMembers.map((n) => n.id),
      ]);
      const externalIds = new Set<string>();
      for (const b of branchesArr) {
        if (memberIds.has(b.from) && !memberIds.has(b.to))
          externalIds.add(b.to);
        if (memberIds.has(b.to) && !memberIds.has(b.from))
          externalIds.add(b.from);
      }
      for (const c of conductorsArr) {
        if (memberIds.has(c.from) && !memberIds.has(c.to))
          externalIds.add(c.to);
        if (memberIds.has(c.to) && !memberIds.has(c.from))
          externalIds.add(c.from);
      }

      if (showFluidNodes) {
        for (const n of fluidMembers) {
          const sel = selection.kind === "node" && selection.id === n.id;
          const snap = snapshot.nodes[n.id];
          nodes.push({
            id: n.id,
            type: "fluidNode",
            position: { x: n.x, y: n.y },
            data: {
              node: n,
              selected: sel,
              resultPressure: snap?.pressure,
              resultTemperature: snap?.temperature,
              colorValue: colorData.nodeValues[n.id],
              domain: colorData.domain,
              colorBy,
              colorSigned: colorData.signed,
              branchToolActive: connectionToolActiveFor(n.id),
              dense,
              isPendingSource:
                pendingSourceNodeId === n.id ||
                pendingConductorSourceId === n.id,
            },
            selected: sel,
          });
        }
      }

      if (showThermalNodes) {
        for (const n of solidMembers) {
          const sel = selection.kind === "solidNode" && selection.id === n.id;
          const snap = snapshot.solidNodes[n.id];
          nodes.push({
            id: n.id,
            type: "solidNode",
            position: { x: n.x, y: n.y },
            data: {
              node: n,
              selected: sel,
              resultTemperature: snap?.temperature,
              colorValue: colorData.solidValues[n.id],
              domain: colorData.domain,
              colorBy,
              colorSigned: colorData.signed,
              branchToolActive: connectionToolActiveFor(n.id),
              dense,
              isPendingSource:
                pendingSourceNodeId === n.id ||
                pendingConductorSourceId === n.id,
            },
            selected: sel,
          });
        }
      }

      for (const extId of externalIds) {
        const extFluid = nodesArr.find((n) => n.id === extId);
        const extSolid = solidNodesArr.find((n) => n.id === extId);
        const extNode = extFluid ?? extSolid;
        if (!extNode) continue;
        const isFluid = !!extFluid;
        // A ghost stands in for a real node of this same domain — hide it
        // right alongside every other node of a domain the user turned off.
        if (isFluid ? !showFluidNodes : !showThermalNodes) continue;
        nodes.push({
          id: `ghost-${extId}`,
          type: isFluid ? "fluidNode" : "solidNode",
          position: { x: extNode.x, y: extNode.y },
          data: {
            node: extNode,
            selected: false,
            isGhost: true,
            onGhostClick: () => {
              if (extNode.group) {
                openGroupTab(extNode.group);
              } else {
                setActiveTab("editor");
                setActiveGroupTab(null);
              }
              setSelection({ kind: isFluid ? "node" : "solidNode", id: extId });
            },
          },
          draggable: false,
          selectable: false,
        });
      }
    } else {
      // Main canvas: ungrouped nodes + group containers. Physical space has
      // no collapsed-subnetwork box, so the 3D view places every element by
      // its own position; the containers themselves are dropped downstream
      // along with the notes, both being schematic-only constructs.
      const ungrouped = view3d ? nodesArr : nodesArr.filter((n) => !n.group);
      if (showFluidNodes) {
        for (const n of ungrouped) {
          const sel = selection.kind === "node" && selection.id === n.id;
          const snap = snapshot.nodes[n.id];
          nodes.push({
            id: n.id,
            type: "fluidNode",
            position: { x: n.x, y: n.y },
            data: {
              node: n,
              selected: sel,
              resultPressure: snap?.pressure,
              resultTemperature: snap?.temperature,
              colorValue: colorData.nodeValues[n.id],
              domain: colorData.domain,
              colorBy,
              colorSigned: colorData.signed,
              branchToolActive: connectionToolActiveFor(n.id),
              dense,
              isPendingSource:
                pendingSourceNodeId === n.id ||
                pendingConductorSourceId === n.id,
            },
            selected: sel || canvasSelectionSet.has(n.id),
          });
        }
      }

      const ungroupedSolid = view3d
        ? solidNodesArr
        : solidNodesArr.filter((n) => !n.group);
      if (showThermalNodes) {
        for (const n of ungroupedSolid) {
          const sel = selection.kind === "solidNode" && selection.id === n.id;
          const snap = snapshot.solidNodes[n.id];
          nodes.push({
            id: n.id,
            type: "solidNode",
            position: { x: n.x, y: n.y },
            data: {
              node: n,
              selected: sel,
              resultTemperature: snap?.temperature,
              colorValue: colorData.solidValues[n.id],
              domain: colorData.domain,
              colorBy,
              colorSigned: colorData.signed,
              branchToolActive: connectionToolActiveFor(n.id),
              dense,
              isPendingSource:
                pendingSourceNodeId === n.id ||
                pendingConductorSourceId === n.id,
            },
            selected: sel || canvasSelectionSet.has(n.id),
          });
        }
      }

      for (const g of groups) {
        const fluidCount = nodesArr.filter((n) => n.group === g.id).length;
        const solidCount = solidNodesArr.filter((n) => n.group === g.id).length;
        const memberCount = fluidCount + solidCount;
        const sel = selection.kind === "group" && selection.id === g.id;
        nodes.push({
          id: `group-${g.id}`,
          type: "groupContainer",
          position: { x: g.x, y: g.y },
          data: {
            groupId: g.id,
            label: g.label || g.id,
            memberCount,
            selected: sel,
          },
          selected: sel,
        });
      }
    }

    // Notes follow the tab they were placed on, exactly like nodes: pinned
    // inside a subnetwork or loose on the main canvas, never both.
    const notesShown = groupId
      ? notesArr.filter((n) => n.group === groupId)
      : notesArr.filter((n) => !n.group);
    for (const note of notesShown) {
      const sel = selection.kind === "note" && selection.id === note.id;
      nodes.push({
        id: `${NOTE_NODE_PREFIX}${note.id}`,
        type: "canvasNote",
        position: { x: note.x, y: note.y },
        data: {
          noteId: note.id,
          text: note.text,
          width: note.width,
          height: note.height,
          selected: sel,
        },
        selected: sel,
      });
    }

    return nodes;
    // This helper closes over the connect-tool state already listed below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    nodesArr,
    solidNodesArr,
    branchesArr,
    conductorsArr,
    notesArr,
    groupId,
    selection,
    snapshot,
    colorData,
    colorBy,
    branchTool,
    conductorTool,
    connectionSourceId,
    pendingSourceNodeId,
    pendingConductorSourceId,
    groups,
    canvasSelectionSet,
    openGroupTab,
    setActiveTab,
    setActiveGroupTab,
    setSelection,
    dense,
    view3d,
    showFluidNodes,
    showThermalNodes,
  ]);

  /**
   * Re-place the graph for the 3D camera. Elements with no physical placement
   * — group containers and notes, which exist only in schematic pixels — drop
   * out here rather than being special-cased at every construction site.
   * Positions are top-left origins, so the projected CENTRE is offset by the
   * glyph half-size to keep the node centred on its physical point.
   */
  const viewNodes: Node[] = useMemo(() => {
    if (!view3d || !projected3d || !layout3d) return initialNodes;
    return initialNodes.flatMap((node) => {
      const realId = node.id.startsWith("ghost-")
        ? node.id.slice("ghost-".length)
        : node.id;
      const placed = projected3d.get(realId);
      if (!placed) return [];
      const half = layout3d.halfSizes.get(realId) ?? 0;
      return [
        {
          ...node,
          position: { x: placed.x - half, y: placed.y - half },
          zIndex: depthZIndex(placed.t),
          style: { ...node.style, opacity: depthOpacity(placed.t) },
          // Dragging would have to invert the projection onto a chosen plane
          // and write physical metres; until then the property panel owns
          // position editing.
          draggable: false,
        },
      ];
    });
  }, [initialNodes, view3d, projected3d, layout3d]);

  // Build React Flow edges
  const initialEdges: Edge[] = useMemo(() => {
    const edges: Edge[] = [];

    // View-only connection filters: a hidden kind never reaches the graph,
    // so a branch/conductor whose kind is off just isn't drawn (its
    // endpoints may still be, independently, per the node-side toggles).
    const branchesShown = showFluidBranches ? branchesArr : [];
    const conductorsShown = conductorsArr.filter((c) => {
      switch (c.type.kind) {
        case "conduction":
          return canvasVisibility.conduction;
        case "convection":
          return canvasVisibility.convection;
        case "radiation":
          return canvasVisibility.radiation;
        default:
          return true;
      }
    });

    const getEndpointGroup = (nodeId: string) => {
      const fluidNode = nodesArr.find((n) => n.id === nodeId);
      if (fluidNode) return fluidNode.group;
      const solidNode = solidNodesArr.find((n) => n.id === nodeId);
      return solidNode?.group;
    };

    /**
     * Center of a RENDERED React Flow node id (handles the ghost- and group-
     * prefixes the canvas synthesizes). Drives per-edge connection sides:
     * edges leave/enter through the sides that face each other, so a
     * left→right layout reads Right→Left instead of the old Bottom→Top
     * default. Recomputed whenever positions change (drag commits, loads,
     * grouping), so orientation follows the layout reactively.
     */
    const centerFor = (rfNodeId: string): CanvasPoint | null => {
      // In 3D the rendered centre is the projected one; using the schematic
      // centre here would pick anchor sides that contradict the drawn layout.
      if (view3d) return projectedCenter(rfNodeId);
      if (rfNodeId.startsWith("ghost-")) {
        const realId = rfNodeId.slice("ghost-".length);
        const f = nodesArr.find((n) => n.id === realId);
        if (f) return fluidNodeCenter(f);
        const s = solidNodesArr.find((n) => n.id === realId);
        return s ? solidNodeCenter(s) : null;
      }
      if (rfNodeId.startsWith("group-")) {
        const g = groups.find(
          (gr) => gr.id === rfNodeId.slice("group-".length),
        );
        return g ? groupCenter(g) : null;
      }
      const f = nodesArr.find((n) => n.id === rfNodeId);
      if (f) return fluidNodeCenter(f);
      const s = solidNodesArr.find((n) => n.id === rfNodeId);
      return s ? solidNodeCenter(s) : null;
    };

    const orientFor = (
      source: string,
      target: string,
    ): ConnectionOrientation => {
      const a = centerFor(source);
      const c = centerFor(target);
      return a && c ? connectionOrientation(a, c) : DEFAULT_ORIENTATION;
    };

    const pushBranchEdge = (
      b: BranchConfig,
      source: string,
      target: string,
    ) => {
      const sel =
        (selection.kind === "branch" && selection.id === b.id) ||
        multiSelectionSet.has(b.id);
      const snap = snapshot.branches[b.id];
      // Geometry picks the anchor sides only — the edge's physical
      // source/target are untouched. P&ID runs carry NO arrowheads: flow
      // direction is shown by the signed ṁ chip, the reversed-flow dash,
      // and the flip of directional on-line symbols (see CustomEdge).
      const o = orientFor(source, target);
      edges.push({
        id: b.id,
        source,
        target,
        sourceHandle: o.sourceHandle,
        targetHandle: o.targetHandle,
        type: "fluidEdge",
        interactionWidth: EDGE_INTERACTION_WIDTH,
        data: {
          componentType: b.component.type,
          label: b.label || b.id,
          mdot: snap?.mdot,
          dP: snap?.dP,
          colorValue: colorData.branchValues[b.id],
          domain: colorData.domain,
          colorBy,
          colorSigned: colorData.signed,
          dense,
        },
        selected: sel,
      });
    };

    const pushConductorEdge = (
      c: ConductorConfig,
      source: string,
      target: string,
    ) => {
      const sel =
        (selection.kind === "conductor" && selection.id === c.id) ||
        multiSelectionSet.has(c.id);
      const snap = snapshot.conductors[c.id];
      const o = orientFor(source, target);
      edges.push({
        id: c.id,
        source,
        target,
        sourceHandle: o.sourceHandle,
        targetHandle: o.targetHandle,
        type: "conductorEdge",
        interactionWidth: EDGE_INTERACTION_WIDTH,
        data: {
          kind: c.type.kind,
          label: c.label || c.id,
          heatRate: snap?.heatRate,
          colorValue: colorData.conductorValues[c.id],
          domain: colorData.domain,
          colorBy,
          colorSigned: colorData.signed,
          dense,
        },
        selected: sel,
      });
    };

    if (groupId) {
      // Group tab: edges involving at least one member
      const fluidMembers = nodesArr.filter((n) => n.group === groupId);
      const solidMembers = solidNodesArr.filter((n) => n.group === groupId);
      const memberIds = new Set([
        ...fluidMembers.map((n) => n.id),
        ...solidMembers.map((n) => n.id),
      ]);
      for (const b of branchesShown) {
        const fromMember = memberIds.has(b.from);
        const toMember = memberIds.has(b.to);
        if (!fromMember && !toMember) continue;
        const source = fromMember ? b.from : `ghost-${b.from}`;
        const target = toMember ? b.to : `ghost-${b.to}`;
        pushBranchEdge(b, source, target);
      }
      for (const c of conductorsShown) {
        const fromMember = memberIds.has(c.from);
        const toMember = memberIds.has(c.to);
        if (!fromMember && !toMember) continue;
        const source = fromMember ? c.from : `ghost-${c.from}`;
        const target = toMember ? c.to : `ghost-${c.to}`;
        pushConductorEdge(c, source, target);
      }
    } else if (view3d) {
      // 3D expands every group, so endpoints stay themselves and the
      // intra-group runs that a container would have hidden are drawn.
      for (const b of branchesShown) pushBranchEdge(b, b.from, b.to);
      for (const c of conductorsShown) pushConductorEdge(c, c.from, c.to);
    } else {
      // Main canvas: map grouped endpoints to containers
      for (const b of branchesShown) {
        const fromGroup = getEndpointGroup(b.from);
        const toGroup = getEndpointGroup(b.to);
        if (fromGroup && fromGroup === toGroup) continue;
        const source = fromGroup ? `group-${fromGroup}` : b.from;
        const target = toGroup ? `group-${toGroup}` : b.to;
        pushBranchEdge(b, source, target);
      }
      for (const c of conductorsShown) {
        const fromGroup = getEndpointGroup(c.from);
        const toGroup = getEndpointGroup(c.to);
        if (fromGroup && fromGroup === toGroup) continue;
        const source = fromGroup ? `group-${fromGroup}` : c.from;
        const target = toGroup ? `group-${toGroup}` : c.to;
        pushConductorEdge(c, source, target);
      }
    }

    return edges;
  }, [
    nodesArr,
    solidNodesArr,
    branchesArr,
    conductorsArr,
    groupId,
    selection,
    multiSelectionSet,
    snapshot,
    colorData,
    colorBy,
    dense,
    groups,
    view3d,
    projectedCenter,
    showFluidBranches,
    canvasVisibility,
  ]);

  const [nodes, setNodes, onNodesChange] = useNodesState(viewNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);

  React.useEffect(() => {
    setNodes(viewNodes);
  }, [viewNodes, setNodes]);

  React.useEffect(() => {
    setEdges(initialEdges);
  }, [initialEdges, setEdges]);

  const createBranchFromTool = useCallback(
    (
      source: string,
      target: string,
      toolOverride?: string,
      localOverride?: LocalComponent,
    ) => {
      // Resolve ghost nodes to real nodes
      const realSource = source.startsWith("ghost-")
        ? source.replace("ghost-", "")
        : source;
      const realTarget = target.startsWith("ghost-")
        ? target.replace("ghost-", "")
        : target;
      const endpointError = fluidBranchEndpointError(
        config,
        realSource,
        realTarget,
      );
      if (endpointError) {
        setConnectError(endpointError);
        return;
      }

      const tool = toolOverride ?? branchTool ?? "pipe";
      const id = createId("b", new Set(config.branches.map((b) => b.id)));
      const resolvedTool = resolveBranchTool(tool, componentLibrary.components);
      if (resolvedTool.kind === "stale-local" && !localOverride) {
        setConnectError(
          `Local component "${resolvedTool.key ?? "unknown"}" is no longer available; refresh the library and select it again`,
        );
        return;
      }
      const local =
        localOverride ??
        (resolvedTool.kind === "local" ? resolvedTool.component : undefined);
      const component: BranchConfig["component"] = local
        ? componentInstanceDefaults(local)
        : defaultComponent(
            resolvedTool.kind === "builtin" ? resolvedTool.type : "pipe",
          );
      const branch: BranchConfig = {
        id,
        from: realSource,
        to: realTarget,
        component,
      };
      // Clear endpoint selection before the new selected edge mounts; doing
      // this afterward lets React Flow briefly report node + edge as a bulk
      // selection.
      setSelection({ kind: "branch", id });
      addBranch(
        branch,
        local
          ? {
              key: local.key,
              entry: {
                code: local.source,
                format: "defineComponent",
                metadata: local.metadata,
              },
            }
          : undefined,
      );
    },
    [branchTool, componentLibrary.components, config, addBranch, setSelection],
  );

  const createConductorFromTool = useCallback(
    (source: string, target: string, toolOverride?: string) => {
      if (source === target) return;
      const realSource = source.startsWith("ghost-")
        ? source.replace("ghost-", "")
        : source;
      const realTarget = target.startsWith("ghost-")
        ? target.replace("ghost-", "")
        : target;
      const kind = toolOverride ?? conductorTool ?? "conduction";
      const error = conductorEndpointError(
        config,
        kind as "conduction" | "convection" | "radiation",
        realSource,
        realTarget,
      );
      if (error) {
        // Persist until the next interaction — never auto-dismiss an error.
        setConnectError(error);
        return;
      }
      const id = createId(
        "c",
        new Set((config.conductors ?? []).map((c) => c.id)),
      );
      const conductor: ConductorConfig = {
        id,
        from: realSource,
        to: realTarget,
        type: defaultConductor(kind),
      };
      setSelection({ kind: "conductor", id });
      addConductor(conductor);
    },
    [conductorTool, config, addConductor, setSelection],
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      if (!connection.source || !connection.target) return;
      setConnectError(null);

      // A direct handle-to-handle gesture is intent to connect, not intent to
      // silently accept a default. Offer only ties valid for these endpoints.
      if (
        !branchTool &&
        !conductorTool &&
        !connection.source.startsWith("group-") &&
        !connection.target.startsWith("group-")
      ) {
        const source = connection.source.startsWith("ghost-")
          ? connection.source.slice(6)
          : connection.source;
        const target = connection.target.startsWith("ghost-")
          ? connection.target.slice(6)
          : connection.target;
        const branches =
          fluidBranchEndpointError(config, source, target) === null
            ? BRANCH_COMPONENTS.map((item) => item.id)
            : [];
        const conductors = CONDUCTORS.filter(
          (item) =>
            conductorEndpointError(config, item.id, source, target) === null,
        ).map((item) => item.id);
        if (branches.length || conductors.length) {
          setConnectionChooser({
            source,
            target,
            x: pointerRef.current.x,
            y: pointerRef.current.y,
            branches,
            conductors,
          });
          return;
        }
      }

      // If target is a group container on main canvas, show member picker
      if (!groupId && connection.target.startsWith("group-")) {
        const gid = connection.target.replace("group-", "");
        const allMembers = [
          ...config.nodes.filter((n) => n.group === gid),
          ...(config.solidNodes ?? []).filter((n) => n.group === gid),
        ];
        const sourceId = connection.source.startsWith("ghost-")
          ? connection.source.replace("ghost-", "")
          : connection.source;
        const members = allMembers.filter((member) =>
          conductorTool
            ? conductorEndpointError(
                config,
                conductorTool as "conduction" | "convection" | "radiation",
                sourceId,
                member.id,
              ) === null
            : fluidBranchEndpointError(config, sourceId, member.id) === null,
        );
        if (members.length === 0) {
          setConnectError(
            conductorTool
              ? "This group has no nodes compatible with the selected thermal conductor"
              : "Fluid branches can connect only fluid nodes",
          );
          return;
        }
        if (members.length === 1) {
          if (conductorTool) {
            createConductorFromTool(connection.source, members[0].id);
            setPendingConductorSourceId(null);
          } else {
            createBranchFromTool(connection.source, members[0].id);
            setPendingSourceNodeId(null);
          }
          return;
        }
        if (members.length > 1) {
          const container = config.groups?.find((g) => g.id === gid);
          const { x, y } = groupCenter({
            x: container?.x ?? 0,
            y: container?.y ?? 0,
          });
          setMemberPicker({
            x,
            y,
            members,
            onPick: (nodeId) => {
              if (conductorTool) {
                createConductorFromTool(connection.source!, nodeId);
                setPendingConductorSourceId(null);
              } else {
                createBranchFromTool(connection.source!, nodeId);
                setPendingSourceNodeId(null);
              }
              setMemberPicker(null);
            },
          });
          return;
        }
      }

      if (conductorTool) {
        createConductorFromTool(connection.source, connection.target);
        setPendingConductorSourceId(null);
      } else {
        createBranchFromTool(connection.source, connection.target);
        setPendingSourceNodeId(null);
      }
    },
    [
      createBranchFromTool,
      createConductorFromTool,
      setPendingSourceNodeId,
      setPendingConductorSourceId,
      groupId,
      config,
      conductorTool,
      branchTool,
    ],
  );

  const isValidConnection = useCallback(
    (connection: Connection | Edge): boolean => {
      if (!connection.source || !connection.target) return false;
      const source = connection.source.startsWith("ghost-")
        ? connection.source.replace("ghost-", "")
        : connection.source;
      const target = connection.target.startsWith("ghost-")
        ? connection.target.replace("ghost-", "")
        : connection.target;
      if (conductorTool) {
        return (
          conductorEndpointError(
            config,
            conductorTool as "conduction" | "convection" | "radiation",
            source,
            target,
          ) === null
        );
      }
      if (branchTool)
        return fluidBranchEndpointError(config, source, target) === null;
      return (
        fluidBranchEndpointError(config, source, target) === null ||
        CONDUCTORS.some(
          (item) =>
            conductorEndpointError(config, item.id, source, target) === null,
        )
      );
    },
    [branchTool, conductorTool, config],
  );

  const onNodeClick = useCallback(
    (_e: React.MouseEvent, node: Node) => {
      // New interaction clears a previous connect error (it never auto-dismisses).
      setConnectError(null);
      if (branchTool) {
        if (!pendingSourceNodeId) {
          const realId = node.id.startsWith("ghost-")
            ? node.id.replace("ghost-", "")
            : node.id;
          if (!canStartFluidBranch(config, realId)) {
            setConnectError("Fluid branches can connect only fluid nodes");
            return;
          }
          // Arming the source must NOT steal the property-panel selection —
          // the analyst may be mid-edit on another element.
          setPendingSourceNodeId(node.id);
        } else if (pendingSourceNodeId === node.id) {
          setPendingSourceNodeId(null);
        } else {
          // If target is a group container on main canvas
          if (!groupId && node.type === "groupContainer") {
            const gid = groupIdFromNode(node);
            if (!gid) return;
            const members = [
              ...config.nodes.filter((n) => n.group === gid),
            ].filter(
              (member) =>
                fluidBranchEndpointError(
                  config,
                  pendingSourceNodeId,
                  member.id,
                ) === null,
            );
            if (members.length === 0) {
              setConnectError(
                "This group has no fluid nodes compatible with a fluid branch",
              );
              return;
            }
            if (members.length === 1) {
              createBranchFromTool(pendingSourceNodeId, members[0].id);
              setPendingSourceNodeId(null);
              return;
            }
            if (members.length > 1) {
              setMemberPicker({
                ...groupCenter(node.position),
                members,
                onPick: (nodeId) => {
                  createBranchFromTool(pendingSourceNodeId!, nodeId);
                  setPendingSourceNodeId(null);
                  setMemberPicker(null);
                },
              });
              return;
            }
          }
          createBranchFromTool(pendingSourceNodeId, node.id);
          setPendingSourceNodeId(null);
        }
      } else if (conductorTool) {
        if (!pendingConductorSourceId) {
          const realId = node.id.startsWith("ghost-")
            ? node.id.replace("ghost-", "")
            : node.id;
          if (
            !canStartConductor(
              config,
              conductorTool as "conduction" | "convection" | "radiation",
              realId,
            )
          ) {
            setConnectError(
              conductorTool === "convection"
                ? "Convection must start from a fluid, solid, or ambient node"
                : `${conductorLabel(conductorTool)} can start only from a solid or ambient node`,
            );
            return;
          }
          setPendingConductorSourceId(node.id);
        } else if (pendingConductorSourceId === node.id) {
          setPendingConductorSourceId(null);
        } else {
          if (!groupId && node.type === "groupContainer") {
            const gid = groupIdFromNode(node);
            if (!gid) return;
            const members = [
              ...config.nodes.filter((n) => n.group === gid),
              ...(config.solidNodes ?? []).filter((n) => n.group === gid),
            ].filter(
              (member) =>
                conductorEndpointError(
                  config,
                  conductorTool as "conduction" | "convection" | "radiation",
                  pendingConductorSourceId,
                  member.id,
                ) === null,
            );
            if (members.length === 0) {
              setConnectError(
                "This group has no nodes compatible with the selected thermal conductor",
              );
              return;
            }
            if (members.length === 1) {
              createConductorFromTool(pendingConductorSourceId, members[0].id);
              setPendingConductorSourceId(null);
              return;
            }
            if (members.length > 1) {
              setMemberPicker({
                ...groupCenter(node.position),
                members,
                onPick: (nodeId) => {
                  createConductorFromTool(pendingConductorSourceId!, nodeId);
                  setPendingConductorSourceId(null);
                  setMemberPicker(null);
                },
              });
              return;
            }
          }
          createConductorFromTool(pendingConductorSourceId, node.id);
          setPendingConductorSourceId(null);
        }
      } else {
        // Shift-click grows the React Flow multi-selection; the panel
        // selection is then owned by onSelectionChange.
        shiftSelectingRef.current = _e.shiftKey;
        if (_e.shiftKey) return;
        if (node.type === "groupContainer") {
          const gid = groupIdFromNode(node);
          if (!gid) return;
          setSelection({ kind: "group", id: gid });
        } else if (node.type === "canvasNote") {
          setSelection({ kind: "note", id: noteIdFromNode(node) });
        } else if (node.type === "solidNode") {
          setSelection({ kind: "solidNode", id: node.id });
        } else {
          setSelection({ kind: "node", id: node.id });
        }
      }
    },
    [
      branchTool,
      conductorTool,
      pendingSourceNodeId,
      pendingConductorSourceId,
      setPendingSourceNodeId,
      setPendingConductorSourceId,
      setSelection,
      createBranchFromTool,
      createConductorFromTool,
      groupId,
      config,
    ],
  );

  const updateGroup = useStore((s) => s.updateGroup);
  const updateNote = useStore((s) => s.updateNote);
  const onNodeDragStop = useCallback(
    (_event: any, node: Node) => {
      if (node.type === "groupContainer") {
        const gid = groupIdFromNode(node);
        if (!gid) return;
        updateGroup(
          gid,
          snapOriginToGrid(node.position, GROUP_WIDTH, GROUP_HEIGHT),
        );
      } else if (node.type === "canvasNote") {
        // Corner-snapped, not center-snapped: a note's size is user-set, and
        // the grid alignment must not depend on it.
        updateNote(noteIdFromNode(node), snapPointToGrid(node.position));
      } else if (node.type === "solidNode") {
        updateSolidNode(
          node.id,
          snapOriginToGrid(node.position, SOLID_NODE_SIZE, SOLID_NODE_SIZE),
        );
      } else {
        const type =
          config.nodes.find((item) => item.id === node.id)?.type ?? "internal";
        const size = fluidNodeSize(type);
        updateNode(node.id, snapOriginToGrid(node.position, size, size));
      }
    },
    [config.nodes, updateNode, updateSolidNode, updateGroup, updateNote],
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const target = e.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable ||
          ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
      )
        return;
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        deleteSelected();
      }
      if (e.key === "Escape") {
        if (connectionChooser) {
          setConnectionChooser(null);
        } else if (memberPicker) {
          setMemberPicker(null);
        } else if (pendingSourceNodeId) {
          setPendingSourceNodeId(null);
        } else if (pendingConductorSourceId) {
          setPendingConductorSourceId(null);
        } else if (branchTool) {
          setBranchTool(null);
        } else if (conductorTool) {
          setConductorTool(null);
        }
        setConnectError(null);
      }
    },
    [
      deleteSelected,
      connectionChooser,
      memberPicker,
      pendingSourceNodeId,
      pendingConductorSourceId,
      setPendingSourceNodeId,
      setPendingConductorSourceId,
      branchTool,
      setBranchTool,
      conductorTool,
      setConductorTool,
    ],
  );

  /**
   * Free drop spot for a new node: viewport centre, spiralling out, never
   * underneath the floating canvas UI (action row, color chip, Global Map).
   * Works for the main canvas and group tabs alike (the store tracks the
   * active pane's viewport via onMove).
   */
  const dropPosition = useCallback(
    (): { x: number; y: number } => canvasDropPosition(),
    [],
  );

  const handleAddNode = useCallback(
    (type: "internal" | "boundary", position?: { x: number; y: number }) => {
      const id = createId(type === "boundary" ? "B" : "N", allNodeIds);
      const size = fluidNodeSize(type);
      const { x, y } = position
        ? gridOriginForCenter(position, size, size)
        : snapOriginToGrid(dropPosition(), size, size);
      const node: NodeConfig = {
        id,
        type,
        x,
        y,
        label: id,
        ...(type === "boundary"
          ? { pressure: 101325, temperature: 293 }
          : { pressure: 101325, temperature: 293, volume: 0.1 }),
        ...(groupId ? { group: groupId } : {}),
      };
      addNode(node);
      if (position) setSelection({ kind: "node", id });
    },
    [allNodeIds, addNode, groupId, dropPosition, setSelection],
  );

  const handleAddSolidNode = useCallback(
    (type: "solid" | "ambient", position?: { x: number; y: number }) => {
      const id = createId(type === "ambient" ? "A" : "S", allNodeIds);
      const { x, y } = position
        ? gridOriginForCenter(position, SOLID_NODE_SIZE, SOLID_NODE_SIZE)
        : snapOriginToGrid(dropPosition(), SOLID_NODE_SIZE, SOLID_NODE_SIZE);
      const node: SolidNodeConfig = {
        id,
        type,
        x,
        y,
        label: id,
        temperature: 293,
        ...(type === "solid" ? { mass: 1, cp: 500 } : {}),
        ...(groupId ? { group: groupId } : {}),
      };
      addSolidNode(node);
      if (position) setSelection({ kind: "solidNode", id });
    },
    [allNodeIds, addSolidNode, groupId, dropPosition, setSelection],
  );

  const handleAddNote = useCallback(
    (position?: { x: number; y: number }) => {
      const id = createId("NOTE", noteIds);
      // The pointer marks where the card's top-left should land: a note is read
      // as a block of text, not centered on a point like a node glyph.
      const { x, y } = snapOriginToGrid(
        position ?? dropPosition(),
        NOTE_WIDTH,
        NOTE_MIN_HEIGHT,
      );
      addNote({ id, text: "", x, y, ...(groupId ? { group: groupId } : {}) });
      // Always select: an empty note opens its editor, so a rail click puts the
      // caret where the user is already looking.
      setSelection({ kind: "note", id });
    },
    [noteIds, addNote, groupId, dropPosition, setSelection],
  );

  const handleCanvasDragOver = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      if (
        !Array.from(event.dataTransfer.types).includes(
          "application/x-fluids-network-element",
        )
      )
        return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    },
    [],
  );

  const handleCanvasDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      const element = canvasElementFromDrop(event);
      if (!element) return;
      event.preventDefault();
      const bounds = event.currentTarget.getBoundingClientRect();
      const position = {
        x:
          (event.clientX - bounds.left - canvasViewport.x) /
          canvasViewport.zoom,
        y:
          (event.clientY - bounds.top - canvasViewport.y) / canvasViewport.zoom,
      };
      if (element === "fluid:internal") handleAddNode("internal", position);
      if (element === "fluid:boundary") handleAddNode("boundary", position);
      if (element === "solid:solid") handleAddSolidNode("solid", position);
      if (element === "solid:ambient") handleAddSolidNode("ambient", position);
      if (element === "note") handleAddNote(position);
    },
    [canvasViewport, handleAddNode, handleAddSolidNode, handleAddNote],
  );

  const activeLocalComponent = localComponentForTool(
    branchTool,
    componentLibrary.components,
  );
  const activeLabel =
    activeLocalComponent?.metadata.label ??
    activeLocalComponent?.key ??
    (branchTool ? componentLabel(branchTool) : "");
  const activeConductorLabel = conductorTool
    ? conductorLabel(conductorTool)
    : "";
  const toolActive = !!(branchTool || conductorTool);

  // ── Subnetwork creation from multi-selection ──────────────────────────
  const addGroup = useStore((s) => s.addGroup);
  /** Selected ids that can go into a new subnetwork: real, ungrouped nodes. */
  const eligibleMemberIds = useMemo(() => {
    if (groupId) return [];
    return canvasSelection.filter((id) => {
      const fluid = nodesArr.find((n) => n.id === id);
      if (fluid) return !fluid.group;
      const solid = solidNodesArr.find((n) => n.id === id);
      if (solid) return !solid.group;
      return false;
    });
  }, [canvasSelection, nodesArr, solidNodesArr, groupId]);

  const createSubnetwork = useCallback(() => {
    if (eligibleMemberIds.length < 2) return;
    const positions = eligibleMemberIds
      .map(
        (id) =>
          nodesArr.find((n) => n.id === id) ??
          solidNodesArr.find((n) => n.id === id),
      )
      .filter((n): n is NodeConfig | SolidNodeConfig => !!n);
    const xs = positions.map((n) => n.x);
    const ys = positions.map((n) => n.y);
    // The container sits centered on the member bounding box.
    const origin = groupOriginForCenter(
      (arrayMin(xs) + arrayMax(xs)) / 2,
      (arrayMin(ys) + arrayMax(ys)) / 2,
    );
    const { x: cx, y: cy } = snapOriginToGrid(
      origin,
      GROUP_WIDTH,
      GROUP_HEIGHT,
    );

    const existingGroupIds = new Set((config.groups ?? []).map((g) => g.id));
    const gid = createId("G", existingGroupIds);
    const label = `Subnetwork ${(config.groups ?? []).length + 1}`;
    addGroup({ id: gid, label, x: cx, y: cy }, eligibleMemberIds);
    setSelection({ kind: "group", id: gid });
    setCanvasSelection([]);
    setSubnetworkNotice(
      `${label} created with ${eligibleMemberIds.length} members`,
    );
  }, [
    eligibleMemberIds,
    nodesArr,
    solidNodesArr,
    config.groups,
    addGroup,
    setSelection,
    setCanvasSelection,
  ]);

  // Cmd/Ctrl+G creates a subnetwork from the eligible multi-selection.
  // Never intercepts when the user is typing in a field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "g") return;
      const t = e.target;
      if (t instanceof HTMLElement) {
        const tag = t.tagName;
        if (
          tag === "INPUT" ||
          tag === "TEXTAREA" ||
          tag === "SELECT" ||
          t.isContentEditable
        )
          return;
      }
      if (eligibleMemberIds.length < 2) return;
      e.preventDefault();
      createSubnetwork();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [eligibleMemberIds, createSubnetwork]);

  // Transient result for scrubber (completed or cancelled partial)
  const transientResult =
    (result && "times" in result ? result : null) ??
    (runStatus === "cancelled" && liveResult && "times" in liveResult
      ? liveResult
      : null);
  const showScrubber =
    !!transientResult &&
    runStatus !== "running" &&
    runStatus !== "loadingFluids";
  const times = transientResult?.times ?? [];
  const maxTimeIndex = Math.max(0, times.length - 1);
  const currentTimeIndex = timeIndex ?? maxTimeIndex;
  const canInspectResult = hasInspectableResult(result);
  const selectionChannels = useMemo(
    () => channelsForSelection(config, result, selection, canvasSelection),
    [config, result, selection, canvasSelection],
  );
  const selectionPlots = useMemo(() => {
    if (!result || !("times" in result) || !canInspectResult) return [];

    const plots = new Map<
      string,
      {
        key: string;
        title: string;
        yLabel: string;
        yQuantityKind: (typeof selectionChannels)[number]["quantity"];
        rawUnit?: string;
        series: Series[];
      }
    >();
    for (const descriptor of selectionChannels) {
      const data = resolveChannel(result, descriptor.channel);
      if (data?.kind !== "series") continue;
      const key = `${descriptor.channel.entity}:${descriptor.channel.field}`;
      const title =
        descriptor.label.split(" · ").pop() ?? descriptor.channel.field;
      const current = plots.get(key) ?? {
        key,
        title,
        yLabel: title,
        yQuantityKind: descriptor.quantity,
        ...(descriptor.rawUnit !== undefined
          ? { rawUnit: descriptor.rawUnit }
          : {}),
        series: [],
      };
      current.series.push({
        id: descriptor.key,
        label: descriptor.elementLabel,
        values: data.values,
      });
      plots.set(key, current);
    }
    return [...plots.values()];
  }, [result, canInspectResult, selectionChannels]);
  const steadySelectionProperties = useMemo(() => {
    if (!result || "times" in result || !canInspectResult) return [];
    return selectionChannels.flatMap((descriptor) => {
      const data = resolveChannel(result, descriptor.channel);
      return data?.kind === "scalar" ? [{ descriptor, value: data.value }] : [];
    });
  }, [result, canInspectResult, selectionChannels]);
  useEffect(() => {
    const keys = selectionPlots.map((plot) => plot.key);
    setSelectionPlotProperties((current) =>
      current.filter((key) => keys.includes(key)).length
        ? current.filter((key) => keys.includes(key))
        : keys.slice(0, 1),
    );
  }, [selectionPlots]);
  const selectionMenuPosition = useMemo(() => {
    const selected = canvasSelection
      .map(
        (id) =>
          config.nodes.find((node) => node.id === id) ??
          (config.solidNodes ?? []).find((node) => node.id === id),
      )
      .filter((node): node is NodeConfig | SolidNodeConfig => !!node);
    if (selected.length) {
      const right =
        arrayMax(selected.map((node) => node.x)) * canvasViewport.zoom +
        canvasViewport.x +
        32;
      const top =
        arrayMin(selected.map((node) => node.y)) * canvasViewport.zoom +
        canvasViewport.y -
        8;
      return { x: right, y: Math.max(8, top) };
    }
    if (selection.kind !== "branch" && selection.kind !== "conductor")
      return null;
    const edge =
      selection.kind === "branch"
        ? config.branches.find((branch) => branch.id === selection.id)
        : config.conductors?.find((conductor) => conductor.id === selection.id);
    if (!edge) return null;
    const point = (id: string) =>
      config.nodes.find((node) => node.id === id) ??
      config.solidNodes?.find((node) => node.id === id);
    const from = point(edge.from);
    const to = point(edge.to);
    if (!from || !to) return null;
    return {
      x: ((from.x + to.x) / 2) * canvasViewport.zoom + canvasViewport.x,
      y: Math.max(
        8,
        ((from.y + to.y) / 2) * canvasViewport.zoom + canvasViewport.y - 20,
      ),
    };
  }, [
    canvasSelection,
    selection,
    config.nodes,
    config.solidNodes,
    config.branches,
    config.conductors,
    canvasViewport,
  ]);

  return (
    <div
      data-testid="flow-canvas"
      ref={canvasRef}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onPointerDown={beginOrbit}
      onMouseDownCapture={(event) => {
        if (
          connectionChooser &&
          !(
            event.target instanceof Element &&
            event.target.closest(".connection-chooser")
          )
        ) {
          setConnectionChooser(null);
        }
      }}
      onMouseMove={(event) => {
        const bounds = event.currentTarget.getBoundingClientRect();
        pointerRef.current = {
          x: event.clientX - bounds.left,
          y: event.clientY - bounds.top,
        };
      }}
      style={{
        width: "100%",
        height: "100%",
        outline: "none",
        cursor: toolActive ? "crosshair" : "default",
        position: "relative",
      }}
    >
      <style>{`
        @keyframes pulse-ring {
          0% { transform: scale(1); opacity: 1; }
          50% { transform: scale(1.05); opacity: 0.7; }
          100% { transform: scale(1); opacity: 1; }
        }
      `}</style>
      {config.nodes.length === 0 && (config.solidNodes ?? []).length === 0 && (
        <div data-testid="canvas-empty-hint" style={emptyOverlayStyle}>
          <div
            style={{
              fontWeight: 700,
              marginBottom: 8,
              color: "var(--text-1)",
              fontSize: 16,
            }}
          >
            Get started
          </div>
          <div>
            Start with a boundary and an internal node from the model rail, then
            select a component and connect them.
          </div>
        </div>
      )}
      <LabelLayoutContext.Provider value={labelLayout}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onConnectStart={(_event, params) => {
            setConnectionSourceId(params.nodeId ?? null);
          }}
          onConnectEnd={() => {
            setConnectionSourceId(null);
          }}
          onDragOver={handleCanvasDragOver}
          onDrop={handleCanvasDrop}
          isValidConnection={isValidConnection}
          onNodeDragStop={onNodeDragStop}
          onNodeClick={onNodeClick}
          onMove={(_e, vp) => setCanvasViewport(vp)}
          onEdgeClick={(e, edge) => {
            // Shift-click grows the React Flow multi-selection; the panel
            // selection is then owned by onSelectionChange.
            shiftSelectingRef.current = e.shiftKey;
            if (e.shiftKey) return;
            if (config.conductors?.some((c) => c.id === edge.id)) {
              setSelection({ kind: "conductor", id: edge.id });
            } else {
              setSelection({ kind: "branch", id: edge.id });
            }
          }}
          onPaneClick={() => {
            // Releasing an orbit lands here as a pane click; clearing the
            // selection then would punish the user for looking around.
            if (orbitMovedRef.current) {
              orbitMovedRef.current = false;
              return;
            }
            setConnectionChooser(null);
            setSelection({ kind: "none" });
            setCanvasSelection([]);
            if (pendingSourceNodeId) {
              setPendingSourceNodeId(null);
            }
            if (pendingConductorSourceId) {
              setPendingConductorSourceId(null);
            }
            if (memberPicker) {
              setMemberPicker(null);
            }
            if (connectError) {
              setConnectError(null);
            }
          }}
          onSelectionChange={({ nodes: selNodes, edges: selEdges }) => {
            if (groupId) return;
            const realNodes = selNodes.filter(
              (n) =>
                (n.type === "fluidNode" || n.type === "solidNode") &&
                !n.id.startsWith("ghost-"),
            );
            const next = realNodes.map((n) => n.id);
            // Multi-entity panel selection ("elements and ties"): 2+ selected
            // nodes/edges drive the bulk-edit PropertyPanel. Single-entity and
            // empty selections stay owned by the click handlers, except when
            // COLLAPSING out of a multi selection (rubber band shrunk, shift-
            // click toggled members off) — the click handlers never fire then.
            const items: MultiSelectionItem[] = [
              ...realNodes.map((n): MultiSelectionItem => ({
                kind: n.type === "solidNode" ? "solidNode" : "node",
                id: n.id,
              })),
              ...selEdges.flatMap((e): MultiSelectionItem[] => {
                if (config.branches.some((b) => b.id === e.id))
                  return [{ kind: "branch", id: e.id }];
                if ((config.conductors ?? []).some((c) => c.id === e.id))
                  return [{ kind: "conductor", id: e.id }];
                return [];
              }),
            ];
            const panelSel = useStore.getState().selection;
            if (items.length >= 2) {
              // React Flow can emit one stale multi-selection after an
              // ordinary click or programmatic navigation has already
              // selected a single entity. Only Shift-click and marquee
              // gestures are allowed to promote that callback to `multi`.
              if (!shiftSelectingRef.current && !marqueeSelectingRef.current) {
                return;
              }
              const cur = useStore.getState().canvasSelection;
              if (!(
                cur.length === next.length && cur.every((v, i) => v === next[i])
              )) {
                setCanvasSelection(next);
              }
              const same =
                panelSel.kind === "multi" &&
                panelSel.items.length === items.length &&
                panelSel.items.every(
                  (it, i) => it.kind === items[i].kind && it.id === items[i].id,
                );
              if (!same) setSelection({ kind: "multi", items });
              shiftSelectingRef.current = false;
            } else if (panelSel.kind === "multi") {
              setSelection(items.length === 1 ? items[0] : { kind: "none" });
            }
          }}
          onSelectionStart={() => {
            marqueeSelectingRef.current = multiSelectActive;
          }}
          onSelectionEnd={() => {
            marqueeSelectingRef.current = false;
          }}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          connectionMode={ConnectionMode.Loose}
          selectionOnDrag={view3d ? false : multiSelectActive}
          // 3D hands the left button to orbit and keeps pan on middle/right.
          panOnDrag={view3d ? [1, 2] : !multiSelectActive}
          nodesDraggable={!view3d}
          minZoom={0.2}
          deleteKeyCode={null}
          multiSelectionKeyCode="Shift"
        >
          <FitOnLoad epoch={`${configEpoch}:${groupId ?? "root"}`} />
          <RefitOnRequest nonce={refitNonce} />
          <FocusRequestHandler />
          <Controls />
          {globalMapOpen ? (
            <Panel position="bottom-right" className="global-map-panel">
              <div className="global-map-card" data-testid="global-map-panel">
                <div className="global-map-card__header">
                  <span>Global map</span>
                  <button
                    type="button"
                    data-testid="global-map-toggle"
                    aria-expanded={true}
                    aria-controls="global-map-body"
                    aria-label="Collapse global map"
                    title="Collapse global map"
                    onClick={toggleGlobalMap}
                  >
                    <span aria-hidden="true">▾</span>
                  </button>
                </div>
                <div className="global-map-card__body" id="global-map-body">
                  <MiniMap
                    nodeColor={(n) => {
                      if (n.type === "groupContainer") return GROUP_FILL;
                      // A note is the largest node on the canvas; left to fall
                      // through it painted the overview's biggest block in fluid
                      // blue, as if the annotation were part of the network.
                      if (n.type === "canvasNote") return NOTE_MINIMAP;
                      const d = (n.data ?? {}) as {
                        isGhost?: boolean;
                        colorBy?: string;
                        colorValue?: number;
                        domain?: [number, number];
                        colorSigned?: boolean;
                        node?: { type?: string };
                      };
                      if (d.isGhost) return NODE_GHOST;
                      const base =
                        n.type === "solidNode"
                          ? solidNodeColor(d.node?.type)
                          : fluidNodeColor(d.node?.type);
                      return fillForCanvas({
                        colorBy: d.colorBy,
                        colorValue: d.colorValue,
                        domain: d.domain,
                        signed: d.colorSigned,
                        base,
                      });
                    }}
                    className="canvas-minimap"
                  />
                </div>
              </div>
            </Panel>
          ) : (
            <Panel position="bottom-right" className="global-map-panel">
              <button
                type="button"
                data-testid="global-map-toggle"
                className="chip global-map-collapsed"
                aria-expanded={false}
                aria-controls="global-map-body"
                aria-label="Expand global map"
                title="Expand global map"
                onClick={toggleGlobalMap}
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 18 18"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  aria-hidden="true"
                >
                  <rect x="1.5" y="1.5" width="15" height="15" rx="2" />
                  <rect
                    x="4"
                    y="5"
                    width="3"
                    height="3"
                    fill="currentColor"
                    stroke="none"
                  />
                  <rect
                    x="10"
                    y="8"
                    width="3"
                    height="3"
                    fill="currentColor"
                    stroke="none"
                  />
                  <line x1="7" y1="6.5" x2="10" y2="9.5" />
                </svg>
                <span>Map</span>
              </button>
            </Panel>
          )}
          {/* Two grids, drafting-paper style: a fine field for placement and a
            coarser one every sixth dot for judging distance at a glance. A
            single 15px field gives no sense of scale when zoomed. */}
          <Background id="grid-minor" gap={15} size={1} color={GRID_MINOR} />
          <Background id="grid-major" gap={90} size={2} color={GRID_MAJOR} />
          <Panel position="top-left" className="node-actions-panel">
            <CanvasRail
              multiSelectActive={multiSelectActive}
              setMultiSelectActive={setMultiSelectActive}
              inspectMode={inspectMode}
              toggleInspectMode={() => setInspectMode((active) => !active)}
              canInspectResult={canInspectResult}
              view3d={view3d}
              setCanvasView={setCanvasView}
              showLabels={showLabels}
              setShowLabels={setShowLabels}
              canvasVisibility={canvasVisibility}
              setCanvasVisibility={setCanvasVisibility}
              onAddNode={handleAddNode}
              onAddSolidNode={handleAddSolidNode}
              onAddNote={() => handleAddNote()}
              onOpenModelView={onOpenModelView}
            />
          </Panel>
          <Panel position="top-right">
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 6,
                alignItems: "flex-end",
              }}
            >
              {/* Shares the existing top-right stack rather than opening a
                  second Panel there, which would land on the same pixels. */}
              {view3d && (
                <Canvas3DControls
                  camera={camera3d}
                  onCameraChange={applyCameraPreset}
                />
              )}
              <div
                className="chip"
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "4px 8px",
                }}
              >
                <span style={{ fontSize: 11, color: "var(--text-2)" }}>
                  Color by
                </span>
                <select
                  data-testid="color-by-select"
                  className="select"
                  aria-label="Color by"
                  style={{ width: "auto", padding: "2px 4px", fontSize: 12 }}
                  value={colorBy}
                  onChange={(e) => setColorBy(e.target.value as ColorBy)}
                >
                  <option value="none">None</option>
                  {COLOR_BY_GROUPS.map((g) => (
                    <optgroup key={g.label} label={g.label}>
                      {g.options.map((o) => (
                        <option key={o.field} value={o.field}>
                          {o.label}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              </div>
              {colorBy !== "none" && colorData.hasData && (
                <ColorLegend colorData={colorData} colorBy={colorBy} />
              )}
            </div>
          </Panel>
          {branchTool && (
            <Panel position="top-center">
              <div
                data-testid="canvas-connect-hint"
                className="chip"
                style={{
                  borderColor: "var(--select)",
                  color: "var(--select)",
                  fontWeight: 600,
                  whiteSpace: "nowrap",
                }}
              >
                {pendingSourceNodeId
                  ? `${activeLabel} tool: node ${pendingSourceNodeId} selected — now click the target node`
                  : `${activeLabel} tool: click a source node, then click a target node to connect`}
              </div>
            </Panel>
          )}
          {conductorTool && (
            <Panel position="top-center">
              <div
                data-testid="canvas-conductor-hint"
                className="chip"
                style={{
                  borderColor: "var(--select)",
                  color: "var(--select)",
                  fontWeight: 600,
                  whiteSpace: "nowrap",
                }}
              >
                {pendingConductorSourceId
                  ? `${activeConductorLabel} tool: node ${pendingConductorSourceId} selected — now click the target node`
                  : `${activeConductorLabel} tool: click a source node, then click a target node to connect`}
              </div>
            </Panel>
          )}
          {connectError && (
            <Panel position="top-center">
              <div
                data-testid="canvas-connect-error"
                className="banner banner--error"
                role="alert"
                style={{ whiteSpace: "nowrap" }}
              >
                {connectError}
              </div>
            </Panel>
          )}

          {showScrubber && (
            <Panel position="bottom-center">
              <TimeScrubber
                times={times}
                maxTimeIndex={maxTimeIndex}
                currentTimeIndex={currentTimeIndex}
                setTimeIndex={setTimeIndex}
              />
            </Panel>
          )}
        </ReactFlow>
      </LabelLayoutContext.Provider>
      {connectionChooser && (
        <div
          className="connection-chooser"
          style={{ left: connectionChooser.x, top: connectionChooser.y }}
          role="dialog"
          aria-label="Choose connection type"
        >
          <button
            type="button"
            className="connection-chooser__title"
            aria-label="Move connection menu"
            onMouseDown={(event) => {
              event.preventDefault();
              const bounds =
                event.currentTarget.parentElement!.getBoundingClientRect();
              setConnectionChooserDrag({
                offsetX: event.clientX - bounds.left,
                offsetY: event.clientY - bounds.top,
              });
            }}
          >
            <span>Connect with</span>
            <span aria-hidden="true">⋮⋮</span>
          </button>
          {(["common", "advanced", "custom"] as const).map((category) => {
            const options = BRANCH_COMPONENTS.filter(
              (item) =>
                item.category === category &&
                item.id !== "userComponent" &&
                connectionChooser.branches.includes(item.id),
            );
            const localOptions =
              category === "custom" && connectionChooser.branches.length > 0
                ? componentLibrary.components
                : [];
            if (!options.length && !localOptions.length) return null;
            return (
              <ConnectionChoiceSection
                key={category}
                label={`${category} flow`}
              >
                {options.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className="connection-chooser__option"
                    onClick={() => {
                      createBranchFromTool(
                        connectionChooser.source,
                        connectionChooser.target,
                        item.id,
                      );
                      setConnectionChooser(null);
                    }}
                  >
                    <PidSymbol kind={item.symbol ?? item.id} size={16} />
                    {item.label}
                  </button>
                ))}
                {localOptions.map((item) => (
                  <button
                    key={`local:${item.key}`}
                    type="button"
                    className="connection-chooser__option"
                    onClick={() => {
                      createBranchFromTool(
                        connectionChooser.source,
                        connectionChooser.target,
                        localComponentToolId(item.key),
                      );
                      setConnectionChooser(null);
                    }}
                  >
                    <PidSymbol kind="userComponent" size={16} />
                    {item.metadata.label ?? item.key}
                  </button>
                ))}
              </ConnectionChoiceSection>
            );
          })}
          {connectionChooser.conductors.length > 0 && (
            <ConnectionChoiceSection label="Thermal ties">
              {CONDUCTORS.filter((item) =>
                connectionChooser.conductors.includes(item.id),
              ).map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className="connection-chooser__option"
                  onClick={() => {
                    createConductorFromTool(
                      connectionChooser.source,
                      connectionChooser.target,
                      item.id,
                    );
                    setConnectionChooser(null);
                  }}
                >
                  <PidSymbol kind={item.symbol ?? item.id} size={16} />
                  {item.label}
                </button>
              ))}
            </ConnectionChoiceSection>
          )}
          {connectionChooser.branches.length > 0 && (
            <div className="connection-chooser__library-actions">
              <button
                type="button"
                className="connection-chooser__new-component"
                onClick={() =>
                  setComponentEditorConnection({
                    source: connectionChooser.source,
                    target: connectionChooser.target,
                  })
                }
              >
                + Create custom component
              </button>
              <button
                type="button"
                className="connection-chooser__refresh"
                title="Refresh local components"
                aria-label="Refresh local components"
                disabled={componentLibrary.status === "loading"}
                onClick={() => void refreshComponentLibrary({ force: true })}
              >
                ↻
              </button>
            </div>
          )}
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => setConnectionChooser(null)}
          >
            Cancel
          </button>
        </div>
      )}
      {selectionMenuPosition && (
        <div
          className="selection-menu"
          style={{
            left: selectionMenuPosition.x,
            top: selectionMenuPosition.y,
          }}
          role="toolbar"
          aria-label="Selection actions"
        >
          {canDuplicate && (
            <button
              type="button"
              className="selection-menu__action"
              onClick={handleDuplicate}
            >
              Duplicate
            </button>
          )}
          {!groupId && (
            <RepeatMenuAction
              repeatability={repeatability}
              onClick={() => setRepeatDialogOpen(true)}
            />
          )}
          {!groupId && canvasSelection.length > 0 && (
            <button
              type="button"
              className="selection-menu__action"
              disabled={eligibleMemberIds.length < 2}
              onClick={createSubnetwork}
              title={
                eligibleMemberIds.length < 2
                  ? "Select at least two ungrouped nodes"
                  : "Create subnetwork"
              }
            >
              Create subnetwork
            </button>
          )}
          <button
            type="button"
            className="selection-menu__action selection-menu__action--danger"
            onClick={deleteSelected}
          >
            Delete
          </button>
        </div>
      )}
      {inspectMode &&
        result &&
        canInspectResult &&
        selectionChannels.length > 0 && (
          <div
            className="selection-plot"
            data-testid="selection-inspect-panel"
            style={
              selectionPlotPosition
                ? {
                    left: selectionPlotPosition.x,
                    top: selectionPlotPosition.y,
                    bottom: "auto",
                  }
                : undefined
            }
          >
            <div
              className="selection-plot__head"
              onMouseDown={(event) => {
                event.preventDefault();
                const bounds =
                  event.currentTarget.parentElement!.getBoundingClientRect();
                setSelectionPlotDrag({
                  offsetX: event.clientX - bounds.left,
                  offsetY: event.clientY - bounds.top,
                });
              }}
            >
              <span className="selection-plot__title">Selected properties</span>
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                aria-label="Close selected properties plot"
                onMouseDown={(event) => event.stopPropagation()}
                onClick={() => setInspectMode(false)}
              >
                ×
              </button>
            </div>
            {"times" in result ? (
              <>
                <div className="selection-plot__properties">
                  {selectionPlots.map((plot) => (
                    <label key={plot.key}>
                      <input
                        type="checkbox"
                        checked={selectionPlotProperties.includes(plot.key)}
                        onChange={() =>
                          setSelectionPlotProperties((current) =>
                            current.includes(plot.key)
                              ? current.filter((key) => key !== plot.key)
                              : [...current, plot.key],
                          )
                        }
                      />{" "}
                      {plot.title}
                    </label>
                  ))}
                </div>
                {selectionPlots
                  .filter((plot) => selectionPlotProperties.includes(plot.key))
                  .map((plot) => (
                    <InteractiveChart
                      key={plot.key}
                      dataTestid={`selection-transient-chart-${plot.key}`}
                      series={plot.series}
                      times={result.times}
                      xLabel="Time"
                      yLabel={plot.yLabel}
                      yQuantityKind={plot.yQuantityKind}
                      {...(plot.rawUnit !== undefined
                        ? { yUnitLabel: plot.rawUnit }
                        : {})}
                      height={180}
                    />
                  ))}
              </>
            ) : (
              <div className="selection-plot__steady-properties">
                {steadySelectionProperties.map(({ descriptor, value }) => (
                  <div
                    className="selection-plot__steady-property"
                    key={descriptor.key}
                  >
                    <span>{descriptor.label}</span>
                    <strong>
                      {formatChannelValue(
                        value,
                        descriptor,
                        unitPreferences,
                        resultSigFigs,
                      )}
                    </strong>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      {componentEditorConnection && (
        <ComponentEditorDialog
          libraryAvailable={componentLibrary.status === "ready"}
          onClose={() => setComponentEditorConnection(null)}
          onCreated={(component) => {
            createBranchFromTool(
              componentEditorConnection.source,
              componentEditorConnection.target,
              localComponentToolId(component.key),
              component,
            );
            setConnectionChooser(null);
            setComponentEditorConnection(null);
          }}
        />
      )}
      {repeatDialogOpen && (
        <RepeatDialog
          config={config}
          repeatability={repeatability}
          onClose={() => setRepeatDialogOpen(false)}
        />
      )}

      <div
        aria-live="polite"
        role="status"
        className="visually-hidden"
        data-testid="subnetwork-announce"
      >
        {subnetworkNotice}
      </div>
      <div
        aria-live="polite"
        role="status"
        className="visually-hidden"
        data-testid="canvas-announce"
      >
        {duplicateNotice}
      </div>

      {memberPicker && (
        <div
          className="chip"
          style={{
            position: "absolute",
            left: memberPicker.x * canvasViewport.zoom + canvasViewport.x,
            top: memberPicker.y * canvasViewport.zoom + canvasViewport.y,
            zIndex: 30,
          }}
        >
          <div
            style={{ fontSize: 11, color: "var(--text-2)", marginBottom: 6 }}
          >
            Select member node
          </div>
          {memberPicker.members.map((m) => (
            <button
              key={m.id}
              className="btn btn--sm"
              onClick={() => memberPicker.onPick(m.id)}
              style={{
                display: "block",
                width: "100%",
                textAlign: "left",
                marginBottom: 4,
              }}
            >
              {m.label || m.id}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ConnectionChoiceSection({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="connection-chooser__section">
      <div className="connection-chooser__section-label">{label}</div>
      <div className="connection-chooser__options">{children}</div>
    </div>
  );
}

function TimeScrubber({
  times,
  maxTimeIndex,
  currentTimeIndex,
  setTimeIndex,
}: {
  times: number[];
  maxTimeIndex: number;
  currentTimeIndex: number;
  setTimeIndex: (i: number) => void;
}) {
  const [playing, setPlaying] = useState(false);
  const unitPrefs = useStore((s) => s.unitPreferences);

  // ~10 fps playback through the saved time points; stops at the end.
  React.useEffect(() => {
    if (!playing) return;
    const timer = setInterval(() => {
      const cur = useStore.getState().timeIndex ?? maxTimeIndex;
      if (cur >= maxTimeIndex) {
        setPlaying(false);
      } else {
        setTimeIndex(cur + 1);
      }
    }, 100);
    return () => clearInterval(timer);
  }, [playing, maxTimeIndex, setTimeIndex]);

  const step = (delta: number) => {
    setPlaying(false);
    setTimeIndex(Math.max(0, Math.min(maxTimeIndex, currentTimeIndex + delta)));
  };

  return (
    <div
      data-testid="time-scrubber-panel"
      className="chip scrubber"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft") {
          e.preventDefault();
          step(-1);
        } else if (e.key === "ArrowRight") {
          e.preventDefault();
          step(1);
        }
      }}
    >
      <button
        data-testid="time-scrubber-play"
        className="btn btn--ghost btn--sm"
        onClick={() => {
          if (!playing && currentTimeIndex >= maxTimeIndex) setTimeIndex(0);
          setPlaying(!playing);
        }}
        aria-label={playing ? "Pause" : "Play"}
        title={playing ? "Pause" : "Play"}
      >
        {playing ? "❚❚" : "▶"}
      </button>
      <button
        data-testid="time-scrubber-back"
        className="btn btn--ghost btn--sm"
        onClick={() => step(-1)}
        aria-label="Step back"
        title="Step back"
      >
        ‹
      </button>
      <input
        data-testid="time-scrubber"
        className="scrubber__range"
        type="range"
        min={0}
        max={maxTimeIndex}
        step={1}
        value={currentTimeIndex}
        onChange={(e) => {
          setPlaying(false);
          setTimeIndex(parseInt(e.target.value));
        }}
        aria-label="Time index"
      />
      <button
        data-testid="time-scrubber-forward"
        className="btn btn--ghost btn--sm"
        onClick={() => step(1)}
        aria-label="Step forward"
        title="Step forward"
      >
        ›
      </button>
      <span
        style={{ whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}
      >
        t = {formatWithUnit(times[currentTimeIndex] ?? 0, "time", unitPrefs, 4)}{" "}
        / {formatWithUnit(times[maxTimeIndex] ?? 0, "time", unitPrefs, 4)}
      </span>
    </div>
  );
}

/** Colorable quantities, straight from the channel registry (colorData.ts). */
const COLOR_BY_GROUPS = colorByGroups();

/**
 * One editable legend bound (min or max), in display units. Mirrors the
 * commit-on-blur/Enter/Escape contract of UnitInput, but simpler: the
 * value is already display-scaled by the caller, and there's no formula
 * form to support — just a pinned number for the color ramp.
 */
function LegendBoundInput({
  value,
  onCommit,
  testId,
  label,
}: {
  value: number;
  onCommit: (v: number) => void;
  testId: string;
  label: string;
}) {
  const [raw, setRaw] = React.useState(() => formatSig(value, 3));
  const [focused, setFocused] = React.useState(false);

  React.useEffect(() => {
    if (!focused) setRaw(formatSig(value, 3));
  }, [value, focused]);

  const commit = () => {
    setFocused(false);
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed !== value) {
      onCommit(parsed);
    } else {
      setRaw(formatSig(value, 3));
    }
  };

  return (
    <input
      data-testid={testId}
      aria-label={label}
      className="input"
      type="text"
      inputMode="decimal"
      value={raw}
      onFocus={() => setFocused(true)}
      onChange={(e) => setRaw(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          commit();
          (e.target as HTMLInputElement).blur();
        } else if (e.key === "Escape") {
          setRaw(formatSig(value, 3));
          setFocused(false);
          (e.target as HTMLInputElement).blur();
        }
      }}
      style={{
        width: 44,
        padding: "1px 3px",
        fontSize: 10,
        textAlign: "center",
      }}
    />
  );
}

/**
 * Draggable dual-handle "scroller" over the legend gradient — the quick,
 * approximate companion to the precise LegendBoundInput text fields below
 * it. The track's full width is a *fixed* reference frame: `naturalDomain`,
 * the actual [min, max] of this quantity across the model right now. The
 * two handles pick a sub-range of that (`domain`) to use as the color
 * scale, so dragging never rescales the frame it's dragging within.
 *
 * Because values outside the pinned [min, max] get clamped to the extreme
 * ramp color anyway (see colorForValue), the track paints that directly:
 * solid dead zones outside the handles, gradient only between them.
 */
function LegendRangeSlider({
  naturalDomain,
  domain,
  signed,
  onChange,
}: {
  naturalDomain: [number, number];
  domain: [number, number];
  signed: boolean;
  onChange: (next: [number, number]) => void;
}) {
  const trackRef = React.useRef<HTMLDivElement>(null);
  const draggingEdgeRef = React.useRef<"min" | "max" | null>(null);
  const [min, max] = domain;
  const [lo, hi] = naturalDomain;
  const denom = hi - lo || 1;
  const pct = (v: number) =>
    Math.max(0, Math.min(100, ((v - lo) / denom) * 100));
  const minPct = pct(min);
  const maxPct = pct(max);
  const [loColor, hiColor] = rampEndColors(signed);

  const pendingRef = React.useRef<[number, number] | null>(null);
  const rafRef = React.useRef<number | null>(null);
  const flush = () => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (pendingRef.current) {
      onChange(pendingRef.current);
      pendingRef.current = null;
    }
  };
  const schedule = (next: [number, number]) => {
    pendingRef.current = next;
    if (rafRef.current === null) {
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        if (pendingRef.current) {
          onChange(pendingRef.current);
          pendingRef.current = null;
        }
      });
    }
  };

  const startDrag =
    (edge: "min" | "max") => (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      draggingEdgeRef.current = edge;
      e.currentTarget.setPointerCapture(e.pointerId);
    };

  // Only the pointer that's actually down (tracked via draggingEdgeRef, set
  // in startDrag/cleared in endDrag) should move the handle — otherwise a
  // plain hover or the incidental pointermove a click generates while the
  // cursor arrives at the thumb would drag it too.
  const onMove =
    (edge: "min" | "max") => (e: React.PointerEvent<HTMLDivElement>) => {
      if (draggingEdgeRef.current !== edge) return;
      const track = trackRef.current;
      if (!track) return;
      const rect = track.getBoundingClientRect();
      const frac = rect.width > 0 ? (e.clientX - rect.left) / rect.width : 0;
      const value = sliderValueFromFraction(naturalDomain, frac);
      schedule(moveSliderEdge(domain, edge, value));
    };

  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.releasePointerCapture(e.pointerId);
    flush();
    draggingEdgeRef.current = null;
  };

  const nudge =
    (edge: "min" | "max") => (e: React.KeyboardEvent<HTMLDivElement>) => {
      const span = Math.max(hi - lo, 1e-9);
      const step = span * 0.02;
      let delta = 0;
      if (e.key === "ArrowRight" || e.key === "ArrowUp") delta = step;
      else if (e.key === "ArrowLeft" || e.key === "ArrowDown") delta = -step;
      else return;
      e.preventDefault();
      onChange(
        moveSliderEdge(domain, edge, (edge === "min" ? min : max) + delta),
      );
    };

  const thumbStyle = (v: number): React.CSSProperties => ({
    position: "absolute",
    top: 2,
    left: `${pct(v)}%`,
    transform: "translate(-50%, 0)",
    width: 12,
    height: 12,
    borderRadius: "50%",
    background: "var(--text-1)",
    border: "2px solid var(--bg-2)",
    boxShadow: "0 0 0 1px var(--line-1)",
    cursor: "ew-resize",
    touchAction: "none",
  });

  return (
    <div
      ref={trackRef}
      data-testid="canvas-legend-slider"
      style={{
        position: "relative",
        width: 120,
        height: 16,
        margin: "6px 0 2px",
      }}
    >
      <div
        data-testid="canvas-legend-gradient"
        style={{
          position: "absolute",
          top: 4,
          left: 0,
          width: "100%",
          height: 8,
          borderRadius: 4,
          overflow: "hidden",
          border: "1px solid var(--line-1)",
          display: "flex",
        }}
      >
        <div
          style={{ width: `${minPct}%`, height: "100%", background: loColor }}
        />
        <div
          style={{
            width: `${Math.max(0, maxPct - minPct)}%`,
            height: "100%",
            background: `linear-gradient(90deg, ${rampGradientStops(signed)})`,
          }}
        />
        <div
          style={{
            width: `${Math.max(0, 100 - maxPct)}%`,
            height: "100%",
            background: hiColor,
          }}
        />
      </div>
      <div
        data-testid="canvas-legend-slider-min"
        role="slider"
        aria-label="Scale minimum"
        aria-valuenow={min}
        tabIndex={0}
        onPointerDown={startDrag("min")}
        onPointerMove={onMove("min")}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={nudge("min")}
        style={thumbStyle(min)}
      />
      <div
        data-testid="canvas-legend-slider-max"
        role="slider"
        aria-label="Scale maximum"
        aria-valuenow={max}
        tabIndex={0}
        onPointerDown={startDrag("max")}
        onPointerMove={onMove("max")}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={nudge("max")}
        style={thumbStyle(max)}
      />
    </div>
  );
}

function ColorLegend({
  colorData,
  colorBy,
}: {
  colorData: ReturnType<typeof resolveColorData>;
  colorBy: ColorBy;
}) {
  const unitId = useStore((s) => s.unitPreferences[colorData.unitKind]);
  const setColorDomainOverride = useStore((s) => s.setColorDomainOverride);
  const [min, max] = colorData.domain;
  const scale = resolveScale([min, max], colorData.unitKind, unitId);
  const mid = (min + max) / 2;
  const title = colorData.label || colorData.unitKind;

  const commitBound = (edge: "min" | "max", displayValue: number) => {
    const si = convertToSI(colorData.unitKind, displayValue, scale.unitId);
    const nextDomain: [number, number] = edge === "min" ? [si, max] : [min, si];
    if (nextDomain[0] >= nextDomain[1]) return; // reject a range that would invert or collapse the ramp
    setColorDomainOverride(colorBy, nextDomain);
  };

  return (
    <div
      data-testid="canvas-legend"
      className="chip canvas-legend"
      style={{ fontSize: 10 }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: 6,
        }}
      >
        <div
          style={{
            fontWeight: 700,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color: "var(--text-2)",
            fontSize: 10,
          }}
        >
          {title} ({scale.unitLabel})
        </div>
        {colorData.domainIsOverride && (
          <button
            type="button"
            data-testid="canvas-legend-reset"
            title="Reset to automatic range"
            onClick={() => setColorDomainOverride(colorBy, null)}
            style={{
              fontSize: 9,
              color: "var(--text-2)",
              background: "none",
              border: "none",
              cursor: "pointer",
              padding: 0,
              textDecoration: "underline",
            }}
          >
            auto
          </button>
        )}
      </div>
      <LegendRangeSlider
        naturalDomain={colorData.naturalDomain}
        domain={colorData.domain}
        signed={colorData.signed}
        onChange={(next) => setColorDomainOverride(colorBy, next)}
      />
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          width: 120,
          color: "var(--text-2)",
          fontVariantNumeric: "tabular-nums",
          gap: 4,
        }}
      >
        <LegendBoundInput
          testId="canvas-legend-min"
          label={`${title} scale minimum (${scale.unitLabel})`}
          value={scale.convert(min)}
          onCommit={(v) => commitBound("min", v)}
        />
        <span>{formatSig(scale.convert(mid), 3)}</span>
        <LegendBoundInput
          testId="canvas-legend-max"
          label={`${title} scale maximum (${scale.unitLabel})`}
          value={scale.convert(max)}
          onCommit={(v) => commitBound("max", v)}
        />
      </div>
      {colorData.dataMode === "initial" && (
        <div
          data-testid="canvas-legend-initial-note"
          style={{ marginTop: 4, color: "var(--text-3)", fontStyle: "italic" }}
        >
          showing initial values — run to update
        </div>
      )}
    </div>
  );
}

const emptyOverlayStyle: React.CSSProperties = {
  position: "absolute",
  top: "50%",
  left: "50%",
  transform: "translate(-50%, -50%)",
  textAlign: "center",
  color: "var(--text-2)",
  fontSize: 13,
  maxWidth: 280,
  lineHeight: 1.5,
  pointerEvents: "none",
  zIndex: 5,
};
