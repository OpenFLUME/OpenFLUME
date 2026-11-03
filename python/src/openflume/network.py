"""Network models: load, validate, edit, save, solve."""

from __future__ import annotations

import copy
import json
import os
from pathlib import Path
from typing import Any, Literal

from ._bridge import ProgressCallback, Session, default_session
from .errors import ParseError
from .results import SteadyResult, TransientResult, make_result

PathLike = str | os.PathLike[str]
SolveMode = Literal["steady", "transient"]


class Network:
    """An OpenFLUME network model.

    ``config`` is the plain-dict ``NetworkConfig`` (schema v2, SI units) — the
    same structure the web app autosaves and ``src/core/schema.ts`` defines.
    Edit it freely between solves; it is sent to the core on every call.

    Construct with :func:`openflume.load`, :meth:`from_dict`, :meth:`from_text`,
    :meth:`from_json` or :func:`openflume.example`.
    """

    def __init__(self, config: dict[str, Any], *, session: Session | None = None) -> None:
        if not isinstance(config, dict):
            raise TypeError(f"config must be a dict, got {type(config).__name__}")
        self.config = config
        self._session = session

    # construction -----------------------------------------------------------
    @classmethod
    def from_dict(cls, config: dict[str, Any], *, session: Session | None = None) -> Network:
        """Wrap a deep copy of ``config``."""
        return cls(copy.deepcopy(config), session=session)

    @classmethod
    def from_json(cls, text: str, *, session: Session | None = None) -> Network:
        return cls(json.loads(text), session=session)

    @classmethod
    def from_text(cls, text: str, *, session: Session | None = None, source: str | None = None) -> Network:
        """Parse the ``.fn`` text format (what the web app's Save writes)."""
        sess = session or default_session()
        res = sess.call("parseText", {"text": text})
        if res["config"] is None or res["errors"]:
            raise ParseError(res["errors"], source)
        return cls(res["config"], session=session)

    @classmethod
    def load(cls, path: PathLike, *, session: Session | None = None) -> Network:
        """Load a ``.fn`` text model or a ``.json`` config from disk."""
        p = Path(path)
        text = p.read_text(encoding="utf-8")
        if p.suffix.lower() == ".json" or (p.suffix.lower() != ".fn" and text.lstrip().startswith("{")):
            return cls.from_json(text, session=session)
        return cls.from_text(text, session=session, source=str(p))

    # serialization ----------------------------------------------------------
    def to_dict(self) -> dict[str, Any]:
        """A deep copy of the config dict."""
        return copy.deepcopy(self.config)

    def to_json(self, *, indent: int | None = 2) -> str:
        return json.dumps(self.config, indent=indent)

    def to_text(self) -> str:
        """Serialize to the ``.fn`` text format (loadable by the web app)."""
        return self._session_call("serializeText", {"config": self.config})

    def save(self, path: PathLike) -> Path:
        """Write ``.fn`` text, or JSON when the suffix is ``.json``."""
        p = Path(path)
        data = self.to_json() + "\n" if p.suffix.lower() == ".json" else self.to_text()
        p.write_text(data, encoding="utf-8")
        return p

    def copy(self) -> Network:
        return Network(copy.deepcopy(self.config), session=self._session)

    # inspection -------------------------------------------------------------
    @property
    def name(self) -> str:
        return str(self.config.get("meta", {}).get("name", ""))

    @property
    def mode(self) -> str:
        """``settings.mode`` — ``"steady"`` or ``"transient"``."""
        return str(self.config.get("settings", {}).get("mode", "steady"))

    @property
    def settings(self) -> dict[str, Any]:
        return self.config.setdefault("settings", {})

    def _find(self, key: str, entity_id: str) -> dict[str, Any]:
        for item in self.config.get(key, []):
            if item.get("id") == entity_id:
                return item
        raise KeyError(f"no {key} entry with id {entity_id!r}")

    def node(self, node_id: str) -> dict[str, Any]:
        """The node dict with this id (live — edits change the model)."""
        return self._find("nodes", node_id)

    def branch(self, branch_id: str) -> dict[str, Any]:
        """The branch dict with this id (live — edits change the model)."""
        return self._find("branches", branch_id)

    def decoded(self) -> Network:
        """A copy normalized by the core decoder (legacy fields migrated)."""
        return Network(self._session_call("decode", {"config": self.config}), session=self._session)

    def validate(self) -> list[str]:
        """Semantic validation errors; an empty list means the model is runnable.

        Raises :class:`~openflume.ConfigDecodeError` if the model is structurally malformed.
        """
        return list(self._session_call("validate", {"config": self.config})["errors"])

    @property
    def is_valid(self) -> bool:
        try:
            return not self.validate()
        except ValueError:
            return False

    def readiness(self) -> list[dict[str, Any]]:
        """Pre-run readiness checks from the model advisor."""
        return self._session_call("readiness", {"config": self.config})

    # solving ----------------------------------------------------------------
    def solve(
        self,
        mode: SolveMode | None = None,
        *,
        progress: ProgressCallback | None = None,
    ) -> SteadyResult | TransientResult:
        """Validate and solve. ``mode`` defaults to ``settings.mode``.

        ``progress`` (optional) is called at most ~10×/s with a dict —
        ``{"kind": "steady", "iteration", "residual"}`` or
        ``{"kind": "transient", "step", "time", "endTime", "dt", "totalSteps"}``.

        Raises :class:`~openflume.ValidationError` if the model fails validation.
        Ctrl-C interrupts a long solve (the Node process is restarted).
        """
        sess = self._session or default_session()
        res = sess.call(
            "solve",
            {"config": self.config, "mode": mode, "progress": progress is not None},
            on_progress=progress,
        )
        return make_result(res["mode"], res["result"], self)

    def solve_steady(self, *, progress: ProgressCallback | None = None) -> SteadyResult:
        result = self.solve("steady", progress=progress)
        assert isinstance(result, SteadyResult)
        return result

    def solve_transient(self, *, progress: ProgressCallback | None = None) -> TransientResult:
        result = self.solve("transient", progress=progress)
        assert isinstance(result, TransientResult)
        return result

    # internals --------------------------------------------------------------
    def _session_call(self, method: str, params: dict[str, Any]) -> Any:
        return (self._session or default_session()).call(method, params)

    def __repr__(self) -> str:
        return (
            f"<Network {self.name!r} mode={self.mode} nodes={len(self.config.get('nodes', []))} "
            f"branches={len(self.config.get('branches', []))}>"
        )


