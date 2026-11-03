"""Solve results.

Both result types keep the core's JSON result unchanged in ``raw`` (field names
and SI units exactly as documented in docs/user-manual.md and
src/core/schema.ts) and add typed accessors plus optional numpy/pandas
conversion. Always check ``converged`` before using numbers: the solver returns
its best state either way.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    import pandas as pd

    from .network import Network


def _require_pandas() -> Any:
    try:
        import pandas
    except ImportError as exc:  # pragma: no cover - depends on environment
        raise ImportError("this method needs pandas: pip install 'openflume[pandas]'") from exc
    return pandas


def _array(values: list[Any]) -> Any:
    """numpy array when numpy is installed, else the list itself."""
    try:
        import numpy
    except ImportError:
        return values
    return numpy.asarray(values)


class _Result(Mapping[str, Any]):
    """Read-only mapping view over the raw result, plus convenience accessors."""

    mode: str

    def __init__(self, raw: dict[str, Any], network: Network | None = None) -> None:
        self.raw = raw
        self.network = network

    # Mapping protocol → raw dict, so result["nodes"] etc. keep working.
    def __getitem__(self, key: str) -> Any:
        return self.raw[key]

    def __iter__(self):  # type: ignore[no-untyped-def]
        return iter(self.raw)

    def __len__(self) -> int:
        return len(self.raw)

    @property
    def converged(self) -> bool:
        return bool(self.raw.get("converged"))

    @property
    def aborted(self) -> bool:
        return bool(self.raw.get("aborted", False))

    @property
    def nodes(self) -> dict[str, dict[str, Any]]:
        return self.raw.get("nodes", {})

    @property
    def branches(self) -> dict[str, dict[str, Any]]:
        return self.raw.get("branches", {})

    @property
    def solid_nodes(self) -> dict[str, dict[str, Any]]:
        return self.raw.get("solidNodes") or {}

    @property
    def conductors(self) -> dict[str, dict[str, Any]]:
        return self.raw.get("conductors") or {}

    @property
    def junctions(self) -> dict[str, dict[str, Any]]:
        return self.raw.get("junctions") or {}

    @property
    def warnings(self) -> list[str]:
        return list(self.raw.get("warnings") or [])

    @property
    def final_registers(self) -> dict[str, float]:
        return dict(self.raw.get("finalRegisters") or {})

    def _lookup(self, table: str, key: str) -> dict[str, Any]:
        group = self.raw.get(table) or {}
        if key not in group:
            raise KeyError(f"no {table} entry {key!r}; available: {sorted(group)}")
        return group[key]

    def node(self, node_id: str) -> dict[str, Any]:
        return self._lookup("nodes", node_id)

    def branch(self, branch_id: str) -> dict[str, Any]:
        return self._lookup("branches", branch_id)

    def assess(self) -> list[dict[str, Any]]:
        """Post-solve findings (choked branches, two-phase entry, limits hit, ...).

        Returns the core's ``ResultFinding`` dicts (``severity``, ``message``, ``target``...).
        """
        if self.network is None:
            raise ValueError("assess() needs the Network this result was solved from")
        return self.network._session_call("assessResult", {"config": self.network.config, "result": self.raw})


class SteadyResult(_Result):
    """Result of a steady-state solve.

    ``nodes[id]`` carries ``pressure`` [Pa], ``temperature`` [K], ``density``
    [kg/m³] and, where the fluid model supports them, ``quality``, ``phase``,
    ``enthalpy``, ``entropy``... ``branches[id]`` carries ``mdot`` [kg/s],
    ``velocity`` [m/s], ``dP`` [Pa], ``reynolds`` and optional ``mach``,
    ``volumetricFlow``, ``massFlux``, ``dynamicPressure``.
    """

    mode = "steady"

    @property
    def iterations(self) -> int:
        return int(self.raw.get("iterations", 0))

    @property
    def residual(self) -> float:
        return float(self.raw.get("residual", float("nan")))

    def _frame(self, table: str) -> pd.DataFrame:
        pd = _require_pandas()
        rows = {
            key: {k: v for k, v in values.items() if not isinstance(v, (dict, list))}
            for key, values in (self.raw.get(table) or {}).items()
        }
        frame = pd.DataFrame.from_dict(rows, orient="index")
        frame.index.name = "id"
        return frame

    def nodes_frame(self) -> pd.DataFrame:
        """Node states as a DataFrame indexed by node id (needs pandas)."""
        return self._frame("nodes")

    def branches_frame(self) -> pd.DataFrame:
        """Branch flows as a DataFrame indexed by branch id (needs pandas)."""
        return self._frame("branches")

    def __repr__(self) -> str:
        return (
            f"<SteadyResult converged={self.converged} iterations={self.iterations} "
            f"residual={self.residual:.3g} nodes={len(self.nodes)} branches={len(self.branches)}>"
        )


class TransientResult(_Result):
    """Result of a transient solve.

    ``times`` [s] holds every accepted step; every per-entity history
    (``nodes[id]["pressure"]``, ``branches[id]["mdot"]``, ...) is aligned 1:1
    with it.
    """

    mode = "transient"

    @property
    def times(self) -> Any:
        """Accepted-step times [s] (numpy array if numpy is installed)."""
        return _array(self.raw.get("times", []))

    @property
    def stats(self) -> dict[str, Any]:
        return dict(self.raw.get("stats") or {})

    def series(self, entity_id: str, quantity: str, *, kind: str | None = None) -> Any:
        """One history, e.g. ``series("tank", "pressure")`` or ``series("orifice", "mdot")``.

        ``kind`` (``"nodes"``, ``"branches"``, ``"solidNodes"``, ``"conductors"``,
        ``"junctions"``) is only needed when ids collide across kinds.
        Returns a numpy array when numpy is installed, else a list.
        """
        tables = [kind] if kind else ["nodes", "branches", "solidNodes", "conductors", "junctions"]
        for table in tables:
            group = self.raw.get(table) or {}
            if entity_id in group:
                values = group[entity_id]
                if quantity not in values:
                    raise KeyError(f"{table}[{entity_id!r}] has no {quantity!r}; available: {sorted(values)}")
                return _array(values[quantity])
        raise KeyError(f"no entity {entity_id!r} in {', '.join(tables)}")

    def frame(self, kind: str = "nodes") -> pd.DataFrame:
        """Histories as a wide DataFrame (needs pandas).

        Index is ``time`` [s]; columns are a ``(id, quantity)`` MultiIndex, so
        ``result.frame()["tank"]["pressure"]`` is the tank pressure trace.
        Non-numeric-per-step entries (nested dicts such as ``massFractions``)
        are skipped.
        """
        pd = _require_pandas()
        times = self.raw.get("times", [])
        columns: dict[tuple[str, str], list[Any]] = {}
        for entity_id, values in (self.raw.get(kind) or {}).items():
            for quantity, series in values.items():
                if isinstance(series, list) and len(series) == len(times):
                    columns[(entity_id, quantity)] = series
        frame = pd.DataFrame(columns, index=pd.Index(times, name="time"))
        if columns:
            frame.columns = pd.MultiIndex.from_tuples(frame.columns, names=["id", "quantity"])
        return frame

    def __repr__(self) -> str:
        times = self.raw.get("times", [])
        end = times[-1] if times else float("nan")
        return (
            f"<TransientResult converged={self.converged} steps={len(times)} "
            f"t_end={end:.6g}s nodes={len(self.nodes)} branches={len(self.branches)}>"
        )


def make_result(mode: str, raw: dict[str, Any], network: Network | None) -> SteadyResult | TransientResult:
    return TransientResult(raw, network) if mode == "transient" else SteadyResult(raw, network)
