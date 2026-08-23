/**
 * ============================================================================
 * LOX/RP-1 THRUSTER — TRANSIENT STARTUP RAMP
 * ============================================================================
 *
 * The same reacting-junction combustor as thrusterCombustor.ts (same
 * geometry, same regen wall stack, same CEA-coupled chamber closure — built
 * from the SAME GAS_STATIONS table and builder functions), run transient
 * instead of steady: both propellant tanks ramp from 100 psi to 1000 psi
 * over the first second, then hold at 1000 psi for a second more.
 *
 * ── WHAT MAKES A REACTING JUNCTION TRANSIENT ────────────────────────────
 * core/solver/kernel.ts's useCoupledHMode gates the coupled [P, ṁ, h]
 * Newton system that the junction's thermochemical closure row lives in.
 * It used to require settings.mode === "steady"; it now also covers
 * TRANSIENT solves of the analytic (non-real-fluid) EOS classes — exactly
 * this network (idealGas gas, incompressible LOX/RP-1) — so the SAME
 * closure row (h_node = efficiency·h(T0(Pc, O/F)), T0 from the CEA lookup,
 * solved inside the Jacobian) now runs every implicit step.  That row still
 * carries NO storage term: the chamber's ENERGY is quasi-steady (combustion
 * residence time ~ms, far below this ramp's 1 s), so it locks onto its
 * instantaneous CEA equilibrium every step.  The chamber's MASS row is an
 * ordinary internal-node balance, Σṁ − d(ρV)/dt, so Pc still has a genuine
 * fill/drain dynamic — it just relaxes to the quasi-steady value on a time
 * scale set by chamber mass / mass flow (~0.3 ms here), i.e. it tracks the
 * feed-pressure ramp almost exactly rather than lagging it.
 *
 * ── NODE VOLUMES ─────────────────────────────────────────────────────────
 * Every INTERNAL node needs settings.mode "transient" to see a positive
 * volume (validate/nodes.ts) — steady has no use for one, so
 * thrusterCombustor.ts's nodes carry none.  This example assigns:
 *   - each gas station: (π/4)·D²·L, L = tributaryLength(i) — the SAME
 *     tributary half-segment partition buildRegenSystem uses for wetted
 *     area, so the discretized nozzle free volume tiles the true nozzle
 *     length exactly once (no gaps, no double-counting);
 *   - each RP-1 jacket node: (π/4)·JACKET_D²·L, the coolant channel treated
 *     as a duct of the jacket's hydraulic diameter over the same tributary
 *     length (an approximation — the jacket pass's own geometric length
 *     differs slightly station to station — but consistent with how the
 *     gas-side volumes are built, and the coolant loop's fill dynamics are
 *     not the point of this example).
 * The three copper wall layers per station are solid nodes (mass + cp),
 * already transient-capable with no changes needed.
 *
 * ── EXHAUST BOUNDARY: WHY NOT SEA-LEVEL AMBIENT ─────────────────────────
 * thrusterCombustor.ts authors EXHAUST_P at the MATCHED-EXPANSION pressure
 * for its steady design point (188.6 psi feed) specifically to avoid a
 * known artifact: a boundary node imposes a static pressure, over-
 * specifying a supersonic outlet, and any value that disagrees with the
 * quasi-1-D solution back-propagates into the LAST interior station's
 * momentum row (this model has no shock-capturing, so it cannot represent
 * the flow separation a real over-expanded nozzle would show there — it
 * just produces a smeared, non-monotonic partial recompression).
 *
 * This example's ramp covers a 6.9x range of Pc (100 to 1000 psi feed —
 * FAR wider than the steady example's single design point), so one fixed
 * exhaust pressure cannot sit at the matched-expansion value everywhere.
 * Tested empirically (see the exhaust boundary at both ramp ends):
 *   - sea-level ambient (101 325 Pa) is safely BELOW the natural exit trace
 *     at 1000 psi feed (monotonic, fine) but ABOVE it at 100 psi feed —
 *     there the last divergent station (div23) shows exactly the
 *     back-propagation artifact above: pressure and temperature both jump
 *     UP from div22 instead of continuing to fall (+30 % on Pexit alone);
 *   - a fixed 30 000 Pa exhaust (a high-altitude / altitude-test-stand
 *     ambient, not sea level, but still a physically ordinary fixed
 *     boundary condition) sits below the natural exit trace at EVERY point
 *     of the 100-1000 psi ramp, so the divergent section stays monotonic
 *     throughout with no re-tuning — this is the "logic" applied to the
 *     boundary node: picking the fixed value by checking admissibility
 *     across the whole operating envelope, rather than defaulting to sea
 *     level and hitting the artifact at the low end.
 * Either way this is confined to the last interior station(s): chamber
 * pressure, temperature, O/F and the propellant mass flows are set upstream
 * and are unaffected (thrusterCombustor.ts's own EXHAUST BOUNDARY note
 * already documents that the mass flow is untouched by this artifact).
 *
 * ── TIME STEPPING ────────────────────────────────────────────────────────
 * Fixed stepping, dt = 0.25 s (8 steps over the 2 s run, landing exactly on
 * the t = 1 s ramp/hold boundary).  This network's fastest internal time
 * constant (chamber fill time ~0.3 ms) is ~3 orders of magnitude below the
 * ramp rate, so there is no genuine fast transient content to resolve — the
 * solution trajectory is smooth and essentially quasi-static, tracking the
 * feed-pressure schedule almost exactly — and each implicit step is
 * expensive here regardless of dt (the coupled h-system + regen thermal
 * subsystem + CEA property lag settle to a tight bar every step; this is
 * the same per-step cost the steady solve already pays once, ~10-30 s).
 * A coarser fixed step resolves the (piecewise-linear) schedule shape fully
 * — 5 points sample the ramp itself — without paying for step counts the
 * quasi-static physics has no use for; see docs/combustion.md for the
 * measured per-step cost and why this is not adaptive-stepping territory
 * (there is no fast transient for step-doubling error control to protect
 * against, only an expensive quasi-static solve at every sample point).
 */
