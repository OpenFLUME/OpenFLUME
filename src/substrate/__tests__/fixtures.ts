/**
 * Representative network-config fixtures for the text-projection tests.
 *
 * These mirror a small representative subset of the ui/examples library —
 * a simple junction, a conjugate-thermal network (solids + conductors), a
 * component-library example with multiline user code, and a pump/valve/
 * elevation network. They are duplicated here, rather than imported from
 * ui/examples, to keep the substrate layer dependent only on core. The full
 * examples-library round-trip sweep lives in the UI layer at
 * src/ui/tests/examplesTextRoundTrip.test.ts.
 *
 * All fixtures are canonical v2 configs.
 */

import type { NetworkConfig } from "../../core";

/** Simple steady junction (plain pipes only). */
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
      position: { x: 0, y: 0, z: 0 },
      pressure: 300000,
      temperature: 300,
      label: "Inlet",
    },
    {
      id: "j",
      type: "internal",
      x: 200,
      y: 0,
      position: { x: 2, y: 0, z: 0 },
      pressure: 250000,
      temperature: 300,
      label: "Junction",
    },
    {
      id: "out1",
      type: "boundary",
      x: 400,
      y: 100,
      position: { x: 2, y: 3, z: 0 },
      pressure: 200000,
      temperature: 300,
      label: "Out 1",
    },
    {
      id: "out2",
      type: "boundary",
      x: 400,
      y: -100,
      position: { x: 2, y: -4, z: 0 },
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

/** Conjugate-heat-transfer network: fluid nodes + solid nodes + conductors. */
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
      position: { x: 0, y: 0, z: 0 },
      pressure: 200_000,
      temperature: 300,
      label: "Inlet",
    },
    {
      id: "f1",
      type: "internal",
      x: 200,
      y: 300,
      position: { x: 0.5, y: 0, z: 0 },
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
      position: { x: 1, y: 0, z: 0 },
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
      position: { x: 1, y: 0, z: 0 },
      pressure: 100_000,
      temperature: 300,
      label: "Outlet",
    },
  ],
  solidNodes: [
    {
      id: "w1",
      type: "solid",
      x: 200,
      y: 150,
      position: { x: 0.5, y: 0, z: 0 },
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
      position: { x: 1, y: 0, z: 0 },
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
      position: { x: 0.5, y: 0, z: 0.5 },
      temperature: 300,
      label: "Ambient",
    },
  ],
  conductors: [
    {
      id: "c1",
      from: "w1",
      to: "f1",
      type: { kind: "convection", h: 1000, area: 0.1 },
      label: "Conv w1-f1",
    },
    {
      id: "c2",
      from: "w2",
      to: "f2",
      type: { kind: "convection", h: 1000, area: 0.1 },
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

/** Component-library example with multiline defineComponent source code. */
export const embeddedKResistance: NetworkConfig = {
  meta: { name: "Extension: embedded K resistance", version: 2 },
  settings: {
    mode: "steady",
    tolerance: 1e-9,
    maxIterations: 200,
    relaxation: 0.9,
  },
  fluid: { model: "incompressible", preset: "water" },
  componentLibrary: {
    "embedded-k": {
      format: "defineComponent",
      description:
        "Self-contained K-factor resistance embedded in this network.",
      metadata: {
        name: "embedded-k",
        label: "Embedded K resistance",
        params: [{ name: "K", default: 2, min: 0 }],
      },
      code: `defineComponent({
  metadata: { name: 'embedded-k', label: 'Embedded K resistance', params: [{ name: 'K', default: 2, min: 0 }] },
  pressureDrop(args) {
    const area = args.area ?? 1e-4;
    return args.params.K * args.mdot * Math.abs(args.mdot) / (2 * args.rho * area * area);
  }
});`,
    },
  },
  nodes: [
    {
      id: "in",
      type: "boundary",
      x: 0,
      y: 0,
      position: { x: 0, y: 0, z: 0 },
      pressure: 200_000,
      temperature: 300,
      label: "200 kPa",
    },
    {
      id: "out",
      type: "boundary",
      x: 240,
      y: 0,
      position: { x: 0, y: 0, z: 0 },
      pressure: 100_000,
      temperature: 300,
      label: "100 kPa",
    },
  ],
  branches: [
    {
      id: "loss",
      from: "in",
      to: "out",
      component: {
        type: "userComponent",
        component: "embedded-k",
        area: 1e-4,
        params: { K: 2 },
      },
      label: "Embedded K=2",
    },
  ],
};

/** Pump/valve/elevation distribution network. */
export const waterDistributionNetwork: NetworkConfig = {
  meta: { name: "Water distribution network", version: 2 },
  settings: {
    mode: "steady",
    tolerance: 1e-8,
    maxIterations: 500,
    relaxation: 0.8,
  },
  fluid: { model: "incompressible", preset: "water" },
  nodes: [
    {
      id: "SRC",
      type: "boundary",
      x: 0,
      y: 0,
      position: { x: 0, y: 0, z: 0 },
      pressure: 200_000,
      temperature: 300,
      label: "Supply",
    },
    {
      id: "N0",
      type: "internal",
      x: 150,
      y: 0,
      position: { x: 0, y: 0, z: 0 },
      pressure: 400_000,
      temperature: 300,
      label: "Pump out",
    },
    {
      id: "N1",
      type: "internal",
      x: 300,
      y: 0,
      position: { x: 5, y: 0, z: 0 },
      pressure: 350_000,
      temperature: 300,
      label: "Header",
    },
    {
      id: "N2",
      type: "internal",
      x: 450,
      y: 120,
      position: { x: 13, y: 3, z: 3 },
      pressure: 300_000,
      temperature: 300,
      label: "Leg1 mid",
    },
    {
      id: "N3",
      type: "internal",
      x: 450,
      y: 0,
      position: { x: 13, y: 0, z: 0 },
      pressure: 300_000,
      temperature: 300,
      label: "Leg2 mid",
    },
    {
      id: "N4",
      type: "internal",
      x: 450,
      y: -120,
      position: { x: 13, y: -3, z: -3 },
      pressure: 300_000,
      temperature: 300,
      label: "Leg3 mid",
    },
    {
      id: "N5",
      type: "internal",
      x: 600,
      y: 0,
      position: { x: 13, y: 0, z: 0 },
      pressure: 250_000,
      temperature: 300,
      label: "Return merge",
    },
    {
      id: "N6",
      type: "internal",
      x: 750,
      y: -80,
      position: { x: 19, y: -2, z: 0 },
      pressure: 200_000,
      temperature: 300,
      label: "Return low",
    },
    {
      id: "N7",
      type: "internal",
      x: 750,
      y: 80,
      position: { x: 19, y: 2, z: 0 },
      pressure: 200_000,
      temperature: 300,
      label: "Return high",
    },
    {
      id: "D_LOW",
      type: "boundary",
      x: 900,
      y: -80,
      position: { x: 23, y: -2, z: -5 },
      pressure: 150_000,
      temperature: 300,
      label: "Discharge low",
    },
    {
      id: "D_HIGH",
      type: "boundary",
      x: 900,
      y: 80,
      position: { x: 23, y: 2, z: 5 },
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

/** The fixtures keyed by their display names (as the ui/examples map does). */
export const fixtures: Record<string, NetworkConfig> = {
  "Three-pipe junction": threePipeJunction,
  "Heated pipe with radiating wall (conjugate HT)": heatedPipeRadiatingWall,
  "Extension: embedded K resistance": embeddedKResistance,
  "Water distribution network": waterDistributionNetwork,
};