def load(path: PathLike, *, session: Session | None = None) -> Network:
    """Load a ``.fn`` or ``.json`` model file."""
    return Network.load(path, session=session)


def examples(*, session: Session | None = None) -> list[str]:
    """Names of the example models bundled with the web app."""
    return list((session or default_session()).call("examples"))


def example(name: str, *, session: Session | None = None) -> Network:
    """One of the bundled example models, e.g. ``example("Tank blowdown")``."""
    return Network((session or default_session()).call("example", {"name": name}), session=session)


def solve(
    model: Network | dict[str, Any] | PathLike,
    mode: SolveMode | None = None,
    *,
    progress: ProgressCallback | None = None,
    session: Session | None = None,
) -> SteadyResult | TransientResult:
    """Solve a :class:`Network`, a config dict, or a model file path."""
    if isinstance(model, Network):
        net = model
    elif isinstance(model, dict):
        net = Network(model, session=session)
    else:
        net = Network.load(model, session=session)
    return net.solve(mode, progress=progress)


def validate(model: Network | dict[str, Any] | PathLike, *, session: Session | None = None) -> list[str]:
    """Validation errors for a :class:`Network`, config dict, or model file path."""
    if isinstance(model, Network):
        return model.validate()
    if isinstance(model, dict):
        return Network(model, session=session).validate()
    return Network.load(model, session=session).validate()


__all__ = ["Network", "example", "examples", "load", "solve", "validate"]