import type { NetworkConfig } from "../core/schema";
import {
  GAS_STATIONS,
  JACKET_D,
  buildGasPath,
  buildRegenSystem,
  feedNodes,
  injectorBranches,
  tributaryLength,
} from "./thrusterCombustor";

const PSI = 6894.757293168361;

/** Fixed exhaust boundary pressure: below the natural exit trace across the
 *  whole 100-1000 psi ramp (see the EXHAUST BOUNDARY note above). */
const EXHAUST_P_TRANSIENT = 30000;

const gasPath = buildGasPath();
const regen = buildRegenSystem();

// Give every gas station and RP-1 jacket node a physical volume, and swap
// the exhaust node's pressure for the ramp-wide-admissible fixed value.
const gasNodes: NetworkConfig["nodes"] = gasPath.gasNodes.map((n) => {
  if (n.id === "exhaust") return { ...n, pressure: EXHAUST_P_TRANSIENT };
  const i = GAS_STATIONS.findIndex((st) => st.id === n.id);
  const D = GAS_STATIONS[i].D;
  const volume = (Math.PI / 4) * D * D * tributaryLength(i);
  return { ...n, volume };
});

const coolantNodes: NetworkConfig["nodes"] = regen.coolantNodes.map((n) => {
  const stationId = n.id.replace(/Coolant$/, "");
  const i = GAS_STATIONS.findIndex((st) => st.id === stationId);
  const volume = (Math.PI / 4) * JACKET_D * JACKET_D * tributaryLength(i);
  return { ...n, volume };
});

// Feed tanks: pressure ramps 100 psi -> 1000 psi over [0, 1] s, then holds
// through t = 2 s. Temperature and fluid identity are unchanged from
// thrusterCombustor.ts.
const rampedFeedNodes: NetworkConfig["nodes"] = feedNodes.map((n) => ({
  ...n,
  pressure: 100 * PSI,
  pressureSchedule: [
    [0, 100 * PSI],
    [1, 1000 * PSI],
    [2, 1000 * PSI],
  ] as Array<[number, number]>,
}));

