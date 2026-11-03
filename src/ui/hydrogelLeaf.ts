/**
 * Hydrogel "artificial leaf": interdigitated microchannels in agarose.
 *
 * Source: Koo, H.-J., Velev, O. D. (2017). Design and characterization of
 * hydrogel-based microfluidic devices with biomimetic solute transport
 * networks. Biomicrofluidics 11(2):024104. doi:10.1063/1.4978617
 * (open access, PMC5367088).
 *
 * The device: two source channels fed from an inlet header and three drain
 * channels collected by an outlet header, interdigitated in a 2 wt % agarose
 * gel.  The channels are not connected; liquid crosses from source to drain
 * by Darcy flow through the gel, which is what carries solute into the gel
 * (leaf venation / capillary-bed analogue).  The paper solves Brinkman flow
 * plus convection–diffusion in 2-D with COMSOL.
 *
 * What this lumped model reproduces: the FLOW through that network — how the
 * inflow at a fixed 7 kPa depends on channel length, and why it jumps when
 * the channel tips approach the opposite header.  It does not model solute
 * transport (no liquid species transport in OpenFLUME), so the paper's dye
 * coverage maps are out of scope.
 *
 * Parameters from the paper (§II): permeability k = 5.4e-16 m² (2 wt %
 * agarose), μ = 1e-3 Pa·s, inlet 7e3 Pa above the outlet, channel width
 * 500 µm, gap between adjacent channels 0.3 cm, active area 2 cm × 3 cm,
 * channel length L = 1.5–2.95 cm, channel height ~500 µm (experiments).
 *
 * Modelling choices (stated, not from the paper):
 *  - Geometry: source and drain combs grow from headers 3 cm apart, so a
 *    source and its neighbouring drain overlap over 2L − 3 cm and each tip
 *    is 3 − L cm from the opposite header.  This matches the paper's text
 *    (1.5 cm channels give negligible coverage; 2.95 cm tips come close to
 *    the collector) but is read from its Scheme 1, not tabulated.
 *  - Gel thickness = channel height = 500 µm (channels through the gel,
 *    sandwiched between glass).  Results are also reported per unit depth,
 *    which does not depend on this.
 *  - Lateral gel slab between neighbouring channel segments: 1-D Darcy,
 *    R = μ·gap / (k·Δy·H).
 *  - Tip leakage: each channel end treated as a cylinder of radius w/2
 *    touching the end, facing the opposite header as an equipotential wall,
 *    conductance per depth 2π·k / (μ·arccosh(d/r)), d = gap + r.  An
 *    approximation of the 2-D field near the tip.
 *  - Header and feed channels 500 × 500 µm; their geometry is not given and
 *    their resistance is ~1e-4 of the gel's, so it does not matter.
 * Darcy slabs are `dpTable` branches with a linear two-point table.
 */
import type { NetworkConfig } from "./types";

export const HYDROGEL_LEAF = {
  doi: "10.1063/1.4978617",
  /** Permeability of 2 wt % agarose [m²] (§II A). */
  permeability: 5.4e-16,
  viscosity: 1e-3,
  /** Inlet pressure above outlet [Pa] (§II A). */
  inletPressure: 7e3,
  channelWidth: 500e-6,
  /** Gap between adjacent channels [m] (§II A). */
  gap: 3e-3,
  /** Header-to-header span = active-area length [m]. */
  span: 0.03,
  /** Gel thickness = channel height [m] (experiments, §II B). */
  thickness: 500e-6,
  /** COMSOL inflow, linear channels, Table I: F_in [mol/(m·s)] at
   *  c_in = 5 mol/m³, i.e. per unit out-of-plane depth. */
  comsol: [
    { length: 0.015, fin: 1.0e-7 },
    { length: 0.025, fin: 6.0e-7 },
    { length: 0.0275, fin: 7.5e-7 },
    { length: 0.0295, fin: 10.4e-7 },
  ],
  inletConcentration: 5,
};

const P0 = 101325;
const RHO = 998;

/** Lateral Darcy resistance of a gel slab [Pa·s/m³]. */
export function gelSlabResistance(gap: number, faceArea: number): number {
  const c = HYDROGEL_LEAF;
  return (c.viscosity * gap) / (c.permeability * faceArea);
}

/** Tip-to-header leakage resistance [Pa·s/m³] (cylinder–wall estimate). */
export function tipResistance(tipGap: number): number {
  const c = HYDROGEL_LEAF;
  const r = c.channelWidth / 2;
  return (
    (c.viscosity * Math.acosh((tipGap + r) / r)) /
    (2 * Math.PI * c.permeability * c.thickness)
  );
}

/** Linear ΔP = R·Q as a two-point pressure-drop table (ṁ = ρQ). */
function darcy(R: number): NetworkConfig["branches"][number]["component"] {
  const m1 = 1e-9;
  return {
    type: "dpTable",
    points: [
      [0, 0],
      [m1, (R * m1) / RHO],
    ],
    extrapolate: "linear",
  };
}

/**
 * Build the interdigitated network for channel length L (needs L > span/2,
 * i.e. a non-zero overlap).  `segments` discretises the overlap of every
 * channel; `tips: false` drops the tip-leakage branches.
 */
