import { getCoolProp, realFluidsReady } from "./coolprop";
import type { AbstractState } from "coolprop-wasm";
import type { Dual } from "../dual";
import {
  canonicalizeFluidName,
  fluidHasConductivityModel,
  fluidHasViscosityModel,
  CURATED_REAL_FLUIDS,
  FLUID_CATALOGUE_COUNT,
  type HeosFluidName,
} from "./fluidCatalogue";

/**
 * Curated favorites (the historical 9-fluid allowlist), kept as a
 * backward-compatible export.  The set of ACCEPTED fluids is the full
 * generated HEOS catalogue — see fluidCatalogue.ts and validate.ts.
 */
export const SUPPORTED_REAL_FLUIDS = CURATED_REAL_FLUIDS;

/**
 * Any canonical CoolProp HEOS fluid name (union of the 124 catalogue names).
 * Alias strings must be run through canonicalizeFluidName first.
 */
export type SupportedRealFluid = HeosFluidName;

function validateFluidName(name: string): SupportedRealFluid {
  const canonical = canonicalizeFluidName(name);
  if (canonical === undefined) {
    throw new Error(
      `Unsupported real fluid "${name}". Expected one of the ${FLUID_CATALOGUE_COUNT} CoolProp HEOS fluids ` +
        `(curated set: ${SUPPORTED_REAL_FLUIDS.join(", ")}); registered aliases such as "N2" or "R718" are accepted.`,
    );
  }
  return canonical;
}

class TwoPhaseError extends Error {
  constructor(fluidName: string, P: number, T: number, quality: number) {
    super(
      `Two-phase dome detected for ${fluidName} at P=${P.toExponential(3)} Pa, T=${T.toFixed(2)} K (quality=${quality.toFixed(3)}). ` +
        `Real-fluid solves are currently restricted to single-phase conditions.`,
    );
  }
}

