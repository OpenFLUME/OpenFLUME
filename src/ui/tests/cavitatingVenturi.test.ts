import { describe, it, expect, beforeAll } from "vitest";
import { describeSlow } from "../../testUtils/slow";
import { NetworkConfig } from "../../core/schema";
import {
  solveTransient,
  solveSteady,
  initRealFluids,
  validateNetwork,
} from "../../core";
import { getCoolProp } from "../../core/fluids/coolprop";
import {
  nitrousOxideCavitatingVenturi,
  nitrousOxideCavitatingVenturiSteady,
} from "../examples";

beforeAll(async () => {
  await initRealFluids();
  refreshFluidProps();
}, 30000);

const D_LINE = 0.0127;
const D_THROAT = 0.0025;
const A_LINE = Math.PI * Math.pow(D_LINE / 2, 2);
const A_THROAT = Math.PI * Math.pow(D_THROAT / 2, 2);
const P_IN = 5.5158e6;
const P_OUT = 3.4474e6;

let P_V: number;
let RHO_F: number;

function refreshFluidProps() {
  const cp = getCoolProp();
  P_V = cp.PropsSI("P", "T", 244.26, "Q", 0, "NitrousOxide");
  RHO_F = cp.PropsSI("D", "P", P_IN, "T", 244.26, "NitrousOxide");
}

const N_CONTRACTION = 3;
const N_DIFFUSER = 6;
const R_C = Math.pow(A_LINE / A_THROAT, 1 / N_CONTRACTION);
const R_D = Math.pow(A_LINE / A_THROAT, 1 / N_DIFFUSER);

function buildVenturiConfig(
  outletMPa: number,
  seedDome: boolean,
): NetworkConfig {
  const nodes: NetworkConfig["nodes"] = [
    {
      id: "inlet",
      type: "boundary",
      x: 0,
      y: 0,
      pressure: P_IN,
      temperature: 244.26,
    },
  ];
  const branches: NetworkConfig["branches"] = [];
  let prevId = "inlet";
  let currentArea = A_LINE;

  for (let i = 1; i <= N_CONTRACTION; i++) {
    const nextArea = currentArea / R_C;
    nodes.push({
      id: `c${i}`,
      type: "internal",
      x: i * 100,
      y: 0,
      pressure: 4.0e6,
      temperature: 244.26,
      volume: 1e-6,
    });
    branches.push({
      id: `ac_c${i}`,
      from: prevId,
      to: `c${i}`,
      component: { type: "areaChange", areaIn: currentArea, areaOut: nextArea },
    });
    prevId = `c${i}`;
    currentArea = nextArea;
  }

  const throatNode: any = {
    id: "throat",
    type: "internal",
    x: (N_CONTRACTION + 1) * 100,
    y: 0,
    volume: 1e-5,
  };
  if (seedDome) {
    throatNode.pressure = P_V;
    throatNode.quality = 0.001;
  } else {
    throatNode.pressure = 4.0e6;
    throatNode.temperature = 244.26;
  }
  nodes.push(throatNode);
  branches.push({
    id: `ac_c${N_CONTRACTION + 1}`,
    from: prevId,
    to: "throat",
    component: { type: "areaChange", areaIn: currentArea, areaOut: A_THROAT },
  });
  prevId = "throat";
  currentArea = A_THROAT;

  for (let i = 1; i <= N_DIFFUSER; i++) {
    const nextArea = currentArea * R_D;
    nodes.push({
      id: `d${i}`,
      type: "internal",
      x: (N_CONTRACTION + 1 + i) * 100,
      y: 0,
      pressure: seedDome ? 2.5e6 : 4.0e6,
      temperature: 244.26,
      volume: 1e-6,
    });
    branches.push({
      id: `ac_d${i}`,
      from: prevId,
      to: `d${i}`,
      component: { type: "areaChange", areaIn: currentArea, areaOut: nextArea },
    });
    prevId = `d${i}`;
    currentArea = nextArea;
  }

  nodes.push({
    id: "outlet",
    type: "boundary",
    x: (N_CONTRACTION + N_DIFFUSER + 2) * 100,
    y: 0,
    pressure: outletMPa * 1e6,
    temperature: 244.26,
  });
  branches.push({
    id: `ac_d${N_DIFFUSER + 1}`,
    from: prevId,
    to: "outlet",
    component: { type: "areaChange", areaIn: currentArea, areaOut: A_LINE },
  });

  return {
    meta: { name: "N2O-venturi-test", version: 2 },
    settings: {
      mode: "transient",
      dt: 0.01,
      endTime: 0.01,
      tolerance: 1e-6,
      maxIterations: 200,
      relaxation: 0.5,
    },
    fluid: { model: "realFluid", params: { fluidName: "NitrousOxide" } },
    nodes,
    branches,
  };
}

