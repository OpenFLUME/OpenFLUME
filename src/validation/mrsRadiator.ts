/**
 * 1973 Shuttle Modular Radiator System (MRS) thermal-vacuum case: network
 * builder, registry/outlet readers and metrics.  Shared by the CI gates and
 * the validation report.  The protocol (comparison set, exclusions, modelling
 * choices, metrics) is fixed in docs/validation/mrs-protocol.md and the data
 * and provenance are in validation/data/digitized/mrs/README.md.
 *
 * Physics.  Eleven main tubes per panel (lengths 3, 5, ... 23 ft, ID 0.125 in,
 * wall 0.033 in) welded to 0.020 in aluminium sheet on 6.0 in centres.  Each
 * tube owns a fin strip one pitch wide.  The flow is imposed (a flowSource on
 * every branch, equal split over the tubes).  Each tube is a chain of
 * segments.  A segment has one fluid node (the cell outlet state), an inner
 * and an outer tube wall node, and `finNodes` fin nodes across the half pitch.
 * Fin conduction acts across the half pitch and along the tube, the exposed
 * tube crown and the fin radiate to a -280 F sink node, and the absorbed
 * flux enters as node heat input.  The tubes of a panel discharge into a mixing
 * node.  Panels of a leg are solved one network each and chained in series
 * (the mixed outlet state of one panel is the inlet of the next).
 *
 * Pressure.  A network whose branches are all flowSources leaves the node
 * pressures undetermined, and the solver then lets them drift (by hundreds of
 * kPa).  The R21 enthalpy depends on pressure, so temperatures would shift by
 * about 0.1 K.  Only the first branch of each tube is a flowSource.  Every
 * other branch is a viscosity-free K resistance, so the pressures follow from
 * the outlet boundary and stay within a few hundred pascal of the loop
 * pressure.
 *
 * Fluid.  R21 (Freon-21): density, specific heat and enthalpy come from the
 * CoolProp R21 equation of state.  Viscosity and conductivity are not in the
 * CoolProp build, so the wall-fluid heat transfer coefficient is a custom
 * convection expression that carries its own mu(T) and k(T) (fits of the
 * committed transport table, see MRS_R21_TRANSPORT).  The fluid is declared
 * with `params.transport = "external"`, which tells validation that no
 * built-in correlation or pipe friction may be attached to it.
 */

import { solveSteady, validateNetwork } from "../core";
import type { NetworkConfig } from "../core";
import { RealFluid } from "../core/fluids/realFluid";

/* ------------------------------------------------------------------ */
/* Units and constants                                                 */
/* ------------------------------------------------------------------ */

export const FT = 0.3048;
export const IN = 0.0254;
export const BTUHR_FT2_TO_W_M2 = 3.15459075;
export const LBHR_TO_KGS = 0.45359237 / 3600;
export const W_TO_BTUHR = 3.412141633;
export const f2k = (f: number): number => (f - 32) / 1.8 + 273.15;
export const k2f = (k: number): number => (k - 273.15) * 1.8 + 32;

/** Loop pressure [Pa].  Not published, see the protocol. */
export const MRS_PRESSURE = 1.5e6;

/** Geometry of one panel (Vol III Table 1, Vol II section 3.1, Vol VIII Fig. 2). */
export const MRS_GEOMETRY = {
  tubeLengthsFt: [3, 5, 7, 9, 11, 13, 15, 17, 19, 21, 23],
  /** Inside diameter [m]. */
  ID: 0.125 * IN,
  /** Outside diameter [m]. */
  OD: (0.125 + 2 * 0.033) * IN,
  /** Tube pitch [m]. */
  pitch: 6.0 * IN,
  /** Sheet thickness [m]. */
  sheet: 0.02 * IN,
} as const;

/** Modelling choices fixed in the protocol. */
export const MRS_CHOICES = {
  /** Aluminium conductivity [W/m-K]: NIST 6063-T5 fit at 295 K, held constant. */
  kAl: 201,
  emissivity: 0.9,
  sinkF: -280,
  /** Effective area of the cavity side of a two-sided panel, over the panel area. */
  twoSidedExtra: 0.67,
  /** Laminar Nusselt number (constant wall temperature). */
  nuLaminar: 3.66,
} as const;

