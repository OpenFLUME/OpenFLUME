import { NetworkConfig } from "./types";
import { extensionAdvancedExample } from "./extensionAdvancedExample";
import { lh2StorageTankNoVentFill } from "./lh2StorageTank";
import { thrusterCombustor } from "./thrusterCombustor";
import { thrusterCombustorTransient } from "./thrusterCombustorTransient";
import { CANVAS_GRID_SIZE } from "./canvasGeometry";
import { arrayMin, arrayMax } from "./arrayMinMax";

export {
  extensionAdvancedExample,
  lh2StorageTankNoVentFill,
  thrusterCombustor,
  thrusterCombustorTransient,
};

/** Physical coordinates [m], z-up. Canvas `x`/`y` on the node stay schematic pixels. */
const metres = (x: number, y = 0, z = 0) => ({ x, y, z });

export const threePipeJunction: NetworkConfig = {
  meta: { name: "Three-pipe junction", version: 2 },
  settings: {
    mode: "steady",
    tolerance: 1e-9,
    maxIterations: 500,
    relaxation: 0.9,
  },
  fluid: { model: "incompressible", preset: "water" },
  nodes: [
    {
      id: "in",
      type: "boundary",
      x: 0,
      y: 0,
      position: metres(0),
      pressure: 300000,
      temperature: 300,
      label: "Inlet",
    },
    {
      id: "j",
      type: "internal",
      x: 200,
      y: 0,
      position: metres(2),
      pressure: 250000,
      temperature: 300,
      label: "Junction",
    },
    {
      id: "out1",
      type: "boundary",
      x: 400,
      y: 100,
      position: metres(2, 3),
      pressure: 200000,
      temperature: 300,
      label: "Out 1",
    },
    {
      id: "out2",
      type: "boundary",
      x: 400,
      y: -100,
      position: metres(2, -4),
      pressure: 150000,
      temperature: 300,
      label: "Out 2",
    },
  ],
  branches: [
    {
      id: "b1",
      from: "in",
      to: "j",
      component: { type: "pipe", length: 2, diameter: 0.03, roughness: 1e-5 },
      label: "Pipe 1",
    },
    {
      id: "b2",
      from: "j",
      to: "out1",
      component: { type: "pipe", length: 3, diameter: 0.02, roughness: 1e-5 },
      label: "Pipe 2",
    },
    {
      id: "b3",
      from: "j",
      to: "out2",
      component: { type: "pipe", length: 4, diameter: 0.015, roughness: 1e-5 },
      label: "Pipe 3",
    },
  ],
};

export const tankBlowdown: NetworkConfig = {
  meta: { name: "Tank blowdown", version: 2 },
  settings: {
    mode: "transient",
    dt: 0.01,
    endTime: 5.0,
    tolerance: 1e-6,
    maxIterations: 200,
    relaxation: 0.9,
  },
  fluid: { model: "idealGas", preset: "air" },
  nodes: [
    {
      id: "tank",
      type: "internal",
      x: 0,
      y: 0,
      position: metres(0),
      pressure: 500000,
      temperature: 300,
      volume: 0.1,
      label: "Tank",
    },
    {
      id: "ambient",
      type: "boundary",
      x: 300,
      y: 0,
      position: metres(1),
      pressure: 101325,
      temperature: 300,
      label: "Ambient",
    },
  ],
  branches: [
    {
      id: "orifice",
      from: "tank",
      to: "ambient",
      component: { type: "orifice", area: 0.0001, cd: 0.6 },
      label: "Orifice",
    },
  ],
};

export const waterDistributionNetwork: NetworkConfig = {
  meta: { name: "Water distribution network", version: 2 },
  settings: {
    mode: "steady",
    tolerance: 1e-8,
    maxIterations: 500,
    relaxation: 0.8,
  },
  fluid: { model: "incompressible", preset: "water" },
  // Physical layout: every node-to-node chord is <= the connecting pipe's
  // length (slack means a routed pipe), and z steps match each pipe's
  // elevationChange.  The compact zero-length components (pump, valves) get
  // a short stand-off instead of coincident endpoints.  The discharge drops
  // are drawn as pure vertical runs of exactly their elevationChange.
  nodes: [
    {
      id: "SRC",
      type: "boundary",
      x: 0,
      y: 0,
      position: metres(0),
      pressure: 200_000,
      temperature: 300,
      label: "Supply",
    },
    {
      id: "N0",
      type: "internal",
      x: 150,
      y: 0,
      position: metres(0.5),
      pressure: 400_000,
      temperature: 300,
      label: "Pump out",
    },
    {
      id: "N1",
      type: "internal",
      x: 300,
      y: 0,
      position: metres(5.5),
      pressure: 350_000,
      temperature: 300,
      label: "Header",
    },
    {
      id: "N2",
      type: "internal",
      x: 450,
      y: 120,
      position: metres(12, 3, 3),
      pressure: 300_000,
      temperature: 300,
      label: "Leg1 mid",
    },
    {
      id: "N3",
      type: "internal",
      x: 450,
      y: 0,
      position: metres(13.5),
      pressure: 300_000,
      temperature: 300,
      label: "Leg2 mid",
    },
    {
      id: "N4",
      type: "internal",
      x: 450,
      y: -120,
      position: metres(12, -3, -3),
      pressure: 300_000,
      temperature: 300,
      label: "Leg3 mid",
    },
    {
      id: "N5",
      type: "internal",
      x: 600,
      y: 0,
      position: metres(14),
      pressure: 250_000,
      temperature: 300,
      label: "Return merge",
    },
    {
      id: "N6",
      type: "internal",
      x: 750,
      y: -80,
      position: metres(19.5, -2),
      pressure: 200_000,
      temperature: 300,
      label: "Return low",
    },
    {
      id: "N7",
      type: "internal",
      x: 750,
      y: 80,
      position: metres(19.5, 2),
      pressure: 200_000,
      temperature: 300,
      label: "Return high",
    },
    {
      id: "D_LOW",
      type: "boundary",
      x: 900,
      y: -80,
      position: metres(19.5, -2, -5),
      pressure: 150_000,
      temperature: 300,
      label: "Discharge low",
    },
    {
      id: "D_HIGH",
      type: "boundary",
      x: 900,
      y: 80,
      position: metres(19.5, 2, 5),
      pressure: 120_000,
      temperature: 300,
      label: "Discharge high",
    },
  ],
  branches: [
    {
      id: "pump",
      from: "SRC",
      to: "N0",
      component: {
        type: "pump",
        curve: [
          [0, 300_000],
          [0.01, 250_000],
          [0.02, 150_000],
          [0.03, 50_000],
        ],
      },
      label: "Pump",
    },
    {
      id: "main",
      from: "N0",
      to: "N1",
      component: { type: "pipe", length: 5, diameter: 0.05, roughness: 1e-5 },
      label: "Main header",
    },
    {
      id: "leg1_p",
      from: "N1",
      to: "N2",
      component: {
        type: "pipe",
        length: 8,
        diameter: 0.03,
        roughness: 1e-5,
        elevationChange: 3,
      },
      label: "Leg1 pipe",
    },
    {
      id: "leg1_v",
      from: "N2",
      to: "N5",
      component: { type: "valve", area: 0.001, cd: 0.6, position: 0.5 },
      label: "Leg1 valve",
    },
    {
      id: "leg2_p",
      from: "N1",
      to: "N3",
      component: {
        type: "pipe",
        length: 8,
        diameter: 0.03,
        roughness: 1e-5,
        elevationChange: 0,
      },
      label: "Leg2 pipe",
    },
    {
      id: "leg2_v",
      from: "N3",
      to: "N5",
      component: { type: "valve", area: 0.001, cd: 0.6, position: 0.8 },
      label: "Leg2 valve",
    },
    {
      id: "leg3_p",
      from: "N1",
      to: "N4",
      component: {
        type: "pipe",
        length: 8,
        diameter: 0.03,
        roughness: 1e-5,
        elevationChange: -3,
      },
      label: "Leg3 pipe",
    },
    {
      id: "leg3_v",
      from: "N4",
      to: "N5",
      component: { type: "valve", area: 0.001, cd: 0.6, position: 1.0 },
      label: "Leg3 valve",
    },
    {
      id: "ret1",
      from: "N5",
      to: "N6",
      component: { type: "pipe", length: 6, diameter: 0.04, roughness: 1e-5 },
      label: "Return low",
    },
    {
      id: "ret2",
      from: "N5",
      to: "N7",
      component: { type: "pipe", length: 6, diameter: 0.04, roughness: 1e-5 },
      label: "Return high",
    },
    {
      id: "dis_low",
      from: "N6",
      to: "D_LOW",
      component: {
        type: "pipe",
        length: 4,
        diameter: 0.04,
        roughness: 1e-5,
        elevationChange: -5,
      },
      label: "Discharge low",
    },
    {
      id: "dis_high",
      from: "N7",
      to: "D_HIGH",
      component: {
        type: "pipe",
        length: 4,
        diameter: 0.04,
        roughness: 1e-5,
        elevationChange: 5,
      },
      label: "Discharge high",
    },
  ],
};

export const pumpStartup: NetworkConfig = {
  meta: { name: "Pump startup transient", version: 2 },
  settings: {
    mode: "transient",
    dt: 0.05,
    endTime: 5.0,
    tolerance: 1e-8,
    maxIterations: 500,
    relaxation: 0.8,
  },
  fluid: { model: "incompressible", preset: "water" },
  nodes: [
    {
      id: "res",
      type: "boundary",
      x: 0,
      y: 0,
      position: metres(0),
      pressure: 100_000,
      temperature: 300,
      label: "Reservoir",
    },
    {
      id: "pumpOut",
      type: "internal",
      x: 150,
      y: 0,
      position: metres(0),
      pressure: 250_000,
      temperature: 300,
      volume: 0.02,
      label: "Pump out",
    },
    {
      id: "seg1",
      type: "internal",
      x: 300,
      y: 0,
      position: metres(40),
      pressure: 200_000,
      temperature: 300,
      volume: 0.02,
      label: "Seg1",
    },
    {
      id: "seg2",
      type: "internal",
      x: 450,
      y: 0,
      position: metres(80),
      pressure: 180_000,
      temperature: 300,
      volume: 0.02,
      label: "Seg2",
    },
    {
      id: "seg3",
      type: "internal",
      x: 600,
      y: 0,
      position: metres(120),
      pressure: 160_000,
      temperature: 300,
      volume: 0.02,
      label: "Seg3",
    },
    {
      id: "disch",
      type: "boundary",
      x: 750,
      y: 0,
      position: metres(120),
      pressure: 100_000,
      temperature: 300,
      label: "Discharge",
    },
  ],
  branches: [
    {
      id: "pump",
      from: "res",
      to: "pumpOut",
      component: {
        type: "pump",
        curve: [
          [0, 300_000],
          [0.005, 250_000],
          [0.01, 150_000],
          [0.02, 50_000],
        ],
      },
      label: "Pump",
    },
    {
      id: "pipe1",
      from: "pumpOut",
      to: "seg1",
      component: { type: "pipe", length: 40, diameter: 0.05, roughness: 1e-5 },
      label: "Pipe1",
    },
    {
      id: "pipe2",
      from: "seg1",
      to: "seg2",
      component: { type: "pipe", length: 40, diameter: 0.05, roughness: 1e-5 },
      label: "Pipe2",
    },
    {
      id: "pipe3",
      from: "seg2",
      to: "seg3",
      component: { type: "pipe", length: 40, diameter: 0.05, roughness: 1e-5 },
      label: "Pipe3",
    },
    {
      id: "valve",
      from: "seg3",
      to: "disch",
      component: {
        type: "valve",
        area: 0.0005,
        cd: 0.6,
        position: 0,
        positionSchedule: [
          [0, 0],
          [2, 1],
          [5, 1],
        ],
      },
      label: "Valve",
    },
  ],
};

export function buildGfrLoop(options?: {
  pressure?: number;
  fluidParams?: { R: number; gamma: number; mu: number; cp: number };
  mode?: "steady" | "transient";
  dt?: number;
  endTime?: number;
  diameter?: number;
  coreUA?: number;
  hxUA?: number;
  coreWallT?: number;
}): NetworkConfig {
  const P = options?.pressure ?? 1.5e6;
  const fp = options?.fluidParams ?? {
    R: 189,
    gamma: 1.3,
    mu: 1.5e-5,
    cp: 819,
  };
  const mode = options?.mode ?? "transient";
  const dt = options?.dt ?? 0.5;
  const endTime = options?.endTime ?? 300;
  const D = options?.diameter ?? 0.3;
  const coreUA = options?.coreUA ?? 5000;
  const hxUA = options?.hxUA ?? 3000;
  const coreWallT = options?.coreWallT ?? 1100;

  const isSteady = mode === "steady";

  // For closed ideal-gas loops in steady mode, a fully-closed valve makes the Jacobian singular.
  // Transient: closed valve (effective area floor 1e-9) is fine because dρ/dP·V/dt regularizes.
  // Steady: use an open leak path with tiny area so the Jacobian stays conditioned.
  const anchorBranch = isSteady
    ? {
        id: "anchor",
        from: "ANCHOR",
        to: "CORE",
        component: { type: "valve" as const, area: 1e-6, cd: 0.6, position: 1 },
        label: "Anchor leak",
      }
    : {
        id: "anchor",
        from: "ANCHOR",
        to: "CORE",
        component: { type: "valve" as const, area: 1e-6, cd: 0.6, position: 0 },
        label: "Anchor valve",
      };

  // Pre-segregated temperatures for transient to avoid the zero-flow fixed
  // point and to give the thermal solver a warm start close to the steady
  // profile.  The steady test already applies these via applySegregatedTemps.
  const Tinit = isSteady
    ? 700
    : ({
        ANCHOR: 700,
        CORE: 373,
        RISER_BOT: 1100,
        RISER_TOP: 1100,
        HX: 1100,
        HX_OUT: 373,
        DC_BOT: 373,
      } as Record<string, number>);
  const getT = (id: string) =>
    typeof Tinit === "number" ? Tinit : (Tinit[id] ?? 700);

  return {
    meta: { name: "GFR passive cooling loop", version: 2 },
    settings: {
      mode,
      ...(isSteady ? {} : { dt, endTime }),
      tolerance: 1e-6,
      maxIterations: 500,
      relaxation: 0.9,
    },
    fluid: { model: "idealGas", params: fp },
    nodes: [
      {
        id: "ANCHOR",
        type: "boundary",
        x: 0,
        y: 400,
        position: metres(0),
        pressure: P,
        temperature: getT("ANCHOR"),
        label: "Anchor",
      },
      {
        id: "CORE",
        type: "internal",
        x: 0,
        y: 500,
        position: metres(0),
        pressure: P,
        temperature: getT("CORE"),
        volume: 2.0,
        label: "Core",
      },
      {
        id: "RISER_BOT",
        type: "internal",
        x: 120,
        y: 500,
        position: metres(2),
        pressure: P,
        temperature: getT("RISER_BOT"),
        volume: 0.5,
        label: "Riser bottom",
      },
      {
        id: "RISER_TOP",
        type: "internal",
        x: 120,
        y: 200,
        position: metres(2, 0, 10),
        pressure: P,
        temperature: getT("RISER_TOP"),
        volume: 0.5,
        label: "Riser top",
      },
      {
        id: "HX",
        type: "internal",
        x: 0,
        y: 200,
        position: metres(0, 0, 10),
        pressure: P,
        temperature: getT("HX"),
        volume: 1.0,
        label: "HX",
      },
      {
        id: "HX_OUT",
        type: "internal",
        x: -120,
        y: 200,
        position: metres(-2, 0, 10),
        pressure: P,
        temperature: getT("HX_OUT"),
        volume: 0.5,
        label: "HX out",
      },
      {
        id: "DC_BOT",
        type: "internal",
        x: -120,
        y: 500,
        position: metres(-2),
        pressure: P,
        temperature: getT("DC_BOT"),
        volume: 1.0,
        label: "Downcomer",
      },
    ],
    branches: [
      anchorBranch,
      {
        id: "core",
        from: "CORE",
        to: "RISER_BOT",
        component: {
          type: "heatedPipe",
          length: 2,
          diameter: D,
          roughness: 4.5e-5,
          elevationChange: 0,
          ua: coreUA,
          wallTemperature: coreWallT,
        },
        label: "Core heated pipe",
      },
      {
        id: "riser",
        from: "RISER_BOT",
        to: "RISER_TOP",
        component: {
          type: "pipe",
          length: 12,
          diameter: D,
          roughness: 4.5e-5,
          elevationChange: 10,
        },
        label: "Hot riser",
      },
      {
        id: "conn_top",
        from: "RISER_TOP",
        to: "HX",
        component: {
          type: "pipe",
          length: 1,
          diameter: D,
          roughness: 4.5e-5,
          elevationChange: 0,
        },
        label: "Top connector",
      },
      {
        id: "hx",
        from: "HX",
        to: "HX_OUT",
        component: {
          type: "heatedPipe",
          length: 2,
          diameter: D,
          roughness: 4.5e-5,
          elevationChange: 0,
          ua: hxUA,
          wallTemperature: 373,
        },
        label: "HX cooled pipe",
      },
      {
        id: "conn_left",
        from: "HX_OUT",
        to: "DC_BOT",
        component: {
          type: "pipe",
          length: 1,
          diameter: D,
          roughness: 4.5e-5,
          elevationChange: -10,
        },
        label: "Downcomer",
      },
      {
        id: "conn_bot",
        from: "DC_BOT",
        to: "CORE",
        component: {
          type: "pipe",
          length: 1,
          diameter: D,
          roughness: 4.5e-5,
          elevationChange: 0,
        },
        label: "Bottom connector",
      },
    ],
  };
}

/**
 * Conjugate-HT teaching example — also the kept FORMULA-BINDING demo
 * (core/paramBindings.ts): the wall↔fluid convection areas are tied to the
 * wetted inner surface of the pipe segment each wall segment jackets
 * (c1 wraps b_in, c2 wraps b_mid), so editing the pipe length/diameter
 * re-derives the heat-transfer area at solve entry.  The formulas are
 * resolved once against the static model before each solve; the shipped
 * values (π·0.03·0.5 ≈ 0.0471 m²) match the physics of the original
 * hand-set 0.1 m² areas to within a factor of ~2.
 */
