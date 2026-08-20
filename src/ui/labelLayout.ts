/**
 * labelLayout.ts — screen-space declutter for canvas text.
 *
 * Canvas labels are screen-size invariant (counter-scaled, see zoomTiers.ts),
 * so at low zoom dense models stack chips on top of each other. This module
 * runs ONE deterministic layout pass per frame over all visible labels:
 *
 *   1. Aggregation — identical adjacent labels (same kind + text) collapse
 *      into the first survivor shown as `Name ×N`.
 *   2. Overlap culling — greedy reading-order (top→bottom, left→right)
 *      AABB rejection; selected/hovered labels always win.
 *
 * The result is consumed through React context so pan/zoom updates don't
 * rebuild React Flow node/edge objects.
 */
import React from "react";

export interface LabelItem {
  id: string;
  /** Screen-space center of the label (px). */
  x: number;
  y: number;
  /** Label text (chip content without readouts). */
  text: string;
  kind: "edge" | "node";
  /** Selected/hovered elements are never culled and claim space first. */
  alwaysShow?: boolean;
}

export interface LabelLayout {
  /** Ids whose label should not render this frame. */
  hidden: Set<string>;
  /** Display-text override (aggregation `Name ×N`) for surviving labels. */
  text: Map<string, string>;
}

export const EMPTY_LAYOUT: LabelLayout = { hidden: new Set(), text: new Map() };

/* Estimated chip box (screen px). Chips are ~11px text with horizontal
   padding; node names are bare text. Heights share the same band so a node
   name and an edge chip on the same line still collide. */
const EDGE_CHAR_W = 6.4;
const EDGE_PAD_W = 16; // chip padding + border (no icon — symbols live on the run)
const EDGE_H = 20;
const NODE_CHAR_W = 6.6;
const NODE_PAD_W = 6;
const NODE_H = 15;

interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;
}

function rectFor(item: LabelItem, text: string): Rect {
  const w =
    item.kind === "edge"
      ? text.length * EDGE_CHAR_W + EDGE_PAD_W
      : text.length * NODE_CHAR_W + NODE_PAD_W;
  const h = item.kind === "edge" ? EDGE_H : NODE_H;
  return {
    x0: item.x - w / 2,
    y0: item.y - h / 2,
    x1: item.x + w / 2,
    y1: item.y + h / 2,
  };
}

/**
 * Layout pass. `aggregate` enables the `Name ×N` collapse of identical
 * labels (used below the full-detail zoom tier, where per-edge readouts are
 * not shown anyway).
 */
export function layoutLabels(
  items: LabelItem[],
  opts: { aggregate?: boolean } = {},
): LabelLayout {
  const hidden = new Set<string>();
  const text = new Map<string, string>();

  // ── 1. Aggregate identical labels (deterministic: lowest id survives) ──
  let working = items;
  if (opts.aggregate) {
    const groups = new Map<string, LabelItem[]>();
    for (const item of items) {
      const key = `${item.kind}${item.text}`;
      const g = groups.get(key);
      if (g) g.push(item);
      else groups.set(key, [item]);
    }
    const survivors: LabelItem[] = [];
    for (const g of groups.values()) {
      if (g.length === 1) {
        survivors.push(g[0]);
        continue;
      }
      const sorted = [...g].sort(
        (a, b) => a.x - b.x || a.id.localeCompare(b.id),
      );
      const rep = sorted[0];
      // Representative sits at the run's centroid so `Name ×N` reads as a band.
      const cx = g.reduce((s, it) => s + it.x, 0) / g.length;
      const cy = g.reduce((s, it) => s + it.y, 0) / g.length;
      survivors.push({
        ...rep,
        x: cx,
        y: cy,
        alwaysShow: g.some((it) => it.alwaysShow),
      });
      for (const rest of sorted.slice(1)) hidden.add(rest.id);
      text.set(rep.id, `${rep.text} ×${g.length}`);
    }
    working = survivors;
  }

  // ── 2. Greedy overlap culling (alwaysShow first, then reading order) ──
  const ordered = [...working].sort((a, b) => {
    const pa = a.alwaysShow ? 0 : 1;
    const pb = b.alwaysShow ? 0 : 1;
    if (pa !== pb) return pa - pb;
    return a.y - b.y || a.x - b.x || a.id.localeCompare(b.id);
  });
  const placed: Rect[] = [];
  for (const item of ordered) {
    if (hidden.has(item.id)) continue;
    const label = text.get(item.id) ?? item.text;
    const r = rectFor(item, label);
    if (item.alwaysShow || !placed.some((p) => overlaps(p, r))) {
      placed.push(r);
    } else {
      hidden.add(item.id);
    }
  }

  return { hidden, text };
}

/** Shared per-frame layout; FlowCanvas provides, node/edge components consume. */
export const LabelLayoutContext =
  React.createContext<LabelLayout>(EMPTY_LAYOUT);
