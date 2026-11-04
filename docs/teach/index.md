---
title: Teaching with OpenFLUME
description: An educator kit for OpenFLUME — four browser-based labs on pipe networks, tank blowdown, conduction, and Fanno flow, with hand calculations and answer keys.
---

# Teaching with OpenFLUME

OpenFLUME is a finite-volume thermo-fluid network solver that runs entirely in
the browser. This kit contains four labs. Each one asks students to predict a
result by hand, build or open the matching model, run it, and explain any
difference between the two. Every lab includes an answer key that you can
strip out before handing it to students.

OpenFLUME is alpha software (version 0.3.1). It was written by one engineer
with heavy AI assistance, which the README discloses under "How This Was
Built". The project's position is _check it rather than trust it_, and that is
also how these labs work: the hand calculation comes first, and the solver is
treated as something to verify rather than an oracle.

## Why it works for a course

- **No install.** Students open
  [openflume.github.io/OpenFLUME](https://openflume.github.io/OpenFLUME/) in a
  current Chromium-, Firefox-, or WebKit-based browser (user manual §2.1). That
  covers school-managed laptops and Chromebooks, where students usually cannot
  install software.
- **No license server.** Nothing has to be checked out, there are no seat
  counts, and nothing expires at the end of the semester. The software is
  MIT-licensed.
- **Nothing is uploaded.** The solver runs in a Web Worker on the student's
  own machine. Models autosave to browser storage and are saved as `.fn` files
  on the student's own disk.
- **Share links.** The toolbar **Share** button copies a link that contains
  the whole model, compressed into the URL fragment (`#model=…`). Browsers do
  not send the fragment to the server, so a share link hands out a model
  without uploading it anywhere. One link is enough to give a class a starting
  model.
- **Inspectable.** **Text view** shows the entire model as plain text, the
  same text that goes in a `.fn` file. Students can see every number the solver
  uses, and you can see every number a student changed.
- **Verified against references.** The labs reuse the cases in the
  [validation reports](../validation/incompressible-hydraulics-report.md),
  where each case is compared against closed-form or independent reference
  solutions.

### Limits to tell students about

OpenFLUME is a lumped network code, not a CFD code. The limitations that matter
for these labs:

- There is no shock capture. Lab 4 shows what that means in practice at a
  choked duct exit.
- Wave propagation is not modelled. Water hammer and acoustic waves are
  outside the model; fluid inertia is lumped per branch.
- Turbomachinery is represented by a pump curve only.
- Unlike streams mix only at reacting junctions. There is no general junction
  mixing.
- Two-phase flow uses the homogeneous equilibrium model (HEM) only. There
  is no separated-flow (Lockhart–Martinelli) correlation yet.
- Cavitation is modelled only at venturi closure.
- A steady closed ideal-gas loop needs a pressure anchor.
- User-authored code is trusted, not sandboxed. A share link or file that
  contains embedded code triggers the same trust prompt as loading a file.
  Tell students to accept code only from you.

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
link of the form `https://openflume.github.io/OpenFLUME/#example=<slug>`; the
labs use these links.

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

There are three ways to put a model in front of a class.

1. **Built-in example links.** Where a lab starts from a shipped example, the
   lab page links straight to it (for example
   `https://openflume.github.io/OpenFLUME/#example=tank-blowdown`). Opening
   the link loads a fresh copy of the example and replaces whatever model the
   student had open.
2. **Share link.** Build or edit the model, then click **Share** in the
   toolbar. The button changes to **Link copied**. Paste the link into your
   LMS or an email. Points to know:
   - The link contains the model only, not your results. Students have to
     click **Run** themselves.
   - Above 8,000 characters, the app warns that some chat apps and forums
     truncate long links. Large models are better distributed as a `.fn`
     file.
   - Opening a link goes through the same validation and embedded-code trust
     prompt as loading a file.
   - The link is a snapshot. If you fix the model later, you need to send a new
     link.
3. **`.fn` file.** Click **Save** to download the model as a `.fn` text file.
   Students open it with **Load**. A `.fn` file is plain text, so it works
   well with version control and diffs, and it does not depend on link
   length.

Remind students that **loading an example, a link, or a file replaces the open
model**. They should **Save** their own work first.

## How students submit

Ask for these three things:

1. **The model:** the `.fn` file from **Save**.
2. **The results:** when a model has been run, **Save** also writes a
   `<model>.runs.json` file containing the recorded runs (user manual §6.12).
   Students can also attach CSV files from the **Results** tab: **Export CSV**
   writes the current plot's channels and **Export all** writes every channel.
   Each chart can be exported as PNG or SVG with the run's provenance in the
   footer.
3. **The hand calculation and answers** to the lab questions, in whatever
   format you normally use.

Results are also kept in browser storage, but clearing site data deletes them.
Tell students to save the `.runs.json` file before they close the tab on
anything they need to hand in.

## Grading tips

- **Load the submitted `.fn` and run it yourself.** The status pill should
  read **Converged**. If it says **stale**, the student edited the model after
  the run that their numbers came from.
- **Check the inputs in Text view.** Most wrong answers come from a wrong
  input, such as a diameter in millimetres entered as metres or a Darcy friction
  factor entered where the textbook value was Fanning. **Text view** and
  **Table view** show every value in SI.
- **Watch the unit preset.** The **Units ▾** menu changes what the property
  panel displays, but `.fn` files and the **Sweep** tab are always in SI.
  Telling students to set **Units ▾** to **SI** for these labs avoids most unit
  confusion.
- **Grade the comparison, not just the number.** The useful skill is
  explaining why a hand result and a solver result differ, for example a
  friction-factor guess, a time step, or grid resolution. Each answer key
  states the expected size of the difference and its cause.
- **Use the Findings.** Under each plot, the **Results** tab lists automatic
  findings such as the dominant pressure drop, reverse flow, near-sonic flow,
  and junction mass imbalance (user manual §6.8). These help both students and
  graders.
- **Change the numbers between terms.** The answer keys are public on this
  site. Changing one or two inputs each term (a pipe diameter, a boundary
  pressure, a heat load) keeps the method the same and makes copied keys
  useless. The hand-calculation procedure in each lab works for any
  reasonable inputs, and the solver gives you a new key in seconds.

## Answer keys

Each lab ends with its answer key inside a collapsible container:

```md
::: details Answer key
...
:::
```

On the published site the key is collapsed until a reader clicks it. To make a
student handout, copy the lab's Markdown source from the repository
(`docs/teach/*.md`) and delete everything from `::: details Answer key` to the
closing `:::`. The rest of the page does not depend on the key.

Every number in a key is either computed independently from the stated inputs
(closed forms, or a separate Newton or bisection solve written for this kit)
or copied from the cited validation report. Values that come from running
OpenFLUME are labelled as solver results from version 0.3.1. Small changes in
the last digit can appear between versions; differences larger than the
stated tolerance are worth reporting as an issue.

## License for reuse

- **Lab text:** the text of this educator kit (this page and the four lab
  pages) is released under the
  [Creative Commons Attribution 4.0 International license (CC BY 4.0)](https://creativecommons.org/licenses/by/4.0/).
  You may copy, adapt, translate, and redistribute it, including in course
  packs and commercial settings, provided you give credit. A suitable
  attribution is: "Adapted from the OpenFLUME educator kit, J. Rising,
  https://openflume.github.io/OpenFLUME/docs/teach/, CC BY 4.0."
- **Software:** OpenFLUME itself is MIT-licensed (see `LICENSE` in the
  repository).
- **Citing the software** in a course or paper: use the Zenodo DOI
  [10.5281/zenodo.22051608](https://doi.org/10.5281/zenodo.22051608); the
  repository's `CITATION.cff` has the full record.

## Tell us you're using it

If you use OpenFLUME in a course, please say so in
[GitHub Discussions](https://github.com/OpenFLUME/OpenFLUME/discussions).
Even a short note helps: the course, the level, which labs you ran, and what
went wrong. Bug reports from a lab session, such as a confusing interface step,
a wrong answer-key number, or a model that would not converge on a student
machine, are especially useful. Corrections to these pages are welcome as
pull requests.