export const heatedPipeRadiatingWall: NetworkConfig = {
  meta: { name: "Heated pipe with radiating wall (conjugate HT)", version: 2 },
  settings: {
    mode: "steady",
    tolerance: 1e-8,
    maxIterations: 500,
    relaxation: 0.9,
  },
  fluid: { model: "incompressible", preset: "water" },
  nodes: [
    {
      id: "in",
      type: "boundary",
      x: 0,
      y: 300,
      position: metres(0),
      pressure: 200_000,
      temperature: 300,
      label: "Inlet",
    },
    {
      id: "f1",
      type: "internal",
      x: 200,
      y: 300,
      position: metres(0.5),
      pressure: 175_000,
      temperature: 300,
      volume: 0.001,
      label: "Fluid 1",
    },
    {
      id: "f2",
      type: "internal",
      x: 400,
      y: 300,
      position: metres(1),
      pressure: 150_000,
      temperature: 300,
      volume: 0.001,
      label: "Fluid 2",
    },
    {
      id: "out",
      type: "boundary",
      x: 600,
      y: 300,
      position: metres(1.1),
      pressure: 100_000,
      temperature: 300,
      label: "Outlet",
    },
  ],
  // Wall segments jacket the pipes they wrap (w1 on b_in, w2 on b_mid), so
  // each sits at its pipe's axial midpoint, lifted by the pipe radius
  // (D = 0.03 m) to the wall surface.  The outlet boundary stands 0.1 m
  // past f2 across the zero-length orifice.
  solidNodes: [
    {
      id: "w1",
      type: "solid",
      x: 200,
      y: 150,
      position: metres(0.25, 0, 0.015),
      temperature: 350,
      mass: 1,
      cp: 500,
      heatInput: 5000,
      label: "Wall 1",
    },
    {
      id: "w2",
      type: "solid",
      x: 400,
      y: 150,
      position: metres(0.75, 0, 0.015),
      temperature: 350,
      mass: 1,
      cp: 500,
      heatInput: 5000,
      label: "Wall 2",
    },
    {
      id: "amb",
      type: "ambient",
      x: 300,
      y: 0,
      position: metres(0.5, 0, 0.5),
      temperature: 300,
      label: "Ambient",
    },
  ],
  conductors: [
    {
      id: "c1",
      from: "w1",
      to: "f1",
      type: {
        kind: "convection",
        h: 1000,
        area: { expr: "pipe('b_in').surfaceArea" },
      },
      label: "Conv w1-f1",
    },
    {
      id: "c2",
      from: "w2",
      to: "f2",
      type: {
        kind: "convection",
        h: 1000,
        area: { expr: "pipe('b_mid').surfaceArea" },
      },
      label: "Conv w2-f2",
    },
    {
      id: "c3",
      from: "w1",
      to: "w2",
      type: { kind: "conduction", k: 50, area: 0.05, length: 0.1 },
      label: "Cond w1-w2",
    },
    {
      id: "c4",
      from: "w1",
      to: "amb",
      type: { kind: "radiation", emissivity: 0.8, area: 0.5, viewFactor: 1 },
      label: "Rad w1-amb",
    },
    {
      id: "c5",
      from: "w2",
      to: "amb",
      type: { kind: "radiation", emissivity: 0.8, area: 0.5, viewFactor: 1 },
      label: "Rad w2-amb",
    },
  ],
  branches: [
    {
      id: "b_in",
      from: "in",
      to: "f1",
      component: { type: "pipe", length: 0.5, diameter: 0.03, roughness: 1e-5 },
      label: "Inlet pipe",
    },
    {
      id: "b_mid",
      from: "f1",
      to: "f2",
      component: { type: "pipe", length: 0.5, diameter: 0.03, roughness: 1e-5 },
      label: "Mid pipe",
    },
    {
      id: "b_out",
      from: "f2",
      to: "out",
      component: { type: "orifice", area: 0.0001, cd: 0.6 },
      label: "Outlet orifice",
    },
  ],
};

/**
 * Benchmark A — GFSSP Ex.13: Conduction rod with convection (steady)
 *
 * Source: NASA/TM-2011-216470 §6.13 + Majumdar TFAWS-2004.
 * Rod: L=0.6096 m, D=0.0508 m, k=16.27 W/(m·K), A_cs=2.028e-3 m², P=0.1596 m.
 * Ends held at 273.15 K and 373.15 K; convection h=6.47 W/(m²·K) to air at 294.26 K.
 * Discretized with N=5 solid segment nodes (masses for transient-validity).
 * Air is modelled as a flowing stream to satisfy conjugate requirement.
 */
export const gfsspEx13ConductionRod: NetworkConfig = {
  meta: { name: "GFSSP Ex.13: Conduction rod with convection", version: 2 },
  settings: {
    mode: "transient",
    dt: 100,
    endTime: 40000,
    tolerance: 1e-8,
    maxIterations: 500,
    relaxation: 0.9,
  },
  fluid: { model: "idealGas", preset: "air" },
  nodes: [
    {
      id: "air_in",
      type: "boundary",
      x: 0,
      y: 300,
      position: metres(0),
      pressure: 101325,
      temperature: 294.26,
      label: "Air in",
    },
    {
      id: "air_mid",
      type: "internal",
      x: 300,
      y: 300,
      position: metres(0.3048),
      pressure: 101325,
      temperature: 294.26,
      volume: 0.1,
      label: "Air bulk",
    },
    {
      id: "air_out",
      type: "boundary",
      x: 600,
      y: 300,
      position: metres(0.6096),
      pressure: 101325,
      temperature: 294.26,
      label: "Air out",
    },
  ],
  solidNodes: [
    {
      id: "amb_cold",
      type: "ambient",
      x: 0,
      y: 150,
      position: metres(0),
      temperature: 273.15,
      label: "Cold end",
    },
    {
      id: "amb_hot",
      type: "ambient",
      x: 600,
      y: 150,
      position: metres(0.6096),
      temperature: 373.15,
      label: "Hot end",
    },
    {
      id: "s0",
      type: "solid",
      x: 60,
      y: 150,
      position: metres(0.06096),
      temperature: 294.26,
      mass: 3.22,
      cp: 500,
      label: "Seg1",
    },
    {
      id: "s1",
      type: "solid",
      x: 180,
      y: 150,
      position: metres(0.18288),
      temperature: 294.26,
      mass: 3.22,
      cp: 500,
      label: "Seg2",
    },
    {
      id: "s2",
      type: "solid",
      x: 300,
      y: 150,
      position: metres(0.3048),
      temperature: 294.26,
      mass: 3.22,
      cp: 500,
      label: "Seg3",
    },
    {
      id: "s3",
      type: "solid",
      x: 420,
      y: 150,
      position: metres(0.42672),
      temperature: 294.26,
      mass: 3.22,
      cp: 500,
      label: "Seg4",
    },
    {
      id: "s4",
      type: "solid",
      x: 540,
      y: 150,
      position: metres(0.54864),
      temperature: 294.26,
      mass: 3.22,
      cp: 500,
      label: "Seg5",
    },
  ],
  conductors: [
    {
      id: "c_cold_s0",
      from: "amb_cold",
      to: "s0",
      type: { kind: "conduction", k: 16.27, area: 2.028e-3, length: 0.06096 },
      label: "Cold end cond",
    },
    {
      id: "c_s0_s1",
      from: "s0",
      to: "s1",
      type: { kind: "conduction", k: 16.27, area: 2.028e-3, length: 0.12192 },
      label: "Cond 1-2",
    },
    {
      id: "c_s1_s2",
      from: "s1",
      to: "s2",
      type: { kind: "conduction", k: 16.27, area: 2.028e-3, length: 0.12192 },
      label: "Cond 2-3",
    },
    {
      id: "c_s2_s3",
      from: "s2",
      to: "s3",
      type: { kind: "conduction", k: 16.27, area: 2.028e-3, length: 0.12192 },
      label: "Cond 3-4",
    },
    {
      id: "c_s3_s4",
      from: "s3",
      to: "s4",
      type: { kind: "conduction", k: 16.27, area: 2.028e-3, length: 0.12192 },
      label: "Cond 4-5",
    },
    {
      id: "c_s4_hot",
      from: "s4",
      to: "amb_hot",
      type: { kind: "conduction", k: 16.27, area: 2.028e-3, length: 0.06096 },
      label: "Hot end cond",
    },
    {
      id: "c_s0_air",
      from: "s0",
      to: "air_mid",
      type: { kind: "convection", h: 6.47, area: 0.01946 },
      label: "Conv s1-air",
    },
    {
      id: "c_s1_air",
      from: "s1",
      to: "air_mid",
      type: { kind: "convection", h: 6.47, area: 0.01946 },
      label: "Conv s2-air",
    },
    {
      id: "c_s2_air",
      from: "s2",
      to: "air_mid",
      type: { kind: "convection", h: 6.47, area: 0.01946 },
      label: "Conv s3-air",
    },
    {
      id: "c_s3_air",
      from: "s3",
      to: "air_mid",
      type: { kind: "convection", h: 6.47, area: 0.01946 },
      label: "Conv s4-air",
    },
    {
      id: "c_s4_air",
      from: "s4",
      to: "air_mid",
      type: { kind: "convection", h: 6.47, area: 0.01946 },
      label: "Conv s5-air",
    },
  ],
  branches: [
    {
      id: "b_air_in",
      from: "air_in",
      to: "air_mid",
      component: { type: "flowSource", massFlow: 1.0 },
      label: "Air inlet",
    },
    {
      id: "b_air_out",
      from: "air_mid",
      to: "air_out",
      component: { type: "flowSource", massFlow: 1.0 },
      label: "Air outlet",
    },
  ],
};

/**
 * Benchmark B — GFSSP-style N2–N2 counterflow HX (conjugate, steady)
 *
 * Source: JANNAF-2024 Majumdar & LeClair conjugate HX schematic.
 * Geometry: inner D_i=0.0508 m, tube OD 0.05715 m, annulus OD 0.1016 m, L=0.6096 m.
 * SS wall k=16.2, rho=8000, cp=500.
 * IMPORTANT deviation: loop pressure set to 2.0e6 Pa (published schematic flow rates at 1 atm
 * give ~500 m/s, which is unphysical for this geometry).
 * Fluid N2 ideal gas {R:296.8, gamma:1.4, mu:2.2e-5, cp:1040}.
 * FlowSource branches impose mdot_hot=1.175 kg/s (inlet 394.26 K) and mdot_cold=1.193 kg/s (inlet 294.26 K).
 * 5 segments with 5 solid wall nodes; conductors per segment: hot-side convection h_h·A_i,
 * cold-side convection h_c·A_o, axial wall conduction between wall nodes.
 */
export const gfsspN2N2CounterflowHX: NetworkConfig = {
  meta: { name: "GFSSP-style N2-N2 counterflow HX (conjugate)", version: 2 },
  settings: {
    mode: "transient",
    dt: 2,
    endTime: 200,
    tolerance: 1e-8,
    maxIterations: 500,
    relaxation: 0.9,
  },
  fluid: {
    model: "idealGas",
    params: { R: 296.8, gamma: 1.4, mu: 2.2e-5, cp: 1040 },
  },
  nodes: [
    {
      id: "h_in",
      type: "boundary",
      x: 0,
      y: 0,
      position: metres(0),
      pressure: 2.0e6,
      temperature: 394.26,
      label: "Hot in",
    },
    {
      id: "h1",
      type: "internal",
      x: 100,
      y: 0,
      position: metres(0.1016),
      pressure: 2.0e6,
      temperature: 294.26,
      volume: 2.5e-4,
      label: "Hot 1",
    },
    {
      id: "h2",
      type: "internal",
      x: 200,
      y: 0,
      position: metres(0.2032),
      pressure: 2.0e6,
      temperature: 294.26,
      volume: 2.5e-4,
      label: "Hot 2",
    },
    {
      id: "h3",
      type: "internal",
      x: 300,
      y: 0,
      position: metres(0.3048),
      pressure: 2.0e6,
      temperature: 294.26,
      volume: 2.5e-4,
      label: "Hot 3",
    },
    {
      id: "h4",
      type: "internal",
      x: 400,
      y: 0,
      position: metres(0.4064),
      pressure: 2.0e6,
      temperature: 294.26,
      volume: 2.5e-4,
      label: "Hot 4",
    },
    {
      id: "h5",
      type: "internal",
      x: 500,
      y: 0,
      position: metres(0.508),
      pressure: 2.0e6,
      temperature: 294.26,
      volume: 2.5e-4,
      label: "Hot 5",
    },
    {
      id: "h_out",
      type: "boundary",
      x: 600,
      y: 0,
      position: metres(0.6096),
      pressure: 2.0e6,
      temperature: 394.26,
      label: "Hot out",
    },
    {
      id: "c_in",
      type: "boundary",
      x: 600,
      y: 200,
      position: metres(0.6096),
      pressure: 2.0e6,
      temperature: 294.26,
      label: "Cold in",
    },
    {
      id: "c1",
      type: "internal",
      x: 100,
      y: 200,
      position: metres(0.1016),
      pressure: 2.0e6,
      temperature: 294.26,
      volume: 6.8e-4,
      label: "Cold 1",
    },
    {
      id: "c2",
      type: "internal",
      x: 200,
      y: 200,
      position: metres(0.2032),
      pressure: 2.0e6,
      temperature: 294.26,
      volume: 6.8e-4,
      label: "Cold 2",
    },
    {
      id: "c3",
      type: "internal",
      x: 300,
      y: 200,
      position: metres(0.3048),
      pressure: 2.0e6,
      temperature: 294.26,
      volume: 6.8e-4,
      label: "Cold 3",
    },
    {
      id: "c4",
      type: "internal",
      x: 400,
      y: 200,
      position: metres(0.4064),
      pressure: 2.0e6,
      temperature: 294.26,
      volume: 6.8e-4,
      label: "Cold 4",
    },
    {
      id: "c5",
      type: "internal",
      x: 500,
      y: 200,
      position: metres(0.508),
      pressure: 2.0e6,
      temperature: 294.26,
      volume: 6.8e-4,
      label: "Cold 5",
    },
    {
      id: "c_out",
      type: "boundary",
      x: 0,
      y: 200,
      position: metres(0),
      pressure: 2.0e6,
      temperature: 294.26,
      label: "Cold out",
    },
  ],
  solidNodes: [
    {
      id: "w1",
      type: "solid",
      x: 100,
      y: 100,
      position: metres(0.1016),
      temperature: 294.26,
      mass: 0.524,
      cp: 500,
      label: "Wall 1",
    },
    {
      id: "w2",
      type: "solid",
      x: 200,
      y: 100,
      position: metres(0.2032),
      temperature: 294.26,
      mass: 0.524,
      cp: 500,
      label: "Wall 2",
    },
    {
      id: "w3",
      type: "solid",
      x: 300,
      y: 100,
      position: metres(0.3048),
      temperature: 294.26,
      mass: 0.524,
      cp: 500,
      label: "Wall 3",
    },
    {
      id: "w4",
      type: "solid",
      x: 400,
      y: 100,
      position: metres(0.4064),
      temperature: 294.26,
      mass: 0.524,
      cp: 500,
      label: "Wall 4",
    },
    {
      id: "w5",
      type: "solid",
      x: 500,
      y: 100,
      position: metres(0.508),
      temperature: 294.26,
      mass: 0.524,
      cp: 500,
      label: "Wall 5",
    },
  ],
  conductors: [
    {
      id: "hw1",
      from: "h1",
      to: "w1",
      type: { kind: "convection", h: 970, area: 0.01946 },
      label: "Hot conv 1",
    },
    {
      id: "hw2",
      from: "h2",
      to: "w2",
      type: { kind: "convection", h: 970, area: 0.01946 },
      label: "Hot conv 2",
    },
    {
      id: "hw3",
      from: "h3",
      to: "w3",
      type: { kind: "convection", h: 970, area: 0.01946 },
      label: "Hot conv 3",
    },
    {
      id: "hw4",
      from: "h4",
      to: "w4",
      type: { kind: "convection", h: 970, area: 0.01946 },
      label: "Hot conv 4",
    },
    {
      id: "hw5",
      from: "h5",
      to: "w5",
      type: { kind: "convection", h: 970, area: 0.01946 },
      label: "Hot conv 5",
    },
    {
      id: "cw1",
      from: "w1",
      to: "c1",
      type: { kind: "convection", h: 1250, area: 0.0219 },
      label: "Cold conv 1",
    },
    {
      id: "cw2",
      from: "w2",
      to: "c2",
      type: { kind: "convection", h: 1250, area: 0.0219 },
      label: "Cold conv 2",
    },
    {
      id: "cw3",
      from: "w3",
      to: "c3",
      type: { kind: "convection", h: 1250, area: 0.0219 },
      label: "Cold conv 3",
    },
    {
      id: "cw4",
      from: "w4",
      to: "c4",
      type: { kind: "convection", h: 1250, area: 0.0219 },
      label: "Cold conv 4",
    },
    {
      id: "cw5",
      from: "w5",
      to: "c5",
      type: { kind: "convection", h: 1250, area: 0.0219 },
      label: "Cold conv 5",
    },
    {
      id: "wcond1",
      from: "w1",
      to: "w2",
      type: { kind: "conduction", k: 16.2, area: 5.383e-4, length: 0.12192 },
      label: "Wall cond 1-2",
    },
    {
      id: "wcond2",
      from: "w2",
      to: "w3",
      type: { kind: "conduction", k: 16.2, area: 5.383e-4, length: 0.12192 },
      label: "Wall cond 2-3",
    },
    {
      id: "wcond3",
      from: "w3",
      to: "w4",
      type: { kind: "conduction", k: 16.2, area: 5.383e-4, length: 0.12192 },
      label: "Wall cond 3-4",
    },
    {
      id: "wcond4",
      from: "w4",
      to: "w5",
      type: { kind: "conduction", k: 16.2, area: 5.383e-4, length: 0.12192 },
      label: "Wall cond 4-5",
    },
  ],
  branches: [
    {
      id: "hb0",
      from: "h_in",
      to: "h1",
      component: { type: "flowSource", massFlow: 1.175 },
      label: "Hot flow 0",
    },
    {
      id: "hb1",
      from: "h1",
      to: "h2",
      component: { type: "flowSource", massFlow: 1.175 },
      label: "Hot flow 1",
    },
    {
      id: "hb2",
      from: "h2",
      to: "h3",
      component: { type: "flowSource", massFlow: 1.175 },
      label: "Hot flow 2",
    },
    {
      id: "hb3",
      from: "h3",
      to: "h4",
      component: { type: "flowSource", massFlow: 1.175 },
      label: "Hot flow 3",
    },
    {
      id: "hb4",
      from: "h4",
      to: "h5",
      component: { type: "flowSource", massFlow: 1.175 },
      label: "Hot flow 4",
    },
    {
      id: "hb5",
      from: "h5",
      to: "h_out",
      component: { type: "flowSource", massFlow: 1.175 },
      label: "Hot flow 5",
    },
    {
      id: "cb0",
      from: "c_in",
      to: "c5",
      component: { type: "flowSource", massFlow: 1.193 },
      label: "Cold flow 0",
    },
    {
      id: "cb1",
      from: "c5",
      to: "c4",
      component: { type: "flowSource", massFlow: 1.193 },
      label: "Cold flow 1",
    },
    {
      id: "cb2",
      from: "c4",
      to: "c3",
      component: { type: "flowSource", massFlow: 1.193 },
      label: "Cold flow 2",
    },
    {
      id: "cb3",
      from: "c3",
      to: "c2",
      component: { type: "flowSource", massFlow: 1.193 },
      label: "Cold flow 3",
    },
    {
      id: "cb4",
      from: "c2",
      to: "c1",
      component: { type: "flowSource", massFlow: 1.193 },
      label: "Cold flow 4",
    },
    {
      id: "cb5",
      from: "c1",
      to: "c_out",
      component: { type: "flowSource", massFlow: 1.193 },
      label: "Cold flow 5",
    },
  ],
};

