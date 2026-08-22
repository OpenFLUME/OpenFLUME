import React from "react";
import { useViewport } from "@xyflow/react";
import { NetworkConfig } from "../types";
import { useStore } from "../store";
import { formatWithUnit } from "../format";
import { fillForCanvas } from "../colorData";
import { NODE_GHOST, NODE_OUTLINE, fluidNodeColor } from "../canvasPalette";
import { zoomTier, showsNodeName, showsNodeChip } from "../zoomTiers";
import { LabelLayoutContext } from "../labelLayout";
import { fluidNodeSize, nodeLabelTop, ghostLabelTop } from "../canvasGeometry";
import ConnectionHandles from "./ConnectionHandles";
import ZoomStableLabel from "./ZoomStableLabel";

type NodeConfig = NetworkConfig["nodes"][number];

interface CustomNodeData {
  node: NodeConfig;
  selected: boolean;
  resultPressure?: number;
  resultTemperature?: number;
  colorValue?: number;
  domain?: [number, number];
  colorBy?: string;
  colorSigned?: boolean;
  branchToolActive?: boolean;
  dense?: boolean;
  isPendingSource?: boolean;
  isGhost?: boolean;
  onGhostClick?: () => void;
}

const NAME_STYLE: React.CSSProperties = {
  whiteSpace: "nowrap",
  fontSize: 11,
  color: "var(--text-1)",
  textShadow: "0 1px 2px rgba(0,0,0,0.8)",
};

