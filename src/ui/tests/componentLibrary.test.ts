import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  compareEmbeddedComponents,
  ComponentLibraryCreateError,
  componentSourceHash,
  componentSourceTrustHash,
  createLocalComponent,
  embedReferencedComponents,
  isComponentSourceTrusted,
  parseLocalComponent,
  refreshComponentLibrary,
  rememberComponentSourceTrust,
  resolveUserComponentDescriptor,
} from "../componentLibrary";
import type { NetworkConfig } from "../types";

const source = `defineComponent({
  metadata: { name: 'needle', label: 'Needle', params: [{ name: 'K', default: 2 }] },
  pressureDrop() { throw new Error('must not run during discovery'); }
});`;

function config(): NetworkConfig {
  return {
    meta: { name: "test", version: 2 },
    settings: { mode: "steady", tolerance: 1e-6, maxIterations: 10 },
    fluid: { model: "incompressible", preset: "water" },
    nodes: [],
    branches: [
      {
        id: "b",
        from: "a",
        to: "z",
        component: { type: "userComponent", component: "needle" },
      },
    ],
  };
}

let storage: Record<string, string>;

beforeEach(() => {
  storage = {};
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage[key] ?? null,
    setItem: (key: string, value: string) => {
      storage[key] = value;
    },
  });
});

afterEach(() => vi.unstubAllGlobals());

