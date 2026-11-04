import { defineConfig } from "vitepress";
import path from "node:path";
import { createRequire } from "node:module";
import { unpublishedPosts } from "./blog";

// The Markdown sources live outside this package (../docs), so bare imports
// emitted into compiled pages ("vue", "vue/server-renderer") would resolve
// from the repo root, where Vue is not installed. Pin them to this package.
const require = createRequire(import.meta.url);
const vueDir = path.dirname(require.resolve("vue/package.json"));

/**
 * OpenFLUME documentation site.
 *
 * Source is the repository's own `docs/` folder, so the Markdown that renders
 * on GitHub and the published site are one and the same file. Links that
 * point out of `docs/` (to `../src`, `../scripts`, `../CHANGELOG.md`, …) are
 * rewritten to GitHub URLs at build time, so they work in both places.
 *
 * Deployed under the demo at https://openflume.github.io/OpenFLUME/docs/.
 */

const REPO = "https://github.com/OpenFLUME/OpenFLUME";
const SITE = "https://openflume.github.io/OpenFLUME";
const BASE = "/OpenFLUME/docs/";
const APP = `${SITE}/`;
const DESCRIPTION =
  "Open-source thermo-fluid network solver (GFSSP / SINDA-FLUINT class) that runs entirely in the browser. Steady and transient, real fluids, two-phase, conjugate heat transfer, combustion — verified against NASA benchmarks.";

const docsRoot = path.resolve(__dirname, "../../docs");

