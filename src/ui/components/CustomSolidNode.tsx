import React from "react";
import { useViewport } from "@xyflow/react";
import { useStore } from "../store";
import { formatWithUnit } from "../format";
import { fillForCanvas } from "../colorData";
import { NODE_GHOST, NODE_OUTLINE, solidNodeColor } from "../canvasPalette";
import { zoomTier, showsNodeName, showsNodeChip } from "../zoomTiers";
import { LabelLayoutContext } from "../labelLayout";
import {
  SOLID_NODE_SIZE,
  nodeLabelTop,
  ghostLabelTop,
} from "../canvasGeometry";
import ConnectionHandles from "./ConnectionHandles";
import ZoomStableLabel from "./ZoomStableLabel";
import type { SolidNode } from "../types";

interface CustomSolidNodeData {
  node: SolidNode;
  selected: boolean;
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

export default React.memo(function CustomSolidNode({
  data,
  id,
  selected: rfSelected,
}: {
  data: CustomSolidNodeData;
  id: string;
  selected?: boolean;
}) {
  const {
    node,
    selected: panelSelected,
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
  const isAmbient = node.type === "ambient";
  const size = SOLID_NODE_SIZE;

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
          <polygon
            points={`${size / 2},2 ${size - 2},${size / 2} ${size / 2},${size - 2} 2,${size / 2}`}
            fill="none"
            stroke={NODE_GHOST}
            strokeWidth={2}
            strokeDasharray={isAmbient ? "4 2" : undefined}
          />
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

  const fill = fillForCanvas({
    colorBy,
    colorValue,
    domain,
    signed: colorSigned,
    base: solidNodeColor(node.type),
  });
  const dash = isAmbient ? "4 2" : undefined;

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

  const unitPrefs = useStore((s) => s.unitPreferences);

  const resultChip = React.useMemo(() => {
    if (resultTemperature === undefined) return null;
    return formatWithUnit(resultTemperature, "temperature", unitPrefs, 3);
  }, [resultTemperature, unitPrefs]);

  // Ambient BC chip: configured temperature visible before any run.
  const bcChip = React.useMemo(() => {
    if (resultChip || !isAmbient || node.temperature === undefined) return null;
    if (typeof node.temperature !== "number") return "BC ƒ";
    return `BC ${formatWithUnit(node.temperature, "temperature", unitPrefs, 3)}`;
  }, [resultChip, isAmbient, node.temperature, unitPrefs]);

  const showName = showsNodeName({
    tier,
    showLabels,
    selected,
    hovered,
    pinned: isAmbient,
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
        <polygon
          points={`${size / 2},2 ${size - 2},${size / 2} ${size / 2},${size - 2} 2,${size / 2}`}
          fill={fill}
          stroke={NODE_OUTLINE}
          strokeWidth={2}
          strokeDasharray={dash}
        />
      </svg>
      {/* Matches CustomNode: the shape answers the pointer before it is
          clicked, one weight below the selection ring. */}
      {hovered && !selected && (
        <div
          style={{
            position: "absolute",
            inset: -3,
            border: "1px solid var(--line-2)",
            borderRadius: 6,
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
            borderRadius: 6,
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
            borderRadius: 4,
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
