/**
 * Canvas coloring: map ONE published quantity across the whole network onto
 * a color ramp, plus the legend domain arithmetic that goes with it.
 *
 * The set of colorable quantities is not maintained here — it is the channel
 * field registry (ui/channels.ts), so anything the solver publishes and the
 * Results tab can plot can also paint the diagram, with the same label,
 * unit kind and sign convention.  `ColorBy` is therefore a field NAME
 * (applied to whichever entity kinds carry that field: 'temperature' colors
 * fluid and solid nodes alike, 'heatFlux' colors conductors), and values are
 * read through resolveChannelAt so the schema layout, mode handling and
 * non-finite policy stay in one place.
 */
import { NetworkConfig, SteadyResult, TransientResult } from "./types";
import { QuantityKind } from "./units";
import { resolveFluidSpec } from "../core";
import { siNumber } from "./format";
import { arrayMin, arrayMax } from "./arrayMinMax";
import {
  channelFieldInfo,
  listChannelFields,
  makeChannelId,
  resolveChannelAt,
  type ChannelEntityKind,
  type ChannelField,
  type ChannelFieldInfo,
} from "./channels";

/** 'none', or the name of a channel field to paint across the network. */
export type ColorBy = "none" | ChannelField;

/**
 * The quantities offered by the canvas "Color by" picker, in registry order.
 * Transient-only quantities are included: a steady result simply has no
 * values for them and the diagram greys out, exactly as for any element that
 * lacks the selected quantity.
 */
export function colorByOptions(): ChannelFieldInfo[] {
  return listChannelFields();
}

const ENTITY_GROUP_LABEL: Record<ChannelEntityKind, string> = {
  node: "Fluid nodes",
  branch: "Branches",
  solidNode: "Solid nodes",
  conductor: "Conductors",
};

/**
 * colorByOptions grouped for a picker, under the element kind that carries
 * each quantity.  A field several kinds share (temperature, on fluid and
 * solid nodes) is listed once under the first of them, since selecting it
 * colors every element that has it regardless of kind.
 */
export function colorByGroups(): Array<{
  label: string;
  options: ChannelFieldInfo[];
}> {
  const groups = new Map<ChannelEntityKind, ChannelFieldInfo[]>();
  for (const info of colorByOptions()) {
    const entity = info.entities[0];
    const existing = groups.get(entity);
    if (existing) existing.push(info);
    else groups.set(entity, [info]);
  }
  return Array.from(groups, ([entity, options]) => ({
    label: ENTITY_GROUP_LABEL[entity],
    options,
  }));
}

/** User-pinned [min, max] legend domain (SI units) per `ColorBy` kind, overriding the auto-computed one. */
export type ColorDomainOverrides = Partial<Record<ColorBy, [number, number]>>;

export interface ColorData {
  nodeValues: Record<string, number | undefined>;
  branchValues: Record<string, number | undefined>;
  solidValues: Record<string, number | undefined>;
  conductorValues: Record<string, number | undefined>;
  domain: [number, number];
  /**
   * The un-overridden [min, max] across every value currently feeding the
   * ramp — "the entire range of this quantity in the model" right now,
   * regardless of any pinned `domain`. This is the fixed reference frame
   * the legend scroller drags within: `domain` picks a sub-range of it.
   */
  naturalDomain: [number, number];
  unitKind: QuantityKind;
  /** Display name of the coloured quantity (legend title); '' for 'none'. */
  label: string;
  /** True when at least one finite value feeds the ramp. */
  hasData: boolean;
  /** True for signed quantities (mass flow, heat rate): diverging ramp anchored at 0. */
  signed: boolean;
  /** Where the values came from: solver results vs. initial/config values. */
  dataMode: "none" | "initial" | "results";
  /** True when `domain` is a user-pinned override rather than auto-computed from data. */
  domainIsOverride: boolean;
}

/** 5-stop perceptual ramp for unsigned quantities (cyan → pale → orange → red).
 *  The cold stop is `--accent` (#197cb4) so color-by pressure/temperature
 *  starts in the same family as the fluid network. */
const UNSIGNED_STOPS: Array<[number, number, number]> = [
  [0x19, 0x7c, 0xb4], // #197cb4
  [0x62, 0xc2, 0xd2], // #62c2d2
  [0xff, 0xff, 0xbf], // #ffffbf
  [0xfd, 0xae, 0x61], // #fdae61
  [0xd7, 0x19, 0x1c], // #d7191c
];

/** Diverging cyan–white–orange ramp for signed quantities (anchored at 0). */
const SIGNED_LO: [number, number, number] = [0x16, 0x63, 0x8c]; // #16638c
const SIGNED_MID: [number, number, number] = [0xf7, 0xf7, 0xf7]; // #f7f7f7
const SIGNED_HI: [number, number, number] = [0xe0, 0x82, 0x14]; // #e08214

