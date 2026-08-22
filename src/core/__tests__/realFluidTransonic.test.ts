/**
 * Real-fluid transonic flow — CoolProp nitrogen through a choked
 * converging–diverging nozzle (steady coupled h-system, default
 * limited-upwind momentum faces).
 *
 * The steady kineticEnergy formulation carries the full Mach coupling for
 * EVERY EOS (static h is a Newton unknown, energy rows flux h + v²/2, and
 * momentum density is ρ(P, h) from statePH), so a real fluid chokes
 * emergently exactly like an ideal gas — and shares the ideal gas's
 * expansion-shock twin-root hazard, which is why upwindEligible
 * (core/solver/kernel.ts) includes real-fluid branches whenever
 * kineticEnergy is on.  This suite pins that support with three checks:
 *
 *  1. TWIN CROSS-CHECK — the same network solved with CoolProp N₂ and with
 *     an analytic ideal gas carrying N₂'s (R, γ).  At 5 bar / 300 K
 *     nitrogen is near-ideal (Z ≈ 0.998) and the imposed friction factor
 *     removes viscosity sensitivity, so the two solves share scheme,
 *     grid, and physics; measured mass-flow agreement is 0.17 %.  This
 *     isolates "the upwind faces work through a real EOS" from any
 *     question about the scheme's own accuracy.
 *
 *  2. CHOKING — mass flow lands the documented upwind-scheme margin above
 *     the analytic ideal choked value (first-order sonic-cell bias, grid-
 *     convergent: 11.9 % on a 5+6-station mesh, 7.2 % on this 8+10 mesh),
 *     with a monotone pressure profile and a supersonic exit.
 *
 *  3. SEED ROBUSTNESS — the property the upwind faces exist to provide:
 *     a flat adversarial warm start (all internal nodes at the chamber
 *     state, ṁ seeded at 0.1 kg/s) reaches the same choked root as the
 *     authored isentropic-ramp start.
 */
import { describe, it, expect, beforeAll } from "vitest";
import type { NetworkConfig } from "../schema";
import { initRealFluids, realFluidsReady, RealFluid } from "../";
import { solveSteady } from "../solver";
import { validateNetwork } from "../validate";

beforeAll(async () => {
  await initRealFluids();
  expect(realFluidsReady()).toBe(true);
}, 30000);

/* ── Gas and operating point ─────────────────────────────────────────── */

const GAMMA = 1.4; // N2 at 300 K, ideal-gas twin
const R_GAS = 8.314462618 / 0.0280134; // 296.80 J/(kg·K)
const P0 = 5e5; // chamber stagnation pressure [Pa]
const T0 = 300; // chamber stagnation temperature [K]
const FRICTION_FACTOR = 0.01; // imposed Darcy f (removes μ sensitivity)

/* ── Contour: barrel, 30° convergent, 15° divergent, ε = 2.25 ────────── */

const D_CH = 0.08;
const D_TH = 0.04;
const D_EX = 0.06;
const L_BARREL = 0.05;
const CONV_ANG = (30 * Math.PI) / 180;
const DIV_ANG = (15 * Math.PI) / 180;
const Z_TH = L_BARREL + (D_CH - D_TH) / 2 / Math.tan(CONV_ANG);
const Z_END = Z_TH + (D_EX - D_TH) / 2 / Math.tan(DIV_ANG);

const areaOf = (d: number) => (Math.PI / 4) * d * d;
const A_STAR = areaOf(D_TH);

function contourD(z: number): number {
  if (z <= L_BARREL) return D_CH;
  if (z <= Z_TH) return D_CH - 2 * Math.tan(CONV_ANG) * (z - L_BARREL);
  return D_TH + 2 * Math.tan(DIV_ANG) * (z - Z_TH);
}

/* ── Isentropic references (γ = 1.4): boundaries and the choked ṁ ────── */

function areaRatioFromMach(M: number): number {
  const t = 1 + ((GAMMA - 1) / 2) * M * M;
  return (1 / M) * (t / ((GAMMA + 1) / 2)) ** ((GAMMA + 1) / (2 * (GAMMA - 1)));
}
function machFromAreaRatio(ar: number, supersonic: boolean): number {
  if (ar <= 1) return 1;
  let lo = supersonic ? 1 : 1e-6;
  let hi = supersonic ? 60 : 1;
  for (let k = 0; k < 200; k++) {
    const mid = 0.5 * (lo + hi);
    const wide = areaRatioFromMach(mid) > ar;
    if (supersonic === wide) hi = mid;
    else lo = mid;
  }
  return 0.5 * (lo + hi);
}

