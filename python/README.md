# openflume (Python)

Python API for [OpenFLUME](https://github.com/OpenFLUME/OpenFLUME), an open-source
thermal-fluid network solver for steady and transient analysis of propulsion feed
systems, cryogenic lines, and tank pressurization, with real-fluid properties from
CoolProp.

```bash
pip install openflume            # add [numpy,pandas] for array/DataFrame output
```

No other installation is needed. The solver core is the same TypeScript code as the
web app, bundled into the package and run on a Node.js runtime that pip installs as
a dependency (`nodejs-wheel-binaries`). It is the same solver, with the same
verification record, not a port.

## Quick start

```python
import openflume as of

net = of.load("feed_system.fn")  # .fn from the web app, or .json
print(net.validate())  # [] means runnable

result = net.solve()  # steady or transient per settings.mode
print(result.converged, result.node("tank")["pressure"])  # SI units: Pa
```

Start from a bundled example and edit the model as a plain dict:

```python
net = of.example("Tank blowdown")
net.settings["endTime"] = 2.0
net.branch("orifice")["component"]["cd"] = 0.65

tr = net.solve(progress=lambda p: print(f"t = {p['time']:.3f} s", end="\r"))
t, p = tr.times, tr.series("tank", "pressure")  # numpy arrays if numpy is installed
df = tr.frame()  # pandas: index time, columns (id, quantity)
```

Parameter sweeps are ordinary Python:

```python
base = of.example("Sanity: orifice hand-calc")
for cd in (0.55, 0.60, 0.65):
    net = base.copy()
    net.branch("o")["component"]["cd"] = cd
    print(cd, net.solve().branch("o")["mdot"])
```

Fluid properties use the same EOS models as the solver:

```python
lox = of.Fluid.real("Oxygen")
lox.density(2e6, 95.0)  # kg/m³
lox.saturation_temperature([1e5, 5e5, 1e6])
of.fluids(curated=True)  # CoolProp HEOS catalogue
of.combustion_gas("lox-rp1", pc=7e6, of=2.6)  # NASA CEA equilibrium tables
```

Command line:

```bash
openflume validate model.fn
openflume solve model.fn -o result.json
openflume info
```

## Notes

- **Units** are SI throughout: Pa, K, kg/s, m, m², J/kg.
- **Always check `result.converged`.** The solver returns its best state either way.
- **Model format.** `Network.config` is the `NetworkConfig` dict (schema v2) defined in
  `src/core/schema.ts` and documented in the user manual. `.fn` files round-trip
  losslessly with the web app.
- **User code.** Models can embed JavaScript user components (`componentLibrary`). That
  code runs in the Node process with your user's privileges, so only solve models you
  trust.
- **Runtime.** One Node process per `Session` is started on first use and stopped at
  exit. Set `OPENFLUME_NODE` to use a specific Node.js 22+ executable. For parallel
  sweeps, use one process (and therefore one session) per worker, e.g. with
  `concurrent.futures.ProcessPoolExecutor`. Ctrl-C interrupts a running solve.

Full documentation: [docs/python.md](https://github.com/OpenFLUME/OpenFLUME/blob/main/docs/python.md).
License: MIT.