/**
 * Benchmark C — GFSSP Ex.5: water-water counterflow HX (steady-state benchmark)
 *
 * Source: GFSSP v5 manual Example 5 via Patel 2011 (tabulated GFSSP outputs).
 * Hot water in at 100 °F (310.93 K), cold in at 60 °F (288.71 K).
 * Overall UA = 1.10375 BTU/(s·°R) = 2094 W/K.
 * Published GFSSP results: mdot_hot=0.4014 kg/s, mdot_cold=2.454 kg/s,
 *   T_hot,out=295.67 K, T_cold,out=290.94 K, Q≈25.6 kW.
 * Implementation: incompressible water; flowSource branches impose published mdots;
 *   counterflow with 12 segments (≥8 as specified); per-segment wall solid node
 *   with hot-side and cold-side convection conductors each sized to 2·UA/N_seg per side.
 *
 * Ships in STEADY mode (the published GFSSP results are steady-state values).
 * The retained dt/endTime settings let the benchmark tests build a transient
 * copy (see buildTransientConfig in gfssp-benchmarks.test.ts) to verify that
 * the transient end-state matches this steady solve; they are inert here.
 */

/**
 * Physical layout for GFSSP Ex.5 (manual Fig. 87): each stream runs a 10 in
 * inlet pipe, the 10 in heat-exchanger section, and a 10 in outlet pipe
 * (30 in = 0.762 m total).  The 12 segment nodes sit at the segment centres
 * of the HX section.  The two streams lie side by side, separated by their
 * pipe radii: the hot 0.25 in tube centreline sits +r_hot above the shared
 * wall plane and the cold 0.5 in tube centreline −r_cold below it, so the
 * wall solid nodes sit exactly where the tube wall is (z = 0).
 */
const EX5_IN = 0.0254;
const EX5_LENGTH = 30 * EX5_IN;
const EX5_HX_START = 10 * EX5_IN;
const EX5_SEG = (10 * EX5_IN) / 12;
const EX5_HOT_Z = (0.25 / 2) * EX5_IN;
const EX5_COLD_Z = -(0.5 / 2) * EX5_IN;
/** Axial station [m] of HX segment centre i (1-based). */
const ex5X = (i: number) => EX5_HX_START + (i - 0.5) * EX5_SEG;

export const gfsspEx5WaterWaterHX: NetworkConfig = {
  meta: { name: "Water-water counterflow heat exchanger", version: 2 },
  settings: {
    mode: "steady",
    dt: 2,
    endTime: 200,
    tolerance: 1e-8,
    maxIterations: 500,
    relaxation: 0.9,
  },
  fluid: { model: "incompressible", preset: "water" },
  nodes: [
    {
      id: "h_in",
      type: "boundary",
      x: 0,
      y: 0,
      position: metres(0, 0, EX5_HOT_Z),
      pressure: 2e5,
      temperature: 310.93,
      label: "Hot in",
    },
    {
      id: "h1",
      type: "internal",
      x: 70,
      y: 0,
      position: metres(ex5X(1), 0, EX5_HOT_Z),
      pressure: 2e5,
      temperature: 288.71,
      volume: 1e-5,
      label: "Hot 1",
    },
    {
      id: "h2",
      type: "internal",
      x: 140,
      y: 0,
      position: metres(ex5X(2), 0, EX5_HOT_Z),
      pressure: 2e5,
      temperature: 288.71,
      volume: 1e-5,
      label: "Hot 2",
    },
    {
      id: "h3",
      type: "internal",
      x: 210,
      y: 0,
      position: metres(ex5X(3), 0, EX5_HOT_Z),
      pressure: 2e5,
      temperature: 288.71,
      volume: 1e-5,
      label: "Hot 3",
    },
    {
      id: "h4",
      type: "internal",
      x: 280,
      y: 0,
      position: metres(ex5X(4), 0, EX5_HOT_Z),
      pressure: 2e5,
      temperature: 288.71,
      volume: 1e-5,
      label: "Hot 4",
    },
    {
      id: "h5",
      type: "internal",
      x: 350,
      y: 0,
      position: metres(ex5X(5), 0, EX5_HOT_Z),
      pressure: 2e5,
      temperature: 288.71,
      volume: 1e-5,
      label: "Hot 5",
    },
    {
      id: "h6",
      type: "internal",
      x: 420,
      y: 0,
      position: metres(ex5X(6), 0, EX5_HOT_Z),
      pressure: 2e5,
      temperature: 288.71,
      volume: 1e-5,
      label: "Hot 6",
    },
    {
      id: "h7",
      type: "internal",
      x: 490,
      y: 0,
      position: metres(ex5X(7), 0, EX5_HOT_Z),
      pressure: 2e5,
      temperature: 288.71,
      volume: 1e-5,
      label: "Hot 7",
    },
    {
      id: "h8",
      type: "internal",
      x: 560,
      y: 0,
      position: metres(ex5X(8), 0, EX5_HOT_Z),
      pressure: 2e5,
      temperature: 288.71,
      volume: 1e-5,
      label: "Hot 8",
    },
    {
      id: "h9",
      type: "internal",
      x: 630,
      y: 0,
      position: metres(ex5X(9), 0, EX5_HOT_Z),
      pressure: 2e5,
      temperature: 288.71,
      volume: 1e-5,
      label: "Hot 9",
    },
    {
      id: "h10",
      type: "internal",
      x: 700,
      y: 0,
      position: metres(ex5X(10), 0, EX5_HOT_Z),
      pressure: 2e5,
      temperature: 288.71,
      volume: 1e-5,
      label: "Hot 10",
    },
    {
      id: "h11",
      type: "internal",
      x: 770,
      y: 0,
      position: metres(ex5X(11), 0, EX5_HOT_Z),
      pressure: 2e5,
      temperature: 288.71,
      volume: 1e-5,
      label: "Hot 11",
    },
    {
      id: "h12",
      type: "internal",
      x: 840,
      y: 0,
      position: metres(ex5X(12), 0, EX5_HOT_Z),
      pressure: 2e5,
      temperature: 288.71,
      volume: 1e-5,
      label: "Hot 12",
    },
    {
      id: "h_out",
      type: "boundary",
      x: 910,
      y: 0,
      position: metres(EX5_LENGTH, 0, EX5_HOT_Z),
      pressure: 2e5,
      temperature: 310.93,
      label: "Hot out",
    },
    {
      id: "c_in",
      type: "boundary",
      x: 910,
      y: 200,
      position: metres(EX5_LENGTH, 0, EX5_COLD_Z),
      pressure: 2e5,
      temperature: 288.71,
      label: "Cold in",
    },
    {
      id: "c1",
      type: "internal",
      x: 70,
      y: 200,
      position: metres(ex5X(1), 0, EX5_COLD_Z),
      pressure: 2e5,
      temperature: 288.71,
      volume: 1e-5,
      label: "Cold 1",
    },
    {
      id: "c2",
      type: "internal",
      x: 140,
      y: 200,
      position: metres(ex5X(2), 0, EX5_COLD_Z),
      pressure: 2e5,
      temperature: 288.71,
      volume: 1e-5,
      label: "Cold 2",
    },
    {
      id: "c3",
      type: "internal",
      x: 210,
      y: 200,
      position: metres(ex5X(3), 0, EX5_COLD_Z),
      pressure: 2e5,
      temperature: 288.71,
      volume: 1e-5,
      label: "Cold 3",
    },
    {
      id: "c4",
      type: "internal",
      x: 280,
      y: 200,
      position: metres(ex5X(4), 0, EX5_COLD_Z),
      pressure: 2e5,
      temperature: 288.71,
      volume: 1e-5,
      label: "Cold 4",
    },
    {
      id: "c5",
      type: "internal",
      x: 350,
      y: 200,
      position: metres(ex5X(5), 0, EX5_COLD_Z),
      pressure: 2e5,
      temperature: 288.71,
      volume: 1e-5,
      label: "Cold 5",
    },
    {
      id: "c6",
      type: "internal",
      x: 420,
      y: 200,
      position: metres(ex5X(6), 0, EX5_COLD_Z),
      pressure: 2e5,
      temperature: 288.71,
      volume: 1e-5,
      label: "Cold 6",
    },
    {
      id: "c7",
      type: "internal",
      x: 490,
      y: 200,
      position: metres(ex5X(7), 0, EX5_COLD_Z),
      pressure: 2e5,
      temperature: 288.71,
      volume: 1e-5,
      label: "Cold 7",
    },
    {
      id: "c8",
      type: "internal",
      x: 560,
      y: 200,
      position: metres(ex5X(8), 0, EX5_COLD_Z),
      pressure: 2e5,
      temperature: 288.71,
      volume: 1e-5,
      label: "Cold 8",
    },
    {
      id: "c9",
      type: "internal",
      x: 630,
      y: 200,
      position: metres(ex5X(9), 0, EX5_COLD_Z),
      pressure: 2e5,
      temperature: 288.71,
      volume: 1e-5,
      label: "Cold 9",
    },
    {
      id: "c10",
      type: "internal",
      x: 700,
      y: 200,
      position: metres(ex5X(10), 0, EX5_COLD_Z),
      pressure: 2e5,
      temperature: 288.71,
      volume: 1e-5,
      label: "Cold 10",
    },
    {
      id: "c11",
      type: "internal",
      x: 770,
      y: 200,
      position: metres(ex5X(11), 0, EX5_COLD_Z),
      pressure: 2e5,
      temperature: 288.71,
      volume: 1e-5,
      label: "Cold 11",
    },
    {
      id: "c12",
      type: "internal",
      x: 840,
      y: 200,
      position: metres(ex5X(12), 0, EX5_COLD_Z),
      pressure: 2e5,
      temperature: 288.71,
      volume: 1e-5,
      label: "Cold 12",
    },
    {
      id: "c_out",
      type: "boundary",
      x: 0,
      y: 200,
      position: metres(0, 0, EX5_COLD_Z),
      pressure: 2e5,
      temperature: 288.71,
      label: "Cold out",
    },
  ],
  solidNodes: [
    {
      id: "w1",
      type: "solid",
      x: 70,
      y: 100,
      position: metres(ex5X(1)),
      temperature: 288.71,
      mass: 0.1,
      cp: 500,
      label: "Wall 1",
    },
    {
      id: "w2",
      type: "solid",
      x: 140,
      y: 100,
      position: metres(ex5X(2)),
      temperature: 288.71,
      mass: 0.1,
      cp: 500,
      label: "Wall 2",
    },
    {
      id: "w3",
      type: "solid",
      x: 210,
      y: 100,
      position: metres(ex5X(3)),
      temperature: 288.71,
      mass: 0.1,
      cp: 500,
      label: "Wall 3",
    },
    {
      id: "w4",
      type: "solid",
      x: 280,
      y: 100,
      position: metres(ex5X(4)),
      temperature: 288.71,
      mass: 0.1,
      cp: 500,
      label: "Wall 4",
    },
    {
      id: "w5",
      type: "solid",
      x: 350,
      y: 100,
      position: metres(ex5X(5)),
      temperature: 288.71,
      mass: 0.1,
      cp: 500,
      label: "Wall 5",
    },
    {
      id: "w6",
      type: "solid",
      x: 420,
      y: 100,
      position: metres(ex5X(6)),
      temperature: 288.71,
      mass: 0.1,
      cp: 500,
      label: "Wall 6",
    },
    {
      id: "w7",
      type: "solid",
      x: 490,
      y: 100,
      position: metres(ex5X(7)),
      temperature: 288.71,
      mass: 0.1,
      cp: 500,
      label: "Wall 7",
    },
    {
      id: "w8",
      type: "solid",
      x: 560,
      y: 100,
      position: metres(ex5X(8)),
      temperature: 288.71,
      mass: 0.1,
      cp: 500,
      label: "Wall 8",
    },
    {
      id: "w9",
      type: "solid",
      x: 630,
      y: 100,
      position: metres(ex5X(9)),
      temperature: 288.71,
      mass: 0.1,
      cp: 500,
      label: "Wall 9",
    },
    {
      id: "w10",
      type: "solid",
      x: 700,
      y: 100,
      position: metres(ex5X(10)),
      temperature: 288.71,
      mass: 0.1,
      cp: 500,
      label: "Wall 10",
    },
    {
      id: "w11",
      type: "solid",
      x: 770,
      y: 100,
      position: metres(ex5X(11)),
      temperature: 288.71,
      mass: 0.1,
      cp: 500,
      label: "Wall 11",
    },
    {
      id: "w12",
      type: "solid",
      x: 840,
      y: 100,
      position: metres(ex5X(12)),
      temperature: 288.71,
      mass: 0.1,
      cp: 500,
      label: "Wall 12",
    },
  ],
  conductors: [
    {
      id: "hw1",
      from: "h1",
      to: "w1",
      type: { kind: "convection", h: 349, area: 1 },
      label: "Hot conv 1",
    },
    {
      id: "hw2",
      from: "h2",
      to: "w2",
      type: { kind: "convection", h: 349, area: 1 },
      label: "Hot conv 2",
    },
    {
      id: "hw3",
      from: "h3",
      to: "w3",
      type: { kind: "convection", h: 349, area: 1 },
      label: "Hot conv 3",
    },
    {
      id: "hw4",
      from: "h4",
      to: "w4",
      type: { kind: "convection", h: 349, area: 1 },
      label: "Hot conv 4",
    },
    {
      id: "hw5",
      from: "h5",
      to: "w5",
      type: { kind: "convection", h: 349, area: 1 },
      label: "Hot conv 5",
    },
    {
      id: "hw6",
      from: "h6",
      to: "w6",
      type: { kind: "convection", h: 349, area: 1 },
      label: "Hot conv 6",
    },
    {
      id: "hw7",
      from: "h7",
      to: "w7",
      type: { kind: "convection", h: 349, area: 1 },
      label: "Hot conv 7",
    },
    {
      id: "hw8",
      from: "h8",
      to: "w8",
      type: { kind: "convection", h: 349, area: 1 },
      label: "Hot conv 8",
    },
    {
      id: "hw9",
      from: "h9",
      to: "w9",
      type: { kind: "convection", h: 349, area: 1 },
      label: "Hot conv 9",
    },
    {
      id: "hw10",
      from: "h10",
      to: "w10",
      type: { kind: "convection", h: 349, area: 1 },
      label: "Hot conv 10",
    },
    {
      id: "hw11",
      from: "h11",
      to: "w11",
      type: { kind: "convection", h: 349, area: 1 },
      label: "Hot conv 11",
    },
    {
      id: "hw12",
      from: "h12",
      to: "w12",
      type: { kind: "convection", h: 349, area: 1 },
      label: "Hot conv 12",
    },
    {
      id: "cw1",
      from: "w1",
      to: "c1",
      type: { kind: "convection", h: 349, area: 1 },
      label: "Cold conv 1",
    },
    {
      id: "cw2",
      from: "w2",
      to: "c2",
      type: { kind: "convection", h: 349, area: 1 },
      label: "Cold conv 2",
    },
    {
      id: "cw3",
      from: "w3",
      to: "c3",
      type: { kind: "convection", h: 349, area: 1 },
      label: "Cold conv 3",
    },
    {
      id: "cw4",
      from: "w4",
      to: "c4",
      type: { kind: "convection", h: 349, area: 1 },
      label: "Cold conv 4",
    },
    {
      id: "cw5",
      from: "w5",
      to: "c5",
      type: { kind: "convection", h: 349, area: 1 },
      label: "Cold conv 5",
    },
    {
      id: "cw6",
      from: "w6",
      to: "c6",
      type: { kind: "convection", h: 349, area: 1 },
      label: "Cold conv 6",
    },
    {
      id: "cw7",
      from: "w7",
      to: "c7",
      type: { kind: "convection", h: 349, area: 1 },
      label: "Cold conv 7",
    },
    {
      id: "cw8",
      from: "w8",
      to: "c8",
      type: { kind: "convection", h: 349, area: 1 },
      label: "Cold conv 8",
    },
    {
      id: "cw9",
      from: "w9",
      to: "c9",
      type: { kind: "convection", h: 349, area: 1 },
      label: "Cold conv 9",
    },
    {
      id: "cw10",
      from: "w10",
      to: "c10",
      type: { kind: "convection", h: 349, area: 1 },
      label: "Cold conv 10",
    },
    {
      id: "cw11",
      from: "w11",
      to: "c11",
      type: { kind: "convection", h: 349, area: 1 },
      label: "Cold conv 11",
    },
    {
      id: "cw12",
      from: "w12",
      to: "c12",
      type: { kind: "convection", h: 349, area: 1 },
      label: "Cold conv 12",
    },
  ],
  branches: [
    {
      id: "hb0",
      from: "h_in",
      to: "h1",
      component: { type: "flowSource", massFlow: 0.4014 },
      label: "Hot flow 0",
    },
    {
      id: "hb1",
      from: "h1",
      to: "h2",
      component: { type: "flowSource", massFlow: 0.4014 },
      label: "Hot flow 1",
    },
    {
      id: "hb2",
      from: "h2",
      to: "h3",
      component: { type: "flowSource", massFlow: 0.4014 },
      label: "Hot flow 2",
    },
    {
      id: "hb3",
      from: "h3",
      to: "h4",
      component: { type: "flowSource", massFlow: 0.4014 },
      label: "Hot flow 3",
    },
    {
      id: "hb4",
      from: "h4",
      to: "h5",
      component: { type: "flowSource", massFlow: 0.4014 },
      label: "Hot flow 4",
    },
    {
      id: "hb5",
      from: "h5",
      to: "h6",
      component: { type: "flowSource", massFlow: 0.4014 },
      label: "Hot flow 5",
    },
    {
      id: "hb6",
      from: "h6",
      to: "h7",
      component: { type: "flowSource", massFlow: 0.4014 },
      label: "Hot flow 6",
    },
    {
      id: "hb7",
      from: "h7",
      to: "h8",
      component: { type: "flowSource", massFlow: 0.4014 },
      label: "Hot flow 7",
    },
    {
      id: "hb8",
      from: "h8",
      to: "h9",
      component: { type: "flowSource", massFlow: 0.4014 },
      label: "Hot flow 8",
    },
    {
      id: "hb9",
      from: "h9",
      to: "h10",
      component: { type: "flowSource", massFlow: 0.4014 },
      label: "Hot flow 9",
    },
    {
      id: "hb10",
      from: "h10",
      to: "h11",
      component: { type: "flowSource", massFlow: 0.4014 },
      label: "Hot flow 10",
    },
    {
      id: "hb11",
      from: "h11",
      to: "h12",
      component: { type: "flowSource", massFlow: 0.4014 },
      label: "Hot flow 11",
    },
    {
      id: "hb12",
      from: "h12",
      to: "h_out",
      component: { type: "flowSource", massFlow: 0.4014 },
      label: "Hot flow 12",
    },
    {
      id: "cb0",
      from: "c_in",
      to: "c12",
      component: { type: "flowSource", massFlow: 2.454 },
      label: "Cold flow 0",
    },
    {
      id: "cb1",
      from: "c12",
      to: "c11",
      component: { type: "flowSource", massFlow: 2.454 },
      label: "Cold flow 1",
    },
    {
      id: "cb2",
      from: "c11",
      to: "c10",
      component: { type: "flowSource", massFlow: 2.454 },
      label: "Cold flow 2",
    },
    {
      id: "cb3",
      from: "c10",
      to: "c9",
      component: { type: "flowSource", massFlow: 2.454 },
      label: "Cold flow 3",
    },
    {
      id: "cb4",
      from: "c9",
      to: "c8",
      component: { type: "flowSource", massFlow: 2.454 },
      label: "Cold flow 4",
    },
    {
      id: "cb5",
      from: "c8",
      to: "c7",
      component: { type: "flowSource", massFlow: 2.454 },
      label: "Cold flow 5",
    },
    {
      id: "cb6",
      from: "c7",
      to: "c6",
      component: { type: "flowSource", massFlow: 2.454 },
      label: "Cold flow 6",
    },
    {
      id: "cb7",
      from: "c6",
      to: "c5",
      component: { type: "flowSource", massFlow: 2.454 },
      label: "Cold flow 7",
    },
    {
      id: "cb8",
      from: "c5",
      to: "c4",
      component: { type: "flowSource", massFlow: 2.454 },
      label: "Cold flow 8",
    },
    {
      id: "cb9",
      from: "c4",
      to: "c3",
      component: { type: "flowSource", massFlow: 2.454 },
      label: "Cold flow 9",
    },
    {
      id: "cb10",
      from: "c3",
      to: "c2",
      component: { type: "flowSource", massFlow: 2.454 },
      label: "Cold flow 10",
    },
    {
      id: "cb11",
      from: "c2",
      to: "c1",
      component: { type: "flowSource", massFlow: 2.454 },
      label: "Cold flow 11",
    },
    {
      id: "cb12",
      from: "c1",
      to: "c_out",
      component: { type: "flowSource", massFlow: 2.454 },
      label: "Cold flow 12",
    },
  ],
};

