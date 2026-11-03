"""Fluid property access — the same EOS models the solver uses.

All inputs and outputs are SI: pressure P [Pa], temperature T [K], specific
enthalpy h [J/kg]. Property methods accept scalars, sequences or numpy arrays
(broadcast against each other) and return a float for all-scalar input,
otherwise a numpy array (or a list when numpy is not installed).
"""

from __future__ import annotations

from typing import Any

from ._bridge import Session, default_session

_ArrayLike = Any


def _is_scalar(x: Any) -> bool:
    return not hasattr(x, "__len__") and not hasattr(x, "__array__")


def _broadcast(args: tuple[Any, ...]) -> tuple[list[list[float]], tuple[int, ...] | None, bool]:
    """Rows of scalar arguments, output shape (numpy only), all-scalar flag."""
    if all(_is_scalar(a) for a in args):
        return [[float(a) for a in args]], None, True
    try:
        import numpy as np
    except ImportError:
        np = None
    if np is None:
        # Plain-Python fallback: scalars repeat, sequences must share one length.
        lists = [list(a) if not _is_scalar(a) else None for a in args]
        n = max(len(v) for v in lists if v is not None)
        cols = []
        for a, v in zip(args, lists, strict=True):
            if v is None:
                cols.append([float(a)] * n)
            elif len(v) != n:
                raise ValueError(f"argument lengths differ ({len(v)} vs {n}); install numpy for broadcasting")
            else:
                cols.append([float(x) for x in v])
        return [list(r) for r in zip(*cols, strict=True)], None, False
    arrays = np.broadcast_arrays(*[np.asarray(a, dtype=float) for a in args])
    shape = arrays[0].shape
    return np.stack([a.ravel() for a in arrays], axis=-1).tolist(), shape, False


def _shape_output(values: list[Any], shape: tuple[int, ...] | None) -> Any:
    if shape is None:
        return values
    import numpy as np

    if values and isinstance(values[0], dict):
        return np.asarray(values, dtype=object).reshape(shape)
    return np.asarray(values, dtype=float).reshape(shape)