/**
 * Fits of the committed R21 transport table (mrs_r21_transport_table.csv,
 * -95 to 220 F, 1.5 MPa) in x = (T[K] - 280)/100.
 *   ln(mu [Pa s]) = c0 + c1 x + c2 x^2 + c3 x^3 + c4 x^4   (max error 0.28 %)
 *   k [W/m-K]     = d0 + d1 x + d2 x^2 + d3 x^3             (max error 0.15 %)
 * The table is the CoolProp ECS evaluation of the REFPROP R21.FLD transport
 * block (see the data README).
 */
export const MRS_R21_TRANSPORT = {
  c: [-7.8828676, -0.88487304, 0.31984185, -0.20753926, 0.048304591],
  d: [0.10699949, -0.035281473, 0.0028614205, -0.0018107556],
} as const;

/* ------------------------------------------------------------------ */
/* Convection expression                                               */
/* ------------------------------------------------------------------ */

/**
 * Custom h expression of the wall-fluid conductor.  Local Re = G D / mu(Tf)
 * from the local mass flux, mu and k from the R21 fits, cp from CoolProp.
 * Nusselt number: laminar value to Re 2300, Gnielinski (Petukhov friction
 * factor) from Re 4000, linear blend in Re between.  Parameters read from
 * `params`: c0..c4, d0..d3, muScale, kScale, nuLam, hScale.
 */
export function mrsConvectionExpression(): string {
  const X = "((Tf-280)/100)";
  const MU = `(params.muScale*exp(params.c0+${X}*(params.c1+${X}*(params.c2+${X}*(params.c3+${X}*params.c4)))))`;
  const K = `(params.kScale*(params.d0+${X}*(params.d1+${X}*(params.d2+${X}*params.d3))))`;
  const RE = `(G*D/${MU})`;
  const PR = `(cp*${MU}/${K})`;
  const gn = (R: string): string => {
    const F = `((0.79*log(${R})-1.64)^(-2))`;
    return `(${F}/8*(${R}-1000)*${PR}/(1+12.7*sqrt(${F}/8)*(${PR}^(2/3)-1)))`;
  };
  const W = `((${RE}-2300)/1700)`;
  const NU =
    `(${RE}<=2300 ? params.nuLam : (${RE}>=4000 ? ${gn(RE)} : ` +
    `((1-${W})*params.nuLam+${W}*${gn("4000")})))`;
  return `params.hScale*${NU}*${K}/D`;
}

/* ------------------------------------------------------------------ */
/* Options and network builder                                         */
/* ------------------------------------------------------------------ */

export interface MrsOptions {
  /** Axial segments per tube.  Default 8. */
  segments: number;
  /** Fin nodes across the half pitch.  Default 5. */
  finNodes: number;
  emissivity: number;
  /** Fin and tube conductivity [W/m-K]. */
  kAl: number;
  fluxScale: number;
  muScale: number;
  kScale: number;
  hScale: number;
  nuLaminar: number;
  /** Tube flow weight is L^p, 0 means equal split. */
  splitExponent: number;
  /** Cavity-side effective area factor of a two-sided panel. */
  twoSidedExtra: number;
  /** Include radial and axial tube wall conduction.  Default true. */
  wallConduction: boolean;
  tolerance: number;
  maxIterations: number;
}

export const MRS_DEFAULTS: MrsOptions = {
  segments: 8,
  finNodes: 5,
  emissivity: MRS_CHOICES.emissivity,
  kAl: MRS_CHOICES.kAl,
  fluxScale: 1,
  muScale: 1,
  kScale: 1,
  hScale: 1,
  nuLaminar: MRS_CHOICES.nuLaminar,
  splitExponent: 0,
  twoSidedExtra: MRS_CHOICES.twoSidedExtra,
  wallConduction: true,
  /**
   * Solver tolerance.  The pressure-anchoring rows put a round-off floor of
   * about 1.5e-10 under the raw residual (pressures are 1.5e6 Pa), so 1e-11
   * does not converge.  The tolerance is judged by the panel heat balance
   * instead.  On TP1A panel 1 (4 and 8 segments) 1e-10 closes the balance to
   * 5e-5 and 2e-4 of the panel heat (0.07 and 0.3 W of 1420 W) and 1e-9 closes
   * it to 1e-4 and 1e-3.  A panel heat error of 1e-3 is 0.04 F of outlet
   * temperature, so a solve is accepted when it has converged and the balance
   * is under 1e-3 (MRS_CLOSURE_LIMIT), trying 1e-10, 3e-10 and 1e-9 in turn.
   */
  tolerance: 1e-10,
  maxIterations: 300,
};