/**
 * Hand-calc: vertical water column, 4 segments of 2.5 m, total 10 m.
 * ρ = 1000 kg/m³, g = 9.80665 m/s² → ΔP_step = 1000·9.80665·2.5 = 24516.625 Pa.
 * Top boundary at 100 kPa, bottom at 198.0665 kPa (exact hydrostatic balance).
 * With no driving pressure difference, every branch carries exactly zero flow.
 * Node pressures from top to bottom: 100.000, 124.517, 149.033, 173.550, 198.067 kPa.
 */
export const sanityHydrostaticColumn: NetworkConfig = {
  meta: { name: "Sanity: hydrostatic column", version: 2 },
  settings: {
    mode: "steady",
    tolerance: 1e-12,
    maxIterations: 500,
    relaxation: 0.9,
  },
  fluid: { model: "incompressible", params: { rho: 1000, mu: 1e-3, cp: 4182 } },
  nodes: [
    {
      id: "top",
      type: "boundary",
      x: 0,
      y: 0,
      position: metres(0, 0, 10),
      pressure: 100_000,
      temperature: 300,
      label: "Top 100 kPa",
    },
    {
      id: "n1",
      type: "internal",
      x: 0,
      y: 60,
      position: metres(0, 0, 7.5),
      pressure: 124_516.625,
      temperature: 300,
      label: "expect 124.5 kPa",
    },
    {
      id: "n2",
      type: "internal",
      x: 0,
      y: 120,
      position: metres(0, 0, 5),
      pressure: 149_033.25,
      temperature: 300,
      label: "expect 149.0 kPa",
    },
    {
      id: "n3",
      type: "internal",
      x: 0,
      y: 180,
      position: metres(0, 0, 2.5),
      pressure: 173_549.875,
      temperature: 300,
      label: "expect 173.5 kPa",
    },
    {
      id: "bot",
      type: "boundary",
      x: 0,
      y: 240,
      position: metres(0),
      pressure: 198_066.5,
      temperature: 300,
      label: "Bot 198.1 kPa",
    },
  ],
  branches: [
    {
      id: "p1",
      from: "top",
      to: "n1",
      component: {
        type: "pipe",
        length: 1,
        diameter: 0.1,
        roughness: 0,
        elevationChange: -2.5,
      },
      label: "Pipe 1",
    },
    {
      id: "p2",
      from: "n1",
      to: "n2",
      component: {
        type: "pipe",
        length: 1,
        diameter: 0.1,
        roughness: 0,
        elevationChange: -2.5,
      },
      label: "Pipe 2",
    },
    {
      id: "p3",
      from: "n2",
      to: "n3",
      component: {
        type: "pipe",
        length: 1,
        diameter: 0.1,
        roughness: 0,
        elevationChange: -2.5,
      },
      label: "Pipe 3",
    },
    {
      id: "p4",
      from: "n3",
      to: "bot",
      component: {
        type: "pipe",
        length: 1,
        diameter: 0.1,
        roughness: 0,
        elevationChange: -2.5,
      },
      label: "Pipe 4",
    },
  ],
};

/**
 * Hand-calc: a 2.000 kg/s flow source feeds a junction that splits into two IDENTICAL pipes
 * discharging to the SAME outlet boundary. By symmetry each pipe must carry exactly 1.000 kg/s.
 */
export const sanityFlowSplit: NetworkConfig = {
  meta: { name: "Sanity: 50/50 flow split", version: 2 },
  settings: {
    mode: "steady",
    tolerance: 1e-9,
    maxIterations: 500,
    relaxation: 0.9,
  },
  fluid: { model: "incompressible", preset: "water" },
  nodes: [
    {
      id: "in",
      type: "boundary",
      x: 0,
      y: 0,
      position: metres(0),
      pressure: 300_000,
      temperature: 300,
      label: "Inlet",
    },
    {
      id: "j",
      type: "internal",
      x: 200,
      y: 0,
      position: metres(0),
      pressure: 150_000,
      temperature: 300,
      label: "Junction",
    },
    {
      id: "out",
      type: "boundary",
      x: 400,
      y: 0,
      position: metres(2),
      pressure: 100_000,
      temperature: 300,
      label: "Outlet",
    },
  ],
  branches: [
    {
      id: "fs",
      from: "in",
      to: "j",
      component: { type: "flowSource", massFlow: 2.0 },
      label: "Flow source 2.000 kg/s",
    },
    {
      id: "p1",
      from: "j",
      to: "out",
      component: { type: "pipe", length: 2, diameter: 0.05, roughness: 0 },
      label: "Pipe 1 (expect 1.000 kg/s)",
    },
    {
      id: "p2",
      from: "j",
      to: "out",
      component: { type: "pipe", length: 2, diameter: 0.05, roughness: 0 },
      label: "Pipe 2 (expect 1.000 kg/s)",
    },
  ],
};

/**
 * Hand-calc: incompressible orifice with Cd = 0.6, A = 1×10⁻⁴ m², ΔP = 100 kPa, ρ = 1000 kg/m³.
 * mdot = Cd·A·√(2·ρ·ΔP) = 0.6·1e-4·√(2·1000·100000) ≈ 0.8485 kg/s.
 */
export const sanityOrificeHandCalc: NetworkConfig = {
  meta: { name: "Sanity: orifice hand-calc", version: 2 },
  settings: {
    mode: "steady",
    tolerance: 1e-9,
    maxIterations: 500,
    relaxation: 0.9,
  },
  fluid: { model: "incompressible", params: { rho: 1000, mu: 1e-3, cp: 4182 } },
  nodes: [
    {
      id: "in",
      type: "boundary",
      x: 0,
      y: 0,
      position: metres(0),
      pressure: 200_000,
      temperature: 300,
      label: "200 kPa",
    },
    {
      // 0.1 m downstream stand-off: the orifice plate itself is zero-length,
      // so the two pressure taps must not be coincident in space.
      id: "out",
      type: "boundary",
      x: 200,
      y: 0,
      position: metres(0.1),
      pressure: 100_000,
      temperature: 300,
      label: "100 kPa",
    },
  ],
  branches: [
    {
      id: "o",
      from: "in",
      to: "out",
      component: { type: "orifice", area: 1e-4, cd: 0.6 },
      label: "mdot = 0.6·1e-4·√(2·1000·100000) ≈ 0.849 kg/s",
    },
  ],
};

/**
 * Hand-calc: two equal water streams, 1.000 kg/s at 300 K and 1.000 kg/s at 400 K, mix adiabatically.
 * With equal cp: T_mix = (1·300 + 1·400) / (1+1) = 350.00 K exactly.
 */
export const sanityEqualTMixing: NetworkConfig = {
  meta: { name: "Sanity: equal-T mixing", version: 2 },
  settings: {
    mode: "steady",
    tolerance: 1e-9,
    maxIterations: 500,
    relaxation: 0.9,
  },
  fluid: { model: "incompressible", preset: "water" },
  nodes: [
    {
      id: "hot_in",
      type: "boundary",
      x: 0,
      y: 60,
      position: metres(0, 1),
      pressure: 200_000,
      temperature: 400,
      label: "1 kg/s @ 400 K",
    },
    {
      id: "cold_in",
      type: "boundary",
      x: 0,
      y: -60,
      position: metres(0, -1),
      pressure: 200_000,
      temperature: 300,
      label: "1 kg/s @ 300 K",
    },
    {
      id: "mix",
      type: "internal",
      x: 200,
      y: 0,
      position: metres(0),
      pressure: 150_000,
      temperature: 350,
      label: "expect 350 K",
    },
    {
      id: "out",
      type: "boundary",
      x: 400,
      y: 0,
      position: metres(1),
      pressure: 100_000,
      temperature: 300,
      label: "Outlet",
    },
  ],
  branches: [
    {
      id: "hot_fs",
      from: "hot_in",
      to: "mix",
      component: { type: "flowSource", massFlow: 1.0 },
      label: "Hot 1.000 kg/s",
    },
    {
      id: "cold_fs",
      from: "cold_in",
      to: "mix",
      component: { type: "flowSource", massFlow: 1.0 },
      label: "Cold 1.000 kg/s",
    },
    {
      id: "p",
      from: "mix",
      to: "out",
      component: { type: "pipe", length: 1, diameter: 0.05, roughness: 0 },
      label: "Outlet pipe",
    },
  ],
};

/**
 * Hand-calc: two identical air tanks (1.0 m³ each) at 200 kPa and 100 kPa, same temperature,
 * connected by an orifice. For ideal gas at uniform T, mass ∝ P·V, so the equilibrium pressure
 * is the volume-weighted mean: (200·1 + 100·1) / (1+1) = 150.0 kPa.
 * The transient should show both curves meeting at 150 kPa.
 */
export const sanityTankEqualization: NetworkConfig = {
  meta: { name: "Sanity: tank equalization", version: 2 },
  settings: {
    mode: "transient",
    dt: 0.1,
    endTime: 30,
    tolerance: 1e-8,
    maxIterations: 200,
    relaxation: 0.9,
  },
  fluid: { model: "idealGas", preset: "air" },
  nodes: [
    {
      id: "tank1",
      type: "internal",
      x: 0,
      y: 0,
      position: metres(0),
      pressure: 200_000,
      temperature: 300,
      volume: 1.0,
      label: "Tank 1 (expect 150 kPa)",
    },
    {
      id: "tank2",
      type: "internal",
      x: 200,
      y: 0,
      position: metres(1),
      pressure: 100_000,
      temperature: 300,
      volume: 1.0,
      label: "Tank 2 (expect 150 kPa)",
    },
    {
      id: "anchor",
      type: "boundary",
      x: 400,
      y: 0,
      position: metres(1),
      pressure: 150_000,
      temperature: 300,
      label: "Anchor",
    },
  ],
  branches: [
    {
      id: "o",
      from: "tank1",
      to: "tank2",
      component: { type: "orifice", area: 1e-4, cd: 0.6 },
      label: "Orifice",
    },
    {
      id: "anchor_flow",
      from: "tank1",
      to: "anchor",
      component: { type: "flowSource", massFlow: 0 },
      label: "Anchor (zero flow)",
    },
  ],
};

/**
 * Hand-calc:
 * (a) 1-D conduction ladder: 3 solid nodes between 300 K and 400 K ambients with equal conductances.
 *    Steady temperatures are equally spaced: 325 / 350 / 375 K.
 * (b) Lumped capacitance cooldown: solid node with m·cp = 100 J/K convecting to a 300 K stream
 *    with hA = 1 W/K → τ = 100 s.
 *    T(t) = 300 + 100·e^(−t/100).
 *    At 100 s: 300 + 100·e^(−1) ≈ 336.8 K.
 *    At 300 s: 300 + 100·e^(−3) ≈ 305.0 K.
 */
export const sanityConductionLadderCooldown: NetworkConfig = {
  meta: { name: "Sanity: conduction ladder + lumped cooldown", version: 2 },
  settings: {
    mode: "transient",
    dt: 1,
    endTime: 500,
    tolerance: 1e-9,
    maxIterations: 500,
    relaxation: 0.9,
  },
  fluid: { model: "incompressible", preset: "water" },
  nodes: [
    {
      id: "dummy_in",
      type: "boundary",
      x: 0,
      y: 300,
      position: metres(0),
      pressure: 100_000,
      temperature: 300,
      label: "Dummy in",
    },
    {
      id: "stream",
      type: "boundary",
      x: 200,
      y: 300,
      position: metres(1),
      pressure: 100_000,
      temperature: 300,
      label: "Stream 300 K",
    },
  ],
  solidNodes: [
    {
      id: "amb_cold",
      type: "ambient",
      x: 0,
      y: 0,
      position: metres(0),
      temperature: 300,
      label: "Cold 300 K",
    },
    {
      id: "s1",
      type: "solid",
      x: 80,
      y: 0,
      position: metres(0.1),
      temperature: 300,
      mass: 0.1,
      cp: 100,
      label: "expect 325 K",
    },
    {
      id: "s2",
      type: "solid",
      x: 160,
      y: 0,
      position: metres(0.2),
      temperature: 300,
      mass: 0.1,
      cp: 100,
      label: "expect 350 K",
    },
    {
      id: "s3",
      type: "solid",
      x: 240,
      y: 0,
      position: metres(0.3),
      temperature: 300,
      mass: 0.1,
      cp: 100,
      label: "expect 375 K",
    },
    {
      id: "amb_hot",
      type: "ambient",
      x: 320,
      y: 0,
      position: metres(0.4),
      temperature: 400,
      label: "Hot 400 K",
    },
    {
      id: "solid_cool",
      type: "solid",
      x: 160,
      y: 150,
      position: metres(0.2),
      temperature: 400,
      mass: 1,
      cp: 100,
      label: "expect 336.8 K @ 100 s",
    },
  ],
  conductors: [
    {
      id: "c_cold_s1",
      from: "amb_cold",
      to: "s1",
      type: { kind: "conduction", k: 100, area: 0.01, length: 0.1 },
      label: "Cond cold-s1",
    },
    {
      id: "c_s1_s2",
      from: "s1",
      to: "s2",
      type: { kind: "conduction", k: 100, area: 0.01, length: 0.1 },
      label: "Cond s1-s2",
    },
    {
      id: "c_s2_s3",
      from: "s2",
      to: "s3",
      type: { kind: "conduction", k: 100, area: 0.01, length: 0.1 },
      label: "Cond s2-s3",
    },
    {
      id: "c_s3_hot",
      from: "s3",
      to: "amb_hot",
      type: { kind: "conduction", k: 100, area: 0.01, length: 0.1 },
      label: "Cond s3-hot",
    },
    {
      id: "c_conv",
      from: "solid_cool",
      to: "stream",
      type: { kind: "convection", h: 10, area: 0.1 },
      label: "Conv cool-stream",
    },
  ],
  branches: [
    {
      id: "dummy_pipe",
      from: "dummy_in",
      to: "stream",
      component: { type: "pipe", length: 1, diameter: 0.1, roughness: 0 },
      label: "Dummy pipe",
    },
  ],
};

