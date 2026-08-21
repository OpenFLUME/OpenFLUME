import type { UserComponentMetadata } from "../core";
import type { NetworkConfig } from "./types";
import { fnv1a64Hex } from "./provenance";
import { useEffect, useSyncExternalStore } from "react";

export interface LocalComponentSource {
  path: string;
  source: string;
  modifiedAt: string | number;
}

export interface LocalComponent extends LocalComponentSource {
  key: string;
  metadata: UserComponentMetadata;
  hash: string;
}

export interface ComponentLibrarySnapshot {
  status: "idle" | "loading" | "ready" | "unavailable";
  components: LocalComponent[];
  error?: string;
}

export interface ComponentTrustComparison {
  key: string;
  status: "match" | "mismatch" | "missing-local";
  embeddedHash: string;
  localHash?: string;
}

export interface UserComponentDescriptor {
  key: string;
  metadata?: UserComponentMetadata;
  source: "embedded" | "local" | "missing";
  drift: boolean;
  local?: LocalComponent;
  error?: string;
}

const LOCAL_TOOL_PREFIX = "userComponent:";

export function localComponentToolId(key: string): string {
  return `${LOCAL_TOOL_PREFIX}${encodeURIComponent(key)}`;
}

export function localComponentKeyFromTool(
  tool: string | null,
): string | undefined {
  if (!tool?.startsWith(LOCAL_TOOL_PREFIX)) return undefined;
  try {
    return decodeURIComponent(tool.slice(LOCAL_TOOL_PREFIX.length));
  } catch {
    return undefined;
  }
}

export function localComponentForTool(
  tool: string | null,
  components = snapshot.components,
): LocalComponent | undefined {
  const key = localComponentKeyFromTool(tool);
  return key === undefined
    ? undefined
    : components.find((component) => component.key === key);
}

export function resolveBranchTool(
  tool: string | null,
  components: LocalComponent[],
):
  | { kind: "none" }
  | { kind: "builtin"; type: string }
  | { kind: "local"; component: LocalComponent }
  | { kind: "stale-local"; key?: string } {
  if (!tool) return { kind: "none" };
  if (!tool.startsWith(LOCAL_TOOL_PREFIX))
    return { kind: "builtin", type: tool };
  const key = localComponentKeyFromTool(tool);
  const component =
    key === undefined ? undefined : components.find((item) => item.key === key);
  return component
    ? { kind: "local", component }
    : { kind: "stale-local", key };
}

export function componentInstanceDefaults(
  component: LocalComponent,
): Extract<
  NetworkConfig["branches"][number]["component"],
  { type: "userComponent" }
> {
  return {
    type: "userComponent",
    component: component.key,
    area: 0.001,
    params: Object.fromEntries(
      (component.metadata.params ?? []).map((param) => [
        param.name,
        param.default,
      ]),
    ),
  };
}

export type ComponentLibraryCreateErrorCode =
  "duplicate" | "unavailable" | "request";

export class ComponentLibraryCreateError extends Error {
  constructor(
    readonly code: ComponentLibraryCreateErrorCode,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ComponentLibraryCreateError";
  }
}

let snapshot: ComponentLibrarySnapshot = { status: "idle", components: [] };
let pending: Promise<ComponentLibrarySnapshot> | null = null;
let generation = 0;
const listeners = new Set<() => void>();
const TRUSTED_SOURCES_KEY = "fluids-network-trusted-component-sources-v1";

function publish(next: ComponentLibrarySnapshot): ComponentLibrarySnapshot {
  snapshot = next;
  listeners.forEach((listener) => listener());
  return next;
}

export function componentSourceHash(source: string): string {
  return fnv1a64Hex(source);
}

/** Cryptographic source identity used for executable-code trust decisions.
 * FNV remains useful for synchronous drift labels, but is not authorization. */
