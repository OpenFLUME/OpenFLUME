"""OpenFLUME — thermal-fluid network solver, from Python.

Quick start::

    import openflume as of

    net = of.load("feed_system.fn")        # or of.example("Tank blowdown")
    errors = net.validate()                # [] means runnable
    result = net.solve()                   # steady or transient per settings.mode
    print(result.converged, result.node("tank")["pressure"])

    n2 = of.Fluid.real("Nitrogen")
    n2.density(101325, 300.0)              # kg/m³

Everything is SI (Pa, K, kg/s, m, J/kg). The solver core is the same
TypeScript code that runs the web app, executed in a bundled Node.js runtime
(see :class:`Session`). Models that embed JavaScript user components run that
code with the privileges of your Python process — only solve models you trust.
"""

from __future__ import annotations

from importlib.metadata import PackageNotFoundError
from importlib.metadata import version as _dist_version

from ._bridge import Session, default_session, find_node, shutdown
from .errors import (
    BridgeError,
    ConfigDecodeError,
    CoreError,
    InvalidRequestError,
    OpenFLUMEError,
    ParseError,
    UnknownExampleError,
    UnsupportedPropertyError,
    ValidationError,
)
from .fluids import Fluid, combustion_gas, combustion_propellants, fluids
from .network import Network, example, examples, load, solve, validate
from .results import SteadyResult, TransientResult

try:
    __version__ = _dist_version("openflume")
except PackageNotFoundError:  # running from a source tree without install
    __version__ = "0+unknown"

__all__ = [
    "__version__",
    # models
    "Network",
    "load",
    "example",
    "examples",
    "solve",
    "validate",
    # results
    "SteadyResult",
    "TransientResult",
    # fluids
    "Fluid",
    "fluids",
    "combustion_gas",
    "combustion_propellants",
    # runtime
    "Session",
    "default_session",
    "shutdown",
    "find_node",
    # errors
    "OpenFLUMEError",
    "BridgeError",
    "ConfigDecodeError",
    "ValidationError",
    "ParseError",
    "CoreError",
    "UnknownExampleError",
    "InvalidRequestError",
    "UnsupportedPropertyError",
]
