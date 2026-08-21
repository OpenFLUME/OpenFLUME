/**
 * Solid-property specification (specific heat cp, thermal conductivity k).
 *  - `number`                  — constant (legacy behaviour, bit-identical);
 *  - `{ table: [[T, v], …] }`  — piecewise-linear in T (K), clamped outside the
 *                                knot range; T strictly increasing, values > 0;
 *  - `{ material: '<name>' }`  — named preset from the SOLID_MATERIALS registry
 *                                (see core/solidProperties.ts; ofhc-copper,
 *                                grcop-84, aluminum-6061-t6, stainless 304/316,
 *                                inconel-718, ptfe, g10-cr-normal/warp);
 *  - `{ expression, tRange }`  — custom temperature equation in the SAFE
 *                                expression language (core/usercode/expression.ts)
 *                                with `T` (K) in scope; sampled ONCE at solver-
 *                                context build over `tRange` ([Tmin, Tmax], both
 *                                positive K, increasing) into the canonical
 *                                piecewise-linear T curve — the sampled form then
 *                                uses the exact value/integral/slope logic of
 *                                PiecewiseLinearProperty (no per-step expression
 *                                evaluation, exact Jacobians as for `{ table }`);
 *  - `{ timeTable: [[t, v], …] }` — TIME-varying property: piecewise-linear in
 *                                solve time t (s), clamped outside the knot
 *                                range; t ≥ 0 strictly increasing, values > 0.
 *                                TRANSIENT ONLY (validate.ts rejects it in
 *                                steady mode — there is no t to evaluate at).
 *                                The value is FROZEN per candidate step at the
 *                                step's endpoint time (backward Euler): cp(t)
 *                                enters the storage term as m·cp(t_end)·ΔT/dt
 *                                and k(t) as a constant conductance for the
 *                                step, so the per-step Jacobian stays exact
 *                                (no T-derivative from a time table inside a
 *                                step).  timeTable knots join the adaptive
 *                                stepper's event grid (like schedules).
 * For T-dependent cp the solid energy storage uses the exact enthalpy
 * integral of the represented curve (see solveThermalSubsystem in
 * core/solver.ts).
 */
export type SolidPropertySpec =
  | number
  | { table: Array<[number, number]> }
  | { material: string }
  | { expression: string; tRange: [number, number] }
  | { timeTable: Array<[number, number]> };

/**
 * A statically-bound model parameter: either a literal SI number or a
 * formula object `{ expr }` written in the safe expression language
 * (core/usercode/expression.ts) and resolved ONCE at validation/solve entry
 * against the static model scope (see core/paramBindings.ts) — never during
 * a transient step or Newton iteration, so bindings cannot feed solver
 * state back into the Jacobian.
 *
 * Formula capability covers scalar values edited in the Property Panel,
 * including physical coordinates. Canvas coordinates, schedules/tables,
 * solver settings, and dynamic runtime expression systems remain separate
 * and stay literal here.
 */
export type NumberOrExpression = number | { expr: string };

/**
 * Deep-mapped NetworkConfig with every `{ expr }` formula form removed:
 * the shape the solver consumes after resolveNetworkParameters
 * (core/paramBindings.ts) has replaced each bound field with a finite SI
 * number.  Structurally a subtype of NetworkConfig, so a resolved config is
 * accepted anywhere a NetworkConfig is expected.
 */
export type ResolvedNetworkConfig = StripExpressions<NetworkConfig>;

type StripExpressions<T> = T extends { expr: string }
  ? never
  : T extends object
    ? { [K in keyof T]: StripExpressions<T[K]> }
    : T;

/**
 * Gravity acceleration vector [m/s²] in the network's physical (x, y, z)
 * coordinates — schema version 2 `settings` field.  The solver's elevation
 * term still uses pipe/heatedPipe `elevationChange` with the magnitude of
 * this default (9.80665 m/s² along −z); it does not yet read a custom
 * vector (`g · Δr` is a follow-on).
 */
export interface GravityVector {
  x: number;
  y: number;
  z: number;
}

/** Standard-gravity magnitude [m/s²] (z-up lab frame). */
export const STANDARD_GRAVITY_MAGNITUDE = 9.80665;

/**
 * Standard gravity along −z (z-up).  Frozen shared reference — it must
 * never be mutated; clone it before editing.
 */
export const DEFAULT_GRAVITY: GravityVector = Object.freeze({
  x: 0,
  y: 0,
  z: -STANDARD_GRAVITY_MAGNITUDE,
});

/**
 * Optional physical coordinates [m] in the z-up lab frame.  Canvas `x`/`y`
 * stay pixels and are never solver input.  Partial is allowed: a 1-D line
 * may set only `x`; hydrostatics may set only `z`.
 */
export interface PhysicalPosition {
  x?: NumberOrExpression;
  y?: NumberOrExpression;
  z?: NumberOrExpression;
}

export interface SolidNode {
  id: string;
  label?: string;
  x: number;
  y: number;
  /** Physical coordinates [m]; canvas `x`/`y` remain schematic pixels. */
  position?: PhysicalPosition;
  /**
   * @deprecated Decode-only alias for `position.z`.  Dropped on decode.
   */
  z?: number;
  type: "solid" | "ambient";
  group?: string;
  temperature: number;
  mass?: number;
  cp?: SolidPropertySpec;
  heatInput?: number;
  temperatureSchedule?: Array<[number, number]>;
}

