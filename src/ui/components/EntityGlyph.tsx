/**
 * EntityGlyph — the single place that decides what a model entity looks like
 * as a small icon.
 *
 * Node shapes and colors are the ones the canvas draws (circle = internal
 * fluid, rounded square = boundary, diamond = solid, dashed diamond =
 * ambient), so the outline and the creation rail read as a legend for the
 * drawing rather than as a second, unrelated vocabulary. Branches and
 * conductors delegate to the P&ID symbol set, tinted with their canvas edge
 * color.
 *
 * Sizing: pass `size` for an intrinsically sized glyph (outline rows), or
 * omit it and size the returned SVG from CSS (the canvas rail does this).
 */
import PidSymbol, { hasPidSymbol } from "./PidSymbol";
import {
  EDGE_BRANCH,
  EDGE_CONDUCTOR,
  EDGE_RADIATION,
  fluidNodeColor,
  solidNodeColor,
} from "../canvasPalette";
import { componentSymbol, conductorSymbol } from "../componentRegistry";

export type EntityGlyphSpec =
  /** `component` and `kind` are raw registry types; the symbol lookup is
   *  done here so callers never have to know about symbol aliases. */
  | { entity: "node"; type: "internal" | "boundary" }
  | { entity: "solidNode"; type: "solid" | "ambient" }
  | { entity: "branch"; component: string }
  | { entity: "conductor"; kind: string }
  | { entity: "group" }
  | { entity: "note" };

export type EntityGlyphProps = EntityGlyphSpec & {
  /** Rendered square size in px. Omit to size from CSS. */
  size?: number;
  /** Accessible name; without it the glyph is decoration. */
  title?: string;
  className?: string;
};

/** Canvas edge color for a conductor kind. */
function conductorColor(kind: string): string {
  return kind === "radiation" ? EDGE_RADIATION : EDGE_CONDUCTOR;
}

export default function EntityGlyph(props: EntityGlyphProps) {
  const { size, title, className } = props;

  // Branches and conductors already have a symbol vocabulary. Tint via
  // `color` because every P&ID path strokes with currentColor.
  if (props.entity === "branch" || props.entity === "conductor") {
    const kind =
      props.entity === "branch"
        ? componentSymbol(props.component)
        : conductorSymbol(props.kind);
    const color =
      props.entity === "branch" ? EDGE_BRANCH : conductorColor(props.kind);
    return (
      <span
        className={className}
        style={{ color, display: "inline-flex", flex: "none" }}
      >
        <PidSymbol
          kind={hasPidSymbol(kind) ? kind : "unknown"}
          size={size ?? 16}
          title={title}
        />
      </span>
    );
  }

  // Everything else is a shape the canvas draws directly. One 32-unit
  // viewBox shared with the rail glyphs so the two can never drift.
  const sizeProps = size === undefined ? {} : { width: size, height: size };
  const a11y = title
    ? ({ role: "img" } as const)
    : ({ "aria-hidden": true } as const);

  return (
    <svg
      className={className}
      viewBox="0 0 32 32"
      style={{ flex: "none" }}
      {...sizeProps}
      {...a11y}
    >
      {title && <title>{title}</title>}
      {props.entity === "node" &&
        (props.type === "boundary" ? (
          <rect
            x="5"
            y="5"
            width="22"
            height="22"
            rx="4"
            fill={fluidNodeColor("boundary")}
          />
        ) : (
          <circle cx="16" cy="16" r="11" fill={fluidNodeColor("internal")} />
        ))}
      {props.entity === "solidNode" && (
        <polygon
          points="16,4 28,16 16,28 4,16"
          fill={solidNodeColor(props.type)}
          stroke={props.type === "ambient" ? solidNodeColor("solid") : "none"}
          strokeWidth="2.5"
          strokeDasharray={props.type === "ambient" ? "5 3" : undefined}
        />
      )}
      {props.entity === "group" && (
        <rect
          x="4"
          y="7"
          width="24"
          height="18"
          rx="3"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeDasharray="5 3"
        />
      )}
      {props.entity === "note" && (
        <>
          <rect
            x="5"
            y="6"
            width="22"
            height="20"
            rx="3"
            strokeWidth="2"
            style={{ fill: "var(--note-paper)", stroke: "var(--note-edge)" }}
          />
          <path
            d="M10 13h12M10 17h12M10 21h7"
            strokeWidth="1.8"
            strokeLinecap="round"
            style={{ stroke: "var(--note-edge)", fill: "none" }}
          />
        </>
      )}
    </svg>
  );
}