const MDOT_CHOKED =
  A_STAR *
  P0 *
  Math.sqrt(GAMMA / (R_GAS * T0)) *
  (2 / (GAMMA + 1)) ** ((GAMMA + 1) / (2 * (GAMMA - 1)));
const M_EXIT = machFromAreaRatio(areaOf(D_EX) / A_STAR, true);
const EXIT_STAG = 1 + ((GAMMA - 1) / 2) * M_EXIT * M_EXIT;
const P_EXIT = P0 * EXIT_STAG ** (-GAMMA / (GAMMA - 1));
const T_EXIT = T0 / EXIT_STAG;

/* ── Throat-clustered mesh (sonic crossing lives inside one cell) ────── */

const N_BARREL = 1;
const N_CONV = 8;
const N_DIV = 10;

function stationZ(): number[] {
  const xs: number[] = [];
  for (let i = 0; i <= N_BARREL; i++) xs.push((L_BARREL * i) / N_BARREL);
  for (let i = 1; i <= N_CONV; i++) {
    const s = i / N_CONV;
    xs.push(L_BARREL + (Z_TH - L_BARREL) * (1 - (1 - s) ** 2));
  }
  for (let i = 1; i <= N_DIV; i++) {
    const s = i / N_DIV;
    xs.push(Z_TH + (Z_END - Z_TH) * s ** 2);
  }
  return xs;
}
const ZS = stationZ();
const THROAT_INDEX = N_BARREL + N_CONV;
const stationId = (i: number) =>
  i === 0 ? "inlet" : i === ZS.length - 1 ? "exhaust" : `st${i}`;

function buildNozzle(
  fluid: NetworkConfig["fluid"],
  seed: "ramp" | "flat",
): NetworkConfig {
  const n = ZS.length;
  const nodes: NetworkConfig["nodes"] = ZS.map((z, i) => {
    const isIn = i === 0;
    const isOut = i === n - 1;
    const s = i / (n - 1);
    return {
      id: stationId(i),
      type: isIn || isOut ? ("boundary" as const) : ("internal" as const),
      x: i * 100,
      y: 0,
      pressure: isIn ? P0 : isOut ? P_EXIT : seed === "ramp" ? P0 + s * (P_EXIT - P0) : P0,
      temperature: isIn ? T0 : isOut ? T_EXIT : seed === "ramp" ? T0 + s * (T_EXIT - T0) : T0,
    };
  });
  const branches: NetworkConfig["branches"] = [];
  for (let i = 1; i < n; i++) {
    const dIn = contourD(ZS[i - 1]);
    const dOut = contourD(ZS[i]);
    branches.push({
      id: `seg${i}`,
      from: stationId(i - 1),
      to: stationId(i),
      initialMdot: seed === "ramp" ? MDOT_CHOKED : 0.1,
      component: {
        type: "pipe",
        length: Math.max(ZS[i] - ZS[i - 1], 1e-4),
        diameter: dIn,
        roughness: 1e-6,
        frictionFactor: FRICTION_FACTOR,
        ...(Math.abs(dOut - dIn) > 1e-12 ? { diameterOut: dOut } : {}),
      },
    });
  }
  return {
    meta: { name: "n2 transonic nozzle", version: 2 },
    settings: {
      mode: "steady",
      tolerance: 1e-6,
      maxIterations: 400,
      kineticEnergy: true,
      momentumFlux: true,
    },
    fluid,
    nodes,
    branches,
  };
}

const RF_SPEC: NetworkConfig["fluid"] = {
  model: "realFluid",
  params: { fluidName: "Nitrogen" },
};
const IG_SPEC: NetworkConfig["fluid"] = {
  model: "idealGas",
  params: {
    R: R_GAS,
    gamma: GAMMA,
    mu: 1.78e-5,
    cp: (GAMMA * R_GAS) / (GAMMA - 1),
  },
};

