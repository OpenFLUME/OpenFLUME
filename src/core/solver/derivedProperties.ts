/**
 * Reporting-only derived properties, shared by the steady result packer
 * (solver/steady.ts) and the transient trajectory recorder
 * (transient/resultRecorder.ts) so that the two modes publish the SAME
 * quantities computed the SAME way.
 *
 * Nothing here is on a solver hot path: every function is called once per
 * element per published state (once for a steady solve, once per accepted
 * step for a transient one).  That budget is what makes it affordable to ask
 * CoolProp for entropy / sound speed / conductivity, which the Newton
 * iterations never need.
 *
 * Two rules govern the whole module:
 *
 *   Omission — every field is optional and is OMITTED rather than defaulted
 *   when the underlying model cannot supply it: absolute entropy has no
 *   reference state in the analytic fluid models, sound speed and cp are not
 *   single-valued inside the two-phase dome, and mass flux / dynamic
 *   pressure are meaningless for a component with no flow area.  An absent
 *   field becomes an absent channel downstream (ui/channels.ts), never a
 *   fabricated zero.
 *
 *   Property lookups never throw — an out-of-range CoolProp flash must not
 *   take down an otherwise converged result, so a failed lookup degrades to
 *   `undefined` and the field is simply absent.  The one deliberate exception
 *   is the component's own pressure-drop closure: a user component that
 *   raises, or returns a non-finite ΔP, is a broken model and must surface as
 *   a UserCodeError naming the branch rather than as a silently missing
 *   number.
 *
 * Bit-identity: the velocity / Reynolds / ΔP / Mach arithmetic below is the
 * code that used to live inline in steady.ts, moved verbatim, so existing
 * steady results are unchanged.
 */
import {
  Pipe,
  FlowSource,
  Regulator,
  OrificeCompressible,
  CavitatingVenturi,
} from "../components";
import type { FluidModel } from "../fluids";
import { RealFluid } from "../fluids/realFluid";
import { componentPressureDrop } from "./pressureDrop";
import type { ConductorEntry, SolverContext, StepState } from "./types";

/**
 * Copy without the undefined-valued keys, so an unavailable property leaves
 * no trace in the serialized result at all.
 */
export function definedOnly<T extends object>(obj: T | undefined): Partial<T> {
  const out: Partial<T> = {};
  if (!obj) return out;
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k as keyof T] = v as T[keyof T];
  }
  return out;
}