export async function componentSourceTrustHash(
  source: string,
): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error(
      "Web Crypto SHA-256 is unavailable; executable component trust cannot be persisted safely",
    );
  }
  const digest = await subtle.digest(
    "SHA-256",
    new TextEncoder().encode(source),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function loadTrustedSourceHashes(): Set<string> {
  try {
    const parsed = JSON.parse(
      localStorage.getItem(TRUSTED_SOURCES_KEY) ?? "[]",
    );
    return new Set(
      Array.isArray(parsed)
        ? parsed.filter((value): value is string => typeof value === "string")
        : [],
    );
  } catch {
    return new Set();
  }
}

export function isComponentSourceTrusted(hash: string): boolean {
  return loadTrustedSourceHashes().has(hash);
}

export function rememberComponentSourceTrust(hashes: Iterable<string>): void {
  try {
    const trusted = loadTrustedSourceHashes();
    for (const hash of hashes) trusted.add(hash);
    localStorage.setItem(
      TRUSTED_SOURCES_KEY,
      JSON.stringify([...trusted].sort()),
    );
  } catch {
    // Trust persistence is a convenience; accepting the current load still works.
  }
}

/** Register a trusted local source and read metadata without evaluating its pressure-drop function. */
export function parseLocalComponent(
  entry: LocalComponentSource,
): LocalComponent {
  let definition: unknown;
  const register = (value: unknown) => {
    definition = value;
    return value;
  };
  // Local library files are explicitly trusted user code. The callback only
  // captures registration; pressureDrop is never called during discovery.
  const factory = new Function(
    "defineComponent",
    `"use strict";\n${entry.source}`,
  ) as (callback: typeof register) => void;
  factory(register);

  if (!definition || typeof definition !== "object")
    throw new Error(`${entry.path}: source did not call defineComponent`);
  const candidate = definition as {
    metadata?: UserComponentMetadata;
    pressureDrop?: unknown;
  };
  const metadata = candidate.metadata;
  if (
    !metadata ||
    typeof metadata.name !== "string" ||
    metadata.name.trim() === ""
  ) {
    throw new Error(`${entry.path}: metadata.name is required`);
  }
  if (typeof candidate.pressureDrop !== "function")
    throw new Error(`${entry.path}: pressureDrop must be a function`);
  if (metadata.params !== undefined) {
    if (!Array.isArray(metadata.params))
      throw new Error(`${entry.path}: metadata.params must be an array`);
    for (const param of metadata.params) {
      if (
        !param ||
        typeof param.name !== "string" ||
        !Number.isFinite(param.default)
      ) {
        throw new Error(
          `${entry.path}: component params require a name and finite default`,
        );
      }
    }
  }
  return {
    ...entry,
    key: metadata.name.trim() || entry.path,
    metadata,
    hash: componentSourceHash(entry.source),
  };
}

export function getComponentLibrarySnapshot(): ComponentLibrarySnapshot {
  return snapshot;
}

export function subscribeComponentLibrary(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useComponentLibrary(
  refreshOnIdle = true,
): ComponentLibrarySnapshot {
  const current = useSyncExternalStore(
    subscribeComponentLibrary,
    getComponentLibrarySnapshot,
    getComponentLibrarySnapshot,
  );
  useEffect(() => {
    if (refreshOnIdle && current.status === "idle")
      void refreshComponentLibrary();
  }, [current.status, refreshOnIdle]);
  return current;
}

const LIBRARY_SERVER_HINT =
  "Run `npm run serve` in another terminal, or open http://127.0.0.1:4174/.";

export function refreshComponentLibrary(
  options: { force?: boolean } = {},
): Promise<ComponentLibrarySnapshot> {
  if (pending && !options.force) return pending;
  const requestGeneration = ++generation;
  publish({ ...snapshot, status: "loading", error: undefined });
  const request = Promise.resolve()
    .then(() => fetch("/api/library"))
    .catch((error) => {
      // fetch only rejects on network-level failure (connection refused, DNS,
      // CORS) — the companion server is almost certainly not running.
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Could not reach local library server. ${LIBRARY_SERVER_HINT} (${detail})`,
      );
    })
    .then(async (response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      // A dev server without the /api proxy (or any non-companion server)
      // answers with the SPA fallback page; fail with an actionable message
      // instead of an opaque JSON parse error.
      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.includes("application/json")) {
        throw new Error(
          contentType.includes("html")
            ? "Library API returned HTML instead of JSON. If using `npm run dev`, make sure `npm run serve` is also running, or open http://127.0.0.1:4174/ instead."
            : `Library API returned "${contentType || "unknown"}" instead of JSON. ${LIBRARY_SERVER_HINT}`,
        );
      }
      const body = (await response.json()) as {
        components?: LocalComponentSource[];
      };
      if (!Array.isArray(body.components))
        throw new Error("invalid library response");
      const components: LocalComponent[] = [];
      for (const entry of body.components) {
        try {
          if (
            entry &&
            typeof entry.path === "string" &&
            typeof entry.source === "string"
          ) {
            components.push(parseLocalComponent(entry));
          }
        } catch {
          // A malformed local component does not hide the rest of the library.
        }
      }
      components.sort(
        (a, b) => a.key.localeCompare(b.key) || a.path.localeCompare(b.path),
      );
      const unique = components.filter(
        (component, index) =>
          index === 0 || component.key !== components[index - 1].key,
      );
      return requestGeneration === generation
        ? publish({ status: "ready", components: unique })
        : snapshot;
    })
    .catch((error) =>
      requestGeneration === generation
        ? publish({
            status: "unavailable",
            components: snapshot.components,
            error: error instanceof Error ? error.message : String(error),
          })
        : snapshot,
    )
    .finally(() => {
      if (pending === request) pending = null;
    });
  pending = request;
  return request;
}

async function responseMessage(
  response: Response,
): Promise<string | undefined> {
  try {
    const body = (await response.json()) as {
      error?: unknown;
      message?: unknown;
    };
    const message = body.error ?? body.message;
    return typeof message === "string" ? message : undefined;
  } catch {
    return undefined;
  }
}

export async function createLocalComponent(
  fileName: string,
  source: string,
): Promise<LocalComponent> {
  const suffix = ".component.js";
  const fileSlug = fileName.endsWith(suffix)
    ? fileName.slice(0, -suffix.length)
    : fileName;
  const expectedPath = `${fileSlug}${suffix}`;
  let response: Response;
  try {
    response = await fetch("/api/library/components", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fileName: fileSlug, source }),
    });
  } catch (error) {
    throw new ComponentLibraryCreateError(
      "unavailable",
      `Local component saving is unavailable. Run npm run serve. (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  if (!response.ok) {
    const detail = await responseMessage(response);
    if (response.status === 409) {
      throw new ComponentLibraryCreateError(
        "duplicate",
        detail ?? `A local component named "${expectedPath}" already exists.`,
        response.status,
      );
    }
    if ([404, 405, 501].includes(response.status)) {
      throw new ComponentLibraryCreateError(
        "unavailable",
        "This companion server cannot save components. Run npm run serve.",
        response.status,
      );
    }
    throw new ComponentLibraryCreateError(
      "request",
      detail ?? `Could not save component (HTTP ${response.status}).`,
      response.status,
    );
  }

  const next = await refreshComponentLibrary({ force: true });
  const created =
    next.components.find((component) => component.path === expectedPath) ??
    next.components.find((component) => component.source === source);
  if (!created) {
    throw new ComponentLibraryCreateError(
      "request",
      "The component was saved, but was not returned by the refreshed library.",
    );
  }
  return created;
}

/** Add only local definitions that are referenced and not already embedded. */
export function embedReferencedComponents(
  config: NetworkConfig,
  components = snapshot.components,
): string[] {
  const byKey = new Map(
    components.map((component) => [component.key, component]),
  );
  const references = new Set(
    config.branches.flatMap((branch) =>
      branch.component.type === "userComponent"
        ? [branch.component.component]
        : [],
    ),
  );
  const missing: string[] = [];
  for (const key of [...references].sort()) {
    if (config.componentLibrary?.[key]) continue;
    const local = byKey.get(key);
    if (!local) {
      missing.push(key);
      continue;
    }
    config.componentLibrary ??= {};
    config.componentLibrary[key] = {
      code: local.source,
      format: "defineComponent",
      metadata: local.metadata,
    };
  }
  return missing;
}

export async function compareEmbeddedComponents(
  library: NetworkConfig["componentLibrary"],
  components = snapshot.components,
): Promise<ComponentTrustComparison[]> {
  const localByKey = new Map(
    components.map((component) => [component.key, component]),
  );
  return Promise.all(
    Object.entries(library ?? {}).map(async ([key, entry]) => {
      const local = localByKey.get(key);
      const embeddedHash = await componentSourceTrustHash(entry.code);
      if (!local) return { key, status: "missing-local", embeddedHash };
      const localHash = await componentSourceTrustHash(local.source);
      return {
        key,
        status: localHash === embeddedHash ? "match" : "mismatch",
        embeddedHash,
        localHash,
      };
    }),
  );
}

/** Resolve editor metadata without allowing mutable local code to redefine an embedded branch. */
export function resolveUserComponentDescriptor(
  key: string,
  library: NetworkConfig["componentLibrary"],
  components = snapshot.components,
): UserComponentDescriptor {
  const local = components.find((component) => component.key === key);
  const embedded = library?.[key];
  if (embedded) {
    return {
      key,
      metadata: embedded.metadata,
      source: "embedded",
      drift: !!local && local.source !== embedded.code,
      local,
      ...(!embedded.metadata
        ? {
            error:
              "Embedded component has no stored metadata; update explicitly from the local library to edit parameters.",
          }
        : {}),
    };
  }
  return local
    ? { key, metadata: local.metadata, source: "local", drift: false, local }
    : { key, source: "missing", drift: false };
}