export const RAMP_MUTED = "#6b7280";

function lerpStops(stops: Array<[number, number, number]>, t: number): string {
  const x = Math.max(0, Math.min(1, t)) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(x));
  const f = x - i;
  const [a, b] = [stops[i], stops[i + 1]];
  const r = Math.round(a[0] + (b[0] - a[0]) * f);
  const g = Math.round(a[1] + (b[1] - a[1]) * f);
  const bl = Math.round(a[2] + (b[2] - a[2]) * f);
  return `rgb(${r}, ${g}, ${bl})`;
}

function lerp3(
  a: [number, number, number],
  b: [number, number, number],
  t: number,
): string {
  return lerpStops([a, b], t);
}

/**
 * Map a value to a display color. Unsigned quantities use the 5-stop
 * perceptual ramp over [min, max]; signed quantities use a diverging
 * cyan–white–orange ramp anchored at 0 over [-m, +m], m = max|domain|.
 * Degenerate domains return the mid stop.
 */
export function colorForValue(
  value: number | undefined,
  domain: [number, number],
  signed = false,
): string {
  if (value === undefined || !Number.isFinite(value)) return RAMP_MUTED;
  const [min, max] = domain;
  if (signed) {
    const m = Math.max(Math.abs(min), Math.abs(max));
    if (m === 0) return lerp3(SIGNED_MID, SIGNED_MID, 0);
    const t = Math.max(-1, Math.min(1, value / m));
    return t >= 0
      ? lerp3(SIGNED_MID, SIGNED_HI, t)
      : lerp3(SIGNED_MID, SIGNED_LO, -t);
  }
  if (min === max) {
    return lerpStops(UNSIGNED_STOPS, 0.5);
  }
  const t = Math.max(0, Math.min(1, (value - min) / (max - min)));
  return lerpStops(UNSIGNED_STOPS, t);
}

/** Fraction (0..1 along the track) → value within `bounds`, clamped. */
export function sliderValueFromFraction(
  bounds: [number, number],
  frac: number,
): number {
  const [lo, hi] = bounds;
  const clamped = Math.max(0, Math.min(1, frac));
  return lo + clamped * (hi - lo);
}

/**
 * Move one edge of a domain to `value`. Unlike the text inputs (which
 * reject an edit that would invert or collapse the range), a slider drag
 * clamps against the other handle instead — you simply can't drag past it.
 */
export function moveSliderEdge(
  domain: [number, number],
  edge: "min" | "max",
  value: number,
): [number, number] {
  const [min, max] = domain;
  const gap = Math.max((max - min) * 0.02, 1e-9);
  return edge === "min"
    ? [Math.min(value, max - gap), max]
    : [min, Math.max(value, min + gap)];
}

/** CSS gradient stops for the legend bar (must match colorForValue). */
export function rampGradientStops(signed: boolean): string {
  if (signed) {
    return `rgb(${SIGNED_LO.join(",")}) 0%, rgb(${SIGNED_MID.join(",")}) 50%, rgb(${SIGNED_HI.join(",")}) 100%`;
  }
  return UNSIGNED_STOPS.map(
    (s, i) => `rgb(${s.join(",")}) ${(i / (UNSIGNED_STOPS.length - 1)) * 100}%`,
  ).join(", ");
}

/**
 * The flat colors at the very ends of the ramp — what `colorForValue`
 * clamps EVERY out-of-domain value to (below min → `lo`, above max →
 * `hi`). The legend scroller paints these as solid dead zones outside the
 * pinned handles so it's visually obvious that values out there don't get
 * their own shade, they're just pegged to the extreme.
 */
export function rampEndColors(signed: boolean): [lo: string, hi: string] {
  if (signed)
    return [`rgb(${SIGNED_LO.join(",")})`, `rgb(${SIGNED_HI.join(",")})`];
  const lo = UNSIGNED_STOPS[0];
  const hi = UNSIGNED_STOPS[UNSIGNED_STOPS.length - 1];
  return [`rgb(${lo.join(",")})`, `rgb(${hi.join(",")})`];
}

/**
 * Canvas element fill: data-driven when coloring is active and a value
 * exists, muted when coloring is active but this element has no value,
 * `base` (type color) otherwise. Selection never touches fill — the ring
 * communicates it.
 */
export function fillForCanvas(opts: {
  colorBy?: string;
  colorValue?: number;
  domain?: [number, number];
  signed?: boolean;
  base: string;
}): string {
  const { colorBy, colorValue, domain, signed, base } = opts;
  if (!colorBy || colorBy === "none") return base;
  if (colorValue !== undefined && domain)
    return colorForValue(colorValue, domain, signed);
  return RAMP_MUTED;
}

