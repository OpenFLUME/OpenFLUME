---
title: Why a thermo-fluid solver should run in the browser
description: The architecture behind OpenFLUME (Web Worker solver, CoolProp in WebAssembly, local-first storage, URL-fragment share links, a Python package) and its trade-offs.
date: 2026-12-15
author: John Rising
---

# Why a thermo-fluid solver should run in the browser

_John Rising · 2026-12-15_

Engineering solvers are traditionally desktop programs. Some are licensed per seat, some need an installer and an administrator, and some only run on a particular operating system. A newer generation runs in the cloud: your model goes up, the results come back. OpenFLUME takes a third route. The whole solver runs inside a browser tab, on your machine, from static files.

This post explains why, how it is put together, what it costs in performance, and what it gives up. The architecture details come from [docs/architecture.md](../architecture.md). All performance numbers come from [docs/real-fluid-performance.md](../real-fluid-performance.md), which `npx tsx scripts/real-fluid-performance.ts` regenerates.

## The argument

Three properties matter to me, and the browser is the only platform I know of that delivers all three at once.

**Zero install.** A student, a reviewer, or an engineer on a locked-down laptop can follow a link and be solving a network a few seconds later. There is no license server, no administrator rights, and no account. That changes who can check your work. If I send someone a model, they can run it.

**Local-first.** Nothing about your model leaves your machine. The app is static files on GitHub Pages, the solver runs in your browser, and models are saved to local files and browser storage. For people working on proprietary designs, or in environments with strict data-handling rules, "nothing is uploaded" is an architectural fact they can verify, not a policy they have to trust. (That is a statement about where data goes. It is not a compliance determination for any regulatory regime. Whether a given model is controlled remains your call.)

**One core, many hosts.** The same TypeScript solver runs in the browser worker, in Node for the test suites, and in Python through a bundled Node runtime. There is one implementation and one verification record.

## How it is put together

### The solver lives in a Web Worker

Each browser solve runs in a dedicated module worker. The UI sends a structured clone of the model and the mode. The worker validates the model, initializes CoolProp only if the network needs it, sends throttled progress messages, and returns the result. Each solve spawns exactly one worker, and that worker is terminated whenever the solve settles (done, error, or crash) as well as on cancellation, so idle workers never pile up.

The solve loop is synchronous, which has a consequence: **Cancel terminates the worker and spawns a fresh one.** A cooperative cancel would need `SharedArrayBuffer`, and that requires cross-origin isolation headers that a static host does not give you by default. Terminate-and-respawn is blunt, but it always works, and a cancelled transient keeps its partial trajectory, labeled as partial.

The worker boundary is there to keep the UI responsive. **It is not a security boundary.** User-authored components run as trusted JavaScript through `new Function`. As defense in depth, the worker strips network-capable globals (`fetch`, `XMLHttpRequest`, `WebSocket`, `indexedDB`, `caches`, and others) before any solve. Still, treat a model file that contains code like source code.

### CoolProp, compiled to WebAssembly

Real-fluid properties come from `coolprop-wasm`. It was chosen because it is MIT-licensed, covers the cryogenic and propulsion fluids I needed, exposes saturation and analytic-derivative APIs, and runs in both Node tests and browser workers. It is lazy-loaded only for models that use a real fluid, and only inside the worker. A water-distribution model with an incompressible fluid never downloads it.

### Local-first persistence

Models save as `.fn` files: a line-oriented, lossless text format that diffs cleanly in version control. The browser autosaves your current model. Run results are mirrored into browser storage so that a reload resumes the session, and **Save** also writes a portable `<model>.runs.json` sidecar holding each run's config snapshot, result, and solver diary.

### Share links that never touch a server

The toolbar's **Share** button copies a link with the entire model inside the URL fragment: `#model=` followed by the `.fn` text, deflate-compressed and base64url-encoded (`src/ui/shareLink.ts`). Browsers do not send the fragment to the server, so the host only ever sees a request for the bare page. As the source puts it, "a link is the model, not a pointer to an upload." Any components the model references are embedded in the shared copy.

