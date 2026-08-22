/**
 * Local-first companion server for the OpenFLUME app.
 *
 *   npm run serve        # build (tsc --noEmit && vite build), then serve
 *   npm run serve:dist   # serve an existing dist/ without rebuilding
 *
 * What it does:
 *   - Serves the static production build from dist/ (SPA fallback to
 *     index.html for extension-less routes). The REAL path of every served
 *     file is verified to stay inside the real static root, so a symlink
 *     planted in dist/ cannot leak files from elsewhere on disk.
 *   - Exposes a component-library discovery endpoint:
 *       GET /api/library -> { components: [{ path, source, modifiedAt }], warnings? }
 *     backed by a local directory of *.component.js files (default
 *     <repo>/library/components). Scans are bounded — per-file size, file
 *     count, and aggregate bytes are capped — and skipped files are
 *     reported in the optional top-level `warnings` array (absent when
 *     nothing was skipped). See library/README.md for the file format and
 *     the trust model.
 *   - Exposes one constrained local creation endpoint:
 *       POST /api/library/components  (Content-Type: application/json)
 *       body: { fileName: string, source: string }
 *     which writes `<fileName>.component.js` directly under the library
 *     root. `fileName` must be a slug-like basename (lowercase letters,
 *     digits, single hyphens — no slashes or dots), the JSON body is capped
 *     at 256 KiB with a read timeout, and files are created exclusively
 *     (`flag: 'wx'`): an existing file is never overwritten through this
 *     endpoint (409). Component files are executable JavaScript, so this is
 *     still a local-trust interface — see library/README.md.
 *
 * Hard rules:
 *   - Node built-ins only (no npm dependencies); runs under tsx.
 *   - Binds 127.0.0.1 by default — this is a LOCAL companion, not a network
 *     service. On a non-loopback bind (anything other than 127.0.0.0/8,
 *     ::1, or "localhost" — e.g. HOST=0.0.0.0) the creation endpoint is
 *     DISABLED with 403 unless ALLOW_REMOTE_WRITES=1 is set explicitly;
 *     discovery and static serving stay read-only. Set HOST /
 *     ALLOW_REMOTE_WRITES only if you understand the trust implications
 *     (library component files are executable JavaScript, and the create
 *     endpoint above can add new ones).
 *   - Writes are limited to the constrained creation endpoint: GET/HEAD for
 *     static files and discovery, POST only on /api/library/components;
 *     everything else gets 405 with an Allow header.
 *   - Path traversal is blocked for static files, library symlinks, and
 *     component creation (slug-only file names, containment re-checked).
 *     Static serving realpaths the static root and every candidate and
 *     refuses symlink escapes; discovery reads every component through its
 *     verified real path.
 *
 * Configuration (environment variables):
 *   PORT                listening port            (default 4174; vite preview uses 4173)
 *   HOST                bind address              (default 127.0.0.1)
 *   DIST_DIR            static build directory    (default <repo>/dist)
 *   LIBRARY_DIR         component library root    (default <repo>/library/components)
 *   ALLOW_REMOTE_WRITES "1" re-enables the component-creation endpoint on a
 *                       non-loopback bind         (default unset = disabled there)
 *
 * The directory-scan / path-resolution helpers are exported so they can be
 * unit-tested (scripts/__tests__/serve.test.ts) without binding a port —
 * the server only listens when this file is executed directly.
 */

import * as http from "node:http";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");

const DEFAULT_PORT = 4174;
const DEFAULT_HOST = "127.0.0.1";
const COMPONENT_SUFFIX = ".component.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface ServerConfig {
  port: number;
  host: string;
  distDir: string;
  libraryDir: string;
  /**
   * Escape hatch that re-enables the component-creation endpoint on a
   * non-loopback bind (ALLOW_REMOTE_WRITES=1). Ignored on loopback binds,
   * where creation is always enabled.
   */
  allowRemoteWrites: boolean;
}

export function resolveConfig(
  env: NodeJS.ProcessEnv = process.env,
): ServerConfig {
  const port = Number(env.PORT ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(
      `Invalid PORT "${env.PORT}": expected an integer between 1 and 65535.`,
    );
  }
  return {
    port,
    host: env.HOST?.trim() ? env.HOST.trim() : DEFAULT_HOST,
    distDir: path.resolve(env.DIST_DIR ?? path.join(REPO_ROOT, "dist")),
    libraryDir: path.resolve(
      env.LIBRARY_DIR ?? path.join(REPO_ROOT, "library", "components"),
    ),
    // Deliberately strict: only the literal string "1" counts.
    allowRemoteWrites: env.ALLOW_REMOTE_WRITES === "1",
  };
}

