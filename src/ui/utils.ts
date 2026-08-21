import type { NetworkConfig } from "../core";
import { decodeNetworkConfig } from "../core";
import {
  parseText,
  serializeText,
  type ParseError,
} from "../substrate/textProjection";
import { UnitPreferences, SI_PRESET } from "./units";

const STORAGE_KEY = "fluids-network-config-v1";
const UNITS_KEY = "fluids-network-units-v1";
const SIGFIGS_KEY = "fluids-network-sigfigs-v1";

export function saveToLocalStorage(config: NetworkConfig): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  } catch {
    // ignore quota errors
  }
}

export function loadFromLocalStorage(): NetworkConfig | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    // Boundary-decode the persisted config: malformed or wrong-version data
    // (hand edits, older/newer builds) hydrates as "nothing stored" instead
    // of crashing validation or the canvas later.
    return decodeNetworkConfig(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function saveUnitPreferences(prefs: UnitPreferences): void {
  try {
    localStorage.setItem(UNITS_KEY, JSON.stringify(prefs));
  } catch {
    // ignore quota errors
  }
}

export function loadUnitPreferences(): UnitPreferences | null {
  try {
    const raw = localStorage.getItem(UNITS_KEY);
    if (!raw) return null;
    // Merge over the SI defaults: prefs persisted by an older build may lack
    // quantity kinds added later (e.g. specificHeat) — they take the SI base
    // unit instead of surfacing as undefined selects.
    const stored = JSON.parse(raw) as Partial<UnitPreferences>;
    if (typeof stored !== "object" || stored === null) return null;
    return { ...SI_PRESET, ...stored };
  } catch {
    return null;
  }
}

export function getDefaultUnitPreferences(): UnitPreferences {
  return { ...SI_PRESET };
}

export function saveSigFigs(n: number): void {
  try {
    localStorage.setItem(SIGFIGS_KEY, String(n));
  } catch {
    // ignore quota errors
  }
}

export function loadSigFigs(): number | null {
  try {
    const raw = localStorage.getItem(SIGFIGS_KEY);
    if (!raw) return null;
    const n = parseInt(raw, 10);
    return n >= 3 && n <= 6 ? n : null;
  } catch {
    return null;
  }
}

/* --------------------------------------------------------------------------
 * Small persisted UI preferences (panels, sections). Failures are silent —
 * these are conveniences, never correctness.
 * ------------------------------------------------------------------------ */

const GLOBAL_MAP_KEY = "fluids-network-global-map-v1";

/** Global-map expanded preference; default = expanded (true). */
export function loadGlobalMapOpen(): boolean {
  try {
    return localStorage.getItem(GLOBAL_MAP_KEY) !== "0";
  } catch {
    return true;
  }
}

export function saveGlobalMapOpen(open: boolean): void {
  try {
    localStorage.setItem(GLOBAL_MAP_KEY, open ? "1" : "0");
  } catch {
    // ignore quota errors
  }
}

const SHOW_LABELS_KEY = "fluids-network-show-labels-v1";

/** Canvas name-label preference; default = shown (true). */
export function loadShowLabels(): boolean {
  try {
    return localStorage.getItem(SHOW_LABELS_KEY) !== "0";
  } catch {
    return true;
  }
}

export function saveShowLabels(show: boolean): void {
  try {
    localStorage.setItem(SHOW_LABELS_KEY, show ? "1" : "0");
  } catch {
    // ignore quota errors
  }
}

const CANVAS_VISIBILITY_KEY = "fluids-network-canvas-visibility-v1";

/**
 * Which element/connection kinds the canvas draws — a pure viewing filter,
 * never part of the model. Lets the user isolate one part of the system
 * (e.g. "just the thermal network", or "just radiation ties") without
 * touching the underlying config.
 */
export interface CanvasVisibility {
  fluidNodes: boolean;
  thermalNodes: boolean;
  fluidBranches: boolean;
  conduction: boolean;
  convection: boolean;
  radiation: boolean;
}

/** Default: everything shown — the toggle is opt-out, not opt-in. */
export const DEFAULT_CANVAS_VISIBILITY: CanvasVisibility = {
  fluidNodes: true,
  thermalNodes: true,
  fluidBranches: true,
  conduction: true,
  convection: true,
  radiation: true,
};

/** Canvas element/connection visibility preference; default = everything shown. */
export function loadCanvasVisibility(): CanvasVisibility {
  try {
    const raw = localStorage.getItem(CANVAS_VISIBILITY_KEY);
    if (!raw) return { ...DEFAULT_CANVAS_VISIBILITY };
    const stored = JSON.parse(raw) as Partial<CanvasVisibility>;
    if (typeof stored !== "object" || stored === null)
      return { ...DEFAULT_CANVAS_VISIBILITY };
    // Merge over the defaults: a preference persisted by an older build may
    // lack a kind added later, and that kind should stay shown rather than
    // surface as undefined (falsy).
    return { ...DEFAULT_CANVAS_VISIBILITY, ...stored };
  } catch {
    return { ...DEFAULT_CANVAS_VISIBILITY };
  }
}

export function saveCanvasVisibility(visibility: CanvasVisibility): void {
  try {
    localStorage.setItem(CANVAS_VISIBILITY_KEY, JSON.stringify(visibility));
  } catch {
    // ignore quota errors
  }
}

/** Filesystem-safe file name stem: keeps word chars/dots/dashes, collapses the rest. */
export function safeFilename(name: string): string {
  const cleaned = name
    .trim()
    .replace(/[^\w.-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return cleaned || "network";
}

/* --------------------------------------------------------------------------
 * Model files — the user-facing save format is the text projection
 * (src/substrate/textProjection.ts) with the `.fn` extension.
 * ------------------------------------------------------------------------ */

/** File extension for the canonical text-projection save format. */
export const MODEL_FILE_EXTENSION = ".fn";

/** Default download name: filesystem-safe stem from the network name + `.fn`. */
export function modelFileName(config: NetworkConfig): string {
  return `${safeFilename(config.meta.name)}${MODEL_FILE_EXTENSION}`;
}

/** Canonical file contents for a config (the text projection). */
export function serializeModelFile(config: NetworkConfig): string {
  return serializeText(config);
}

export function downloadModelText(
  config: NetworkConfig,
  filename?: string,
): void {
  const blob = new Blob([serializeModelFile(config)], {
    type: "text/plain;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename || modelFileName(config);
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * A `.fn` file whose text failed to parse/validate.  Carries the full
 * ParseError diagnostics; the message summarizes the first few with line
 * numbers where the parser attributed them.
 */
export class ModelFileParseError extends Error {
  readonly diagnostics: ParseError[];

  constructor(diagnostics: ParseError[]) {
    const shown = diagnostics.slice(0, 8);
    const lines = shown.map((d) =>
      d.line !== undefined ? `line ${d.line}: ${d.message}` : d.message,
    );
    if (diagnostics.length > shown.length)
      lines.push(`… and ${diagnostics.length - shown.length} more`);
    super(
      `invalid model file (${diagnostics.length} error${diagnostics.length === 1 ? "" : "s"}):\n${lines.join("\n")}`,
    );
    this.name = "ModelFileParseError";
    this.diagnostics = diagnostics;
  }
}

/**
 * Parse an uploaded model file (the `.fn` text projection).  Throws
 * ModelFileParseError for invalid text (with diagnostics).  Pure: on any
 * failure nothing is consumed or mutated, so a rejected file can never
 * replace the current network.
 */
export function parseModelFile(text: string): NetworkConfig {
  const result = parseText(text);
  if (result.config === undefined || result.errors.length > 0) {
    throw new ModelFileParseError(
      result.errors.length > 0
        ? result.errors
        : [{ message: "no config produced", severity: "error" }],
    );
  }
  return result.config;
}

export async function uploadModelFile(file: File): Promise<NetworkConfig> {
  return parseModelFile(await file.text());
}

export function createId(prefix: string, existing: Set<string>): string {
  let i = 1;
  while (existing.has(`${prefix}${i}`)) i++;
  return `${prefix}${i}`;
}

export function cloneConfig(config: NetworkConfig): NetworkConfig {
  return JSON.parse(JSON.stringify(config));
}

/** Axis-aligned rectangle in flow coordinates (blocked placement regions). */
export interface FlowRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * Pick a drop position for a new canvas element: start at `cx, cy` (usually
 * the viewport centre) and spiral outward until the spot does not overlap
 * any existing position or fall inside a blocked rect (floating canvas UI
 * such as the Global Map). Positions snap to the 15px canvas grid.
 */
export function findFreePosition(
  taken: Array<{ x: number; y: number }>,
  cx: number,
  cy: number,
  blocked: FlowRect[] = [],
): { x: number; y: number } {
  const SPACING = 110;
  const snap = (v: number) => Math.round(v / 15) * 15;
  const inBlocked = (x: number, y: number) =>
    blocked.some((r) => x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1);
  const collides = (x: number, y: number) =>
    inBlocked(x, y) ||
    taken.some((p) => Math.hypot(p.x - x, p.y - y) < SPACING * 0.9);
  if (!collides(cx, cy)) return { x: snap(cx), y: snap(cy) };
  for (let ring = 1; ring <= 12; ring++) {
    const steps = ring * 8;
    for (let i = 0; i < steps; i++) {
      const angle = (i / steps) * Math.PI * 2;
      const x = cx + Math.cos(angle) * SPACING * ring;
      const y = cy + Math.sin(angle) * SPACING * ring;
      if (!collides(x, y)) return { x: snap(x), y: snap(y) };
    }
  }
  return { x: snap(cx + SPACING * 13), y: snap(cy) };
}
