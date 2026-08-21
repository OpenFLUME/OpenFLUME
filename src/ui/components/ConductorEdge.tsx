import React from "react";
import {
  BaseEdge,
  EdgeLabelRenderer,
  getStraightPath,
  useViewport,
  EdgeProps,
} from "@xyflow/react";
import { useStore } from "../store";
import { formatWithUnit } from "../format";
import { fillForCanvas } from "../colorData";
import { EDGE_CONDUCTOR, EDGE_RADIATION } from "../canvasPalette";
import { conductorLabel, conductorSymbol } from "../componentRegistry";
import { zoomTier, counterScale } from "../zoomTiers";
import {
  edgeRun,
  EDGE_CHIP_OFFSET,
  EDGE_INTERACTION_WIDTH,
} from "../canvasGeometry";
import { PidEdgeSymbol } from "./PidSymbol";

/**
 * ConductorEdge — a thermal conductor drawn like the fluid runs: a STRAIGHT
 * dashed line carrying the conduction/convection/radiation glyph on its
 * midpoint, with the result chip offset perpendicular to the run.
 */
export default React.memo(function ConductorEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  selected,
  interactionWidth,
}: EdgeProps & {
  data?: {
    kind: string;
    label?: string;
    heatRate?: number;
    colorValue?: number;
    domain?: [number, number];
    colorBy?: string;
    colorSigned?: boolean;
    dense?: boolean;
  };
}) {
  const [edgePath] = getStraightPath({ sourceX, sourceY, targetX, targetY });
  const run = edgeRun(sourceX, sourceY, targetX, targetY);
  const { zoom } = useViewport();
  const tier = zoomTier(zoom, data?.dense);
  const [hovered, setHovered] = React.useState(false);

  const kind = data?.kind || "conduction";
  const kindName = conductorLabel(kind);
  const heatRate = data?.heatRate;
  const label = data?.label ?? id;
  const colorValue = data?.colorValue;
  const domain = data?.domain;
  const colorBy = data?.colorBy;

  const isRadiation = kind === "radiation";
  const stroke = fillForCanvas({
    colorBy,
    colorValue,
    domain,
    signed: data?.colorSigned,
    base: isRadiation ? EDGE_RADIATION : EDGE_CONDUCTOR,
  });
  const strokeDasharray = "6 3";
  const strokeOpacity = isRadiation ? 0.88 : 1;

  const unitPrefs = useStore((s) => s.unitPreferences);
  const showLabels = useStore((s) => s.showLabels);

  const qLabel = React.useMemo(() => {
    if (heatRate === undefined) return null;
    return `Q ${formatWithUnit(heatRate, "power", unitPrefs, 3)}`;
  }, [heatRate, unitPrefs]);

  // The hover chip stays screen-size invariant and retires at sparse tiers.
  const tierShowsChip = tier === "full" || tier === "names";
  // The chip is all element text — name plus readouts — so the labels toggle
  // retires the whole thing rather than emptying it.
  const showChip = tierShowsChip && hovered && showLabels;
  const showReadouts = tier === "full";

  // Chip beside the run (constant screen-space perpendicular offset).
  // Side labels on vertical ties grow outward from the symbol's edge.
  const sideLabel = Math.abs(run.normalX) > Math.abs(run.normalY);
  const chipOffsetScreen = sideLabel ? 16 : EDGE_CHIP_OFFSET;
  const chipOffsetFlow = chipOffsetScreen / zoom;
  const chipX = run.midX + run.normalX * chipOffsetFlow;
  const chipY = run.midY + run.normalY * chipOffsetFlow;

  return (
    <>
      {/* Deterministic side markers for tests/diagnostics: which node sides
          this edge leaves/enters (chosen by connectionGeometry). */}
      <g
        data-source-side={sourcePosition}
        data-target-side={targetPosition}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        <BaseEdge
          id={id}
          path={edgePath}
          interactionWidth={interactionWidth ?? EDGE_INTERACTION_WIDTH}
          style={{
            stroke,
            strokeWidth: selected ? 3 : 2,
            strokeDasharray,
            opacity: strokeOpacity,
            filter: selected
              ? "drop-shadow(0 0 4px rgba(201, 154, 67, 0.7))"
              : undefined,
          }}
        />
        {/* Conductor glyph on the run midpoint (aria-hidden decoration). */}
        <PidEdgeSymbol
          kind={conductorSymbol(kind)}
          edgeId={id}
          x={run.midX}
          y={run.midY}
          angleDeg={run.angleDeg}
          runLength={run.length}
          color={selected ? "var(--select)" : stroke}
        />
      </g>
      {showChip && (
        <EdgeLabelRenderer>
          <div
            style={{
              position: "absolute",
              transform: `translate(${chipX}px, ${chipY}px)`,
              width: 0,
              height: 0,
              display: "flex",
              justifyContent: sideLabel
                ? run.normalX > 0
                  ? "flex-start"
                  : "flex-end"
                : "center",
              alignItems: "center",
              pointerEvents: "none",
            }}
          >
            <div
              className="readout-chip"
              data-testid={`edge-chip-${id}`}
              title={kindName}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 5,
                transform: counterScale(zoom),
                borderColor: selected ? "var(--select)" : stroke,
                pointerEvents: "none",
                whiteSpace: "nowrap",
              }}
            >
              <span>{label}</span>
              {showReadouts && qLabel && (
                <span style={{ marginLeft: 2, color: "var(--info)" }}>
                  {qLabel}
                </span>
              )}
            </div>
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
});