/**
 * True when `host` names a loopback interface: any 127.0.0.0/8 address,
 * ::1 (optionally bracketed, or the IPv4-mapped form ::ffff:127.x.y.z), or
 * "localhost". Everything else — including the wildcards 0.0.0.0 and ::
 * (every interface) and other hostnames — is treated as non-loopback.
 * Unrecognised spellings fail CLOSED (writes disabled), never open.
 */
export function isLoopbackHost(host: string): boolean {
  let h = host.trim().toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1); // RFC 3986 literal brackets
  if (h === "localhost" || h === "localhost.") return true;
  if (h === "::1" || h === "0:0:0:0:0:0:0:1") return true;
  if (h.startsWith("::ffff:")) h = h.slice("::ffff:".length); // IPv4-mapped IPv6
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return false;
  const octets = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  return octets[0] === 127 && octets.every((o) => o <= 255);
}

// ---------------------------------------------------------------------------
// Component library discovery
// ---------------------------------------------------------------------------

export interface LibraryComponentFile {
  /** POSIX-style path relative to the library root (e.g. "pumps/centrifugal.component.js"). */
  path: string;
  /** Full UTF-8 source of the component file. */
  source: string;
  /** File mtime as an ISO-8601 string. */
  modifiedAt: string;
}

export interface LibraryListing {
  components: LibraryComponentFile[];
  /**
   * Files the scan skipped because of the size/count/aggregate limits
   * below. Absent when nothing was skipped, so a clean scan keeps the
   * original response shape.
   */
  warnings?: string[];
}

/** Result of a bounded library scan. */
export interface LibraryScanResult {
  components: LibraryComponentFile[];
  /** Human-readable notes about skipped files; empty when nothing was skipped. */
  warnings: string[];
}

/** Per-file source size cap applied during discovery (256 KiB). */
export const MAX_COMPONENT_FILE_BYTES = 256 * 1024;
/** Maximum number of component files one scan returns. */
export const MAX_LIBRARY_COMPONENTS = 256;
/** Maximum aggregate source bytes one scan returns (4 MiB). */
export const MAX_LIBRARY_TOTAL_BYTES = 4 * 1024 * 1024;

/** Scan bounds; any field may be overridden per call (mainly for tests). */
export interface LibraryScanLimits {
  maxFileBytes: number;
  maxFiles: number;
  maxTotalBytes: number;
}

const DEFAULT_SCAN_LIMITS: LibraryScanLimits = {
  maxFileBytes: MAX_COMPONENT_FILE_BYTES,
  maxFiles: MAX_LIBRARY_COMPONENTS,
  maxTotalBytes: MAX_LIBRARY_TOTAL_BYTES,
};

function toPosixPath(p: string): string {
  return p.split(path.sep).join("/");
}

function isWithin(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + path.sep);
}

/**
 * Recursively collect every `*.component.js` file under `libraryDir`,
 * bounded by the scan limits.
 *
 * Guarantees:
 *   - Deterministic: candidates are sorted by relative POSIX path
 *     (code-unit order) BEFORE the limits are applied, so the same library
 *     always yields the same listing, the same skips, and the same
 *     warnings, regardless of directory-enumeration order.
 *   - Path traversal / symlink escapes are blocked: every returned file's
 *     real path is verified to live inside the real library root, the file
 *     is read THROUGH that real path, and directory symlinks are
 *     cycle-guarded.
 *   - Bounded: files over `maxFileBytes` are skipped, at most `maxFiles`
 *     files are listed, and at most `maxTotalBytes` of source (by stat
 *     size) is returned. Every skip is reported in `warnings`.
 *   - Best-effort: files that vanish or become unreadable mid-scan are
 *     skipped; a missing library root simply yields an empty result.
 */