describe("real-fluid transonic — choked N2 CD nozzle (upwind faces)", () => {
  it("validates, converges, and matches the ideal-gas twin on mass flow", () => {
    const rfCfg = buildNozzle(RF_SPEC, "ramp");
    expect(validateNetwork(rfCfg)).toEqual([]);
    const rf = solveSteady(rfCfg);
    const ig = solveSteady(buildNozzle(IG_SPEC, "ramp"));
    expect(rf.converged).toBe(true);
    expect(ig.converged).toBe(true);

    // Same grid, same scheme, near-ideal regime, imposed friction factor:
    // the only difference is the EOS. Measured agreement 0.17 %.
    const mRf = rf.branches["seg1"].mdot;
    const mIg = ig.branches["seg1"].mdot;
    expect(Math.abs(mRf - mIg) / mIg).toBeLessThan(0.01);
  });

  it("chokes within the upwind scheme's documented margin, monotone to a supersonic exit", () => {
    const res = solveSteady(buildNozzle(RF_SPEC, "ramp"));
    expect(res.converged).toBe(true);

    // First-order sonic-cell bias runs the choked flow HIGH (measured
    // 1.072 on this mesh, 1.119 on a 5+6-station mesh — grid-convergent).
    const ratio = res.branches["seg1"].mdot / MDOT_CHOKED;
    expect(ratio).toBeGreaterThan(1.0);
    expect(ratio).toBeLessThan(1.1);

    // Static pressure falls monotonically chamber → exit (no expansion
    // shock parked anywhere).
    for (let i = 1; i < ZS.length; i++) {
      expect(res.nodes[stationId(i)].pressure).toBeLessThan(
        res.nodes[stationId(i - 1)].pressure,
      );
    }

    // Mach from the solved state (real speed of sound): subsonic upstream
    // of the throat's neighborhood, supersonic at the last interior
    // station (design M there ≈ 2.35).
    const n2 = new RealFluid("Nitrogen");
    const mdot = res.branches["seg1"].mdot;
    const machAt = (i: number): number => {
      const nd = res.nodes[stationId(i)];
      const v = mdot / (nd.density * areaOf(contourD(ZS[i])));
      return v / n2.speedOfSound!(nd.pressure, nd.temperature);
    };
    expect(machAt(1)).toBeLessThan(0.3); // barrel
    expect(machAt(THROAT_INDEX - 2)).toBeLessThan(1.0); // convergent
    expect(machAt(THROAT_INDEX + 2)).toBeGreaterThan(1.0); // divergent
    const mLast = machAt(ZS.length - 2);
    expect(mLast).toBeGreaterThan(2.0);
    expect(mLast).toBeLessThan(2.6);
  });

  it("reaches the same choked root from a flat adversarial seed", () => {
    const ramp = solveSteady(buildNozzle(RF_SPEC, "ramp"));
    const flat = solveSteady(buildNozzle(RF_SPEC, "flat"));
    expect(flat.converged).toBe(true);
    // Same root, not merely "converged": measured bit-close mass flows.
    expect(
      Math.abs(flat.branches["seg1"].mdot - ramp.branches["seg1"].mdot) /
        ramp.branches["seg1"].mdot,
    ).toBeLessThan(1e-3);
    // And the same monotone profile.
    for (let i = 1; i < ZS.length; i++) {
      expect(flat.nodes[stationId(i)].pressure).toBeLessThan(
        flat.nodes[stationId(i - 1)].pressure,
      );
    }
  });

  it("transports stagnation enthalpy through the transonic crossing", () => {
    // Adiabatic duct: h₀ = h + v²/2 must telescope station to station,
    // including across the sonic cell (energy rows are exact fluxes; the
    // upwind faces only touch the momentum term). KE at the last interior
    // station is ~160 kJ/kg, so 2 kJ/kg of drift is a strict bar.
    const res = solveSteady(buildNozzle(RF_SPEC, "ramp"));
    expect(res.converged).toBe(true);
    const n2 = new RealFluid("Nitrogen");
    const mdot = res.branches["seg1"].mdot;
    // Downstream branch's area carries the outflow flux at each node (the
    // energy rows' convention) — interior stations only.
    const h0 = (i: number): number => {
      const nd = res.nodes[stationId(i)];
      const A = areaOf(contourD(ZS[i]));
      const v = mdot / (nd.density * A);
      return n2.enthalpyPT(nd.pressure, nd.temperature) + 0.5 * v * v;
    };
    const keScale = h0(ZS.length - 2) - // stagnation minus static at the
      n2.enthalpyPT( // last interior station
        res.nodes[stationId(ZS.length - 2)].pressure,
        res.nodes[stationId(ZS.length - 2)].temperature,
      );
    expect(keScale).toBeGreaterThan(1e5); // strongly compressible case
    for (let i = 2; i < ZS.length - 1; i++) {
      expect(Math.abs(h0(i) - h0(i - 1))).toBeLessThan(2e3);
    }
  });
});
