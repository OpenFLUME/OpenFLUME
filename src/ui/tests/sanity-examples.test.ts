import { describe, it, expect } from "vitest";
import {
  sanityHydrostaticColumn,
  sanityFlowSplit,
  sanityOrificeHandCalc,
  sanityEqualTMixing,
  sanityTankEqualization,
  sanityConductionLadderCooldown,
} from "../examples";
import {
  validateNetwork,
  solveSteady,
  solveTransient,
  createFluidModel,
} from "../../core";

const g = 9.80665;

function getFluidParams(config: typeof sanityHydrostaticColumn) {
  const fm = createFluidModel(
    config.fluid.model,
    config.fluid.preset,
    config.fluid.params,
  );
  return {
    rho: fm.density(101325, 300),
    cp: fm.cp(101325, 300),
    R: (fm as any).R,
  };
}

describe("Sanity: hydrostatic column", () => {
  it("node pressures follow 100 kPa + ρg·depth within ±10 Pa and all flows are zero", () => {
    const errs = validateNetwork(sanityHydrostaticColumn);
    expect(errs).toEqual([]);

    const res = solveSteady(sanityHydrostaticColumn);
    expect(res.converged).toBe(true);

    const { rho } = getFluidParams(sanityHydrostaticColumn);
    const dz = 2.5;
    const dP = rho * g * dz;

    const nodes = sanityHydrostaticColumn.nodes;
    const P_top = nodes.find((n) => n.id === "top")!.pressure!;

    const expected: Record<string, number> = {
      top: P_top,
      n1: P_top + dP * 1,
      n2: P_top + dP * 2,
      n3: P_top + dP * 3,
      bot: P_top + dP * 4,
    };

    for (const [id, Pexp] of Object.entries(expected)) {
      const Pact = res.nodes[id].pressure;
      expect(Math.abs(Pact - Pexp)).toBeLessThan(10);
    }

    for (const b of sanityHydrostaticColumn.branches) {
      expect(Math.abs(res.branches[b.id].mdot)).toBeLessThan(1e-9);
    }
  });
});

describe("Sanity: 50/50 flow split", () => {
  it("each identical parallel pipe carries exactly half the flow-source rate", () => {
    const errs = validateNetwork(sanityFlowSplit);
    expect(errs).toEqual([]);

    const res = solveSteady(sanityFlowSplit);
    expect(res.converged).toBe(true);

    const fsBranch = sanityFlowSplit.branches.find(
      (b) => b.component.type === "flowSource",
    )!;
    const totalFlow = (fsBranch.component as any).massFlow as number;
    const half = totalFlow / 2;

    for (const b of sanityFlowSplit.branches) {
      if (b.component.type === "pipe") {
        expect(Math.abs(res.branches[b.id].mdot - half)).toBeLessThan(0.001);
      }
    }
  });
});

describe("Sanity: orifice hand-calc", () => {
  it("mdot matches Cd·A·√(2ρΔP) within 0.5%", () => {
    const errs = validateNetwork(sanityOrificeHandCalc);
    expect(errs).toEqual([]);

    const res = solveSteady(sanityOrificeHandCalc);
    expect(res.converged).toBe(true);

    const { rho } = getFluidParams(sanityOrificeHandCalc);
    const orificeBranch = sanityOrificeHandCalc.branches.find(
      (b) => b.component.type === "orifice",
    )!;
    const cd = (orificeBranch.component as any).cd as number;
    const area = (orificeBranch.component as any).area as number;

    const P_in = sanityOrificeHandCalc.nodes.find(
      (n) => n.id === "in",
    )!.pressure!;
    const P_out = sanityOrificeHandCalc.nodes.find(
      (n) => n.id === "out",
    )!.pressure!;
    const dP = P_in - P_out;

    const expected = cd * area * Math.sqrt(2 * rho * dP);
    const actual = res.branches[orificeBranch.id].mdot;

    expect(Math.abs(actual - expected) / expected).toBeLessThan(0.005);
  });
});

describe("Sanity: equal-T mixing", () => {
  it("outlet temperature equals flow-weighted mean of inlet temperatures", () => {
    const errs = validateNetwork(sanityEqualTMixing);
    expect(errs).toEqual([]);

    const res = solveSteady(sanityEqualTMixing);
    expect(res.converged).toBe(true);

    const hotBranch = sanityEqualTMixing.branches.find(
      (b) => b.id === "hot_fs",
    )!;
    const coldBranch = sanityEqualTMixing.branches.find(
      (b) => b.id === "cold_fs",
    )!;
    const m_hot = (hotBranch.component as any).massFlow as number;
    const m_cold = (coldBranch.component as any).massFlow as number;
    const T_hot = sanityEqualTMixing.nodes.find(
      (n) => n.id === "hot_in",
    )!.temperature!;
    const T_cold = sanityEqualTMixing.nodes.find(
      (n) => n.id === "cold_in",
    )!.temperature!;

    const { cp } = getFluidParams(sanityEqualTMixing);
    const expected =
      (m_hot * cp * T_hot + m_cold * cp * T_cold) / ((m_hot + m_cold) * cp);
    const actual = res.nodes["mix"].temperature;

    expect(Math.abs(actual - expected)).toBeLessThan(0.05);
  });
});

