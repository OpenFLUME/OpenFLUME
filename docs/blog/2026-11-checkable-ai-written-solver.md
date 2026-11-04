---
title: Building OpenFLUME with AI
description: I couldn't have built OpenFLUME as well without AI, and I wouldn't have let AI build it alone. What it was good at, where it needed me, and what the checks caught.
date: 2026-11-24
author: John Rising
# Publish after John's own edit pass: the personal-writing section and note 2 say he rewrote it.
draft: true
---

# Building OpenFLUME with AI

_John Rising · 2026-11-24_

Earlier this month I was getting OpenFLUME ready to launch, and I had an AI agent help me draft the docs, the blog, and a preprint. It was fast. It was also full of sentences like "Here is my honest one-paragraph version" and "Convergence is reported rather than assumed."

Who talks like that? Nobody. Those are the model's notes to itself about staying on task, and it handed them to me as prose. What made it maddening was that I had dictated what I wanted to say. It had my direct phraseology right there to draw from, and it wrote this instead. Once I could articulate what I didn't like, it cut them. But it shouldn't have written them in the first place, and I know most people don't take that extra step most of the time. It's too easy to be sloppy.

I don't use AI for writing because I don't care. Ironically, it's because I do. What I write by my own hand often doesn't meet my lofty expectations and criteria, and self-censorship sometimes stops me from putting anything down at all. A model gets something down on canvas that I can edit. It also gives me permission. When neither I nor it can come up with something better, I can accept that a particular sentence or point is good enough.

## Code is functional. Writing to you is personal.

For a long time I told myself, and anyone who asked, that it doesn't matter how something was made, it matters how good it is. I believed it. At the same time, I judge AI slop harshly, even though I use AI every day. It's like finding mold on bread. One spot of chatbot phrasing in a post or a message and the whole thing goes in the trash, and so does a good part of my respect for the person who sent it. If they couldn't be bothered to write it, why should I spend my attention reading it? That made no sense if quality was all that mattered, so one of the two had to give.

What gave was the idea that all writing is the same kind of thing.

Some writing is functional. Its value is in what it says, and nobody cares who typed it. A table of fluid properties, a proof, a diff. If it's correct, it's correct, and if a model produced it, fine. When two people are working on the same document or the same pull request, every edit is in service of making the thing better, and AI is one more tool in the pile. There the only fair question is whether the result is good.

Other writing is personal. Its value comes from the fact that a particular person thought it, felt it, and is sharing that very real experience with you. Feedback from someone who knows your work lands differently than the same advice in a book, because it came from them. When you ask someone what they think and get back something that reads like it was pasted from a chatbot, it is a betrayal. You asked for connection and they shooed you away like a pest.

The more personal the exchange, the more AI in it cheapens it.

A thermo-fluid solver is about as functional as artifacts get. Nobody running a tank blowdown cares whether I or a model wrote the backward-Euler step. They care whether the pressure history is right. A blog post is different. If you're reading this, you want to know what _I_ think about building an engineering tool this way, so I rewrote this post until it said what I think.[²](#notes)

## Why I built it with AI

I had actually wanted to build an open source solver like this for a long time, since I had to write my own basic one at Virgin Galactic over ten years ago. I knew, more-or-less, how I wanted to build and test it, and would chip away at a rough draft every few years, but the amount of effort was simply too much for me to make much progress on. With AI, I built it in about ten weeks.[¹](#notes)

I couldn't have done it as well without AI. I also wouldn't have let AI do it all.

## What AI made possible

The part of a solver that takes the most effort isn't the solver. It's the evidence that the solver is right. Every closure needs a case it can be checked against, every case needs a reference, and every reference needs someone to dig it out of a NASA report, set it up, and decide what agreement means.

That's where AI changed what one person could do. OpenFLUME has generated validation reports across incompressible hydraulics, compressible duct flow, conjugate heat transfer, fluid and tank transients, combustion, and microfluidics, plus thousands of tests that run on every pull request. It rebuilds six published microfluidic networks from their papers and compares cryogenic chilldown against the measured traces in NBS Report 9264. On my own, I'd have covered a fraction of those disciplines and checked against far less real data.

Each report is written by a script that runs the current solver, so a model can't type "agrees within 1 %" into it. The script can only print what the solver returned. Every case is also labeled as analytic verification, comparison with another code, or comparison with experiment ([user manual §8.1](../user-manual.md#_8-1-approach)), because "agrees with GFSSP" and "agrees with measurements" are very different claims.

## What it needed me for

The models were bad at judgment, and a solver is mostly judgment.

They tended to overcomplicate. Asked to fix a convergence problem or add a physical effect, they reached for more machinery, another fallback, another special case, instead of going back to first principles and asking what the conservation equations actually require. Deciding which terms belong in the energy balance, what the right closure is, when a simpler formulation is the correct one, and what counts as agreement were all calls I had to make.

They were also bad at seeing that a result was wrong. A physics solver has to do more than converge. Its answer has to be physically plausible, and AI is not yet as good as a person at looking at a plot and seeing that something is off even when the general trend is right. A wrong sign in an energy balance, a badly scaled residual, or a convergence check that passes for the wrong reason still produces a smooth, reasonable-looking plot. That is exactly the failure AI is best at producing.

## What the checks caught

Almost every serious defect in the [CHANGELOG](../../CHANGELOG.md) was something reporting success when it hadn't succeeded.

- **Microfluidic transients froze and called it convergence** (0.3.0). The stopping test compared an absolute tolerance against mass residuals in kg/s, and at flows around 1e-8 kg/s every imbalance already passed. A rebuilt published case, a bubble-damped syringe network checked against its exact ODE, showed 37 % error at the default tolerance. After the fix it was under 1e-3 ([microfluidics report](../validation/microfluidics-report.md), case B6).
- **Transient steps were certified as converged unconditionally** (0.2.2), which hid a real failure in the **Entrapped-air line** example.
- **A fabricated property state could reach an accepted result** (0.2.2). A last-resort fallback that existed only to dodge a WebAssembly crash could flow straight into results.
- **A Fanno duct reported "Converged" on a nonphysical answer** this month, with Mach jumping from 0.70 to 1.40 halfway down a constant-area pipe while the second-law audit stayed silent. The fix ships in the next release.

None of these crashed. All of them produced plausible numbers. Most of the fixes had the same shape, replacing a silent fallback with a loud failure.

The record has limits too. Most of it is analytic verification, and the experimental side is narrow. On saturated liquid-nitrogen chilldown, OpenFLUME's mean absolute error is 12.8 % against 8.8 % for GFSSP's published predictions, so GFSSP is better there ([§8.4](../user-manual.md#_8-4-validation-against-experiment)).

## Where that leaves me

AI made it cheap to build a huge surface area and to check it against far more than I could have on my own. It didn't know what to build or when the answer was wrong. Those were mine.

If you find a case where OpenFLUME disagrees with a reference you trust, [open an issue](https://github.com/OpenFLUME/OpenFLUME/issues/new/choose) with the reference and the tolerance.

## Notes

1. The full list of tools is in the [README's "How This Was Built"](https://github.com/OpenFLUME/OpenFLUME#how-this-was-built) section and the preprint's tool disclosure. Mostly Claude models in coding agents, plus Kimi and GPT models.
2. Full disclosure, I drafted this post with AI assistance too, and then rewrote it. If it still sounds like a chatbot anywhere, that part is on me, and I'd like to hear about it.
