---
name: Bug report
about: Report a defect in the solver, UI, or companion tooling
title: ""
labels: bug
assignees: ""
---

## Before filing

Run the project gate locally and include the outcome:

```bash
npm run check
```

If `npm run check` fails, include the failing command and its output.

## Description

A clear, concise description of the bug.

## Steps to reproduce

1. Go to '...'
2. Click on '...'
3. Run with settings '...'
4. See error

If the issue involves a specific network, attach the `.fn` file (or a minimal
reduction of it) or paste the JSON config.

## Expected behavior

What you expected to happen.

## Actual behavior

What actually happened. Include exact error messages, validation output, or
solver status text.

## Numerical concerns (if applicable)

If the bug concerns a numerical result (convergence, accuracy, physical
plausibility), state:

- The reference value you expected and its source (analytical, published
  benchmark, experiment)
- The tolerance you consider acceptable
- Units and assumptions

## Environment

- OS: [e.g. macOS 15, Ubuntu 24.04]
- Browser (if UI-related): [e.g. Chrome 128, Firefox 130]
- Node version (`node --version`): [e.g. 22.9.0]
- Commit or version: [e.g. 0.1.0, or `git rev-parse HEAD`]

## Additional context

Screenshots, console logs, or anything else that helps reproduce the issue.