export function buildLeeMartin(options?: {
  pressureRatio?: number;
  alphaG?: number;
  polytropicIndex?: number;
  dt?: number;
  endTime?: number;
}): NetworkConfig {
  const pressureRatio = options?.pressureRatio ?? 7;
  const alphaG = options?.alphaG ?? 0.448;
  // Tuned default: the 10-segment backward-Euler model with dt = 0.01 s is
  // numerically dissipative, so the effective gas stiffness is higher than the
  // physical value. A polytropic index of 1.03 (near-isothermal) best recovers
  // the published first-peak amplitude (~1.90 MPa abs) and oscillation period
  // (~0.55–0.60 s) from Majumdar et al. (AIAA 2015-3850, Fig. 11). Rapid
  // compression nominally tends toward adiabatic (n≈1.4), but the coarse
  // discretisation requires a lower effective n to match the experiment.
  const n = options?.polytropicIndex ?? 1.03;
  const dt = options?.dt ?? 0.01;
  const endTime = options?.endTime ?? 4.0;

  const D = 0.026035;
  const A = (Math.PI / 4) * D * D;
  const L = 0.6096;
  const Vseg = A * L;
  // Physical gas volume from the void fraction: Vg0 = alpha_g * V_water_total / (1 - alpha_g)
  // where V_water_total = 10 pipe segments * A * L.
  const Vg0 = (alphaG * (10 * Vseg)) / (1 - alphaG);
  const P_atm = 101_350;
  const P_R = pressureRatio * P_atm;

  // Node IDs follow paper: 1 = reservoir boundary, 2..11 internal along the pipe,
  // 12 = internal node carrying the variable gas cushion.
  const nodes: NetworkConfig["nodes"] = [
    {
      // Reservoir sits just upstream of the pipe inlet (node 2 at x = 0)
      // across the zero-length fast-opening valve.
      id: "1",
      type: "boundary",
      x: 0,
      y: 0,
      position: metres(-0.1),
      pressure: P_R,
      temperature: 293,
      label: "1 Reservoir",
    },
  ];
  const coords = [
    { x: 80, y: 0 },
    { x: 160, y: 0 },
    { x: 240, y: 60 },
    { x: 320, y: 60 },
    { x: 400, y: 0 },
    { x: 480, y: 0 },
    { x: 560, y: 60 },
    { x: 640, y: 60 },
    { x: 720, y: 0 },
    { x: 800, y: 0 },
  ];
  for (let i = 0; i < 10; i++) {
    const id = String(i + 2);
    nodes.push({
      id,
      type: "internal",
      x: coords[i].x,
      y: coords[i].y,
      position: metres(i * L),
      pressure: P_atm,
      temperature: 293,
      volume: Vseg,
      label: id,
    });
  }
  nodes.push({
    id: "12",
    type: "internal",
    x: 880,
    y: 0,
    position: metres(10 * L),
    pressure: P_atm,
    temperature: 293,
    volume: Vg0 + Vseg,
    gasCushion: { initialGasVolume: Vg0, polytropicIndex: n },
    label: "12 Air cushion",
  });

  const branches: NetworkConfig["branches"] = [
    {
      id: "valve",
      from: "1",
      to: "2",
      component: {
        type: "valve",
        area: A,
        cd: 0.6,
        position: 0,
        positionSchedule: [
          [0, 0],
          [0.15, 0],
          [0.4, 1],
        ],
      },
      label: "Valve",
    },
  ];
  for (let i = 0; i < 10; i++) {
    const from = String(i + 2);
    const to = String(i + 3);
    branches.push({
      id: `p${i + 1}`,
      from,
      to,
      component: {
        type: "pipe",
        length: L,
        diameter: D,
        roughness: 1.5e-6,
        inertia: true,
      },
      label: `Pipe ${i + 1}`,
    });
  }

  return {
    meta: { name: "Entrapped-air line", version: 2 },
    settings: {
      mode: "transient",
      dt,
      endTime,
      tolerance: 1e-6,
      maxIterations: 200,
      relaxation: 0.9,
    },
    fluid: { model: "incompressible", preset: "water" },
    nodes,
    branches,
  };
}

/** Shipped default (see `examples` / **Examples ▾** dropdown). */
export const leeMartinEntrappedAir = buildLeeMartin();

/**
 * Cryogenic line chilldown (GFSSP Fig.14, single-phase)
 *
 * Citation: Majumdar et al., AIAA 2015-3850, §IV.C; NBS Report 9264 (1966).
 *
 * MANDATORY ADAPTATION — SINGLE-PHASE ONLY:
 * The original NBS experiment and GFSSP model involve two-phase boiling
 * heat transfer (Miropolskii correlation) and the large latent-heat sink
 * of cryogenic hydrogen. Our solver is strictly single-phase: CoolProp’s
 * two-phase dome guard throws an error if any state enters the saturation
 * dome. We first attempted the recommended supercritical N₂ (80 K, 5 MPa)
 * but the real-fluid transient proved numerically troublesome: the
 * Newton–Raphson pressure updates can overshoot into negative pressures
 * or sub-melting temperatures, causing unrecoverable CoolProp WASM errors.
 *
 * FALLBACK SHIPPED — cold GN₂ vapour (ideal-gas N₂):
 *   - Inlet: 90 K, 5.0 MPa  (raised to drive higher mdot·cp and sharpen the
 *     thermal front in the single-phase surrogate)
 *   - Outlet: 0.50 MPa, 300 K
 *   - Initial pipe fluid: 300 K at ~0.50 MPa
 * The single-phase guarantee is trivial (ideal gas has no saturation dome).
 * Because there is no boiling heat transfer and no latent heat, the
 * absolute chilldown times are NOT comparable to the paper’s ~70 s for
 * LH₂. Only the structural behaviour (sequential station chilling,
 * thermal-front propagation, pressure-driven trend) is validated.
 *
 * TUNING NOTE — h = 3500 W/(m²·K):
 * The original paper’s Fig. 15 shows a sharp plateau-then-plunge with
 * contracting gaps and downstream steepening. A single-phase gas model
 * cannot reproduce the latent-heat-driven front acceleration of boiling
 * chilldown. To make the *closest defensible* single-phase surrogate,
 * h was raised far above single-phase gas values (typical h ≈ 10–100
 * W/(m²·K)) so that the upstream wall equilibrates to the fluid
 * temperature quickly, letting the cold fluid penetrate downstream ever
 * faster. This produces:
 *   1. Contracting gaps (t₂−t₁) > (t₃−t₂) > (t₄−t₃)
 *   2. A modest plateau fraction that increases downstream
 *   3. Common asymptote to the inlet fluid temperature
 * Downstream steepening of max |dT/dt| is fundamentally impossible
 * without boiling physics (the front diffuses rather than steepens).
 *
 * Geometry: vacuum-jacketed 200-ft (60.96 m) copper line, 5/8-in ID
 * (0.015875 m), 3/4-in OD (0.01905 m).
 * Default N = 15 segments (paper uses 30; 30×realFluid transient is too
 * slow for interactive use, >20 s). Tests may request fewer segments via
 * options.
 */
export function buildChilldown(options?: {
  segments?: number;
  inletPressure?: number;
  outletPressure?: number;
  inletTemperature?: number;
  h?: number;
  dt?: number;
  endTime?: number;
  timeStepping?: "fixed" | "adaptive";
}): NetworkConfig {
  const N = options?.segments ?? 15;
  const L = 60.96;
  const D = 0.015875;
  const OD = 0.01905;
  const roughness = 1.5e-6;
  const rhoCu = 8960;
  const cpCu = 385;
  const kCu = 400;
  const hConv = options?.h ?? 3500; // tuned to accentuate front acceleration in single-phase surrogate
  const P_in = options?.inletPressure ?? 5.0e6;
  const T_in = options?.inletTemperature ?? 90;
  const P_out = options?.outletPressure ?? 0.5e6;
  const T_out = 300;
  const segL = L / N;
  const A_fluid = (Math.PI / 4) * D * D;
  const A_metal = (Math.PI / 4) * (OD * OD - D * D);
  const vol = A_fluid * segL;
  const mass_solid = rhoCu * A_metal * segL;
  const convArea = Math.PI * D * segL;
  const canvasX = (i: number) => i * 170;
  const at = (i: number, y: number) => ({
    x: canvasX(i),
    y,
    position: metres(i * segL),
  });

  const nodes: NetworkConfig["nodes"] = [];
  const solidNodes: NetworkConfig["solidNodes"] = [];
  const conductors: NetworkConfig["conductors"] = [];
  const branches: NetworkConfig["branches"] = [];

  // Inlet boundary
  nodes.push({
    id: "f0",
    type: "boundary",
    ...at(0, 0),
    pressure: P_in,
    temperature: T_in,
    label: "Inlet",
  });
  solidNodes.push({
    id: "s0",
    type: "solid",
    ...at(0, 80),
    temperature: T_out,
    mass: mass_solid,
    cp: cpCu,
    label: "Wall inlet",
  });

  // Internal nodes and solid nodes
  for (let i = 1; i < N; i++) {
    const station = i * segL;
    const p0 = P_in - (P_in - P_out) * (i / N);
    let label = `Node ${i}`;
    const ft = station / 0.3048;
    if (Math.abs(ft - 20) < 2) label = "Station 1 (20 ft)";
    else if (Math.abs(ft - 80) < 2) label = "Station 2 (80 ft)";
    else if (Math.abs(ft - 141) < 2) label = "Station 3 (141 ft)";
    else if (Math.abs(ft - 198) < 2) label = "Station 4 (198 ft)";
    nodes.push({
      id: `f${i}`,
      type: "internal",
      ...at(i, 0),
      pressure: p0,
      temperature: T_out,
      volume: vol,
      label,
    });
    solidNodes.push({
      id: `s${i}`,
      type: "solid",
      ...at(i, 80),
      temperature: T_out,
      mass: mass_solid,
      cp: cpCu,
      label: `Wall ${i}`,
    });
  }

  // Outlet boundary
  nodes.push({
    id: `f${N}`,
    type: "boundary",
    ...at(N, 0),
    pressure: P_out,
    temperature: T_out,
    label: "Outlet",
  });
  solidNodes.push({
    id: `s${N}`,
    type: "solid",
    ...at(N, 80),
    temperature: T_out,
    mass: mass_solid,
    cp: cpCu,
    label: "Wall outlet",
  });

  // Convection conductors fluid <-> solid
  for (let i = 0; i <= N; i++) {
    conductors.push({
      id: `conv${i}`,
      from: `f${i}`,
      to: `s${i}`,
      type: { kind: "convection", h: hConv, area: convArea },
      label: `Conv ${i}`,
    });
  }

  // Axial solid-solid conduction
  for (let i = 0; i < N; i++) {
    conductors.push({
      id: `cond${i}`,
      from: `s${i}`,
      to: `s${i + 1}`,
      type: { kind: "conduction", k: kCu, area: A_metal, length: segL },
      label: `Cond ${i}`,
    });
  }

  // Pipe branches
  for (let i = 0; i < N; i++) {
    branches.push({
      id: `pipe${i}`,
      from: `f${i}`,
      to: `f${i + 1}`,
      component: { type: "pipe", length: segL, diameter: D, roughness },
      label: `Pipe ${i}`,
    });
  }

  const dt = options?.dt ?? 2;
  const endTime = options?.endTime ?? 300;
  const timeStepping = options?.timeStepping ?? "adaptive";

  const settings: NetworkConfig["settings"] = {
    mode: "transient",
    tolerance: 1e-6,
    maxIterations: 500,
    relaxation: 0.9,
    endTime,
    ...(timeStepping === "fixed"
      ? { dt, timeStepping: "fixed" as const }
      : {
          timeStepping: "adaptive" as const,
          adaptive: {
            dtInitial: dt,
            dtMin: 0.5,
            dtMax: 20,
            relTol: 1e-3,
            absTolP: 1000,
            absTolT: 0.5,
            safety: 0.9,
          },
        }),
  };

  return {
    meta: {
      name: "Cryogenic line chilldown (GFSSP Fig.14, single-phase)",
      version: 2,
    },
    settings,
    fluid: {
      model: "idealGas",
      params: { R: 296.8, gamma: 1.4, mu: 1.7e-5, cp: 1040 },
    },
    nodes,
    solidNodes,
    conductors,
    branches,
  };
}

/**
 * Cryogenic line chilldown — TWO-PHASE LN₂ (GFSSP Fig.14, NBS/GFSSP §IV.C)
 *
 * Uses realFluid Nitrogen with CoolProp, HEM two-phase momentum, and the
 * Miropolskii film-boiling correlation for conjugate wall heat transfer.
 *
 * Inlet boundary: saturated liquid at driving pressure (quality≈0).
 * Outlet boundary: warm vapour at atmospheric pressure.
 * Initial line: warm N₂ gas at outlet pressure and temperature.
 *
 * TUNING NOTE:
 * RealFluid two-phase transient with pressure-driven pipe flow is numerically
 * expensive.  The default N=3, L=6 m is tuned for interactive use.  The
 * default fixed step is dt=0.5 s (200 steps over the 100 s horizon): the
 * chilldown is a fast transient with steep thermal gradients at the quench
 * front, and the smaller step resolves the front passage far more accurately
 * than the original dt=10 s at modest extra cost (per-step Newton cost drops
 * as the step shrinks, so the full solve stays in the few-second range).
 * For validation tests the scale is increased; see chilldownTwoPhase.test.ts
 * for measured runtimes.
 */
export function buildChilldownTwoPhase(options?: {
  segments?: number;
  length?: number;
  drivingPressure?: number;
  outletPressure?: number;
  outletTemperature?: number;
  /**
   * CoolProp HEOS fluid name.  Default 'Nitrogen' (the LN₂ Table-6 rows).
   * 'Hydrogen' (normal) and 'ParaHydrogen' select the LH₂ rows; the name
   * must pass validateNetwork (any catalogue fluid with a transport model —
   * see core/fluids/fluidCatalogue.ts).
   * NOTE: 'OrthoHydrogen' loads but carries NO viscosity/conductivity in
   * the current coolprop-wasm build — validation rejects it; do not use it
   * for solves.
   */
  fluidName?: string;
  /**
   * Inlet liquid state.  Default (undefined): SATURATED liquid at the
   * driving pressure (boundary node carries quality: 0) — the Table-6
   * "saturated" rows.  Set explicitly (K) for a SUBCOOLED/compressed-
   * liquid inlet (boundary node carries temperature instead) — the
   * Table-6 "subcooled" rows, e.g. 76.0 K for LN2 subcooled at -322.87 F.
   */
  inletTemperature?: number;
  /**
   * Which fluid node the OUTLET wall node (sN, at x = L) convects to.
   * 'boundary' (default, legacy): the fixed-T outlet boundary node — a
   * warm-vapor reservoir, so sN never chills (outlet-BC artifact; wall
   * samples near the line end are then unusable for station comparison).
   * 'upwind': the last INTERNAL fluid node (f_{N-1}) — the wall of the
   * last segment sees the actual flowing fluid, so sN chills like a real
   * wall and brackets station 4 (60.35 m) for spatial interpolation.
   */
  outletWallCoupling?: "boundary" | "upwind";
  /**
   * Initial temperature (K) of the line wall and internal fluid nodes.
   * Default: outletTemperature (legacy — the two were previously coupled,
   * which confounds "warm initial line" with "warm outlet boundary").
   * The NBS experiment did not record the initial line temperature
   * (documented nuisance parameter), so this is exposed independently.
   */
  initialTemperature?: number;
  /**
   * Wall-to-fluid boiling correlation.  Default 'miropolskii' (legacy —
   * omitting this option yields BIT-IDENTICAL configs to before the option
   * existed).  'darrHartwig' opts into the Darr–Hartwig 2020 LH2 set
   * (see src/core/darrHartwig.ts); the builder then also
   * supplies each conductor's `axialPosition` (required by validate.ts) as
   * the WALL node's `position.x` — identical to the fluid node's
   * `position.x` for every conductor except the upwind-coupled outlet
   * conductor, where the wall position is the physically meaningful
   * quench-front coordinate (the quench front advances along the wall, not
   * the fluid mesh). Canvas `x`/`y` are schematic pixels and are not used.
   * `inletLiquidReynolds` is deliberately left unset: the documented
   * default (instantaneous local-G estimate, uniform-ṁ pipe assumption —
   * the same uniform-ṁ model P1's own fit imposed) is used, and the
   * `relin` validity clamp loudly counts any envelope exits.
   * 'ttWf' opts into the PROPOSED two-temperature / wetted-fraction closure
   * (src/core/ttWf.ts): the same axialPosition convention as
   * 'darrHartwig' plus the schema-required `segmentLength` (= segL, the
   * builder's uniform segment length).  The two physical parameters
   * (`frontEnergyFactor` C_q, `rewetHysteresisOffsetK` ΔT_h) are
   * deliberately left UNSET so the pre-registered DESIGN defaults
   * (C_q = 1, ΔT_h = 2 K; TTWF_DEFAULT_PARAMS) apply — this builder never
   * tunes them.
   */
  correlationModel?: "miropolskii" | "darrHartwig" | "ttWf";
  /**
   * TT-WF only, OPT-IN (default off ⇒ bit-identical configs): enable the
   * transported cryogenic-front model (docs/fluid-front-transport.md) —
   * every ttWf conductor carries `correlation.fluidFront: true` (the
   * dry-side gate) and the inlet boundary node f0 is marked
   * `fluidFrontInlet: 1` (the tracer source: saturated cryogenic liquid
   * enters at t = 0).  No transport-speed or threshold parameter exists;
   * the front moves at the conservation speed of the accepted flow.
   */
  fluidFront?: boolean;
  dt?: number;
  endTime?: number;
  timeStepping?: "fixed" | "adaptive";
}): NetworkConfig {
  const N = options?.segments ?? 3;
  const L = options?.length ?? 6; // short default for interactive speed
  const P_in = options?.drivingPressure ?? 0.5169e6;
  const P_out = options?.outletPressure ?? 101325;
  const T_out = options?.outletTemperature ?? 300;
  const T_inlet = options?.inletTemperature;
  const outletWallCoupling = options?.outletWallCoupling ?? "boundary";
  const T_init = options?.initialTemperature ?? T_out;
  const dt = options?.dt ?? 0.5;
  const endTime = options?.endTime ?? 100;
  const timeStepping = options?.timeStepping ?? "fixed";
  const fluidName = options?.fluidName ?? "Nitrogen";
  const correlationModel = options?.correlationModel ?? "miropolskii";
  const fluidFront = options?.fluidFront ?? false;
  if (fluidFront && correlationModel !== "ttWf") {
    throw new Error(
      `buildChilldownTwoPhase: fluidFront: true requires correlationModel 'ttWf' ` +
        `(the gate is implemented on the TT-WF dry side only — docs/fluid-front-transport.md); got '${correlationModel}'`,
    );
  }

  const D = 0.015875;
  const OD = 0.01905;
  const roughness = 1.5e-6;
  const rhoCu = 8960;
  const cpCu = 385;
  const kCu = 400;
  const segL = L / N;
  const A_fluid = (Math.PI / 4) * D * D;
  const A_metal = (Math.PI / 4) * (OD * OD - D * D);
  const vol = A_fluid * segL;
  const mass_solid = rhoCu * A_metal * segL;
  const convArea = Math.PI * D * segL;
  const at = (i: number, y: number) => ({
    x: i * 170,
    y,
    position: metres(i * segL),
  });

  const nodes: NetworkConfig["nodes"] = [
    T_inlet === undefined
      ? {
          id: "f0",
          type: "boundary",
          ...at(0, 0),
          pressure: P_in,
          quality: 0,
          label: "Inlet",
        }
      : {
          id: "f0",
          type: "boundary",
          ...at(0, 0),
          pressure: P_in,
          temperature: T_inlet,
          label: "Inlet",
        },
  ];
  // Cryogenic-front tracer source: the inlet boundary is pure cryogenic
  // inlet fluid (a_bnd = 1) — model semantics, not a fitted knob.
  if (fluidFront) nodes[0].fluidFrontInlet = 1;
  const solidNodes: NetworkConfig["solidNodes"] = [
    {
      id: "s0",
      type: "solid",
      ...at(0, 80),
      temperature: T_init,
      mass: mass_solid,
      cp: cpCu,
      label: "Wall inlet",
    },
  ];
  const conductors: NetworkConfig["conductors"] = [];
  const branches: NetworkConfig["branches"] = [];

  for (let i = 1; i < N; i++) {
    const p0 = P_in - (P_in - P_out) * (i / N);
    nodes.push({
      id: `f${i}`,
      type: "internal",
      ...at(i, 0),
      pressure: p0,
      temperature: T_init,
      volume: vol,
      label: `Node ${i}`,
    });
    solidNodes.push({
      id: `s${i}`,
      type: "solid",
      ...at(i, 80),
      temperature: T_init,
      mass: mass_solid,
      cp: cpCu,
      label: `Wall ${i}`,
    });
  }

  nodes.push({
    id: `f${N}`,
    type: "boundary",
    ...at(N, 0),
    pressure: P_out,
    temperature: T_out,
    label: "Outlet",
  });
  solidNodes.push({
    id: `s${N}`,
    type: "solid",
    ...at(N, 80),
    temperature: T_init,
    mass: mass_solid,
    cp: cpCu,
    label: "Wall outlet",
  });

  for (let i = 0; i <= N; i++) {
    conductors.push({
      id: `conv${i}`,
      from: i === N && outletWallCoupling === "upwind" ? `f${N - 1}` : `f${i}`,
      to: `s${i}`,
      type: {
        kind: "convection",
        area: convArea,
        correlation:
          correlationModel === "darrHartwig"
            ? {
                model: "darrHartwig" as const,
                diameter: D,
                flowArea: A_fluid,
                axialPosition: i * segL,
              }
            : correlationModel === "ttWf"
              ? {
                  model: "ttWf" as const,
                  diameter: D,
                  flowArea: A_fluid,
                  axialPosition: i * segL,
                  segmentLength: segL,
                  ...(fluidFront ? { fluidFront: true as const } : {}),
                }
              : {
                  model: "miropolskii" as const,
                  diameter: D,
                  flowArea: A_fluid,
                },
      },
      label: `Conv ${i}`,
    });
  }

  for (let i = 0; i < N; i++) {
    conductors.push({
      id: `cond${i}`,
      from: `s${i}`,
      to: `s${i + 1}`,
      type: { kind: "conduction", k: kCu, area: A_metal, length: segL },
      label: `Cond ${i}`,
    });
  }

  for (let i = 0; i < N; i++) {
    branches.push({
      id: `pipe${i}`,
      from: `f${i}`,
      to: `f${i + 1}`,
      component: { type: "pipe", length: segL, diameter: D, roughness },
      label: `Pipe ${i}`,
    });
  }

  const settings: NetworkConfig["settings"] = {
    mode: "transient",
    tolerance: 1e-5,
    maxIterations: 200,
    relaxation: 0.7,
    endTime,
    ...(timeStepping === "fixed"
      ? { dt, timeStepping: "fixed" as const }
      : {
          timeStepping: "adaptive" as const,
          adaptive: {
            dtInitial: dt,
            dtMin: 0.2,
            dtMax: 15,
            relTol: 5e-2,
            absTolP: 5000,
            absTolT: 2.0,
            safety: 0.9,
          },
        }),
  };

  return {
    meta: {
      name: `Cryogenic chilldown — two-phase ${fluidName} (NBS/GFSSP Fig.14)`,
      version: 2,
    },
    settings,
    fluid: { model: "realFluid", params: { fluidName } },
    nodes,
    solidNodes,
    conductors,
    branches,
  };
}

