---
title: Introducing OpenFLUME
description: An open-source thermo-fluid network solver that runs in your browser, why I wanted one for over a decade, and how to check whether it's right.
date: 2026-11-10
author: John Rising
---

# Introducing OpenFLUME

_John Rising · 2026-11-10_

Over ten years ago at Virgin Galactic, I needed to model a fluid network, and I ended up writing my own basic solver to do it.

That's not unusual. It's what most people in this field end up doing. The established tools for this kind of problem are NASA's GFSSP and C&R's SINDA/FLUINT, and both are good codes with a lot of heritage. But you have to request or license them and install them, and neither lets you read the implementation behind a result. So organization after organization, and project after project, writes its own application-specific network code, validates it a little, and maintains it forever.

I've wanted an open one ever since. Today it exists.

**[OpenFLUME](https://openflume.github.io/OpenFLUME/)** (Open FLUid Model Environment) is a finite-volume thermo-fluid network solver that runs entirely in your browser. It's MIT-licensed, it's at version 0.3.1, and it's alpha software.

## The solver I kept not finishing

I knew, more-or-less, how I wanted to build and test it. Nodes that store mass and energy, branches that carry flow, solid walls that conduct and radiate, real-fluid properties, steady and transient solves. And a verification record that a stranger could rerun and believe.

I would chip away at a rough draft every few years, but the amount of effort was simply too much for one person. The solver is maybe half the work. The other half is the evidence that it's right, and that half never got done.

This year, with a lot of AI help, it finally did. I'll write separately about what that was like, because it deserves more than a paragraph.

## No install, and your model never leaves your machine

I wanted something an engineer could open on a locked-down corporate laptop without an IT ticket, a license request, or a cloud-service review.

So the whole thing is static files. The solver runs in a Web Worker in your browser tab, and real-fluid properties come from CoolProp compiled to WebAssembly and shipped with the app. Your network is never uploaded anywhere. (Running locally keeps model data on your machine. It doesn't by itself settle export-control questions, which remain yours to judge.)

Sharing works the same way. The **Share** button copies a link with the whole model compressed into the URL fragment, which browsers never send to a server. The link _is_ the model. Paste it into a forum answer, a bug report, or a course page, and whoever clicks it is running your network a few seconds later.

## What it does

If you've used GFSSP or SINDA/FLUINT, it'll feel familiar. You draw nodes and branches and it solves the coupled mass, momentum, and energy equations, with Newton–Raphson for steady problems and backward Euler for transients. The [user manual](../user-manual.md) has everything, but the short version is this.

- 19 branch types, from pipes and orifices to cavitating venturis, regulators, dynamic check valves, and capillary channels
- Real fluids from a 124-fluid CoolProp catalog, plus ideal gas and incompressible models
- Conjugate heat transfer through conduction, convection, and radiation
- Transient two-phase flow (homogeneous equilibrium) with film boiling for chilldown
- Opt-in compressible duct flow, with Fanno and Rayleigh choking and nozzles
- CEA-coupled combustion junctions
- Custom components, schedules, logic rules, and PID controllers, so you can model a system the way it's actually operated
- `pip install openflume` to drive the same solver from Python

The fastest way to get a feel for it is to open an example. [Tank blowdown](https://openflume.github.io/OpenFLUME/#example=tank-blowdown) is a gas tank venting through an orifice. [Cryogenic line cooldown](https://openflume.github.io/OpenFLUME/#example=cryogenic-line-cooldown) chills a 61 m copper line with liquid hydrogen. [LOX/RP-1 thruster (combustor)](https://openflume.github.io/OpenFLUME/#example=lox-rp-1-thruster-combustor) couples a feed system, a combustion chamber, and a regeneratively cooled nozzle. All 14 are in the [examples gallery](../examples.md).

## Don't trust it. Check it.

A solver nobody can check is just a plot generator. So the part of OpenFLUME I care most about is the verification record.

Every case is labeled as one of three kinds of evidence ([§8.1](../user-manual.md#_8-1-approach)). Analytic verification compares against a closed form, and a disagreement means OpenFLUME is wrong. Code-to-code benchmarking compares against published GFSSP or SINDA/FLUINT results, which helps but inherits their assumptions. Validation against experiment compares against measured data, which is the one that tells you about real hardware.

The validation reports are written by scripts that run the current solver, so nobody can type a better number into them. A few results.

- The [compressible-flow report](../validation/compressible-report.md) recreates NASA's GFSSP TFAWS-2007 verification study case for case, and all five cases land within that paper's own agreement band.
- The [microfluidics report](../validation/microfluidics-report.md) rebuilds six published microfluidic networks from their papers.
- Cryogenic chilldown is compared against the measured traces in NBS Report 9264 ([§8.4](../user-manual.md#_8-4-validation-against-experiment)).

That last one is also the weakest part of the record. Most of the evidence is analytic. The experimental side is narrow, and chilldown agreement is an engineering band, not a precision prediction.

## What it can't do

Read these before you use a result in a decision. The full list is [§1.7](../user-manual.md#_1-7-scope-boundaries).

- No shock capture, so no over-expanded nozzles and no thrust
- No acoustic waves, so no water hammer
- Cavitation only in the cavitating-venturi closure
- Turbomachinery is a pump curve
- Two-phase flow is homogeneous equilibrium only
- User components run trusted JavaScript, not sandboxed code

## Try it, and tell me where it's wrong

Open [Sanity: orifice hand-calc](https://openflume.github.io/OpenFLUME/#example=sanity-orifice-hand-calc) and click **Run**. The orifice should match the hand calculation of 0.8485 kg/s to within 0.5 %. Then open [Tank blowdown](https://openflume.github.io/OpenFLUME/#example=tank-blowdown), run it, and plot the tank pressure. That's the whole onboarding. The [getting-started guide](../guides/getting-started.md) goes further.

The most useful thing you can send me is a well-documented disagreement. A case where OpenFLUME disagrees with a reference you trust, with the reference, the tolerance you expected, and the units. [Open an issue](https://github.com/OpenFLUME/OpenFLUME/issues/new/choose). The next most useful is a published validation case that exercises something the current reports don't ([CONTRIBUTING.md](../../CONTRIBUTING.md)).

I wrote my first version of this ten years ago because nothing open existed. I'd like the next engineer in that position to just click a link.

If OpenFLUME helps your work, the citation is on Zenodo at [10.5281/zenodo.22051608](https://doi.org/10.5281/zenodo.22051608).
