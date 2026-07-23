const CACHE_ENVELOPE_VERSION = 1;

function decode(raw) {
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw);
    if (
      parsed?.version === CACHE_ENVELOPE_VERSION
      && typeof parsed.body === "string"
      && Number.isFinite(parsed.storedAtMs)
    ) {
      return {
        body: parsed.body,
        storedAtMs: parsed.storedAtMs,
        generatedAt: parsed.generatedAt || null,
        legacy: false,
      };
    }
  } catch {
    // Existing cache entries predate the envelope. Preserve them as stale
    // snapshots and refresh them in the background instead of discarding them.
  }

  return {
    body: raw,
    storedAtMs: 0,
    generatedAt: null,
    legacy: true,
  };
}

function encode(body, storedAtMs) {
  let generatedAt = null;
  try {
    generatedAt = JSON.parse(body)?.generatedAt || null;
  } catch {
    // Bodies without valid JSON have no generated timestamp.
  }

  return JSON.stringify({
    version: CACHE_ENVELOPE_VERSION,
    storedAtMs,
    generatedAt,
    body,
  });
}

async function rebuild(kv, key, retentionTtlSeconds, build, now) {
  const body = JSON.stringify(await build());
  const storedAtMs = now();
  await kv.put(key, encode(body, storedAtMs), {
    expirationTtl: retentionTtlSeconds,
  });
  return { body, storedAtMs };
}

export async function cachedJson({
  kv,
  key,
  freshTtlSeconds,
  retentionTtlSeconds,
  build,
  ctx,
  now = Date.now,
}) {
  const raw = await kv.get(key);
  const cached = decode(raw);
  const freshForMs = freshTtlSeconds * 1000;

  if (cached && !cached.legacy && now() - cached.storedAtMs < freshForMs) {
    return {
      body: cached.body,
      cache: "HIT",
      generatedAt: cached.generatedAt,
    };
  }

  if (cached) {
    const refresh = rebuild(kv, key, retentionTtlSeconds, build, now).catch(() => null);
    if (ctx?.waitUntil) ctx.waitUntil(refresh);
    else await refresh;

    return {
      body: cached.body,
      cache: "STALE",
      generatedAt: cached.generatedAt,
    };
  }

  const rebuilt = await rebuild(kv, key, retentionTtlSeconds, build, now);
  return {
    body: rebuilt.body,
    cache: "MISS",
    generatedAt: JSON.parse(rebuilt.body)?.generatedAt || null,
  };
}