Opening a link never bypasses the guards. The decoded text goes through the same parse, validate, and embedded-code trust prompt as opening a file with **Load**. Built-in examples use the same mechanism with a short slug, for example [`#example=tank-blowdown`](https://openflume.github.io/OpenFLUME/#example=tank-blowdown).

There is a practical limit. Very large models make very long URLs, and chat apps and email clients truncate long links. Above about 8,000 characters the app still makes the link but warns you. For big models, send the `.fn` file.

### The Python package bundles the same core

`pip install openflume` does not reimplement the solver ([docs/python.md](../python.md)). The package bundles the core, the `.fn` parser, and the examples into one JavaScript file alongside `coolprop.wasm`, and runs them in a Node.js runtime delivered as a pip dependency. Python talks to it over newline-delimited JSON on stdin and stdout. Results match the TypeScript library exactly, and the browser to floating-point rounding, since JavaScript engines may differ in the last bit of `Math.*` functions. Every verification result applies unchanged.

## What it costs: performance

The obvious objection: surely a JavaScript solver calling a WebAssembly property library is slow? The profile in `real-fluid-performance.md` measures four real-fluid solves on one machine:

| Case                                 | Hybrid wall time | Share in property evaluation |
| ------------------------------------ | ---------------- | ---------------------------- |
| LN₂ two-phase chilldown (first 75 s) | 167 ms           | 18.3 %                       |
| LN₂ chilldown, full 300 s horizon    | 1.34 s           | 74.9 %                       |
| N₂O cavitating venturi               | 30 ms            | 12.2 %                       |
| N₂ transonic C-D nozzle              | 40 ms            | 7.0 %                        |

The document gives its own caveat: identical solves have been observed to differ by up to about 1.7× across machines and loads, so treat absolute wall times as indicative. Property-call counts repeat exactly.

Three findings shaped the design.

**The analytic Jacobian matters more than the language.** The default `hybrid` Jacobian builds real-fluid derivatives analytically: one state evaluation and one derivative evaluation per node per build, instead of a full residual sweep per column. Against finite differences, it makes **2.75×–70.63× fewer property calls** on these cases and converges to the same trajectories. The wall-clock speedup was 1.53×–6.78× on that machine, which is load-dependent.

**Use CoolProp's cached-state interface, not `PropsSI`.** A full `PropsSI` round trip costs 9.29× more than a flash on a cached `AbstractState`. Hot paths use the cached interface, behind a bounded 8,192-entry cache keyed on `(fluid, P, h)`.

**Do not port the solver to make it fast.** This is the conclusion I find most interesting. Absolute wall times are 30 ms–1.34 s on these cases. On long horizons, the dominant cost is still first-visit CoolProp flashes, which a port to a compiled language would not touch. The remaining solver-side time is spread across residual assembly, state cloning, and bookkeeping, with no single hotspot that compiled code would fix. Dense Gaussian elimination is only 0.4 %–4.3 % of wall time. Even a faster property backend has a hybrid-path ceiling of 1.08×–3.98× on these cases. And a port "would forfeit the browser-worker deployment." The document's recommendation: revisit only with a profile of a real workload that is still too slow.

There is one fixed cost you will notice. The first CoolProp call in a fresh process pays the WebAssembly compile, measured at 1.67 s in that report, and the report notes that short transients feel it as a fixed per-solve overhead.

## The trade-offs

I don't think the browser is free, and I'd rather list the costs than have someone find them.

- **No cooperative cancellation.** Cancel kills the worker, as described above. That is fine for a UI and awkward for some embedding hosts. The Python package has the same property: Ctrl-C kills the Node process, and the session restarts on its next call.
- **Single-threaded solves.** One solve runs on one worker. Parameter sweeps run their variants sequentially, one worker each, so a real-fluid sweep reloads CoolProp per variant. The architecture notes a warm-worker pool as a future optimization, not a current feature. In Python, parallelism means one session per process.
- **Session-scoped exploration.** Sweeps are session-only by design, and promoting a sweep point to a saved variant is how a result survives the session.
- **Trusted user code.** Embedded components are not sandboxed. The worker hardening reduces accidental risk, but it does not make hostile code safe.
- **Browser storage is not a backup.** Autosave and the results mirror live in your browser profile. Save the `.fn` file and its sidecar if the work matters.
- **Last-bit differences.** Browser and Node results agree to floating-point rounding, not bit for bit.

None of these touch the physics scope, which has its own, more important limits ([§1.7 Scope Boundaries](../user-manual.md#_1-7-scope-boundaries)): no shock capture, no acoustic wave propagation, HEM-only two-phase flow, cavitation only at the venturi closure, a pump curve for turbomachinery, and no general junction mixing.

## Why it is worth it

The payoff is that the distance between "I wonder if this is right" and "let me check" becomes one click. Here is a converged hand-calculation: [Sanity: orifice hand-calc](https://openflume.github.io/OpenFLUME/#example=sanity-orifice-hand-calc). Here is a transient: [Tank blowdown](https://openflume.github.io/OpenFLUME/#example=tank-blowdown). Here is a two-phase cryogenic chilldown with temperature-dependent copper and film boiling: [Cryogenic line cooldown](https://openflume.github.io/OpenFLUME/#example=cryogenic-line-cooldown). Nothing to install, and nothing uploaded.

For a code whose whole premise is "check it rather than trust it," making checking cheap is the point.
