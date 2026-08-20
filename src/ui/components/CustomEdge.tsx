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
import { EDGE_BRANCH } from "../canvasPalette";
import { componentLabel, componentSymbol } from "../componentRegistry";
import { zoomTier, counterScale } from "../zoomTiers";
import {
  edgeRun,
  EDGE_CHIP_OFFSET,
  EDGE_INTERACTION_WIDTH,
} from "../canvasGeometry";
import { PidEdgeSymbol } from "./PidSymbol";

/**
 * CustomEdge — a fluid branch drawn as a P&ID pipe run: a STRAIGHT line with
 * no arrowheads, carrying the component symbol on its midpoint (a plain pipe
 * has no midpoint glyph; valves get the centered bow-tie; directional
 * symbols flip when the solved ṁ reverses). Flow direction is reported by
 * the signed ṁ readout in the chip and the reversed-flow dash cue.
 */
export default React.memo(function CustomEdge({
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
    componentType: string;
    label?: string;
    mdot?: number;
    dP?: number;
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

  const compType = data?.componentType || "pipe";
  const compName = componentLabel(compType);
  const mdot = data?.mdot;
  const dP = data?.dP;
  const label = data?.label ?? id;
  const colorValue = data?.colorValue;
  const domain = data?.domain;
  const colorBy = data?.colorBy;

  // Stroke always carries the data/type color; selection adds a glow + width.
  const stroke = fillForCanvas({
    colorBy,
    colorValue,
    domain,
    signed: data?.colorSigned,
    base: EDGE_BRANCH,
  });
  const reversed = mdot !== undefined && mdot < 0;
  const strokeDasharray = reversed ? "6 4" : undefined;

  const unitPrefs = useStore((s) => s.unitPreferences);
  const showLabels = useStore((s) => s.showLabels);

  const mdotLabel = React.useMemo(() => {
    if (mdot === undefined) return null;
    return `ṁ ${formatWithUnit(mdot, "massFlow", unitPrefs, 3)}`;
  }, [mdot, unitPrefs]);

  // ΔP demoted: only on selection or hover.
  const dPLabel = React.useMemo(() => {
    if (dP === undefined || (!selected && !hovered)) return null;
    return `ΔP ${formatWithUnit(dP, "pressure", unitPrefs, 3)}`;
  }, [dP, selected, hovered, unitPrefs]);

  // The hover chip stays screen-size invariant and retires at sparse tiers.
  const tierShowsChip = tier === "full" || tier === "names";
  // The chip is all element text — name plus readouts — so the labels toggle
  // retires the whole thing rather than emptying it.
  const showChip = tierShowsChip && hovered && showLabels;
  const showReadouts = tier === "full";

  // The chip sits beside the run (perpendicular offset), clear of the
  // on-line symbol. The offset is a constant SCREEN distance, so it is
  // converted to flow units at the current zoom.
  // For vertical runs, the chip is edge-anchored and grows away from the
  // symbol. This clears the glyph without a large, fixed-width gap.
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
            filter: selected
              ? "drop-shadow(0 0 4px rgba(201, 154, 67, 0.7))"
              : undefined,
          }}
        />
        {/* P&ID component symbol on the run midpoint (none for plain pipe).
            Decorative only — the chip title carries the accessible name. */}
        <PidEdgeSymbol
          kind={componentSymbol(compType)}
          edgeId={id}
          x={run.midX}
          y={run.midY}
          angleDeg={run.angleDeg}
          runLength={run.length}
          reversed={reversed}
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
              title={compName}
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
              {showReadouts && mdotLabel && (
                <span
                  data-testid={`mdot-${id}`}
                  style={{ marginLeft: 2, color: "var(--info)" }}
                >
                  {mdotLabel}
                </span>
              )}
              {showReadouts && dPLabel && (
                <span
                  style={{
                    marginLeft: 2,
                    color: "var(--text-2)",
                    fontSize: 10,
                  }}
                >
                  {dPLabel}
                </span>
              )}
            </div>
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
});
