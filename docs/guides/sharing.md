---
title: Sharing models
description: Share OpenFLUME models as links — how the Share button works, why nothing is uploaded, link-length limits, and deep links to all 14 built-in examples.
---

# Sharing models

There are two ways to send someone an OpenFLUME model. Neither puts the model
on a server:

- a **link**, created with the toolbar **Share** button, which carries the
  whole model inside the URL;
- the **`.fn` file**, created with **Save**, which is plain text you can
  attach, commit, or diff.

For any built-in example there is also a third, much shorter option: an
**example link** (`#example=<slug>`).

## The Share button

**Share** in the toolbar copies a link to your clipboard, and the button
briefly reads **Link copied**. Its tooltip sums up how it works: _the model is
encoded in the link itself — nothing is uploaded_. If the browser won't allow
clipboard access, a dialog shows the link so you can copy it by hand.

The link contains the same content **Save** writes to a `.fn` file: the base
network plus every simulation variant, with any user components the model
references embedded in it. It does **not** contain run results. Results live
in the `.runs.json` sidecar (manual §6.12), so the recipient runs the model
themselves.

## Link format

Implemented in [`src/ui/shareLink.ts`](../../src/ui/shareLink.ts):

```
https://openflume.github.io/OpenFLUME/#example=<slug>    built-in example
https://openflume.github.io/OpenFLUME/#model=<payload>   inline model
```

`<payload>` is the model's `.fn` text, compressed with `deflate-raw` and
encoded as base64url. Decoding a payload gives back exactly that text, so
nothing in it is opaque.

### Privacy: the fragment stays in the browser

Everything after `#` is the URL **fragment**. Browsers do not send the
fragment to the server, so the host serving the page (GitHub Pages) only sees
a request for the bare app URL. The link _is_ the model, not a pointer to an
upload. This keeps the property that holds everywhere else in OpenFLUME: your
model never leaves your machine unless you send it to someone.

What you do with the link afterwards is a separate matter. If you paste it
into a chat app, forum, or issue tracker, that service stores the full URL,
model included. Treat a model link as you would the `.fn` file itself.

### What happens when someone opens a link

- The app reads the fragment once at startup and then removes it from the
  address bar. A reload or a later edit can't re-apply it over the
  recipient's work.
- If the recipient's browser already has a model open, the app asks before
  replacing it (**Open shared model** or **Open shared example**).
- The model goes through the **same checks as Load**: parsing, validation, and
  the embedded-code trust prompt. If the model embeds JavaScript user
  components that differ from the recipient's local copies, or that they don't
  have, and they haven't trusted that code before, the app shows **Trust embedded component code?** and loads nothing
  until they accept. User code is trusted, not sandboxed (manual §1.7;
  [usercode.md](../usercode.md)). Only accept code from a source you trust.
- A truncated or damaged link fails safely, with the message _"The shared link
  is damaged or incomplete … Ask the sender to copy it again."_ An unknown
  example slug produces an error and leaves the current model untouched.

## Link length

If a link is longer than **8000 characters** (`SHARE_URL_SOFT_LIMIT`), Share
still copies it, then shows a **Long share link** notice. The notice explains
that some chat apps and forums truncate long links, and suggests sharing the
saved `.fn` file instead for large models. Browsers themselves handle much
longer fragments.

To give a sense of scale, here are approximate link lengths for the shipped
examples, estimated by compressing each example's `.fn` text. Exact lengths
vary slightly with the compressor:

| Model size                                                                                                                                             | Approximate link length              |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------ |
| Small (orifice, tank blowdown, three-pipe junction)                                                                                                    | under 1 000 characters               |
| Medium (water network, heated pipe, capillary circuit, cryo tank vent control, entrapped air, cryogenic line cooldown, counterflow HX, radiator panel) | about 1 000–4 000                    |
| LH2 tank no-vent fill                                                                                                                                  | about 9 000 (over the warning limit) |
| LOX/RP-1 thruster (steady or transient startup)                                                                                                        | about 23 000–25 000                  |

Guidance:

- **Under about 8000 characters:** a link works well almost anywhere.
- **Over the limit:** attach or link the `.fn` file instead. You can put it in
  a gist or a repository, or attach it to a GitHub issue. For a built-in
  example you haven't changed, the `#example=` link is shorter.
- **Large changes to a big example:** share the `.fn` file and say which
  example it started from.

## Example deep links

