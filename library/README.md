# Component Library (local-first)

This directory holds **user component definitions** discovered by the
local companion server (`scripts/serve.ts`) and loaded by the app at
runtime. It is the extension point for project-specific hardware models
that don't belong in the built-in component set (`src/core/components/`).

## Running

There are two ways to use the component library:

1. **Production mode (recommended, same-origin):**

   ```bash
   npm run serve        # build the app, then launch the companion server
   npm run serve:dist   # launch without rebuilding (serves existing dist/)
   ```

   Then open the printed URL (default <http://127.0.0.1:4174/>). The app and
   the API are served by the same process, so no proxy is involved.

2. **Dev mode (HMR):** run the companion server in one terminal and the Vite
   dev server in another:

   ```bash
   npx tsx scripts/serve.ts   # terminal 1: API + component library on :4174
   npm run dev                # terminal 2: Vite dev server with HMR
   ```

   Then open <http://localhost:5173/>. `vite.config.ts` proxies `/api` to
   `http://127.0.0.1:4174`, so the library works as long as the companion
   server is running; without it, `/api/library` would fall through to the
   SPA fallback and return HTML.

Either way, the app calls `GET /api/library`, which returns:

```json
{
  "components": [
    {
      "path": "example-resistance.component.js",
      "source": "...",
      "modifiedAt": "2026-08-09T..."
    }
  ]
}
```

`path` is relative to the library root, `source` is the full file text, and
`modifiedAt` is the file mtime (ISO-8601). Entries are sorted by `path`, so
the response is deterministic.

Discovery is bounded so a huge or hostile directory cannot exhaust memory:
individual files over **256 KiB** are skipped, at most **256** files are
listed, and at most **4 MiB** of source is returned per scan. Skips are
applied in sorted `path` order (so they are deterministic) and reported in
an optional top-level **`warnings`** array, which is absent when nothing
was skipped. Component files are read through their verified real paths, so
symlinks pointing outside the library root are never followed.

### Creating components over HTTP

The server also exposes one constrained write endpoint for local tooling:

```http
POST /api/library/components
Content-Type: application/json

{ "fileName": "my-pump", "source": "defineComponent({ ... });\n" }
```

This writes `my-pump.component.js` **directly under the library root** and
returns `201` with the component record (`{ path, source, modifiedAt }`).

Constraints (enforced, not conventions):

- `fileName` must be a slug-like basename: 1–64 characters of lowercase
  letters, digits, and single hyphens between segments. No slashes, dots, or
  leading/trailing hyphens — so writes can never escape the library root.
- The JSON body is capped at **256 KiB** (`413` beyond that).
- Creation is **exclusive**: if the file already exists the request fails
  with `409` and the existing file is never overwritten. To change a
  component, edit or replace the file yourself (e.g. in your editor and
  version control).
- Wrong `Content-Type` → `415`; malformed JSON or invalid fields → `400`;
  a body that stalls mid-upload → `408` (the read is time-limited).
- The library directory is created automatically if it doesn't exist yet.
- On a **non-loopback bind** (any `HOST` other than 127.0.0.0/8, `::1`, or
  `localhost` — including `0.0.0.0`) this endpoint is **disabled** (`403`)
  unless `ALLOW_REMOTE_WRITES=1` is set; see the trust model below.

### Configuration (environment variables)

| Variable              | Default                     | Meaning                                                           |
| --------------------- | --------------------------- | ----------------------------------------------------------------- |
| `PORT`                | `4174`                      | Listening port                                                    |
| `HOST`                | `127.0.0.1`                 | Bind address (localhost only!)                                    |
| `DIST_DIR`            | `<repo>/dist`               | Static build directory                                            |
| `LIBRARY_DIR`         | `<repo>/library/components` | Component library root                                            |
| `ALLOW_REMOTE_WRITES` | _(unset)_                   | Set `1` to re-enable the creation endpoint on a non-loopback bind |

Example: `PORT=8080 LIBRARY_DIR=~/my-components npm run serve:dist`

## File format

- Files must live under `library/components/` (or `$LIBRARY_DIR`) and end in
  **`.component.js`**. Subdirectories are scanned recursively; every other
  file is ignored.
- Each file calls the ambient **`defineComponent({...})`** exactly once. The
  app injects that function when evaluating the file — component files have
  **no imports and no exports** and must be fully self-contained.
- The current definition shape is
  `defineComponent({ metadata: { name, label?, params? }, pressureDrop, heat? })`.
  `metadata.params` is an array of
  `{ name, label?, unit?, default, min?, max? }`; every `default` is a finite
  number. Branches reference `metadata.name` and supply per-instance `params`
  and an optional contextual `area`.
- `pressureDrop(args)` receives `mdot`, `rho`, `mu`, `t`, optional `T`,
  `pFrom`, `pTo`, `area`, frozen `params`, and a branch-scoped read-only
  `fluid` property accessor. It returns a finite pressure drop in Pa. It
  cannot access registers, the network, or solver internals.
- Optional `heat(args)` receives `mdot`, `Tup`, `cp`, optional `P`, `h`,
  `area`, `params`, and `fluid`, and returns a finite heat rate in W.
- See [`components/example-resistance.component.js`](components/example-resistance.component.js)
  for a complete, commented template modeled on the built-in K-factor
  resistance.

## Trust model — read this before adding files

**Component files are executable JavaScript.** Discovery and solver compilation
use `new Function` in strict mode. This limits convenient lexical inputs but is
not a security boundary: code can still reach browser globals. Loading
embedded source that does not match the local library triggers a consent prompt
remembered by source hash, but local-library files are treated as trusted code.

Therefore:

- **Only place files here that you would run as code.** Treat
  `library/components/` exactly like `src/`. Never copy component files from
  untrusted sources without reading them line by line — including files you
  `POST` to the creation endpoint.
- The companion server binds **localhost only** by default. Its single write
  path, `POST /api/library/components`, is deliberately constrained
  (slug-only file names directly under the library root, a 256 KiB body cap
  with a read timeout, exclusive create — new files only, never
  overwrites), but it is **not authenticated**: anything that can reach the
  port can add executable component code to your library, and it will run
  in the app on next load.
- Do **not** set `HOST` to a non-loopback address unless you understand that
  you are then serving executable source (and the app) to that interface.
  As a backstop, the creation endpoint answers **403** on any non-loopback
  bind unless you also set `ALLOW_REMOTE_WRITES=1` — and the server warns
  loudly at startup when that combination is active.
- The server blocks path traversal and refuses to follow symlinks that point
  outside the library root, so a stray symlink can't leak files elsewhere on
  disk into the library listing. Static files get the same treatment: every
  served path is realpath-checked against the real `dist/` root.
- Prefer committing library files to version control (or otherwise tracking
  them) so changes to executable physics code are reviewable in diffs.

See [`../docs/usercode.md`](../docs/usercode.md) for embedding behavior,
declarative alternatives, lifecycle logic, PID controllers, and security.
