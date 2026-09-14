/**
 * runsFile.ts — the results sidecar.
 *
 * The `.fn` file carries the model and its variants; results are bulky and
 * regenerable, so they live beside it in `<model>.runs.json`. The sidecar is
 * also mirrored into localStorage on every completed run, so an ordinary
 * page reload keeps the session's results without the user having to think
 * about saving them.
 *
 * Attaching a sidecar to a model it does not match is allowed — the records
 * carry their own config hash and simply show as stale — because refusing
 * would be worse than showing clearly-labelled history.
 */
import type { RunRecord } from "./runHistory";
import type { NetworkConfig } from "./types";
import { configHash } from "./provenance";
import { safeFilename } from "./utils";

export const RUNS_FILE_SUFFIX = ".runs.json";
const RUNS_STORAGE_KEY = "fluids-network-runs-v1";
const FORMAT = "openflume.runs/1";

export interface RunsFile {
  format: typeof FORMAT;
  /** Model name at save time, for the human reading the file. */
  modelName: string;
  /** Hash of the base network, so a mismatch can be reported on load. */
  baseModelHash: string;
  /**
   * Session identity of the document these runs belong to (see
   * `newDocumentToken`). Written by the localStorage mirror only: it is
   * meaningless outside the browser that minted it, so the portable
   * `.runs.json` omits it.
   */
  documentToken?: string;
  savedAt: string;
  runs: RunRecord[];
}

export function runsFileName(config: NetworkConfig): string {
  return `${safeFilename(config.meta.name)}${RUNS_FILE_SUFFIX}`;
}

export function serializeRunsFile(
  baseConfig: NetworkConfig,
  runs: readonly RunRecord[],
  options: { documentToken?: string } = {},
): string {
  const payload: RunsFile = {
    format: FORMAT,
    modelName: baseConfig.meta.name,
    baseModelHash: configHash(baseConfig),
    ...(options.documentToken ? { documentToken: options.documentToken } : {}),
    savedAt: new Date().toISOString(),
    runs: [...runs],
  };
  return JSON.stringify(payload, null, 2);
}

/** True when `text` looks like a runs sidecar rather than something else. */
export function isRunsFileText(text: string): boolean {
  try {
    const parsed: unknown = JSON.parse(text);
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      (parsed as { format?: unknown }).format === FORMAT
    );
  } catch {
    return false;
  }
}

export class RunsFileParseError extends Error {}

/** Structural parse. Throws RunsFileParseError with a user-facing message. */
export function parseRunsFile(text: string): RunsFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new RunsFileParseError("Not valid JSON.");
  }
  if (typeof parsed !== "object" || parsed === null)
    throw new RunsFileParseError("Expected a results object.");
  const obj = parsed as Record<string, unknown>;
  if (obj.format !== FORMAT)
    throw new RunsFileParseError(
      `Unrecognized results format ${JSON.stringify(obj.format)}.`,
    );
  if (!Array.isArray(obj.runs))
    throw new RunsFileParseError("Missing the runs array.");
  for (const [i, run] of obj.runs.entries()) {
    if (
      typeof run !== "object" ||
      run === null ||
      typeof (run as RunRecord).id !== "string" ||
      typeof (run as RunRecord).config !== "object" ||
      typeof (run as RunRecord).result !== "object"
    ) {
      throw new RunsFileParseError(`Run ${i + 1} is malformed.`);
    }
  }
  return {
    format: FORMAT,
    modelName: typeof obj.modelName === "string" ? obj.modelName : "",
    baseModelHash:
      typeof obj.baseModelHash === "string" ? obj.baseModelHash : "",
    ...(typeof obj.documentToken === "string"
      ? { documentToken: obj.documentToken }
      : {}),
    savedAt: typeof obj.savedAt === "string" ? obj.savedAt : "",
    runs: obj.runs as RunRecord[],
  };
}

export function downloadRunsFile(
  baseConfig: NetworkConfig,
  runs: readonly RunRecord[],
): void {
  const blob = new Blob([serializeRunsFile(baseConfig, runs)], {
    type: "application/json;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = runsFileName(baseConfig);
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/* -------------------------------------------------------------------- */
/* localStorage mirror                                                    */
/* -------------------------------------------------------------------- */

/**
 * Mirror the session's runs so a reload does not lose them. Transient
 * results are large, so a quota failure drops the oldest runs and retries
 * rather than giving up (and ultimately gives up quietly — losing the
 * mirror is never worth breaking a solve).
 */
export function saveRunsToLocalStorage(
  baseConfig: NetworkConfig,
  runs: readonly RunRecord[],
  documentToken: string,
): void {
  let candidate = [...runs];
  while (true) {
    try {
      localStorage.setItem(
        RUNS_STORAGE_KEY,
        serializeRunsFile(baseConfig, candidate, { documentToken }),
      );
      return;
    } catch {
      if (candidate.length === 0) return;
      candidate = candidate.slice(1);
    }
  }
}

/**
 * Restore the mirrored runs when they belong to the current document.
 *
 * Identity is the document token, not the config hash: the mirror is written
 * when runs change, the autosave when the model changes, and a model edited
 * after its last run must still find its history on reload (each record
 * carries its own hash and shows as stale, exactly as when selected live).
 * Mirrors written before tokens existed fall back to the hash comparison.
 */
export function loadRunsFromLocalStorage(
  baseConfig: NetworkConfig,
  documentToken: string,
): RunRecord[] {
  try {
    const raw = localStorage.getItem(RUNS_STORAGE_KEY);
    if (!raw) return [];
    const file = parseRunsFile(raw);
    // Only reattach to the same document: showing another file's runs is the
    // exact confusion the sidecar exists to avoid.
    const sameDocument =
      file.documentToken !== undefined
        ? file.documentToken === documentToken
        : file.baseModelHash === configHash(baseConfig);
    return sameDocument ? file.runs : [];
  } catch {
    return [];
  }
}

export function clearRunsLocalStorage(): void {
  try {
    localStorage.removeItem(RUNS_STORAGE_KEY);
  } catch {
    // Best-effort.
  }
}
