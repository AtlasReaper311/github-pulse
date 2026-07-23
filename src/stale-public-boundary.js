import worker from "./public-boundary.js";
import { cachedJson } from "./lib/staleCache.js";

const CACHE_ALL = "pulse:swr:v1:all";
const CACHE_HEATMAP = "pulse:swr:v1:heatmap";

function positiveSeconds(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function corsHeaders(request, env) {
  const allowed = (env.ALLOWED_ORIGINS ||
    "https://atlas-systems.uk,https://www.atlas-systems.uk,https://status.atlas-systems.uk,http://localhost:8788")
    .split(",")
    .map((value) => value.trim());
  const origin = request.headers.get("Origin");
  const headers = {
    Vary: "Origin",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
  };
  if (origin && allowed.includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}

async function buildFromWorker(request, env, ctx) {
  const response = await worker.fetch(request, env, ctx);
  if (!response.ok) {
    throw new Error(`pulse rebuild returned ${response.status}`);
  }
  return response.json();
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const isPulse = url.pathname.endsWith("/pulse") || url.pathname === "/pulse";
    const isHeatmap = url.pathname.endsWith("/pulse/heatmap");
    const repoParam = url.searchParams.get("repo");

    if (request.method === "POST" && url.pathname.endsWith("/pulse/purge")) {
      await Promise.all([
        env.PULSE_CACHE.delete(CACHE_ALL),
        env.PULSE_CACHE.delete(CACHE_HEATMAP),
      ]);
      return worker.fetch(request, env, ctx);
    }

    if (request.method !== "GET" || (!isPulse && !isHeatmap) || repoParam) {
      return worker.fetch(request, env, ctx);
    }

    if (!env.GITHUB_TOKEN) return worker.fetch(request, env, ctx);

    try {
      const freshTtlSeconds = positiveSeconds(
        isHeatmap ? env.HEATMAP_TTL_SECONDS : env.CACHE_TTL_SECONDS,
        isHeatmap ? 1800 : 3600,
      );
      const retentionTtlSeconds = Math.max(
        positiveSeconds(env.CACHE_RETENTION_TTL_SECONDS, 86400),
        freshTtlSeconds + 60,
      );
      const result = await cachedJson({
        kv: env.PULSE_CACHE,
        key: isHeatmap ? CACHE_HEATMAP : CACHE_ALL,
        freshTtlSeconds,
        retentionTtlSeconds,
        build: () => buildFromWorker(request, env, ctx),
        ctx,
      });

      return new Response(result.body, {
        status: 200,
        headers: {
          ...corsHeaders(request, env),
          "content-type": "application/json",
          "x-pulse-cache": result.cache,
          ...(result.generatedAt ? { "x-pulse-generated-at": result.generatedAt } : {}),
          "Cache-Control": "public, max-age=300",
        },
      });
    } catch {
      return worker.fetch(request, env, ctx);
    }
  },
};
