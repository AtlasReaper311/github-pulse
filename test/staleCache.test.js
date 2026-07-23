import assert from "node:assert/strict";
import test from "node:test";

import { cachedJson } from "../src/lib/staleCache.js";

function memoryKv(initial = new Map()) {
  return {
    values: initial,
    async get(key) {
      return this.values.get(key) ?? null;
    },
    async put(key, value, options) {
      this.lastPut = { key, value, options };
      this.values.set(key, value);
    },
  };
}

function context() {
  const pending = [];
  return {
    pending,
    waitUntil(promise) {
      pending.push(promise);
    },
  };
}

test("builds and retains an initial cache miss", async () => {
  const kv = memoryKv();
  const result = await cachedJson({
    kv,
    key: "pulse",
    freshTtlSeconds: 3600,
    retentionTtlSeconds: 86400,
    build: async () => ({ generatedAt: "2026-07-23T17:00:00Z", ok: true }),
    now: () => 1000,
  });

  assert.equal(result.cache, "MISS");
  assert.equal(JSON.parse(result.body).ok, true);
  assert.equal(kv.lastPut.options.expirationTtl, 86400);
});

test("returns a fresh envelope without rebuilding", async () => {
  let builds = 0;
  const seed = JSON.stringify({
    version: 1,
    storedAtMs: 1000,
    generatedAt: "2026-07-23T17:00:00Z",
    body: JSON.stringify({ generatedAt: "2026-07-23T17:00:00Z", ok: true }),
  });
  const kv = memoryKv(new Map([["pulse", seed]]));

  const result = await cachedJson({
    kv,
    key: "pulse",
    freshTtlSeconds: 3600,
    retentionTtlSeconds: 86400,
    build: async () => {
      builds += 1;
      return { ok: false };
    },
    now: () => 2000,
  });

  assert.equal(result.cache, "HIT");
  assert.equal(builds, 0);
});

test("serves stale data and refreshes through waitUntil", async () => {
  const oldBody = JSON.stringify({ generatedAt: "2026-07-23T16:00:00Z", value: "old" });
  const seed = JSON.stringify({
    version: 1,
    storedAtMs: 1000,
    generatedAt: "2026-07-23T16:00:00Z",
    body: oldBody,
  });
  const kv = memoryKv(new Map([["pulse", seed]]));
  const ctx = context();

  const result = await cachedJson({
    kv,
    key: "pulse",
    freshTtlSeconds: 1,
    retentionTtlSeconds: 86400,
    build: async () => ({ generatedAt: "2026-07-23T17:00:00Z", value: "new" }),
    ctx,
    now: () => 5000,
  });

  assert.equal(result.cache, "STALE");
  assert.equal(result.body, oldBody);
  assert.equal(ctx.pending.length, 1);
  await Promise.all(ctx.pending);
  assert.equal(JSON.parse(JSON.parse(kv.values.get("pulse")).body).value, "new");
});

test("retains stale data when background refresh fails", async () => {
  const oldBody = JSON.stringify({ value: "old" });
  const seed = JSON.stringify({ version: 1, storedAtMs: 1000, generatedAt: null, body: oldBody });
  const kv = memoryKv(new Map([["pulse", seed]]));
  const ctx = context();

  const result = await cachedJson({
    kv,
    key: "pulse",
    freshTtlSeconds: 1,
    retentionTtlSeconds: 86400,
    build: async () => {
      throw new Error("upstream unavailable");
    },
    ctx,
    now: () => 5000,
  });

  assert.equal(result.cache, "STALE");
  await Promise.all(ctx.pending);
  assert.equal(kv.values.get("pulse"), seed);
});

test("serves legacy entries as stale during migration", async () => {
  const legacy = JSON.stringify({ generatedAt: "2026-07-23T16:00:00Z", value: "legacy" });
  const kv = memoryKv(new Map([["pulse", legacy]]));
  const ctx = context();

  const result = await cachedJson({
    kv,
    key: "pulse",
    freshTtlSeconds: 3600,
    retentionTtlSeconds: 86400,
    build: async () => ({ generatedAt: "2026-07-23T17:00:00Z", value: "new" }),
    ctx,
    now: () => 5000,
  });

  assert.equal(result.cache, "STALE");
  assert.equal(result.body, legacy);
  await Promise.all(ctx.pending);
});
