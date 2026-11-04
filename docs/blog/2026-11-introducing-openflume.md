---
title: Introducing OpenFLUME
description: An open-source thermo-fluid network solver that runs in your browser, why I wanted one for over a decade, and how to check whether it's right.
date: 2026-11-10
author: John Rising
---

# Introducing OpenFLUME

_John Rising · 2026-11-10_

Over ten years ago at Virgin Galactic, I needed to model a fluid network, and I ended up writing my own basic solver to do it.

Later, at Relativity Space, we needed one again. So I hired the engineer who had written the same kind of solver for SpaceX, and he wrote one for us. Eight years later, he's still maintaining it.

That's not unusual. It's what most teams in this field end up doing. The established tools for this kind of problem are NASA's GFSSP and C&R's SINDA/FLUINT, and both are good codes with a lot of heritage. But you have to request or license them and install them, and neither lets you read the implementation behind a result. And sooner or later you need to extend it anyway. The systems people actually work on are hard and complicated, and each one comes with its own special considerations and its own questions you need to ask. So organization after organization, and project after project, writes its own application-specific network code, validates it a little, and maintains it for years.

This is a solved problem that keeps getting solved again, privately, at great expense. It shouldn't be. So here's an open one.

**[OpenFLUME](https://openflume.github.io/OpenFLUME/)** (Open FLUid Model Environment) is a finite-volume thermo-fluid network solver you can run in a web app in your browser or as a Python package. It's MIT-licensed. It's also alpha software, at version 0.3.1, so treat it that way.

## The solver I kept not finishing

I knew, more-or-less, how I wanted to build and test it. That was never the hard part.

The hard part was the sheer amount of it. Nodes that store mass and energy and branches that carry flow are the easy part. Real-fluid properties, solid walls that conduct and radiate, transients that don't fall over, and then a verification record a stranger could actually rerun and believe? That's years. I would chip away at a rough draft every so often, get a little further, and run out of steam again.

This year, with a lot of AI help, I finally got to the end of it. That deserves its own post, so I'll leave it there for now.

## No install, and your model stays on your machine

I wanted something an engineer could open on a locked-down corporate laptop without filing a ticket with IT.

So the whole app is static files. The solver runs in your browser tab, and real-fluid properties come from CoolProp, compiled to WebAssembly and shipped with the app. Nothing you build gets uploaded anywhere.[¹](#notes)

Sharing works the same way, which I'm kind of delighted by. The **Share** button copies a link with your whole model compressed into the part of the URL after the `#`, and browsers never send that part to a server. The link is the model. Drop it in a forum answer or a bug report and whoever clicks it is running your network a few seconds later.

## What it does

If you've used GFSSP or SINDA/FLUINT, the basic idea will feel familiar. You draw nodes and branches, and it solves coupled mass, momentum, and energy, with Newton–Raphson for steady problems and backward Euler for transients. The [user manual](../user-manual.md) covers all of it in more detail than anyone wants, but here's the gist.

- 19 branch types, from plain pipes and orifices up to cavitating venturis, regulators, and capillary channels
- Real fluids from CoolProp's 124-fluid catalog, plus ideal-gas and incompressible models
- Conjugate heat transfer with solid walls
- Transient two-phase flow with film boiling, for chilldown
- Opt-in compressible duct flow, including Fanno and Rayleigh choking and nozzles
- Combustion chambers coupled to NASA CEA tables
- Custom components, schedules, logic rules, and PID controllers, so you can model a system the way it's actually operated
- A Python package (`pip install openflume`) that drives the same solver

Honestly, the fastest way to get a feel for it is to open an example and poke at it. [Tank blowdown](https://openflume.github.io/OpenFLUME/#example=tank-blowdown) is the simplest transient. If you want something harder, [Cryogenic line cooldown](https://openflume.github.io/OpenFLUME/#example=cryogenic-line-cooldown) chills a 61 m copper line with liquid hydrogen. There are 14 in the [examples gallery](../examples.md).

## Don't trust it. Check it.

A solver nobody can check is just a plot generator.

So every verification case is labeled by what it actually proves ([§8.1](../user-manual.md#_8-1-approach)). Comparing against a closed-form solution tells you whether the math is implemented right. Comparing against published GFSSP or SINDA/FLUINT results tells you OpenFLUME agrees with those codes, assumptions and all. Only comparing against measured data tells you anything about real hardware. Those are very different claims, and I didn't want them blurred together.

The reports are generated by scripts that run the current solver, so nobody can type a nicer number into them. The [compressible-flow report](../validation/compressible-report.md), for example, recreates NASA's GFSSP TFAWS-2007 verification study case for case, and all five cases land inside that paper's own agreement band. The [microfluidics report](../validation/microfluidics-report.md) rebuilds six published networks from their papers.

The weak spot is experiment. Most of the record is analytic, and the main experimental comparison, cryogenic chilldown against NBS Report 9264 ([§8.4](../user-manual.md#_8-4-validation-against-experiment)), agrees within an engineering band. It isn't a precision prediction yet.

## What it can't do

Read the full list in [§1.7](../user-manual.md#_1-7-scope-boundaries) before you lean on a result. The big ones are below.

- No shock capture, so no over-expanded nozzles and no thrust
- No acoustic waves, so no water hammer
- Cavitation only inside the cavitating-venturi model
- Two-phase flow is homogeneous equilibrium only
- Custom components run your JavaScript with no sandbox, so treat them like code

## Try it, and tell me where it's wrong

Open [Sanity: orifice hand-calc](https://openflume.github.io/OpenFLUME/#example=sanity-orifice-hand-calc) and click **Run**. The orifice should match the hand calculation of 0.8485 kg/s to within 0.5 %. Then open [Tank blowdown](https://openflume.github.io/OpenFLUME/#example=tank-blowdown), run it, and plot the tank pressure. That's the whole onboarding. The [getting-started guide](../guides/getting-started.md) goes further.

The most useful thing you can send me is a case where OpenFLUME disagrees with a reference you trust. Tell me what the reference says and how close you expected it to be, and [open an issue](https://github.com/OpenFLUME/OpenFLUME/issues/new/choose). A published validation case that covers something the current reports don't is almost as good ([CONTRIBUTING.md](../../CONTRIBUTING.md)).

I wrote my first version of this ten years ago because nothing open existed. I'd like the next engineer in that position to just click a link.

If OpenFLUME helps your work, the citation is on Zenodo at [10.5281/zenodo.22051608](https://doi.org/10.5281/zenodo.22051608).

## Notes

1. Keeping your model on your machine doesn't settle export-control questions by itself. Those are still yours to judge.