export const cryogenicLineChilldownTwoPhase: NetworkConfig =
  buildChilldownTwoPhase();

// Cryogenic line cooldown — SINDA/FLUINT validation (NBS Report 9264, Fig. 2).
// Saturated LH₂ at 75 psia (~517 kPa, ~27.3 K) admitted to a 61 m copper
// pipe (15.9 mm ID) initially at 300 K. Outlet open to atmosphere (0.82 atm).
// N=20 axial segments, each with a copper wall thermal mass and convective
// coupling. Cold LH₂ flushes through, boiling on the hot wall. The vapor
// phase does most of the cooling (sensible enthalpy >> latent heat for H₂,
// ratio ~14:1). Cooldown time ~100-120 s; 30-50 L of LH₂ consumed.
// C&R Tech validation note (May 2009): normal-H2 overpredicts, para-H2
// underpredicts by ~20%; test data bracketed between them.
//
// Wall material: NIST OFHC copper with TEMPERATURE-DEPENDENT cp(T) (named
// material 'ofhc-copper', core/solidProperties.ts — NIST Cryogenic Material
// Properties fit, 4–300 K).  cp falls from ~385 J/(kg·K) at 300 K to ~90 at
// 80 K and O(1) near 20 K, so wall masses accelerate their cooldown as they
// chill — a constant 385 J/(kg·K) materially over-predicts the cold-end
// cooldown time.
//
// Convection: Miropolskii film-boiling correlation (the legacy cryogenic
// closure used across the repo's chilldown builders).  No literal h is set.
//
// Inlet state: "saturated at 75 psia" (517 kPa) means
// T_inlet = Tsat(H₂, 517 kPa) ≈ 27.3 K, so the inlet boundary is
// specified with quality: 0 — the same convention the repo's NBS 9264
// digitization metadata uses for the "saturated" runs
// (validation/data/digitized/chilldown/nbs9264_runs_metadata.csv).
//
// Per-segment derived quantities (L_seg = 61/20 = 3.05 m):
//   fluid volume:  π/4 · ID² · L_seg ≈ 6.05e-4 m³
//   wall mass:     ρ_Cu · π/4 · (OD² − ID²) · L_seg ≈ 2.32 kg
//   wetted area:   π · ID · L_seg ≈ 0.152 m²
//
// NUMERICS NOTES:
//  - Internal nodes start at ambient outlet pressure (0.82 atm) with 300 K
//    fluid — the line is initially unpressurised before LH₂ admission.
//  - FIXED dt = 1 s keeps the stiff quench band resolved without the cost of
//    step-doubling adaptive trials through film-boiling transitions.
export const sindaFluintCryoLineCooldown: NetworkConfig = (() => {
  const N = 20;
  const segLen = 61 / N; // 3.05 m per segment
  const id = 0.0159; // 15.9 mm internal diameter
  const od = 0.019; // 19 mm outer diameter
  const roughness = 1.5e-6; // smooth copper
  const P_in = 517000; // 75 psia
  const P_out = 83000; // 0.82 atm (Boulder CO)
  const wallAreaPerSeg = Math.PI * id * segLen; // internal surface area per segment
  const wallMassPerSeg = 8960 * (Math.PI / 4) * (od ** 2 - id ** 2) * segLen; // copper wall mass per segment
  const fluidVolPerSeg = (Math.PI / 4) * id ** 2 * segLen; // fluid volume per segment

  const nodes: NetworkConfig["nodes"] = [
    {
      id: "inlet",
      type: "boundary",
      x: 0,
      y: 0,
      position: metres(0),
      pressure: P_in,
      quality: 0,
      label: "LH₂ supply (75 psia)",
    },
  ];
  for (let i = 1; i <= N; i++) {
    nodes.push({
      id: `n${i}`,
      type: "internal",
      x: 40 * i,
      y: 0,
      position: metres(i * segLen),
      volume: fluidVolPerSeg,
      temperature: 300,
      pressure: P_out,
      label: `Segment ${i}`,
    });
  }
  nodes.push({
    id: "outlet",
    type: "boundary",
    x: 40 * (N + 2),
    y: 0,
    position: metres((N + 1) * segLen),
    pressure: P_out,
    temperature: 300,
    label: "Outlet (atm)",
  });

  const branches: NetworkConfig["branches"] = [
    {
      id: "seg1",
      from: "inlet",
      to: "n1",
      component: { type: "pipe", length: segLen, diameter: id, roughness },
      label: "Segment 1",
    },
  ];
  for (let i = 1; i < N; i++) {
    branches.push({
      id: `seg${i + 1}`,
      from: `n${i}`,
      to: `n${i + 1}`,
      component: { type: "pipe", length: segLen, diameter: id, roughness },
      label: `Segment ${i + 1}`,
    });
  }
  branches.push({
    id: `seg${N + 1}`,
    from: `n${N}`,
    to: "outlet",
    component: { type: "pipe", length: segLen, diameter: id, roughness },
    label: `Segment ${N + 1}`,
  });

  const solidNodes: NetworkConfig["solidNodes"] = [];
  const conductors: NetworkConfig["conductors"] = [];
  for (let i = 1; i <= N; i++) {
    solidNodes.push({
      id: `wall${i}`,
      type: "solid",
      x: 40 * i,
      y: -80,
      // Same axial station as its fluid node (position.x feeds the derived
      // convection axialPosition), lifted to the copper wall mid-thickness
      // radius (ID/2 + OD/2)/2 so the wall sits on the tube, not in the bore.
      position: metres(i * segLen, 0, (id + od) / 4),
      temperature: 300,
      mass: wallMassPerSeg,
      cp: { material: "ofhc-copper" },
      label: `Wall ${i}`,
    });
    conductors.push({
      id: `conv${i}`,
      from: `wall${i}`,
      to: `n${i}`,
      type: {
        kind: "convection",
        area: wallAreaPerSeg,
        correlation: {
          model: "miropolskii",
          diameter: id,
          flowArea: (Math.PI / 4) * id ** 2,
        },
      },
      label: `Conv wall${i}-n${i}`,
    });
  }

  return {
    meta: {
      name: "Cryogenic line cooldown",
      version: 2,
    },
    settings: {
      mode: "transient",
      dt: 1,
      endTime: 80,
      timeStepping: "fixed",
      tolerance: 1e-6,
      maxIterations: 200,
      relaxation: 0.9,
    },
    fluid: { model: "realFluid", params: { fluidName: "Hydrogen" } },
    nodes,
    branches,
    solidNodes,
    conductors,
  };
})();