/** Evaluate `fn`, mapping any throw or non-finite result to undefined. */
function attempt(fn: () => number | undefined): number | undefined {
  try {
    const v = fn();
    return typeof v === "number" && Number.isFinite(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

/* ------------------------------------------------------------------ */
/* Fluid nodes                                                         */
/* ------------------------------------------------------------------ */

/** Thermodynamic/transport state of one fluid node beyond (P, T, ρ). */
export interface NodeDerivedProperties {
  /** Specific enthalpy h [J/kg]. */
  enthalpy?: number;
  /** Specific internal energy u [J/kg]. */
  internalEnergy?: number;
  /** Absolute specific entropy s [J/(kg·K)] — real fluids only. */
  entropy?: number;
  /** Dynamic viscosity μ [Pa·s]. */
  viscosity?: number;
  /** Isobaric specific heat cp [J/(kg·K)]. */
  specificHeat?: number;
  /** Thermal conductivity k [W/(m·K)]. */
  thermalConductivity?: number;
  /** Isentropic speed of sound a [m/s]. */
  speedOfSound?: number;
}

function fluidForNode(
  ctx: SolverContext,
  nodeId: string,
): FluidModel | undefined {
  try {
    return ctx.fluidAssignment.node(nodeId);
  } catch {
    return undefined;
  }
}

/**
 * Species networks carry composition, so the mixture rules — not the
 * single-substance model attached to the node — define h, u, cp and μ.
 */
function mixtureNodeProperties(
  ctx: SolverContext,
  state: StepState,
  nodeId: string,
  P: number,
  T: number,
): NodeDerivedProperties | undefined {
  const mix = ctx.mixtureFluid;
  const Y = state.nodeY?.get(nodeId);
  if (!ctx.hasSpecies || !mix || !Y) return undefined;
  return {
    enthalpy: attempt(() => mix.enthalpyMix(P, T, Y)),
    internalEnergy: attempt(() => mix.internalEnergyMix(P, T, Y)),
    specificHeat: attempt(() => mix.cpMix(P, T, Y)),
    viscosity: attempt(() => mix.viscosityMix(P, T, Y)),
    speedOfSound: attempt(() =>
      Math.sqrt(mix.gammaMix(P, T, Y) * mix.R_mix(Y) * T),
    ),
  };
}

/**
 * Reporting properties of one fluid node at the given solver state.
 *
 * Real fluids are evaluated on the (P, h) path so the values stay correct
 * inside the two-phase dome, where a PT flash is degenerate; h comes from
 * the solver's own enthalpy state when the run carries one.  Analytic models
 * use their PT closures directly.
 */
export function nodeDerivedProperties(
  ctx: SolverContext,
  state: StepState,
  nodeId: string,
): NodeDerivedProperties {
  const P = state.nodeP.get(nodeId);
  const T = state.nodeT.get(nodeId);
  if (
    P === undefined ||
    T === undefined ||
    !Number.isFinite(P) ||
    !Number.isFinite(T)
  )
    return {};

  const mu = state.nodeMu.get(nodeId);
  const viscosity =
    typeof mu === "number" && Number.isFinite(mu) && mu > 0 ? mu : undefined;

  const mixture = mixtureNodeProperties(ctx, state, nodeId, P, T);
  if (mixture) return { ...mixture, viscosity: viscosity ?? mixture.viscosity };

  const fluid = fluidForNode(ctx, nodeId);
  if (!fluid) return { viscosity };

  if (fluid instanceof RealFluid) {
    const h = state.nodeH?.get(nodeId) ?? attempt(() => fluid.enthalpy(P, T));
    if (h === undefined) return { viscosity };
    const bulk = fluid.reportingPropertiesPH(P, h);
    return { enthalpy: h, viscosity, ...bulk };
  }

  return {
    enthalpy: attempt(() => fluid.enthalpy(P, T)),
    internalEnergy: attempt(() => fluid.internalEnergy(P, T)),
    entropy: attempt(() => fluid.entropy?.(P, T)),
    viscosity,
    specificHeat: attempt(() => fluid.cp(P, T)),
    thermalConductivity: attempt(() => fluid.thermalConductivity?.(P, T)),
    speedOfSound: attempt(() => fluid.speedOfSound?.(P, T)),
  };
}

/** Reporting properties for every fluid node, keyed by node id. */
export function nodeDerivedMap(
  ctx: SolverContext,
  state: StepState,
  nodeIds: Iterable<string>,
): Map<string, NodeDerivedProperties> {
  const out = new Map<string, NodeDerivedProperties>();
  for (const id of nodeIds) out.set(id, nodeDerivedProperties(ctx, state, id));
  return out;
}

/* ------------------------------------------------------------------ */
/* Branches                                                            */
/* ------------------------------------------------------------------ */

/** Flow quantities of one branch derived from its mass flow and endpoints. */
export interface BranchDerivedProperties {
  /** Bulk velocity V = ṁ/(ρA) at the upstream endpoint state [m/s]. */
  velocity: number;
  /** Branch pressure drop [Pa], signed with the flow direction. */
  dP: number;
  /** Reynolds number based on the component's characteristic length. */
  reynolds: number;
  /** Mach number |V|/a — only when the fluid model supplies a sound speed. */
  mach?: number;
  /** Volumetric flow Q = ṁ/ρ [m³/s]. */
  volumetricFlow?: number;
  /** Mass flux G = ṁ/A [kg/(m²·s)] — only for components with a flow area. */
  massFlux?: number;
  /** Dynamic pressure ½ρV² [Pa] — only for components with a flow area. */
  dynamicPressure?: number;
}

/**
 * Flow quantities of branch `j` at the given solver state.
 *
 * `nodeProps` supplies the upstream node's already-computed sound speed so
 * the Mach number costs no extra property evaluation; without it, the
 * fluid model's own `speedOfSound` is consulted.  `t` is the simulation time
 * handed to time-scheduled components — omit it for steady solves.
 *
 * ΔP is the component's own pressure-drop closure evaluated at this state
 * (including the elevation head), which is exactly the branch momentum row.
 * With settings.momentumFlux the acceleration term is part of that row too,
 * but its value is scheme-dependent (upwind donor faces, tapered areas,
 * junction-inlet exclusions — kernel.ts), so instead of re-deriving the
 * stencil here the converged row itself is used:
 * P_from − P_to = ΔP + ΔP_accel + ΔP_inertia, hence the reported total is
 * P_from − P_to less the fluid-inertia term (supplied via `prevState`/`dt`
 * by the transient recorder; zero for steady solves).  At steady convergence
 * it equals P_from − P_to; during a transient with fluid inertia it
 * deliberately does not, since the balance also carries ∂ṁ/∂t.  The closure
 * is still the one call here allowed to throw: a user component that raises
 * or returns a non-finite ΔP fails loudly, naming the branch, instead of
 * quietly publishing a substitute number.
 */
export function branchDerivedProperties(
  ctx: SolverContext,
  state: StepState,
  j: number,
  nodeProps?: Map<string, NodeDerivedProperties>,
  t?: number,
  opts?: { prevState?: StepState; dt?: number },
): BranchDerivedProperties {
  const b = ctx.branches[j];
  const mdot = state.mdots[j];
  const upNode = mdot >= 0 ? b.from : b.to;
  const downNode = mdot >= 0 ? b.to : b.from;
  let rho = state.nodeRho.get(upNode)!;
  const mu = state.nodeMu.get(upNode)!;
  if ((b.component.elevationChange ?? 0) !== 0) {
    const rhoDown = state.nodeRho.get(downNode)!;
    rho = 0.5 * (rho + rhoDown);
  }
  // Upstream-endpoint flow area (areaOut when the flow enters at the
  // tapered component's outlet end; identical to area otherwise).
  const flowArea =
    mdot >= 0 ? b.component.area : (b.component.areaOut ?? b.component.area);
  const A = flowArea ?? 1;
  const v = mdot / (rho * A);
  const charLen =
    b.component instanceof Pipe
      ? b.component.diameter
      : b.component.area
        ? Math.sqrt((4 * A) / Math.PI)
        : 1;
  const Re = (rho * Math.abs(v) * charLen) / mu;

  let dP: number;
  if (
    b.component instanceof FlowSource ||
    b.component instanceof OrificeCompressible ||
    b.component instanceof CavitatingVenturi ||
    b.component instanceof Regulator
  ) {
    const pFrom = state.nodeP.get(b.from)!;
    const pTo = state.nodeP.get(b.to)!;
    dP = pFrom - pTo;
  } else {
    const pFrom = state.nodeP.get(b.from)!;
    const pTo = state.nodeP.get(b.to)!;
    const upT = state.nodeT.get(upNode)!;
    dP = componentPressureDrop(
      mdot,
      rho,
      mu,
      b.component,
      t,
      upT,
      ctx.fluidAssignment.branch(b.id),
      pFrom,
      pTo,
    );
    // Reported dP mirrors the momentum row: with settings.momentumFlux the
    // acceleration term is part of the branch pressure balance.  Its value
    // is scheme-dependent (see the doc comment above), so it is recovered
    // from the converged row rather than re-derived here.
    if (ctx.momentumFlux) {
      let inertiaTerm = 0;
      if (
        opts?.dt !== undefined &&
        opts.prevState !== undefined &&
        b.inertia &&
        b.component instanceof Pipe
      ) {
        const L = b.component.length;
        const A = b.component.area;
        inertiaTerm = ((L / A) * (mdot - opts.prevState.mdots[j])) / opts.dt;
      }
      dP = pFrom - pTo - inertiaTerm;
    }
  }

  const out: BranchDerivedProperties = { velocity: v, dP, reynolds: Re };

  const a =
    nodeProps?.get(upNode)?.speedOfSound ??
    branchSoundSpeed(ctx, state, b.id, upNode);
  if (a !== undefined && a > 0) out.mach = Math.abs(v) / a;

  if (rho > 0) out.volumetricFlow = mdot / rho;
  if (flowArea !== undefined && flowArea > 0) {
    out.massFlux = mdot / flowArea;
    out.dynamicPressure = 0.5 * rho * v * v;
  }
  return out;
}

/** Sound speed of the branch fluid at the upstream endpoint, or undefined. */
function branchSoundSpeed(
  ctx: SolverContext,
  state: StepState,
  branchId: string,
  upNode: string,
): number | undefined {
  const T = state.nodeT.get(upNode);
  const P = state.nodeP.get(upNode);
  if (T === undefined || P === undefined) return undefined;
  return attempt(() => {
    const fluid = ctx.fluidAssignment.branch(branchId);
    // Real fluids would need a fresh CoolProp flash here; the caller passes
    // the node map precisely so that path is not taken per branch.
    return fluid instanceof RealFluid ? undefined : fluid.speedOfSound?.(P, T);
  });
}

/* ------------------------------------------------------------------ */
/* Conductors                                                          */
/* ------------------------------------------------------------------ */

/**
 * Wall heat flux q″ = Q/A [W/m²].  Every conductor kind (conduction,
 * convection, radiation) carries a transfer area, so this is defined
 * whenever the area is positive.
 */
export function conductorHeatFlux(
  cond: ConductorEntry,
  heatRate: number,
): number | undefined {
  const area = cond.type.area;
  if (typeof area !== "number" || !Number.isFinite(area) || area <= 0)
    return undefined;
  if (!Number.isFinite(heatRate)) return undefined;
  return heatRate / area;
}
