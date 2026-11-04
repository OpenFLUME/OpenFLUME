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

Who talks like that? Nobody. Those are the model's notes to itself about staying on task, and it handed them to me as prose. What made it maddening was that I had dictated what I wanted to say. It had my direct phraseology right there to draw from, and it wrote this instead. Once I could articulate what I didn't like, it cut them. But it shouldn't have written them in the first place, and I know most people don't take that extra step most of the time. It's too easy to be sloppy.

I don't use AI for writing because I don't care. Ironically, it's because I do. What I write by my own hand often doesn't meet my lofty expectations and criteria, and self-censorship sometimes stops me from putting anything down at all. A model gets something down on canvas that I can edit. It also gives me permission. When neither I nor it can come up with something better, I can accept that a particular sentence or point is good enough.

Meanwhile, the solver those documents describe was written with an enormous amount of AI help, by me, alone, in about ten weeks.[¹](#notes) I had actually wanted to build an open source solver like this for a long time, since I had to write my own basic one at Virgin Galactic over ten years ago. I knew, more-or-less, how I wanted to build and test it, and would chip away at a rough draft every few years, but the amount of effort was simply too much for me to make much progress on.

So I am, at the same time, someone who builds with AI every single day and someone who closes the tab the moment a blog post starts sounding like Claude. For a while that felt like hypocrisy. It isn't, once you ask what a given piece of writing is for.

## Code is functional. Writing to you is personal.

Some writing is functional. Its value is in what it says, and nobody cares who typed it. A table of fluid properties, a proof, a diff. If it's correct, it's correct, and if a model produced it, fine. When two people are working on the same document or the same pull request, every edit is in service of making the thing better, and AI is one more tool in the pile. There the only fair question is whether the result is good.

Other writing is personal. Its value comes from the fact that a particular person thought it, felt it, and is sharing that very real experience with you. Feedback from someone who knows your work lands differently than the same advice in a book, because it came from them. When you ask someone what they think and get back something that reads like it was pasted from a chatbot, it is a small betrayal. You asked for connection and they shooed you away like a pest.

The more personal the exchange, the more AI in it cheapens it.

A thermo-fluid solver is about as functional as artifacts get. Nobody running a tank blowdown cares whether I or a model wrote the backward-Euler step. They care whether the pressure history is right.

A blog post is different. If you're reading this, you want to know what _I_ think about building an engineering tool this way, so I rewrote this post until it said what I think.[²](#notes)

Code has one big advantage over prose here. Whether it is true and useful can be measured. Unlike most functional code, though, a physics solver has to do more than converge. Its answer has to be physically plausible, and AI is not yet as good as a person at looking at a plot and seeing that something is off even when the general trend is right.

## Network codes fail by looking fine

When a web app is broken, it usually tells you. A network solver usually doesn't. A wrong sign in an energy balance, a badly scaled residual, or a convergence check that passes for the wrong reason all still produce a smooth, reasonable-looking plot. You'd use it. You'd put it in a design review.

And this is exactly the failure that AI-generated code is best at producing. Plausible, complete-looking, returns a number, says "done."

People who are excited about AI and people who are wary of it are usually both right. The excited ones are racing against time, and the wary ones are racing against entropy. The speed is real. One person building a GFSSP-class solver in ten weeks was not possible a few years ago. The entropy is real too. Every one of those ten weeks produced code I didn't type, and every line of it could be wrong in a way that still looks fine. Arguing about which side wins gets nowhere. The useful move is to turn it into an engineering question. What would it take?

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

If you're going to talk up what AI let you build, you owe people the costs in the same breath. So here they are.

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