export interface Conductor {
  id: string;
  label?: string;
  from: string;
  to: string;
  type:
    | {
        kind: "conduction";
        /**
         * Thermal conductivity [W/mK], or a stand-in used as conductance
         * when length is 1 m (G = k·A/L).  A `{ expr }` formula is
         * resolved once at validation/solve entry (same static scope as
         * area/length); table/material/T-equation/timeTable shapes are
         * the temperature- or time-dependent SolidPropertySpec forms.
         */
        k: SolidPropertySpec | { expr: string };
        area: NumberOrExpression;
        length: NumberOrExpression;
      }
    | {
        kind: "convection";
        h?: number;
        area: NumberOrExpression;
        correlation?: {
          /**
           * 'dittusBoelter' | 'miropolskii': single-phase / film-boiling h.
           * 'darrHartwig': Darr–Hartwig 2020 LH2 flow-boiling set (NTRS
           * 20190029114 / Cryogenics 105:102999) — full chilldown regime map
           * (NB / TB / FB with non-equilibrium x_a, T_v closure).  Opt-in;
           * fit is LH2 vertical-upflow only — selecting another fluid is
           * outside the published validity envelope (see darrHartwig.ts).
           * Requires axialPosition per conductor.
           * 'ttWf': PROPOSED two-temperature / wetted-fraction chilldown
           * closure — D-H algebraic T_v plus an
           * accepted-step subcell wetted-fraction/front state.  Phase 2
           * status: wired into the conductor heat-transfer evaluation with
           * the accepted-step lifecycle (fWet/latch frozen mid-step,
           * committed once per accepted transient step); per-conductor
           * fWet/latch/regime histories are recorded in
           * TransientResult.ttWf.  Requires axialPosition and segmentLength
           * per conductor, transient mode, and a solid wall endpoint with
           * thermal mass.
           * 'custom': user h expression in the SAFE expression language
           * (core/usercode/expression.ts — no eval), evaluated by
           * correlations.ts on the same cadence as the named models (h-map
           * refresh at attempt start + each outer iteration, frozen inside
           * the inner Newton, floor-clamped and under-relaxed identically).
           * Scope: t, Tf, Tw, P, G, D, area, flowArea, rho, mu, k, cp, Pr,
           * Re, quality (fluid-dependent identifiers are exposed only when
           * the fluid model carries them — legacy models have no k, so Pr
           * is absent there), param('name') / params.name, plus the
           * expression builtins.  `custom` does NOT require a realFluid
           * model when the expression uses only generic quantities.
           */
          model:
            "dittusBoelter" | "miropolskii" | "darrHartwig" | "ttWf" | "custom";
          /**
           * Characteristic diameter [m].  REQUIRED (positive) for the named
           * models — validate.ts enforces; OPTIONAL for 'custom' (the scope
           * exposes D / a derived flowArea only when it is set).
           */
          diameter?: NumberOrExpression;
          flowArea?: NumberOrExpression;
          /**
           * 'custom' only: the h expression [W/m²K], e.g.
           * "0.023 * (G * D / mu)^0.8 * (cp * mu / k)^0.4 * k / D".
           * Required by validate.ts for model 'custom'; rejected for other
           * models.  Compiled ONCE per solve (buildSolverContext) — never
           * re-parsed inside an iteration loop.
           */
          expression?: string;
          /**
           * 'custom' only: named numeric constants readable from the
           * expression as param('name') or params.name.  All values must be
           * finite numbers (validate.ts).
           */
          params?: Record<string, number>;
          /** darrHartwig/ttWf: axial coordinate from pipe inlet [m]
           *  (quench-front L). */
          axialPosition?: number;
          /** darrHartwig/ttWf: inlet liquid Reynolds Re_l,in (one value per
           *  pipe); default local-G estimate. */
          inletLiquidReynolds?: number;
          /**
           * ttWf only: axial length Δz of the segment this conductor
           * represents [m].  The wetted fraction f_w is a SUBCELL state:
           * the rewet front sits at z_left + f_w·Δz.  No defensible default
           * exists — required by validate.ts.
           */
          segmentLength?: number;
          /**
           * ttWf only: ratio of actual to energy-limited rewet-front speed
           * C_q, dimensionless (from the closure's design candidate-parameter
           * list).  Globally-fixed PHYSICAL parameter —
           * prior median 1, hard bounds [0.25, 4]; default 1.  NOT a solver
           * control.
           */
          frontEnergyFactor?: number;
          /**
           * ttWf only: rewet-to-dry hysteresis temperature separation
           * ΔT_h [K].  Globally-fixed PHYSICAL parameter — prior scale ~1 K,
           * hard bounds [0, 5] K; default 2 K (consistent with the D-H
           * latch offset DH_HYSTERESIS).  NOT a solver control.
           */
          rewetHysteresisOffsetK?: number;
          /**
           * ttWf only, OPT-IN (default off ⇒ bit-identical TT-WF): gate the
           * dry-side (film/SP) heat exchange by the transported cryogenic
           * front fraction a of the conductor's fluid node,
           * q_dry' = g(a)·q_dry with g = smoothstep on [0,1]
           * (docs/fluid-front-transport.md).  Setting this on ANY ttWf
           * conductor enables the network-wide front-transport state (one
           * a_i per internal fluid node, advanced once per accepted
           * transient step from the accepted branch mdots and node masses —
           * no transport-speed parameter exists); the gate itself applies
           * only to conductors carrying this flag.  Cryogenic inlet
           * boundaries are marked with the node-level `fluidFrontInlet`
           * field.  Per-node a histories are recorded in
           * TransientResult.fluidFront.  NOT a fitted model: Phase-1
           * implementation, unvalidated against data.
           */
          fluidFront?: boolean;
        };
      }
    | {
        kind: "radiation";
        emissivity: number;
        area: NumberOrExpression;
        viewFactor: number;
      };
}