Each of these opens a built-in example, ready to **Run**. The slugs are
derived from the example names by `exampleSlug()`, and these are the only
valid ones.

| Example                                            | Group                | Link                                                                                                                                                           |
| -------------------------------------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sanity: orifice hand-calc                          | Verify-by-inspection | [`#example=sanity-orifice-hand-calc`](https://openflume.github.io/OpenFLUME/#example=sanity-orifice-hand-calc)                                                 |
| Three-pipe junction                                | Applications         | [`#example=three-pipe-junction`](https://openflume.github.io/OpenFLUME/#example=three-pipe-junction)                                                           |
| Tank blowdown                                      | Applications         | [`#example=tank-blowdown`](https://openflume.github.io/OpenFLUME/#example=tank-blowdown)                                                                       |
| Water distribution network                         | Applications         | [`#example=water-distribution-network`](https://openflume.github.io/OpenFLUME/#example=water-distribution-network)                                             |
| Heated pipe with radiating wall (conjugate HT)     | Applications         | [`#example=heated-pipe-with-radiating-wall-conjugate-ht`](https://openflume.github.io/OpenFLUME/#example=heated-pipe-with-radiating-wall-conjugate-ht)         |
| Spacecraft radiator panel (ammonia loop heat pipe) | Applications         | [`#example=spacecraft-radiator-panel-ammonia-loop-heat-pipe`](https://openflume.github.io/OpenFLUME/#example=spacecraft-radiator-panel-ammonia-loop-heat-pipe) |
| LOX/RP-1 thruster (combustor)                      | Applications         | [`#example=lox-rp-1-thruster-combustor`](https://openflume.github.io/OpenFLUME/#example=lox-rp-1-thruster-combustor)                                           |
| LOX/RP-1 thruster (transient startup)              | Applications         | [`#example=lox-rp-1-thruster-transient-startup`](https://openflume.github.io/OpenFLUME/#example=lox-rp-1-thruster-transient-startup)                           |
| Capillary circuit (stop + trigger valve)           | Applications         | [`#example=capillary-circuit-stop-plus-trigger-valve`](https://openflume.github.io/OpenFLUME/#example=capillary-circuit-stop-plus-trigger-valve)               |
| Water-water counterflow heat exchanger             | Benchmarks           | [`#example=water-water-counterflow-heat-exchanger`](https://openflume.github.io/OpenFLUME/#example=water-water-counterflow-heat-exchanger)                     |
| Entrapped-air line                                 | Benchmarks           | [`#example=entrapped-air-line`](https://openflume.github.io/OpenFLUME/#example=entrapped-air-line)                                                             |
| Cryogenic line cooldown                            | Benchmarks           | [`#example=cryogenic-line-cooldown`](https://openflume.github.io/OpenFLUME/#example=cryogenic-line-cooldown)                                                   |
| Extension: Cryo tank vent control (transient)      | Extensibility        | [`#example=extension-cryo-tank-vent-control-transient`](https://openflume.github.io/OpenFLUME/#example=extension-cryo-tank-vent-control-transient)             |
| LH2 tank no-vent fill                              | Extensibility        | [`#example=lh2-tank-no-vent-fill`](https://openflume.github.io/OpenFLUME/#example=lh2-tank-no-vent-fill)                                                       |

The [examples gallery](../examples.md) describes each one.

## Where links are useful

**Course pages and assignments.** Link a starting model next to the problem
statement. Students open it in the browser with nothing to install. For an
assignment that starts from an example ("open the three-pipe junction and
halve the diameter of Pipe 3…"), use the `#example=` link. For a model you
built yourself, use **Share**, or host the `.fn` file if the link is long.

**Forum and Q&A answers.** A model link lets the reader reproduce your answer
exactly instead of rebuilding it from a description. Say what the reader
should click (for example, "Run, then select the orifice branch") and what
result to expect.

**Bug reports.** A link or `.fn` file that reproduces the problem is the most
useful thing you can attach to an
[issue](https://github.com/OpenFLUME/OpenFLUME/issues). Include:

- the model link, or the `.fn` file if the link is over the limit;
- what you expected, with its reference and tolerance where you have one;
- what you got: the status pill text, the value, and the version (0.3.1 at
  the time of writing);
- for convergence problems, the solver diary export from the **Results** tab,
  which carries the config hash.

Remove anything you can't share publicly before posting. The link contains
the whole model, including labels and notes.
