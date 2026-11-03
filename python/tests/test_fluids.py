from __future__ import annotations

import pytest

import openflume as of


def test_nitrogen_density_ideal_gas_limit():
    # N2 at 1 atm, 300 K is near-ideal: rho ≈ P·M/(R·T) = 101325·0.0280134/(8.314462618·300)
    # = 1.1380 kg/m³; compressibility Z ≈ 0.9997 at this state.
    rho = of.Fluid.real("Nitrogen").density(101325.0, 300.0)
    assert isinstance(rho, float)
    assert rho == pytest.approx(1.1380, rel=1e-3)


def test_vectorized_properties():
    n2 = of.Fluid.real("Nitrogen")
    values = n2.density([101325.0, 202650.0], 300.0)
    assert len(values) == 2
    assert values[1] == pytest.approx(2 * values[0], rel=2e-3)


def test_numpy_broadcasting():
    np = pytest.importorskip("numpy")
    P = np.array([1e5, 2e5, 3e5])[:, None]
    T = np.array([250.0, 300.0])[None, :]
    rho = of.Fluid.air().density(P, T)
    assert rho.shape == (3, 2)
    assert rho[0, 1] == pytest.approx(1e5 / (287.0 * 300.0), rel=1e-9)


def test_saturation_and_critical_point():
    o2 = of.Fluid.real("Oxygen")
    # Normal boiling point of O2 ≈ 90.19 K; critical point ≈ 154.58 K, 5.043 MPa.
    assert o2.saturation_temperature(101325.0) == pytest.approx(90.19, abs=0.05)
    assert o2.critical_temperature() == pytest.approx(154.58, abs=0.05)
    assert o2.critical_pressure() == pytest.approx(5.043e6, rel=1e-3)


def test_state_ph_returns_dicts():
    water = of.Fluid.real("Water")
    h = water.enthalpy_pq(101325.0, 0.5)
    state = water.state_ph(101325.0, h)
    assert isinstance(state, dict)
    assert 0.49 < state["quality"] < 0.51


def test_incompressible_constants():
    liq = of.Fluid.incompressible(rho=1140.0, mu=1.9e-4, cp=1700.0)
    assert liq.density(1e6, 90.0) == 1140.0
    assert liq.spec == {"model": "incompressible", "params": {"rho": 1140.0, "mu": 1.9e-4, "cp": 1700.0}}


def test_unsupported_property():
    with pytest.raises(of.UnsupportedPropertyError):
        of.Fluid.water().entropy(1e5, 300.0)


def test_unknown_real_fluid():
    with pytest.raises(of.CoreError):
        of.Fluid.real("Unobtainium").density(1e5, 300.0)


def test_fluid_catalogue():
    all_fluids = of.fluids()
    names = {f["name"] for f in all_fluids}
    assert {"Nitrogen", "Oxygen", "Hydrogen", "Methane"} <= names
    curated = of.fluids(curated=True)
    assert 0 < len(curated) < len(all_fluids)


def test_combustion_tables():
    pairs = {p["propellants"]: p["bounds"] for p in of.combustion_propellants()}
    assert "lox-rp1" in pairs
    gas = of.combustion_gas("lox-rp1", 7e6, 2.6)
    # LOX/RP-1 at 7 MPa, O/F 2.6: CEA equilibrium T0 ≈ 3.6–3.7 kK, c* ≈ 1.8 km/s.
    assert 3400 < gas["state"]["T0"] < 3900
    assert 1700 < gas["state"]["cstar"] < 1900
    assert not gas["clampedPc"] and not gas["clampedOf"]
