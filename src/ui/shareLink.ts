/**
 * Shareable model links.
 *
 * A model travels in the URL *fragment* (`#model=…`), never the query string,
 * so it is not sent to any server — the GitHub Pages host only ever sees the
 * bare page request. This keeps the "nothing leaves your machine" property:
 * a link is the model, not a pointer to an upload.
 *
 * Two fragment forms are recognised:
 *
 *   #example=<slug>   open a built-in example by its stable slug
 *   #model=<payload>  open an inline model; payload is the `.fn` text,
 *                     deflate-raw compressed, base64url encoded
 *
 * Loading a link never bypasses the normal guards: the decoded text goes
 * through the same parse → validate → embedded-code trust path as a file
 * opened with Load (see Toolbar).
 */
import { examples } from "./examples";

export const MODEL_FRAGMENT_KEY = "model";
export const EXAMPLE_FRAGMENT_KEY = "example";

/**
 * Practical ceiling for a shared URL. Browsers accept far longer fragments,
 * but chat apps, forums, and email clients start truncating or refusing
 * links well before that. Above this we still produce a link but warn.
 */
export const SHARE_URL_SOFT_LIMIT = 8000;

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

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function base64UrlToBytes(input: string): Uint8Array {
  const b64 = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function pipeThrough(
  bytes: Uint8Array,
  stream: CompressionStream | DecompressionStream,
): Promise<Uint8Array> {
  const body = new Blob([bytes as BlobPart]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(body).arrayBuffer());
}

/** `.fn` text → compact URL-safe payload. */
export async function encodeModelPayload(text: string): Promise<string> {
  const raw = new TextEncoder().encode(text);
  const compressed = await pipeThrough(
    raw,
    new CompressionStream("deflate-raw"),
  );
  return bytesToBase64Url(compressed);
}

/** URL payload → `.fn` text. Throws on malformed input. */
export async function decodeModelPayload(payload: string): Promise<string> {
  const compressed = base64UrlToBytes(payload);
  const raw = await pipeThrough(
    compressed,
    new DecompressionStream("deflate-raw"),
  );
  return new TextDecoder().decode(raw);
}

export type ShareFragment =
  | { kind: "example"; slug: string; name: string | undefined }
  | { kind: "model"; payload: string }
  | { kind: "none" };

/** Parse `location.hash` (with or without the leading `#`). */
export function parseShareFragment(hash: string): ShareFragment {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const payload = params.get(MODEL_FRAGMENT_KEY);
  if (payload) return { kind: "model", payload };
  const slug = params.get(EXAMPLE_FRAGMENT_KEY);
  if (slug) return { kind: "example", slug, name: exampleNameFromSlug(slug) };
  return { kind: "none" };
}

/** App base URL (origin + Vite base path) with no fragment. */
export function appBaseUrl(
  location: Pick<Location, "origin" | "pathname">,
): string {
  return `${location.origin}${location.pathname}`;
}

export async function buildModelShareUrl(
  baseUrl: string,
  fnText: string,
): Promise<string> {
  return `${baseUrl}#${MODEL_FRAGMENT_KEY}=${await encodeModelPayload(fnText)}`;
}

export function buildExampleShareUrl(baseUrl: string, name: string): string {
  return `${baseUrl}#${EXAMPLE_FRAGMENT_KEY}=${exampleSlug(name)}`;
}
