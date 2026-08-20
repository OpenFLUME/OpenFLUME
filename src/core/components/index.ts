/**
 * Branch (fluid-pipe) component models — public entry point.
 *
 * Each component implements BranchComponent (branchComponent.ts): a
 * pressureDrop(mdot, rho, mu, ...) method, an optional pressureDropDual for
 * exact Jacobian derivatives, and optional getBranchHeat for components that
 * exchange heat with the stream. One file per component, split by concern:
 *
 *   branchComponent.ts      BranchComponent interface + interpolateSchedule
 *                            (shared by Valve/FlowSource schedule lookups).
 *   frictionFactor.ts        smoothstep, RE_LAMINAR/RE_TURBULENT, and the
 *                            Darcy friction factor (scalar + dual) shared by
 *                            Pipe/HeatedPipe/Bend.
 *   pipe.ts                  Pipe — Darcy–Weisbach with Swamee–Jain friction.
 *   heatedPipe.ts             HeatedPipe — Pipe + wall heat transfer
 *                            (optionally via the Miropolskii correlation).
 *   orifice.ts                Orifice — ΔP = mdot²/(2ρ(CdA)²).
 *   orificeCompressible.ts    OrificeCompressible — ideal-gas choked/unchoked
 *                            isentropic mass-flux orifice.
 *   cavitatingVenturi.ts      CavitatingVenturi — real-fluid venturi with a
 *                            smooth choked/non-choked cavitation blend.
 *   flowResistance.ts        FlowResistance — generic constant-K resistance.
 *   customResistance.ts      CustomResistance — constant K or a tabulated
 *                            K(Re) piecewise-linear closure.
 *   valve.ts                  Valve — position-scheduled effective-CdA orifice.
 *   checkValve.ts             CheckValve — orifice forward, smoothly blocked
 *                            reverse flow (the strictly open/closed check
 *                            valve: instantaneous, no dynamics).
 *   dynamicCheckValve.ts      DynamicCheckValve — spring-mass-damper poppet
 *                            position ODE, integrated once per accepted
 *                            transient step (opening lag, slam-shut, chatter).
 *   reliefValve.ts            ReliefValve — crack/full-open opening fraction
 *                            plus check-valve reverse blocking.
 *   regulator.ts              Regulator — softmin downstream-pressure residual.
 *   pump.ts                   Pump — pressure-rise vs. volumetric-flow curve.
 *   bend.ts                   Bend — Idelchik/Crane K-factor + arc friction.
 *   areaChange.ts             AreaChange — sudden expansion/contraction with
 *                            Bernoulli recovery.
 *   flowSource.ts             FlowSource — imposed mass flow (schedule or
 *                            controller override).
 *   dpTable.ts                DpTable — tabulated ΔP(mdot) characteristic.
 *   userDefinedComponent.ts   UserDefinedComponent — sandboxed user-code
 *                            component (usercode/sandbox.ts).
 *
 * This file only re-exports; it has no logic of its own.
 */
export type { BranchComponent } from "./branchComponent";
export { interpolateSchedule } from "./branchComponent";

export {
  RE_LAMINAR,
  RE_TURBULENT,
  darcyFrictionFactor,
  darcyFrictionFactorDual,
} from "./frictionFactor";

export { Pipe } from "./pipe";
export { HeatedPipe } from "./heatedPipe";
export { Orifice } from "./orifice";
export { OrificeCompressible } from "./orificeCompressible";
export { CavitatingVenturi } from "./cavitatingVenturi";
export { FlowResistance } from "./flowResistance";
export { CustomResistance } from "./customResistance";
export { Valve } from "./valve";
export { CheckValve } from "./checkValve";
export { DynamicCheckValve } from "./dynamicCheckValve";
export { ReliefValve } from "./reliefValve";
export { Regulator } from "./regulator";
export { Pump } from "./pump";
export { Bend } from "./bend";
export { AreaChange } from "./areaChange";
export { FlowSource } from "./flowSource";
export { DpTable } from "./dpTable";
export { UserDefinedComponent } from "./userDefinedComponent";