describe("local component library", () => {
  it("captures metadata through defineComponent without calling pressureDrop", () => {
    const parsed = parseLocalComponent({
      path: "needle.js",
      source,
      modifiedAt: 1,
    });
    expect(parsed.key).toBe("needle");
    expect(parsed.metadata.params?.[0]).toEqual({ name: "K", default: 2 });
  });

  it("retains the last library snapshot when refresh is unavailable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce({
        ok: true,
        headers: { get: () => "application/json" },
        json: async () => ({
          components: [{ path: "needle.js", source, modifiedAt: 1 }],
        }),
      }),
    );
    expect(
      (await refreshComponentLibrary()).components.map((item) => item.key),
    ).toEqual(["needle"]);

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    const unavailable = await refreshComponentLibrary();
    expect(unavailable.status).toBe("unavailable");
    expect(unavailable.components.map((item) => item.key)).toEqual(["needle"]);
    expect(unavailable.error).toContain("Could not reach local library server");
    expect(unavailable.error).toContain("offline");
  });

  it("rejects a non-JSON (HTML) response with an actionable message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce({
        ok: true,
        headers: {
          get: (name: string) =>
            name.toLowerCase() === "content-type"
              ? "text/html; charset=utf-8"
              : null,
        },
        json: async () => {
          throw new Error("Unexpected token < in JSON");
        },
      }),
    );
    const unavailable = await refreshComponentLibrary({ force: true });
    expect(unavailable.status).toBe("unavailable");
    expect(unavailable.error).toContain("HTML instead of JSON");
    expect(unavailable.error).toContain("npm run serve");
  });

  it("does not let an older forced refresh overwrite a newer response", async () => {
    let resolveFirst!: (value: unknown) => void;
    let resolveSecond!: (value: unknown) => void;
    const first = new Promise((resolve) => {
      resolveFirst = resolve;
    });
    const second = new Promise((resolve) => {
      resolveSecond = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second),
    );
    const oldRequest = refreshComponentLibrary({ force: true });
    const newRequest = refreshComponentLibrary({ force: true });
    resolveSecond({
      ok: true,
      headers: { get: () => "application/json" },
      json: async () => ({
        components: [{ path: "new.js", source, modifiedAt: 2 }],
      }),
    });
    expect((await newRequest).components[0].path).toBe("new.js");
    const oldSource = source.replace("name: 'needle'", "name: 'old'");
    resolveFirst({
      ok: true,
      headers: { get: () => "application/json" },
      json: async () => ({
        components: [{ path: "old.js", source: oldSource, modifiedAt: 1 }],
      }),
    });
    expect((await oldRequest).components[0].path).toBe("new.js");
  });

  it("creates a component and refreshes the library snapshot", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 201 })
      .mockResolvedValueOnce({
        ok: true,
        headers: { get: () => "application/json" },
        json: async () => ({
          components: [{ path: "needle.component.js", source, modifiedAt: 2 }],
        }),
      });
    vi.stubGlobal("fetch", fetchMock);
    const created = await createLocalComponent("needle.component.js", source);
    expect(created.key).toBe("needle");
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/library/components",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ fileName: "needle", source }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/library");
  });

  it("builds a palette tool id and user-component defaults from metadata", async () => {
    const {
      componentInstanceDefaults,
      localComponentForTool,
      localComponentKeyFromTool,
      localComponentToolId,
    } = await import("../componentLibrary");
    const local = parseLocalComponent({
      path: "needle.component.js",
      source,
      modifiedAt: 1,
    });
    const tool = localComponentToolId(local.key);
    expect(localComponentKeyFromTool(tool)).toBe("needle");
    expect(localComponentForTool(tool, [local])).toBe(local);
    expect(componentInstanceDefaults(local)).toEqual({
      type: "userComponent",
      component: "needle",
      area: 0.001,
      params: { K: 2 },
    });
  });

  it("returns useful typed errors for duplicates and unavailable companions", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce({
        ok: false,
        status: 409,
        json: async () => ({ error: "already exists" }),
      }),
    );
    await expect(
      createLocalComponent("needle.component.js", source),
    ).rejects.toMatchObject({
      code: "duplicate",
      message: "already exists",
    } satisfies Partial<ComponentLibraryCreateError>);

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce({
        ok: false,
        status: 405,
        json: async () => ({}),
      }),
    );
    await expect(
      createLocalComponent("needle.component.js", source),
    ).rejects.toMatchObject({
      code: "unavailable",
      message: expect.stringContaining("npm run serve"),
    });
  });

  it("falls back to an unavailable error when the companion cannot be reached", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    await expect(
      createLocalComponent("needle.component.js", source),
    ).rejects.toMatchObject({
      code: "unavailable",
      message: expect.stringContaining("offline"),
    });
  });

  it("hashes deterministically, embeds only missing references, and compares trust", async () => {
    expect(componentSourceHash(source)).toBe(componentSourceHash(source));
    expect(componentSourceHash(`${source}\n`)).not.toBe(
      componentSourceHash(source),
    );
    const local = parseLocalComponent({
      path: "needle.js",
      source,
      modifiedAt: 1,
    });
    const cfg = config();
    expect(embedReferencedComponents(cfg, [local])).toEqual([]);
    expect(cfg.componentLibrary).toEqual({
      needle: {
        code: source,
        format: "defineComponent",
        metadata: local.metadata,
      },
    });
    expect(
      (await compareEmbeddedComponents(cfg.componentLibrary, [local]))[0]
        .status,
    ).toBe("match");
    cfg.componentLibrary!.needle.code += "\n";
    expect(
      (await compareEmbeddedComponents(cfg.componentLibrary, [local]))[0]
        .status,
    ).toBe("mismatch");
  });

  it("uses embedded metadata for existing branches and reports local drift", () => {
    const embedded = source.replace("default: 2", "default: 7");
    const local = parseLocalComponent({
      path: "needle.js",
      source,
      modifiedAt: 1,
    });
    const embeddedParsed = parseLocalComponent({
      path: "embedded.js",
      source: embedded,
      modifiedAt: 0,
    });
    const descriptor = resolveUserComponentDescriptor(
      "needle",
      {
        needle: {
          code: embedded,
          format: "defineComponent",
          metadata: embeddedParsed.metadata,
        },
      },
      [local],
    );
    expect(descriptor.source).toBe("embedded");
    expect(descriptor.metadata?.params?.[0].default).toBe(7);
    expect(descriptor.drift).toBe(true);
    expect(descriptor.local).toBe(local);
  });

  it("remembers trust by source hash and re-prompts when code changes", async () => {
    const firstHash = await componentSourceTrustHash(source);
    rememberComponentSourceTrust([firstHash]);
    expect(isComponentSourceTrusted(firstHash)).toBe(true);
    expect(
      isComponentSourceTrusted(await componentSourceTrustHash(`${source}\n`)),
    ).toBe(false);
  });

  it("treats unavailable or malformed storage as untrusted without throwing", async () => {
    storage["fluids-network-trusted-component-sources-v1"] = "{bad";
    const trustHash = await componentSourceTrustHash(source);
    expect(isComponentSourceTrusted(trustHash)).toBe(false);
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    });
    expect(() => rememberComponentSourceTrust([trustHash])).not.toThrow();
    expect(isComponentSourceTrusted(trustHash)).toBe(false);
  });
});