class Fluid:
    """A fluid property model.

    Construct with the named constructors::

        n2 = Fluid.real("Nitrogen")          # CoolProp HEOS (see openflume.fluids())
        air = Fluid.air()                    # ideal gas preset
        water = Fluid.water()                # incompressible preset
        gas = Fluid.ideal_gas(R=296.8, gamma=1.4, mu=1.78e-5)
        liq = Fluid.incompressible(rho=1140, mu=1.9e-4, cp=1700)

    The arguments mirror the ``fluid`` block of a network config
    (``{"model": ..., "preset": ..., "params": {...}}``).
    """

    def __init__(
        self,
        model: str = "realFluid",
        *,
        preset: str | None = None,
        params: dict[str, float | str] | None = None,
        session: Session | None = None,
    ) -> None:
        self.model = model
        self.preset = preset
        self.params = dict(params or {})
        self._session = session

    # constructors -------------------------------------------------------------
    @classmethod
    def real(cls, name: str, *, session: Session | None = None) -> Fluid:
        """A CoolProp HEOS real fluid (two-phase capable), e.g. ``"Oxygen"``, ``"Hydrogen"``."""
        return cls("realFluid", params={"fluidName": name}, session=session)

    @classmethod
    def ideal_gas(
        cls, *, R: float = 287.0, gamma: float = 1.4, mu: float = 1.8e-5, session: Session | None = None
    ) -> Fluid:
        """Calorically perfect gas: gas constant R [J/(kg·K)], gamma, viscosity mu [Pa·s]."""
        return cls("idealGas", params={"R": R, "gamma": gamma, "mu": mu}, session=session)

    @classmethod
    def air(cls, *, session: Session | None = None) -> Fluid:
        return cls("idealGas", preset="air", session=session)

    @classmethod
    def incompressible(
        cls, *, rho: float = 1000.0, mu: float = 1e-3, cp: float = 4182.0, session: Session | None = None
    ) -> Fluid:
        """Constant-property liquid: rho [kg/m³], mu [Pa·s], cp [J/(kg·K)]."""
        return cls("incompressible", params={"rho": rho, "mu": mu, "cp": cp}, session=session)

    @classmethod
    def water(cls, *, session: Session | None = None) -> Fluid:
        return cls("incompressible", preset="water", session=session)

    @property
    def spec(self) -> dict[str, Any]:
        """The ``fluid`` config block for this model."""
        out: dict[str, Any] = {"model": self.model}
        if self.preset is not None:
            out["preset"] = self.preset
        if self.params:
            out["params"] = dict(self.params)
        return out

    # evaluation ---------------------------------------------------------------
    def _call(self, method: str, *args: _ArrayLike) -> Any:
        rows, shape, scalar = _broadcast(args) if args else ([[]], None, True)
        values = (self._session or default_session()).call(
            "fluidProperty", {"fluid": self.spec, "method": method, "args": rows}
        )
        if scalar:
            return values[0]
        return _shape_output(values, shape)

    def density(self, P: _ArrayLike, T: _ArrayLike) -> Any:
        """Density ρ(P, T) [kg/m³]."""
        return self._call("density", P, T)

    def viscosity(self, P: _ArrayLike, T: _ArrayLike) -> Any:
        """Dynamic viscosity μ(P, T) [Pa·s]."""
        return self._call("viscosity", P, T)

    def cp(self, P: _ArrayLike, T: _ArrayLike) -> Any:
        """Isobaric specific heat [J/(kg·K)]."""
        return self._call("cp", P, T)

    def cv(self, P: _ArrayLike, T: _ArrayLike) -> Any:
        """Isochoric specific heat [J/(kg·K)]."""
        return self._call("cv", P, T)

    def enthalpy(self, P: _ArrayLike, T: _ArrayLike) -> Any:
        """Specific enthalpy h(P, T) [J/kg]."""
        return self._call("enthalpy", P, T)

    def internal_energy(self, P: _ArrayLike, T: _ArrayLike) -> Any:
        """Specific internal energy u(P, T) [J/kg]."""
        return self._call("internalEnergy", P, T)

    def entropy(self, P: _ArrayLike, T: _ArrayLike) -> Any:
        """Specific entropy s(P, T) [J/(kg·K)] (real fluids only)."""
        return self._call("entropy", P, T)

    def speed_of_sound(self, P: _ArrayLike, T: _ArrayLike) -> Any:
        """Speed of sound a(P, T) [m/s] (not defined for incompressible liquids)."""
        return self._call("speedOfSound", P, T)

    def thermal_conductivity(self, P: _ArrayLike, T: _ArrayLike) -> Any:
        """Thermal conductivity k(P, T) [W/(m·K)] (real fluids only)."""
        return self._call("thermalConductivity", P, T)

    def temperature_from_enthalpy(self, P: _ArrayLike, h: _ArrayLike) -> Any:
        """Inverse T(P, h) [K]."""
        return self._call("temperatureFromEnthalpy", P, h)

    def state_ph(self, P: _ArrayLike, h: _ArrayLike) -> Any:
        """Full state at (P, h): dict with ``T``, ``rho``, ``quality``, ``phase``, ..."""
        return self._call("statePH", P, h)

    def enthalpy_pq(self, P: _ArrayLike, quality: _ArrayLike) -> Any:
        """Enthalpy at pressure and vapor quality [J/kg] (two-phase models)."""
        return self._call("enthalpyPQ", P, quality)

    def saturation_temperature(self, P: _ArrayLike) -> Any:
        """Saturation temperature T_sat(P) [K]."""
        return self._call("saturationTemperature", P)

    def h_sat_liquid(self, P: _ArrayLike) -> Any:
        return self._call("hSatLiquid", P)

    def h_sat_vapor(self, P: _ArrayLike) -> Any:
        return self._call("hSatVapor", P)

    def rho_sat_liquid(self, P: _ArrayLike) -> Any:
        return self._call("rhoSatLiquid", P)

    def rho_sat_vapor(self, P: _ArrayLike) -> Any:
        return self._call("rhoSatVapor", P)

    def critical_pressure(self) -> float:
        return self._call("criticalPressure")

    def critical_temperature(self) -> float:
        return self._call("criticalTemperature")

    def __repr__(self) -> str:
        if self.model == "realFluid":
            return f"Fluid.real({self.params.get('fluidName')!r})"
        return f"Fluid({self.model!r}, preset={self.preset!r}, params={self.params!r})"


def fluids(*, curated: bool = False, session: Session | None = None) -> list[dict[str, Any]]:
    """The CoolProp HEOS fluid catalogue (name, aliases, CAS, limits, transport flags).

    ``curated=True`` restricts it to the short list the web app offers first.
    """
    data = (session or default_session()).call("fluidCatalogue")
    entries = list(data["fluids"])
    if curated:
        wanted = set(data["curated"])
        entries = [e for e in entries if e.get("name") in wanted]
    return entries


def combustion_propellants(*, session: Session | None = None) -> list[dict[str, Any]]:
    """Tabulated propellant pairs and their (Pc, O/F) table bounds."""
    return list((session or default_session()).call("combustionPropellants"))


def combustion_gas(propellants: str, pc: float, of: float, *, session: Session | None = None) -> dict[str, Any]:
    """Equilibrium chamber gas state from the bundled NASA CEA tables.

    ``pc`` is chamber pressure [Pa], ``of`` the oxidizer/fuel mass ratio.
    The result flags ``clampedPc`` / ``clampedOf`` when the request was outside the table.
    """
    return (session or default_session()).call("combustionGas", {"propellants": propellants, "pc": pc, "of": of})
