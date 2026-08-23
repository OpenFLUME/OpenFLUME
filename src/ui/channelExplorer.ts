/**
 * Channel formatting and search — the pure bits the Runs tab still needs.
 *
 * No React, no store: these operate on the channel inventory of ui/channels.ts
 * plus plain values, so they stay unit-testable headless.
 *
 *   - formatChannelValue / formatChannelDelta — unit-aware scalar formatting.
 *     Channels carrying a `rawUnit` (specific enthalpy in J/kg) are never
 *     converted, because they have no convertible QuantityKind; deltas pass
 *     through clampDisplayDelta so floating-point noise renders as "+0".
 *   - matchesQuery — the channel search predicate.
 *
 * This module used to hold the explorer's whole state policy — a pinned set, a
 * "primary" channel, follow-the-selection, chart composition. The plot model
 * (ui/resultPlots.ts) replaced all of it: a plot simply owns its channel list,
 * so there is no pinning to cap and no primary to derive.
 */

import type { UnitPreferences } from "./units";
import type { ChannelDescriptor } from "./channels";
import {
  clampDisplayDelta,
  formatSig,
  formatWithUnit,
  resolveScale,
} from "./format";

export function formatChannelValue(
  value: number,
  d: Pick<ChannelDescriptor, "quantity" | "rawUnit">,
  prefs?: Partial<UnitPreferences>,
  sigFigs = 4,
): string {
  if (typeof d.rawUnit === "string" && d.rawUnit.length > 0) {
    return `${formatSig(value, sigFigs)} ${d.rawUnit}`;
  }
  return formatWithUnit(value, d.quantity, prefs, sigFigs);
}

/**
 * Signed "current − baseline" delta text in the channel's display unit,
 * snapped to "+0" below display resolution / FP noise (clampDisplayDelta).
 * Offset units (°C/°F) are delta-safe: the display delta is exactly
 * factor·Δsi.  rawUnit channels delta in raw SI units.
 */
export function formatChannelDelta(
  current: number,
  baseline: number,
  d: Pick<ChannelDescriptor, "quantity" | "rawUnit">,
  prefs?: Partial<UnitPreferences>,
  sigFigs = 4,
): string {
  const sign = (v: number) => (v >= 0 ? "+" : "");
  if (typeof d.rawUnit === "string" && d.rawUnit.length > 0) {
    const delta = clampDisplayDelta(
      current - baseline,
      Math.max(Math.abs(current), Math.abs(baseline)),
      sigFigs,
    );
    return `${sign(delta)}${formatSig(delta, sigFigs)} ${d.rawUnit}`;
  }
  const scale = resolveScale(
    [current, baseline],
    d.quantity,
    prefs?.[d.quantity],
  );
  const cur = scale.convert(current);
  const base = scale.convert(baseline);
  const delta = clampDisplayDelta(
    cur - base,
    Math.max(Math.abs(cur), Math.abs(base)),
    sigFigs,
  );
  return `${sign(delta)}${formatSig(delta, sigFigs)} ${scale.unitLabel}`;
}

/* ------------------------------------------------------------------ */
/* Search                                                              */
/* ------------------------------------------------------------------ */

/**
 * Case-insensitive substring match over the channel label, element id, field
 * and entity kind.  Empty/whitespace queries match everything.
 */
export function matchesQuery(d: ChannelDescriptor, query: string): boolean {
  const q = (query ?? "").trim().toLowerCase();
  if (!q) return true;
  return (
    d.label.toLowerCase().includes(q) ||
    d.channel.id.toLowerCase().includes(q) ||
    d.elementLabel.toLowerCase().includes(q) ||
    String(d.channel.field).toLowerCase().includes(q) ||
    d.channel.entity.toLowerCase().includes(q)
  );
}
