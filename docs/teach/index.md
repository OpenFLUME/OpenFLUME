---
title: Teaching with OpenFLUME
description: An educator kit for OpenFLUME — four browser-based labs on pipe networks, tank blowdown, conduction, and Fanno flow, with hand calculations and answer keys.
---

# Teaching with OpenFLUME

OpenFLUME is a finite-volume thermo-fluid network solver that runs entirely in
the browser. In each of the four labs below, students predict a result by
hand, build or open the matching model, run it, and explain the difference.
Each lab ends with an answer key you can strip out before handing it to
students.

OpenFLUME is alpha software (version 0.3.1), written by one engineer with heavy
AI assistance (see "How This Was Built" in the README). The labs follow the
project's motto, _check it rather than trust it_: the hand calculation comes
first, and the solver result is something to verify.

## Classroom features

- **No install.** Students open
  [openflume.github.io/OpenFLUME](https://openflume.github.io/OpenFLUME/) in a
  current Chromium-, Firefox-, or WebKit-based browser (user manual §2.1),
  including on school-managed laptops and Chromebooks.
- **No license server.** There are no seat counts and nothing expires at the
  end of the semester. The software is MIT-licensed.
- **Nothing is uploaded.** The solver runs in a Web Worker on the student's
  machine. Models autosave to browser storage and are saved as `.fn` files on
  the student's disk.
- **Inspectable.** **Text view** shows the entire model as plain text, the
  same text as a `.fn` file. Students can see every number the solver uses,
  and you can see every number a student changed.
- **Verified against references.** The labs reuse cases from the
  [validation reports](../validation/incompressible-hydraulics-report.md),
  where each case is compared against closed-form or independent reference
  solutions.

### Limits to tell students about

OpenFLUME is a lumped network code, not a CFD code. The limitations relevant
to these labs:

- There is no shock capture. Lab 4 shows the effect at a choked duct exit.
- Wave propagation is not modelled. Water hammer and acoustic waves are
  outside the model; fluid inertia is lumped per branch.
- Turbomachinery is represented by a pump curve only.
- Unlike streams mix only at reacting junctions. There is no general junction
  mixing.
- Two-phase flow uses the homogeneous equilibrium model (HEM) only. There
  is no separated-flow (Lockhart–Martinelli) correlation yet.
- Cavitation is modelled only at venturi closure.
- A steady closed ideal-gas loop needs a pressure anchor.
- User-authored code is trusted, not sandboxed. Loading a file with embedded
  code triggers a trust prompt. Tell students to accept code only from you.

The complete list is in user manual §1.7.

## Suggested courses

| Course                         | Where OpenFLUME fits                                                                      | Labs and examples                                                                                                             |
| ------------------------------ | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Undergraduate fluid mechanics  | Darcy–Weisbach, series/parallel pipes, loop networks, pump operating points               | Lab 1; **Three-pipe junction**, **Water distribution network**                                                                |
| Heat transfer                  | Thermal resistance networks, radiation, lumped capacitance, fins, conjugate heat transfer | Lab 3; **Heated pipe with radiating wall (conjugate HT)**, **Water-water counterflow heat exchanger**                         |
| Thermodynamics                 | Open-system energy balances, adiabatic and isothermal blowdown, fill heating              | Lab 2; **Tank blowdown**                                                                                                      |
| Compressible flow / propulsion | Choked orifices, Fanno flow, feed systems                                                 | Labs 2 and 4; **LOX/RP-1 thruster (combustor)** for a capstone look                                                           |
| Spacecraft thermal             | Radiation to deep space, conductor networks, loop heat pipes                              | Lab 3; **Spacecraft radiator panel (ammonia loop heat pipe)**                                                                 |
| Microfluidics                  | Capillary-driven filling, stop and trigger valves                                         | **Capillary circuit (stop + trigger valve)** and the [microfluidics validation report](../validation/microfluidics-report.md) |

The examples are in the toolbar **Examples ▾** menu. Each also has a direct
link of the form `https://openflume.github.io/OpenFLUME/#example=<slug>`,
which the labs use.

## The labs

| Lab                               | Topic                           | Learning objectives                                                                                                                                                                                                               | Time                      |
| --------------------------------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| [Lab 1](./lab-1-pipe-networks.md) | Pipe networks                   | Apply Darcy–Weisbach with an explicit friction factor; solve series, branching, and parallel pipe problems; run a Hardy-Cross loop correction on a multi-loop network; read a hydraulic grade line                                | 60 min pre-lab, 2 h lab   |
| [Lab 2](./lab-2-tank-blowdown.md) | Tank blowdown                   | Derive the choked adiabatic blowdown solution; explain expansion cooling with an open-system energy balance; show first-order time-step convergence; compare adiabatic and isothermal blowdown                                    | 45 min pre-lab, 1.5 h lab |
| [Lab 3](./lab-3-conduction.md)    | Conduction and thermal networks | Build solid nodes and conductors; solve a composite wall as series resistances; find a nonlinear radiation–convection equilibrium; integrate a lumped cooldown; close the energy balance of a conjugate model; discretize a fin   | 45 min pre-lab, 2 h lab   |
| [Lab 4](./lab-4-fanno-flow.md)    | Fanno flow                      | Compute a Fanno choking length from tables; set up a quasi-1-D compressible duct with the **Momentum flux** and **Kinetic energy** settings; measure grid convergence; recognize the behaviour of a network solver beyond choking | 45 min pre-lab, 1.5 h lab |

Lab 1 needs no prior OpenFLUME experience. Labs 2 to 4 assume students have
done the [Getting started](../guides/getting-started.md) page or Lab 1.

## Distributing a starting model

1. **Built-in example links.** Where a lab starts from a shipped example, the
   lab page links straight to it (for example
   `https://openflume.github.io/OpenFLUME/#example=tank-blowdown`). The link
   loads a fresh copy of the example. If the student already has a model open, the app asks before replacing it.
2. **`.fn` file.** For a model you built or edited, click **Save** to
   download it as a `.fn` text file and post it to your LMS or send it by
   email. Students open it with **Load**. Plain text works well with version
   control and diffs.

Remind students that **loading an example or a file replaces the open
model**, so they should **Save** their own work first.

## How students submit

Ask for:

1. **The model:** the `.fn` file from **Save**.
2. **The results:** when a model has been run, **Save** also writes a
   `<model>.runs.json` file containing the recorded runs (user manual §6.12).
   Students can also attach CSV files from the **Results** tab: **Export CSV**
   writes the current plot's channels and **Export all** writes every channel.
   Each chart can be exported as PNG or SVG with the run's provenance in the
   footer.
3. **The hand calculation and answers** to the lab questions, in your usual
   format.

Results are also kept in browser storage, but clearing site data deletes them.
Students should save the `.runs.json` file before closing the tab on anything
they need to hand in.

## Grading tips

- **Load the submitted `.fn` and run it yourself.** The status pill should
  read **Converged**. If it says **stale**, the student edited the model after
  the run their numbers came from.
- **Check the inputs in Text view.** Most wrong answers come from a wrong
  input, such as a diameter in millimetres entered as metres or a Darcy friction
  factor entered where the textbook value was Fanning. **Text view** and
  **Table view** show every value in SI.
- **Watch the unit preset.** The **Units ▾** menu changes what the property
  panel displays, but `.fn` files and the **Sweep** tab are always in SI.
  Having students set **Units ▾** to **SI** for these labs avoids most unit
  confusion.
- **Grade the comparison as well as the number.** The useful skill is
  explaining why a hand result and a solver result differ: a friction-factor
  guess, a time step, or grid resolution. Each answer key states the expected
  size of the difference and its cause.
- **Use the Findings.** Under each plot, the **Results** tab lists automatic
  findings such as the dominant pressure drop, reverse flow, near-sonic flow,
  and junction mass imbalance (user manual §6.8).
- **Change the numbers between terms.** The answer keys are public on this
  site. Changing one or two inputs each term (a pipe diameter, a boundary
  pressure, a heat load) keeps the method and makes copied keys useless. The
  hand-calculation procedure in each lab works for any reasonable inputs, and
  the solver gives you a new key in seconds.

## Answer keys

Each lab ends with its answer key inside a collapsible container:

```md
::: details Answer key
...
:::
```

On the published site the key stays collapsed until a reader clicks it. To make
a student handout, copy the lab's Markdown source from the repository
(`docs/teach/*.md`) and delete everything from `::: details Answer key` to the
closing `:::`. The rest of the page does not depend on the key.

Every number in a key is either computed independently from the stated inputs
(closed forms, or a separate Newton or bisection solve written for this kit)
or copied from the cited validation report. Values from OpenFLUME runs are
labelled as solver results from version 0.3.1. The last digit can change
between versions; please report differences larger than the stated tolerance
as an issue.

## License for reuse

- **Lab text:** the text of this educator kit (this page and the four lab
  pages) is released under the
  [Creative Commons Attribution 4.0 International license (CC BY 4.0)](https://creativecommons.org/licenses/by/4.0/).
  You may copy, adapt, translate, and redistribute it, including in course
  packs and commercial settings, provided you give credit. A suitable
  attribution is: "Adapted from the OpenFLUME educator kit, J. Rising,
  https://openflume.github.io/teach/, CC BY 4.0."
- **Software:** OpenFLUME itself is MIT-licensed (see `LICENSE` in the
  repository).
- **Citing the software** in a course or paper: use the Zenodo DOI
  [10.5281/zenodo.22051608](https://doi.org/10.5281/zenodo.22051608); the
  repository's `CITATION.cff` has the full record.

## Feedback

If you use OpenFLUME in a course, please post in
[GitHub Discussions](https://github.com/OpenFLUME/OpenFLUME/discussions) with
the course, the level, which labs you ran, and what went wrong. Bug reports
from lab sessions are especially useful: a confusing interface step, a wrong
answer-key number, or a model that would not converge on a student machine.
Corrections to these pages are welcome as pull requests.
