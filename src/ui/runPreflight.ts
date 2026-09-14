/**
 * runPreflight.ts — the one gate every solve passes through before a config
 * reaches the worker.
 *
 * Manual runs and sweeps used to preflight differently: the manual path
 * checked embedded-component trust, embedded referenced local components,
 * and validated; the sweep path went straight to the worker. Embedded user
 * components execute as trusted code inside the worker (see
 * docs/architecture.md "Extension trust"), so a sweep of an untrusted file
 * was a way around the consent the manual path enforces. Both paths now call
 * `prepareRunConfig`.
 *
 * Steps, in order:
 *  1. Refresh the local component library (best effort — a missing companion
 *     server yields an empty library, not a failure).
 *  2. Trust: every embedded component whose source differs from the local
 *     library copy must have been approved by the user, unless it ships with
 *     a bundled example.
 *  3. Local components referenced but not embedded are embedded into the
 *     returned clone (`embedLocal: true`, the manual-run behaviour) or
 *     reported as an error (`embedLocal: false`, for callers whose config is
 *     hash-pinned and cannot change, such as sweep jobs).
 *  4. Semantic validation.
 *
 * The input is never mutated; the returned config is a clone.
 */
import { validateNetwork } from "../core";
import { cloneConfig } from "./utils";
import { examples } from "./examples";
import type { NetworkConfig } from "./types";
import {
  compareEmbeddedComponents,
  embedReferencedComponents,
  isComponentSourceTrusted,
  refreshComponentLibrary,
} from "./componentLibrary";

export type PreflightResult =
  { ok: true; config: NetworkConfig } | { ok: false; errors: string[] };

// Component sources shipped with the bundled examples are implicitly trusted
// (the user got them from this app, not from an untrusted file).
let bundledComponentSources: Set<string> | null = null;
function getBundledComponentSources(): Set<string> {
  if (!bundledComponentSources) {
    bundledComponentSources = new Set(
      Object.values(examples).flatMap((example) =>
        Object.values(example.componentLibrary ?? {}).map(
          (entry) => entry.code,
        ),
      ),
    );
  }
  return bundledComponentSources;
}

export async function prepareRunConfig(
  config: NetworkConfig,
  options: { embedLocal?: boolean } = {},
): Promise<PreflightResult> {
  const embedLocal = options.embedLocal ?? true;
  try {
    const library = await refreshComponentLibrary();
    const cloned = cloneConfig(config);
    const bundled = getBundledComponentSources();
    const untrustedEmbedded = (
      await compareEmbeddedComponents(
        cloned.componentLibrary,
        library.components,
      )
    ).filter((entry) => {
      const source = cloned.componentLibrary?.[entry.key]?.code;
      return (
        entry.status !== "match" &&
        !isComponentSourceTrusted(entry.embeddedHash) &&
        !(source && bundled.has(source))
      );
    });
    if (untrustedEmbedded.length > 0) {
      return {
        ok: false,
        errors: [
          `Run blocked: embedded component code is not trusted (${untrustedEmbedded.map((entry) => entry.key).join(", ")}). ` +
            "Load the model file and approve its component code before running.",
        ],
      };
    }

    if (embedLocal) {
      const unavailable = embedReferencedComponents(cloned, library.components);
      if (unavailable.length > 0) {
        return {
          ok: false,
          errors: unavailable.map(
            (key) =>
              `User component "${key}" is not embedded and is unavailable from the local component library.`,
          ),
        };
      }
    } else {
      const missing = referencedButNotEmbedded(cloned);
      if (missing.length > 0) {
        return {
          ok: false,
          errors: missing.map(
            (key) =>
              `User component "${key}" is not embedded in the model. Embed it from the component library before sweeping.`,
          ),
        };
      }
    }

    const errs = validateNetwork(cloned);
    if (errs.length > 0) return { ok: false, errors: errs };
    return { ok: true, config: cloned };
  } catch (error) {
    return {
      ok: false,
      errors: [error instanceof Error ? error.message : String(error)],
    };
  }
}

function referencedButNotEmbedded(config: NetworkConfig): string[] {
  const missing = new Set<string>();
  for (const branch of config.branches) {
    if (
      branch.component.type === "userComponent" &&
      !config.componentLibrary?.[branch.component.component]
    )
      missing.add(branch.component.component);
  }
  return [...missing].sort();
}
