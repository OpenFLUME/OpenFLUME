"""Exception hierarchy. Every error raised by openflume derives from OpenFLUMEError."""

from __future__ import annotations

from typing import Any


class OpenFLUMEError(Exception):
    """Base class for all openflume errors."""


class BridgeError(OpenFLUMEError, RuntimeError):
    """The Node.js runtime could not be found, started, or died mid-request."""


class ConfigDecodeError(OpenFLUMEError, ValueError):
    """The model is structurally malformed (missing/wrongly-typed field, bad schema version).

    Attributes:
        code: Machine-readable category, e.g. ``"missing-field"``, ``"invalid-type"``,
            ``"unsupported-version"``.
        path: Dotted path to the offending value, e.g. ``"nodes[2].pressure"``.
    """

    def __init__(self, message: str, *, code: str = "", path: str = "") -> None:
        super().__init__(message)
        self.code = code
        self.path = path


class ValidationError(OpenFLUMEError, ValueError):
    """The model decoded but failed semantic validation; ``errors`` lists every problem."""

    def __init__(self, message: str, errors: list[str]) -> None:
        super().__init__(message + "".join(f"\n  - {e}" for e in errors))
        self.errors = list(errors)


class ParseError(OpenFLUMEError, ValueError):
    """A ``.fn`` text model could not be parsed.

    ``errors`` holds dicts with ``message``, ``stage`` and (when known) 1-based ``line``.
    """

    def __init__(self, errors: list[dict[str, Any]], source: str | None = None) -> None:
        self.errors = list(errors)
        self.source = source
        where = f" in {source}" if source else ""
        lines = []
        for e in self.errors:
            loc = f"line {e['line']}: " if e.get("line") is not None else ""
            lines.append(f"\n  - {loc}{e.get('message', '')}")
        super().__init__(f"could not parse model{where}" + "".join(lines))


class CoreError(OpenFLUMEError):
    """An error thrown inside the solver core.

    Attributes:
        js_type: The JavaScript error name (e.g. ``"Error"``, ``"UserCodeError"``).
        js_stack: The JavaScript stack trace, when available.
    """

    def __init__(self, message: str, *, js_type: str = "Error", js_stack: str | None = None) -> None:
        super().__init__(message)
        self.js_type = js_type
        self.js_stack = js_stack


class UnknownExampleError(OpenFLUMEError, KeyError):
    """No bundled example has the requested name."""

    def __init__(self, message: str, available: list[str]) -> None:
        super().__init__(message)
        self.available = list(available)

    def __str__(self) -> str:  # KeyError would repr() the message
        return str(self.args[0])


class InvalidRequestError(OpenFLUMEError, ValueError):
    """An argument was rejected (unknown solve mode, unsupported property name, ...)."""


class UnsupportedPropertyError(OpenFLUMEError, NotImplementedError):
    """The selected fluid model does not provide the requested property."""


def from_payload(payload: dict[str, Any]) -> OpenFLUMEError:
    """Map a bridge error payload to the matching Python exception."""
    kind = payload.get("type", "Error")
    message = payload.get("message", "unknown error")
    if kind == "ConfigDecodeError":
        return ConfigDecodeError(message, code=payload.get("code", ""), path=payload.get("path", ""))
    if kind == "ValidationError":
        return ValidationError(message, payload.get("errors", []))
    if kind == "KeyError":
        return UnknownExampleError(message, payload.get("available", []))
    if kind == "ValueError":
        return InvalidRequestError(message)
    if kind == "NotImplementedError":
        return UnsupportedPropertyError(message)
    return CoreError(message, js_type=kind, js_stack=payload.get("stack"))