class FluidPropertyError extends Error {
  constructor(
    fluidName: string,
    operation: string,
    P: number,
    h?: number,
    cause?: unknown,
  ) {
    const ctx =
      h !== undefined
        ? `P=${P.toExponential(3)} Pa, h=${h.toFixed(2)} J/kg`
        : `P=${P.toExponential(3)} Pa`;
    super(
      `Failed ${operation} for ${fluidName} at ${ctx}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
}

/** Per-fluid AbstractState cache to avoid repeated factory calls. */
const stateCache = new Map<
  string,
  ReturnType<ReturnType<typeof getCoolProp>["factory"]>
>();

/**
 * Bounded least-recently-used map.  Several property caches below are keyed
 * by the EXACT pressure double (deliberately: quantized keys can flip the
 * phase branch across tiny finite-difference steps).  Exact keys never
 * collide across a continuously drifting pressure field, so an unbounded
 * Map grows by one entry per (node, step, call-site) on long transients —
 * the 2026-08-07 Darr–Hartwig 161.72 psia run died in `Runtime_MapGrow` at
 * the default heap after ~2,100 steps.
 * Eviction only discards a memoized value that is recomputed identically on
 * the next call (the CoolProp evaluations are deterministic), so results are
 * bit-exact while the heap stays bounded.
 */
export class LruMap<K, V> {
  private readonly map = new Map<K, V>();
  constructor(private readonly capacity: number) {
    if (!(capacity >= 1))
      throw new Error(`LruMap capacity must be >= 1, got ${capacity}`);
  }
  get(key: K): V | undefined {
    const v = this.map.get(key);
    if (v !== undefined) {
      // refresh recency: delete + re-insert moves the key to the newest slot
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }
  set(key: K, v: V): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, v);
    while (this.map.size > this.capacity) {
      const oldest = this.map.keys().next();
      if (oldest.done) break;
      this.map.delete(oldest.value);
    }
  }
  get size(): number {
    return this.map.size;
  }
  clear(): void {
    this.map.clear();
  }
}

/**
 * Capacity of the exact-pressure-keyed property caches.  Sized far above any
 * simultaneous working set (a 50-node network touches ~10² distinct
 * pressures per h-map refresh; each entry is ~150 B) and far below anything
 * that can threaten the heap on million-step transients.
 */
export const PROPERTY_CACHE_CAPACITY = 8192;

/** Diagnostic cache sizes (diagnostics.ts pattern — read-only snapshot). */
export function getFluidCacheSizes(): Record<string, number> {
  return {
    satPropCache: satPropCache.size,
    satDerivCache: satDerivCache.size,
    surfaceTensionCache: surfaceTensionCache.size,
    stateCache: stateCache.size,
    criticalCache: criticalCache.size,
    fluidLimitsCache: fluidLimitsCache.size,
  };
}

/** Per-fluid AbstractState cache to avoid repeated factory calls.
 *  For NitrousOxide the HEOS backend is unstable with repeated updates on a
 *  single cached object (WASM memory corruption after certain PQ→PT→HmassP
 *  sequences), so we always return a fresh state for that fluid.  Other fluids
 *  use the cache for speed.
 */
function getState(fluidName: SupportedRealFluid) {
  let state = stateCache.get(fluidName);
  if (!state) {
    const cp = getCoolProp();
    state = cp.factory("HEOS", fluidName);
    stateCache.set(fluidName, state);
  }
  return state;
}

/** Create a brand-new AbstractState instance. Used as a fallback when the
 *  cached state may have been corrupted by an unrecoverable CoolProp abort.
 */
function getFreshState(fluidName: SupportedRealFluid) {
  const cp = getCoolProp();
  return cp.factory("HEOS", fluidName);
}

/** Safely read viscosity, skipping fluids that the generated catalogue marks
 *  as having NO confirmed model — calling viscosity() on those throws/aborts
 *  and can corrupt the CoolProp heap (first observed with NitrousOxide, now
 *  generalized to every catalogue fluid with transport.viscosity !== 'yes').
 *  Returns 0 for them (inviscid limit); validation steers new no-transport
 *  fluids away from solving — see validate.ts. */
function safeViscosity(
  state: AbstractState,
  fluidName: SupportedRealFluid,
): number {
  if (!fluidHasViscosityModel(fluidName)) return 0;
  try {
    const v = state.viscosity();
    return isFinite(v) && v > 0 ? v : 0;
  } catch {
    return 0;
  }
}

/** Safely read thermal conductivity, skipping fluids that lack the model. */
function safeConductivity(
  state: AbstractState,
  fluidName: SupportedRealFluid,
): number | undefined {
  if (!fluidHasConductivityModel(fluidName)) return undefined;
  try {
    const k = state.conductivity?.();
    return k !== undefined && isFinite(k) && k > 0 ? k : undefined;
  } catch {
    return undefined;
  }
}

/** Read one finite scalar from an updated state, or undefined when the
 *  build lacks the method or the property is undefined at this state
 *  (e.g. speed of sound inside the two-phase dome). */
function safeRead(read: (() => number) | undefined): number | undefined {
  if (typeof read !== "function") return undefined;
  try {
    const v = read();
    return typeof v === "number" && isFinite(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

function guardSinglePhase(
  fluidName: SupportedRealFluid,
  P: number,
  T: number,
): AbstractState {
  const state = getState(fluidName);
  try {
    state.update(getCoolProp().input_pairs.PT_INPUTS, P, T);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (
      msg.includes("Saturation") ||
      msg.includes("saturation") ||
      msg.includes("two-phase")
    ) {
      throw new TwoPhaseError(fluidName, P, T, -1);
    }
    if (
      msg.includes("abort") ||
      msg.includes("Abort") ||
      msg.includes("out of bounds")
    ) {
      // Cached state may be corrupted; retry with a fresh state
      const fresh = getFreshState(fluidName);
      try {
        fresh.update(getCoolProp().input_pairs.PT_INPUTS, P, T);
      } catch (e2) {
        const msg2 = e2 instanceof Error ? e2.message : String(e2);
        if (
          msg2.includes("Saturation") ||
          msg2.includes("saturation") ||
          msg2.includes("two-phase")
        ) {
          throw new TwoPhaseError(fluidName, P, T, -1);
        }
        throw e2;
      }
      const q = fresh.Q();
      if (q >= 0 && q <= 1) {
        throw new TwoPhaseError(fluidName, P, T, q);
      }
      return fresh;
    }
    throw e;
  }
  const q = state.Q();
  if (q >= 0 && q <= 1) {
    throw new TwoPhaseError(fluidName, P, T, q);
  }
  return state;
}

function getProps(fluidName: SupportedRealFluid, P: number, T: number) {
  const state = guardSinglePhase(fluidName, P, T);
  const mu = safeViscosity(state, fluidName);
  return {
    rho: state.rhomass(),
    h: state.hmass(),
    u: state.umass(),
    cp: state.cpmass(),
    cv: state.cvmass(),
    mu,
  };
}

/** Cached surface tension per (fluidName, P) — CoolProp keyed output 'I'
 *  at Q=0 (saturated-liquid surface tension, N/m).  Bounded LRU: exact-P
 *  keys multiply without bound on long transients (see LruMap note). */
const surfaceTensionCache = new LruMap<string, number>(PROPERTY_CACHE_CAPACITY);

function getSurfaceTension(fluidName: SupportedRealFluid, P: number): number {
  const key = `${fluidName}@${P}`;
  const hit = surfaceTensionCache.get(key);
  if (hit !== undefined) return hit;
  const cp = getCoolProp();
  let sigma: number;
  try {
    sigma = cp.PropsSI("I", "P", P, "Q", 0, fluidName);
  } catch (e) {
    throw new FluidPropertyError(fluidName, "surfaceTension", P, undefined, e);
  }
  // σ → 0⁺ at the critical point is legitimate; negative/NaN is not.
  if (!isFinite(sigma) || sigma < 0) {
    throw new FluidPropertyError(
      fluidName,
      "surfaceTension",
      P,
      undefined,
      `Invalid surface tension ${sigma}`,
    );
  }
  surfaceTensionCache.set(key, sigma);
  return sigma;
}

/** Cached per-fluid critical properties. */
const criticalCache = new Map<string, { Pc: number; Tc: number }>();

function getCritical(fluidName: SupportedRealFluid) {
  let crit = criticalCache.get(fluidName);
  if (crit) return crit;

  const cp = getCoolProp();
  const state = getState(fluidName);
  let Pc = 0;
  let Tc = 0;
  try {
    // CoolProp constant properties via empty-string inputs
    Pc = cp.PropsSI("PCRIT", "", 0, "", 0, fluidName);
    Tc = cp.PropsSI("TCRIT", "", 0, "", 0, fluidName);
  } catch {
    // Fallback: try keyed_output on the state object if available
  }
  if (!isFinite(Pc) || Pc <= 0) {
    // Rough fallback: use state at known supercritical guess to infer
    try {
      state.update(cp.input_pairs.PT_INPUTS, 10e6, 300);
      Pc = 10e6; // generous conservative guess
      Tc = 300;
    } catch {
      Pc = 1e7;
      Tc = 300;
    }
  }
  crit = { Pc, Tc };
  criticalCache.set(fluidName, crit);
  return crit;
}

/** Cached per-fluid limits. */
const fluidLimitsCache = new Map<
  string,
  {
    Pmin: number;
    Pmax: number;
    hmin: number;
    hmax: number;
    Tmin: number;
    Tmax: number;
  }
>();

export function getFluidLimits(fluidName: SupportedRealFluid) {
  let limits = fluidLimitsCache.get(fluidName);
  if (limits) return limits;

  const cp = getCoolProp();

  let Tmin = 1;
  let Tmax = 5000;
  let Pmin = 1;
  let Pmax = 1e9;
  let hmin = -1e8;
  let hmax = 1e8;

  try {
    Tmin = cp.PropsSI("TMIN", "", 0, "", 0, fluidName);
  } catch {
    // keep default
  }
  try {
    Tmax = cp.PropsSI("TMAX", "", 0, "", 0, fluidName);
  } catch {
    // keep default
  }
  try {
    const Ttriple = cp.PropsSI("TTRIPLE", "", 0, "", 0, fluidName);
    if (isFinite(Ttriple) && Ttriple > 0) {
      Pmin = Math.max(1, cp.PropsSI("P", "T", Ttriple, "Q", 0, fluidName));
    }
  } catch {
    // keep default
  }
  try {
    if (isFinite(Tmax) && Tmax > 0) {
      Pmax = Math.min(1e9, cp.PropsSI("P", "T", Tmax, "Q", 1, fluidName));
    }
  } catch {
    // keep default (Tmax may be supercritical, so Q=1 is invalid)
  }
  try {
    // Saturated liquid at Tmin (Q=0) is the physical minimum-enthalpy state
    // and an UNAMBIGUOUS query.  A (T, P) flash at (Tmin, Pmin) — Pmin being
    // Psat(Tmin) — sits exactly ON the saturation curve, which some HEOS
    // backends resolve to the VAPOR branch instead of the liquid one (e.g.
    // Ammonia returns ~1.49 MJ/kg there, its near-triple-point VAPOR
    // enthalpy, instead of the ~30 J/kg liquid value).  That silently
    // clamped every ordinary liquid-phase Ammonia node upward into the
    // vapor dome via clampToValidPH.  Q=0 sidesteps the ambiguity entirely.
    if (isFinite(Tmin) && Tmin > 0) {
      hmin = cp.PropsSI("HMASS", "T", Tmin, "Q", 0, fluidName);
    }
    if (
      !isFinite(hmin) &&
      isFinite(Tmin) &&
      Tmin > 0 &&
      isFinite(Pmin) &&
      Pmin > 0
    ) {
      hmin = cp.PropsSI("HMASS", "T", Tmin, "P", Pmin, fluidName);
    }
    if (!isFinite(hmin) || hmin === -Infinity) {
      // Triple-point enthalpy can return Infinity for some fluids (e.g. Water).
      // Fallback to 1 bar at Tmin+1 K.
      hmin = cp.PropsSI("HMASS", "T", Tmin + 1, "P", 1e5, fluidName);
    }
  } catch {
    // keep default
  }
  try {
    if (isFinite(Tmax) && Tmax > 0 && isFinite(Pmax) && Pmax > 0) {
      hmax = cp.PropsSI(
        "HMASS",
        "T",
        Tmax,
        "P",
        Math.min(Pmax, 1e7),
        fluidName,
      );
    }
    if (!isFinite(hmax) || hmax === Infinity) {
      hmax = cp.PropsSI("HMASS", "T", Tmax - 1, "P", 1e5, fluidName);
    }
  } catch {
    // keep default
  }

  limits = {
    Pmin: isFinite(Pmin) && Pmin > 0 ? Pmin : 1,
    Pmax: isFinite(Pmax) && Pmax > 0 ? Pmax : 1e9,
    hmin: isFinite(hmin) ? hmin : -1e8,
    hmax: isFinite(hmax) ? hmax : 1e8,
    Tmin: isFinite(Tmin) && Tmin > 0 ? Tmin : 1,
    Tmax: isFinite(Tmax) && Tmax > 0 ? Tmax : 5000,
  };

  fluidLimitsCache.set(fluidName, limits);
  return limits;
}

/** Clamp P/h to valid range for a fluid. Returns [clampedP, clampedH]. */
export function clampToValidPH(
  fluidName: SupportedRealFluid,
  P: number,
  h: number,
): [number, number] {
  const limits = getFluidLimits(fluidName);
  const clampedP = Math.max(limits.Pmin, Math.min(limits.Pmax, P));
  const clampedH = Math.max(limits.hmin, Math.min(limits.hmax, h));
  return [clampedP, clampedH];
}

/** Clamp P/T to valid range for a fluid. Returns [clampedP, clampedT]. */
export function clampToValidPT(
  fluidName: SupportedRealFluid,
  P: number,
  T: number,
): [number, number] {
  const limits = getFluidLimits(fluidName);
  const clampedP = Math.max(limits.Pmin, Math.min(limits.Pmax, P));
  const clampedT = Math.max(limits.Tmin, Math.min(limits.Tmax, T));
  return [clampedP, clampedT];
}

export type FluidPhase = "liquid" | "twoPhase" | "vapor" | "supercritical";

export interface PHState {
  T: number;
  rho: number;
  quality: number | undefined;
  mu: number;
  k?: number;
  cp?: number;
  phase: FluidPhase;
}

/**
 * Dual-number counterpart of {@link PHState}: every field that the Newton
 * residual consumes arithmetically carries a forward-mode derivative; the
 * rest are plain values, exactly as statePH returns them.
 *
 *  - `T`, `rho`: full duals (analytic partials from derivativesPH).
 *  - `cp`: full dual where statePH defines it (single-phase / supercritical);
 *    undefined in the dome, exactly as statePH.
 *  - `mu`: dual with `d === 0` ALWAYS (locally frozen — see statePHDual).
 *  - `k`: value only.  Conductivity partials are unavailable in this build
 *    (same class as viscosity), and k is never consumed inside the Newton
 *    residual's property calls — it only feeds precomputed convection-h maps
 *    (correlations.ts), so no derivative is needed.
 *  - `quality`: value only — a branch field (phase/quality tests and state
 *    bookkeeping), never residual arithmetic.
 *  - `phase`: same branch string statePH returns.
 */
export interface PHStateDual {
  T: Dual;
  rho: Dual;
  quality: number | undefined;
  mu: Dual;
  k?: number;
  cp?: Dual;
  phase: FluidPhase;
}

/** Cached saturation properties per (fluidName, P). */
const satPropCache = new LruMap<
  string,
  {
    Tsat: number;
    hf: number;
    hg: number;
    rhof: number;
    rhog: number;
    muf: number;
    mug: number;
    uf: number;
    ug: number;
    cpf: number;
    cpg: number;
    kf: number;
    kg: number;
  }
>(PROPERTY_CACHE_CAPACITY);

export function getSatProps(fluidName: SupportedRealFluid, P: number) {
  // Use exact P as key to avoid cache-induced phase flips during tiny FD steps.
  // The cache is a bounded LRU (the exact-key set grows without bound on long
  // transients — see the LruMap note above).
  const key = `${fluidName}@${P}`;
  let props = satPropCache.get(key);
  if (props) return props;

  const cp = getCoolProp();
  let state = getState(fluidName);

  function updateWithFallback(inputs: number, val1: number, val2?: number) {
    try {
      if (val2 !== undefined) {
        state.update(inputs, val1, val2);
      } else {
        state.update(inputs, val1);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (
        msg.includes("abort") ||
        msg.includes("Abort") ||
        msg.includes("out of bounds")
      ) {
        state = getFreshState(fluidName);
        if (val2 !== undefined) {
          state.update(inputs, val1, val2);
        } else {
          state.update(inputs, val1);
        }
      } else {
        throw e;
      }
    }
  }

  // Saturated liquid (Q=0)
  updateWithFallback(cp.input_pairs.PQ_INPUTS, P, 0);
  const Tsat = state.T();
  const hf = state.hmass();
  const rhof = state.rhomass();
  const muf = safeViscosity(state, fluidName);
  const uf = state.umass();
  const cpf = state.cpmass();
  const kf = safeConductivity(state, fluidName) ?? 0;

  // Saturated vapor (Q=1)
  updateWithFallback(cp.input_pairs.PQ_INPUTS, P, 1);
  const hg = state.hmass();
  const rhog = state.rhomass();
  const mug = safeViscosity(state, fluidName);
  const ug = state.umass();
  const cpg = state.cpmass();
  const kg = safeConductivity(state, fluidName) ?? 0;

  props = { Tsat, hf, hg, rhof, rhog, muf, mug, uf, ug, cpf, cpg, kf, kg };
  satPropCache.set(key, props);
  return props;
}

/** Cached saturation-curve pressure derivatives per (fluidName, P).
 *  Bounded LRU, same exact-P rationale as satPropCache. */
const satDerivCache = new LruMap<
  string,
  {
    dTsat: number; // dTsat/dP along the saturation curve [K/Pa]
    dhf: number; // dh_f/dP (saturated-liquid enthalpy slope)
    dhg: number; // dh_g/dP (saturated-vapor enthalpy slope; sign is fluid/pressure
    //              dependent: negative for N2/N2O/H2 here, positive for Water below ~3 MPa)
    drhof: number; // dρ_f/dP
    drhog: number; // dρ_g/dP
  }
>(PROPERTY_CACHE_CAPACITY);

/**
 * Pressure derivatives of the saturation-curve quantities at P, from
 * CoolProp's `first_saturation_deriv` evaluated on the Q=0 / Q=1 states.
 *
 * embind calling convention (verified for coolprop-wasm@6.6.0, see
 * docs/real-fluid-performance.md §2): the parameter arguments must be the
 * `cp.parameters.*` EnumValue OBJECTS — passing raw `.value` numbers silently
 * coerces to parameter key 0 and throws.
 */
function getSatDerivs(fluidName: SupportedRealFluid, P: number) {
  // Same exact-P keying as satPropCache (avoid cache-induced phase flips).
  const key = `${fluidName}@${P}`;
  let derivs = satDerivCache.get(key);
  if (derivs) return derivs;

  const cp = getCoolProp();
  let state = getState(fluidName);
  const { iP, iT, iDmass, iHmass } = cp.parameters;

  function readSatDerivs(Q: 0 | 1) {
    try {
      state.update(cp.input_pairs.PQ_INPUTS, P, Q);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (
        msg.includes("abort") ||
        msg.includes("Abort") ||
        msg.includes("out of bounds")
      ) {
        // Cached state may be corrupted; retry with a fresh one (same pattern
        // as getSatProps / statePH).
        state = getFreshState(fluidName);
        state.update(cp.input_pairs.PQ_INPUTS, P, Q);
      } else {
        throw e;
      }
    }
    return {
      dT: state.first_saturation_deriv(iT, iP),
      dh: state.first_saturation_deriv(iHmass, iP),
      drho: state.first_saturation_deriv(iDmass, iP),
    };
  }

  const f = readSatDerivs(0);
  const g = readSatDerivs(1);

  derivs = { dTsat: f.dT, dhf: f.dh, dhg: g.dh, drhof: f.drho, drhog: g.drho };
  satDerivCache.set(key, derivs);
  return derivs;
}

/**
 * Analytic partial derivatives of the {@link RealFluid.statePH} map
 * (P, h) → (ρ, T).
 *
 * Units: drhodP_h [kg/m³/Pa], drhodh_P [kg/m³ per (J/kg)],
 *        dTdP_h [K/Pa],       dTdh_P [K per (J/kg)].
 */
export interface PHDerivatives {
  /** ∂ρ/∂P at constant h [kg/m³/Pa] */
  drhodP_h: number;
  /** ∂ρ/∂h at constant P [kg/m³ per (J/kg)] */
  drhodh_P: number;
  /** ∂T/∂P at constant h [K/Pa] */
  dTdP_h: number;
  /** ∂T/∂h at constant P [K per (J/kg)] */
  dTdh_P: number;
  /** ∂cp/∂P at constant h [(J/kg/K)/Pa] — single-phase/supercritical only;
   *  undefined in the dome, where statePH itself returns no cp. */
  dcpdP_h?: number;
  /** ∂cp/∂h at constant P [(J/kg/K) per (J/kg)] — same availability as dcpdP_h. */
  dcpdh_P?: number;
  /** Region branch used — identical to statePH(P, h).phase at the same point. */
  phase: FluidPhase;
}

/**
 * Single-phase / supercritical analytic partials via CoolProp
 * `first_partial_deriv` on an HmassP-updated state (the same update statePH
 * performs; the derivative reads add <1 % on top of the flash — see
 * docs/real-fluid-performance.md §2).  EnumValue OBJECTS are passed, per the
 * embind calling convention noted at getSatDerivs.
 */
function singlePhaseDerivs(
  fluidName: SupportedRealFluid,
  P: number,
  h: number,
  phase: FluidPhase,
): PHDerivatives {
  const cp = getCoolProp();
  let state = getState(fluidName);
  const { iP, iT, iDmass, iHmass, iCpmass } = cp.parameters;

  const readDerivs = (s: AbstractState): PHDerivatives => {
    // cp partials ARE supported by this build (cp is EOS-derived, unlike
    // viscosity — validated against central FD of statePH.cp to ≤8e-7 for all
    // four fluids × liquid/vapor/supercritical).  Read defensively anyway: a
    // CoolProp build that rejected iCpmass must not break the ρ/T partials.
    let dcpdP_h: number | undefined;
    let dcpdh_P: number | undefined;
    try {
      dcpdP_h = s.first_partial_deriv(iCpmass, iP, iHmass);
      dcpdh_P = s.first_partial_deriv(iCpmass, iHmass, iP);
    } catch {
      dcpdP_h = undefined;
      dcpdh_P = undefined;
    }
    return {
      drhodP_h: s.first_partial_deriv(iDmass, iP, iHmass),
      drhodh_P: s.first_partial_deriv(iDmass, iHmass, iP),
      dTdP_h: s.first_partial_deriv(iT, iP, iHmass),
      dTdh_P: s.first_partial_deriv(iT, iHmass, iP),
      dcpdP_h,
      dcpdh_P,
      phase,
    };
  };

  try {
    state.update(cp.input_pairs.HmassP_INPUTS, h, P);
    return readDerivs(state);
  } catch (e) {
    // Same corruption fallback as statePH: an unrecoverable CoolProp abort can
    // poison the cached AbstractState — retry once on a fresh instance.
    const msg = e instanceof Error ? e.message : String(e);
    if (
      msg.includes("abort") ||
      msg.includes("Abort") ||
      msg.includes("out of bounds")
    ) {
      state = getFreshState(fluidName);
      try {
        state.update(cp.input_pairs.HmassP_INPUTS, h, P);
        return readDerivs(state);
      } catch (e2) {
        throw new FluidPropertyError(
          fluidName,
          "derivativesPH (single-phase)",
          P,
          h,
          e2,
        );
      }
    }
    throw new FluidPropertyError(
      fluidName,
      "derivativesPH (single-phase)",
      P,
      h,
      e,
    );
  }
}

/**
 * Two-phase (in-dome) analytic partials, derived from the SAME homogeneous
 * equilibrium mixture rules that statePH uses:
 *
 *   x   = (h − h_f)/(h_g − h_f)
 *   1/ρ = x/ρ_g + (1−x)/ρ_f        (harmonic/volume mixture)
 *   T   = Tsat(P)
 *
 * IMPORTANT: CoolProp's own in-dome `first_partial_deriv` uses a DIFFERENT
 * two-phase equilibrium convention and does NOT reproduce the derivatives of
 * this mixture density (docs/real-fluid-performance.md §3 — off by a factor of
 * ~3.7 at x=0.5 for N2).  The in-dome partials are therefore assembled from
 * `first_saturation_deriv` on the Q=0 / Q=1 states plus differentiation of
 * the mixture algebra below; they match central finite differences of
 * statePH itself to ~1e-10.
 *
 * ∂/∂h at fixed P  (only x varies; dx/dh = 1/(h_g − h_f)):
 *   with A(x) ≡ 1/ρ = x/ρ_g + (1−x)/ρ_f:
 *     dA/dh = (1/ρ_g − 1/ρ_f)/(h_g − h_f)
 *     ∂ρ/∂h|_P = −ρ² · dA/dh
 *
 * ∂/∂P at fixed h  (h_f, h_g, ρ_f, ρ_g all vary along the saturation curve;
 *                   primes denote the first_saturation_deriv quantities):
 *     x(P) = (h − h_f(P))/(h_g(P) − h_f(P))
 *     dx/dP|_h = [−h_f′ − x·(h_g′ − h_f′)] / (h_g − h_f)
 *     dA/dP|_h = (dx/dP)·(1/ρ_g − 1/ρ_f) − x·ρ_g′/ρ_g² − (1−x)·ρ_f′/ρ_f²
 *     ∂ρ/∂P|_h = −ρ² · dA/dP|_h
 *
 * T partials: T = Tsat(P) everywhere in the dome, so ∂T/∂h|_P = 0 and
 * ∂T/∂P|_h = Tsat′(P) (the saturation-curve slope, again from
 * first_saturation_deriv).
 */
function twoPhaseDerivs(
  fluidName: SupportedRealFluid,
  P: number,
  h: number,
): PHDerivatives {
  const { hf, hg, rhof, rhog } = getSatProps(fluidName, P);
  const { dTsat, dhf, dhg, drhof, drhog } = getSatDerivs(fluidName, P);

  const dhfg = hg - hf;
  const x = (h - hf) / dhfg;
  const invRho = x / rhog + (1 - x) / rhof; // A(x) = 1/ρ
  const rho = 1 / invRho;

  // ∂ρ/∂h|_P: only the quality moves with h at fixed P.
  const dAdh = (1 / rhog - 1 / rhof) / dhfg;
  const drhodh_P = -rho * rho * dAdh;

  // ∂ρ/∂P|_h: the saturation anchors slide along their curves with P.
  const dxdP = (-dhf - x * (dhg - dhf)) / dhfg;
  const dAdP =
    dxdP * (1 / rhog - 1 / rhof) -
    (x * drhog) / (rhog * rhog) -
    ((1 - x) * drhof) / (rhof * rhof);
  const drhodP_h = -rho * rho * dAdP;

  return {
    drhodP_h,
    drhodh_P,
    dTdP_h: dTsat,
    dTdh_P: 0,
    phase: "twoPhase",
  };
}

export class RealFluid {
  readonly fluidName: SupportedRealFluid;

  constructor(fluidName: string) {
    if (!realFluidsReady()) {
      throw new Error(
        "Real fluids not initialized: call await initRealFluids() before solving with real fluids",
      );
    }
    this.fluidName = validateFluidName(fluidName);
  }

  // ---- Existing PT-path API (unchanged, dome guard active) ----

  density(P: number, T: number): number {
    return getProps(this.fluidName, P, T).rho;
  }

  viscosity(P: number, T: number): number {
    return getProps(this.fluidName, P, T).mu;
  }

  cp(P: number, T: number): number {
    return getProps(this.fluidName, P, T).cp;
  }

  cv(P: number, T: number): number {
    return getProps(this.fluidName, P, T).cv;
  }

  enthalpy(P: number, T: number): number {
    return getProps(this.fluidName, P, T).h;
  }

  internalEnergy(P: number, T: number): number {
    return getProps(this.fluidName, P, T).u;
  }

  temperatureFromEnthalpy(P: number, h: number): number {
    const cp = getCoolProp();
    try {
      const T = cp.PropsSI("T", "P", P, "HMASS", h, this.fluidName);
      if (!isFinite(T) || T <= 0) {
        throw new Error(`Invalid temperature ${T} from enthalpy inverse`);
      }
      return T;
    } catch (e) {
      throw new Error(
        `Failed to invert enthalpy for ${this.fluidName} at P=${P.toExponential(3)} Pa, h=${h.toFixed(2)} J/kg: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  temperatureFromInternalEnergy(P: number, u: number): number {
    const cp = getCoolProp();
    try {
      const T = cp.PropsSI("T", "P", P, "UMASS", u, this.fluidName);
      if (!isFinite(T) || T <= 0) {
        throw new Error(
          `Invalid temperature ${T} from internal-energy inverse`,
        );
      }
      return T;
    } catch (e) {
      throw new Error(
        `Failed to invert internal energy for ${this.fluidName} at P=${P.toExponential(3)} Pa, u=${u.toFixed(2)} J/kg: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  // ---- Saturation API ----

  saturationTemperature(P: number): number {
    if (P <= 0) {
      throw new FluidPropertyError(
        this.fluidName,
        "saturationTemperature",
        P,
        undefined,
        "Pressure must be positive",
      );
    }
    return getSatProps(this.fluidName, P).Tsat;
  }

  saturationPressure(T: number): number {
    if (T <= 0) {
      throw new FluidPropertyError(
        this.fluidName,
        "saturationPressure",
        0,
        undefined,
        "Temperature must be positive",
      );
    }
    const cp = getCoolProp();
    try {
      const P = cp.PropsSI("P", "T", T, "Q", 0, this.fluidName);
      if (!isFinite(P) || P <= 0) {
        throw new Error(`Invalid saturation pressure ${P} at T=${T}`);
      }
      return P;
    } catch (e) {
      throw new FluidPropertyError(
        this.fluidName,
        "saturationPressure",
        0,
        undefined,
        e,
      );
    }
  }

  hSatLiquid(P: number): number {
    if (P <= 0) {
      throw new FluidPropertyError(
        this.fluidName,
        "hSatLiquid",
        P,
        undefined,
        "Pressure must be positive",
      );
    }
    return getSatProps(this.fluidName, P).hf;
  }

  hSatVapor(P: number): number {
    if (P <= 0) {
      throw new FluidPropertyError(
        this.fluidName,
        "hSatVapor",
        P,
        undefined,
        "Pressure must be positive",
      );
    }
    return getSatProps(this.fluidName, P).hg;
  }

  rhoSatLiquid(P: number): number {
    if (P <= 0) {
      throw new FluidPropertyError(
        this.fluidName,
        "rhoSatLiquid",
        P,
        undefined,
        "Pressure must be positive",
      );
    }
    return getSatProps(this.fluidName, P).rhof;
  }

  rhoSatVapor(P: number): number {
    if (P <= 0) {
      throw new FluidPropertyError(
        this.fluidName,
        "rhoSatVapor",
        P,
        undefined,
        "Pressure must be positive",
      );
    }
    return getSatProps(this.fluidName, P).rhog;
  }

  criticalPressure(): number {
    return getCritical(this.fluidName).Pc;
  }

  criticalTemperature(): number {
    return getCritical(this.fluidName).Tc;
  }

  saturationProperties(P: number) {
    if (P <= 0) {
      throw new FluidPropertyError(
        this.fluidName,
        "saturationProperties",
        P,
        undefined,
        "Pressure must be positive",
      );
    }
    return getSatProps(this.fluidName, P);
  }

  /**
   * Saturated-liquid surface tension σ(P) [N/m] (CoolProp 'I', Q=0), cached.
   * Needed by Weber-number-based boiling correlations (e.g. the Darr–Hartwig
   * T_wet = 0.844·T_cr·(1 + 0.060·We_D^0.208) rewet temperature).
   */
  surfaceTension(P: number): number {
    if (P <= 0) {
      throw new FluidPropertyError(
        this.fluidName,
        "surfaceTension",
        P,
        undefined,
        "Pressure must be positive",
      );
    }
    return getSurfaceTension(this.fluidName, P);
  }

  /**
   * Single-update PT-path transport bundle for SUPERHEATED-VAPOR lookups:
   * { rho, mu, cp, k } at (P, T).  Uses guardSinglePhase — T must be outside
   * the two-phase dome (callers in the boiling correlations clamp
   * T ≥ T_sat + margin).  k falls back to 0 where a conductivity model is
   * missing (same policy as safeConductivity elsewhere).
   */
  transportPropsPT(
    P: number,
    T: number,
  ): { rho: number; mu: number; cp: number; k: number } {
    const state = guardSinglePhase(this.fluidName, P, T);
    return {
      rho: state.rhomass(),
      mu: safeViscosity(state, this.fluidName),
      cp: state.cpmass(),
      k: safeConductivity(state, this.fluidName) ?? 0,
    };
  }

  // ---- Reporting-only properties (single-phase PT path) ----

  entropy(P: number, T: number): number {
    const state = guardSinglePhase(this.fluidName, P, T);
    const s = safeRead(state.smass ? () => state.smass!() : undefined);
    if (s === undefined) {
      throw new FluidPropertyError(
        this.fluidName,
        "entropy",
        P,
        undefined,
        "No entropy available",
      );
    }
    return s;
  }

  speedOfSound(P: number, T: number): number {
    const state = guardSinglePhase(this.fluidName, P, T);
    const a = safeRead(
      state.speed_sound ? () => state.speed_sound!() : undefined,
    );
    if (a === undefined) {
      throw new FluidPropertyError(
        this.fluidName,
        "speedOfSound",
        P,
        undefined,
        "No sound-speed model",
      );
    }
    return a;
  }

  thermalConductivity(P: number, T: number): number {
    const k = safeConductivity(
      guardSinglePhase(this.fluidName, P, T),
      this.fluidName,
    );
    if (k === undefined) {
      throw new FluidPropertyError(
        this.fluidName,
        "thermalConductivity",
        P,
        undefined,
        "No conductivity model",
      );
    }
    return k;
  }

  /**
   * Bulk read of the reporting-only properties at (P, h) — valid everywhere
   * the solver state is, including inside the two-phase dome, because the
   * flash is HmassP rather than PT.
   *
   * One `update` amortised over every read, and called ONCE per element per
   * recorded step (core/results/derivedProperties.ts) — never on the Newton
   * hot path.  Every field is individually optional: properties that are not
   * single-valued in the dome (cp, cv, sound speed) or that the fluid has no
   * model for simply come back undefined, and the corresponding channel is
   * then absent from the result rather than carrying a fabricated number.
   */
  reportingPropertiesPH(
    P: number,
    h: number,
  ): {
    internalEnergy?: number;
    entropy?: number;
    specificHeat?: number;
    cv?: number;
    thermalConductivity?: number;
    speedOfSound?: number;
  } {
    if (!isFinite(P) || !isFinite(h) || P <= 0) return {};
    let state: AbstractState;
    try {
      state = getState(this.fluidName);
      state.update(getCoolProp().input_pairs.HmassP_INPUTS, h, P);
    } catch {
      return {};
    }
    // Inside the dome CoolProp still answers cp / cv / conductivity with a
    // quality-weighted average of the two saturated phases.  That number is
    // not the property: isobaric cp is formally unbounded along the
    // saturation line, and a mixture has no single transport conductivity.
    // Reporting it would be worse than reporting nothing, so those fields are
    // dropped and only the true mixture properties (u, s) survive.
    const q = safeRead(() => state.Q());
    const twoPhase = q !== undefined && q > 0 && q < 1;
    return {
      internalEnergy: safeRead(() => state.umass()),
      entropy: safeRead(state.smass ? () => state.smass!() : undefined),
      ...(twoPhase
        ? {}
        : {
            specificHeat: safeRead(() => state.cpmass()),
            cv: safeRead(() => state.cvmass()),
            thermalConductivity: safeConductivity(state, this.fluidName),
            speedOfSound: safeRead(
              state.speed_sound ? () => state.speed_sound!() : undefined,
            ),
          }),
    };
  }

  // ---- P-h state API (valid everywhere, including two-phase dome) ----

  enthalpyPT(P: number, T: number): number {
    return this.enthalpy(P, T);
  }

  enthalpyPQ(P: number, quality: number): number {
    if (quality < 0 || quality > 1) {
      throw new FluidPropertyError(
        this.fluidName,
        "enthalpyPQ",
        P,
        undefined,
        `Quality ${quality} out of range [0,1]`,
      );
    }
    const cp = getCoolProp();
    const state = getState(this.fluidName);
    state.update(cp.input_pairs.PQ_INPUTS, P, quality);
    return state.hmass();
  }

  /**
   * Evaluate thermodynamic state from (P, h). Valid everywhere including
   * inside the two-phase dome (homogeneous equilibrium mixture).
   *
   * Two-phase density:   1/ρ = x/ρ_g + (1−x)/ρ_f   (harmonic/volume mixture)
   * Two-phase viscosity:   1/μ = x/μ_g + (1−x)/μ_f   (McAdams mixing rule)
   */
  statePH(P: number, h: number): PHState {
    if (!isFinite(P) || !isFinite(h)) {
      throw new FluidPropertyError(
        this.fluidName,
        "statePH",
        P,
        h,
        "Non-finite inputs",
      );
    }
    if (P <= 0) {
      throw new FluidPropertyError(
        this.fluidName,
        "statePH",
        P,
        h,
        "Pressure must be positive",
      );
    }

    const { Pc } = getCritical(this.fluidName);

    // Supercritical or very near critical
    if (P >= Pc) {
      const cp = getCoolProp();
      const state = getState(this.fluidName);
      try {
        state.update(cp.input_pairs.HmassP_INPUTS, h, P);
      } catch (e) {
        throw new FluidPropertyError(
          this.fluidName,
          "statePH (supercritical)",
          P,
          h,
          e,
        );
      }
      return {
        T: state.T(),
        rho: state.rhomass(),
        quality: undefined,
        mu: safeViscosity(state, this.fluidName),
        k: safeConductivity(state, this.fluidName),
        cp: state.cpmass(),
        phase: "supercritical",
      };
    }

    // Subcritical: determine region relative to saturation enthalpies
    const { Tsat, hf, hg, rhof, rhog, muf, mug } = getSatProps(
      this.fluidName,
      P,
    );

    // Two-phase dome
    if (h >= hf && h <= hg) {
      const x = (h - hf) / (hg - hf);
      const rho = 1 / (x / rhog + (1 - x) / rhof);
      const mu = 1 / (x / mug + (1 - x) / muf);

      // Try thermal conductivity (optional) using McAdams-like mixture
      let k: number | undefined;
      try {
        const cp = getCoolProp();
        const state = getState(this.fluidName);
        state.update(cp.input_pairs.PQ_INPUTS, P, 0);
        const kf = safeConductivity(state, this.fluidName);
        state.update(cp.input_pairs.PQ_INPUTS, P, 1);
        const kg = safeConductivity(state, this.fluidName);
        if (kf !== undefined && kg !== undefined && kf > 0 && kg > 0) {
          k = 1 / (x / kg + (1 - x) / kf);
        }
      } catch {
        k = undefined;
      }

      return {
        T: Tsat,
        rho,
        quality: x,
        mu,
        k,
        phase: "twoPhase",
      };
    }

    // Single-phase: subcooled liquid or superheated vapor
    const phase: FluidPhase = h < hf ? "liquid" : "vapor";
    const cp = getCoolProp();
    let state = getState(this.fluidName);
    try {
      state.update(cp.input_pairs.HmassP_INPUTS, h, P);
    } catch (e) {
      // Cached state may be corrupted after an unrecoverable CoolProp abort.
      // Retry with a fresh AbstractState before giving up.
      const msg = e instanceof Error ? e.message : String(e);
      if (
        msg.includes("abort") ||
        msg.includes("Abort") ||
        msg.includes("out of bounds")
      ) {
        state = getFreshState(this.fluidName);
        try {
          state.update(cp.input_pairs.HmassP_INPUTS, h, P);
        } catch (e2) {
          throw new FluidPropertyError(
            this.fluidName,
            "statePH (single-phase)",
            P,
            h,
            e2,
          );
        }
      } else {
        throw new FluidPropertyError(
          this.fluidName,
          "statePH (single-phase)",
          P,
          h,
          e,
        );
      }
    }

    const mu2 = safeViscosity(state, this.fluidName);
    const k2 = safeConductivity(state, this.fluidName);

    return {
      T: state.T(),
      rho: state.rhomass(),
      quality: undefined,
      mu: mu2,
      k: k2,
      cp: state.cpmass(),
      phase,
    };
  }

  /**
   * Analytic partial derivatives of statePH(P, h) with respect to P and h.
   *
   * Region branching is IDENTICAL to statePH (same getSatProps cache and the
   * same inclusive dome comparisons), so `derivativesPH(P, h).phase ===
   * statePH(P, h).phase` at every point:
   *
   * 1. Single-phase / supercritical — CoolProp `first_partial_deriv` on an
   *    HmassP-updated state (EnumValue-object calling convention).
   * 2. Two-phase (inside the dome) — analytic differentiation of the HEM
   *    mixture rules (see twoPhaseDerivs for the derivation); built from
   *    `first_saturation_deriv`, NOT CoolProp's in-dome `first_partial_deriv`,
   *    which uses a different two-phase convention and does not match our
   *    mixture ρ (docs/real-fluid-performance.md §3).
   * 3. At/near the saturation boundary — ρ(P, h) and T(P, h) have genuine
   *    KINKS at the dome edges (e.g. ∂ρ/∂h|_P jumps from the liquid value to
   *    the mixture value; for Water at 2 bar the jump is a factor ~2000 with
   *    a sign change).  There is no single derivative at the exact edge, so a
   *    subgradient convention is required.  Convention chosen: exactly at
   *    h = h_f or h = h_g — points statePH classifies as 'twoPhase' by its
   *    inclusive comparisons — the returned derivatives are the ONE-SIDED
   *    limits taken from the TWO-PHASE (dome) side.  This is the element of
   *    the Clarke subdifferential that is consistent with the branch the
   *    residual function itself takes at the point, which is the correct
   *    choice for a semismooth Newton Jacobian: an iterate sitting exactly
   *    on the edge is evolved by statePH's two-phase branch, so its
   *    derivative is the two-phase one.  Points arbitrarily close to the edge
   *    on either side get that side's smooth derivative (regions 1/2).
   *
   * Viscosity partials (∂μ/∂P|_h, ∂μ/∂h|_P) are intentionally NOT provided:
   * this coolprop-wasm build rejects both `first_partial_deriv(iviscosity,…)`
   * and `first_saturation_deriv(iviscosity, iP)` ("input to
   * get_dT_drho[viscosity] is invalid"), so analytic μ partials are not
   * available cheaply.  (See statePHDual for how the dual layer handles μ.)
   *
   * cp partials (∂cp/∂P|_h, ∂cp/∂h|_P) ARE provided for the single-phase /
   * supercritical branches (cp is EOS-derived, so this build accepts
   * first_partial_deriv(iCpmass,…)); they are undefined in the dome, matching
   * statePH, which returns no cp there.
   */
  derivativesPH(P: number, h: number): PHDerivatives {
    if (!isFinite(P) || !isFinite(h)) {
      throw new FluidPropertyError(
        this.fluidName,
        "derivativesPH",
        P,
        h,
        "Non-finite inputs",
      );
    }
    if (P <= 0) {
      throw new FluidPropertyError(
        this.fluidName,
        "derivativesPH",
        P,
        h,
        "Pressure must be positive",
      );
    }

    const { Pc } = getCritical(this.fluidName);

    // Supercritical (single-phase branch, exactly as statePH)
    if (P >= Pc) {
      return singlePhaseDerivs(this.fluidName, P, h, "supercritical");
    }

    // Subcritical: same region test as statePH
    const { hf, hg } = getSatProps(this.fluidName, P);

    // Two-phase dome (inclusive bounds — boundary convention, see doc comment)
    if (h >= hf && h <= hg) {
      return twoPhaseDerivs(this.fluidName, P, h);
    }

    return singlePhaseDerivs(this.fluidName, P, h, h < hf ? "liquid" : "vapor");
  }

  /**
   * Dual-valued statePH: property VALUES are bitwise-identical to
   * statePH(P.v, h.v) (they are computed by calling it), and each dual field
   * chains the seeded direction through the analytic partials of
   * derivativesPH(P.v, h.v):
   *
   *   rho.d = drhodP_h · P.d + drhodh_P · h.d
   *   T.d   = dTdP_h   · P.d + dTdh_P   · h.d
   *   cp.d  = dcpdP_h  · P.d + dcpdh_P  · h.d   (single-phase / supercritical)
   *
   * Because both branches dispatch identically (derivativesPH is branch-locked
   * to statePH — see its doc comment and the branch-consistency test), the
   * dome-edge kink convention is inherited exactly: exactly at h = h_f or
   * h = h_g the returned derivatives are the ONE-SIDED limits from the
   * TWO-PHASE side, matching the branch statePH itself takes there.
   *
   * VISCOSITY DECISION — μ is returned LOCALLY FROZEN (`mu.d === 0` always):
   * this coolprop-wasm build rejects analytic μ partials
   * (first_partial_deriv(iviscosity,…) and first_saturation_deriv(iviscosity, iP)
   * both throw), so the only alternatives were:
   *   (a) frozen μ (chosen) — zero marginal cost; or
   *   (b) a scoped one-sided FD for μ only — measured at 2 extra statePH
   *       flashes ≈ 138–888 µs per statePHDual call (fluid/regime dependent;
   *       probe: 2000-call timing loops on N2/N2O/H2O/H2 × liquid/vapor/
   *       supercritical/in-dome), i.e. +97 %…+201 % on top of the
   *       statePH+derivativesPH base — roughly doubling the property-layer
   *       cost of every dual Jacobian column and erasing the speed advantage
   *       the dual path exists for (an analytic partial read is sub-µs,
   *       docs/real-fluid-performance.md §2).
   * The convergence risk of wrong-by-zero is small: measured |∂μ/∂P|_h and
   * |∂μ/∂h|_P are 4–7 ORDERS OF MAGNITUDE below |∂ρ/∂·| at the same states
   * (e.g. N2 liquid: |∂μ/∂h| = 8.5e-10 vs |∂ρ/∂h| = 2.9e-3), and μ enters the
   * residual ONLY through the Darcy friction factor, whose turbulent
   * sensitivity to μ is itself weak (Blasius f ∝ Re^-1/4 ⇒ |∂ln f/∂ln μ| =
   * 1/4).  ASSUMPTION, stated plainly: the seeded directions are the solution
   * variables (node P, branch ṁ, node h); μ(P, h) varies negligibly along
   * them compared with ρ, and the flows of interest are turbulent — for a
   * laminar-dominated network the dropped term is O(f/μ) and this choice
   * should be revisited (switch to option (b)).  Newton tolerates an inexact
   * Jacobian (convergence RATE degrades, the root does not move), and the
   * existing trust-region/PTC safeguards are unaffected.  For NitrousOxide
   * statePH.mu is identically 0 (safeViscosity), so frozen μ is EXACT there,
   * not approximate.  The choice is pinned by an explicit `mu.d === 0` test
   * in statePHDual.test.ts so it is discoverable rather than an accident.
   *
   * N₂O WASM fragility: this method adds NO new CoolProp interactions — it
   * calls only statePH and derivativesPH, which already implement the
   * cached-state-corruption / fresh-AbstractState fallback pattern — so that
   * pattern is respected by construction (and exercised by the soak test).
   */
  statePHDual(P: Dual, h: Dual): PHStateDual {
    const st = this.statePH(P.v, h.v);
    const d = this.derivativesPH(P.v, h.v);
    // st.phase === d.phase at every point (branch-lock guarantee of
    // derivativesPH), so st's values and d's partials are consistent.
    const chain = (dP_h: number, dh_P: number): number =>
      dP_h * P.d + dh_P * h.d;

    let cp: Dual | undefined;
    if (st.cp !== undefined) {
      // statePH defines cp exactly in the single-phase/supercritical branches,
      // where derivativesPH provides the cp partials; if a CoolProp build ever
      // rejected iCpmass (leaving them undefined) fall back to a frozen cp —
      // same convention as μ, and still bitwise-correct in value.
      cp = { v: st.cp, d: chain(d.dcpdP_h ?? 0, d.dcpdh_P ?? 0) };
    }

    return {
      T: { v: st.T, d: chain(d.dTdP_h, d.dTdh_P) },
      rho: { v: st.rho, d: chain(d.drhodP_h, d.drhodh_P) },
      quality: st.quality,
      mu: { v: st.mu, d: 0 },
      k: st.k,
      cp,
      phase: st.phase,
    };
  }

  /** Internal energy from (P, h) — valid in dome via single mixture call. */
  internalEnergyPH(P: number, h: number): number {
    const { Pc } = getCritical(this.fluidName);
    if (P >= Pc) {
      const cp = getCoolProp();
      let state = getState(this.fluidName);
      try {
        state.update(cp.input_pairs.HmassP_INPUTS, h, P);
        return state.umass();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (
          msg.includes("abort") ||
          msg.includes("Abort") ||
          msg.includes("out of bounds")
        ) {
          state = getFreshState(this.fluidName);
          try {
            state.update(cp.input_pairs.HmassP_INPUTS, h, P);
            return state.umass();
          } catch (e2) {
            throw new FluidPropertyError(
              this.fluidName,
              "internalEnergyPH",
              P,
              h,
              e2,
            );
          }
        } else {
          throw new FluidPropertyError(
            this.fluidName,
            "internalEnergyPH",
            P,
            h,
            e,
          );
        }
      }
    }

    const { hf, hg, uf, ug } = getSatProps(this.fluidName, P);
    if (h >= hf && h <= hg) {
      const x = (h - hf) / (hg - hf);
      return uf + x * (ug - uf);
    }

    const cp = getCoolProp();
    let state = getState(this.fluidName);
    try {
      state.update(cp.input_pairs.HmassP_INPUTS, h, P);
      return state.umass();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (
        msg.includes("abort") ||
        msg.includes("Abort") ||
        msg.includes("out of bounds")
      ) {
        state = getFreshState(this.fluidName);
        try {
          state.update(cp.input_pairs.HmassP_INPUTS, h, P);
          return state.umass();
        } catch (e2) {
          throw new FluidPropertyError(
            this.fluidName,
            "internalEnergyPH",
            P,
            h,
            e2,
          );
        }
      } else {
        throw new FluidPropertyError(
          this.fluidName,
          "internalEnergyPH",
          P,
          h,
          e,
        );
      }
    }
  }

  /** Invert u(P,h) → h. Works in dome and single-phase. */
  enthalpyFromInternalEnergy(P: number, u: number): number {
    if (!isFinite(P) || !isFinite(u)) {
      throw new FluidPropertyError(
        this.fluidName,
        "enthalpyFromInternalEnergy",
        P,
        u,
        "Non-finite inputs",
      );
    }
    if (P <= 0) {
      throw new FluidPropertyError(
        this.fluidName,
        "enthalpyFromInternalEnergy",
        P,
        u,
        "Pressure must be positive",
      );
    }

    const cp = getCoolProp();

    // Try direct CoolProp inversion P,U → H
    try {
      const hDirect = cp.PropsSI("HMASS", "P", P, "UMASS", u, this.fluidName);
      if (isFinite(hDirect)) {
        return hDirect;
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (
        msg.includes("abort") ||
        msg.includes("Abort") ||
        msg.includes("out of bounds")
      ) {
        // Cached state may be corrupted; retry with a fresh AbstractState
        try {
          const fresh = getFreshState(this.fluidName);
          fresh.update(cp.input_pairs.PUmass_INPUTS, P, u);
          const hFresh = fresh.hmass();
          if (isFinite(hFresh)) {
            return hFresh;
          }
        } catch {
          // Fall through to numerical search
        }
      }
      // Fall through to numerical search
    }

    // Numerical search: bracket then bisect on h to match u
    const limits = getFluidLimits(this.fluidName);
    let hLow = limits.hmin;
    let hHigh = limits.hmax;
    let uLow = this.internalEnergyPH(P, hLow);
    let uHigh = this.internalEnergyPH(P, hHigh);

    // Ensure bracket contains target u
    if ((uLow - u) * (uHigh - u) > 0) {
      for (let i = 0; i < 20; i++) {
        if (uLow > u && uHigh > u) {
          hHigh = hLow;
          uHigh = uLow;
          hLow = limits.hmin - (limits.hmax - limits.hmin) * (i + 1);
          uLow = this.internalEnergyPH(P, hLow);
        } else if (uLow < u && uHigh < u) {
          hLow = hHigh;
          uLow = uHigh;
          hHigh = limits.hmax + (limits.hmax - limits.hmin) * (i + 1);
          uHigh = this.internalEnergyPH(P, hHigh);
        } else {
          break;
        }
      }
    }

    if ((uLow - u) * (uHigh - u) > 0) {
      throw new FluidPropertyError(
        this.fluidName,
        "enthalpyFromInternalEnergy",
        P,
        u,
        `Cannot bracket target internal energy (uLow=${uLow}, uHigh=${uHigh})`,
      );
    }

    // Bisection
    let hMid = 0;
    let uMid = 0;
    for (let i = 0; i < 80; i++) {
      hMid = (hLow + hHigh) / 2;
      uMid = this.internalEnergyPH(P, hMid);
      if (Math.abs(uMid - u) < 1e-6 * Math.max(1, Math.abs(u))) {
        return hMid;
      }
      if ((uMid - u) * (uHigh - u) > 0) {
        hHigh = hMid;
        uHigh = uMid;
      } else {
        hLow = hMid;
        uLow = uMid;
      }
    }
    return hMid;
  }
}