export interface ArrheniusReaction {
  reactants: Record<string, number>;
  products: Record<string, number>;
  A: number;
  b: number;
  Ea: number; // J/mol
  heatOfReaction?: number; // J/kg of mixture
}

export interface SpeciesConfig {
  names: string[];
  molecularWeights: number[]; // kg/mol
  cp?: number[]; // J/kg/K per species (optional, for energy coupling)
  formationEnthalpy?: number[]; // J/kg per species (for heat of reaction)
  viscosity?: number[]; // Pa·s per species (optional; defaults to 1.8e-5)
  reactions?: ArrheniusReaction[];
}

/* ------------------------------------------------------------------ */
/* User-code / declarative-extension types                             */
/*                                                                     */
/* componentLibrary branches (dpTable / customResistance /             */
/* userComponent) are constructed by buildSolverContext, and           */
/* registers + logic rules drive the solve lifecycle via               */
/* core/logicRuntime.ts (wired in solver.ts / transient.ts).           */
/* `controllers` are minimal PID controllers executed by               */
/* core/controllerRuntime.ts after each accepted transient step.       */
/* ------------------------------------------------------------------ */

/** Lifecycle events at which logic rules / controllers may fire. */
export type HookEvent =
  | "init"
  | "stepStart"
  | "stepAccepted"
  | "stepRejected"
  | "converged"
  | "solveEnd";

/**
 * A user component in the network-level library.  `code` is user source in
 * one of two formats (see core/usercode/sandbox.ts):
 *   'defineComponent' (default) — body calling defineComponent({...});
 *   'inline'                    — bare pressure-drop function body.
 * Branches reference an entry via { type: 'userComponent', component: key }.
 */
export interface UserComponentLibraryEntry {
  code: string;
  format?: "defineComponent" | "inline";
  description?: string;
  /** Trusted descriptor captured when the source is authored/selected.
   * UI rendering reads this field and never executes embedded source. */
  metadata?: import("./usercode/sandbox").UserComponentMetadata;
}

/** Declarative logic rule: when `when` (expression string) is truthy at the
 *  hook event (`on`, default 'stepAccepted'), assign each register in `set`
 *  the value of its expression string.  Expression syntax:
 *  core/usercode/expression.ts; runtime semantics: core/logicRuntime.ts.
 *  `stop: true` requests a user termination of the solve when the rule
 *  fires (the result carries userTerminated/terminationReason); `reason`
 *  is the optional human-readable termination message. */
export interface LogicRule {
  id: string;
  on?: HookEvent;
  when: string;
  set?: Record<string, string>;
  stop?: boolean;
  reason?: string;
}

/** PID controller sense input: a fluid-node quantity (pressure /
 *  temperature / density) or a branch mass flow. */
export type ControllerSense =
  | {
      kind: "node";
      id: string;
      quantity: "pressure" | "temperature" | "density";
    }
  | { kind: "branch"; id: string; quantity: "massFlow" };

/** PID controller actuation target:
 *   valvePosition        — position of a `valve` branch (overrides its
 *                          position / positionSchedule until changed);
 *   flowRate             — mass flow of a `flowSource` branch (overrides
 *                          massFlow / massFlowSchedule);
 *   boundaryPressure     — pressure of a BOUNDARY node (overrides
 *                          pressure / pressureSchedule);
 *   boundaryTemperature  — temperature of a BOUNDARY node (overrides
 *                          temperature / temperatureSchedule);
 *   heatInput            — heat input [W] of a fluid or solid node. */
export type ControllerOutputTarget =
  | { kind: "valvePosition"; id: string }
  | { kind: "flowRate"; id: string }
  | { kind: "boundaryPressure"; id: string }
  | { kind: "boundaryTemperature"; id: string }
  | { kind: "heatInput"; id: string };

/**
 * Minimal PID controller (core/controllerRuntime.ts).  Transient solves
 * only (validate.ts rejects controllers for steady mode); `on` supports
 * 'stepAccepted' only (the default): after each accepted step the error
 * (setpoint − sensed value) drives
 *   output = kp·e + ki·∫e dt + kd·de/dt
 * (backward-Euler integral with the accepted dt; derivative zero on the
 * first execution), clamped to `limits` when given.  The clamped output is
 * written to the actuation target IMMEDIATELY, so it takes effect on the
 * NEXT transient step (base schedules still apply whenever no override has
 * been written — the controller override always wins once written).
 * `initialOutput` seeds the reported output and is written to the target at
 * t = 0 (so it already affects the first step).
 */
export interface PidControllerConfig {
  id: string;
  type: "pid";
  on?: "stepAccepted";
  sense: ControllerSense;
  setpoint: number;
  gains: { kp: number; ki: number; kd: number };
  output: ControllerOutputTarget;
  limits?: { min: number; max: number };
  initialOutput?: number;
}