export interface MrsLegSpec {
  /** Panel numbers in the order of flow. */
  panels: number[];
  /** Leg flow [kg/s]. */
  mdot: number;
  /** Inlet temperature [F]. */
  tinF: number;
  /** Absorbed flux per panel number [Btu/hr-ft2]. */
  flux: Record<number, number>;
  /** 1 or 2 radiating sides. */
  sides: 1 | 2;
  /** Subset of tube indices (0 based).  Default all eleven. */
  tubes?: number[];
}

/** One panel of a leg. */
export interface MrsPanelSpec {
  panel: number;
  /** Panel (leg) flow [kg/s]. */
  mdot: number;
  /** Inlet temperature [F]. */
  tinF: number;
  /** Absorbed flux [Btu/hr-ft2]. */
  flux: number;
  sides: 1 | 2;
  /** Subset of tube indices (0 based).  Default all eleven. */
  tubes?: number[];
}

/** Largest accepted relative panel heat imbalance (see MRS_DEFAULTS.tolerance). */
export const MRS_CLOSURE_LIMIT = 1e-3;

/** Loss factor of the pressure-anchoring resistances (no physical meaning, a few tens of pascal per segment). */
export const MRS_ANCHOR_K = 0.01;

export interface MrsNetworkIndex {
  /** Panel mixing (outlet) node id. */
  mix: string;
  /** Per-tube mass flow [kg/s] by tube index. */
  tubeFlow: Record<number, number>;
  /** Number of solid unknowns (excluding the sink). */
  nSolid: number;
  nFluid: number;
}

/** Equal (p = 0) or length-weighted tube flow fractions over the eleven tubes. */
export function tubeFractions(p: number, tubes?: number[]): number[] {
  const all = MRS_GEOMETRY.tubeLengthsFt.map((L) => Math.pow(L, p));
  const idx = tubes ?? all.map((_, i) => i);
  const sum = idx.reduce((s, i) => s + all[i], 0);
  return idx.map((i) => all[i] / sum);
}

