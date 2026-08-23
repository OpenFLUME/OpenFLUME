/**
 * PidSymbol.tsx — inline SVG symbols for branch components and thermal
 * conductors, drawn in the conservative visual vocabulary of process
 * schematics / P&IDs (bow-tie valve, circle-and-impeller pump, orifice
 * plate, reducer taper, radiating arcs, …).
 *
 * NOTE: P&ID symbology varies across ISA-5.1 / ISO 14617 / EN and industry
 * practice. These glyphs are *recognizable conventional forms*, NOT a
 * claim of strict standards compliance — the human-readable component name
 * is always available via tooltip / aria title.
 */
/* eslint-disable react-refresh/only-export-components -- symbol policy helpers are public and tested */
import React from "react";
import { EDGE_GLYPH_SIZE, edgeGlyphScale } from "../canvasGeometry";

export type PidSymbolProps = {
  /** Branch component type or conductor kind (registry ids). */
  kind: string;
  /** Rendered square size in px (default 18). */
  size?: number;
  /** Accessible name. When omitted the symbol is aria-hidden decoration. */
  title?: string;
  className?: string;
  style?: React.CSSProperties;
};

const W = 1.5; // stroke width

function paths(kind: string): React.ReactNode {
  switch (kind) {
    // ── Common flow ──────────────────────────────────────────────────
    case "pipe":
      // Straight run of pipe.
      return <line x1="1" y1="9" x2="17" y2="9" />;
    case "valve":
      // Classic bow-tie (two opposed triangles) with pipeline through.
      return (
        <>
          <line x1="1" y1="9" x2="4" y2="9" />
          <line x1="14" y1="9" x2="17" y2="9" />
          <polygon points="4,4.5 9,9 4,13.5" />
          <polygon points="14,4.5 9,9 14,13.5" />
        </>
      );
    case "checkValve":
      // Cone seating against a perpendicular seat line (free flow →).
      return (
        <>
          <line x1="1" y1="9" x2="3.5" y2="9" />
          <polygon points="3.5,4.5 11,9 3.5,13.5" />
          <line x1="13" y1="4" x2="13" y2="14" />
          <line x1="13" y1="9" x2="17" y2="9" />
        </>
      );
    case "reliefValve":
      // Bow-tie valve with a spring cue above the bonnet.
      return (
        <>
          <line x1="1" y1="11" x2="4" y2="11" />
          <line x1="14" y1="11" x2="17" y2="11" />
          <polygon points="4,6.5 9,11 4,15.5" />
          <polygon points="14,6.5 9,11 14,15.5" />
          <polyline points="9,6.5 9,4.8 7,3.6 11,2.2 9,1" />
        </>
      );
    case "dynamicCheckValve":
      // Cone seating against a seat line (like checkValve), plus a spring
      // cue on the poppet stem — the mechanical DOF that sets it apart.
      return (
        <>
          <line x1="1" y1="9" x2="3.5" y2="9" />
          <polygon points="3.5,4.5 11,9 3.5,13.5" />
          <line x1="13" y1="4" x2="13" y2="14" />
          <line x1="13" y1="9" x2="17" y2="9" />
          <polyline points="7,4.3 7,3.3 5.3,2.5 8.7,1.3 7,0.5" />
        </>
      );
    case "pump":
      // Circle with directional impeller triangle (discharge →).
      return (
        <>
          <circle cx="9" cy="9" r="6.5" />
          <polygon
            points="6.5,5.5 13.5,9 6.5,12.5"
            fill="currentColor"
            stroke="none"
          />
        </>
      );
    case "flowSource":
      // Source circle with a directional flow arrow.
      return (
        <>
          <circle cx="7" cy="9" r="4" />
          <line x1="7" y1="9" x2="15" y2="9" />
          <polyline points="12.5,6.5 15.5,9 12.5,11.5" />
        </>
      );
    // ── Advanced flow ────────────────────────────────────────────────
    case "orifice":
      // Pipeline interrupted by an orifice plate.
      return (
        <>
          <line x1="1" y1="9" x2="17" y2="9" />
          <line x1="7.5" y1="4" x2="7.5" y2="14" />
          <line x1="10.5" y1="4" x2="10.5" y2="14" />
        </>
      );
    case "cavitatingVenturi":
      // Converging–diverging (venturi) nozzle with a cavitation bubble cue.
      return (
        <>
          <polyline points="1,5 6.5,7.6 11.5,7.6 17,5" />
          <polyline points="1,13 6.5,10.4 11.5,10.4 17,13" />
          <circle cx="13.5" cy="14.8" r="1.1" />
        </>
      );
    case "resistance":
      // Resistive restriction (zig-zag), as in hydraulic schematics.
      return (
        <polyline points="1,9 3.5,9 5.5,4.5 8,13.5 10.5,4.5 13,13.5 14.5,9 17,9" />
      );
    case "bend":
      // Elbow.
      return <path d="M4 16 L4 10 A6 6 0 0 1 10 4 L16 4" />;
    case "areaChange":
      // Reducer/expander taper.
      return (
        <>
          <polyline points="1,4 17,7.4" />
          <polyline points="1,14 17,10.6" />
          <line x1="1" y1="4" x2="1" y2="14" />
        </>
      );
    case "regulator":
      // Bow-tie valve with a diaphragm actuator on top.
      return (
        <>
          <line x1="1" y1="11" x2="4" y2="11" />
          <line x1="14" y1="11" x2="17" y2="11" />
          <polygon points="4,6.5 9,11 4,15.5" />
          <polygon points="14,6.5 9,11 14,15.5" />
          <line x1="9" y1="6.5" x2="9" y2="3.8" />
          <path d="M5 3.8 Q9 0.6 13 3.8" />
        </>
      );
    case "heatedPipe":
      // Pipe run with heat waves rising off it.
      return (
        <>
          <line x1="1" y1="11.5" x2="17" y2="11.5" />
          <path d="M4.5 8.2 q1 -1.6 0 -3.2" />
          <path d="M9 8.2 q1 -1.6 0 -3.2" />
          <path d="M13.5 8.2 q1 -1.6 0 -3.2" />
        </>
      );
    case "dpTable":
      return (
        <>
          <path d="M3 14 L7 11 L11 12 L16 5" />
          <path d="M3 3 V15 H17" />
        </>
      );
    case "customResistance":
      return <path d="M1 9 H4 L6 5 L8 13 L10 5 L12 13 L14 9 H17" />;
    case "userComponent":
      return (
        <>
          <rect x="4" y="3" width="10" height="12" rx="1.5" />
          <path d="M1 9 H4 M14 9 H17" />
          <text
            x="9"
            y="11.5"
            textAnchor="middle"
            fontSize="7"
            fill="currentColor"
            stroke="none"
          >
            U
          </text>
        </>
      );
    // ── Thermal conductors ───────────────────────────────────────────
    case "conduction":
      // Solid thermal link (filled bar).
      return (
        <rect
          x="1.5"
          y="6.5"
          width="15"
          height="5"
          fill="currentColor"
          stroke="none"
        />
      );
    case "convection":
      // Solid link with a fluid (convective) wave.
      return (
        <>
          <line x1="1" y1="11" x2="17" y2="11" />
          <path d="M2 7.5 q1.8 -3 3.7 0 q1.8 3 3.7 0 q1.8 -3 3.7 0 q1.8 3 3.6 0" />
        </>
      );
    case "radiation":
      // Radiating waves from a surface.
      return (
        <>
          <line x1="2" y1="13" x2="16" y2="13" />
          <path d="M5.5 10 A4 4 0 0 1 12.5 10" />
          <path d="M4 7 A7 7 0 0 1 14 7" />
        </>
      );
    default:
      // Unknown kind: neutral diamond placeholder (never asserted as P&ID).
      return (
        <polygon points="9,2.5 15.5,9 9,15.5 2.5,9" strokeDasharray="2.5 2" />
      );
  }
}