/**
 * Register-following controller: copies a logic register to an actuation
 * target at stepStart (after logic stepStart rules have run).  Used to
 * drive bang-bang valve actuation from hysteresis logic without PID
 * hunting.
 */
export interface RegisterControllerConfig {
  id: string;
  type: "register";
  on?: "stepStart";
  register: string;
  output: ControllerOutputTarget;
  limits?: { min: number; max: number };
}

export type ControllerConfig = PidControllerConfig | RegisterControllerConfig;

/** Equation-of-state class for a fluid specification. */
export const FLUID_MODELS = [
  "incompressible",
  "idealGas",
  "expandableLiquid",
  "realFluid",
] as const;
export type FluidModelKind = (typeof FLUID_MODELS)[number];

/** One fluid definition: the network default or an entry in `fluids`. */
export interface FluidSpec {
  model: FluidModelKind;
  preset?: "water" | "air" | "waterExpandable";
  params?: Record<string, number | string>;
}

/** One reactant stream feeding a reacting junction. */
export interface JunctionInletConfig {
  /** Branch carrying this reactant stream.  Must END at the junction node
   *  (`to === junction.node`); its `from` endpoint carries the reactant
   *  fluid — junction inlets are the one place a branch may connect two
   *  unlike fluids. */
  branch: string;
  /** Reactant role consumed by the thermochemistry model.  The `ceaTable`
   *  model requires "oxidizer" and "fuel".  Multiple inlets may share a
   *  role; their mass flows sum. */
  role: string;
}

/** Thermochemistry closure of a reacting junction (extensible union;
 *  `ceaTable` is the only v1 member). */
export interface JunctionModelConfig {
  /** NASA CEA chamber-equilibrium tables, bilinear in (ln Pc, O/F)
   *  (core/combustion/combustionGas.ts, generated by
   *  scripts/build-cea-tables.py). */
  type: "ceaTable";
  /** Propellant pair selecting a committed CEA table
   *  (core/combustion/generated/ceaTables.ts). */
  propellants: import("./combustion/generated/ceaTables").CombustionPropellants;
  /** Combustion efficiency ∈ (0, 1]: fraction of the ideal (adiabatic)
   *  enthalpy rise achieved, h_product = efficiency · h(T0).  For a rocket
   *  chamber this equals ηc*².  Default 1 (ideal equilibrium). */
  efficiency?: number;
}

/**
 * Reacting junction: an INTERNAL node where N reactant streams of unlike
 * fluids combine into one product-gas stream, with the coupling solved
 * INSIDE the monolithic Newton system (core/solver/kernel.ts):
 *
 *   - mass: the ordinary nodal Σṁ balance already closes (reaction
 *     conserves mass);
 *   - momentum: inlet branches back-pressure against the junction node's
 *     own solved pressure (a shared unknown — no outer loop);
 *   - energy: the junction node's energy row is REPLACED by the
 *     thermochemical closure h_node = efficiency · h(T0(Pc, mixture)),
 *     with T0 from the model differentiated inside the Jacobian.
 *
 * Only the product continuum's ideal-gas property closure (R, γ, μ, cp) is
 * Picard-lagged between outer iterations, with its own settle criterion.
 * See docs/combustion.md for the physics and the v1 limitations (steady +
 * kineticEnergy only; frozen composition downstream; reactant inlet
 * enthalpy not yet a model input).
 */
export interface JunctionConfig {
  id: string;
  label?: string;
  /** INTERNAL node on the product fluid where the reactant streams react
   *  (e.g. the rocket chamber).  Its solved pressure drives the model. */
  node: string;
  /** Reactant streams (≥ 1 branch per role the model requires). */
  inlets: JunctionInletConfig[];
  /** Thermochemistry closure producing T0 and the product-gas properties. */
  model: JunctionModelConfig;
  /** Named fluid (a key into `fluids`) of the product-gas continuum.  Must
   *  resolve to an `idealGas` model; its params (R, gamma, mu, cp) are
   *  refreshed from the model between outer Picard iterations. */
  productFluid: string;
}