export const thrusterCombustorTransient: NetworkConfig = {
  meta: { name: "LOX/RP-1 thruster (transient startup)", version: 2 },
  settings: {
    mode: "transient",
    timeStepping: "fixed",
    dt: 0.25,
    endTime: 2.0,
    // 10x looser than the steady combustor's 1e-8: the transient mass row's
    // extra d(ρV)/dt storage term raises the raw (mixed-unit, un-scaled)
    // residual's noise floor at some points on the ramp — 1e-8 was
    // reachable but only by grinding hundreds of extra inner iterations
    // right at that floor (measured: one step went from ~15 s to 8+ minutes
    // for a 10x tighter bar with no measurable accuracy gain, since the
    // outer Picard loop's own settle criterion, maxDeltaT < fluidTol, is
    // unchanged and still the thing actually certifying the coupling).
    tolerance: 1e-7,
    maxIterations: 800,
    relaxation: 0.6,
    momentumFlux: true,
    kineticEnergy: true,
  },
  // Network default (no node references it — every node names a fluid).
  fluid: {
    model: "idealGas",
    params: { R: 361.49837, gamma: 1.2, mu: 0.00008, cp: 2168.9902 },
  },
  fluids: {
    gas: {
      model: "idealGas",
      params: { R: 363.633, gamma: 1.126691, mu: 0.00010611, cp: 3235.32 },
    },
    lox: {
      model: "incompressible",
      params: { rho: 1141, mu: 0.000195, cp: 1700 },
    },
    rp1: {
      model: "incompressible",
      params: { rho: 810, mu: 0.0017, cp: 2000 },
    },
  },
  junctions: [
    {
      id: "mainCombustor",
      label: "LOX/RP-1 combustor",
      node: "chamber",
      inlets: [
        { branch: "loxInjector", role: "oxidizer" },
        { branch: "fuelInjector", role: "fuel" },
      ],
      model: {
        type: "ceaTable",
        propellants: "lox-rp1",
        efficiency: 0.9409,
      },
      productFluid: "gas",
    },
  ],
  nodes: [...gasNodes, ...rampedFeedNodes, ...coolantNodes],
  solidNodes: regen.solidNodes,
  branches: [
    ...gasPath.gasBranches,
    ...injectorBranches,
    ...regen.jacketBranches,
  ],
  conductors: regen.conductors,
  notes: [
    {
      id: "noteOverview",
      text: "TRANSIENT STARTUP: both propellant tanks ramp from 100 psi to 1000 psi over the first second, then hold for a second more. The reacting junction's chamber closure (CEA equilibrium, efficiency 0.9409) is quasi-steady in energy but has a genuine mass-storage fill dynamic, so Pc tracks the feed ramp with a ~0.3 ms lag — essentially instantaneously on the scale of this ramp.",
      x: 255,
      y: 510,
      width: 430,
    },
    {
      id: "noteVolumes",
      text: "Every gas station and RP-1 jacket node carries a physical volume (π/4·D²·L, L = tributary half-segment length) so the mass balance has a real d(ρV)/dt storage term. The three copper wall layers were already transient-capable (mass + cp).",
      x: 1095,
      y: 900,
      width: 430,
    },
    {
      id: "noteExhaust",
      text: "EXHAUST BOUNDARY: fixed at 30 kPa (not sea-level 101.3 kPa) — chosen because sea-level ambient sits ABOVE the natural nozzle exit pressure trace at the low end of this ramp (100 psi feed), producing a non-physical recompression bump in the last divergent station; 30 kPa stays below the natural trace across the whole 100-1000 psi range. Chamber pressure, temperature, O/F and mass flows are set upstream and are unaffected either way.",
      x: 1485,
      y: 75,
      width: 430,
    },
  ],
};
