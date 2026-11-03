/**
 * Capillary-network state: node wetting, meniscus integration and the
 * discrete events of capillary-driven microfluidics.
 *
 * Every CapillaryChannel's pressure drop is a pure function of its frozen
 * fill state (components/capillaryChannel.ts).  This module is the ONLY
 * place that state changes, once per ACCEPTED transient step (driven from
 * transient/statefulComponents.ts, with snapshot/rollback for adaptive
 * step-doubling candidates), plus once at construction to settle the
 * initial condition.
 *
 * Per accepted step of size dt ending at time t:
 *
 *  1. Each channel is updated against the node wetness at the START of the
 *     step (so the result does not depend on branch order):
 *       filling       the meniscus ODE is integrated across the step
 *                     (RK4 sub-steps) against a Thevenin equivalent of the
 *                     rest of the network seen from the channel's two
 *                     nodes — driving-point conductance G_th of the
 *                     network linearised at the solved state:
 *                       q(s) = [q0 (1 + G_th R(s0)) − G_th k (s − s0)]
 *                              / (1 + G_th R(s)),
 *                       R(s) = r_liq s + r_gas (L − s),  k = ρ g Δz / L
 *                     (q0 = solved flow, s0 = fill during the solve).
 *                     G_th → ∞ (fixed-pressure reservoirs) recovers the
 *                     pressure-driven Washburn law exactly, including its
 *                     stiff early phase (velocity ∝ 1/s); G_th → 0 (a
 *                     syringe pump) gives q = q0 exactly.  Between, the
 *                     channel's own resistance change is exact and only
 *                     the coupling between simultaneously moving fronts is
 *                     O(dt).
 *                     s ≤ 0  → pinnedInlet (front cannot drain a wet node)
 *                     s ≥ L  → pinnedOutlet when a stop valve guards the
 *                              exit, else full + the exit node is wetted
 *       pinnedInlet   reopens when P_wet − P_dry + P_cap > 0
 *       pinnedOutlet  bursts when P_wet − P_dry − ρ g Δz ≥ P_burst (exit
 *                     node wetted); recedes into the channel when
 *                     P_wet − P_dry − ρ g Δz + P_cap < 0
 *     (in a closed channel ṁ ≈ 0, so P_wet − P_dry is exactly the pressure
 *     difference the static meniscus is holding).
 *  2. Newly wetted nodes are committed; at each one, every incident
 *     capillary channel reacts:
 *       dry          starts filling from this end (pinnedInlet when its
 *                    capillary pressure is ≤ 0, i.e. a hydrophobic
 *                    entrance), or becomes trapped when its other end is
 *                    already wet (gas enclosed)
 *       pinnedOutlet whose exit is this node → full ("triggered": a
 *                    trigger valve released by liquid arriving from
 *                    elsewhere)
 *       filling / pinnedInlet whose DRY end is this node → trapped: the
 *                    gas column between its meniscus and the node can no
 *                    longer escape.
 *
 * Front overshoot past a channel end within one step is clamped (O(dt)
 * timing error per event, like any event-free lumped scheme); use smaller
 * or adaptive steps to resolve fast filling.
 */
import type { ResolvedNetworkConfig } from "./schema";
import type {
  CapillaryEvent,
  CapillaryEventKind,
  CapillarySnapshot,
} from "./schema";
import type { BuiltBranch } from "./componentFactory";
import {
  CAPILLARY_GRAVITY,
  CapillaryChannel,
  type FillSide,
} from "./components/capillaryChannel";
import { FlowSource, Pipe } from "./components";
import type { SolverContext, StepState } from "./solver/types";
import {
  componentPressureDrop,
  componentPressureDropDual,
} from "./solver/pressureDrop";
import { variable } from "./dual";

interface CapBranch {
  /** Index into the solver's branch arrays (StepState.mdots). */
  j: number;
  id: string;
  from: string;
  to: string;
  c: CapillaryChannel;
}

/** Target meniscus travel per RK4 sub-step, as a fraction of L. */
const SUBSTEP_FRACTION = 0.005;
const MAX_SUBSTEPS = 2000;

/**
 * Integrate ds/dt = v(s) from s0 over dt (RK4), stopping at the first exit
 * from [0, L].  Returns the end position (clamped) and, when an end was
 * reached, the time into the step at which it was reached (linear
 * interpolation inside the final sub-step).
 */