export interface NetworkConfig {
  /**
   * Schema version marker.  Version 2 is the canonical (and only) supported
   * version; the decode boundary (core/config.ts decodeNetworkConfig)
   * rejects anything else explicitly.
   */
  meta: { name: string; version: 2 };
  /**
   * Physically-meaningful closure-correlation constants (wall heat
   * transfer, wall friction) plus the clearly-labeled `solidCpScale`
   * MATERIAL-PROPERTY nuisance parameter.  Optional; unspecified groups
   * take the published constants (DEFAULT_CLOSURE_PARAMS), and the
   * arithmetic is then bit-identical to a config without this field.
   * Solver NUMERICS (relaxation, trust-region, floors, blend sharpness,
   * thresholds, iteration caps, FD steps) are structurally NOT reachable
   * through this object — see core/closureParams.ts.
   */
  closureParams?: import("./closureParams").ClosureParams;
  settings: {
    mode: "steady" | "transient";
    dt?: number;
    endTime?: number;
    tolerance: number;
    maxIterations: number;
    relaxation?: number;
    /**
     * Gravity vector [m/s²].  Optional (defaults to DEFAULT_GRAVITY, −z).
     * Hydrostatics still use pipe/heatedPipe `elevationChange` × 9.80665.
     */
    gravity?: GravityVector;
    /**
     * Include the momentum-flux (convective acceleration) term in the branch
     * momentum equation: ΔP_accel = (ṁ/A)²·(1/ρ_downstream − 1/ρ_upstream),
     * with endpoint densities and the branch flow area.  Captures the
     * pressure drop from flow acceleration when the fluid expands along a
     * branch (heating, compressibility).  Off by default: the term is
     * identically zero for constant-density flow, and leaving it off
     * preserves the published-benchmark baselines that were validated
     * without it.  Branches whose component carries no flow area
     * contribute no acceleration term.
     */
    momentumFlux?: boolean;
    /**
     * Include the kinetic-energy (stagnation-enthalpy) term in the nodal
     * energy balance: each branch transports ṁ·(h + V²/2) with
     * V = ṁ/(ρA) at the respective endpoint state and the branch flow
     * area.  Together with `momentumFlux` this upgrades the network to a
     * quasi-1-D compressible formulation: a duct discretised into pipe
     * segments then reproduces Fanno flow (friction choking, static-T
     * drop at constant T₀), Rayleigh flow, and nozzle flow (validated
     * against the analytical solutions in NASA TFAWS-2007 / GFSSP,
     * NTRS 20070036728).  Off by default — the term is negligible at low
     * Mach and leaving it off preserves published-benchmark baselines.
     * Supported for every fluid model: steady solves use the coupled
     * [P, ṁ, h] enthalpy-primary system, so real fluids (CoolProp) ride the
     * same formulation as the analytic models.  Species networks keep the
     * segregated stagnation-enthalpy update (composition is not a coupled
     * unknown).  Branches whose component carries no flow area contribute
     * no kinetic energy.
     */
    kineticEnergy?: boolean;
    timeStepping?: "fixed" | "adaptive";
    steadySolver?: "ptc" | "direct";
    globalization?: "trustRegion" | "lineSearch";
    jacobian?: "hybrid" | "fd";
    /** EXPERIMENTAL, opt-in (default off): coupled-honesty gate.  Re-verify
     *  the scaled residual at the post-wall-solve / post-h-map state before
     *  certifying a transient real-fluid step (the energy-certification
     *  finding).  Investigation flag only — do NOT
     *  enable by default until the dome-edge stall question is resolved. */
    coupledHonestyGate?: boolean;
    adaptive?: {
      dtInitial?: number;
      dtMin: number;
      dtMax: number;
      relTol: number;
      absTolP?: number;
      absTolT?: number;
      safety?: number;
    };
  };
  /** Default fluid. Nodes with no `fluid` name use this specification. */
  fluid: FluidSpec;
  /**
   * Named extra fluids (isolated continua). A node may set `fluid` to a key
   * in this map; omitted `fluid` means the default. Branches may only join
   * nodes that resolve to the same named fluid. Unlike fluids couple only
   * thermally, through solids. EOS classes may differ between entries (e.g.
   * an idealGas hot side with a realFluid coolant) — since unlike fluids
   * never share an equation, the solver dispatches property access per node.
   */
  fluids?: Record<string, FluidSpec>;
  species?: SpeciesConfig;
  /** Named numeric registers readable/writable by user expressions
   *  (expression scope `reg('name')` or a bare identifier).  Initial values;
   *  logic rules may create additional registers by assignment. */
  registers?: Record<string, number>;
  /** Declarative logic rules over registers/schedules (core/logicRuntime.ts). */
  logic?: LogicRule[];
  /** Declarative PID controllers (core/controllerRuntime.ts).  Transient
   *  solves only — validate.ts rejects controllers in steady mode. */
  controllers?: ControllerConfig[];
  /** Reacting junctions (core/solver/kernel.ts energy-closure rows).
   *  Steady + kineticEnergy solves only — validate/junctions.ts rejects
   *  anything else in v1.  See JunctionConfig for the physics. */
  junctions?: JunctionConfig[];
  /** User-code component library, keyed by component name. */
  componentLibrary?: Record<string, UserComponentLibraryEntry>;
  nodes: Array<{
    id: string;
    label?: string;
    type: "internal" | "boundary";
    x: number;
    y: number;
    /**
     * Physical coordinates [m] (z-up).  Canvas `x`/`y` remain schematic
     * pixels.  Decode still accepts a legacy top-level `z` and copies it
     * to `position.z`.
     */
    position?: PhysicalPosition;
    /**
     * @deprecated Decode-only alias for `position.z`.  Dropped on decode.
     */
    z?: number;
    group?: string;
    pressure?: number;
    temperature?: number;
    quality?: number;
    /** Node fluid volume [m³] — formula-bindable (NumberOrExpression). */
    volume?: NumberOrExpression;
    heatInput?: number;
    pressureSchedule?: Array<[number, number]>;
    temperatureSchedule?: Array<[number, number]>;
    gasCushion?: { initialGasVolume: number; polytropicIndex: number };
    massFractions?: Record<string, number>;
    /**
     * Named fluid from `fluids`. Absent means the network default
     * (`config.fluid`). A branch may connect two nodes only when they
     * resolve to the same fluid.
     */
    fluid?: string;
    /**
     * Cryogenic-front boundary input value a_bnd ∈ [0,1] — BOUNDARY nodes
     * only, and only meaningful when at least one ttWf conductor opts into
     * the fluid-front model (correlation.fluidFront: true).  1 marks a
     * cryogenic inlet: flow ENTERING the domain through this node carries
     * front fraction a = 1 (pure cryogenic-inlet fluid); 0/absent marks a
     * warm/ordinary boundary.  Outflow through the boundary always carries
     * the internal upwind node's a.  See docs/fluid-front-transport.md.
     */
    fluidFrontInlet?: number;
  }>;
  solidNodes?: SolidNode[];
  conductors?: Conductor[];
  groups?: Array<{
    id: string;
    label: string;
    x: number;
    y: number;
  }>;
  /**
   * Free-floating canvas annotations.  Documentation for the human reader:
   * assumptions, references, review remarks.  The solver never sees them —
   * they carry no numerics, participate in no connectivity, and are excluded
   * from the provenance hash, so adding or editing a note leaves results and
   * run-history comparisons untouched.
   */
  notes?: Array<{
    id: string;
    /** Note body.  May contain newlines. */
    text: string;
    x: number;
    y: number;
    /**
     * Card size in canvas px, written only once the user drags the resize
     * handle.  While absent the card takes the default width and grows
     * downward with its text; an explicit size is honoured verbatim and the
     * text scrolls inside it.
     */
    width?: number;
    height?: number;
    /** Subnetwork this note is pinned inside; absent = the main canvas. */
    group?: string;
  }>;
  branches: Array<{
    id: string;
    label?: string;
    from: string;
    to: string;
    /**
     * Initial mass-flow guess [kg/s] for the Newton solver (steady solves
     * and the first transient step).  Purely a warm start — it does not
     * constrain the converged solution.  Strongly-compressible networks
     * (near-choked ducts) may need a guess near the expected flow to keep
     * Newton on the subsonic solution branch, exactly as GFSSP requires
     * initial flow-rate guesses.  Default 0.1 kg/s.
     */
    initialMdot?: number;
    component:
      | {
          type: "pipe";
          length: NumberOrExpression;
          diameter: NumberOrExpression;
          roughness: number;
          elevationChange?: number;
          inertia?: boolean;
          /** Fixed Darcy friction factor.  When set, the Colebrook/Swamee–Jain
           *  correlation is bypassed and this constant f is used at every
           *  Reynolds number (0 gives a frictionless pipe).  Matches the
           *  constant-f convention of textbook Fanno/Rayleigh problems and
           *  GFSSP benchmark cases. */
          frictionFactor?: number;
          /** Outlet diameter [m] for a linearly tapered pipe (quasi-1-D area
           *  change, e.g. one segment of a converging-diverging nozzle).
           *  Friction uses the mean diameter; with settings.momentumFlux and
           *  settings.kineticEnergy the endpoint areas feed the acceleration
           *  and kinetic-energy terms.  Omit for a constant-diameter pipe. */
          diameterOut?: number;
        }
      | { type: "orifice"; area: NumberOrExpression; cd: number }
      | { type: "orificeCompressible"; area: NumberOrExpression; cd: number }
      | {
          type: "cavitatingVenturi";
          throatArea: NumberOrExpression;
          cd: number;
          recoveryFactor?: number;
        }
      | { type: "resistance"; k: number; area: NumberOrExpression }
      | {
          type: "valve";
          area: NumberOrExpression;
          cd: number;
          position: number;
          positionSchedule?: Array<[number, number]>;
        }
      | { type: "checkValve"; area: NumberOrExpression; cd: number }
      /** Spring-mass-damper poppet dynamics (see DynamicCheckValve): the
       *  position is a genuine ODE state advanced once per accepted
       *  transient step, not an algebraic function of flow direction.
       *  Steady solves hold the fixed `initialPosition` for the whole
       *  solve (no dynamics — there is no time axis). */
      | {
          type: "dynamicCheckValve";
          area: NumberOrExpression;
          cd: number;
          /** Moving mass of the poppet/disc (plus any effective added
           *  fluid mass) [kg]. Must be positive — a massless valve has no
           *  well-posed dynamics. */
          mass: number;
          /** Spring stiffness k [N/m]. */
          springRate: number;
          /** Spring preload force at x=0 [N] — the closing force that sets
           *  the cracking pressure ≈ preload / discArea. */
          preload: number;
          /** Viscous damping coefficient c [N·s/m]. 0 = undamped (may
           *  chatter/oscillate indefinitely around equilibrium). */
          damping: number;
          /** Full poppet travel from seated (x=0) to fully open (x=stroke) [m]. */
          stroke: number;
          /** Disc area the pressure differential acts on [m²]. Defaults to
           *  `area` (the orifice/seat area) when omitted. */
          discArea?: number;
          /** Initial fractional opening in [0,1] at t=0. Default 0 (closed). */
          initialPosition?: number;
        }
      | {
          type: "reliefValve";
          crackPressure: number;
          fullOpenPressure: number;
          area: NumberOrExpression;
          cd: number;
        }
      | { type: "pump"; curve: Array<[number, number]> }
      | {
          type: "bend";
          diameter: NumberOrExpression;
          angle: number;
          rOverD: number;
          roughness?: number;
        }
      | {
          type: "areaChange";
          areaIn: NumberOrExpression;
          areaOut: NumberOrExpression;
        }
      | {
          type: "flowSource";
          massFlow: number;
          massFlowSchedule?: Array<[number, number]>;
        }
      | { type: "regulator"; setPressure: number; maxCdA: NumberOrExpression }
      | {
          type: "heatedPipe";
          length: NumberOrExpression;
          diameter: NumberOrExpression;
          roughness: number;
          elevationChange?: number;
          ua: NumberOrExpression;
          wallTemperature: number;
          boilingModel?: "miropolskii";
        }
      /** Tabulated ΔP(ṁ): [mdot, dP] pairs, mdot strictly increasing; see DpTable. */
      | {
          type: "dpTable";
          points: Array<[number, number]>;
          extrapolate?: "clamp" | "linear";
        }
      /** Constant K or Reynolds-dependent K(Re) table; diameter required for kTable. */
      | {
          type: "customResistance";
          k: number | { kTable: Array<[number, number]> };
          area: NumberOrExpression;
          diameter?: NumberOrExpression;
        }
      /** User-code component referencing componentLibrary[component]. */
      | {
          type: "userComponent";
          component: string;
          params?: Record<string, number>;
          area?: NumberOrExpression;
        };
  }>;
}

