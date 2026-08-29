# Contributing

Contributions are welcome. Before starting a large change, open an issue first to discuss the scope and validation approach.

## Development setup

This project uses Node.js 22 and npm as the primary package manager, with `package-lock.json` acting as the source of truth for CI.

```bash
npm ci
npm run dev
```

## Before a pull request

Run the same practical gate used for normal pull requests:

```bash
npm run check
```

For changes impacting numerical methods, real-fluid properties, validation, or browser workflows, run the extended test tiers:

```bash
npm run test:all
npm run test:slow
npm run test:e2e
```

`test:slow` runs expensive tests that are otherwise skipped.
`test:e2e` requires Playwright.

```bash
npx playwright install --with-deps chromium
```

See [Architecture](docs/architecture.md#test-tiers) for more information.

## Change expectations

- **Focused:** Keep changes narrow in scope. Do not alter existing behavior unless it is the explicit goal of the change.
- **Testing:** Include tests for all fixes and new features.
- **Validation:** Do not relax test tolerances or modify validation data without a clear physical or numerical justification.
- **Security:** All contributions are expected to be strictly confined and must not compromise the application's security and privacy posture. See [Security](SECURITY.md).
- **Export controls:** Never submit export-controlled material (e.g., ITAR or EAR technical data). Note that public availability does not necessarily mean authorization for release. You are responsible for ensuring your contribution is free of export controls. Always cite lawfully published sources for physical data, correlations, and validation targets.
- **Documentation:** Update the relevant documentation if your change modifies the `.fn` network schema, save format, or other persistent data structures.

Formatting and linting are enforced. `npm run check` runs ESLint with
`--max-warnings=0` and Prettier in check mode, and continuous integration runs
the same gate on every pull request. Run `npm run format` to apply Prettier
before pushing.

## Pull requests

In your pull request description, clearly outline the problem, your solution, the verification steps taken, and any resulting physical or functional limitations. As outlined in the architecture document, maintain a strict separation between research/calibration logic and core product behavior.
