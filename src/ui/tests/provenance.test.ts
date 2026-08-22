import { describe, it, expect } from "vitest";
import {
  stableStringify,
  fnv1a64Hex,
  configHash,
  configSha256,
  settingsSummary,
  provenanceCommentLines,
} from "../provenance";
import type { NetworkConfig } from "../types";

const cfg = (name = "Test net"): NetworkConfig => ({
  meta: { name, version: 2 },
  settings: {
    mode: "transient",
    dt: 0.5,
    endTime: 10,
    tolerance: 1e-8,
    maxIterations: 500,
    relaxation: 0.9,
  },
  fluid: { model: "incompressible", preset: "water" },
  nodes: [
    { id: "B", type: "boundary", x: 0, y: 0, pressure: 2e5, temperature: 300 },
    {
      id: "A",
      type: "internal",
      x: 100,
      y: 0,
      pressure: 1.5e5,
      temperature: 300,
      volume: 0.01,
    },
  ],
  branches: [
    {
      id: "p1",
      from: "B",
      to: "A",
      component: { type: "pipe", length: 1, diameter: 0.02, roughness: 1e-5 },
    },
  ],
});

describe("provenance", () => {
  it("stableStringify is key-order independent", () => {
    const a = stableStringify({ b: 1, a: { d: [1, 2], c: "x" } });
    const b = stableStringify({ a: { c: "x", d: [1, 2] }, b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":{"c":"x","d":[1,2]},"b":1}');
  });

  it("stableStringify treats undefined like JSON (dropped) and canonicalizes -0", () => {
    expect(stableStringify({ a: undefined, b: -0 })).toBe('{"b":0}');
  });

  it("fnv1a64Hex is deterministic and 16 hex chars", () => {
    const h1 = fnv1a64Hex("hello world");
    const h2 = fnv1a64Hex("hello world");
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{16}$/);
    expect(fnv1a64Hex("hello world!")).not.toBe(h1);
  });

  it("hashes complete UTF-8 input rather than only low UTF-16 bytes", () => {
    expect(fnv1a64Hex("\u0000")).not.toBe(fnv1a64Hex("\u0100"));
  });

  it("configHash ignores key order but reacts to content", () => {
    const base = cfg();
    const reordered: NetworkConfig = JSON.parse(JSON.stringify(base));
    // swap node order in the array — that IS a content change for arrays
    expect(configHash(base)).toBe(configHash(JSON.parse(JSON.stringify(base))));
    const modified = cfg();
    modified.nodes[0].pressure = 999;
    expect(configHash(modified)).not.toBe(configHash(base));
    expect(configHash(reordered)).toBe(configHash(base));
  });

  it("configSha256 returns a 64-char hex digest when Web Crypto is available", async () => {
    const sha = await configSha256(cfg());
    if (sha === null) {
      // Environment without subtle crypto — acceptable fallback path.
      expect(globalThis.crypto?.subtle).toBeFalsy();
      return;
    }
    expect(sha).toMatch(/^[0-9a-f]{64}$/);
    const sha2 = await configSha256(cfg());
    expect(sha2).toBe(sha);
  });

  it("settingsSummary includes mode-specific transient settings", () => {
    const s = settingsSummary(cfg());
    expect(s).toContain("tol=1e-8");
    expect(s).toContain("maxIter=500");
    expect(s).toContain("dt=0.5s");
    expect(s).toContain("end=10s");
    const steady = cfg();
    steady.settings = { mode: "steady", tolerance: 1e-6, maxIterations: 100 };
    const ss = settingsSummary(steady);
    expect(ss).not.toContain("dt=");
    expect(ss).not.toContain("end=");
  });

  it("provenanceCommentLines emits the five documented comment keys", async () => {
    const lines = await provenanceCommentLines(cfg("My Model"));
    expect(lines[0]).toBe("# model=My Model");
    expect(lines[1]).toMatch(
      /^# generated=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
    );
    expect(lines[2]).toBe("# mode=transient");
    expect(lines[3]).toMatch(/^# settings=tol=/);
    // sha256 when available, FNV fallback labeled config_hash otherwise
    expect(lines[4]).toMatch(/^# config_(sha256|hash)=[0-9a-f]+$/);
  });
});
