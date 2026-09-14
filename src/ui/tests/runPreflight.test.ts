/**
 * runPreflight.test.ts — the shared gate between an editable config and the
 * solver worker. Embedded user components execute as trusted code in the
 * worker, so both the manual Run path and sweeps must refuse untrusted
 * embedded source, and both must validate before spending a worker.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { prepareRunConfig } from "../runPreflight";
import {
  componentSourceTrustHash,
  rememberComponentSourceTrust,
} from "../componentLibrary";
import type { NetworkConfig } from "../types";

const EMBEDDED =
  "defineComponent({ metadata: { name: 'needle' }, pressureDrop() { return 0; } });";
const LOCAL =
  "defineComponent({ metadata: { name: 'needle' }, pressureDrop() { return 1; } });";

function cfg(): NetworkConfig {
  return {
    meta: { name: "Preflight", version: 2 },
    settings: { mode: "steady", tolerance: 1e-6, maxIterations: 100 },
    fluid: { model: "incompressible", preset: "water" },
    nodes: [
      {
        id: "A",
        type: "boundary",
        x: 0,
        y: 0,
        pressure: 2e5,
        temperature: 300,
      },
      {
        id: "B",
        type: "boundary",
        x: 100,
        y: 0,
        pressure: 1e5,
        temperature: 300,
      },
    ],
    branches: [
      {
        id: "b1",
        from: "A",
        to: "B",
        component: { type: "pipe", length: 1, diameter: 0.02, roughness: 1e-5 },
      },
    ],
  };
}

function withUserComponent(embedded: boolean): NetworkConfig {
  const c = cfg();
  c.branches[0].component = {
    type: "userComponent",
    component: "needle",
    params: {},
  };
  if (embedded)
    c.componentLibrary = {
      needle: { code: EMBEDDED, format: "defineComponent" },
    };
  return c;
}

function stubLibrary(components: { path: string; source: string }[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      json: async () => ({
        components: components.map((c) => ({ ...c, modifiedAt: 1 })),
      }),
    }),
  );
}

beforeEach(() => {
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => void storage.set(k, v),
    removeItem: (k: string) => void storage.delete(k),
  });
  stubLibrary([]);
});

describe("prepareRunConfig", () => {
  it("returns a validated clone and leaves the input untouched", async () => {
    const input = cfg();
    const r = await prepareRunConfig(input);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.config).toEqual(input);
      expect(r.config).not.toBe(input);
    }
  });

  it("reports validation errors instead of a config", async () => {
    const c = cfg();
    c.branches[0].to = "nowhere";
    const r = await prepareRunConfig(c);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(" ")).toMatch(/nowhere/);
  });

  it("blocks embedded component code that differs from the local copy and is not trusted", async () => {
    stubLibrary([{ path: "needle.js", source: LOCAL }]);
    const r = await prepareRunConfig(withUserComponent(true));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toMatch(/not trusted \(needle\)/);
  });

  it("allows embedded code the user has approved", async () => {
    stubLibrary([{ path: "needle.js", source: LOCAL }]);
    rememberComponentSourceTrust([await componentSourceTrustHash(EMBEDDED)]);
    const r = await prepareRunConfig(withUserComponent(true));
    expect(r.ok).toBe(true);
  });

  it("allows embedded code that matches the local library copy", async () => {
    stubLibrary([{ path: "needle.js", source: EMBEDDED }]);
    const r = await prepareRunConfig(withUserComponent(true));
    expect(r.ok).toBe(true);
  });

  it("embeds a referenced local component into the returned clone by default", async () => {
    stubLibrary([{ path: "needle.js", source: LOCAL }]);
    const input = withUserComponent(false);
    const r = await prepareRunConfig(input);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.config.componentLibrary?.needle.code).toBe(LOCAL);
    expect(input.componentLibrary).toBeUndefined();
  });

  it("reports a referenced-but-unembedded component when embedding is disabled", async () => {
    // Sweep jobs are hash-pinned at creation and cannot have their base
    // rewritten at execute time, so they need the error, not the embed.
    stubLibrary([{ path: "needle.js", source: LOCAL }]);
    const r = await prepareRunConfig(withUserComponent(false), {
      embedLocal: false,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toMatch(/"needle" is not embedded/);
  });

  it("reports a referenced component that is neither embedded nor local", async () => {
    const r = await prepareRunConfig(withUserComponent(false));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toMatch(/unavailable from the local/);
  });
});