export async function scanLibrary(
  libraryDir: string,
  limits: Partial<LibraryScanLimits> = {},
): Promise<LibraryScanResult> {
  const { maxFileBytes, maxFiles, maxTotalBytes } = {
    ...DEFAULT_SCAN_LIMITS,
    ...limits,
  };
  const resolvedRoot = path.resolve(libraryDir);
  let root: string;
  try {
    root = await fsp.realpath(resolvedRoot);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { components: [], warnings: [] };
    }
    throw err;
  }

  interface Candidate {
    /** POSIX path relative to the real root (display/sort key). */
    rel: string;
    /** Real path the content is read from (symlink-escape checked). */
    realPath: string;
    size: number;
    mtime: Date;
  }
  const candidates: Candidate[] = [];
  let candidateCount = 0;
  const visitedDirs = new Set<string>();

  const retainCandidate = (candidate: Candidate): void => {
    candidateCount++;
    if (maxFiles <= 0) return;
    // Keep only the lexicographically first maxFiles candidates. This gives
    // deterministic path ordering without retaining an unbounded tree.
    let lo = 0;
    let hi = candidates.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (candidates[mid].rel < candidate.rel) lo = mid + 1;
      else hi = mid;
    }
    candidates.splice(lo, 0, candidate);
    if (candidates.length > maxFiles) candidates.pop();
  };

  async function walk(dir: string): Promise<void> {
    let realDir: string;
    try {
      realDir = await fsp.realpath(dir);
    } catch {
      return; // dangling symlink or unreadable directory
    }
    if (!isWithin(root, realDir)) return; // symlink escape — block
    if (visitedDirs.has(realDir)) return; // symlink cycle — block
    visitedDirs.add(realDir);

    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      if (!entry.name.endsWith(COMPONENT_SUFFIX)) continue;

      // Containment check on the real target blocks symlink escapes.
      try {
        const realFile = await fsp.realpath(full);
        if (!isWithin(root, realFile)) continue;
        const stat = await fsp.stat(realFile);
        if (!stat.isFile()) continue;
        retainCandidate({
          rel: toPosixPath(path.relative(root, full)),
          realPath: realFile,
          size: stat.size,
          mtime: stat.mtime,
        });
      } catch {
        continue; // vanished or unreadable mid-scan — skip
      }
    }
  }

  await walk(root);
  const warnings: string[] = [];
  const components: LibraryComponentFile[] = [];

  const considered = candidates;
  if (candidateCount > maxFiles) {
    warnings.push(
      `Component count limit: only the first ${maxFiles} of ${candidateCount} ` +
        "component files (sorted by path) are listed.",
    );
  }

  let totalBytes = 0;
  for (let i = 0; i < considered.length; i += 1) {
    const candidate = considered[i];
    if (candidate.size > maxFileBytes) {
      warnings.push(
        `"${candidate.rel}" is ${candidate.size} bytes, over the ${maxFileBytes}-byte ` +
          "per-file limit — skipped.",
      );
      continue;
    }
    if (totalBytes + candidate.size > maxTotalBytes) {
      warnings.push(
        `Aggregate size limit: the ${maxTotalBytes}-byte cap was reached, so this and ` +
          `${considered.length - i - 1} later component file(s) are omitted.`,
      );
      break;
    }
    try {
      const source = await fsp.readFile(candidate.realPath, "utf8");
      totalBytes += candidate.size;
      components.push({
        path: candidate.rel,
        source,
        modifiedAt: candidate.mtime.toISOString(),
      });
    } catch {
      continue; // vanished or unreadable mid-scan — skip
    }
  }

  return { components, warnings };
}

// ---------------------------------------------------------------------------
// Component library creation (constrained local write)
// ---------------------------------------------------------------------------

/** Upper bound on the JSON body accepted by the creation endpoint (256 KiB). */
export const MAX_COMPONENT_BODY_BYTES = 256 * 1024;

/**
 * Slug-like basenames only: lowercase letters/digits in one or more segments
 * joined by single hyphens (e.g. "pump", "pump-2stage"). No path separators,
 * no dots, no leading/trailing hyphens — so `<fileName>.component.js` can
 * never escape the library root.
 */
const COMPONENT_FILE_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Upper bound on fileName length, so the final basename stays sane. */
const MAX_COMPONENT_FILE_NAME_LENGTH = 64;

export function isValidComponentFileName(fileName: string): boolean {
  return (
    fileName.length >= 1 &&
    fileName.length <= MAX_COMPONENT_FILE_NAME_LENGTH &&
    COMPONENT_FILE_NAME_PATTERN.test(fileName)
  );
}