export default defineConfig({
  title: "OpenFLUME",
  titleTemplate: ":title · OpenFLUME",
  description: DESCRIPTION,
  lang: "en-US",
  base: BASE,
  srcDir: "../docs",
  outDir: "../dist/docs",
  cleanUrls: false,
  lastUpdated: false,
  // Blog posts dated in the future, or marked `draft: true`, are left out of
  // the build. The deploy workflow rebuilds daily, so a post goes live on
  // its date without a manual push.
  srcExclude: ["**/node_modules/**", ...unpublishedPosts()],
  sitemap: { hostname: `${SITE}/docs/` },
  ignoreDeadLinks: [/^https?:\/\/localhost/],

  head: [
    [
      "link",
      { rel: "icon", href: `${BASE}favicon.svg`, type: "image/svg+xml" },
    ],
    ["meta", { name: "theme-color", content: "#0b5cad" }],
    ["meta", { property: "og:type", content: "website" }],
    ["meta", { property: "og:site_name", content: "OpenFLUME" }],
    ["meta", { property: "og:image", content: `${SITE}/og-image.png` }],
    ["meta", { property: "og:image:width", content: "1280" }],
    ["meta", { property: "og:image:height", content: "640" }],
    ["meta", { name: "twitter:card", content: "summary_large_image" }],
    ["meta", { name: "twitter:image", content: `${SITE}/og-image.png` }],
  ],

  transformPageData(pageData) {
    const canonical = `${SITE}/docs/${pageData.relativePath}`
      .replace(/index\.md$/, "")
      .replace(/\.md$/, ".html");
    const title = pageData.frontmatter.title ?? pageData.title ?? "OpenFLUME";
    const description =
      pageData.frontmatter.description ?? pageData.description ?? DESCRIPTION;
    pageData.frontmatter.head ??= [];
    pageData.frontmatter.head.push(
      ["link", { rel: "canonical", href: canonical }],
      ["meta", { property: "og:url", content: canonical }],
      ["meta", { property: "og:title", content: `${title} · OpenFLUME` }],
      ["meta", { property: "og:description", content: description }],
      ["meta", { name: "twitter:title", content: `${title} · OpenFLUME` }],
      ["meta", { name: "twitter:description", content: description }],
    );
  },

  vite: {
    plugins: [
      {
        // Compiled pages live under ../docs; resolve their bare Vue imports
        // from this package. SSR keeps them external (loaded by Node from
        // site/node_modules); the client gets the runtime bundler build.
        name: "openflume-resolve-vue-from-site",
        enforce: "pre",
        resolveId(id, _importer, options) {
          if (id !== "vue" && id !== "vue/server-renderer") return null;
          if (options?.ssr) return { id, external: true };
          if (id === "vue")
            return path.join(vueDir, "dist/vue.runtime.esm-bundler.js");
          return null;
        },
      },
    ],
    server: { fs: { allow: [path.resolve(__dirname, "../..")] } },
  },

  markdown: {
    math: false,
    config(md) {
      // Rewrite relative links that escape docs/ into GitHub URLs.
      const defaultRender =
        md.renderer.rules.link_open ??
        ((tokens, idx, options, _env, self) =>
          self.renderToken(tokens, idx, options));
      md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
        const token = tokens[idx];
        const href = token.attrGet("href");
        if (href && !/^[a-z]+:|^#|^\//i.test(href) && env?.relativePath) {
          const [target, hash] = href.split("#");
          const fromDir = path.dirname(path.join(docsRoot, env.relativePath));
          const abs = path.resolve(fromDir, target);
          if (!abs.startsWith(docsRoot + path.sep) && abs !== docsRoot) {
            const repoPath = path.relative(path.dirname(docsRoot), abs);
            const kind = /\.[a-z0-9]+$/i.test(repoPath) ? "blob" : "tree";
            token.attrSet(
              "href",
              `${REPO}/${kind}/main/${repoPath}${hash ? `#${hash}` : ""}`,
            );
            token.attrSet("target", "_blank");
            token.attrSet("rel", "noreferrer");
          }
        }
        return defaultRender(tokens, idx, options, env, self);
      };
    },
  },

  themeConfig: {
    logo: { src: "/logo.svg", alt: "OpenFLUME" },
    siteTitle: false,
    nav: [
      { text: "Launch the app", link: APP, target: "_self" },
      { text: "Get started", link: "/guides/getting-started" },
      { text: "Manual", link: "/user-manual" },
      { text: "Verification", link: "/validation/" },
      { text: "Blog", link: "/blog/" },
      {
        text: "More",
        items: [
          { text: "Examples gallery", link: "/examples" },
          { text: "Python package", link: "/python" },
          { text: "Teaching with OpenFLUME", link: "/teach/" },
          { text: "Compare to GFSSP / SINDA", link: "/compare/" },
          { text: "Cite OpenFLUME", link: "/cite" },
          { text: "Changelog", link: `${REPO}/blob/main/CHANGELOG.md` },
        ],
      },
    ],
    sidebar: {
      "/": [
        {
          text: "Start",
          items: [
            { text: "Getting started", link: "/guides/getting-started" },
            { text: "Examples gallery", link: "/examples" },
            { text: "Tutorial: tank blowdown", link: "/guides/tank-blowdown" },
            {
              text: "Tutorial: propellant feed line",
              link: "/guides/feed-system",
            },
            {
              text: "Tutorial: cryogenic chilldown",
              link: "/guides/cryogenic-chilldown",
            },
            { text: "Sharing models", link: "/guides/sharing" },
            { text: "Coming from GFSSP", link: "/guides/from-gfssp" },
          ],
        },
        {
          text: "Reference",
          items: [
            { text: "User's manual", link: "/user-manual" },
            { text: "Python package", link: "/python" },
            { text: "Architecture", link: "/architecture" },
            { text: "Combustion", link: "/combustion" },
            { text: "User code", link: "/usercode" },
            { text: "Parameter bindings", link: "/parameter-bindings" },
            { text: "Fluid catalogue", link: "/fluid-catalogue" },
            { text: "Solid properties", link: "/solid-properties-results" },
            { text: "Fluid-front transport", link: "/fluid-front-transport" },
            { text: "Solver convergence", link: "/solver-convergence" },
            { text: "Real-fluid performance", link: "/real-fluid-performance" },
            { text: "Testing tiers", link: "/testing-slow" },
            { text: "Documentation index", link: "/README" },
          ],
        },
        {
          text: "Verification & validation",
          items: [
            { text: "Overview", link: "/validation/" },
            {
              text: "Compressible flow (GFSSP TFAWS-2007)",
              link: "/validation/compressible-report",
            },
            {
              text: "Incompressible hydraulics",
              link: "/validation/incompressible-hydraulics-report",
            },
            {
              text: "Thermal networks",
              link: "/validation/thermal-network-report",
            },
            {
              text: "Fluid transients",
              link: "/validation/fluid-transient-report",
            },
            {
              text: "Tank transients",
              link: "/validation/tank-transient-report",
            },
            { text: "Combustion", link: "/validation/combustion-report" },
            { text: "Microfluidics", link: "/validation/microfluidics-report" },
          ],
        },
        {
          text: "Comparisons",
          collapsed: true,
          items: [
            { text: "Overview", link: "/compare/" },
            { text: "vs. NASA GFSSP", link: "/compare/gfssp" },
            { text: "vs. SINDA/FLUINT", link: "/compare/sinda-fluint" },
            {
              text: "vs. commercial 1-D tools",
              link: "/compare/commercial-1d",
            },
          ],
        },
        {
          text: "Teaching",
          collapsed: true,
          items: [
            { text: "Overview", link: "/teach/" },
            {
              text: "Lab 1: pipe networks",
              link: "/teach/lab-1-pipe-networks",
            },
            {
              text: "Lab 2: tank blowdown",
              link: "/teach/lab-2-tank-blowdown",
            },
            {
              text: "Lab 3: conduction & fins",
              link: "/teach/lab-3-conduction",
            },
            { text: "Lab 4: Fanno flow", link: "/teach/lab-4-fanno-flow" },
          ],
        },
        {
          text: "Project",
          collapsed: true,
          items: [
            { text: "Blog", link: "/blog/" },
            { text: "Cite OpenFLUME", link: "/cite" },
            { text: "Contributing", link: `${REPO}/blob/main/CONTRIBUTING.md` },
          ],
        },
      ],
    },
    socialLinks: [{ icon: "github", link: REPO }],
    editLink: {
      pattern: `${REPO}/edit/main/docs/:path`,
      text: "Edit this page on GitHub",
    },
    search: { provider: "local" },
    outline: { level: [2, 3] },
    footer: {
      message:
        'MIT licensed · <a href="https://doi.org/10.5281/zenodo.22051608">DOI 10.5281/zenodo.22051608</a>',
      copyright: "OpenFLUME contributors",
    },
  },
});