function integrateMeniscus(
  s0: number,
  dt: number,
  L: number,
  v: (s: number) => number,
): { s: number; tHit?: number } {
  const v0 = Math.abs(v(s0));
  const n = Math.min(
    MAX_SUBSTEPS,
    Math.max(1, Math.ceil((v0 * dt) / (SUBSTEP_FRACTION * L))),
  );
  const h = dt / n;
  let s = s0;
  for (let i = 0; i < n; i++) {
    const k1 = v(s);
    const k2 = v(s + 0.5 * h * k1);
    const k3 = v(s + 0.5 * h * k2);
    const k4 = v(s + h * k3);
    const prev = s;
    s += (h / 6) * (k1 + 2 * k2 + 2 * k3 + k4);
    if (s <= 0 || s >= L) {
      const edge = s <= 0 ? 0 : L;
      const frac = s === prev ? 1 : (edge - prev) / (s - prev);
      return { s: edge, tHit: (i + Math.min(1, Math.max(0, frac))) * h };
    }
  }
  return { s };
}

export interface CapillaryNetworkSnapshot {
  channels: Array<ReturnType<CapillaryChannel["snapshotState"]>>;
  wet: Array<[string, boolean]>;
  events: number;
}

/**
 * Initial wetness of a node: `initiallyWet` when given; otherwise a node is
 * dry exactly when every branch touching it is a capillaryChannel (nodes on
 * ordinary liquid branches are always liquid-filled).
 */
export function initialNodeWetness(config: {
  nodes: ReadonlyArray<{ id: string; initiallyWet?: boolean }>;
  branches: ReadonlyArray<{
    from: string;
    to: string;
    component: { type: string };
  }>;
}): Map<string, boolean> {
  const touchesOrdinary = new Set<string>();
  const touchesCapillary = new Set<string>();
  for (const b of config.branches) {
    const set =
      b.component.type === "capillaryChannel"
        ? touchesCapillary
        : touchesOrdinary;
    set.add(b.from);
    set.add(b.to);
  }
  const wet = new Map<string, boolean>();
  for (const n of config.nodes) {
    if (!touchesCapillary.has(n.id)) continue;
    wet.set(n.id, n.initiallyWet ?? touchesOrdinary.has(n.id));
  }
  return wet;
}

export class CapillaryNetwork {
  readonly channels: CapBranch[];
  /** Wetness of every node touched by a capillary channel. */
  readonly wet: Map<string, boolean>;
  /** Event log (time-ordered). */
  readonly events: CapillaryEvent[] = [];
  private readonly incident = new Map<string, number[]>();

  constructor(
    config: Pick<ResolvedNetworkConfig, "nodes" | "branches">,
    built: BuiltBranch[],
  ) {
    this.channels = [];
    built.forEach((b, j) => {
      if (b.component instanceof CapillaryChannel) {
        this.channels.push({
          j,
          id: b.id,
          from: b.from,
          to: b.to,
          c: b.component,
        });
      }
    });
    this.channels.forEach((cb, k) => {
      for (const n of [cb.from, cb.to]) {
        const list = this.incident.get(n) ?? [];
        list.push(k);
        this.incident.set(n, list);
      }
    });
    this.wet = initialNodeWetness(config);
    this.initialize();
  }

  /* -------------------------------------------------------------- */
  /* Initial condition                                               */
  /* -------------------------------------------------------------- */

  private initialize(): void {
    const toWet: Array<{ node: string; branch: string }> = [];
    for (const cb of this.channels) {
      const c = cb.c;
      c.fill = 0;
      c.side = 0;
      c.status = "dry";
      if (c.initialFill <= 0) continue;
      c.side = c.initialFillFrom === "from" ? 1 : -1;
      c.fill = Math.min(1, c.initialFill) * c.length;
      if (c.fill < c.length) {
        c.status = "filling";
        continue;
      }
      const exit = c.side === 1 ? cb.to : cb.from;
      if (this.wet.get(exit)) {
        c.status = "full";
      } else if (c.burstPressureAt(c.side === 1 ? "to" : "from")) {
        c.status = "pinnedOutlet";
      } else {
        c.status = "full";
        toWet.push({ node: exit, branch: cb.id });
      }
    }
    // Dry channels starting at an initially wet node.
    for (const [node, isWet] of this.wet) {
      if (isWet) this.onNodeWetted(node, 0);
    }
    this.commit(toWet, 0);
  }

  /* -------------------------------------------------------------- */
  /* Time integration                                                */
  /* -------------------------------------------------------------- */

