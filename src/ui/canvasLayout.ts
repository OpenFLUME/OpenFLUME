/**
 * canvasLayout — PRESENTATION-ONLY canvas coordinate normalization.
 *
 * Older shipped models stored physical axial stations (metres) in canvas
 * `node.x`. As canvas positions those values rendered every node within a
 * few dozen pixels. Current builders keep physical stations on
 * `position.x` and write a readable canvas pitch (typically 170 px).
 *
 * The solver never reads canvas `x`/`y`. When a loaded file still has a
 * sub-readable x-span this helper stretches columns to a readable pitch.
 * Idempotent: once the span is readable the config passes through unchanged.
 */
import { NetworkConfig } from "./types";
import {
  fluidNodeSize,
  GROUP_HEIGHT,
  GROUP_WIDTH,
  snapPointToGrid,
  snapOriginToGrid,
  SOLID_NODE_SIZE,
} from "./canvasGeometry";

/** Below this x-span (px) a loaded model is considered physically-scaled. */
const MIN_READABLE_SPAN = 240;
/** Target horizontal pitch between adjacent coordinate columns. */
const COLUMN_PITCH = 170;

export function normalizeCanvasLayout(cfg: NetworkConfig): NetworkConfig {
  const positioned = [...cfg.nodes, ...(cfg.solidNodes ?? [])];
  const uniqX = [...new Set(positioned.map((n) => n.x))].sort((a, b) => a - b);
  const span = uniqX.length >= 2 ? uniqX[uniqX.length - 1] - uniqX[0] : 0;
  const k =
    Number.isFinite(span) && span > 0 && span < MIN_READABLE_SPAN
      ? COLUMN_PITCH / (span / (uniqX.length - 1))
      : 1;
  const stretch = k > 1.5;
  const x0 = uniqX[0] ?? 0;
  const mapX = (x: number) => (stretch ? x0 + (x - x0) * k : x);

  const nodes = cfg.nodes.map((node) => {
    const size = fluidNodeSize(node.type);
    const position = snapOriginToGrid(
      { x: mapX(node.x), y: node.y },
      size,
      size,
    );
    return position.x === node.x && position.y === node.y
      ? node
      : { ...node, ...position };
  });
  const solidNodes = (cfg.solidNodes ?? []).map((node) => {
    const position = snapOriginToGrid(
      { x: mapX(node.x), y: node.y },
      SOLID_NODE_SIZE,
      SOLID_NODE_SIZE,
    );
    return position.x === node.x && position.y === node.y
      ? node
      : { ...node, ...position };
  });
  const groups = (cfg.groups ?? []).map((group) => {
    const position = snapOriginToGrid(group, GROUP_WIDTH, GROUP_HEIGHT);
    return position.x === group.x && position.y === group.y
      ? group
      : { ...group, ...position };
  });
  // Notes ride the same x stretch as the nodes: an annotation that stays put
  // while the network spreads out would end up pointing at the wrong element.
  const notes = (cfg.notes ?? []).map((note) => {
    const position = snapPointToGrid({ x: mapX(note.x), y: note.y });
    return position.x === note.x && position.y === note.y
      ? note
      : { ...note, ...position };
  });
  const changed =
    nodes.some((node, index) => node !== cfg.nodes[index]) ||
    solidNodes.some((node, index) => node !== cfg.solidNodes?.[index]) ||
    groups.some((group, index) => group !== cfg.groups?.[index]) ||
    notes.some((note, index) => note !== cfg.notes?.[index]);
  if (!changed) return cfg;
  return {
    ...cfg,
    nodes,
    ...(cfg.solidNodes ? { solidNodes } : {}),
    ...(cfg.groups ? { groups } : {}),
    ...(cfg.notes ? { notes } : {}),
  };
}