export interface Snapshot {
  nodes: Record<
    string,
    { pressure?: number; temperature?: number; density?: number }
  >;
  branches: Record<
    string,
    { mdot?: number; dP?: number; velocity?: number; reynolds?: number }
  >;
  solidNodes: Record<string, { temperature?: number }>;
  conductors: Record<string, { heatRate?: number }>;
}

function computeEditingDensity(
  config: NetworkConfig,
  node: NetworkConfig["nodes"][number],
): number | undefined {
  const fluid = resolveFluidSpec(config, node);
  const p = siNumber(node.pressure);
  const T = siNumber(node.temperature);
  if (p === undefined || T === undefined || T <= 0) return undefined;
  if (fluid.model === "incompressible") {
    const rho = fluid.params?.rho;
    if (typeof rho === "number") return rho;
    if (fluid.preset === "water") return 1000;
    return undefined;
  }
  if (fluid.model === "idealGas") {
    const R = fluid.params?.R;
    if (typeof R === "number") return p / (R * T);
    if (fluid.preset === "air") return p / (287 * T);
    return undefined;
  }
  return undefined;
}

function isTransientResult(
  r: SteadyResult | TransientResult | null,
): r is TransientResult {
  return !!r && "times" in r && Array.isArray(r.times);
}

/**
 * Quantities whose natural domain is wider than the data: vapor quality is
 * physically [0, 1] (liquid → vapor) and the wetted / front fractions the
 * same, so a handful of two-phase elements must not be stretched across the
 * whole ramp.  The domain still expands if a value falls outside.
 */
const FRACTION_FIELDS = new Set<string>(["quality", "fWet", "fluidFront"]);

function finalizeColorData(
  nodeValues: Record<string, number | undefined>,
  branchValues: Record<string, number | undefined>,
  solidValues: Record<string, number | undefined>,
  conductorValues: Record<string, number | undefined>,
  colorBy: ColorBy,
  dataMode: ColorData["dataMode"],
  domainOverride?: [number, number],
): ColorData {
  const allValues = [
    ...Object.values(nodeValues),
    ...Object.values(branchValues),
    ...Object.values(solidValues),
    ...Object.values(conductorValues),
  ].filter((v): v is number => v !== undefined && Number.isFinite(v));

  let naturalDomain: [number, number];
  if (allValues.length === 0) {
    naturalDomain = [0, 0];
  } else if (FRACTION_FIELDS.has(colorBy)) {
    naturalDomain = [
      Math.min(0, arrayMin(allValues)),
      Math.max(1, arrayMax(allValues)),
    ];
  } else {
    const min = arrayMin(allValues);
    const max = arrayMax(allValues);
    naturalDomain = min === max ? [min - 1, max + 1] : [min, max];
  }

  const domainIsOverride =
    !!domainOverride && domainOverride[0] < domainOverride[1];
  const domain: [number, number] = domainIsOverride
    ? domainOverride!
    : naturalDomain;

  const info = colorBy === "none" ? undefined : channelFieldInfo(colorBy);

  return {
    nodeValues,
    branchValues,
    solidValues,
    conductorValues,
    domain,
    naturalDomain,
    unitKind: info?.quantity ?? "pressure",
    label: info?.label ?? "",
    hasData: allValues.length > 0,
    signed: info?.signed ?? false,
    dataMode: allValues.length > 0 ? dataMode : "none",
    domainIsOverride,
  };
}

/**
 * The quantities that can be shown BEFORE a solve, straight from the model's
 * initial/boundary values.  Everything else is a solver output and simply
 * has no pre-run value to paint.
 */
function editingNodeValue(
  config: NetworkConfig,
  node: NetworkConfig["nodes"][number],
  colorBy: ColorBy,
): number | undefined {
  switch (colorBy) {
    case "pressure":
      return siNumber(node.pressure);
    case "temperature":
      return siNumber(node.temperature);
    case "density":
      return computeEditingDensity(config, node);
    case "quality":
      return node.quality;
    default:
      return undefined;
  }
}