  /** Advance every channel by one ACCEPTED step of size dt ending at t. */
  advance(ctx: SolverContext, state: StepState, dt: number, t: number): void {
    const firstEvent = this.events.length;
    const gTh = this.theveninConductances(ctx, state, dt, t);
    const toWet: Array<{ node: string; branch: string; time?: number }> = [];
    for (const cb of this.channels) {
      const c = cb.c;
      if (c.side === 0) continue; // dry, full-of-gas channels: nothing moves
      const dir = c.side;
      const wetEnd = dir === 1 ? cb.from : cb.to;
      const dryEnd = dir === 1 ? cb.to : cb.from;
      const exitEnd: "from" | "to" = dir === 1 ? "to" : "from";
      const pFrom = state.nodeP.get(cb.from)!;
      const pTo = state.nodeP.get(cb.to)!;
      const rho = state.nodeRho.get(wetEnd)!;
      const dPwet = dir * (pFrom - pTo);
      switch (c.status) {
        case "filling": {
          const mu = state.nodeMu.get(wetEnd)!;
          const rLiq = c.liquidResistance(mu) / c.length;
          const rGas = c.gasResistance() / c.length;
          const R = (s: number) => rGas * c.length + (rLiq - rGas) * s;
          const k =
            (rho * CAPILLARY_GRAVITY * dir * c.elevationChange) / c.length;
          const s0 = c.fill;
          const q0 = (dir * state.mdots[cb.j]) / rho;
          const G = gTh.get(cb.id) ?? Infinity;
          const D = dPwet + c.capillaryPressure;
          const v = Number.isFinite(G)
            ? (s: number) =>
                (q0 * (1 + G * R(s0)) - G * k * (s - s0)) /
                (c.area * (1 + G * R(s)))
            : (s: number) => (D - k * s) / (c.area * R(s));
          const { s, tHit } = integrateMeniscus(s0, dt, c.length, v);
          // Events are stamped at the interpolated arrival time; their
          // effect on the network starts with the next step.
          const tEvent = tHit === undefined ? t : t - dt + tHit;
          if (s <= 0) {
            c.fill = 0;
            c.status = "pinnedInlet";
            this.log(tEvent, "pinned", cb.id, wetEnd);
          } else if (s >= c.length) {
            c.fill = c.length;
            if (c.burstPressureAt(exitEnd) !== undefined) {
              c.status = "pinnedOutlet";
              this.log(tEvent, "pinned", cb.id, dryEnd);
            } else {
              c.status = "full";
              toWet.push({ node: dryEnd, branch: cb.id, time: tEvent });
            }
          } else {
            c.fill = s;
          }
          break;
        }
        case "pinnedInlet": {
          if (dPwet + c.capillaryPressure > 0) {
            c.status = "filling";
            this.log(t, "released", cb.id, wetEnd);
            // Liquid FORCED through the closed entrance during this step
            // (an imposed flow into an incompressible node has nowhere
            // else to go) did enter the channel; a pressure-driven pinned
            // meniscus passes only the ~1e-6 closed-branch leak.
            const q0 = (dir * state.mdots[cb.j]) / rho;
            if (q0 > 0) c.fill = Math.min(c.length, (q0 * dt) / c.area);
          }
          break;
        }
        case "pinnedOutlet": {
          const head = rho * CAPILLARY_GRAVITY * dir * c.elevationChange;
          const drive = dPwet - head;
          const burst = c.burstPressureAt(exitEnd)!;
          if (drive >= burst) {
            c.status = "full";
            this.log(t, "burst", cb.id, dryEnd);
            toWet.push({ node: dryEnd, branch: cb.id });
          } else if (drive + c.capillaryPressure < 0) {
            c.status = "filling";
            this.log(t, "released", cb.id, dryEnd);
          }
          break;
        }
        default:
          break; // full / trapped: no motion
      }
    }
    this.commit(toWet, t);
    // Keep the log time-ordered: events of one step carry interpolated
    // times and are produced channel by channel (stable sort).
    const tail = this.events.splice(firstEvent);
    tail.sort((x, y) => x.time - y.time);
    this.events.push(...tail);
  }

