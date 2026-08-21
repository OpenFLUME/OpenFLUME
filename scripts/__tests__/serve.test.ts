/**
 * Unit/integration tests for the local-first companion server (scripts/serve.ts).
 *
 * The scan/path/create helpers are imported directly (no listener); the HTTP
 * layer — including the constrained POST /api/library/components creation
 * endpoint — is exercised on an ephemeral localhost port against temp
 * directories.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as http from "node:http";
import * as net from "node:net";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AddressInfo } from "node:net";
import {
  ComponentConflictError,
  createLibraryComponent,
  createRequestHandler,
  isLoopbackHost,
  isValidComponentFileName,
  MAX_COMPONENT_BODY_BYTES,
  MAX_COMPONENT_FILE_BYTES,
  mimeTypeFor,
  resolveConfig,
  resolveStaticPath,
  scanLibrary,
} from "../serve";

let tmpRoot: string;
let libraryDir: string;
let distDir: string;

async function writeFile(rel: string, content: string): Promise<void> {
  const full = path.join(tmpRoot, rel);
  await fsp.mkdir(path.dirname(full), { recursive: true });
  await fsp.writeFile(full, content, "utf8");
}

beforeAll(async () => {
  tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "fluids-serve-test-"));
  libraryDir = path.join(tmpRoot, "library", "components");
  distDir = path.join(tmpRoot, "dist");

  // Library fixture: nested components + files that must be ignored.
  await writeFile(
    "library/components/zeta.component.js",
    'defineComponent({ id: "zeta" });\n',
  );
  await writeFile(
    "library/components/alpha.component.js",
    'defineComponent({ id: "alpha" });\n',
  );
  await writeFile(
    "library/components/nested/beta.component.js",
    'defineComponent({ id: "beta" });\n',
  );
  await writeFile("library/components/notes.js", "// not a component\n");
  await writeFile("library/components/draft.component.ts", "// wrong suffix\n");
  await writeFile("library/components/README.md", "# docs\n");

  // Static build fixture.
  await writeFile("dist/index.html", "<!doctype html><title>app</title>\n");
  await writeFile("dist/assets/app.js", 'console.log("app");\n');
  await writeFile("dist/assets/app.css", "body { margin: 0; }\n");
});

afterAll(async () => {
  await fsp.rm(tmpRoot, { recursive: true, force: true });
});

describe("scanLibrary", () => {
  it("recursively finds only *.component.js files, sorted deterministically", async () => {
    const { components, warnings } = await scanLibrary(libraryDir);
    expect(components.map((c) => c.path)).toEqual([
      "alpha.component.js",
      "nested/beta.component.js",
      "zeta.component.js",
    ]);
    expect(warnings).toEqual([]);
  });

  it("returns source and ISO modifiedAt for each component", async () => {
    const { components } = await scanLibrary(libraryDir);
    const alpha = components.find((c) => c.path === "alpha.component.js");
    expect(alpha?.source).toContain('id: "alpha"');
    expect(alpha?.modifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(Number.isNaN(Date.parse(alpha!.modifiedAt))).toBe(false);
  });

  it("returns an empty result when the library directory does not exist", async () => {
    await expect(
      scanLibrary(path.join(tmpRoot, "no-such-dir")),
    ).resolves.toEqual({
      components: [],
      warnings: [],
    });
  });

  it("blocks symlink escapes outside the library root", async () => {
    const outside = path.join(tmpRoot, "secret.component.js");
    await fsp.writeFile(
      outside,
      'defineComponent({ id: "secret" });\n',
      "utf8",
    );
    let linkCreated = true;
    try {
      await fsp.symlink(outside, path.join(libraryDir, "escape.component.js"));
    } catch {
      linkCreated = false; // platform without symlink permission — nothing to assert
    }
    try {
      const { components } = await scanLibrary(libraryDir);
      const paths = components.map((c) => c.path);
      expect(paths).not.toContain("escape.component.js");
      expect(components.some((c) => c.source.includes("secret"))).toBe(false);
      if (linkCreated) {
        // And the legitimate entries still scan fine.
        expect(paths).toContain("alpha.component.js");
      }
    } finally {
      await fsp.rm(path.join(libraryDir, "escape.component.js"), {
        force: true,
      });
      await fsp.rm(outside, { force: true });
    }
  });
});

describe("scanLibrary limits", () => {
  async function makeLibrary(
    name: string,
    files: Record<string, string>,
  ): Promise<string> {
    const dir = path.join(tmpRoot, name);
    for (const [rel, content] of Object.entries(files)) {
      const full = path.join(dir, rel);
      await fsp.mkdir(path.dirname(full), { recursive: true });
      await fsp.writeFile(full, content, "utf8");
    }
    return dir;
  }

  it("skips files over the per-file size limit with a warning (default limits)", async () => {
    const dir = await makeLibrary("limit-size", {
      "ok.component.js": 'defineComponent({ id: "ok" });\n',
      "huge.component.js": `// ${"x".repeat(MAX_COMPONENT_FILE_BYTES)}`,
    });
    const { components, warnings } = await scanLibrary(dir);
    expect(components.map((c) => c.path)).toEqual(["ok.component.js"]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("huge.component.js");
    expect(warnings[0]).toContain(`${MAX_COMPONENT_FILE_BYTES}`);
  });

  it("serves a file exactly at the per-file size limit", async () => {
    const dir = await makeLibrary("limit-size-exact", {
      "max.component.js": "x".repeat(MAX_COMPONENT_FILE_BYTES),
    });
    const { components, warnings } = await scanLibrary(dir);
    expect(components.map((c) => c.path)).toEqual(["max.component.js"]);
    expect(warnings).toEqual([]);
  });

  it("applies the count limit deterministically in sorted path order", async () => {
    const dir = await makeLibrary("limit-count", {
      "a.component.js": 'defineComponent({ id: "a" });\n',
      "b.component.js": 'defineComponent({ id: "b" });\n',
      "c.component.js": 'defineComponent({ id: "c" });\n',
    });
    const first = await scanLibrary(dir, { maxFiles: 2 });
    const second = await scanLibrary(dir, { maxFiles: 2 });
    expect(first.components.map((c) => c.path)).toEqual([
      "a.component.js",
      "b.component.js",
    ]);
    expect(first.warnings).toHaveLength(1);
    expect(first.warnings[0]).toMatch(/count limit.*first 2 of 3/);
    expect(second).toEqual(first); // fully deterministic, warnings included
  });

  it("applies the aggregate byte limit, omitting the rest with a warning", async () => {
    const dir = await makeLibrary("limit-total", {
      "a.component.js": "a".repeat(10),
      "b.component.js": "b".repeat(10),
      "c.component.js": "c".repeat(10),
    });
    const { components, warnings } = await scanLibrary(dir, {
      maxTotalBytes: 25,
    });
    expect(components.map((c) => c.path)).toEqual([
      "a.component.js",
      "b.component.js",
    ]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/Aggregate size limit/);
    expect(warnings[0]).toContain("25");
  });
});

describe("isValidComponentFileName", () => {
  it("accepts slug-like basenames", () => {
    for (const ok of ["a", "pump", "pump-2", "a1-b2", "0", "x".repeat(64)]) {
      expect(isValidComponentFileName(ok), ok).toBe(true);
    }
  });

  it("rejects anything that is not a simple slug basename", () => {
    for (const bad of [
      "",
      "..",
      "../evil",
      "a/b",
      "a\\b",
      "Foo",
      "foo bar",
      "foo_bar",
      "foo.component",
      "foo.component.js",
      "-foo",
      "foo-",
      "foo--bar",
      "é",
      "x".repeat(65),
    ]) {
      expect(isValidComponentFileName(bad), JSON.stringify(bad)).toBe(false);
    }
  });
});

describe("createLibraryComponent", () => {
  it("creates the library directory when missing, writes the file, and returns its record", async () => {
    const dir = path.join(tmpRoot, "unit-create", "components");
    const source = 'defineComponent({ id: "unit" });\n';
    const record = await createLibraryComponent(dir, "unit-pump", source);
    expect(record.path).toBe("unit-pump.component.js");
    expect(record.source).toBe(source);
    expect(Number.isNaN(Date.parse(record.modifiedAt))).toBe(false);
    await expect(
      fsp.readFile(path.join(dir, "unit-pump.component.js"), "utf8"),
    ).resolves.toBe(source);
  });

  it("refuses to overwrite an existing file (ComponentConflictError)", async () => {
    const dir = path.join(tmpRoot, "unit-create", "components");
    const source = 'defineComponent({ id: "unit" });\n';
    await expect(
      createLibraryComponent(dir, "unit-pump", "changed"),
    ).rejects.toBeInstanceOf(ComponentConflictError);
    // The original content is untouched.
    await expect(
      fsp.readFile(path.join(dir, "unit-pump.component.js"), "utf8"),
    ).resolves.toBe(source);
  });

  it("rejects invalid file names before touching the filesystem", async () => {
    const dir = path.join(tmpRoot, "unit-create-names");
    await expect(createLibraryComponent(dir, "../evil", "x")).rejects.toThrow(
      /Invalid component file name/,
    );
    await expect(fsp.stat(dir)).rejects.toThrow(/ENOENT/);
  });
});

describe("resolveStaticPath", () => {
  it("resolves ordinary paths inside the root", () => {
    const resolved = resolveStaticPath(distDir, "/assets/app.js");
    expect(resolved).toBe(path.join(path.resolve(distDir), "assets", "app.js"));
  });

  it("normalizes plain dot segments so they cannot escape", () => {
    const resolved = resolveStaticPath(distDir, "/../../package.json");
    expect(resolved).toBe(path.join(path.resolve(distDir), "package.json"));
  });

  it("normalizes percent-encoded dot segments so they cannot escape", () => {
    const resolved = resolveStaticPath(distDir, "/%2e%2e/%2e%2e/package.json");
    expect(resolved).toBe(path.join(path.resolve(distDir), "package.json"));
  });

  it("rejects malformed percent-encoding and NUL bytes", () => {
    expect(resolveStaticPath(distDir, "/%E0%A4%A")).toBeNull();
    expect(resolveStaticPath(distDir, "/index.html%00.png")).toBeNull();
  });
});

describe("mimeTypeFor", () => {
  it("maps common build assets", () => {
    expect(mimeTypeFor("index.html")).toBe("text/html; charset=utf-8");
    expect(mimeTypeFor("app.JS")).toBe("text/javascript; charset=utf-8");
    expect(mimeTypeFor("app.css")).toBe("text/css; charset=utf-8");
    expect(mimeTypeFor("data.json")).toBe("application/json; charset=utf-8");
    expect(mimeTypeFor("icon.svg")).toBe("image/svg+xml");
    expect(mimeTypeFor("font.woff2")).toBe("font/woff2");
    expect(mimeTypeFor("module.wasm")).toBe("application/wasm");
  });

  it("falls back to application/octet-stream for unknown extensions", () => {
    expect(mimeTypeFor("archive.xyz")).toBe("application/octet-stream");
  });
});

describe("isLoopbackHost", () => {
  it("treats IPv4 loopback, ::1, and localhost as loopback", () => {
    for (const host of [
      "127.0.0.1",
      "127.0.0.2",
      "127.42.9.9",
      "localhost",
      "LOCALHOST",
      "localhost.",
      "::1",
      "[::1]",
      "0:0:0:0:0:0:0:1",
      "::ffff:127.0.0.1",
      " 127.0.0.1 ",
    ]) {
      expect(isLoopbackHost(host), host).toBe(true);
    }
  });

  it("treats wildcards and other addresses as non-loopback (fail closed)", () => {
    for (const host of [
      "0.0.0.0",
      "::",
      "[::]",
      "192.168.1.10",
      "10.0.0.5",
      "128.0.0.1",
      "example.com",
      "myhost.local",
      "localhost.evil.com",
      "",
    ]) {
      expect(isLoopbackHost(host), host).toBe(false);
    }
  });
});

describe("resolveConfig", () => {
  it("applies defaults rooted at the repo", () => {
    const config = resolveConfig({});
    expect(config.port).toBe(4174);
    expect(config.host).toBe("127.0.0.1");
    expect(config.distDir).toBe(
      path.resolve(import.meta.dirname, "..", "..", "dist"),
    );
    expect(config.libraryDir).toBe(
      path.resolve(import.meta.dirname, "..", "..", "library", "components"),
    );
    expect(config.allowRemoteWrites).toBe(false);
  });

  it("enables remote writes only for the literal ALLOW_REMOTE_WRITES=1", () => {
    for (const value of ["true", "yes", "0", ""]) {
      expect(
        resolveConfig({ ALLOW_REMOTE_WRITES: value } as NodeJS.ProcessEnv)
          .allowRemoteWrites,
        JSON.stringify(value),
      ).toBe(false);
    }
    expect(
      resolveConfig({ ALLOW_REMOTE_WRITES: "1" } as NodeJS.ProcessEnv)
        .allowRemoteWrites,
    ).toBe(true);
  });

  it("honours PORT/HOST/DIST_DIR/LIBRARY_DIR overrides", () => {
    const config = resolveConfig({
      PORT: "9999",
      HOST: "localhost",
      DIST_DIR: "custom-dist",
      LIBRARY_DIR: "/tmp/my-library",
    } as NodeJS.ProcessEnv);
    expect(config.port).toBe(9999);
    expect(config.host).toBe("localhost");
    expect(config.distDir).toBe(path.resolve("custom-dist"));
    expect(config.libraryDir).toBe("/tmp/my-library");
  });

  it("rejects invalid ports", () => {
    expect(() => resolveConfig({ PORT: "abc" } as NodeJS.ProcessEnv)).toThrow(
      /Invalid PORT/,
    );
    expect(() => resolveConfig({ PORT: "0" } as NodeJS.ProcessEnv)).toThrow(
      /Invalid PORT/,
    );
    expect(() => resolveConfig({ PORT: "70000" } as NodeJS.ProcessEnv)).toThrow(
      /Invalid PORT/,
    );
  });
});

describe("HTTP handler (ephemeral port)", () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = http.createServer(createRequestHandler({ distDir, libraryDir }));
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  });

  it("GET /api/library returns the discovery payload with cache disabled", async () => {
    const res = await fetch(`${baseUrl}/api/library`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body.components.map((c: { path: string }) => c.path)).toEqual([
      "alpha.component.js",
      "nested/beta.component.js",
      "zeta.component.js",
    ]);
    expect(body.components[0]).toHaveProperty("source");
    expect(body.components[0]).toHaveProperty("modifiedAt");
    // Clean scan: the optional warnings field stays absent (shape preserved).
    expect(body).not.toHaveProperty("warnings");
  });

  it("rejects non-GET methods on /api/library", async () => {
    const res = await fetch(`${baseUrl}/api/library`, { method: "POST" });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET");
  });

  it("serves static files with suitable MIME types", async () => {
    const js = await fetch(`${baseUrl}/assets/app.js`);
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toBe(
      "text/javascript; charset=utf-8",
    );
    expect(await js.text()).toContain('console.log("app")');

    const css = await fetch(`${baseUrl}/assets/app.css`);
    expect(css.headers.get("content-type")).toBe("text/css; charset=utf-8");
  });

  it("serves index.html at the root", async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("<title>app</title>");
  });

  it("falls back to index.html for extension-less SPA routes", async () => {
    const res = await fetch(`${baseUrl}/runs/abc-123/review`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<title>app</title>");
  });

  it("404s missing files that look like assets", async () => {
    const res = await fetch(`${baseUrl}/assets/missing.js`);
    expect(res.status).toBe(404);
  });

  it("never serves files outside the static root", async () => {
    const res = await fetch(`${baseUrl}/%2e%2e/%2e%2e/%2e%2e/package.json`);
    // Normalized into dist/, where package.json does not exist -> 404.
    // Critically, it must NOT be the repo package.json.
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('"openflume"');
  });

  it("refuses to serve a symlinked file that escapes the static root", async () => {
    const secret = path.join(tmpRoot, "secret-static.txt");
    await fsp.writeFile(secret, "TOP SECRET STATIC CONTENTS\n", "utf8");
    const link = path.join(distDir, "leak.txt");
    let linkCreated = true;
    try {
      await fsp.symlink(secret, link);
    } catch {
      linkCreated = false; // platform without symlink permission — nothing to assert
    }
    try {
      const res = await fetch(`${baseUrl}/leak.txt`);
      if (linkCreated) {
        expect(res.status).toBe(404);
        expect(await res.text()).not.toContain("TOP SECRET");
      }
    } finally {
      await fsp.rm(link, { force: true });
      await fsp.rm(secret, { force: true });
    }
  });

  it("refuses to serve files through a symlinked directory that escapes the static root", async () => {
    const outsideDir = path.join(tmpRoot, "outside-static");
    await fsp.mkdir(outsideDir, { recursive: true });
    await fsp.writeFile(
      path.join(outsideDir, "secret.txt"),
      "TOP SECRET DIR CONTENTS\n",
      "utf8",
    );
    const link = path.join(distDir, "dirlink");
    let linkCreated = true;
    try {
      await fsp.symlink(outsideDir, link, "dir");
    } catch {
      linkCreated = false; // platform without symlink permission — nothing to assert
    }
    try {
      if (linkCreated) {
        const file = await fetch(`${baseUrl}/dirlink/secret.txt`);
        expect(file.status).toBe(404);
        expect(await file.text()).not.toContain("TOP SECRET");
        // Even the directory-index probe must not leak outside content.
        const index = await fetch(`${baseUrl}/dirlink/index.html`);
        expect(index.status).toBe(404);
        expect(await index.text()).not.toContain("TOP SECRET");
      }
    } finally {
      await fsp.rm(link, { force: true });
      await fsp.rm(outsideDir, { recursive: true, force: true });
    }
  });

  it("still serves symlinks that resolve inside the static root", async () => {
    const link = path.join(distDir, "linked-app.js");
    let linkCreated = true;
    try {
      await fsp.symlink(path.join(distDir, "assets", "app.js"), link);
    } catch {
      linkCreated = false; // platform without symlink permission — nothing to assert
    }
    try {
      if (linkCreated) {
        const res = await fetch(`${baseUrl}/linked-app.js`);
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toBe(
          "text/javascript; charset=utf-8",
        );
        expect(await res.text()).toContain('console.log("app")');
      }
    } finally {
      await fsp.rm(link, { force: true });
    }
  });

  it("rejects non-GET/HEAD methods on static paths", async () => {
    const res = await fetch(`${baseUrl}/assets/app.js`, { method: "DELETE" });
    expect(res.status).toBe(405);
  });

  it("supports HEAD without a body", async () => {
    const res = await fetch(`${baseUrl}/assets/app.js`, { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(Number(res.headers.get("content-length"))).toBeGreaterThan(0);
    expect(await res.text()).toBe("");
  });
});

describe("POST /api/library/components (ephemeral port)", () => {
  let server: http.Server;
  let baseUrl: string;
  // Intentionally NOT created beforehand — the endpoint must mkdir it.
  let createLibraryDir: string;

  beforeAll(async () => {
    createLibraryDir = path.join(tmpRoot, "created-library", "components");
    server = http.createServer(
      createRequestHandler({ distDir, libraryDir: createLibraryDir }),
    );
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  });

  function post(
    body: unknown,
    contentType = "application/json",
  ): Promise<Response> {
    return fetch(`${baseUrl}/api/library/components`, {
      method: "POST",
      headers: { "content-type": contentType },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  }

  it("creates a component (201) which then appears in GET /api/library", async () => {
    const source = 'defineComponent({ id: "gamma" });\n';
    const res = await post({ fileName: "gamma", source });
    expect(res.status).toBe(201);
    expect(res.headers.get("content-type")).toContain("application/json");
    const record = await res.json();
    expect(record.path).toBe("gamma.component.js");
    expect(record.source).toBe(source);
    expect(Number.isNaN(Date.parse(record.modifiedAt))).toBe(false);

    // The (previously missing) library directory was created, with the file
    // directly under the root.
    await expect(
      fsp.readFile(path.join(createLibraryDir, "gamma.component.js"), "utf8"),
    ).resolves.toBe(source);

    // Discovery on the same server sees the new component.
    const list = await fetch(`${baseUrl}/api/library`);
    expect(list.status).toBe(200);
    const body = await list.json();
    expect(body.components.map((c: { path: string }) => c.path)).toContain(
      "gamma.component.js",
    );
  });

  it("returns 409 on duplicate names and never overwrites the existing file", async () => {
    const original = 'defineComponent({ id: "dupe" });\n';
    const first = await post({ fileName: "dupe", source: original });
    expect(first.status).toBe(201);
    await first.text();

    const second = await post({
      fileName: "dupe",
      source: 'defineComponent({ id: "evil" });\n',
    });
    expect(second.status).toBe(409);
    const err = await second.json();
    expect(err.error).toContain("dupe.component.js");

    await expect(
      fsp.readFile(path.join(createLibraryDir, "dupe.component.js"), "utf8"),
    ).resolves.toBe(original);
  });

  it("rejects invalid and traversal file names with 400 and writes nothing", async () => {
    const before = await fsp.readdir(createLibraryDir);
    const badNames = [
      "../evil",
      "..",
      "a/b",
      "a\\b",
      "Foo",
      "foo bar",
      "foo_bar",
      "foo.component",
      "-foo",
      "foo-",
      "foo--bar",
      "",
      "x".repeat(65),
    ];
    for (const fileName of badNames) {
      const res = await post({ fileName, source: "defineComponent({});\n" });
      expect(res.status, `fileName ${JSON.stringify(fileName)}`).toBe(400);
      expect((await res.json()).error).toMatch(/fileName/);
    }
    // No new files inside the library root...
    const after = await fsp.readdir(createLibraryDir);
    expect(after.sort()).toEqual(before.sort());
    // ...and nothing escaped outside it (where a naive join of "../evil"
    // would have landed).
    await expect(
      fsp.stat(path.join(createLibraryDir, "..", "evil.component.js")),
    ).rejects.toThrow(/ENOENT/);
  });

  it("rejects missing, empty, or wrongly-typed fields with 400", async () => {
    const bodies = [
      {},
      { fileName: "ok-name" },
      { source: "defineComponent({});\n" },
      { fileName: "ok-name", source: "" },
      { fileName: "ok-name", source: 42 },
      { fileName: 42, source: "x" },
    ];
    for (const body of bodies) {
      const res = await post(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      await res.text();
    }
    await expect(
      fsp.stat(path.join(createLibraryDir, "ok-name.component.js")),
    ).rejects.toThrow(/ENOENT/);
  });

  it("rejects malformed or non-object JSON with 400", async () => {
    for (const raw of [
      '{"fileName": ',
      "not json",
      "[1,2]",
      "null",
      '"str"',
      "42",
      "",
    ]) {
      const res = await post(raw);
      expect(res.status, JSON.stringify(raw)).toBe(400);
      await res.text();
    }
  });

  it("rejects bodies over the 256 KiB cap with 413 and writes nothing", async () => {
    const source = `// ${"x".repeat(MAX_COMPONENT_BODY_BYTES)}`;
    const res = await post({ fileName: "too-big", source });
    expect(res.status).toBe(413);
    expect((await res.json()).error).toMatch(/limit/);
    await expect(
      fsp.stat(path.join(createLibraryDir, "too-big.component.js")),
    ).rejects.toThrow(/ENOENT/);
  });

  it("rejects wrong content types with 415", async () => {
    const res = await post(
      { fileName: "ct-test", source: "defineComponent({});\n" },
      "text/plain",
    );
    expect(res.status).toBe(415);
    expect((await res.json()).error).toMatch(/application\/json/);
    await expect(
      fsp.stat(path.join(createLibraryDir, "ct-test.component.js")),
    ).rejects.toThrow(/ENOENT/);
  });

  it("accepts application/json with a charset parameter", async () => {
    const res = await post(
      {
        fileName: "charset-ok",
        source: 'defineComponent({ id: "charset-ok" });\n',
      },
      "application/json; charset=utf-8",
    );
    expect(res.status).toBe(201);
    expect((await res.json()).path).toBe("charset-ok.component.js");
  });

  it("allows only POST on the creation endpoint", async () => {
    for (const method of ["GET", "PUT", "DELETE"]) {
      const res = await fetch(`${baseUrl}/api/library/components`, { method });
      expect(res.status, method).toBe(405);
      expect(res.headers.get("allow")).toBe("POST");
      await res.text();
    }
  });
});

describe("GET /api/library scan-limit warnings (ephemeral port)", () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    const limitedDir = path.join(tmpRoot, "limited-library", "components");
    await fsp.mkdir(limitedDir, { recursive: true });
    await fsp.writeFile(
      path.join(limitedDir, "ok.component.js"),
      'defineComponent({ id: "ok" });\n',
      "utf8",
    );
    // One byte over the default per-file scan limit.
    await fsp.writeFile(
      path.join(limitedDir, "huge.component.js"),
      `// ${"x".repeat(MAX_COMPONENT_FILE_BYTES)}`,
      "utf8",
    );
    server = http.createServer(
      createRequestHandler({ distDir, libraryDir: limitedDir }),
    );
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  });

  it("lists valid components and reports skipped files in warnings", async () => {
    const res = await fetch(`${baseUrl}/api/library`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.components.map((c: { path: string }) => c.path)).toEqual([
      "ok.component.js",
    ]);
    expect(Array.isArray(body.warnings)).toBe(true);
    expect(body.warnings).toHaveLength(1);
    expect(body.warnings[0]).toContain("huge.component.js");
  });
});

describe("non-loopback write safety (ephemeral ports)", () => {
  // The gate keys off the CONFIGURED bind address (options.host); the test
  // listeners themselves stay on loopback so nothing here touches the LAN.
  let serverDefault: http.Server;
  let serverGated: http.Server;
  let serverFlag: http.Server;
  let serverV6: http.Server;
  let baseDefault: string;
  let baseGated: string;
  let baseFlag: string;
  let baseV6: string;
  let gatedDir: string;

  async function listen(
    options: Parameters<typeof createRequestHandler>[0],
  ): Promise<{ server: http.Server; baseUrl: string }> {
    const server = http.createServer(createRequestHandler(options));
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const { port } = server.address() as AddressInfo;
    return { server, baseUrl: `http://127.0.0.1:${port}` };
  }

  beforeAll(async () => {
    const root = path.join(tmpRoot, "gated-library");
    gatedDir = path.join(root, "gated", "components");
    ({ server: serverDefault, baseUrl: baseDefault } = await listen({
      distDir,
      libraryDir: path.join(root, "default", "components"),
    }));
    ({ server: serverGated, baseUrl: baseGated } = await listen({
      distDir,
      libraryDir: gatedDir,
      host: "0.0.0.0", // every interface — non-loopback
    }));
    ({ server: serverFlag, baseUrl: baseFlag } = await listen({
      distDir,
      libraryDir: path.join(root, "flag", "components"),
      host: "0.0.0.0",
      allowRemoteWrites: true,
    }));
    ({ server: serverV6, baseUrl: baseV6 } = await listen({
      distDir,
      libraryDir: path.join(root, "v6", "components"),
      host: "::1",
    }));
  });

  afterAll(async () => {
    for (const server of [serverDefault, serverGated, serverFlag, serverV6]) {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    }
  });

  function post(baseUrl: string, fileName: string): Promise<Response> {
    return fetch(`${baseUrl}/api/library/components`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        fileName,
        source: 'defineComponent({ id: "w" });\n',
      }),
    });
  }

  it("keeps creation enabled with the loopback default options", async () => {
    const res = await post(baseDefault, "default-write");
    expect(res.status).toBe(201);
    await res.text();
  });

  it("disables creation with 403 on a non-loopback bind and writes nothing", async () => {
    const res = await post(baseGated, "gated-write");
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toContain("non-loopback");
    expect(body.error).toContain("ALLOW_REMOTE_WRITES=1");
    // Nothing was created — the library directory itself is absent.
    await expect(fsp.stat(gatedDir)).rejects.toThrow(/ENOENT/);
  });

  it("keeps discovery and static files working on a non-loopback bind", async () => {
    const list = await fetch(`${baseGated}/api/library`);
    expect(list.status).toBe(200);
    const body = await list.json();
    expect(body.components).toEqual([]);
    const page = await fetch(`${baseGated}/`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("<title>app</title>");
  });

  it("re-enables creation on a non-loopback bind with ALLOW_REMOTE_WRITES=1", async () => {
    const res = await post(baseFlag, "flag-write");
    expect(res.status).toBe(201);
    const record = await res.json();
    expect(record.path).toBe("flag-write.component.js");
  });

  it("treats ::1 as loopback and keeps creation enabled", async () => {
    const res = await post(baseV6, "v6-write");
    expect(res.status).toBe(201);
    await res.text();
  });
});

describe("POST body timeout and abort handling (ephemeral port)", () => {
  let server: http.Server;
  let baseUrl: string;
  let port: number;
  let slowDir: string;

  beforeAll(async () => {
    slowDir = path.join(tmpRoot, "slow-library", "components");
    server = http.createServer(
      createRequestHandler({
        distDir,
        libraryDir: slowDir,
        requestBodyTimeoutMs: 100,
      }),
    );
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    port = (server.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  });

  /** Raw-socket POST helper: send `request`, collect the reply until close. */
  function rawExchange(
    request: string,
    destroyAfterWrite = false,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const socket = net.connect(port, "127.0.0.1", () => {
        socket.write(request);
        if (destroyAfterWrite) socket.destroy();
      });
      let raw = "";
      socket.on("data", (d: Buffer) => {
        raw += d.toString("utf8");
      });
      socket.on("error", () => {
        /* ECONNRESET from our own destroy is expected */
      });
      socket.on("close", () => resolve(raw));
      socket.setTimeout(5000, () => {
        socket.destroy();
        reject(new Error("raw exchange timed out"));
      });
    });
  }

  it("times out a stalled body with 408 and writes nothing", async () => {
    const raw = await rawExchange(
      "POST /api/library/components HTTP/1.1\r\n" +
        "Host: localhost\r\n" +
        "Content-Type: application/json\r\n" +
        "Content-Length: 200\r\n" +
        "\r\n" +
        '{"fileName":"stalled","source":"',
      // ...and then the client just stops sending.
    );
    expect(raw).toMatch(/^HTTP\/1\.1 408 /);
    expect(raw).toContain("timed out");
    await expect(
      fsp.stat(path.join(slowDir, "stalled.component.js")),
    ).rejects.toThrow(/ENOENT/);
  });

  it("survives a client that aborts mid-body, with no file written", async () => {
    await rawExchange(
      "POST /api/library/components HTTP/1.1\r\n" +
        "Host: localhost\r\n" +
        "Content-Type: application/json\r\n" +
        "Content-Length: 200\r\n" +
        "\r\n" +
        '{"fileName":"aborted","source":"',
      true, // vanish mid-body
    );
    // The server is still healthy and responsive afterwards.
    const res = await fetch(`${baseUrl}/api/library`);
    expect(res.status).toBe(200);
    await res.text();
    await expect(
      fsp.stat(path.join(slowDir, "aborted.component.js")),
    ).rejects.toThrow(/ENOENT/);
  });
});

describe("generic error responses (ephemeral port)", () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    // A FILE where the library root's parent should be: realpath fails with
    // ENOTDIR (not ENOENT), which scanLibrary rethrows -> generic 500.
    const notADir = path.join(tmpRoot, "not-a-dir");
    await fsp.writeFile(notADir, "I am a file, not a directory\n", "utf8");
    const brokenLibraryDir = path.join(notADir, "components");
    server = http.createServer(
      createRequestHandler({ distDir, libraryDir: brokenLibraryDir }),
    );
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  });

  it("answers a failing scan with a generic 500 and no filesystem details", async () => {
    const res = await fetch(`${baseUrl}/api/library`);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Failed to scan the component library.");
    // No raw paths or errno codes leak to the client.
    expect(JSON.stringify(body)).not.toContain(tmpRoot);
    expect(JSON.stringify(body)).not.toMatch(/ENOTDIR|ENOENT|EACCES/);
  });
});