// Spacecraft radiator panel — basic ammonia loop heat pipe (steady).
//
// A wicked-evaporator ammonia LHP rejects avionics waste heat through a
// deployed flat radiator panel that doubles as the condenser. Liquid
// ammonia leaves the compensation chamber (CC), is driven around the loop
// by the wick's capillary pumping (modelled as a fixed pump curve rather
// than solving the porous-media capillary pressure directly), boils a
// small fraction to vapor in the evaporator core, and that vapor travels
// down the vapor line to the panel's serpentine condenser tube — the same
// four-pass, 8 mm tube bonded to an aluminum face sheet used by the
// original coolant-loop version of this example. Heat convects from the
// condensing ammonia into the tube-saddle strips, spreads through the face
// sheet BOTH along each pass and laterally across the inter-pass fins
// (genuine 2-D in-plane conduction), and every strip radiates to deep
// space at 4 K. The condensed (mostly) liquid returns through the liquid
// line to the CC, closing the loop.
//
// WHAT SETS THE FLOW (the bit that makes this a heat pipe and not a pumped
// liquid loop): an LHP's circulation is evaporation-limited, not pump-curve
// limited.  The wick passes exactly the liquid the applied heat can boil,
// ṁ = Q / h_fg, and the meniscus then raises whatever capillary head the
// loop happens to need — here only ~68 Pa, against the ~19 kPa a 2 µm-pore
// ammonia wick can raise (σ = 0.0187 N/m at 306 K, Δp_cap = 2σ/r), so the
// loop runs with ~270× capillary margin.  That is why the wick is a
// `flowSource` at ṁ = Q/h_fg and NOT a `pump` curve: sizing it any other
// way circulates far more liquid than the heat load can vaporize, the
// vapor line fills with mostly-liquid at a few percent quality, and the
// model quietly stops being a heat pipe.
//
// This is a deliberately simplified LHP: the CC is a fixed-state boundary
// node (saturated liquid at a set pressure/temperature) rather than a
// solved two-phase reservoir with its own inventory, and the wick is a
// prescribed flow rather than a solved porous-media pressure balance.
//
// OPERATING ENVELOPE (what the simplification costs).  A real LHP
// self-regulates by moving liquid inventory: if the radiator can reject
// more than the applied load, liquid backs up and FLOODS the surplus
// condenser length, and the CC — and with it the whole loop's saturation
// temperature — floats down until rejection equals the load.  A steady
// model with no inventory cannot flood anything, so the set point below is
// chosen to be the temperature at which this panel rejects this load; that
// is the same sizing calculation a thermal engineer does, just done once by
// hand instead of by the loop.  Consequences worth knowing before editing:
//   • raising the heat load is benign — the condenser stays fully two-phase
//     and residual vapor returns to the CC, which is exactly the real
//     over-driven behavior that eventually deprimes a loop;
//   • lowering it below the design load drives the model into the flooding
//     regime it cannot represent, and the subcooled tail runs away cold
//     instead of the condenser shortening.  Lower the CC set point (and so
//     P_CC and h_fg) alongside the load to stay on a physical design point.
//
// 3-D layout (z-up lab frame, metres): the panel lies FLAT in the x–y plane
// — deliberate, because in orbit there is no hydrostatic head, and a flat
// panel keeps every tube segment at the same z so the solver derives zero
// elevationChange for every pipe. Four passes along +x at 0.3 m pitch in
// y; the tube centreline rides 6 mm above the panel mid-plane; U-bend apex
// nodes bulge past the panel edges (x = 0 / 1.2 m); the deep-space sink
// hovers 1 m above the panel centre so the 21 radiation links fan upward.
// The evaporator sits 1.8 m off the panel's west edge with the CC bolted
// to its back end (that is where a CC lives on real hardware), joined by a
// 1.5 m vapor line and a 2.0 m, 4 mm liquid line — the long flexible
// transport lines being the whole reason to fly an LHP instead of a
// constant-conductance heat pipe.
//
// Hand numbers (the examples test asserts the resulting invariants):
//   flow    ṁ = 1.02 · Q/h_fg = 0.315 g/s at Q = 350 W, h_fg(306 K) =
//           1132 kJ/kg. The 2% is deliberate margin: it leaves the
//           evaporator exit at x ≈ 0.98 — essentially pure vapor, but
//           still ON the saturation line instead of balanced exactly at
//           x = 1, where the state would flip between saturated and
//           superheated between iterations.
//   loop    CC saturated liquid at Psat(306 K) = 1.269 MPa; total loop
//           Δp ≈ 68 Pa, so the loop is very nearly isobaric and Tsat
//           barely moves — an isothermal fluid IS the heat-pipe signature.
//           The temperature drops all sit across the hardware, not along
//           the fluid: 7.4 K wick-to-vapor at the evaporator, ~1–7 K
//           fluid-to-strip in the condenser, ~17 K strip-to-fin.
//   panel   21 strips × 0.045 m² at ε = 0.85 reject 350 W at ≈ 306 K,
//           which is what fixes the set point. Quality falls almost
//           linearly 0.98 → 0.03 over the first 11 strips at a dead-flat
//           306.00 K, then the last strip finishes condensation and
//           subcools the liquid 6.6 K to 299.4 K before it returns.
//   energy  350 W boiled = 350 W into the vapor; the panel radiates 360 W.
//           The 10 W difference is the CC boundary re-saturating the
//           returning subcooled liquid — in a real loop that is precisely
//           the evaporator→CC back-conduction the subcooling exists to
//           absorb, and 3% of load is a realistic heat leak.
export const spacecraftRadiatorPanel: NetworkConfig = (() => {
  const RUNS = 4; // serpentine passes along +x
  const STATIONS = 3; // fluid nodes per pass
  const RUN_Y = [0, 0.3, 0.6, 0.9]; // pass centrelines [m]
  const GAP_Y = [0.15, 0.45, 0.75]; // inter-pass fin centrelines [m]
  const STATION_X = [0.3, 0.6, 0.9]; // node stations along a pass [m]
  const STEP = 0.3; // station spacing [m]
  const TUBE_Z = 0.006; // tube centreline above panel mid-plane [m]
  const D = 0.008; // tube inner diameter [m]
  const ROUGHNESS = 1.5e-6; // drawn aluminum tube
  const H_COND = 3500; // condensing ammonia film, fixed h [W/m²K]
  const K_AL = 167; // 6061-T6 face sheet
  const SHEET_T = 0.0015; // face-sheet thickness [m]
  const STRIP_AREA = 0.045; // radiating area per strip (0.3 m × 0.15 m)
  const EMISSIVITY = 0.85; // white-paint radiator coating
  const CONV_AREA = Math.PI * D * STEP; // wetted tube area per fluid node
  const AXIAL_COND_AREA = SHEET_T * 0.15; // sheet cross-section along a pass
  const LATERAL_COND_AREA = SHEET_T * STEP; // sheet cross-section across a gap
  const LATERAL_COND_LEN = 0.15; // strip centre → fin centre [m]
  const STRIP_MASS = 0.25; // tube saddle + sheet strip [kg]
  const FIN_MASS = 0.18; // sheet-only strip [kg]
  const CP_AL = 900;

  // LHP loop: evaporator, compensation chamber, and transport lines.
  const Q_AVIONICS = 350; // avionics heat load boiled at the wick [W]
  const T_CC = 306; // CC set point = where this panel rejects this load [K]
  const P_CC = 1_268_609; // Psat(306 K) for ammonia [Pa] (CoolProp)
  const H_FG = 1_132_131; // hfg(306 K) for ammonia [J/kg] (CoolProp)
  const WICK_MARGIN = 1.02; // 2% unvaporized, so the exit stays at x < 1
  // Evaporation-limited circulation — see WHAT SETS THE FLOW above.
  const MDOT = (WICK_MARGIN * Q_AVIONICS) / H_FG; // 3.153e-4 kg/s
  const EVAP_LEN = 0.15; // evaporator body length [m]
  const EVAP_D = 0.02; // evaporator body diameter [m]
  const EVAP_AREA = Math.PI * EVAP_D * EVAP_LEN; // wick -> vapor wetted area
  const EVAP_H = 5000; // ammonia evaporation off a wick, fixed h [W/m²K]
  const VAPOR_LINE_LEN = 1.5; // evaporator -> condenser inlet [m]
  const LIQUID_LINE_LEN = 2.0; // condenser outlet -> CC [m]
  const D_LIQUID = 0.004; // liquid line runs narrower than the vapor line [m]

  // 1-based flow-order index of the tube-strip/fluid pair at pass r,
  // station s (odd passes run right→left, so their station order reverses).
  const fIndex = (r: number, s: number): number =>
    r % 2 === 0 ? r * STATIONS + s + 1 : r * STATIONS + (STATIONS - s);
  // Canvas px: 200 px per station, one row of 200 px per pass.
  const canvasX = (s: number) => 200 * (s + 1);
  const canvasY = (r: number) => 200 * r;

  const nodes: NetworkConfig["nodes"] = [
    {
      id: "cc",
      type: "boundary",
      x: -600,
      y: 400,
      // The CC is bolted to the back end of the evaporator body, as on
      // real hardware; it sets the loop's saturation pressure.
      position: metres(-2.1, 0, TUBE_Z),
      pressure: P_CC,
      quality: 0,
      label: "Compensation chamber",
    },
    {
      id: "evapIn",
      type: "internal",
      x: -600,
      y: 200,
      position: metres(-1.95, 0, TUBE_Z),
      pressure: P_CC,
      temperature: T_CC - 1,
      volume: 1e-5,
      label: "Evaporator inlet",
    },
    {
      id: "evapOut",
      type: "internal",
      x: -600,
      y: 0,
      position: metres(-1.8, 0, TUBE_Z),
      pressure: P_CC,
      quality: 1 / WICK_MARGIN,
      volume: 1e-5,
      label: "Evaporator outlet (vapor)",
    },
    {
      id: "condIn",
      type: "internal",
      x: -200,
      y: 0,
      position: metres(-0.3, 0, TUBE_Z),
      pressure: P_CC,
      quality: 1 / WICK_MARGIN,
      volume: 3e-5,
      label: "Condenser inlet",
    },
  ];
  const pathIds: string[] = ["condIn"];
  for (let r = 0; r < RUNS; r++) {
    const flowOrder = r % 2 === 0 ? [0, 1, 2] : [2, 1, 0];
    for (const s of flowOrder) {
      const idx = fIndex(r, s);
      nodes.push({
        id: `f${idx}`,
        type: "internal",
        x: canvasX(s),
        y: canvasY(r),
        position: metres(STATION_X[s], RUN_Y[r], TUBE_Z),
        pressure: P_CC - idx * 2,
        // Each strip condenses roughly the same power, so quality falls
        // almost linearly along the panel — guess that profile directly.
        quality: Math.max(0.02, (1 - idx / (RUNS * STATIONS)) / WICK_MARGIN),
        volume: 3e-5,
        label: `Coolant ${idx}`,
      });
      pathIds.push(`f${idx}`);
    }
    if (r < RUNS - 1) {
      // U-bend apex past the panel edge: east after even passes, west after odd.
      const east = r % 2 === 0;
      nodes.push({
        id: `u${r + 1}`,
        type: "internal",
        x: east ? 800 : 0,
        y: canvasY(r) + 100,
        position: metres(east ? 1.2 : 0, GAP_Y[r], TUBE_Z),
        pressure: P_CC - (r * STATIONS + 4) * 2,
        quality: Math.max(
          0.02,
          (1 - (r * STATIONS + 4) / (RUNS * STATIONS)) / WICK_MARGIN,
        ),
        volume: 3e-5,
        label: `U-bend ${r + 1}`,
      });
      pathIds.push(`u${r + 1}`);
    }
  }
  nodes.push({
    id: "condOut",
    type: "internal",
    x: -200,
    y: canvasY(RUNS - 1),
    position: metres(-0.3, RUN_Y[RUNS - 1], TUBE_Z),
    pressure: P_CC - 60,
    // Condensation finishes just inside the panel, so the returning liquid
    // leaves subcooled rather than saturated.
    temperature: T_CC - 2,
    volume: 3e-5,
    label: "Condenser outlet (subcooled liquid)",
  });
  pathIds.push("condOut");

  const branches: NetworkConfig["branches"] = [
    {
      id: "wick",
      from: "cc",
      to: "evapIn",
      // Evaporation-limited, not curve-limited: the wick passes exactly what
      // the heat load can boil and raises whatever head the loop needs.
      component: { type: "flowSource", massFlow: MDOT },
      label: "Capillary pump (wick)",
    },
    {
      id: "evapCore",
      from: "evapIn",
      to: "evapOut",
      component: {
        type: "pipe",
        length: EVAP_LEN,
        diameter: D,
        roughness: ROUGHNESS,
      },
      label: "Evaporator core",
    },
    {
      id: "vaporLine",
      from: "evapOut",
      to: "condIn",
      component: {
        type: "pipe",
        length: VAPOR_LINE_LEN,
        diameter: D,
        roughness: ROUGHNESS,
      },
      label: "Vapor line",
    },
  ];
  for (let i = 0; i < pathIds.length - 1; i++) {
    const from = pathIds[i];
    const to = pathIds[i + 1];
    const isManifold = from === "condIn" || to === "condOut";
    const isBend = from.startsWith("u") || to.startsWith("u");
    branches.push({
      id: `p${i + 1}`,
      from,
      to,
      component: {
        type: "pipe",
        // Manifold stubs are 0.6 m; each U-bend half is 0.3 m straight plus
        // a quarter-turn (~0.24 m) ≈ 0.55 m of tube; run segments are the
        // 0.3 m station pitch.
        length: isManifold ? 0.6 : isBend ? 0.55 : STEP,
        diameter: D,
        roughness: ROUGHNESS,
      },
      label: isManifold ? "Manifold" : isBend ? "U-bend" : "Run segment",
    });
  }
  branches.push({
    id: "liquidLine",
    from: "condOut",
    to: "cc",
    component: {
      type: "pipe",
      length: LIQUID_LINE_LEN,
      diameter: D_LIQUID,
      roughness: ROUGHNESS,
    },
    label: "Liquid line",
  });

  const solidNodes: NetworkConfig["solidNodes"] = [
    {
      id: "evaporator",
      type: "solid",
      x: -750,
      y: 100,
      position: metres(-1.875, 0, 0),
      temperature: T_CC + 8,
      mass: 0.6,
      cp: CP_AL,
      heatInput: Q_AVIONICS,
      label: "Avionics evaporator (wick + saddle)",
    },
  ];
  const conductors: NetworkConfig["conductors"] = [
    {
      id: "evapConv",
      from: "evaporator",
      to: "evapOut",
      type: { kind: "convection", h: EVAP_H, area: EVAP_AREA },
      label: "Wick -> vapor",
    },
  ];
  for (let r = 0; r < RUNS; r++) {
    for (let s = 0; s < STATIONS; s++) {
      const idx = fIndex(r, s);
      solidNodes.push({
        id: `w${idx}`,
        type: "solid",
        x: canvasX(s) - 60,
        y: canvasY(r) - 60,
        position: metres(STATION_X[s], RUN_Y[r], 0),
        temperature: 305,
        mass: STRIP_MASS,
        cp: CP_AL,
        label: `Tube strip ${idx}`,
      });
      conductors.push({
        id: `conv${idx}`,
        from: `w${idx}`,
        to: `f${idx}`,
        type: { kind: "convection", h: H_COND, area: CONV_AREA },
        label: `Conv w${idx}-f${idx}`,
      });
    }
  }
  // In-plane conduction ALONG each pass (through the sheet strip under the tube).
  let axialCount = 0;
  for (let r = 0; r < RUNS; r++) {
    for (let s = 0; s < STATIONS - 1; s++) {
      axialCount += 1;
      conductors.push({
        id: `ax${axialCount}`,
        from: `w${fIndex(r, s)}`,
        to: `w${fIndex(r, s + 1)}`,
        type: {
          kind: "conduction",
          k: K_AL,
          area: AXIAL_COND_AREA,
          length: STEP,
        },
        label: `Sheet along pass ${r + 1}`,
      });
    }
  }
  // Mid-gap fin strips plus lateral conduction ACROSS each gap.
  for (let g = 0; g < RUNS - 1; g++) {
    for (let s = 0; s < STATIONS; s++) {
      const finId = `fin${g + 1}${s + 1}`;
      solidNodes.push({
        id: finId,
        type: "solid",
        x: canvasX(s) + 60,
        y: canvasY(g) + 100,
        position: metres(STATION_X[s], GAP_Y[g], 0),
        temperature: 300,
        mass: FIN_MASS,
        cp: CP_AL,
        label: `Fin ${g + 1}-${s + 1}`,
      });
      conductors.push({
        id: `lat${g + 1}${s + 1}a`,
        from: `w${fIndex(g, s)}`,
        to: finId,
        type: {
          kind: "conduction",
          k: K_AL,
          area: LATERAL_COND_AREA,
          length: LATERAL_COND_LEN,
        },
        label: `Sheet across gap ${g + 1}`,
      });
      conductors.push({
        id: `lat${g + 1}${s + 1}b`,
        from: finId,
        to: `w${fIndex(g + 1, s)}`,
        type: {
          kind: "conduction",
          k: K_AL,
          area: LATERAL_COND_AREA,
          length: LATERAL_COND_LEN,
        },
        label: `Sheet across gap ${g + 1}`,
      });
    }
  }
  // Deep-space sink above the panel centre; every strip radiates to it.
  solidNodes.push({
    id: "space",
    type: "ambient",
    x: 1000,
    y: 300,
    position: metres(0.6, 0.45, 1),
    temperature: 4,
    label: "Deep space (4 K)",
  });
  for (let idx = 1; idx <= RUNS * STATIONS; idx++) {
    conductors.push({
      id: `radW${idx}`,
      from: `w${idx}`,
      to: "space",
      type: {
        kind: "radiation",
        emissivity: EMISSIVITY,
        area: STRIP_AREA,
        viewFactor: 1,
      },
      label: `Rad w${idx}-space`,
    });
  }
  for (let g = 0; g < RUNS - 1; g++) {
    for (let s = 0; s < STATIONS; s++) {
      conductors.push({
        id: `radF${g + 1}${s + 1}`,
        from: `fin${g + 1}${s + 1}`,
        to: "space",
        type: {
          kind: "radiation",
          emissivity: EMISSIVITY,
          area: STRIP_AREA,
          viewFactor: 1,
        },
        label: `Rad fin${g + 1}${s + 1}-space`,
      });
    }
  }

  return {
    meta: {
      name: "Spacecraft radiator panel (ammonia loop heat pipe)",
      version: 2,
    },
    settings: {
      mode: "steady",
      tolerance: 1e-8,
      maxIterations: 500,
      relaxation: 0.9,
    },
    fluid: { model: "realFluid", params: { fluidName: "Ammonia" } },
    nodes,
    solidNodes,
    conductors,
    branches,
  };
})();

/** Apply the curated presentation layout and explicit parameter relationships. */
function configureShippedExamples(): void {
  const required = <T>(value: T | undefined, kind: string, id: string): T => {
    if (!value)
      throw new Error(
        `Example configuration references missing ${kind} '${id}'`,
      );
    return value;
  };
  const position = (
    config: NetworkConfig,
    id: string,
    x: number,
    y: number,
  ) => {
    const item =
      config.nodes.find((node) => node.id === id) ??
      config.solidNodes?.find((node) => node.id === id);
    Object.assign(required(item, "node", id), { x, y });
  };
  const addNote = (
    config: NetworkConfig,
    id: string,
    text: string,
    x: number,
    y: number,
    width?: number,
  ) => {
    if (!config.notes) config.notes = [];
    config.notes.push({
      id,
      text,
      x,
      y,
      ...(width !== undefined ? { width } : {}),
    });
  };
  const snapGrid = (v: number) =>
    Math.round(v / CANVAS_GRID_SIZE) * CANVAS_GRID_SIZE;
  /** Flow-space box around every node glyph plus room for labels below. */
  const modelBounds = (config: NetworkConfig) => {
    const pts = [
      ...config.nodes.map((n) => ({ x: n.x, y: n.y })),
      ...(config.solidNodes ?? []).map((n) => ({ x: n.x, y: n.y })),
    ];
    const glyphPad = 20;
    const labelPad = 45;
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    return {
      minX: arrayMin(xs) - glyphPad,
      minY: arrayMin(ys) - glyphPad,
      maxX: arrayMax(xs) + glyphPad,
      maxY: arrayMax(ys) + labelPad,
    };
  };
  /** Place a note under the model so it never sits on top of nodes or labels. */
  const placeNoteBelow = (
    config: NetworkConfig,
    id: string,
    text: string,
    width: number,
    gap = 30,
  ) => {
    const b = modelBounds(config);
    addNote(config, id, text, snapGrid(b.minX), snapGrid(b.maxY + gap), width);
  };
  const bind = (target: object, field: string, expr: string) => {
    (target as Record<string, unknown>)[field] = { expr };
  };
  const branch = (config: NetworkConfig, id: string) =>
    required(
      config.branches.find((item) => item.id === id),
      "branch",
      id,
    ).component;
  const conductor = (config: NetworkConfig, id: string) =>
    required(
      config.conductors?.find((item) => item.id === id),
      "conductor",
      id,
    ).type;
  const node = (config: NetworkConfig, id: string) =>
    required(
      config.nodes.find((item) => item.id === id),
      "node",
      id,
    );
  const solid = (config: NetworkConfig, id: string) =>
    required(
      config.solidNodes?.find((item) => item.id === id),
      "solid node",
      id,
    );
  const correlation = (config: NetworkConfig, id: string) => {
    const type = conductor(config, id);
    if (type.kind !== "convection" || !type.correlation)
      throw new Error(`Conductor '${id}' has no correlation`);
    return type.correlation;
  };

  position(sanityOrificeHandCalc, "in", 2, 2);
  position(sanityOrificeHandCalc, "out", 197, 2);

  const junctionPositions: Array<[string, number, number]> = [
    ["in", 2, 2],
    ["j", 199, 4],
    ["out1", 407, 107],
    ["out2", 407, -103],
  ];
  junctionPositions.forEach(([id, x, y]) =>
    position(threePipeJunction, id, x, y),
  );
  for (const id of ["b2", "b3"])
    bind(branch(threePipeJunction, id), "roughness", "pipe('b1').roughness");

  position(tankBlowdown, "tank", 4, 4);
  position(tankBlowdown, "ambient", 302, 2);

  const waterPositions: Array<[string, number, number]> = [
    ["SRC", 2, 2],
    ["N0", 154, 4],
    ["N1", 304, 4],
    ["N2", 454, 124],
    ["N3", 454, 4],
    ["N4", 454, -116],
    ["N5", 604, 4],
    ["N6", 754, -71],
    ["N7", 754, 79],
    ["D_LOW", 902, -73],
    ["D_HIGH", 902, 77],
  ];
  waterPositions.forEach(([id, x, y]) =>
    position(waterDistributionNetwork, id, x, y),
  );
  for (const id of [
    "leg1_p",
    "leg2_p",
    "leg3_p",
    "ret1",
    "ret2",
    "dis_low",
    "dis_high",
  ])
    bind(
      branch(waterDistributionNetwork, id),
      "roughness",
      "pipe('main').roughness",
    );
  for (const id of ["leg2_p", "leg3_p"]) {
    bind(
      branch(waterDistributionNetwork, id),
      "length",
      "pipe('leg1_p').length",
    );
    bind(
      branch(waterDistributionNetwork, id),
      "diameter",
      "pipe('leg1_p').diameter",
    );
  }
  for (const id of ["leg2_v", "leg3_v"]) {
    bind(branch(waterDistributionNetwork, id), "area", "branch('leg1_v').area");
    bind(branch(waterDistributionNetwork, id), "cd", "branch('leg1_v').cd");
  }
  for (const field of ["length", "diameter"])
    bind(
      branch(waterDistributionNetwork, "ret2"),
      field,
      `pipe('ret1').${field}`,
    );
  for (const id of ["dis_low", "dis_high"])
    bind(
      branch(waterDistributionNetwork, id),
      "diameter",
      "pipe('ret1').diameter",
    );
  bind(
    branch(waterDistributionNetwork, "dis_high"),
    "length",
    "pipe('dis_low').length",
  );

  const heatedPositions: Array<[string, number, number]> = [
    ["in", 2, 302],
    ["f1", 199, 304],
    ["f2", 409, 304],
    ["out", 602, 302],
    ["w1", 197, 152],
    ["w2", 407, 152],
    ["amb", 302, 2],
  ];
  heatedPositions.forEach(([id, x, y]) =>
    position(heatedPipeRadiatingWall, id, x, y),
  );
  bind(node(heatedPipeRadiatingWall, "f2"), "volume", "node('f1').volume");
  for (const field of ["length", "diameter", "roughness"])
    bind(
      branch(heatedPipeRadiatingWall, "b_mid"),
      field,
      `pipe('b_in').${field}`,
    );
  for (const field of ["temperature", "mass", "heatInput"])
    bind(solid(heatedPipeRadiatingWall, "w2"), field, `solid('w1').${field}`);
  bind(conductor(heatedPipeRadiatingWall, "c2"), "h", "conductor('c1').h");
  for (const field of ["emissivity", "area", "viewFactor"])
    bind(
      conductor(heatedPipeRadiatingWall, "c5"),
      field,
      `conductor('c4').${field}`,
    );

  position(gfsspEx5WaterWaterHX, "h_in", 2, 2);
  position(gfsspEx5WaterWaterHX, "h_out", 977, 2);
  position(gfsspEx5WaterWaterHX, "c_out", 2, 212);
  position(gfsspEx5WaterWaterHX, "c_in", 977, 212);
  for (let i = 1; i <= 12; i++) {
    position(gfsspEx5WaterWaterHX, `h${i}`, 4 + 75 * i, 4);
    position(gfsspEx5WaterWaterHX, `w${i}`, 2 + 75 * i, 107);
    position(gfsspEx5WaterWaterHX, `c${i}`, 4 + 75 * i, 214);
    if (i > 1) {
      bind(node(gfsspEx5WaterWaterHX, `h${i}`), "volume", "node('h1').volume");
      bind(node(gfsspEx5WaterWaterHX, `c${i}`), "volume", "node('c1').volume");
      bind(solid(gfsspEx5WaterWaterHX, `w${i}`), "mass", "solid('w1').mass");
      bind(
        solid(gfsspEx5WaterWaterHX, `w${i}`),
        "temperature",
        "solid('w1').temperature",
      );
    }
    if (i > 1) {
      for (const prefix of ["hw", "cw"]) {
        bind(
          conductor(gfsspEx5WaterWaterHX, `${prefix}${i}`),
          "h",
          `conductor('${prefix}1').h`,
        );
        bind(
          conductor(gfsspEx5WaterWaterHX, `${prefix}${i}`),
          "area",
          `conductor('${prefix}1').area`,
        );
      }
    }
    if (i > 0) {
      bind(
        branch(gfsspEx5WaterWaterHX, `hb${i}`),
        "massFlow",
        "branch('hb0').massFlow",
      );
      bind(
        branch(gfsspEx5WaterWaterHX, `cb${i}`),
        "massFlow",
        "branch('cb0').massFlow",
      );
    }
  }

  const extensionPositions: Array<[string, number, number]> = [
    ["tank", 2, 4],
    ["ambient", 302, 2],
  ];
  extensionPositions.forEach(([id, x, y]) =>
    position(extensionAdvancedExample, id, x, y),
  );

  position(sindaFluintCryoLineCooldown, "inlet", 2, 2);
  position(sindaFluintCryoLineCooldown, "outlet", 947, 2);
  for (let i = 1; i <= 20; i++) {
    position(sindaFluintCryoLineCooldown, `n${i}`, 4 + 45 * i, 4);
    position(sindaFluintCryoLineCooldown, `wall${i}`, 2 + 45 * i, -73);
    bind(
      node(sindaFluintCryoLineCooldown, `n${i}`),
      "volume",
      `pipe('seg${i}').volume`,
    );
    if (i > 1) {
      bind(
        solid(sindaFluintCryoLineCooldown, `wall${i}`),
        "mass",
        "solid('wall1').mass",
      );
      bind(
        solid(sindaFluintCryoLineCooldown, `wall${i}`),
        "temperature",
        "solid('wall1').temperature",
      );
    }
    bind(
      conductor(sindaFluintCryoLineCooldown, `conv${i}`),
      "area",
      `pipe('seg${i}').surfaceArea`,
    );
    const corr = correlation(sindaFluintCryoLineCooldown, `conv${i}`);
    bind(corr, "diameter", `pipe('seg${i}').diameter`);
    bind(corr, "flowArea", `pipe('seg${i}').area`);
  }
  for (let i = 2; i <= 21; i++) {
    for (const field of ["length", "diameter", "roughness"])
      bind(
        branch(sindaFluintCryoLineCooldown, `seg${i}`),
        field,
        `pipe('seg1').${field}`,
      );
  }

  for (let i = 2; i <= 10; i++) {
    for (const field of ["length", "diameter", "roughness"])
      bind(
        branch(leeMartinEntrappedAir, `p${i}`),
        field,
        `pipe('p1').${field}`,
      );
  }

  placeNoteBelow(
    sanityOrificeHandCalc,
    "overview",
    "Press Run and check the flow on the orifice branch.\nWater goes from 200 kPa to 100 kPa through a small opening.\nBy hand the flow is about 0.849 kg/s. The solver should match within 0.5%.",
    255,
  );
  placeNoteBelow(
    threePipeJunction,
    "overview",
    "Water enters one pipe and splits into two.\nThe two outlets are at different pressures, so the split is not even.\nPress Run. The two branch flows should add up to the inlet flow.",
    255,
  );
  placeNoteBelow(
    tankBlowdown,
    "overview",
    "A tank of air starts at 500 kPa.\nIt vents through a hole to outside air at 101 kPa.\nPress Run and watch tank pressure fall over 5 seconds.",
    240,
  );
  placeNoteBelow(
    waterDistributionNetwork,
    "overview",
    "A pump pushes water through pipes to three paths.\nEach path has a valve that can be partly open.\nSome pipes go up or down, which changes how hard the pump must work.\nChange valve settings to send more or less flow down each path.",
    270,
  );
  placeNoteBelow(
    heatedPipeRadiatingWall,
    "overview",
    "Water flows through a pipe.\nThe pipe walls are heated (5000 W on each wall piece).\nHeat moves from the walls into the water, along the walls, and out to 300 K air.\nPress Run to see the steady temperatures.",
    270,
  );
  placeNoteBelow(
    gfsspEx5WaterWaterHX,
    "overview",
    "Reference: GFSSP Example 5.\n\nTwo water streams pass each other in opposite directions.\nThey exchange heat through a wall between them.\nHot water moves left to right. Cold water moves right to left.\nThere are 12 segments. After Run, outlet temps should be within 0.44 K (hot) and 0.19 K (cold) of the published values.",
    285,
  );
  placeNoteBelow(
    leeMartinEntrappedAir,
    "overview",
    "Reference: GFSSP Figure 10 (Lee & Martin).\n\nWater fills a long pipe. Trapped air sits at the far end.\nEach pipe segment has fluid inertia — flow cannot change instantly.\nAt about 0.15 s the valve opens.\nPress Run and watch pressure go up and down at node 12.",
    285,
  );
  placeNoteBelow(
    sindaFluintCryoLineCooldown,
    "overview",
    "Reference: NBS Report 9264, Figure 2 (SINDA/FLUINT validation case).\n\nCooldown of an LH2 cryogenic transfer line.\nSaturated liquid hydrogen enters a warm copper pipe; the wall chills station by station.\nPress Run and watch the quench front move down the line.",
    300,
  );
  placeNoteBelow(
    spacecraftRadiatorPanel,
    "overview",
    "A wicked evaporator boils ammonia with 350 W of avionics heat; the vapor travels 1.5 m to a flat radiator panel that condenses it, and the liquid returns to the compensation chamber.\nThere is no mechanical pump: the wick passes exactly the liquid the heat can boil (0.32 g/s) and raises the ~68 Pa the loop needs.\nThe panel lies flat in the x-y plane (microgravity, so no hydrostatic head) - switch to 3D and orbit to see it.\nPress Run: the vapor line should carry x = 0.98 vapor, quality should fall to ~0 along a dead-flat 306 K condenser, and the last strip should subcool the returning liquid ~6 K.\nThe temperature drops are in the hardware, not the fluid - 7 K across the wick, ~17 K from tube strip to fin. A near-isothermal fluid is what makes it a heat pipe.",
    285,
  );
  placeNoteBelow(
    extensionAdvancedExample,
    "overview",
    "A cold nitrogen tank receives 400 W of heat.\nWhen pressure gets too high, the vent opens. When it gets low enough, the vent closes.\nThe open/close band is 5 psi wide around ~3.2 bar.\nLogic rules set ventOpen. A controller drives the valve fully open (1) or closed (0).\nRegisters count vent events and track peak pressure.",
    270,
  );
}