/** Build the OpenFLUME network of one panel of the MRS. */
export function buildMrsPanelNetwork(
  spec: MrsPanelSpec,
  partial: Partial<MrsOptions> = {},
): { config: NetworkConfig; index: MrsNetworkIndex } {
  const o: MrsOptions = { ...MRS_DEFAULTS, ...partial };
  const g = MRS_GEOMETRY;
  const { c, d } = MRS_R21_TRANSPORT;
  const N = o.segments;
  const NF = o.finNodes;
  const tubes = spec.tubes ?? g.tubeLengthsFt.map((_, i) => i);
  const frac = tubeFractions(o.splitExponent, spec.tubes);
  const sides = spec.sides === 2 ? 1 + o.twoSidedExtra : 1;
  const Tin = f2k(spec.tinF);
  const Tsink = f2k(MRS_CHOICES.sinkF);
  const P0 = MRS_PRESSURE;
  const ro = g.OD / 2;
  const ri = g.ID / 2;
  const bFin = g.pitch / 2 - ro;
  const dFin = bFin / NF;
  const flowArea = (Math.PI / 4) * g.ID * g.ID;
  const wallArea = Math.PI * (ro * ro - ri * ri);
  const kAl = o.kAl;
  const qabs = spec.flux * BTUHR_FT2_TO_W_M2 * o.fluxScale;

  const nodes: NetworkConfig["nodes"] = [];
  const solidNodes: NonNullable<NetworkConfig["solidNodes"]> = [];
  const conductors: NonNullable<NetworkConfig["conductors"]> = [];
  const branches: NetworkConfig["branches"] = [];
  const index: MrsNetworkIndex = {
    mix: "mix",
    tubeFlow: {},
    nSolid: 0,
    nFluid: 0,
  };

  nodes.push({
    id: "in",
    type: "boundary",
    x: 0,
    y: 0,
    pressure: P0,
    temperature: Tin,
  });
  solidNodes.push({
    id: "sink",
    type: "ambient",
    x: 0,
    y: 400,
    temperature: Tsink,
  });
  nodes.push({
    id: "mix",
    type: "internal",
    x: 1000,
    y: 0,
    pressure: P0,
    temperature: Tin,
    volume: 1e-6,
  });
  index.nFluid++;

  const params: Record<string, number> = {
    muScale: o.muScale,
    kScale: o.kScale,
    nuLam: o.nuLaminar,
    hScale: o.hScale,
  };
  c.forEach((v, i) => (params[`c${i}`] = v));
  d.forEach((v, i) => (params[`d${i}`] = v));
  const expression = mrsConvectionExpression();
  const resistance = (area: number) => ({
    type: "resistance" as const,
    k: MRS_ANCHOR_K,
    area,
  });

  tubes.forEach((ti, it) => {
    const mTube = spec.mdot * frac[it];
    index.tubeFlow[ti] = mTube;
    const L = g.tubeLengthsFt[ti] * FT;
    const ls = L / N;
    let prevF = "in";
    for (let j = 0; j < N; j++) {
      const id = `t${ti}s${j}`;
      const fN = `F_${id}`;
      const wi = `Wi_${id}`;
      const wo = `Wo_${id}`;
      nodes.push({
        id: fN,
        type: "internal",
        x: 50 + j * 10,
        y: 40 + ti * 30,
        pressure: P0,
        temperature: Tin,
        volume: flowArea * ls,
      });
      index.nFluid++;
      // The inlet branch of a tube imposes its flow.  The others are
      // viscosity-free resistances that fix the pressure level.
      branches.push({
        id: `b_${id}`,
        from: prevF,
        to: fN,
        component:
          j === 0
            ? { type: "flowSource", massFlow: mTube }
            : resistance(flowArea),
      });
      prevF = fN;
      const T0 = Tin - 20;
      solidNodes.push({
        id: wi,
        type: "solid",
        x: 0,
        y: 0,
        temperature: T0,
        mass: 1,
        cp: 900,
      });
      solidNodes.push({
        id: wo,
        type: "solid",
        x: 0,
        y: 0,
        temperature: T0,
        mass: 1,
        cp: 900,
        // Absorbed flux on the exposed tube crown (width OD).
        heatInput: qabs * g.OD * ls,
      });
      index.nSolid += 2;
      conductors.push({
        id: `cv_${id}`,
        from: fN,
        to: wi,
        type: {
          kind: "convection",
          area: Math.PI * g.ID * ls,
          correlation: {
            model: "custom",
            diameter: g.ID,
            flowArea,
            expression,
            params,
          },
        },
      });
      // Radial conduction through the tube wall (log-mean area).  With
      // wallConduction off the wall is made effectively isothermal.
      const aLm = (2 * Math.PI * ls * (ro - ri)) / Math.log(ro / ri);
      conductors.push({
        id: `cw_${id}`,
        from: wi,
        to: wo,
        type: {
          kind: "conduction",
          k: o.wallConduction ? kAl : 1e6,
          area: aLm,
          length: ro - ri,
        },
      });
      conductors.push({
        id: `rc_${id}`,
        from: wo,
        to: "sink",
        type: {
          kind: "radiation",
          emissivity: o.emissivity,
          area: g.OD * ls * sides,
          viewFactor: 1,
        },
      });
      if (j > 0 && o.wallConduction) {
        conductors.push({
          id: `ca_${id}`,
          from: `Wo_t${ti}s${j - 1}`,
          to: wo,
          type: { kind: "conduction", k: kAl, area: wallArea, length: ls },
        });
      }
      // Fin strip (both fins of the tube lumped: conduction and radiation x 2).
      for (let m = 0; m < NF; m++) {
        const fid = `Fn_${id}_${m}`;
        solidNodes.push({
          id: fid,
          type: "solid",
          x: 0,
          y: 0,
          temperature: T0,
          mass: 1,
          cp: 900,
          heatInput: qabs * 2 * dFin * ls,
        });
        index.nSolid++;
        const prevN = m === 0 ? wo : `Fn_${id}_${m - 1}`;
        const lenC = m === 0 ? dFin / 2 : dFin;
        conductors.push({
          id: `fc_${id}_${m}`,
          from: prevN,
          to: fid,
          type: {
            kind: "conduction",
            k: kAl,
            area: 2 * g.sheet * ls,
            length: lenC,
          },
        });
        conductors.push({
          id: `fr_${id}_${m}`,
          from: fid,
          to: "sink",
          type: {
            kind: "radiation",
            emissivity: o.emissivity,
            area: 2 * dFin * ls * sides,
            viewFactor: 1,
          },
        });
        if (j > 0) {
          conductors.push({
            id: `fa_${id}_${m}`,
            from: `Fn_t${ti}s${j - 1}_${m}`,
            to: fid,
            type: {
              kind: "conduction",
              k: kAl,
              area: 2 * g.sheet * dFin,
              length: ls,
            },
          });
        }
      }
    }
    branches.push({
      id: `bm_t${ti}`,
      from: prevF,
      to: "mix",
      component: resistance(flowArea),
    });
  });
  nodes.push({
    id: "out",
    type: "boundary",
    x: 2000,
    y: 0,
    pressure: P0,
    temperature: Tin,
  });
  branches.push({
    id: "b_out",
    from: "mix",
    to: "out",
    component: resistance(tubes.length * flowArea),
  });

  const config: NetworkConfig = {
    meta: {
      name: `MRS panel ${spec.panel} N=${N} nf=${NF}`,
      version: 2,
    },
    settings: {
      mode: "steady",
      tolerance: o.tolerance,
      maxIterations: o.maxIterations,
      relaxation: 0.9,
    },
    fluid: {
      model: "realFluid",
      params: { fluidName: "R21", transport: "external" },
    },
    nodes,
    solidNodes,
    conductors,
    branches,
  };
  return { config, index };
}