/** True when `kind` has a dedicated (non-placeholder) symbol. */
export function hasPidSymbol(kind: string): boolean {
  switch (kind) {
    case "pipe":
    case "valve":
    case "checkValve":
    case "dynamicCheckValve":
    case "reliefValve":
    case "pump":
    case "flowSource":
    case "orifice":
    case "cavitatingVenturi":
    case "resistance":
    case "bend":
    case "areaChange":
    case "regulator":
    case "heatedPipe":
    case "dpTable":
    case "customResistance":
    case "userComponent":
    case "conduction":
    case "convection":
    case "radiation":
      return true;
    default:
      return false;
  }
}

export default function PidSymbol({
  kind,
  size = 18,
  title,
  className,
  style,
}: PidSymbolProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 18 18"
      fill="none"
      stroke="currentColor"
      strokeWidth={W}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={style}
      {...(title ? { role: "img" } : { "aria-hidden": true, focusable: false })}
    >
      {title ? <title>{title}</title> : null}
      {paths(kind)}
    </svg>
  );
}

/* --------------------------------------------------------------------------
 * On-line edge symbols — the P&ID vocabulary drawn directly on the pipe run.
 * ------------------------------------------------------------------------ */

/**
 * Symbols whose glyph encodes a flow/process direction: they are rotated to
 * point along the solved flow (source → target, flipped 180° when the solved
 * ṁ is negative). All other glyphs are direction-neutral and are only
 * normalized upright (never upside down), so reversing flow leaves them
 * visually unchanged.
 */