configureShippedExamples();

export const exampleGroups: Record<string, string[]> = {
  "Verify-by-inspection": ["Sanity: orifice hand-calc"],
  Applications: [
    "Three-pipe junction",
    "Tank blowdown",
    "Water distribution network",
    "Heated pipe with radiating wall (conjugate HT)",
    "Spacecraft radiator panel (ammonia loop heat pipe)",
    "LOX/RP-1 thruster (combustor)",
    "LOX/RP-1 thruster (transient startup)",
  ],
  Benchmarks: [
    "Water-water counterflow heat exchanger",
    "Entrapped-air line",
    "Cryogenic line cooldown",
  ],
  Extensibility: [
    "Extension: Cryo tank vent control (transient)",
    "LH2 tank no-vent fill",
  ],
};

/**
 * Cavitating venturi for N₂O.
 *
 * Inlet: 5.5158 MPa / 244.26 K (subcooled liquid)
 * Outlet: 3.4474 MPa (500 psia)
 * Throat: 2.5 mm diameter inside 12.7 mm inlet
 *
 * Design: 3 gradual contraction steps + 6 gradual diffuser steps.
 * Hand loss budget (AreaChange formulas, all K referred to throat head):
 *   K_c ≈ 0.414 (contraction total)
 *   K_d ≈ 0.264 (diffuser total)
 *   K_total ≈ 0.678
 * Predicted all-liquid throat P = P_in − (1+K_c)·q
 *   where q = (P_in−P_out)/K_total ≈ 3.05 MPa
 *   → P_throat,liquid ≈ 1.20 MPa < Pv (1.365 MPa)
 * Therefore the cavitating state is thermodynamically required.
 *
 * INITIALIZATION: the throat node is seeded at
 * the vapor dome (P = Pv(244.26 K) = 1.365 235 MPa, quality 0.001).  The
 * cavitating state is thermodynamically required (loss budget above), so
 * seeding the throat in the flashing regime is the physically-correct
 * initialization — not a numerics hack.  An ALL-LIQUID start was tried
 * first: the single giant step dt = endTime = 0.01 s then has no exact
 * discrete root (the c3 node's energy residual has a ~1.6 kW floor —
 * storage in the tiny volume cannot balance the advective enthalpy excess
 * of a full 4.0→1.37 MPa depressurisation in one step), the solver
 * reported converged = false with a robust compromise state, and
 * the UI showed a red "Not converged" badge for a shipped example.
 * Refining dt (0.001, 0.0005 s) did NOT produce a root either (the
 * flashing/choking floor is structural, not a step-size artifact —
 * verified).  With the dome seed the shipped dt meets residual tolerance
 * (scaled residual ~6e-11) in ~9 s, with physics unchanged vs the old
 * compromise state (throat P within ~0.2 % of Pv, choked mdot 0.385 kg/s,
 * effective Cd ≈ 0.84, downstream mdot spread < 4 %).  The all-liquid-init
 * no-root case remains exercised (and documented) in
 * cavitatingVenturi.test.ts via the test-local builder.
 */
export const nitrousOxideCavitatingVenturi: NetworkConfig = {
  meta: { name: "N₂O cavitating venturi", version: 2 },
  settings: {
    mode: "transient",
    dt: 0.01,
    endTime: 0.01,
    tolerance: 1e-6,
    maxIterations: 200,
    relaxation: 0.5,
  },
  fluid: { model: "realFluid", params: { fluidName: "NitrousOxide" } },
  nodes: [
    {
      id: "inlet",
      type: "boundary",
      x: 0,
      y: 0,
      position: metres(0),
      pressure: 5.5158e6,
      temperature: 244.26,
      label: "Inlet",
    },
    {
      id: "c1",
      type: "internal",
      x: 100,
      y: 0,
      position: metres(0.02),
      pressure: 4.0e6,
      temperature: 244.26,
      volume: 1e-6,
      label: "Contraction 1",
    },
    {
      id: "c2",
      type: "internal",
      x: 200,
      y: 0,
      position: metres(0.04),
      pressure: 4.0e6,
      temperature: 244.26,
      volume: 1e-6,
      label: "Contraction 2",
    },
    {
      id: "c3",
      type: "internal",
      x: 300,
      y: 0,
      position: metres(0.06),
      pressure: 4.0e6,
      temperature: 244.26,
      volume: 1e-6,
      label: "Contraction 3",
    },
    {
      id: "throat",
      type: "internal",
      x: 400,
      y: 0,
      position: metres(0.08),
      pressure: 1.365235e6,
      quality: 0.001,
      volume: 1e-5,
      label: "Throat",
    },
    {
      id: "d1",
      type: "internal",
      x: 500,
      y: 0,
      position: metres(0.1),
      pressure: 4.0e6,
      temperature: 244.26,
      volume: 1e-6,
      label: "Diffuser 1",
    },
    {
      id: "d2",
      type: "internal",
      x: 600,
      y: 0,
      position: metres(0.12),
      pressure: 4.0e6,
      temperature: 244.26,
      volume: 1e-6,
      label: "Diffuser 2",
    },
    {
      id: "d3",
      type: "internal",
      x: 700,
      y: 0,
      position: metres(0.14),
      pressure: 4.0e6,
      temperature: 244.26,
      volume: 1e-6,
      label: "Diffuser 3",
    },
    {
      id: "d4",
      type: "internal",
      x: 800,
      y: 0,
      position: metres(0.16),
      pressure: 4.0e6,
      temperature: 244.26,
      volume: 1e-6,
      label: "Diffuser 4",
    },
    {
      id: "d5",
      type: "internal",
      x: 900,
      y: 0,
      position: metres(0.18),
      pressure: 4.0e6,
      temperature: 244.26,
      volume: 1e-6,
      label: "Diffuser 5",
    },
    {
      id: "d6",
      type: "internal",
      x: 1000,
      y: 0,
      position: metres(0.2),
      pressure: 4.0e6,
      temperature: 244.26,
      volume: 1e-6,
      label: "Diffuser 6",
    },
    {
      id: "outlet",
      type: "boundary",
      x: 1100,
      y: 0,
      position: metres(0.22),
      pressure: 3.4474e6,
      temperature: 244.26,
      label: "Outlet",
    },
  ],
  branches: [
    // 3 contraction steps: area ratio ≈ 2.96 per step
    {
      id: "ac_c1",
      from: "inlet",
      to: "c1",
      component: { type: "areaChange", areaIn: 1.2674e-4, areaOut: 4.2875e-5 },
      label: "Contraction 1",
    },
    {
      id: "ac_c2",
      from: "c1",
      to: "c2",
      component: { type: "areaChange", areaIn: 4.2875e-5, areaOut: 1.4509e-5 },
      label: "Contraction 2",
    },
    {
      id: "ac_c3",
      from: "c2",
      to: "c3",
      component: { type: "areaChange", areaIn: 1.4509e-5, areaOut: 4.9087e-6 },
      label: "Contraction 3",
    },
    {
      id: "ac_c4",
      from: "c3",
      to: "throat",
      component: { type: "areaChange", areaIn: 4.9087e-6, areaOut: 4.9087e-6 },
      label: "Throat",
    },
    // 6 diffuser steps: area ratio ≈ 1.72 per step
    {
      id: "ac_d1",
      from: "throat",
      to: "d1",
      component: { type: "areaChange", areaIn: 4.9087e-6, areaOut: 8.4352e-6 },
      label: "Diffuser 1",
    },
    {
      id: "ac_d2",
      from: "d1",
      to: "d2",
      component: { type: "areaChange", areaIn: 8.4352e-6, areaOut: 1.4493e-5 },
      label: "Diffuser 2",
    },
    {
      id: "ac_d3",
      from: "d2",
      to: "d3",
      component: { type: "areaChange", areaIn: 1.4493e-5, areaOut: 2.4894e-5 },
      label: "Diffuser 3",
    },
    {
      id: "ac_d4",
      from: "d3",
      to: "d4",
      component: { type: "areaChange", areaIn: 2.4894e-5, areaOut: 4.2764e-5 },
      label: "Diffuser 4",
    },
    {
      id: "ac_d5",
      from: "d4",
      to: "d5",
      component: { type: "areaChange", areaIn: 4.2764e-5, areaOut: 7.3472e-5 },
      label: "Diffuser 5",
    },
    {
      id: "ac_d6",
      from: "d5",
      to: "d6",
      component: { type: "areaChange", areaIn: 7.3472e-5, areaOut: 1.2617e-4 },
      label: "Diffuser 6",
    },
    {
      id: "ac_d7",
      from: "d6",
      to: "outlet",
      component: { type: "areaChange", areaIn: 1.2617e-4, areaOut: 1.2674e-4 },
      label: "Outlet",
    },
  ],
};

/**
 * N₂O cavitating venturi — analytical choked-flow closure (steady).
 *
 * This is the Stage-5 steady counterpart to the emergent transient example
 * above.  It uses the dedicated `cavitatingVenturi` component with a tuned
 * recoveryFactor (0.55) that reproduces the diffuser recovery of the
 * 6-step areaChange cascade, so the throat is pinned at Pv even though the
 * outlet pressure (3.4474 MPa) is well above Pv.  Cd = 0.84 is the effective
 * discharge coefficient measured from the emergent model, making the two
 * directly comparable.
 *
 * Operating point:
 *   Inlet:  244.26 K / 5.5158 MPa (subcooled liquid)
 *   Outlet: 244.26 K / 3.4474 MPa (500 psia)
 *   Throat: 2.5 mm diameter → A ≈ 4.9087e-6 m²
 */
export const nitrousOxideCavitatingVenturiSteady: NetworkConfig = {
  meta: {
    name: "N₂O cavitating venturi (choked-flow closure, steady)",
    version: 2,
  },
  settings: {
    mode: "steady",
    tolerance: 1e-6,
    maxIterations: 200,
    relaxation: 0.9,
  },
  fluid: { model: "realFluid", params: { fluidName: "NitrousOxide" } },
  nodes: [
    {
      id: "inlet",
      type: "boundary",
      x: 0,
      y: 0,
      position: metres(0),
      pressure: 5.5158e6,
      temperature: 244.26,
      label: "Inlet",
    },
    {
      id: "outlet",
      type: "boundary",
      x: 300,
      y: 0,
      position: metres(0.22),
      pressure: 3.4474e6,
      temperature: 244.26,
      label: "Outlet",
    },
  ],
  branches: [
    {
      id: "cv",
      from: "inlet",
      to: "outlet",
      component: {
        type: "cavitatingVenturi",
        throatArea: 4.9087e-6,
        cd: 0.84,
        recoveryFactor: 0.55,
      },
      label: "Cavitating venturi",
    },
  ],
};

/**
 * The shipped example library — these 13 entries populate the UI
 * **Examples ▾** dropdown (see `exampleGroups`) and are the configs
 * covered by the examples-library round-trip/physics tests.
 *
 * NOTE: several other configs and builder functions are exported from this
 * file above (the remaining `sanity*` configs, `pumpStartup`, the GFSSP
 * benchmark configs, the N₂O venturi pair, `cryogenicLineChilldownTwoPhase`,
 * and the `build*` builders). Those are test/script-only exports consumed
 * by the validation suites (sanity-examples, gfssp-benchmarks, nureth,
 * chilldown*, cavitatingVenturi, canvasLayout) and by the research scripts
 * under scripts/ — they are deliberately NOT in this record, so they do not
 * appear in the dropdown.
 */
export const examples: Record<string, NetworkConfig> = {
  "Sanity: orifice hand-calc": sanityOrificeHandCalc,
  "Three-pipe junction": threePipeJunction,
  "Tank blowdown": tankBlowdown,
  "Water distribution network": waterDistributionNetwork,
  "Heated pipe with radiating wall (conjugate HT)": heatedPipeRadiatingWall,
  "Spacecraft radiator panel (ammonia loop heat pipe)": spacecraftRadiatorPanel,
  "LOX/RP-1 thruster (combustor)": thrusterCombustor,
  "LOX/RP-1 thruster (transient startup)": thrusterCombustorTransient,
  "Water-water counterflow heat exchanger": gfsspEx5WaterWaterHX,
  "Entrapped-air line": leeMartinEntrappedAir,
  "Extension: Cryo tank vent control (transient)": extensionAdvancedExample,
  "Cryogenic line cooldown": sindaFluintCryoLineCooldown,
  "LH2 tank no-vent fill": lh2StorageTankNoVentFill,
};