/** Thrown when the target component file already exists (exclusive create). */
export class ComponentConflictError extends Error {
  constructor(public readonly fileName: string) {
    super(`Component "${fileName}${COMPONENT_SUFFIX}" already exists.`);
    this.name = "ComponentConflictError";
  }
}

/**
 * Create a new component file directly under `libraryDir` and return its
 * discovery record (same shape as scanLibrary entries).
 *
 * Guarantees:
 *   - The library directory is created when missing.
 *   - The file is created exclusively (`flag: 'wx'`, i.e. O_CREAT|O_EXCL):
 *     if anything already exists at the target path — file or symlink — a
 *     ComponentConflictError is thrown and nothing is overwritten.
 *   - `fileName` must satisfy isValidComponentFileName, so the target is
 *     always a plain file directly inside the root; containment is
 *     re-verified as defense in depth.
 */
export async function createLibraryComponent(
  libraryDir: string,
  fileName: string,
  source: string,
): Promise<LibraryComponentFile> {
  if (!isValidComponentFileName(fileName)) {
    throw new Error(`Invalid component file name "${fileName}".`);
  }
  const root = path.resolve(libraryDir);
  await fsp.mkdir(root, { recursive: true });
  const target = path.join(root, `${fileName}${COMPONENT_SUFFIX}`);
  if (!isWithin(root, target)) {
    // Unreachable given the pattern above — defense in depth.
    throw new Error(`Invalid component file name "${fileName}".`);
  }
  try {
    await fsp.writeFile(target, source, { encoding: "utf8", flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      throw new ComponentConflictError(fileName);
    }
    throw err;
  }
  const stat = await fsp.stat(target);
  return {
    path: toPosixPath(path.relative(root, target)),
    source,
    modifiedAt: stat.mtime.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Static file helpers
// ---------------------------------------------------------------------------

export const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml",
  ".pdf": "application/pdf",
};

export function mimeTypeFor(filePath: string): string {
  return (
    MIME_TYPES[path.extname(filePath).toLowerCase()] ??
    "application/octet-stream"
  );
}

/**
 * Map a URL path to a file inside `rootDir`, or return null when the
 * resolution is unsafe (undecodable escapes, NUL bytes, or a result outside
 * the root). Dot segments — including percent-encoded ones — are normalized
 * away, so "/../x" can never escape; the containment check is belt-and-braces
 * on top of that.
 */
export function resolveStaticPath(
  rootDir: string,
  urlPath: string,
): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null; // malformed percent-encoding
  }
  if (decoded.includes("\0")) return null;
  const normalized = path.normalize(decoded).replace(/^[/\\]+/, "");
  const resolved = path.resolve(rootDir, normalized);
  const root = path.resolve(rootDir);
  if (!isWithin(root, resolved)) return null;
  return resolved;
}

// ---------------------------------------------------------------------------
// HTTP request handling
// ---------------------------------------------------------------------------

export interface RequestHandlerOptions {
  distDir: string;
  libraryDir: string;
  /**
   * Bind address the handler is serving. A non-loopback value disables the
   * component-creation endpoint unless `allowRemoteWrites` is set. Defaults
   * to the loopback default, so tests and local use keep writes enabled.
   */
  host?: string;
  /** Re-enable component creation on a non-loopback `host`. */
  allowRemoteWrites?: boolean;
  /** Body-read timeout for POST in milliseconds (tests can shrink it). */
  requestBodyTimeoutMs?: number;
}

function sendJson(
  res: http.ServerResponse,
  status: number,
  body: unknown,
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(payload);
}

function sendText(
  res: http.ServerResponse,
  status: number,
  message: string,
  allow?: string,
): void {
  const headers: Record<string, string | number> = {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": Buffer.byteLength(message),
    "X-Content-Type-Options": "nosniff",
  };
  if (allow) headers["Allow"] = allow;
  res.writeHead(status, headers);
  res.end(message);
}

function sendFile(
  res: http.ServerResponse,
  filePath: string,
  size: number,
  headOnly: boolean,
): void {
  res.writeHead(200, {
    "Content-Type": mimeTypeFor(filePath),
    "Content-Length": size,
    "X-Content-Type-Options": "nosniff",
  });
  if (headOnly) {
    res.end();
    return;
  }
  const stream = fs.createReadStream(filePath);
  stream.on("error", () => res.destroy());
  stream.pipe(res);
}