describe("Sanity: tank equalization", () => {
  it("both tanks converge to volume-weighted mean pressure and total mass is conserved", () => {
    const errs = validateNetwork(sanityTankEqualization);
    expect(errs).toEqual([]);

    const res = solveTransient(sanityTankEqualization);
    expect(res.converged).toBe(true);

    const tank1 = sanityTankEqualization.nodes.find((n) => n.id === "tank1")!;
    const tank2 = sanityTankEqualization.nodes.find((n) => n.id === "tank2")!;
    const V1 = tank1.volume! as number; // literal config: no formula bindings
    const V2 = tank2.volume! as number; // literal config: no formula bindings
    const P1_0 = tank1.pressure!;
    const P2_0 = tank2.pressure!;

    const P_eq = (P1_0 * V1 + P2_0 * V2) / (V1 + V2);

    const finalP1 =
      res.nodes["tank1"].pressure[res.nodes["tank1"].pressure.length - 1];
    const finalP2 =
      res.nodes["tank2"].pressure[res.nodes["tank2"].pressure.length - 1];

    expect(Math.abs(finalP1 - P_eq)).toBeLessThan(300);
    expect(Math.abs(finalP2 - P_eq)).toBeLessThan(300);

    const { R } = getFluidParams(sanityTankEqualization);
    const T0 = tank1.temperature!;

    const m0 = (P1_0 * V1 + P2_0 * V2) / (R * T0);
    let maxMassErr = 0;
    for (let i = 0; i < res.times.length; i++) {
      const T1 = res.nodes["tank1"].temperature[i];
      const T2 = res.nodes["tank2"].temperature[i];
      const m =
        (res.nodes["tank1"].pressure[i] * V1) / (R * T1) +
        (res.nodes["tank2"].pressure[i] * V2) / (R * T2);
      maxMassErr = Math.max(maxMassErr, Math.abs(m - m0) / m0);
    }
    expect(maxMassErr).toBeLessThan(0.001);
  });
});

describe("Sanity: conduction ladder + lumped cooldown", () => {
  it("interior solids reach exact linear interpolants and lumped node follows τ within 1%", () => {
    const errs = validateNetwork(sanityConductionLadderCooldown);
    expect(errs).toEqual([]);

    const res = solveTransient(sanityConductionLadderCooldown);
    expect(res.converged).toBe(true);

    // --- Part (a): conduction ladder steady temperatures at end of run ---
    const ambCold = sanityConductionLadderCooldown.solidNodes!.find(
      (n) => n.id === "amb_cold",
    )!.temperature;
    const ambHot = sanityConductionLadderCooldown.solidNodes!.find(
      (n) => n.id === "amb_hot",
    )!.temperature;
    const ladderIds = ["s1", "s2", "s3"];
    const nSeg = ladderIds.length + 1; // 4 conductances in series between boundaries
    for (let i = 0; i < ladderIds.length; i++) {
      const frac = (i + 1) / nSeg;
      const expected = ambCold + frac * (ambHot - ambCold);
      const actual =
        res.solidNodes![ladderIds[i]].temperature[
          res.solidNodes![ladderIds[i]].temperature.length - 1
        ];
      expect(Math.abs(actual - expected)).toBeLessThan(0.01);
    }

    // --- Part (b): lumped capacitance cooldown ---
    const coolNode = sanityConductionLadderCooldown.solidNodes!.find(
      (n) => n.id === "solid_cool",
    )!;
    const m = coolNode.mass!;
    const cp = coolNode.cp! as number;
    const convCond = sanityConductionLadderCooldown.conductors!.find(
      (c) => c.id === "c_conv",
    )!;
    const h = (convCond.type as any).h as number;
    const area = (convCond.type as any).area as number;
    const hA = h * area;
    const tau = (m * cp) / hA;

    const T_f = sanityConductionLadderCooldown.nodes.find(
      (n) => n.id === "stream",
    )!.temperature!;
    const T_0 = coolNode.temperature;

    const checkTime = (t: number) => {
      const idx = res.times.indexOf(t);
      expect(idx).toBeGreaterThanOrEqual(0);
      const expected = T_f + (T_0 - T_f) * Math.exp(-t / tau);
      const actual = res.solidNodes!["solid_cool"].temperature[idx];
      expect(Math.abs(actual - expected) / expected).toBeLessThan(0.01);
    };

    checkTime(tau); // t = τ
    checkTime(3 * tau); // t = 3τ
  });
});