  /**
   * Driving-point conductance [m³/(s·Pa)] of the network seen by each
   * FILLING channel, excluding the channel itself — from the nodal
   * Laplacian of the network linearised at the solved state:
   *   z = eᵀ G⁻¹ e  (e = unit injection between the channel's nodes) is the
   *   driving-point resistance WITH the channel, so G_th = 1/z − g_channel.
   * Boundary nodes are grounded (fixed pressure); flow sources are open
   * circuits; a node left floating (only a flow source and closed branches)
   * is tied to ground by a 1e-12-relative conductance, giving G_th ≈ 0.
   * Infinity when both channel nodes are boundaries.
   */
  private theveninConductances(
    ctx: SolverContext,
    state: StepState,
    dt: number,
    t: number,
  ): Map<string, number> {
    const out = new Map<string, number>();
    const filling = this.channels.filter((cb) => cb.c.status === "filling");
    if (filling.length === 0) return out;
    const n = ctx.nInt;
    const idx = ctx.internalIndex;
    if (filling.every((cb) => !idx.has(cb.from) && !idx.has(cb.to))) {
      return out; // all pressure-driven: Infinity
    }
    const G: number[][] = Array.from({ length: n }, () =>
      new Array<number>(n).fill(0),
    );
    const gBranch = new Array<number>(ctx.nBranch).fill(0);
    for (let j = 0; j < ctx.nBranch; j++) {
      const b = ctx.branches[j];
      if (b.component instanceof FlowSource) continue;
      const g = branchConductance(ctx, state, j, dt, t);
      gBranch[j] = g;
      if (!(g > 0)) continue;
      const a = idx.get(b.from);
      const c = idx.get(b.to);
      if (a !== undefined) G[a][a] += g;
      if (c !== undefined) G[c][c] += g;
      if (a !== undefined && c !== undefined) {
        G[a][c] -= g;
        G[c][a] -= g;
      }
    }
    let maxDiag = 0;
    for (let i = 0; i < n; i++) maxDiag = Math.max(maxDiag, G[i][i]);
    if (!(maxDiag > 0)) return out;
    for (let i = 0; i < n; i++) G[i][i] += 1e-12 * maxDiag;
    const lu = luFactor(G);
    for (const cb of filling) {
      const a = idx.get(cb.from);
      const c = idx.get(cb.to);
      if (a === undefined && c === undefined) continue;
      const e = new Array<number>(n).fill(0);
      if (a !== undefined) e[a] += 1;
      if (c !== undefined) e[c] -= 1;
      const x = luSolve(lu, e);
      let z = 0;
      for (let i = 0; i < n; i++) z += e[i] * x[i];
      out.set(cb.id, z > 0 ? Math.max(0, 1 / z - gBranch[cb.j]) : Infinity);
    }
    return out;
  }

  /** Wet the queued nodes (deduplicated) and react every incident channel. */
  private commit(
    queue: Array<{ node: string; branch: string; time?: number }>,
    t: number,
  ): void {
    // Earliest arrival wins when several fronts reach one node in a step.
    const ordered = [...queue].sort((x, y) => (x.time ?? t) - (y.time ?? t));
    for (const { node, branch, time } of ordered) {
      if (this.wet.get(node)) continue;
      const te = time ?? t;
      this.wet.set(node, true);
      this.log(te, "nodeWetted", branch, node);
      this.onNodeWetted(node, te);
    }
  }

  private onNodeWetted(node: string, t: number): void {
    for (const k of this.incident.get(node) ?? []) {
      const cb = this.channels[k];
      const c = cb.c;
      const here: FillSide = cb.from === node ? 1 : -1;
      const other = here === 1 ? cb.to : cb.from;
      switch (c.status) {
        case "dry":
          if (this.wet.get(other)) {
            c.status = "trapped";
            this.log(t, "airTrapped", cb.id, node);
          } else {
            c.side = here;
            c.fill = 0;
            if (c.capillaryPressure > 0) {
              c.status = "filling";
            } else {
              c.status = "pinnedInlet";
              this.log(t, "pinned", cb.id, node);
            }
          }
          break;
        case "pinnedOutlet":
          if (c.side !== here) {
            // Liquid arrived at this valve's exit from elsewhere: the two
            // menisci merge and the valve opens (trigger valve).
            c.status = "full";
            this.log(t, "triggered", cb.id, node);
          }
          break;
        case "filling":
        case "pinnedInlet":
          if (c.side !== here) {
            if (c.fill >= c.length) {
              c.status = "full";
            } else {
              c.status = "trapped";
              this.log(t, "airTrapped", cb.id, node);
            }
          }
          break;
        default:
          break;
      }
    }
  }

  private log(
    time: number,
    kind: CapillaryEventKind,
    branch: string,
    node: string,
  ): void {
    this.events.push({ time, kind, branch, node });
  }

  /* -------------------------------------------------------------- */
  /* Rollback (adaptive step doubling) and error control             */
  /* -------------------------------------------------------------- */

  snapshot(): CapillaryNetworkSnapshot {
    return {
      channels: this.channels.map((cb) => cb.c.snapshotState()),
      wet: [...this.wet.entries()],
      events: this.events.length,
    };
  }