/** Time budget for reading one POST body (slowloris bound), in milliseconds. */
export const REQUEST_BODY_TIMEOUT_MS = 15_000;

/** Raised when a request body exceeds the configured byte limit. */
class PayloadTooLargeError extends Error {
  constructor(public readonly limit: number) {
    super(`Request body exceeds the ${limit}-byte limit.`);
    this.name = "PayloadTooLargeError";
  }
}

/** Raised when a request body is not fully received within the time budget. */
class RequestBodyTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`Request body timed out after ${timeoutMs} ms.`);
    this.name = "RequestBodyTimeoutError";
  }
}

/** Raised when the peer goes away before the request body is complete. */
class RequestAbortedError extends Error {
  constructor() {
    super("Request aborted by the client.");
    this.name = "RequestAbortedError";
  }
}

/**
 * Buffer a request body up to `limit` bytes, giving up after `timeoutMs`.
 * A body over the limit (declared via Content-Length or observed
 * mid-stream) rejects with PayloadTooLargeError; a stalled body rejects
 * with RequestBodyTimeoutError; a peer that goes away mid-body rejects
 * with RequestAbortedError (or the underlying stream error). The request
 * stream is drained in the over-limit rejection paths so keep-alive
 * connections remain usable; timeout/abort teardown is left to the caller.
 */
function readRequestBody(
  req: http.IncomingMessage,
  limit: number,
  timeoutMs: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > limit) {
      req.resume();
      reject(new PayloadTooLargeError(limit));
      return;
    }
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new RequestBodyTimeoutError(timeoutMs));
    }, timeoutMs);
    timer.unref(); // never keep the process alive just for this timer
    const settle = (complete: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      complete();
    };
    req.on("data", (chunk: Buffer) => {
      if (settled) return;
      total += chunk.length;
      if (total > limit) {
        settle(() => {
          req.resume(); // drain the remainder without buffering it
          reject(new PayloadTooLargeError(limit));
        });
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => settle(() => resolve(Buffer.concat(chunks))));
    req.on("error", (err) => settle(() => reject(err)));
    req.on("aborted", () => settle(() => reject(new RequestAbortedError())));
    req.on("close", () => settle(() => reject(new RequestAbortedError())));
  });
}

interface CreateComponentBody {
  fileName: string;
  source: string;
}

/**
 * POST /api/library/components — create one component file for a trusted
 * local caller. Failures are JSON { error } bodies with matching HTTP status codes:
 * 400 malformed JSON / invalid fileName or source, 408 body read timed out,
 * 409 already exists, 413 body over the 256 KiB cap, 415 wrong Content-Type.
 * Unexpected filesystem failures are logged server-side and answered with a
 * generic 500 — raw paths and errno details never leave the process.
 */
