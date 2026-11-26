/**
 * Read-only embed mode for course pages and blogs (issue #26).
 *
 * `?embed=1` renders the app for embedding in an `<iframe>`: the model
 * can be run and its results read, but the app never writes to
 * localStorage, so an embed can never overwrite a visitor's autosaved
 * model. The fragment is preserved so `#example=<slug>` / `#model=…`
 * shared links keep working inside the embed.
 */

export const EMBED_QUERY_KEY = "embed";
export const EMBED_QUERY_VALUE = "1";

/** True when the URL query (`location.search`) enables embed mode. */
export function parseEmbedMode(search: string): boolean {
  return (
    new URLSearchParams(search.replace(/^\?/, "")).get(EMBED_QUERY_KEY) ===
    EMBED_QUERY_VALUE
  );
}

/**
 * URL for the same app in the full editor: same path and fragment, with
 * the embed parameter removed (and no other parameters dropped).
 */
export function buildFullEditorUrl(currentUrl: string): string {
  const url = new URL(currentUrl);
  url.searchParams.delete(EMBED_QUERY_KEY);
  return url.toString();
}