/* ------------------------------------------------------------------ */
/* Series chaining and energy / mass closure                           */
/* ------------------------------------------------------------------ */

export interface MrsPanelRun {
  panel: number;
  tinF: number;
  toutF: number;
  converged: boolean;
  wallSeconds: number;
  /** Heat to the sink minus absorbed flux, from the conductor heat rates [W]. */
  qRejected: number;
  /** Fluid enthalpy drop mdot (h_in - h_out) [W]. */
  qFluid: number;
  /** Relative closure |qRejected - qFluid| / |qFluid|. */
  energyClosure: number;
  /** Relative mass imbalance between the leg flow and the flow into the outlet. */
  massClosure: number;
  /** Largest deviation of any fluid node pressure from the loop pressure [Pa]. */
  maxPressureOffset: number;
  /** Solver tolerance of the accepted solve. */
  tolerance: number;
  nSolid: number;
  nFluid: number;
}

/** Solve one panel (requires `await initRealFluids()` first). */
export function solveMrsPanel(
  spec: MrsPanelSpec,
  partial: Partial<MrsOptions> = {},
): MrsPanelRun {
  const tol0 = partial.tolerance ?? MRS_DEFAULTS.tolerance;
  let best: MrsPanelRun | undefined;
  for (const tolerance of [tol0, 3 * tol0, 10 * tol0]) {
    const run = solveMrsPanelOnce(spec, { ...partial, tolerance });
    if (
      best === undefined ||
      (run.converged && !best.converged) ||
      (run.converged === best.converged &&
        run.energyClosure < best.energyClosure)
    ) {
      best = run;
    }
    if (run.converged && run.energyClosure < MRS_CLOSURE_LIMIT) return run;
  }
  return best as MrsPanelRun;
}

function solveMrsPanelOnce(
  spec: MrsPanelSpec,
  partial: Partial<MrsOptions>,
): MrsPanelRun {
  const { config, index } = buildMrsPanelNetwork(spec, partial);
  const errors = validateNetwork(config);
  if (errors.length > 0) {
    throw new Error(`MRS network is invalid: ${errors.join("; ")}`);
  }
  const t0 = performance.now();
  const res = solveSteady(config);
  const wallSeconds = (performance.now() - t0) / 1000;
  const mix = res.nodes[index.mix];
  const fluid = new RealFluid("R21");
  const hIn = fluid.enthalpyPT(res.nodes["in"].pressure, f2k(spec.tinF));
  let hOut = NaN;
  try {
    hOut = fluid.enthalpyPT(mix.pressure, mix.temperature);
  } catch {
    // An unconverged state can sit inside the dome: leave the closure infinite.
  }
  const qFluid = spec.mdot * (hIn - hOut);
  let qRad = 0;
  for (const c of config.conductors ?? []) {
    if (c.type.kind === "radiation")
      qRad += res.conductors?.[c.id]?.heatRate ?? 0;
  }
  let qAbs = 0;
  for (const s of config.solidNodes ?? []) qAbs += s.heatInput ?? 0;
  const qRejected = qRad - qAbs;
  const mOut = res.branches["b_out"]?.mdot ?? NaN;
  const maxPressureOffset = Math.max(
    ...Object.values(res.nodes).map((n) => Math.abs(n.pressure - MRS_PRESSURE)),
  );
  return {
    panel: spec.panel,
    tinF: spec.tinF,
    toutF: k2f(mix.temperature),
    converged: res.converged,
    wallSeconds,
    qRejected,
    qFluid,
    energyClosure: Number.isFinite(qFluid)
      ? Math.abs(qRejected - qFluid) / Math.abs(qFluid)
      : Infinity,
    massClosure: Math.abs(mOut - spec.mdot) / spec.mdot,
    maxPressureOffset,
    tolerance: partial.tolerance ?? MRS_DEFAULTS.tolerance,
    nSolid: index.nSolid,
    nFluid: index.nFluid,
  };
}

