import fs from "node:fs";
import path from "node:path";

/**
 * Blog post scheduling.
 *
 * A post in docs/blog/ is published when its front-matter `date` (YYYY-MM-DD,
 * UTC) is today or earlier and it is not marked `draft: true`. Unpublished
 * posts are excluded from the build entirely, so they cannot be reached or
 * indexed early, and the blog index (posts.data.ts) lists only published
 * ones. The OpenFLUME/openflume.github.io workflow rebuilds the site hourly,
 * which rolls scheduled posts out on their date.
 *
 * Set OPENFLUME_BLOG_PREVIEW=1 to build every post (local preview).
 */

const blogDir = path.resolve(__dirname, "../../docs/blog");

export interface PostMeta {
  file: string;
  title: string;
  description: string;
  date: string;
  draft: boolean;
}

function frontMatter(text: string): Record<string, string> {
  const match = /^---\n([\s\S]*?)\n---/.exec(text);
  const out: Record<string, string> = {};
  if (!match) return out;
  for (const line of match[1].split("\n")) {
    const kv = /^([A-Za-z_]+):\s*(.*)$/.exec(line);
    if (kv) out[kv[1]] = kv[2].replace(/^["']|["']$/g, "").trim();
  }
  return out;
}

export function allPosts(): PostMeta[] {
  if (!fs.existsSync(blogDir)) return [];
  return fs
    .readdirSync(blogDir)
    .filter((f) => f.endsWith(".md") && f !== "index.md")
    .map((file) => {
      const fm = frontMatter(fs.readFileSync(path.join(blogDir, file), "utf8"));
      return {
        file,
        title: fm.title ?? file,
        description: fm.description ?? "",
        date: fm.date ?? "9999-12-31",
        draft: fm.draft === "true",
      };
    })
    .sort((a, b) => b.date.localeCompare(a.date));
}

export function isPublished(post: PostMeta, now = new Date()): boolean {
  if (process.env.OPENFLUME_BLOG_PREVIEW === "1") return true;
  const today = now.toISOString().slice(0, 10);
  return !post.draft && post.date <= today;
}

/** srcExclude globs (relative to docs/) for posts not yet published. */
export function unpublishedPosts(): string[] {
  return allPosts()
    .filter((p) => !isPublished(p))
    .map((p) => `blog/${p.file}`);
}