/**
 * Reporting-only fluid-node properties beyond (P, T, ρ), computed once per
 * published state by core/solver/derivedProperties.ts.  Every field is
 * optional and absent — never defaulted — when the node's fluid model cannot
 * supply it: the analytic models define no absolute entropy reference and no
 * conductivity, and cp / sound speed are not single-valued inside the
 * two-phase dome.  Downstream, an absent field is simply not a channel.
 */
export interface NodeStateProperties {
  /** Specific enthalpy h [J/kg]. */
  enthalpy?: number;
  /** Specific internal energy u [J/kg]. */
  internalEnergy?: number;
  /** Absolute specific entropy s [J/(kg·K)] (real fluids only). */
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

/** Per-junction reporting summary attached to SteadyResult when the network
 *  declares reacting junctions.  Reporting only — every quantity is derived
 *  from the converged state; nothing here feeds back into the solve. */
export interface JunctionSummary {
  /** Solved junction (chamber) pressure [Pa]. */
  pc: number;
  /** Solved product-node temperature [K] (efficiency already applied). */
  productTemperature: number;
  /** Per-role inlet mass flows [kg/s] (Σ|ṁ| over that role's inlets). */
  mdotByRole: Record<string, number>;
  /** Total product mass flow Σ inlets [kg/s]. */
  mdotTotal: number;
  /** Oxidizer/fuel mass ratio — present when the model uses those roles. */
  of?: number;
  /** Product gas state from the thermochemistry model at the solved
   *  (pc, inlet flows): adiabatic T0, mw, R, gamma, cp, mu, cstar. */
  gas: import("./combustion/combustionGas").CombustionGasState;
  /** True when the solved pc fell outside the model's tabulated pressure
   *  range and was clamped to the nearest edge. */
  clampedPc: boolean;
  /** True when the solved mixture ratio fell outside the tabulated range
   *  and was clamped to the nearest edge. */
  clampedOf: boolean;
}

export interface SteadyResult {
  converged: boolean;
  iterations: number;
  residual: number;
  /** Per-junction coupling summary, keyed by JunctionConfig.id — present
   *  only when the network declares reacting junctions. */
  junctions?: Record<string, JunctionSummary>;
  nodes: Record<
    string,
    NodeStateProperties & {
      pressure: number;
      temperature: number;
      density: number;
      quality?: number;
      phase?: string;
      massFractions?: Record<string, number>;
    }
  >;
  branches: Record<
    string,
    {
      mdot: number;
      velocity: number;
      dP: number;
      reynolds: number;
      /** Mach number |V|/a at the upstream endpoint state — present only when
       *  the branch fluid model supplies a speed of sound (√(γRT) for ideal
       *  gases; the CoolProp value for real fluids outside the dome). */
      mach?: number;
      /** Volumetric flow Q = ṁ/ρ [m³/s] at the upstream endpoint state. */
      volumetricFlow?: number;
      /** Mass flux G = ṁ/A [kg/(m²·s)] — components with a flow area only. */
      massFlux?: number;
      /** Dynamic pressure ½ρV² [Pa] — components with a flow area only. */
      dynamicPressure?: number;
    }
  >;
  solidNodes?: Record<string, { temperature: number }>;
  conductors?: Record<
    string,
    {
      heatRate: number;
      heatTransferCoeff?: number;
      /** Wall heat flux q″ = Q/A [W/m²] — present when the transfer area is
       *  positive (all three conductor kinds carry one). */
      heatFlux?: number;
    }
  >;
  aborted?: boolean;
  ptcDeltaTau?: number | number[];
  ptcShrinks?: number;
  /**
   * User-logic termination flag (core/logicRuntime.ts): present and true
   * only when a logic rule with `stop: true` fired during the solve.  The
   * result is then the partial state at the stop point (steady: the
   * best/last iterate, also marked aborted).
   */
  userTerminated?: boolean;
  /** Human-readable reason from the stopping logic rule (`reason` field). */
  terminationReason?: string;
  /** Final register values — present whenever the network configures
   *  registers and/or logic rules. */
  finalRegisters?: Record<string, number>;
}

/**
 * Accepted-step TT-WF state history of ONE ttWf conductor, aligned 1:1 with
 * TransientResult.times (recorded at t = 0 and after every accepted step —
 * never at rejected adaptive trials, so the series advances exactly once per
 * accepted step by construction).
 */
export interface TtWfConductorHistory {
  /** Wetted fraction f_w ∈ [0,1] (subcell front coordinate z = z_left + f_w·Δz). */
  fWet: number[];
  /** Rewet-hysteresis latch (set: wall rewetted / rewetting allowed). */
  rewetLatched: boolean[];
  /** Area-dominant un-blended regime label of the two-side flux map at the
   *  committed fWet (≥ 0.5 ⇒ wet side: 'DB'|'NB'|'TB'|'FB'; else dry side:
   *  'FB'|'SP'). */
  regime: Array<"DB" | "NB" | "TB" | "FB" | "SP">;
}

/**
 * Accepted-step fluid-front history of ONE internal fluid node, aligned 1:1
 * with TransientResult.times (recorded at t = 0 and after every accepted
 * step — never at rejected adaptive trials; see docs/fluid-front-transport.md).
 */
export interface FluidFrontNodeHistory {
  /**
   * Cryogenic front fraction a ∈ [0,1]: the advected cryogenic-inlet-fluid
   * inventory fraction of the node (NOT equilibrium quality, NOT vapor
   * temperature, NOT wall wetted fraction).
   */
  fraction: number[];
}

/**
 * Per-accepted-step trajectories of the reporting-only node properties, each
 * aligned 1:1 with TransientResult.times.  Same optionality contract as
 * NodeStateProperties: a property the fluid model cannot supply has no array
 * at all rather than an array of zeros.
 */
export type NodeStatePropertyHistories = {
  [K in keyof NodeStateProperties]?: number[];
};

/**
 * Per-accepted-step branch flow trajectories beyond mass flow.  Recorded for
 * every branch (ΔP / velocity / Reynolds unconditionally, the rest subject to
 * the same availability rules as the steady fields), so a transient run can
 * plot the same flow quantities a steady run reports.
 */
export interface BranchFlowHistories {
  /** Bulk velocity V = ṁ/(ρA) at the upstream endpoint state [m/s]. */
  velocity?: number[];
  /**
   * Branch pressure drop [Pa]: the component's own closure evaluated at each
   * accepted step (elevation head included, plus the momentum-flux term when
   * settings.momentumFlux is on).  With fluid inertia this deliberately
   * differs from P_from − P_to, because the momentum balance also carries
   * ∂ṁ/∂t.
   */
  dP?: number[];
  reynolds?: number[];
  mach?: number[];
  volumetricFlow?: number[];
  massFlux?: number[];
  dynamicPressure?: number[];
}

export interface TransientResult {
  converged: boolean;
  times: number[];
  nodes: Record<
    string,
    NodeStatePropertyHistories & {
      pressure: number[];
      temperature: number[];
      density: number[];
      gasVolume?: number[];
      quality?: number[];
      phase?: string[];
      massFractions?: Record<string, number[]>;
    }
  >;
  branches: Record<string, BranchFlowHistories & { mdot: number[] }>;
  solidNodes?: Record<string, { temperature: number[] }>;
  conductors?: Record<
    string,
    {
      heatRate: number[];
      heatTransferCoeff?: number[];
      /** Wall heat flux q″ = Q/A [W/m²] per accepted step. */
      heatFlux?: number[];
    }
  >;
  /**
   * Per-step inner-Newton residual norms (raw mixed-unit and row-floor
   * scaled).  Present for fixed-stepping solves.  The scaled series is the
   * honest per-step convergence measure for stiff real-fluid steps: it is
   * ~1e-6…1e-4 on genuinely converged steps and ≥ 0.01 on stalled ones
   * (see solver.ts convergence-flag comment).  `converged` is the AND of
   * the per-step flags; these series localise WHICH step failed and by how
   * much, which the aggregate flag cannot.
   */
  stepResiduals?: number[];
  stepResidualsScaled?: number[];
  /**
   * TT-WF accepted-step state histories, keyed by conductor id (present
   * only when the network configures ttWf conductors; optional and
   * backward-compatible).  See TtWfConductorHistory.
   */
  ttWf?: Record<string, TtWfConductorHistory>;
  /**
   * Fluid-front accepted-step state histories, keyed by INTERNAL fluid node
   * id (present only when at least one ttWf conductor opts in via
   * correlation.fluidFront; optional and backward-compatible).  See
   * FluidFrontNodeHistory and docs/fluid-front-transport.md.
   */
  fluidFront?: Record<string, FluidFrontNodeHistory>;
  aborted?: boolean;
  /**
   * User-logic termination flag (core/logicRuntime.ts): present and true
   * only when a logic rule with `stop: true` fired; the result is the
   * partial trajectory recorded up to the stop point.
   */
  userTerminated?: boolean;
  /** Human-readable reason from the stopping logic rule (`reason` field). */
  terminationReason?: string;
  /** Final register values — present whenever the network configures
   *  registers and/or logic rules. */
  finalRegisters?: Record<string, number>;
  /** Final (clamped) PID controller outputs, keyed by controller id —
   *  present whenever the network configures controllers.  The value is
   *  the output computed after the LAST accepted step, i.e. the actuation
   *  that would apply to the next step. */
  finalControllerOutputs?: Record<string, number>;
  stats?: {
    steps: number;
    rejectedSteps: number;
    minDt: number;
    maxDt: number;
    dtAtMinCount?: number;
    /** True when one or more adaptive steps were accepted at dtMin despite
     * the step-doubling error estimate exceeding the requested tolerance. */
    accuracyLimited?: boolean;
  };
}
