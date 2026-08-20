/**
 * provenance.ts — report/export provenance.
 *
 * Every exported artifact (CSV / PNG / SVG) carries a self-describing
 * provenance block: model name, ISO generation timestamp, solve mode, key
 * solver settings, and a content hash of the exact config that produced the
 * numbers. Analysts paste these into reports; the hash is the audit trail.
 *
 * The hashed view excludes canvas annotations (see hashableConfig): the hash
 * identifies what produced the numbers, not the prose written beside it.
 *
 * Hashing honesty: when the Web Crypto API is available (always on
 * localhost / https) we compute a real SHA-256 and label it
 * `config_sha256`. The synchronous fallback is 64-bit FNV-1a — clearly
 * labeled `config_hash`, never "SHA". Run records use the sync FNV hash
 * (labeled configHash) so record-keeping never has to await.
 */
import type { NetworkConfig } from "./types";

/** JSON with object keys sorted recursively — stable across key order. */
export function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number") {
    // Canonicalize -0 → 0 and keep full precision.
    return Object.is(value, -0) ? "0" : JSON.stringify(value);
  }
  if (typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

/** 64-bit FNV-1a, hex. Deterministic and fast — NOT a cryptographic hash. */
export function fnv1a64Hex(str: string): string {
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (const byte of new TextEncoder().encode(str)) {
    h ^= BigInt(byte);
    h = (h * prime) & mask;
  }
  return h.toString(16).padStart(16, "0");
}

/**
 * The config as it matters to the numbers.  Canvas annotations (`notes`) are
 * stripped: the hash claims "these settings produced these numbers", and a
 * note the solver never reads cannot change them.  Keeping notes out means
 * documenting a model does not invalidate a pinned run-history baseline or
 * make two otherwise-identical exports disagree.
 */
function hashableConfig(config: NetworkConfig): unknown {
  if (config.notes === undefined) return config;
  const { notes: _notes, ...rest } = config;
  return rest;
}

/** Synchronous stable config hash (FNV-1a/64). Used for run-record labels. */
export function configHash(config: NetworkConfig): string {
  return fnv1a64Hex(stableStringify(hashableConfig(config)));
}

/** Real SHA-256 of the canonical config string; null when Web Crypto is unavailable. */
export async function configSha256(
  config: NetworkConfig,
): Promise<string | null> {
  try {
    const subtle = globalThis.crypto?.subtle;
    if (!subtle) return null;
    const data = new TextEncoder().encode(
      stableStringify(hashableConfig(config)),
    );
    const digest = await subtle.digest("SHA-256", data);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  } catch {
    return null;
  }
}

/** Compact solver-settings summary, e.g. "tol=1e-8; maxIter=500; dt=2s; end=200s". */
export function settingsSummary(config: NetworkConfig): string {
  const s = config.settings;
  const parts: string[] = [`tol=${s.tolerance}`, `maxIter=${s.maxIterations}`];
  if (s.relaxation !== undefined) parts.push(`relax=${s.relaxation}`);
  if (s.mode === "transient") {
    parts.push(`stepping=${s.timeStepping ?? "fixed"}`);
    if (s.dt !== undefined) parts.push(`dt=${s.dt}s`);
    if (s.endTime !== undefined) parts.push(`end=${s.endTime}s`);
  }
  return parts.join("; ");
}

/** One-line human provenance footer for chart exports. */
export async function provenanceFooter(config: NetworkConfig): Promise<string> {
  const sha = await configSha256(config);
  const hashPart = sha
    ? `sha256:${sha.slice(0, 12)}`
    : `hash:${configHash(config)}`;
  const name =
    config.meta.name.length > 64
      ? `${config.meta.name.slice(0, 61)}…`
      : config.meta.name;
  return `${name} · ${new Date().toISOString()} · mode=${config.settings.mode} · ${settingsSummary(config)} · ${hashPart}`;
}

/**
 * CSV comment header lines (`# key=value`), Excel-compatible (they import as
 * ordinary single-cell rows above the header row).
 */
export async function provenanceCommentLines(
  config: NetworkConfig,
): Promise<string[]> {
  const lines = [
    `# model=${config.meta.name}`,
    `# generated=${new Date().toISOString()}`,
    `# mode=${config.settings.mode}`,
    `# settings=${settingsSummary(config)}`,
  ];
  const sha = await configSha256(config);
  if (sha) lines.push(`# config_sha256=${sha}`);
  else lines.push(`# config_hash=${configHash(config)}`);
  return lines;
}