export default React.memo(function CustomNode({
  data,
  id,
  selected: rfSelected,
}: {
  data: CustomNodeData;
  id: string;
  selected?: boolean;
}) {
  const {
    node,
    selected: panelSelected,
    resultPressure,
    resultTemperature,
    colorValue,
    domain,
    colorBy,
    colorSigned,
    branchToolActive,
    dense,
    isPendingSource,
    isGhost,
    onGhostClick,
  } = data;
  // Ring shows for the PropertyPanel selection AND React Flow multi-selection.
  const selected = panelSelected || !!rfSelected;
  const { zoom } = useViewport();
  const tier = zoomTier(zoom, dense);
  const showLabels = useStore((s) => s.showLabels);
  const labelLayout = React.useContext(LabelLayoutContext);
  const nameCulled = labelLayout.hidden.has(id);
  const displayName = labelLayout.text.get(id) ?? node.label ?? node.id;
  const [hovered, setHovered] = React.useState(false);
  const [portHovered, setPortHovered] = React.useState(false);
  const isBoundary = node.type === "boundary";
  // Reacting junction (config.junctions): marked with an inner dashed ring
  // so a combustion chamber reads differently from a plain mixing node.
  const isJunction = useStore((s) =>
    (s.config.junctions ?? []).some((j) => j.node === node.id),
  );
  const size = fluidNodeSize(node.type);

  const unitPrefs = useStore((s) => s.unitPreferences);

  // Result chip: P · T at 3 sig figs in the user's units.  (Hooks stay above
  // the ghost early-return so the hook order is identical on every render.)
  const resultChip = React.useMemo(() => {
    if (resultPressure === undefined && resultTemperature === undefined)
      return null;
    const parts: string[] = [];
    if (resultPressure !== undefined)
      parts.push(formatWithUnit(resultPressure, "pressure", unitPrefs, 3));
    if (resultTemperature !== undefined)
      parts.push(
        formatWithUnit(resultTemperature, "temperature", unitPrefs, 3),
      );
    return parts.join(" · ");
  }, [resultPressure, resultTemperature, unitPrefs]);

  // Boundary-condition chip: configured P/T visible BEFORE any run, styled
  // hollow + "BC" so an unrun screenshot can't be mistaken for results.
  const bcChip = React.useMemo(() => {
    if (resultChip || !isBoundary) return null;
    const parts: string[] = [];
    if (typeof node.pressure === "number")
      parts.push(formatWithUnit(node.pressure, "pressure", unitPrefs, 3));
    if (typeof node.temperature === "number")
      parts.push(formatWithUnit(node.temperature, "temperature", unitPrefs, 3));
    if (
      parts.length === 0 &&
      (node.pressure !== undefined || node.temperature !== undefined)
    )
      return "BC ƒ";
    return parts.length ? `BC ${parts.join(" · ")}` : null;
  }, [resultChip, isBoundary, node.pressure, node.temperature, unitPrefs]);

  if (isGhost) {
    return (
      <div
        data-testid={`ghost-node-${id}`}
        onClick={(e) => {
          e.stopPropagation();
          if (onGhostClick) onGhostClick();
        }}
        style={{
          width: size,
          height: size,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          position: "relative",
          cursor: "pointer",
          opacity: 0.5,
        }}
      >
        <svg width={size} height={size}>
          {isBoundary ? (
            <rect
              x={2}
              y={2}
              width={size - 4}
              height={size - 4}
              rx={6}
              fill="none"
              stroke={NODE_GHOST}
              strokeWidth={2}
              strokeDasharray="4 2"
            />
          ) : (
            <circle
              cx={size / 2}
              cy={size / 2}
              r={size / 2 - 2}
              fill="none"
              stroke={NODE_GHOST}
              strokeWidth={2}
              strokeDasharray="4 2"
            />
          )}
        </svg>
        {showLabels && (
          <ZoomStableLabel zoom={zoom} left="50%" top={ghostLabelTop(size)}>
            <div style={{ ...NAME_STYLE, color: "var(--text-3)" }}>
              {node.label || node.id}
            </div>
          </ZoomStableLabel>
        )}
        <ConnectionHandles style={{ width: 6, height: 6, opacity: 0.001 }} />
      </div>
    );
  }

  // Fill always carries the data/type color — selection is a ring, never a fill.
  const fill = fillForCanvas({
    colorBy,
    colorValue,
    domain,
    signed: colorSigned,
    base: fluidNodeColor(node.type),
  });

  // One condition drives both the cursor and all-port reveal.
  const connectionAffordanceActive = !!branchToolActive || portHovered;
  const handleSize = connectionAffordanceActive ? 7 : 5;
  const handleOpacity = connectionAffordanceActive ? 1 : 0.001;
  const handleStyleBase: React.CSSProperties = {
    width: handleSize,
    height: handleSize,
    opacity: handleOpacity,
    background: connectionAffordanceActive ? "var(--bg-2)" : "transparent",
    border: connectionAffordanceActive
      ? `2px solid ${branchToolActive ? "var(--select)" : "var(--line-focus)"}`
      : "none",
    borderRadius: "50%",
    zIndex: 20,
    cursor: connectionAffordanceActive ? "crosshair" : "default",
  };

  const showName = showsNodeName({
    tier,
    showLabels,
    selected,
    hovered,
    pinned: isBoundary,
    culled: nameCulled,
  });
  const showChip = showsNodeChip({
    tier,
    showLabels,
    hasContent: !!(resultChip || bcChip),
  });

  return (
    <div
      data-testid={`node-${id}`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        width: size,
        height: size,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        position: "relative",
        cursor: undefined,
      }}
    >
      <svg width={size} height={size} style={{ display: "block" }}>
        {isBoundary ? (
          <rect
            x={2}
            y={2}
            width={size - 4}
            height={size - 4}
            rx={6}
            fill={fill}
            stroke={NODE_OUTLINE}
            strokeWidth={2}
          />
        ) : (
          <circle
            cx={size / 2}
            cy={size / 2}
            r={size / 2 - 2}
            fill={fill}
            stroke={NODE_OUTLINE}
            strokeWidth={2}
          />
        )}
        {isJunction && !isBoundary && (
          <circle
            data-testid={`node-junction-ring-${id}`}
            cx={size / 2}
            cy={size / 2}
            r={size / 2 - 6}
            fill="none"
            stroke="#d68910"
            strokeWidth={1.6}
            strokeDasharray="3 2"
          >
            <title>Reacting junction</title>
          </circle>
        )}
      </svg>
      {/* Hover gave no feedback on the shape itself, so a node looked inert
          until clicked. A hairline ring answers the pointer without competing
          with the amber selection ring it sits under. */}
      {hovered && !selected && (
        <div
          style={{
            position: "absolute",
            inset: -3,
            border: "1px solid var(--line-2)",
            borderRadius: isBoundary ? 9 : "50%",
            pointerEvents: "none",
          }}
        />
      )}
      {selected && (
        <div
          data-testid={`node-selected-ring-${id}`}
          style={{
            position: "absolute",
            inset: -3,
            border: "2px solid var(--select)",
            borderRadius: isBoundary ? 9 : "50%",
            boxShadow: "0 0 6px rgba(201, 154, 67, 0.45)",
            pointerEvents: "none",
          }}
        />
      )}
      {isPendingSource && (
        <div
          style={{
            position: "absolute",
            inset: -6,
            border: "2px dashed var(--select)",
            borderRadius: isBoundary ? 10 : "50%",
            pointerEvents: "none",
            animation: "pulse-ring 1.5s ease-in-out infinite",
          }}
        />
      )}
      <ZoomStableLabel zoom={zoom} left="50%" top={nodeLabelTop(size)}>
        {showName && <div style={NAME_STYLE}>{displayName}</div>}
        {showChip && (
          <div
            data-testid={`node-result-${id}`}
            className={
              resultChip ? "readout-chip" : "readout-chip readout-chip--bc"
            }
          >
            {resultChip ?? bcChip}
          </div>
        )}
      </ZoomStableLabel>
      <ConnectionHandles
        style={handleStyleBase}
        withTestIds
        onHoverChange={setPortHovered}
      />
    </div>
  );
});
