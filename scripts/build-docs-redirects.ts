/**
 * Redirect stubs for the documentation's old address.
 *
 * The docs used to be served under the app at
 * https://openflume.github.io/OpenFLUME/docs/. They now live at
 * https://openflume.github.io/. This writes one small HTML page per docs page
 * into dist/docs/ (deployed with the app), each redirecting to the same page
 * on the new site, so links already shared keep working.
 *
 *   npx tsx scripts/build-docs-redirects.ts   # after `npm run build`
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DOCS = path.join(ROOT, "docs");
const OUT = path.join(ROOT, "dist", "docs");
const NEW_SITE = "https://openflume.github.io/";

function markdownFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "public" || entry.name === "figures"
        ? []
        : markdownFiles(full);
    }
    return entry.name.endsWith(".md") ? [full] : [];
  });
}

/** docs/a/b.md → "a/b.html"; docs/a/index.md → "a/". */
export function pagePath(relativeMd: string): string {
  const posix = relativeMd.split(path.sep).join("/");
  if (posix === "index.md") return "";
  if (posix.endsWith("/index.md")) return posix.slice(0, -"index.md".length);
  return posix.replace(/\.md$/, ".html");
}

function stub(target: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Moved to ${target}</title>
<link rel="canonical" href="${target}">
<meta name="robots" content="noindex">
<meta http-equiv="refresh" content="0; url=${target}">
<script>location.replace(${JSON.stringify(target)} + location.hash);</script>
</head>
<body>The OpenFLUME documentation has moved to <a href="${target}">${target}</a>.</body>
</html>
`;
}

let count = 0;
for (const file of markdownFiles(DOCS)) {
  const page = pagePath(path.relative(DOCS, file));
  const target = NEW_SITE + page;
  const outFile = path.join(
    OUT,
    page === "" || page.endsWith("/") ? path.join(page, "index.html") : page,
  );
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, stub(target));
  count++;
}
console.log(`wrote ${count} redirect stubs to ${path.relative(ROOT, OUT)}/`);
