import type { NetworkConfig } from "./types";

/** Pressure band for vent logic: 5 psi wide, top at ~3.2 bar. */
const PSI = 6894.757293168361;
const P_HIGH = 320_000;
const P_LOW = P_HIGH - 5 * PSI;
const P_INIT = P_LOW - 10_000;

/**
 * Cryogenic storage tank with parasitic heat leak, a vent valve, and the full
 * declarative extensibility stack: registers + logic (hysteresis band) +
 * register-following controller (bang-bang vent actuation).
 */
export const extensionAdvancedExample: NetworkConfig = {
  meta: { name: "Extension: Cryo tank vent control (transient)", version: 2 },
  settings: {
    mode: "transient",
    dt: 0.2,
    endTime: 120,
    timeStepping: "fixed",
    tolerance: 1e-6,
    maxIterations: 200,
    relaxation: 0.9,
  },
  fluid: { model: "realFluid", params: { fluidName: "Nitrogen" } },
  registers: {
    P_low: P_LOW,
    P_high: P_HIGH,
    ventOpen: 0,
    peakP: P_INIT,
    ventEvents: 0,
    acceptedSteps: 0,
  },
  logic: [
    {
      id: "init",
      on: "init",
      when: "1",
      set: {
        ventOpen: "0",
        peakP: `${P_INIT}`,
        ventEvents: "0",
        acceptedSteps: "0",
      },
    },
    {
      id: "open-vent",
      on: "stepStart",
      when: "node('tank').P > P_high && ventOpen == 0",
      set: { ventOpen: "1", ventEvents: "ventEvents + 1" },
    },
    {
      id: "close-vent",
      on: "stepStart",
      when: "node('tank').P < P_low && ventOpen == 1",
      set: { ventOpen: "0" },
    },
    {
      id: "track",
      on: "stepAccepted",
      when: "1",
      set: {
        acceptedSteps: "acceptedSteps + 1",
        peakP: "max(peakP, node('tank').P)",
      },
    },
    {
      id: "stop",
      on: "stepAccepted",
      when: "acceptedSteps >= 90",
      stop: true,
      reason: "Demo run complete",
    },
  ],
  controllers: [
    {
      id: "ventActuator",
      type: "register",
      register: "ventOpen",
      output: { kind: "valvePosition", id: "vent" },
      limits: { min: 0, max: 1 },
    },
  ],
  nodes: [
    {
      id: "tank",
      type: "internal",
      x: 0,
      y: 0,
      position: { x: 0, y: 0, z: 0 },
      pressure: P_INIT,
      temperature: 77,
      volume: 0.05,
      heatInput: 400,
      label: "LN₂ ullage",
    },
    {
      id: "ambient",
      type: "boundary",
      x: 200,
      y: 0,
      position: { x: 1, y: 0, z: 0 },
      pressure: 101_325,
      temperature: 300,
      label: "Vent atmosphere",
    },
  ],
  branches: [
    {
      id: "vent",
      from: "tank",
      to: "ambient",
      component: { type: "valve", area: 5e-7, cd: 0.6, position: 0 },
      label: "Vent valve",
    },
  ],
};