/**
 * Solve a leg panel by panel.  The flow is imposed and nothing flows
 * upstream, so the mixed outlet state of a panel is exactly the inlet state of
 * the next one.  One network per panel keeps the dense solid solve at about
 * 600 unknowns instead of several thousand, and anchors the pressure of every
 * panel at its own outlet.
 */
export function solveMrsLegChained(
  leg: MrsLegSpec,
  partial: Partial<MrsOptions> = {},
): MrsPanelRun[] {
  const out: MrsPanelRun[] = [];
  let tin = leg.tinF;
  for (const panel of leg.panels) {
    const run = solveMrsPanel(
      {
        panel,
        mdot: leg.mdot,
        tinF: tin,
        flux: leg.flux[panel],
        sides: leg.sides,
        tubes: leg.tubes,
      },
      partial,
    );
    out.push(run);
    tin = run.toutF;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Variants (protocol sensitivities)                                   */
/* ------------------------------------------------------------------ */

export interface MrsVariant {
  options: Partial<MrsOptions>;
  /** Override of the number of radiating sides for named test points. */
  sidesOverride?: Record<string, 1 | 2>;
  description: string;
}

/** The baseline and the sensitivities listed in docs/validation/mrs-protocol.md. */
export const MRS_VARIANTS: Record<string, MrsVariant> = {
  base: { options: {}, description: "baseline, 8 segments, 5 fin nodes" },
  seg4: { options: { segments: 4 }, description: "4 segments per tube" },
  seg16: { options: { segments: 16 }, description: "16 segments per tube" },
  fin3: { options: { finNodes: 3 }, description: "3 fin nodes" },
  fin8: { options: { finNodes: 8 }, description: "8 fin nodes" },
  muPlus: { options: { muScale: 1.25 }, description: "viscosity +25 %" },
  muMinus: { options: { muScale: 0.75 }, description: "viscosity -25 %" },
  kPlus: { options: { kScale: 1.15 }, description: "fluid conductivity +15 %" },
  kMinus: {
    options: { kScale: 0.85 },
    description: "fluid conductivity -15 %",
  },
  fluxPlus: { options: { fluxScale: 1.05 }, description: "absorbed flux +5 %" },
  fluxMinus: {
    options: { fluxScale: 0.95 },
    description: "absorbed flux -5 %",
  },
  epsPlus: { options: { emissivity: 0.92 }, description: "emissivity 0.92" },
  epsMinus: { options: { emissivity: 0.88 }, description: "emissivity 0.88" },
  kFinPlus: {
    options: { kAl: MRS_CHOICES.kAl * 1.15 },
    description: "fin conductivity +15 %",
  },
  kFinMinus: {
    options: { kAl: MRS_CHOICES.kAl * 0.85 },
    description: "fin conductivity -15 %",
  },
  splitLength: {
    options: { splitExponent: 1 },
    description: "tube flow proportional to tube length",
  },
  nuLam436: {
    options: { nuLaminar: 4.36 },
    description: "laminar Nusselt number 4.36",
  },
  two15: {
    options: { twoSidedExtra: 0.5 },
    description: "two-sided area factor 1.5",
  },
  two18: {
    options: { twoSidedExtra: 0.8 },
    description: "two-sided area factor 1.8",
  },
  tp51OneSide: {
    options: {},
    sidesOverride: { "51": 1 },
    description: "TP51 as printed (one side)",
  },
  wallIso: {
    options: { wallConduction: false },
    description: "isothermal tube wall, no axial wall conduction",
  },
};
