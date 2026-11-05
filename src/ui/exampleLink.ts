/**
 * Example deep links.
 *
 * `#example=<slug>` in the app URL opens a built-in example by a stable,
 * URL-safe slug derived from its display name, for example
 * `#example=tank-blowdown`. The fragment is never sent to a server.
 */
import { examples } from "./examples";

export const EXAMPLE_FRAGMENT_KEY = "example";

/** Stable, URL-safe slug for an example display name. */
export function exampleSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/\+/g, " plus ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Slug → example display name, for every shipped example. */
export function exampleSlugMap(): Map<string, string> {
  const map = new Map<string, string>();
  for (const name of Object.keys(examples)) map.set(exampleSlug(name), name);
  return map;
}

export function exampleNameFromSlug(slug: string): string | undefined {
  return exampleSlugMap().get(slug.toLowerCase());
}

export type ExampleFragment =
  | { kind: "example"; slug: string; name: string | undefined }
  | { kind: "none" };

/** Parse `location.hash` (with or without the leading `#`). */
export function parseExampleFragment(hash: string): ExampleFragment {
  const slug = new URLSearchParams(hash.replace(/^#/, "")).get(
    EXAMPLE_FRAGMENT_KEY,
  );
  if (slug) return { kind: "example", slug, name: exampleNameFromSlug(slug) };
  return { kind: "none" };
}

export function buildExampleUrl(baseUrl: string, name: string): string {
  return `${baseUrl}#${EXAMPLE_FRAGMENT_KEY}=${exampleSlug(name)}`;
}
