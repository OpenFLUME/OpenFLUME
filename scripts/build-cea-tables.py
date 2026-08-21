#!/usr/bin/env python3
"""
Generator for src/core/combustion/generated/ceaTables.ts — equilibrium
combustion-gas property tables (chamber state) for the built-in propellant
pairs, computed with NASA's open-source CEA (Chemical Equilibrium with
Applications, https://github.com/nasa/cea, Apache-2.0).

This is an OFFLINE generator only.  CEA is native Fortran with a Python
binding; it is not a JavaScript dependency and is never imported at runtime.
The committed output (ceaTables.ts) is a static, plain-data lookup table —
the browser app only interpolates it (src/core/combustion/combustionGas.ts).

Usage (one-time environment setup, then regenerate/check as needed):

    python3 -m venv .venv-cea
    source .venv-cea/bin/activate      # .venv-cea\\Scripts\\activate on Windows
    pip install cea numpy

    python3 scripts/build-cea-tables.py            # regenerate ceaTables.ts
    python3 scripts/build-cea-tables.py --check     # diff-only, exit 1 on drift

Physics (see docs/combustion.md for the full derivation):

  For each propellant pair, over a grid of chamber stagnation pressure Pc
  and oxidizer/fuel mass ratio O/F, this script runs ONE CEA `RocketSolver`
  HP-equilibrium solve per grid point (infinite-area combustor, shifting
  equilibrium — the standard "theoretical rocket performance" problem) and
  records the CHAMBER point (index 0; the solver also returns the throat
  point, used here only to cross-check c*):

    - t0      equilibrium adiabatic flame ("stagnation") temperature [K]
    - mw      equilibrium mixture molecular weight [kg/mol]
    - gammaS  CEA's isentropic exponent gamma_s — NOT cp_eq/cv_eq.  gamma_s
              is the (d ln P / d ln rho)_s exponent that already accounts
              for the shifting-equilibrium expansion, so it is the correct
              single number to pair with mw for a FROZEN, constant-gamma
              ideal-gas surrogate of the equilibrium gas through the nozzle
              (the runtime's stated "frozen downstream of the chamber"
              simplification — see combustionGas.ts).
    - muPaS   equilibrium viscosity [Pa*s] (CEA reports millipoise; *1e-4)
    - cstar   CEA's characteristic velocity c* [m/s] — shipped ONLY as a
              validation reference for the solved network's emergent
              c* = Pc*At/mdot; the runtime never reads this field.

  The runtime deliberately does NOT store CEA's cp_eq: that is the
  equilibrium (reacting) specific heat, a different and larger quantity
  than the frozen ideal-gas cp implied by gammaS and R.  Instead the
  runtime derives, self-consistently with the ideal-gas model:
      R  = R_universal / mw
      cp = gammaS / (gammaS - 1) * R

Reactants (all resolved by name from CEA's bundled thermo.lib; standard
storable/cryogenic injection states used throughout the rest of this repo's
rocket examples):
    O2(L)  at  90.17 K   (oxidizer, both pairs)
    RP-1   at 298.15 K   (fuel, "lox-rp1")
    CH4(L) at 111.6  K   (fuel, "lox-ch4")

Grid: Pc log-spaced 0.2-30 MPa (25 points) x O/F linear 1.0-5.0 (33 points).
Every one of the 2 x 25 x 33 = 1650 points is REQUIRED to converge at
generation time (a non-converged point aborts generation with an error —
never silently emits a bad value; the runtime table is therefore always
complete and does not need edge-of-grid fallback logic).
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np

try:
    import cea
except ImportError:
    sys.stderr.write(
        "error: the `cea` package is not installed.\n"
        "  python3 -m venv .venv-cea\n"
        "  source .venv-cea/bin/activate\n"
        "  pip install cea numpy\n"
        "  python3 scripts/build-cea-tables.py\n"
    )
    sys.exit(1)

SCRIPT_DIR = Path(__file__).resolve().parent
OUT_PATH = (
    SCRIPT_DIR.parent / "src" / "core" / "combustion" / "generated" / "ceaTables.ts"
)

# ---------------------------------------------------------------------------
# Grid and propellant definitions
# ---------------------------------------------------------------------------

PC_GRID_PA = np.logspace(np.log10(0.2e6), np.log10(30e6), 25)
OF_GRID = np.linspace(1.0, 5.0, 33)

PROPELLANTS: dict[str, dict[str, object]] = {
    "lox-rp1": {
        "label": "LOX / RP-1",
        "reactants": ["O2(L)", "RP-1"],
        "temperaturesK": [90.17, 298.15],
    },
    "lox-ch4": {
        "label": "LOX / CH4",
        "reactants": ["O2(L)", "CH4(L)"],
        "temperaturesK": [90.17, 111.6],
    },
}

MILLIPOISE_TO_PA_S = 1e-4
G_PER_MOL_TO_KG_PER_MOL = 1e-3


def solve_grid(reactant_names: list[str], temperatures_k: list[float]) -> dict[str, np.ndarray]:
    """Run one CEA RocketSolver HP-equilibrium chamber solve per grid point."""
    reactants = cea.Mixture(reactant_names)
    products = cea.Mixture(reactant_names, products_from_reactants=True)
    solver = cea.RocketSolver(products, reactants=reactants, transport=True)
    oxidizer_weights = np.array([1.0, 0.0])
    fuel_weights = np.array([0.0, 1.0])
    t_reactant = np.array(temperatures_k)

    shape = (len(PC_GRID_PA), len(OF_GRID))
    t0 = np.zeros(shape)
    mw = np.zeros(shape)
    gamma_s = np.zeros(shape)
    mu = np.zeros(shape)
    cstar = np.zeros(shape)
    cstar_throat = np.zeros(shape)

    for i, pc_pa in enumerate(PC_GRID_PA):
        pc_bar = pc_pa / 1e5
        for j, of_ratio in enumerate(OF_GRID):
            weights = reactants.of_ratio_to_weights(
                oxidizer_weights, fuel_weights, float(of_ratio)
            )
            hc = reactants.calc_property(cea.ENTHALPY, weights, t_reactant) / cea.R
            soln = cea.RocketSolution(solver)
            solver.solve(soln, weights, float(pc_bar), hc=hc)
            chamber_ok = (
                soln.converged
                and soln.num_pts >= 1
                and np.isfinite(soln.T[0])
                and soln.T[0] > 0
            )
            if not chamber_ok:
                raise RuntimeError(
                    f"CEA did not converge at Pc={pc_pa:.4e} Pa, O/F={of_ratio:.4f} "
                    f"for {reactant_names}"
                )
            t0[i, j] = soln.T[0]
            mw[i, j] = soln.MW[0] * G_PER_MOL_TO_KG_PER_MOL
            gamma_s[i, j] = soln.gamma_s[0]
            mu[i, j] = soln.viscosity[0] * MILLIPOISE_TO_PA_S
            cstar[i, j] = soln.c_star[0]
            # Cross-check: the throat point's c* is, by CEA's own definition,
            # identical to the chamber point's — verify rather than assume.
            if soln.num_pts >= 2 and np.isfinite(soln.c_star[1]):
                cstar_throat[i, j] = soln.c_star[1]
            else:
                cstar_throat[i, j] = cstar[i, j]

    max_cstar_drift = float(np.max(np.abs(cstar - cstar_throat) / cstar))
    if max_cstar_drift > 1e-6:
        raise RuntimeError(
            f"chamber/throat c* disagree by up to {max_cstar_drift:.2e} (relative) "
            f"for {reactant_names} — investigate before shipping this table"
        )

    return {"t0": t0, "mw": mw, "gammaS": gamma_s, "muPaS": mu, "cstar": cstar}


# ---------------------------------------------------------------------------
# TypeScript emission
# ---------------------------------------------------------------------------


def fmt(x: float, sig: int = 7) -> str:
    """Round to `sig` significant figures and print the shortest clean form."""
    if x == 0:
        return "0"
    rounded = float(f"{x:.{sig}g}")
    return repr(rounded)


def fmt_row(row: np.ndarray) -> str:
    return "[" + ", ".join(fmt(float(v)) for v in row) + "]"


def fmt_table_2d(arr: np.ndarray) -> str:
    lines = ["["]
    for row in arr:
        lines.append(f"    {fmt_row(row)},")
    lines.append("  ]")
    return "\n".join(lines)


def emit_file(tables: dict[str, dict[str, np.ndarray]], cea_version: str) -> str:
    lines: list[str] = []
    lines.append("/**")
    lines.append(" * GENERATED FILE — do not edit by hand.")
    lines.append(" * Regenerate with: python3 scripts/build-cea-tables.py")
    lines.append(" * (requires a one-time `pip install cea numpy` — see the script")
    lines.append(" * header and docs/combustion.md; CEA is never a runtime dependency)")
    lines.append(" *")
    lines.append(
        f" * Source: NASA CEA (Chemical Equilibrium with Applications) v{cea_version}"
    )
    lines.append(" * (https://github.com/nasa/cea, Apache-2.0), RocketSolver HP-equilibrium")
    lines.append(" * chamber solve (infinite-area combustor, shifting equilibrium), one call")
    lines.append(" * per grid point.  See scripts/build-cea-tables.py for the full physics")
    lines.append(" * and units derivation (in particular why `gammaS` is CEA's gamma_s and")
    lines.append(" * not cp_eq/cv_eq, and why cp_eq itself is not stored).")
    lines.append(" *")
    lines.append(" * Reactants (CEA thermo.lib, standard storable/cryogenic injection states):")
    lines.append(" *   lox-rp1: O2(L) at 90.17 K + RP-1 at 298.15 K")
    lines.append(" *   lox-ch4: O2(L) at 90.17 K + CH4(L) at 111.6 K")
    lines.append(" *")
    lines.append(
        f" * Grid: Pc log-spaced {PC_GRID_PA[0]/1e6:g}-{PC_GRID_PA[-1]/1e6:g} MPa "
        f"({len(PC_GRID_PA)} pts) x O/F linear {OF_GRID[0]:g}-{OF_GRID[-1]:g} "
        f"({len(OF_GRID)} pts)."
    )
    lines.append(" * Every grid point converged at generation time (verified, not assumed).")
    lines.append(" */")
    lines.append("")
    lines.append('export type CombustionPropellants = "lox-rp1" | "lox-ch4";')
    lines.append("")
    lines.append("export interface CeaChamberTable {")
    lines.append("  /** Chamber stagnation pressure grid [Pa], strictly increasing. */")
    lines.append("  readonly pcGridPa: readonly number[];")
    lines.append("  /** Oxidizer/fuel mass-ratio grid, strictly increasing. */")
    lines.append("  readonly ofGrid: readonly number[];")
    lines.append(
        "  /** Equilibrium chamber (stagnation) temperature [K], [pcIndex][ofIndex]. */"
    )
    lines.append("  readonly t0: readonly (readonly number[])[];")
    lines.append("  /** Equilibrium mixture molecular weight [kg/mol]. */")
    lines.append("  readonly mw: readonly (readonly number[])[];")
    lines.append(
        "  /** CEA isentropic exponent gamma_s — the frozen-flow ideal-gas surrogate; "
    )
    lines.append("   *  see the script header for why this is not cp_eq/cv_eq. */")
    lines.append("  readonly gammaS: readonly (readonly number[])[];")
    lines.append("  /** Equilibrium viscosity [Pa*s]. */")
    lines.append("  readonly muPaS: readonly (readonly number[])[];")
    lines.append(
        "  /** CEA characteristic velocity c* [m/s] — validation reference only; "
    )
    lines.append("   *  the runtime combustor model never reads this field. */")
    lines.append("  readonly cstar: readonly (readonly number[])[];")
    lines.append("}")
    lines.append("")
    lines.append("export const CEA_PROVENANCE = {")
    lines.append(f'  ceaVersion: "{cea_version}",')
    lines.append('  generatedBy: "scripts/build-cea-tables.py",')
    lines.append("} as const;")
    lines.append("")
    lines.append(
        "export const CEA_TABLES: Record<CombustionPropellants, CeaChamberTable> = {"
    )
    for key, table in tables.items():
        lines.append(f'  "{key}": {{')
        lines.append(f"    pcGridPa: {fmt_row(PC_GRID_PA)},")
        lines.append(f"    ofGrid: {fmt_row(OF_GRID)},")
        lines.append(f"    t0: {fmt_table_2d(table['t0'])},")
        lines.append(f"    mw: {fmt_table_2d(table['mw'])},")
        lines.append(f"    gammaS: {fmt_table_2d(table['gammaS'])},")
        lines.append(f"    muPaS: {fmt_table_2d(table['muPaS'])},")
        lines.append(f"    cstar: {fmt_table_2d(table['cstar'])},")
        lines.append("  },")
    lines.append("};")
    lines.append("")
    return "\n".join(lines)


def main() -> None:
    check_only = "--check" in sys.argv[1:]

    cea_version = cea.lib_version()
    sys.stderr.write(f"CEA {cea_version}: solving {len(PROPELLANTS)} propellant grids\n")

    tables: dict[str, dict[str, np.ndarray]] = {}
    for key, spec in PROPELLANTS.items():
        sys.stderr.write(f"  {spec['label']} ({key}): {len(PC_GRID_PA)}x{len(OF_GRID)} points... ")
        tables[key] = solve_grid(spec["reactants"], spec["temperaturesK"])
        sys.stderr.write("ok\n")

    output = emit_file(tables, cea_version)

    if check_only:
        current = ""
        try:
            current = OUT_PATH.read_text()
        except FileNotFoundError:
            pass
        if current == output:
            sys.stderr.write("CEA tables are up to date\n")
            return
        sys.stderr.write("CEA tables are STALE — run: python3 scripts/build-cea-tables.py\n")
        sys.exit(1)

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(output)
    sys.stderr.write(f"wrote {OUT_PATH}\n")


if __name__ == "__main__":
    main()