export const DIRECTIONAL_PID_SYMBOLS: ReadonlySet<string> = new Set([
  "pump",
  "checkValve",
  "dynamicCheckValve",
  "flowSource",
  "areaChange",
  "regulator",
  "reliefValve",
]);

export function isDirectionalSymbol(kind: string): boolean {
  return DIRECTIONAL_PID_SYMBOLS.has(kind);
}

/**
 * Rotation (degrees) for a symbol on a run at `runAngleDeg` (screen coords,
 * 0 = left→right). Directional symbols point down-run (flipped on reversed
 * flow); neutral symbols are mirrored into (-90°, 90°] so accessory features
 * (springs, diaphragms, heat waves, text) never render upside down.
 */
export function edgeSymbolRotation(
  kind: string,
  runAngleDeg: number,
  reversed: boolean,
): number {
  let a = ((runAngleDeg % 360) + 360) % 360; // → [0, 360)
  if (isDirectionalSymbol(kind)) {
    if (reversed) a = (a + 180) % 360;
    return a === 0 ? 0 : a; // avoid "-0"
  }
  if (a > 270) a -= 360;
  if (a > 90) a -= 180;
  return a === 0 ? 0 : a;
}

export type PidEdgeSymbolProps = {
  /** Branch component type / conductor kind (registry ids) or symbol id. */
  kind: string;
  /** Edge id — emitted as `edge-symbol-<id>` for tests/diagnostics. */
  edgeId?: string;
  /** Run midpoint in flow coordinates. */
  x: number;
  y: number;
  /** Run direction in degrees (0 = left→right, +y down). */
  angleDeg: number;
  /** Full run length in flow px — short runs shrink/omit the glyph. */
  runLength: number;
  /** Solved reversed flow: flips directional symbols. */
  reversed?: boolean;
  /** Stroke/fill color (result or selection color); glyphs use currentColor. */
  color: string;
  /** Glyph square size in flow px (default EDGE_GLYPH_SIZE). */
  size?: number;
};

/**
 * A P&ID symbol planted on the midpoint of a straight pipe run: rotated with
 * the run, flipped for reversed solved flow, shrunk/omitted on short runs.
 * Pure SVG (no hooks) so it is cheap to render per edge and trivially
 * testable. Always aria-hidden decoration — the edge chip carries the
 * accessible component name.
 *
 * A small canvas-colored backdrop punches the line beneath the symbol so
 * hollow glyphs (pump circle, bow-tie) read as line breaks, as on paper.
 */
export function PidEdgeSymbol({
  kind,
  edgeId,
  x,
  y,
  angleDeg,
  runLength,
  reversed = false,
  color,
  size = EDGE_GLYPH_SIZE,
}: PidEdgeSymbolProps) {
  // A plain pipe run carries no midpoint glyph — the line IS the symbol.
  if (kind === "pipe") return null;
  const scale = edgeGlyphScale(runLength);
  if (scale <= 0) return null;
  const rotation = edgeSymbolRotation(kind, angleDeg, reversed);
  const half = size / 2;
  return (
    <g
      transform={`translate(${x} ${y}) rotate(${rotation}) scale(${scale})`}
      style={{ color, pointerEvents: "none" }}
      aria-hidden="true"
      focusable={false}
      {...(edgeId ? { "data-testid": `edge-symbol-${edgeId}` } : {})}
      data-symbol={kind}
      data-directional={isDirectionalSymbol(kind) || undefined}
      data-reversed={reversed || undefined}
    >
      {/* Backdrop: breaks the run under the glyph (canvas background). */}
      <rect
        x={-half + 1}
        y={-half + 1}
        width={size - 2}
        height={size - 2}
        fill="var(--bg-0)"
        stroke="none"
      />
      <g transform={`translate(${-half} ${-half})`}>
        <PidSymbol kind={kind} size={size} />
      </g>
    </g>
  );
}