export function resolveColorData(
  config: NetworkConfig,
  result: SteadyResult | TransientResult | null,
  liveResult: TransientResult | null,
  runStatus: string,
  colorBy: ColorBy,
  timeIndex: number | null,
  resultStale: boolean,
  domainOverride?: [number, number],
): ColorData {
  const nodeValues: Record<string, number | undefined> = {};
  const branchValues: Record<string, number | undefined> = {};
  const solidValues: Record<string, number | undefined> = {};
  const conductorValues: Record<string, number | undefined> = {};

  if (colorBy === "none") {
    return finalizeColorData(
      nodeValues,
      branchValues,
      solidValues,
      conductorValues,
      colorBy,
      "none",
    );
  }

  const isRunning = runStatus === "running" || runStatus === "loadingFluids";
  const hasResult = !!result || (!!liveResult && isRunning);
  const isEditing = !hasResult || resultStale;

  if (isEditing) {
    for (const n of config.nodes)
      nodeValues[n.id] = editingNodeValue(config, n, colorBy);
    if (colorBy === "temperature") {
      for (const s of config.solidNodes ?? [])
        solidValues[s.id] = siNumber(s.temperature);
    }
    return finalizeColorData(
      nodeValues,
      branchValues,
      solidValues,
      conductorValues,
      colorBy,
      "initial",
      domainOverride,
    );
  }

  const source: SteadyResult | TransientResult | null = isRunning
    ? liveResult
    : result && (isTransientResult(result) || "iterations" in result)
      ? result
      : null;
  if (!source || (isTransientResult(source) && source.times.length === 0)) {
    return finalizeColorData(
      nodeValues,
      branchValues,
      solidValues,
      conductorValues,
      colorBy,
      "none",
      domainOverride,
    );
  }

  // makeChannelId rejects a field the entity cannot carry (branch
  // 'pressure', node 'mach'), and an element with no value is left unset so
  // it paints muted — including when a side table revisits ids already
  // collected from the main one.
  const collect = (
    entity: ChannelEntityKind,
    table: Record<string, unknown> | undefined,
    into: Record<string, number | undefined>,
  ) => {
    for (const id of Object.keys(table ?? {})) {
      const channel = makeChannelId(entity, id, colorBy);
      if (!channel) return;
      const value = resolveChannelAt(source, channel, timeIndex);
      if (value !== null) into[id] = value;
    }
  };
  collect("node", source.nodes, nodeValues);
  collect("branch", source.branches, branchValues);
  collect("solidNode", source.solidNodes, solidValues);
  collect("conductor", source.conductors, conductorValues);
  if (isTransientResult(source)) {
    collect("node", source.fluidFront, nodeValues);
    collect("conductor", source.ttWf, conductorValues);
  }

  return finalizeColorData(
    nodeValues,
    branchValues,
    solidValues,
    conductorValues,
    colorBy,
    "results",
    domainOverride,
  );
}

export function resolveSnapshot(
  config: NetworkConfig,
  result: SteadyResult | TransientResult | null,
  liveResult: TransientResult | null,
  runStatus: string,
  timeIndex: number | null,
): Snapshot {
  const snapshot: Snapshot = {
    nodes: {},
    branches: {},
    solidNodes: {},
    conductors: {},
  };

  for (const n of config.nodes) snapshot.nodes[n.id] = {};
  for (const b of config.branches) snapshot.branches[b.id] = {};
  for (const s of config.solidNodes ?? []) snapshot.solidNodes[s.id] = {};
  for (const c of config.conductors ?? []) snapshot.conductors[c.id] = {};

  const isRunning = runStatus === "running" || runStatus === "loadingFluids";

  if (!result && !liveResult) return snapshot;

  // Steady
  if (result && "iterations" in result && !isTransientResult(result)) {
    for (const [id, n] of Object.entries(result.nodes)) {
      snapshot.nodes[id] = {
        pressure: n.pressure,
        temperature: n.temperature,
        density: n.density,
      };
    }
    for (const [id, b] of Object.entries(result.branches)) {
      snapshot.branches[id] = {
        mdot: b.mdot,
        dP: b.dP,
        velocity: b.velocity,
        reynolds: b.reynolds,
      };
    }
    if (result.solidNodes) {
      for (const [id, s] of Object.entries(result.solidNodes)) {
        snapshot.solidNodes[id] = { temperature: s.temperature };
      }
    }
    if (result.conductors) {
      for (const [id, c] of Object.entries(result.conductors)) {
        snapshot.conductors[id] = { heatRate: c.heatRate };
      }
    }
    return snapshot;
  }

  // Transient
  let transient: TransientResult | null = null;
  if (isRunning) {
    transient = liveResult;
  } else if (isTransientResult(result)) {
    transient = result;
  }
  if (transient && transient.times.length > 0) {
    const idx = timeIndex ?? transient.times.length - 1;
    const safeIdx = Math.max(0, Math.min(transient.times.length - 1, idx));
    for (const [id, n] of Object.entries(transient.nodes)) {
      snapshot.nodes[id] = {
        pressure: n.pressure[safeIdx],
        temperature: n.temperature[safeIdx],
        density: n.density[safeIdx],
      };
    }
    for (const [id, b] of Object.entries(transient.branches)) {
      snapshot.branches[id] = { mdot: b.mdot[safeIdx] };
    }
    if (transient.solidNodes) {
      for (const [id, s] of Object.entries(transient.solidNodes)) {
        snapshot.solidNodes[id] = { temperature: s.temperature[safeIdx] };
      }
    }
    if (transient.conductors) {
      for (const [id, c] of Object.entries(transient.conductors)) {
        snapshot.conductors[id] = { heatRate: c.heatRate[safeIdx] };
      }
    }
  }

  return snapshot;
}
