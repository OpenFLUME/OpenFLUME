# Python package

`openflume` is a pip-installable Python API for the OpenFLUME core. It exists
so propulsion and thermal-fluids engineers can drive the solver from their
existing Python workflows (sweeps, optimizers, notebooks, post-processing
with numpy/pandas/matplotlib, CI checks on models) without touching
TypeScript.

```bash
pip install openflume                 # add [numpy,pandas] for array/DataFrame output
```

```python
import openflume as of

net = of.load("feed_system.fn")       # a model saved from the web app
assert net.validate() == []
result = net.solve()
print(result.converged, result.node("tank")["pressure"])   # Pa
```

## How it works

The package does **not** reimplement the solver. It runs the same
`src/core` code as the web app on Node's V8 engine, so results match the
TypeScript library exactly and the browser to floating-point rounding (JS
engines may differ in the last bit of `Math.*` functions). Every verification
and validation result in the user manual applies unchanged.

```
Python (openflume)  ── NDJSON over stdin/stdout ──▶  node openflume-bridge.mjs
  Network / results / Fluid                             src/core + .fn parser + examples
                                                        coolprop.wasm (real fluids)
```

- **Bundle.** `npm run build:python` bundles `python/bridge/server.ts` (which
  imports the core barrel `src/core/index.ts`, the `.fn` parser
  `src/substrate/textProjection.ts`, and the built-in examples) into one
  self-contained ESM file. `coolprop.wasm` is copied next to it, into
  `python/src/openflume/_js/`. Both files are build artifacts: they are
  gitignored and shipped in the wheel and sdist.
