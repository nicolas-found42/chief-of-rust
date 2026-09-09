import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod/v3";
import { expect, it } from "vitest";
import { cachedCompleteJson } from "../../../apps/server/src/person-benchmark/judge-cache.js";
import type { CompletionRequest } from "../../../apps/server/src/llm/providers.js";

const schema = z.object({ verdict: z.string() });

function request(overrides: Partial<CompletionRequest> = {}): CompletionRequest {
  return {
    system: "judge system prompt",
    user: "dossier under judgment",
    schema,
    ...overrides,
  };
}

function countingInner(answer: unknown, failFirst = false) {
  const calls = { count: 0 };
  return {
    calls,
    inner: async () => {
      calls.count += 1;
      if (failFirst && calls.count === 1) throw new Error("http_error 502");
      return answer;
    },
  };
}

it("serves the second identical judge call from the cache without calling the model", async () => {
  const dir = mkdtempSync(join(tmpdir(), "benchmark-cache-"));
  try {
    const { calls, inner } = countingInner({ verdict: "supported" });
    const cached = cachedCompleteJson(inner, {
      cacheDir: dir,
      namespace: "judge-v1-r1",
      provider: "openrouter",
      model: "acme/tiny",
    });
    await cached(request());
    const second = await cached(request());
    expect(second).toEqual({ verdict: "supported" });
    expect(calls.count).toBe(1);
    // The record on disk is the cached answer itself.
    const files = readdirSync(dir);
    expect(files.length).toBe(1);
    expect(JSON.parse(readFileSync(join(dir, files[0]), "utf8"))).toMatchObject({
      answer: { verdict: "supported" },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("separates namespaces so a judge-version bump or repeat re-samples", async () => {
  const dir = mkdtempSync(join(tmpdir(), "benchmark-cache-ns-"));
  try {
    const { calls, inner } = countingInner({ verdict: "supported" });
    const options = { cacheDir: dir, provider: "openrouter", model: "acme/tiny" } as const;
    await cachedCompleteJson(inner, { ...options, namespace: "judge-v1-r1" })(request());
    await cachedCompleteJson(inner, { ...options, namespace: "judge-v1-r1" })(request());
    await cachedCompleteJson(inner, { ...options, namespace: "judge-v1-r2" })(request());
    await cachedCompleteJson(inner, { ...options, namespace: "judge-v2-r1" })(request());
    expect(calls.count).toBe(3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("never caches a failed call, so an outage is retried for real", async () => {
  const dir = mkdtempSync(join(tmpdir(), "benchmark-cache-fail-"));
  try {
    const { calls, inner } = countingInner({ verdict: "supported" }, true);
    const cached = cachedCompleteJson(inner, {
      cacheDir: dir,
      namespace: "judge-v1-r1",
      provider: "openrouter",
      model: "acme/tiny",
    });
    await expect(cached(request())).rejects.toThrow("http_error 502");
    expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([]);
    await cached(request());
    expect(calls.count).toBe(2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("separates seeds: a different sampling seed never replays another seed's answer", async () => {
  const dir = mkdtempSync(join(tmpdir(), "benchmark-cache-seed-"));
  try {
    const { calls, inner } = countingInner({ verdict: "supported" });
    const cached = cachedCompleteJson(inner, {
      cacheDir: dir,
      namespace: "judge-v1-r1",
      provider: "openrouter",
      model: "acme/tiny",
    });
    await cached(request({ seed: 7 }));
    await cached(request({ seed: 7 }));
    await cached(request({ seed: 8 }));
    await cached(request());
    expect(calls.count).toBe(3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("keys on the request content: a different dossier or sampling setting misses", async () => {
  const dir = mkdtempSync(join(tmpdir(), "benchmark-cache-key-"));
  try {
    const { calls, inner } = countingInner({ verdict: "supported" });
    const cached = cachedCompleteJson(inner, {
      cacheDir: dir,
      namespace: "judge-v1-r1",
      provider: "openrouter",
      model: "acme/tiny",
    });
    await cached(request());
    await cached(request({ user: "a different dossier" }));
    await cached(request({ temperature: 0 }));
    expect(calls.count).toBe(3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("passes through untouched when disabled, writing nothing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "benchmark-cache-off-"));
  try {
    const { calls, inner } = countingInner({ verdict: "supported" });
    const cached = cachedCompleteJson(inner, {
      cacheDir: dir,
      namespace: "judge-v1-r1",
      provider: "openrouter",
      model: "acme/tiny",
      disabled: true,
    });
    await cached(request());
    await cached(request());
    expect(calls.count).toBe(2);
    expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
