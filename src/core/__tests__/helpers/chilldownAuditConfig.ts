/**
 * Shared builder for the "standard two-phase chilldown run at nominal
 * parameters" — the audit/validation case: N=4 segments of the full 60.96 m
 * LN₂ line, saturated-liquid inlet at 0.5169 MPa (quality 0), warm-vapour
 * outlet at 101325 Pa / 300 K, fixed dt=15 s to t=300 s.
 *
 * Mirrors buildChilldownTwoPhase({segments:4, length:60.96,
 * drivingPressure:0.5169e6, outletPressure:101325, dt:15, endTime:300,
 * timeStepping:'fixed'}) from src/ui/examples.ts, duplicated inline because
 * core tests must not import from src/ui (layering + parallel-work ownership).
 */
import type { NetworkConfig } from "../../schema";

export function buildAuditChilldownConfig(): NetworkConfig {
  const N = 4;
  const L = 60.96;
  const P_in = 0.5169e6;
  const P_out = 101325;
  const T_out = 300;
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

  const nodes: NetworkConfig["nodes"] = [
    {
      id: "f0",
      type: "boundary",
      x: 0,
      y: 0,
      position: { x: 0 },
      pressure: P_in,
      quality: 0,
    },
  ];
  const solidNodes: NetworkConfig["solidNodes"] = [
    {
      id: "s0",
      type: "solid",
      x: 0,
      y: 80,
      position: { x: 0 },
      temperature: T_out,
      mass: mass_solid,
      cp: cpCu,
    },
  ];
  for (let i = 1; i < N; i++) {
    const x = i * segL;
    const p0 = P_in - (P_in - P_out) * (i / N);
    nodes.push({
      id: `f${i}`,
      type: "internal",
      x,
      y: 0,
      position: { x },
      pressure: p0,
      temperature: T_out,
      volume: vol,
    });
    solidNodes.push({
      id: `s${i}`,
      type: "solid",
      x,
      y: 80,
      position: { x },
      temperature: T_out,
      mass: mass_solid,
      cp: cpCu,
    });
  }
  nodes.push({
    id: `f${N}`,
    type: "boundary",
    x: L,
    y: 0,
    position: { x: L },
    pressure: P_out,
    temperature: T_out,
  });
  solidNodes.push({
    id: `s${N}`,
    type: "solid",
    x: L,
    y: 80,
    position: { x: L },
    temperature: T_out,
    mass: mass_solid,
    cp: cpCu,
  });

  const conductors: NetworkConfig["conductors"] = [];
  for (let i = 0; i <= N; i++) {
    conductors.push({
      id: `conv${i}`,
      from: `f${i}`,
      to: `s${i}`,
      type: {
        kind: "convection",
        area: convArea,
        correlation: { model: "miropolskii", diameter: D, flowArea: A_fluid },
      },
    });
  }
  for (let i = 0; i < N; i++) {
    conductors.push({
      id: `cond${i}`,
      from: `s${i}`,
      to: `s${i + 1}`,
      type: { kind: "conduction", k: kCu, area: A_metal, length: segL },
    });
  }
  const branches: NetworkConfig["branches"] = [];
  for (let i = 0; i < N; i++) {
    branches.push({
      id: `pipe${i}`,
      from: `f${i}`,
      to: `f${i + 1}`,
      component: { type: "pipe", length: segL, diameter: D, roughness },
    });
  }

  return {
    meta: { name: "audit chilldown N=4", version: 2 },
    settings: {
      mode: "transient",
      tolerance: 1e-5,
      maxIterations: 200,
      relaxation: 0.7,
      endTime: 300,
      dt: 15,
      timeStepping: "fixed",
    },
    fluid: { model: "realFluid", params: { fluidName: "Nitrogen" } },
    nodes,
    solidNodes,
    conductors,
    branches,
  };
}