async function handleCreateComponent(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  libraryRoot: string,
  bodyTimeoutMs: number,
): Promise<void> {
  const mediaType = req.headers["content-type"]
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (mediaType !== "application/json") {
    req.resume(); // drain so keep-alive connections stay usable
    sendJson(res, 415, { error: "Content-Type must be application/json." });
    return;
  }

  let raw: Buffer;
  try {
    raw = await readRequestBody(req, MAX_COMPONENT_BODY_BYTES, bodyTimeoutMs);
  } catch (err) {
    if (err instanceof PayloadTooLargeError) {
      sendJson(res, 413, { error: err.message });
      return;
    }
    if (err instanceof RequestBodyTimeoutError) {
      sendJson(res, 408, { error: err.message });
      // The client stalled; close the socket once the response is flushed
      // instead of holding it open for keep-alive.
      res.once("finish", () => req.destroy());
      return;
    }
    if (err instanceof RequestAbortedError) {
      res.destroy(); // the peer is gone — nothing useful can be sent
      return;
    }
    if (!res.destroyed && !res.writableEnded) {
      sendJson(res, 400, { error: "Failed to read the request body." });
    }
    return;
  }

  let parsed: unknown;
  try {
    // Tolerate a UTF-8 BOM; everything else must be strict JSON.
    parsed = JSON.parse(raw.toString("utf8").replace(/^\uFEFF/, ""));
  } catch {
    sendJson(res, 400, { error: "Request body is not valid JSON." });
    return;
  }

  const body = parsed as Partial<CreateComponentBody> | null;
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    sendJson(res, 400, {
      error: 'Request body must be a JSON object with "fileName" and "source".',
    });
    return;
  }

  const { fileName, source } = body;
  if (typeof fileName !== "string" || !isValidComponentFileName(fileName)) {
    sendJson(res, 400, {
      error:
        "fileName must be a slug-like basename: 1-64 characters of lowercase letters, " +
        "digits, and single hyphens between segments (no slashes, dots, or " +
        "leading/trailing hyphens).",
    });
    return;
  }
  if (typeof source !== "string" || source.length === 0) {
    sendJson(res, 400, {
      error: "source must be a non-empty string of component JavaScript.",
    });
    return;
  }

  try {
    const component = await createLibraryComponent(
      libraryRoot,
      fileName,
      source,
    );
    sendJson(res, 201, component);
  } catch (err) {
    if (err instanceof ComponentConflictError) {
      sendJson(res, 409, { error: err.message });
      return;
    }
    // EACCES, ENOSPC, ... — log details server-side, answer generically.
    console.error(
      `[serve] component creation failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    sendJson(res, 500, { error: "Failed to create the component." });
  }
}

/**
 * Build the request handler. Exported separately from `main` so tests can
 * drive it on an ephemeral port without touching env vars.
 */
export function createRequestHandler(
  options: RequestHandlerOptions,
): http.RequestListener {
  const distRoot = path.resolve(options.distDir);
  const libraryRoot = path.resolve(options.libraryDir);
  const writesEnabled =
    isLoopbackHost(options.host ?? DEFAULT_HOST) ||
    options.allowRemoteWrites === true;
  const bodyTimeoutMs = options.requestBodyTimeoutMs ?? REQUEST_BODY_TIMEOUT_MS;

  // Real path of the static root, resolved lazily and cached on success.
  // dist/ may not exist yet (serve:dist before a build); failures are NOT
  // cached, so a later build is picked up without a restart.
  let cachedRealDistRoot: string | null = null;
  const realDistRoot = async (): Promise<string | null> => {
    if (cachedRealDistRoot) return cachedRealDistRoot;
    try {
      cachedRealDistRoot = await fsp.realpath(distRoot);
      return cachedRealDistRoot;
    } catch {
      return null;
    }
  };

  /**
   * Stat `candidate` for serving, requiring its REAL path (all symlinks
   * resolved) to stay inside the real static root. Returns the real path so
   * the response streams the exact file that passed the check — a symlink
   * swapped in after the check cannot redirect the read elsewhere.
   */
  const statContainedFile = async (
    candidate: string,
  ): Promise<{ filePath: string; stat: fs.Stats } | null> => {
    const root = await realDistRoot();
    if (!root) return null;
    try {
      const real = await fsp.realpath(candidate);
      if (!isWithin(root, real)) return null; // symlink escape — refuse
      const stat = await fsp.stat(real);
      return stat.isFile() ? { filePath: real, stat } : null;
    } catch {
      return null; // missing, dangling symlink, or unreadable
    }
  };

  return async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const pathname = url.pathname;

      // --- Component library discovery API (read-only) ---------------------
      if (pathname === "/api/library") {
        if (req.method !== "GET") {
          sendText(res, 405, "Method Not Allowed\n", "GET");
          return;
        }
        try {
          const scan = await scanLibrary(libraryRoot);
          const listing: LibraryListing = { components: scan.components };
          if (scan.warnings.length > 0) listing.warnings = scan.warnings;
          sendJson(res, 200, listing);
        } catch (err) {
          // Filesystem details stay in the server log, out of the response.
          console.error(
            `[serve] library scan failed: ${err instanceof Error ? err.message : String(err)}`,
          );
          sendJson(res, 500, {
            error: "Failed to scan the component library.",
          });
        }
        return;
      }

      // --- Component creation API (constrained local write) ----------------
      if (pathname === "/api/library/components") {
        if (req.method !== "POST") {
          sendText(res, 405, "Method Not Allowed\n", "POST");
          return;
        }
        if (!writesEnabled) {
          req.resume(); // drain so keep-alive connections stay usable
          sendJson(res, 403, {
            error:
              "Component creation is disabled because the server is bound to a " +
              "non-loopback interface. Restart with ALLOW_REMOTE_WRITES=1 to " +
              "enable it (see library/README.md for the trust implications).",
          });
          return;
        }
        await handleCreateComponent(req, res, libraryRoot, bodyTimeoutMs);
        return;
      }

      // --- Static files from dist/ -----------------------------------------
      if (req.method !== "GET" && req.method !== "HEAD") {
        sendText(res, 405, "Method Not Allowed\n", "GET, HEAD");
        return;
      }

      const resolved = resolveStaticPath(distRoot, pathname);
      if (!resolved) {
        sendText(res, 404, "Not Found\n");
        return;
      }

      // Every served path — direct file, directory index, or SPA shell —
      // must realpath to inside the real static root, so a symlink planted
      // in dist/ cannot leak files from elsewhere on disk.
      let found = await statContainedFile(resolved);
      if (!found) {
        // Not a plain file; also try <dir>/index.html for clean URLs.
        try {
          const dirStat = await fsp.stat(resolved);
          if (dirStat.isDirectory()) {
            found = await statContainedFile(path.join(resolved, "index.html"));
          }
        } catch {
          /* not a directory — fall through */
        }
      }

      if (!found) {
        // SPA fallback: extension-less routes serve the app shell.
        if (!path.extname(pathname)) {
          const shell = await statContainedFile(
            path.join(distRoot, "index.html"),
          );
          if (shell) {
            sendFile(
              res,
              shell.filePath,
              shell.stat.size,
              req.method === "HEAD",
            );
            return;
          }
          sendText(
            res,
            503,
            "dist/index.html not found — run `npm run build` first.\n",
          );
          return;
        }
        sendText(res, 404, "Not Found\n");
        return;
      }

      sendFile(res, found.filePath, found.stat.size, req.method === "HEAD");
    } catch (err) {
      // Last-resort guard: never hang a request on an unexpected error, and
      // never leak raw filesystem details to the client.
      console.error(
        `[serve] unexpected request error: ${err instanceof Error ? err.message : String(err)}`,
      );
      if (!res.headersSent && !res.destroyed) {
        sendJson(res, 500, { error: "Internal server error." });
      } else {
        res.destroy();
      }
    }
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function createServer(config: ServerConfig): http.Server {
  const server = http.createServer(
    createRequestHandler({
      distDir: config.distDir,
      libraryDir: config.libraryDir,
      host: config.host,
      allowRemoteWrites: config.allowRemoteWrites,
    }),
  );
  // Server-level slow-request bounds, on top of the POST body timeout in
  // readRequestBody: headers must arrive within 15 s and a whole request
  // within 60 s. These constrain only how slowly a request may arrive.
  server.headersTimeout = 15_000;
  server.requestTimeout = 60_000;
  return server;
}

async function main(): Promise<void> {
  const config = resolveConfig();
  const server = createServer(config);

  if (!fs.existsSync(path.join(config.distDir, "index.html"))) {
    console.warn(
      `[serve] warning: ${path.join(config.distDir, "index.html")} does not exist — ` +
        "run `npm run build` first (or use `npm run serve`, which builds for you).",
    );
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, () => resolve());
  });

  const loopback = isLoopbackHost(config.host);
  const writesEnabled = loopback || config.allowRemoteWrites;

  console.log(`[serve] OpenFLUME app:  http://${config.host}:${config.port}/`);
  console.log(`[serve] static root:       ${config.distDir}`);
  console.log(`[serve] library root:      ${config.libraryDir}`);
  console.log(
    `[serve] discovery API:     http://${config.host}:${config.port}/api/library`,
  );
  if (writesEnabled) {
    console.log(
      `[serve] creation API:      POST http://${config.host}:${config.port}/api/library/components`,
    );
  } else {
    console.log(
      "[serve] creation API:      DISABLED (non-loopback bind; restart with " +
        "ALLOW_REMOTE_WRITES=1 to enable)",
    );
  }
  if (!loopback && config.allowRemoteWrites) {
    console.warn(
      "[serve] warning: component creation is ENABLED on a non-loopback interface — " +
        "anyone who can reach this port can add executable component code to your library.",
    );
  }

  const shutdown = (): void => {
    server.close(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

const invokedAs = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedAs && invokedAs === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(
      `[serve] fatal: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  });
}