  restore(s: CapillaryNetworkSnapshot): void {
    this.channels.forEach((cb, k) => cb.c.restoreState(s.channels[k]));
    for (const [id, w] of s.wet) this.wet.set(id, w);
    this.events.length = s.events;
  }

  /** Fill fractions, O(1), for the adaptive error norm. */
  dynamicState(): number[] {
    return this.channels.map((cb) => cb.c.fillFraction);
  }

  /** Current per-channel and per-node state, for result recording. */
  report(): CapillarySnapshot {
    const branches: CapillarySnapshot["branches"] = {};
    for (const cb of this.channels) {
      const c = cb.c;
      branches[cb.id] = {
        fill: c.fillFraction,
        status: c.status,
        fillEnd: c.side === 1 ? "from" : c.side === -1 ? "to" : null,
      };
    }
    const nodes: CapillarySnapshot["nodes"] = {};
    for (const [id, w] of this.wet) nodes[id] = { wet: w };
    return { branches, nodes, events: [...this.events] };
  }
}

/**
 * Linearised volumetric conductance dQ/dΔP [m³/(s·Pa)] of branch j at the
 * solved state: the inverse slope of the same pressure-drop closure the
 * residual uses (dual-number derivative where the component has one, a
 * central difference otherwise), plus the backward-Euler fluid-inertia
 * term of inertial pipes.  Non-positive slopes (a pump curve's rising
 * limb, a flat table) give 0 — an open circuit.
 */
function branchConductance(
  ctx: SolverContext,
  state: StepState,
  j: number,
  dt: number,
  t: number,
): number {
  const b = ctx.branches[j];
  const mdot = state.mdots[j];
  const up = mdot >= 0 ? b.from : b.to;
  const rho = state.nodeRho.get(up)!;
  const mu = state.nodeMu.get(up)!;
  const T = state.nodeT.get(up);
  const pFrom = state.nodeP.get(b.from);
  const pTo = state.nodeP.get(b.to);
  const fluid = ctx.fluidAssignment.branch(b.id);
  let slope: number;
  if (b.component.pressureDropDual) {
    slope = componentPressureDropDual(
      variable(mdot),
      rho,
      mu,
      b.component,
      t,
      T,
      fluid,
      pFrom,
      pTo,
    ).d;
  } else {
    const h = Math.max(1e-15, 1e-6 * Math.abs(mdot));
    const f = (m: number) =>
      componentPressureDrop(m, rho, mu, b.component, t, T, fluid, pFrom, pTo);
    slope = (f(mdot + h) - f(mdot - h)) / (2 * h);
  }
  if (b.inertia && b.component instanceof Pipe && dt > 0) {
    slope += b.component.length / (b.component.area * dt);
  }
  // slope = dΔP/dṁ; ΔP = R·ṁ/ρ for a linear law, so dQ/dΔP = 1/(ρ·slope).
  return Number.isFinite(slope) && slope > 0 ? 1 / (rho * slope) : 0;
}

interface LU {
  a: number[][];
  piv: number[];
}

/** In-place LU with partial pivoting.  No absolute pivot floor: the
 *  conductances here are ~1e-18…1e-9 m³/(s·Pa), far below solveDense's
 *  1e-14 regularisation threshold. */
function luFactor(m: number[][]): LU {
  const n = m.length;
  const a = m.map((r) => [...r]);
  const piv = Array.from({ length: n }, (_, i) => i);
  for (let k = 0; k < n; k++) {
    let p = k;
    for (let i = k + 1; i < n; i++)
      if (Math.abs(a[i][k]) > Math.abs(a[p][k])) p = i;
    if (p !== k) {
      [a[k], a[p]] = [a[p], a[k]];
      [piv[k], piv[p]] = [piv[p], piv[k]];
    }
    const d = a[k][k];
    if (d === 0) continue;
    for (let i = k + 1; i < n; i++) {
      const f = (a[i][k] /= d);
      if (f === 0) continue;
      for (let c = k + 1; c < n; c++) a[i][c] -= f * a[k][c];
    }
  }
  return { a, piv };
}

function luSolve({ a, piv }: LU, b: number[]): number[] {
  const n = a.length;
  const y = piv.map((p) => b[p]);
  for (let i = 0; i < n; i++)
    for (let c = 0; c < i; c++) y[i] -= a[i][c] * y[c];
  for (let i = n - 1; i >= 0; i--) {
    for (let c = i + 1; c < n; c++) y[i] -= a[i][c] * y[c];
    y[i] = a[i][i] === 0 ? 0 : y[i] / a[i][i];
  }
  return y;
}