export function buildHydrogelLeaf(
  length = 0.0275,
  options: { segments?: number; tips?: boolean } = {},
): NetworkConfig {
  const c = HYDROGEL_LEAF;
  const nSeg = options.segments ?? 5;
  const tips = options.tips ?? true;
  const overlap = 2 * length - c.span;
  if (!(overlap > 0))
    throw new Error("hydrogel leaf: channel length must exceed span / 2");
  const seg = overlap / nSeg;
  const pitch = c.gap + c.channelWidth;
  const W = c.channelWidth;

  // Columns across the leaf: drain, source, drain, source, drain.
  const columns = ["d0", "s0", "d1", "s1", "d2"];
  const colX = (id: string) => columns.indexOf(id);
  const PX_COL = 170;
  const PX_PER_M = 20000; // 3 cm span → 600 px
  const node = (
    id: string,
    col: number,
    yM: number,
    label?: string,
  ): NetworkConfig["nodes"][number] => ({
    id,
    type: "internal",
    x: 60 + col * PX_COL,
    y: 60 + yM * PX_PER_M,
    position: { x: col * pitch, y: 0 - yM, z: 0 }, // 0 − 0 = +0, not −0
    pressure: P0,
    temperature: 293,
    ...(label ? { label } : {}),
  });

  const nodes: NetworkConfig["nodes"] = [
    {
      id: "inlet",
      type: "boundary",
      x: 60 + 1 * PX_COL,
      y: 60 - 120,
      position: { x: pitch, y: 0.005, z: 0 },
      pressure: P0 + c.inletPressure,
      temperature: 293,
      label: "Inlet 7 kPa",
    },
    {
      id: "outlet",
      type: "boundary",
      x: 60 + 2 * PX_COL,
      y: 60 + c.span * PX_PER_M + 120,
      position: { x: 2 * pitch, y: -c.span - 0.005, z: 0 },
      pressure: P0,
      temperature: 293,
      label: "Outlet",
    },
    node("sh0", 1, 0, "Source header"),
    node("sh1", 3, 0),
    node("dh0", 0, c.span, "Drain header"),
    node("dh1", 2, c.span),
    node("dh2", 4, c.span),
  ];
  const branches: NetworkConfig["branches"] = [];
  const channel = (
    id: string,
    from: string,
    to: string,
    len: number,
    label?: string,
  ) =>
    branches.push({
      id,
      from,
      to,
      ...(label ? { label } : {}),
      component: { type: "rectChannel", width: W, height: W, length: len },
    });

  channel("feed", "inlet", "sh0", 0.005, "Inlet tube");
  channel("sourceHeader", "sh0", "sh1", 2 * pitch);
  channel("drainHeader01", "dh0", "dh1", 2 * pitch);
  channel("drainHeader12", "dh1", "dh2", 2 * pitch);
  channel("drain", "dh1", "outlet", 0.005, "Outlet tube");

  // Each channel: a lead from its header to the overlap, then nSeg overlap
  // segments, one node at the centre of each.  Source channels hang from
  // y = 0, drain channels rise from y = span.
  const yOf = (id: string, i: number) =>
    id.startsWith("s")
      ? c.span - length + seg * (i + 0.5)
      : length - seg * (i + 0.5);
  for (const id of columns) {
    const header = id.startsWith("s") ? `sh${id[1]}` : `dh${id[1]}`;
    for (let i = 0; i < nSeg; i++)
      nodes.push(node(`${id}_${i}`, colX(id), yOf(id, i)));
    channel(
      `${id}_lead`,
      header,
      `${id}_0`,
      c.span - length + seg / 2,
      id.startsWith("s") ? "Source channel" : "Drain channel",
    );
    for (let i = 1; i < nSeg; i++)
      channel(`${id}_c${i}`, `${id}_${i - 1}`, `${id}_${i}`, seg);
  }

  // Lateral gel slabs between each source and its neighbouring drains; drain
  // node nSeg−1−i sits at the height of source node i.
  const neighbours: Array<[string, string]> = [
    ["s0", "d0"],
    ["s0", "d1"],
    ["s1", "d1"],
    ["s1", "d2"],
  ];
  const Rslab = gelSlabResistance(c.gap, seg * c.thickness);
  for (const [s, d] of neighbours)
    for (let i = 0; i < nSeg; i++)
      branches.push({
        id: `gel_${s}_${d}_${i}`,
        from: `${s}_${i}`,
        to: `${d}_${nSeg - 1 - i}`,
        ...(i === 0 ? { label: "Gel slab (Darcy)" } : {}),
        component: darcy(Rslab),
      });

  if (tips) {
    // Source tips leak into the drain header; the source header leaks into
    // drain tips.  Branches point along the flow.
    const Rtip = tipResistance(c.span - length);
    const tip = (id: string, from: string, to: string, label?: string) =>
      branches.push({
        id,
        from,
        to,
        ...(label ? { label } : {}),
        component: darcy(Rtip),
      });
    const end = (ch: string) => `${ch}_${nSeg - 1}`;
    tip("tip_s0", end("s0"), "dh0", "Tip leakage");
    tip("tip_s1", end("s1"), "dh2");
    tip("tip_d0", "sh0", end("d0"));
    tip("tip_d1", "sh0", end("d1"));
    tip("tip_d2", "sh1", end("d2"));
  }

  return {
    meta: {
      name: "Hydrogel leaf (interdigitated microchannels in agarose)",
      version: 2,
    },
    settings: { mode: "steady", tolerance: 1e-9, maxIterations: 200 },
    fluid: { model: "incompressible", preset: "water" },
    nodes,
    branches,
  };
}

export const hydrogelLeaf: NetworkConfig = buildHydrogelLeaf();