- **Runtime.** Node.js comes from the
  [`nodejs-wheel-binaries`](https://pypi.org/project/nodejs-wheel-binaries/)
  dependency, so `pip install` needs nothing else. Lookup order is
  `$OPENFLUME_NODE`, then the wheel's Node, then `node` on `PATH`. Node 22 or
  newer is required.
- **Wheel.** The wheel is pure Python (`py3-none-any`) because the platform
  binary lives in the Node dependency. It is about 4.6 MB, most of which is
  CoolProp.
- **Session.** A `Session` is one long-lived Node process, started on first
  use and stopped at interpreter exit. Module-level functions share a default
  session. Requests are serialized because the solvers are synchronous. Use
  one session per process for parallelism.
- **Protocol.** The header of `python/bridge/server.ts` documents the protocol.
  Non-finite floats travel as `{"$num": "NaN" | "Infinity" | "-Infinity"}` in
  both directions, so NaN and ±inf survive intact (JSON would otherwise turn
  them into `null`). Console output from the core and from user components is
  redirected to stderr and forwarded to the `openflume.node` logger, so it
  cannot corrupt the protocol.
- **Interrupts.** Ctrl-C during a solve kills the Node process (the solve
  cannot be cancelled cooperatively) and raises `KeyboardInterrupt`. The
  session restarts on its next call. Node runs in its own process group so a
  terminal Ctrl-C reaches Python first.

## API

Everything is SI: Pa, K, kg/s, m, m², J/kg, s.

### Models: `Network`

| Call                                                             | Purpose                                                                                                       |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `of.load(path)`                                                  | Load `.fn` text (what the web app saves) or `.json`                                                           |
| `of.example(name)`, `of.examples()`                              | The built-in examples (14)                                                                                    |
| `Network.from_dict(d)`, `.from_json(s)`, `.from_text(s)`         | Construct from a `NetworkConfig` dict, JSON, or `.fn` text                                                    |
| `net.config`                                                     | The live `NetworkConfig` dict (schema v2, `src/core/schema.ts`). Edit it freely; it is re-sent on every call. |
| `net.node(id)`, `net.branch(id)`, `net.settings`                 | Live sub-dicts of `config`                                                                                    |
| `net.validate()`                                                 | List of semantic errors (`[]` means runnable). Raises `ConfigDecodeError` for structural problems.            |
| `net.readiness()`                                                | Model-advisor pre-run checks                                                                                  |
| `net.solve(mode=None, progress=None)`                            | Validate then solve; `mode` defaults to `settings.mode`                                                       |
| `net.solve_steady()`, `net.solve_transient()`                    | Typed shortcuts                                                                                               |
| `net.to_text()`, `net.to_json()`, `net.save(path)`, `net.copy()` | Serialize; `.fn` round-trips losslessly with the web app                                                      |
| `of.solve(model)`, `of.validate(model)`                          | Accept a `Network`, a dict, or a path                                                                         |

`progress` is called at most about 10 times a second with
`{"kind": "steady", "iteration", "residual"}` or
`{"kind": "transient", "step", "time", "endTime", "dt", "totalSteps"}`.

### Results

`SteadyResult` and `TransientResult` are read-only mappings over the core's
raw result object (`result.raw`, field names exactly as in
`src/core/schema.ts`), with accessors on top:

- **Both:**
  - Status: `converged`, `aborted`, `warnings`.
  - Entity results: `nodes`, `branches`, `solid_nodes`, `conductors`, `junctions`, `final_registers`.
  - `node(id)` and `branch(id)`.
  - `assess()`, the post-solve findings from `assessResult`.
- **Steady:**
  - `iterations` and `residual`.
  - `nodes_frame()` and `branches_frame()` return pandas DataFrames.
- **Transient:**
  - `times` and `series(id, quantity)` return numpy arrays if numpy is installed.
  - `stats` holds step statistics.
  - `frame(kind="nodes")` returns a pandas DataFrame indexed by `time`, with `(id, quantity)` columns.

Always check `converged`. The solver returns its best state either way.

### Fluids

```python
lox = of.Fluid.real("Oxygen")         # CoolProp HEOS; of.fluids() lists all 124
lox.density(2e6, 95.0)
lox.saturation_temperature(np.linspace(1e5, 4e6, 50))   # broadcasts like numpy
lox.state_ph(2e6, h)                  # dict: T, rho, quality, phase, ...
of.Fluid.air(); of.Fluid.water(); of.Fluid.ideal_gas(R=..., gamma=..., mu=...)
of.Fluid.incompressible(rho=..., mu=..., cp=...)
of.combustion_gas("lox-rp1", pc=7e6, of=2.6)   # CEA equilibrium tables
```

The methods are `density`, `viscosity`, `cp`, `cv`, `enthalpy`, `internal_energy`,
`entropy`, `speed_of_sound`, `thermal_conductivity`,
`temperature_from_enthalpy`, `state_ph`, `enthalpy_pq`,
`saturation_temperature`, `h_sat_liquid`, `h_sat_vapor`, `rho_sat_liquid`,
`rho_sat_vapor`, `critical_pressure`, and `critical_temperature`. A property
the selected model does not define (for example, entropy of an incompressible
liquid) raises `UnsupportedPropertyError` rather than returning a made-up
number.

### Errors

All errors derive from `OpenFLUMEError`:

| Exception                  | Raised when                                                             | Also a              |
| -------------------------- | ----------------------------------------------------------------------- | ------------------- |
| `ConfigDecodeError`        | The model is malformed; carries `.code` and `.path`                     | ValueError          |
| `ValidationError`          | The model fails semantic validation during `solve()`; carries `.errors` | ValueError          |
| `ParseError`               | `.fn` text has syntax errors; `.errors` lists them with line numbers    | ValueError          |
| `CoreError`                | Anything thrown inside the core; carries `.js_type` and `.js_stack`     | —                   |
| `UnknownExampleError`      | Unknown example name                                                    | KeyError            |
| `InvalidRequestError`      | A bad argument, such as an unknown solve mode                           | ValueError          |
| `UnsupportedPropertyError` | The fluid model lacks the requested property                            | NotImplementedError |
| `BridgeError`              | Node.js is missing, too old, or died                                    | RuntimeError        |

### Command line

```bash
openflume info                         # package, core, and Node versions
openflume validate model.fn            # exit 1 if invalid
openflume solve model.fn -o out.json   # raw JSON result; exit 1 if not converged
```

`python -m openflume ...` does the same.

## Parallel sweeps

Each process gets its own default session, so a process pool parallelizes
directly:

```python
from concurrent.futures import ProcessPoolExecutor
import openflume as of

def run(cd: float) -> float:
    net = of.example("Sanity: orifice hand-calc")
    net.branch("o")["component"]["cd"] = cd
    return net.solve().branch("o")["mdot"]

with ProcessPoolExecutor() as pool:
    flows = list(pool.map(run, [0.55, 0.60, 0.65, 0.70]))
```

Threads within one process share the default session and run one request at
a time. For thread-level parallelism, give each thread its own
`of.Session()`.

## Trust model

Models can embed JavaScript user components (`componentLibrary`;
see [usercode.md](usercode.md)). The Python package runs them exactly as the
TypeScript core does: inside the Node process, with the privileges of the
Python user, and with no isolation. That is the same posture as importing an
untrusted Python module. Only solve models you trust. Expressions
(`{...}` formula bindings, logic rules, controllers) use the core's own
parser and never evaluate code.

## Development

From a clone (Node 22, npm, and Python ≥ 3.10):

```bash
npm ci
npm run build:python                  # bundle core → python/src/openflume/_js/
cd python
python -m venv .venv && . .venv/bin/activate
pip install -e '.[test,numpy,pandas]'
pytest
ruff check . && ruff format --check .
```

Re-run `npm run build:python` after any change under `src/` or
`python/bridge/`. The editable install picks up the new bundle without
reinstalling. `python -m build python` (or `uv build python`) produces the
wheel and sdist. The build refuses to run without the bundle.

CI (`.github/workflows/python-package.yml`, called from `ci.yml`) builds the
wheel and sdist once, checks that a wheel builds from the sdist alone, then
installs the built wheel and runs `python/tests` on Linux, macOS, and Windows
with Python 3.10 and 3.13. One extra job runs without numpy or pandas.

### Releasing

`python/pyproject.toml` `version` must equal `package.json` `version`. A test
enforces this, and so does the publish workflow. Bump both in the release
commit together with the other version strings.

Pushing the tag `vX.Y.Z` runs `.github/workflows/python-publish.yml`. It checks
that the versions agree, runs the full build and test matrix, and then
publishes to PyPI with trusted publishing (OIDC, no stored token). Running the
workflow manually is a dry run: it runs the checks and the build/test matrix
but uploads nothing.

One-time setup before the first release:

1. On PyPI, add a pending trusted publisher: project `openflume`, owner
   `OpenFLUME`, repository `OpenFLUME`, workflow `python-publish.yml`,
   environment `pypi`.
2. In the GitHub repository settings, create the environment `pypi`. Adding
   required reviewers gates every upload on a manual approval.