function computeLossBudget() {
  // Contraction K (referred to throat head)
  let Kc = 0;
  let area = A_LINE;
  for (let i = 1; i <= N_CONTRACTION; i++) {
    const nextArea = area / R_C;
    const Klocal = 0.5 * Math.pow(1 - nextArea / area, 0.75);
    Kc += Klocal * Math.pow(A_THROAT / nextArea, 2);
    area = nextArea;
  }

  // Diffuser K (referred to throat head)
  let Kd = 0;
  area = A_THROAT;
  for (let i = 1; i <= N_DIFFUSER; i++) {
    const nextArea = area * R_D;
    const Klocal = Math.pow(1 - area / nextArea, 2);
    Kd += Klocal * Math.pow(A_THROAT / area, 2);
    area = nextArea;
  }

  const Ktotal = Kc + Kd;
  const q = (P_IN - P_OUT) / Ktotal;
  const PthroatLiquid = P_IN - (1 + Kc) * q;
  return { Kc, Kd, Ktotal, q, PthroatLiquid };
}

describe("N₂O cavitating venturi", () => {
  it("validates with zero errors", () => {
    const errs = validateNetwork(nitrousOxideCavitatingVenturi);
    expect(errs).toEqual([]);
  });

  it("liquid-only design check: hand-computed throat P < Pv", () => {
    const { Kc, Kd, Ktotal, PthroatLiquid } = computeLossBudget();
    console.log(
      `Loss budget  Kc=${Kc.toFixed(4)}  Kd=${Kd.toFixed(4)}  Ktotal=${Ktotal.toFixed(4)}`,
    );
    console.log(
      `Predicted all-liquid throat P = ${(PthroatLiquid / 1e6).toFixed(3)} MPa  (Pv = ${(P_V / 1e6).toFixed(3)} MPa)`,
    );
    expect(PthroatLiquid).toBeLessThan(P_V);
    // Hand-predicted P is ~1.20 MPa (margin below Pv = 1.365 MPa)
    expect(PthroatLiquid).toBeLessThan(1.3e6);
  });

  it(
    "transient march (dome-seeded shipped example) converges with throat P within 5 % of Pv",
    { timeout: 120000 },
    () => {
      const config = JSON.parse(JSON.stringify(nitrousOxideCavitatingVenturi));
      const res = solveTransient(config);
      // The shipped example seeds the throat at the vapor dome (the
      // cavitating state is thermodynamically required by the loss budget),
      // so the single shipped step HAS an exact discrete root and the
      // solver meets residual tolerance (scaled residual ~6e-11).  The previous
      // all-liquid-init version of this example reported
      // converged = false (no-root single giant step — exercised and
      // documented in the next test); the physics here is unchanged vs
      // that compromise state (throat within ~0.2 % of Pv, same choked
      // mdot, same effective Cd), so seeding changed bookkeeping, not
      // physics.  The UI no longer shows a "Not converged" badge for the
      // shipped example (e2e #25 asserts the Converged status).
      expect(res.converged).toBe(true);
      expect(res.stepResidualsScaled!.length).toBe(1);

      const finalIdx = res.times.length - 1;
      const throatP = res.nodes.throat.pressure[finalIdx];
      expect(Math.abs(throatP - P_V) / P_V).toBeLessThan(0.05);

      // Mass-conservation check: contraction and diffuser mdots agree
      // within ~4 % on this short transient (would tighten with longer march)
      const mdots = config.branches.map(
        (b: any) => res.branches[b.id].mdot[finalIdx],
      );
      const maxM = Math.max(...mdots);
      const minM = Math.min(...mdots);
      expect(Math.abs(maxM - minM) / Math.abs(maxM)).toBeLessThan(0.04);

      // Effective Cd
      const cd = maxM / (A_THROAT * Math.sqrt(2 * RHO_F * (P_IN - P_V)));
      console.log(`Cd = ${cd.toFixed(3)}`);
      expect(cd).toBeGreaterThanOrEqual(0.7);
      expect(cd).toBeLessThanOrEqual(1.05);

      // Recovery: downstream single-phase, T rise within [0,5] K
      for (const n of config.nodes) {
        if (n.id.startsWith("d")) {
          const nodeData = res.nodes[n.id];
          expect(nodeData).toBeDefined();
          const q = nodeData!.quality?.[finalIdx];
          expect(q === undefined || q <= 0 || q >= 1).toBe(true);
          const T = nodeData!.temperature[finalIdx];
          expect(Math.abs(T - 244.26)).toBeLessThan(5);
        }
      }
    },
  );

  describeSlow(
    "solver finding (regression): all-liquid-init single giant step has no exact discrete root",
    () => {
      it(
        "reports converged=false with a physically-excellent compromise state",
        { timeout: 120000 },
        () => {
          // Same operating point as the shipped example but with an ALL-LIQUID
          // start (seedDome=false): the single giant step then has no exact
          // discrete root — the c3 node's energy residual has a floor of
          // ~1.6 kW (≈4 % of its 41 kW advective flux) because the storage
          // capacity of the tiny node volume cannot balance the advective
          // enthalpy excess of a full 4.0→1.37 MPa depressurisation in one
          // step, and the choked throat cannot accept the displaced flow
          // (scalar scan along the energy axis confirms the floor).  Refining
          // dt (0.001 / 0.0005 s) does NOT produce a root — the floor is
          // structural (flashing + choking), not a step-size artifact
          // (verified: worstScaled 0.75 / 1.60, physics unchanged).  The
          // solver therefore reports converged = false and returns its
          // least-residual compromise state, which is physically excellent
          // (throat pinned within ~1 % of Pv, same choked mdot as the
          // meets residual tolerance within 0.3 %).  This pins
          // no-root reporting on a proven-no-root step; a future
          // discretisation/solver improvement that converges the step should
          // flip the flag and update this comment.
          const config = buildVenturiConfig(P_OUT / 1e6, false);
          const res = solveTransient(config);
          expect(res.converged).toBe(false);
          expect(res.stepResidualsScaled!.length).toBe(1);
          const finalIdx = res.times.length - 1;
          expect(
            Math.abs(res.nodes.throat.pressure[finalIdx] - P_V) / P_V,
          ).toBeLessThan(0.05);
          expect(res.branches["ac_c1"].mdot[finalIdx]).toBeGreaterThan(0.3);
        },
      );
    },
  );

  it(
    "dome-seeded variant: throat quality ∈ (0,1) and P within 5 % of Pv",
    { timeout: 60000 },
    () => {
      const config = buildVenturiConfig(P_OUT / 1e6, true);
      const res = solveTransient(config);
      expect(res.converged).toBe(true);

      const finalIdx = res.times.length - 1;
      const throatP = res.nodes.throat.pressure[finalIdx];
      const throatNode = res.nodes.throat;
      expect(throatNode.quality).toBeDefined();
      const throatQ = throatNode.quality![finalIdx];
      expect(throatQ).toBeGreaterThan(0);
      expect(throatQ).toBeLessThan(1);
      expect(Math.abs(throatP - P_V) / P_V).toBeLessThan(0.05);
    },
  );

  describeSlow(
    "choking: outlet 500/400/300 psia (3 solves incl. 2 no-root retry cases)",
    () => {
      it("choked mdot varies < 3 % across outlets", { timeout: 180000 }, () => {
        const outlets = [
          { psia: 500, mpa: 3.4474 },
          { psia: 400, mpa: 2.758 },
          { psia: 300, mpa: 2.068 },
        ];
        const mdots: number[] = [];
        for (const o of outlets) {
          const config = buildVenturiConfig(o.mpa, true);
          const res = solveTransient(config);
          // Residual accounting: the 500 psia step meets residual tolerance
          // (scaled residual ~6e-11).  The 400/300 psia steps are
          // the same proven-no-root single-giant-step discretisation as the
          // all-liquid-init solver-finding test above (stronger choking →
          // larger flashing imbalance: best-outer scaled residuals ≈ 0.8 /
          // 6.3, i.e. the worst tiny-volume node's energy row is off by ≈ 8 /
          // 62 kW while mass, momentum and throat pinning stay physical;
          // verified unchanged with dome seeding AND with dt refinement —
          // the floor is structural).  The solver reports converged = false
          // and returns the compromise state.  The choked mdot — the
          // quantity this test actually measures — is robust regardless
          // (see the < 3 % variation assertion below).
          if (o.psia === 500) {
            expect(res.converged).toBe(true);
          } else {
            expect(res.converged).toBe(false);
          }
          const finalIdx = res.times.length - 1;
          const mdot = res.branches["ac_c1"].mdot[finalIdx];
          mdots.push(mdot);
          console.log(`  ${o.psia} psia → mdot = ${mdot.toFixed(4)} kg/s`);
        }
        const maxM = Math.max(...mdots);
        const minM = Math.min(...mdots);
        expect(Math.abs(maxM - minM) / Math.abs(maxM)).toBeLessThan(0.03);
      });
    },
  );

  it(
    "un-choke at 750 psia: mdot drops and throat P >> Pv",
    { timeout: 30000 },
    () => {
      const config = buildVenturiConfig(5.171, false);
      const res = solveTransient(config);
      expect(res.converged).toBe(true);
      const finalIdx = res.times.length - 1;
      const mdot = res.branches["ac_c1"].mdot[finalIdx];
      const throatP = res.nodes.throat.pressure[finalIdx];
      console.log(
        `  750 psia → mdot = ${mdot.toFixed(4)} kg/s  throat P = ${(throatP / 1e6).toFixed(3)} MPa`,
      );
      expect(mdot).toBeLessThan(0.3); // clearly lower than choked ~0.385
      expect(throatP).toBeGreaterThan(3e6); // well above Pv
    },
  );
});

