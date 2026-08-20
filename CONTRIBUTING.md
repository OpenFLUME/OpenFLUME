# Contributing

Contributions are welcome. Before starting a large change, open an issue so the
scope, numerical evidence, and compatibility expectations can be agreed on.

## Development setup

Use Node.js 22 and npm. npm is the canonical package manager and
`package-lock.json` is the lockfile used by CI. `bun.lock` is retained for
contributors who use Bun locally, but changes to it are not required and npm
must remain reproducible with `npm ci`.

```bash
npm ci
npm run dev
```

## Before a pull request

Run the same practical gate used for normal pull requests:

```bash
npm run check
```

Run broader tiers when the change affects numerical methods, real-fluid
properties, validation, or browser workflows:

```bash
npm run test:all
npm run test:slow
npm run test:e2e
```

`test:slow` enables expensive suites that are intentionally skipped otherwise.
`test:e2e` requires Playwright's browser binaries; install them once before the
first run:

```bash
npx playwright install --with-deps chromium
```

See [Architecture](docs/architecture.md#test-tiers) for tier boundaries.

## Change expectations

- Keep changes focused and preserve existing behavior unless the change is
  explicitly behavioral.
- Add or update tests for fixes and new behavior. Numerical claims should state
  their reference, tolerance, units, and assumptions.
- Do not weaken tolerances or replace validation data without explaining the
  physical or numerical reason.
- Treat loaded user components as trusted code and do not describe them as a
  sandbox. See [Security](SECURITY.md).
- Do not include export-controlled material (for example, technical data
  subject to ITAR or the EAR). Public availability alone is not sufficient:
  material released without authorization remains controlled. You are
  responsible for confirming that your contribution is not subject to export
  controls. Cite lawfully published sources for physical data, correlations,
  and validation references.
- Update the current schema documentation when changing persisted config.

The project has no enforced formatter or linter yet. Match nearby TypeScript
and Markdown style; a lightweight formatting/lint policy is future work.

## Pull requests

Describe the problem, the approach, verification performed, and any scientific
or product limitations. Keep research calibration and product behavior
separate as described in the architecture document.
