---
title: I let AI write my solver. I won't let it write to you.
description: OpenFLUME was built by one engineer and a lot of AI. Why that works for code that can be checked, and what checking it actually caught.
date: 2026-11-24
author: John Rising
# Publish after John's own edit pass: the closing section and note 2 say he rewrote it.
draft: true
---

# I let AI write my solver. I won't let it write to you.

_John Rising · 2026-11-24_

Earlier this month I was getting OpenFLUME ready to launch, and I had an AI agent help me draft the docs, the blog, and a preprint. It was fast. It was also full of sentences like "Here is my honest one-paragraph version" and "Convergence is reported rather than assumed."

Who talks like that? Nobody. Those are the model's notes to itself about staying on task, and it handed them to me as prose. I spent a good chunk of the week deleting them.

Meanwhile, the solver those documents describe was written with an enormous amount of AI help, by me, alone, in about ten weeks.[¹](#notes) Six releases between the first commit on August 20 and v0.3.1 on November 3. Nineteen branch component types, real fluids, two-phase flow, conjugate heat transfer, combustion junctions, microfluidics.

So I am, at the same time, someone who builds with AI every single day and someone who closes the tab the moment a blog post starts sounding like Claude. Charity Majors wrote about having [exactly this contradiction](https://charity.wtf/p/confessions-of-an-unrepentant-slop), and reading it was a little eerie. Her resolution is the one I landed on too.

## Code is functional. Writing to you is personal.

Charity splits communication into two kinds. Some of it is functional, where the value is in the idea and nobody cares who typed it. Some of it is personal, where the value is that a specific human thought it. Her line about code is the one that stuck with me. Lines of code "are indifferent to their origin, and can be validated by harnesses and tests."

A thermo-fluid solver is about as functional as artifacts get. Nobody running a tank blowdown cares whether I or a model wrote the backward-Euler step. They care whether the pressure history is right.

A blog post is different. If you're reading this, you want to know what _I_ think about building an engineering tool this way, so I rewrote this post until it said what I think.[²](#notes)

The catch is that "it can be validated by tests" only helps if the tests exist and are good. For a physics code that's a much bigger ask than it sounds.

## Network codes fail by looking fine

When a web app is broken, it usually tells you. A network solver usually doesn't. A wrong sign in an energy balance, a badly scaled residual, or a convergence check that passes for the wrong reason all still produce a smooth, reasonable-looking plot. You'd use it. You'd put it in a design review.

And this is exactly the failure that AI-generated code is best at producing. Plausible, complete-looking, returns a number, says "done."

Charity has a [second piece](https://charity.wtf/p/ai-enthusiasts-are-in-a-race-against) about enthusiasts racing against time and skeptics racing against entropy. Both sides are right. The speed is real. One person building a GFSSP-class solver in ten weeks was not possible a few years ago. The entropy is real too. Every one of those ten weeks produced code I didn't type, and every line of it could be wrong in a way that still looks fine. Her move is to stop arguing about it and ask an engineering question instead. What would it take?

For me the question was this. **What would it take for someone else to trust a solver that one person built with a lot of AI help?**

## What it took

My answer was evidence that a reader can rerun, sorted by what it actually proves.

Every verification case in OpenFLUME is labeled as one of three things ([user manual §8.1](../user-manual.md#_8-1-approach)).

1. **Analytic verification.** Compared against a closed form or an independently integrated solution, like Hagen–Poiseuille, the Fanno relations, or an RK4 reference for a tank blowdown. If it disagrees, OpenFLUME is wrong.
2. **Code-to-code benchmarking.** Compared against published GFSSP or SINDA/FLUINT results. Agreement helps, but it inherits the other code's assumptions, and two codes can be wrong together.
3. **Validation against experiment.** Compared against digitized test data. A disagreement could come from the model, the correlation, the grid, or the experiment.

"Agrees with GFSSP within 5 %" and "agrees with experiment within 5 %" are wildly different claims, and the easiest way to make a verification record look better than it is would be to blur them. So even the GFSSP compressible-flow recreation is filed under _analytic_ verification, because every number in it is graded against an RK4 reference and never against GFSSP output.

The reports themselves are written by scripts. Each script in `scripts/` builds its cases, runs the current solver, and writes the tables and figures in `docs/validation/`. A model will happily write "agrees within 1 %." A script can only print what the solver returned. If the solver changes, the report changes, and the regression is sitting right there in the diff.

Some of the checks you can do yourself in one click. The first example in the menu, [Sanity: orifice hand-calc](https://openflume.github.io/OpenFLUME/#example=sanity-orifice-hand-calc), is two boundaries and an orifice with the expected answer, 0.8485 kg/s, written on the canvas. Click **Run** and compare.

Then there's CI. Every pull request runs the fast tests, every test file at reduced cost, the full browser suite in four shards, and the Python wheel on Linux, macOS, and Windows. The slow scientific suite (full chilldown baselines, venturi sweeps, two-phase staircases) runs on every push to `main` and every Monday. The demo site only deploys after a green run, so a broken solver can't reach the app you're using ([CONTRIBUTING.md](../../CONTRIBUTING.md), [testing tiers](../testing-slow.md)).

## It caught real bugs, and they all looked like success

This is the part that convinced me it wasn't ceremony. Go through the [CHANGELOG](../../CHANGELOG.md) and look at the serious defects. Almost every one of them is something reporting success when it hadn't succeeded.

- **Microfluidic transients froze and called it convergence** (0.3.0). The Newton stopping test compared an absolute tolerance against mass residuals in kg/s. At microfluidic flows, around 1e-8 kg/s, every imbalance already passed, so steps were accepted at their starting guess. A rebuilt published case caught it, a bubble-damped syringe network from Lee et al. (2012), checked against its exact ODE. The error was 37 % at the default tolerance. After the fix it was under 1e-3 ([microfluidics report](../validation/microfluidics-report.md), case B6).
- **Transient steps were certified as converged unconditionally** (0.2.2). For several fluid models, a step got labeled `converged` without checking whether Newton had actually met its residual bar. That hid a real failure in the **Entrapped-air line** example, where a starting guess behind a closed valve was being treated as an initial condition.
- **A fabricated property state could reach an accepted result** (0.2.2). A last-resort fallback (`T = 300 K, ρ = 100 kg/m³`) that existed only to dodge a WebAssembly crash could flow straight through into results. Steady solves now report `converged: false` and count the fallbacks.
- **A fabricated critical point was cached for the life of the process** (0.2.0). A failed CoolProp read stored `Pc = 1e7 Pa, Tc = 300 K` and quietly misrouted every phase-region decision after it. Now it throws.
- **A failed chemistry sub-step was swallowed** (0.2.2), leaving the node at its pre-reaction state inside a step marked converged.

And one from this month. While building a teaching lab, a 20-segment Fanno duct solved with the central momentum scheme reported "Converged" on a nonphysical answer, Mach 0.70 jumping to 1.40 halfway down a constant-area pipe. The second-law audit that's supposed to catch exactly that stayed silent, because it was treating every node of a constant-area duct as a throat and applying the loose near-sonic tolerance everywhere. The audit now catches it, every relaxation setting finds the physical root, and there's a regression test. The fix ships in the next release.

None of these crashed. All of them produced a number that looked plausible. Several of the fixes took the same shape, ripping out a silent fallback and replacing it with a loud failure. That's the habit I'd recommend to anyone building with AI. Hunt down every place your code can say "fine" without checking.

## Tell the whole story

Charity's first piece of advice to enthusiasts is to tell the whole story, the wins and what they cost. So here are the costs.

Most of the record is analytic verification. The experimental side is narrow. On saturated liquid-nitrogen chilldown from NBS Report 9264, OpenFLUME's chilldown time has a mean absolute error of 12.8 %. GFSSP's published predictions for the same runs come in at 8.8 %. GFSSP is better there. The subcooled runs are worse still, so the code marks them diagnostic-only and they can't be quoted as agreement at all. The validator throws if anyone tries to drop that flag ([§8.4](../user-manual.md#_8-4-validation-against-experiment)).

Correlations get the same treatment ([§8.5](../user-manual.md#_8-5-correlation-status)). TT-WF, a chilldown closure I designed, is labeled "Research status, not validated," and I mean it. Production solver code is also forbidden by lint from importing the validation data, because a solver tuned to the experiment it's checked against hasn't been checked by that experiment.

## So, do I trust it?

I trust it exactly as far as the evidence goes, and the evidence is all public. That's the deal I'd want from anyone else's solver, and it's the one I'm offering for mine.

AI made it cheap to build a huge surface area. Nineteen components, a pile of report generators, thousands of tests. It did not make any of that correct. The checks did that, and the checks found bugs I would have shipped.

The preprint drafts had all the bugs a solver has, just in prose. They looked finished and said things nobody would say. A solver gets a test suite to catch that. Writing only gets a person who cares, which is why I went through every sentence of this one myself.

If you find a case where OpenFLUME disagrees with a reference you trust, [open an issue](https://github.com/OpenFLUME/OpenFLUME/issues/new/choose) with the reference and the tolerance. Check it rather than trust it.

## Notes

1. The full list of tools is in the [README's "How This Was Built"](https://github.com/OpenFLUME/OpenFLUME#how-this-was-built) section and the preprint's tool disclosure. Mostly Claude models in coding agents, plus Kimi and GPT models.
2. Full disclosure, I drafted this post with AI assistance too, and then rewrote it. If it still sounds like a chatbot anywhere, that part is on me, and I'd like to hear about it.