describe("N₂O cavitating venturi (choked-flow closure, steady)", () => {
  function expectedMdotChoked() {
    return 0.84 * A_THROAT * Math.sqrt(2 * RHO_F * (P_IN - P_V));
  }

  it("validates with zero errors", () => {
    const errs = validateNetwork(nitrousOxideCavitatingVenturiSteady);
    expect(errs).toEqual([]);
  });

  it(
    "converges from cold guess and mdot matches analytical choked formula within 1%",
    { timeout: 30000 },
    () => {
      const config = JSON.parse(
        JSON.stringify(nitrousOxideCavitatingVenturiSteady),
      );
      const res = solveSteady(config);
      expect(res.converged).toBe(true);
      const expected = expectedMdotChoked();
      console.log(
        `  Steady closure: mdot = ${res.branches.cv.mdot.toFixed(4)} kg/s  iterations = ${res.iterations}`,
      );
      expect(Math.abs(res.branches.cv.mdot - expected) / expected).toBeLessThan(
        0.01,
      );
    },
  );

  it(
    "downstream independence: outlet 500/400/300 psia → mdot variation < 0.5%",
    { timeout: 30000 },
    () => {
      const outlets = [
        { psia: 500, pa: 3.4474e6 },
        { psia: 400, pa: 2.758e6 },
        { psia: 300, pa: 2.068e6 },
      ];
      const mdots: number[] = [];
      for (const o of outlets) {
        const config = JSON.parse(
          JSON.stringify(nitrousOxideCavitatingVenturiSteady),
        );
        config.nodes[1].pressure = o.pa;
        const res = solveSteady(config);
        expect(res.converged).toBe(true);
        mdots.push(res.branches.cv.mdot);
        console.log(
          `  ${o.psia} psia → mdot = ${res.branches.cv.mdot.toFixed(6)} kg/s`,
        );
      }
      const maxM = Math.max(...mdots);
      const minM = Math.min(...mdots);
      const variation = Math.abs(maxM - minM) / Math.abs(maxM);
      console.log(`  Variation = ${(variation * 100).toFixed(4)} %`);
      expect(variation).toBeLessThan(0.005);
    },
  );

  it(
    "non-cavitating regime: high outlet pressure → mdot depends on P_out and matches orifice formula within 1%",
    { timeout: 30000 },
    () => {
      const pOut = 5.4e6;
      const config = JSON.parse(
        JSON.stringify(nitrousOxideCavitatingVenturiSteady),
      );
      config.nodes[1].pressure = pOut;
      const res = solveSteady(config);
      expect(res.converged).toBe(true);

      const expectedOrifice =
        0.84 * A_THROAT * Math.sqrt(2 * RHO_F * (P_IN - pOut));
      console.log(
        `  P_out = 5.4 MPa: mdot = ${res.branches.cv.mdot.toFixed(6)}  expected orifice = ${expectedOrifice.toFixed(6)}`,
      );
      expect(
        Math.abs(res.branches.cv.mdot - expectedOrifice) / expectedOrifice,
      ).toBeLessThan(0.01);

      // Higher outlet → lower mdot (depends on P_out)
      const config2 = JSON.parse(JSON.stringify(config));
      config2.nodes[1].pressure = 5.2e6;
      const res2 = solveSteady(config2);
      expect(res2.converged).toBe(true);
      expect(res2.branches.cv.mdot).toBeGreaterThan(res.branches.cv.mdot);
    },
  );

  it(
    "transition smoothness: sweep outlet pressure through cavitation onset → continuous and monotone",
    { timeout: 30000 },
    () => {
      const mdots: number[] = [];
      const n = 50;
      const pMin = 2.0e6;
      const pMax = 5.5e6;
      for (let i = 0; i <= n; i++) {
        const pOut = pMin + (pMax - pMin) * (i / n);
        const cfg = JSON.parse(
          JSON.stringify(nitrousOxideCavitatingVenturiSteady),
        );
        cfg.nodes[1].pressure = pOut;
        const res = solveSteady(cfg);
        expect(res.converged).toBe(true);
        mdots.push(res.branches.cv.mdot);
      }

      // No jump: maximum increase across the sweep must stay below 0.5% of mdot range
      const range = Math.max(...mdots) - Math.min(...mdots);
      let maxIncrease = 0;
      for (let i = 1; i < mdots.length; i++) {
        const increase = mdots[i] - mdots[i - 1];
        if (increase > maxIncrease) maxIncrease = increase;
      }
      expect(maxIncrease).toBeLessThan(0.005 * range + 1e-6);

      // Numerical derivative bound (central differences)
      const dp = (pMax - pMin) / n;
      let maxDeriv = 0;
      for (let i = 1; i < mdots.length - 1; i++) {
        const dm = mdots[i + 1] - mdots[i - 1];
        const deriv = Math.abs(dm / (2 * dp));
        if (deriv > maxDeriv) maxDeriv = deriv;
      }
      // Bound: 1e-6 kg/s per Pa = 1 kg/s per MPa
      expect(maxDeriv).toBeLessThan(1e-6);
    },
  );

  it(
    "emergent model vs analytical closure: same operating point, mdot agrees within 2%",
    { timeout: 180000 },
    () => {
      // Emergent transient model (shipped example: dome-seeded throat,
      // single 0.01 s step).  It now meets residual tolerance (scaled residual
      // ~6e-11); its mdot is the choked-flow quantity compared here.  (The
      // previous all-liquid-init version reported converged =
      // false — proven no-root — and used the compromise state; the choked
      // mdot was identical to within 0.3 %, see the solver-finding test
      // above.)
      const emergentConfig = JSON.parse(
        JSON.stringify(nitrousOxideCavitatingVenturi),
      );
      const emergentRes = solveTransient(emergentConfig);
      expect(emergentRes.converged).toBe(true);
      const finalIdx = emergentRes.times.length - 1;
      const emergentMdot = emergentRes.branches["ac_c1"].mdot[finalIdx];
      const emergentCd =
        emergentMdot / (A_THROAT * Math.sqrt(2 * RHO_F * (P_IN - P_V)));
      console.log(
        `  Emergent:  mdot = ${emergentMdot.toFixed(4)} kg/s  Cd_eff = ${emergentCd.toFixed(3)}`,
      );

      // Analytical closure (steady)
      const closureConfig = JSON.parse(
        JSON.stringify(nitrousOxideCavitatingVenturiSteady),
      );
      const closureRes = solveSteady(closureConfig);
      expect(closureRes.converged).toBe(true);
      const closureMdot = closureRes.branches.cv.mdot;
      const closureCd = 0.84; // fixed by component design
      console.log(
        `  Closure:   mdot = ${closureMdot.toFixed(4)} kg/s  Cd = ${closureCd.toFixed(3)}`,
      );

      // Difference should be small (< 2%) because the tuned recoveryFactor
      // reproduces the effective recovery of the 6-step diffuser.
      const relDiff = Math.abs(closureMdot - emergentMdot) / emergentMdot;
      console.log(`  Relative difference = ${(relDiff * 100).toFixed(2)} %`);
      expect(relDiff).toBeLessThan(0.02);

      // The closure mdot should match the hand-computed choked formula.
      const expected = expectedMdotChoked();
      expect(Math.abs(closureMdot - expected) / expected).toBeLessThan(0.01);
    },
  );
});
