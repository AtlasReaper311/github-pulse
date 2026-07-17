/**
 * github-pulse
 *
 * Read-only proxy between the portfolio site and the GitHub API.
 * It exists for three reasons:
 *   1. The GitHub token never reaches the browser.
 *   2. KV caching absorbs traffic, so one hour of page views costs one
 *      burst of GitHub API calls instead of one per visitor.
 *   3. The site keeps rendering stats during a GitHub outage, serving
 *      the last cached snapshot.
 *
 * GET /pulse                aggregate stats across the account
 * GET /pulse?repo=name      one repository in detail
 * GET /pulse/heatmap        per-day commit counts for the last 90 days
 *                           (drives the Lab activity heatmap)
 * GET /pulse/workflows      bounded health evidence for three Atlas tools
 */

import { handleMeta } from "./_meta.js";
import { getCommitCountSince, getCommitHeatmapSince } from "./lib/commitHistory.js";

const REPO_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,100}$/;

// The free plan allows 50 subrequests per invocation. Aggregate mode
// spends: 1 repos + up to 2 batched GraphQL history calls (20 repos per
// batch) + N languages + M recent-commits + 2 KV. Capping language lookups
// at 30 and recent-commit lookups at 5 keeps the worst case comfortably
// under the limit even with two GraphQL batches.
const LANGUAGE_REPO_LIMIT = 30;
const RECENT_COMMIT_REPO_LIMIT = 5;

// Heatmap mode batches the same GraphQL history query used by aggregate
// mode instead of paginating REST search. See lib/commitHistory.js.

const GITHUB_API = "https://api.github.com";

export const WORKFLOW_TARGETS = Object.freeze([
  Object.freeze({
    id: "atlas-badges",
    repo: "atlas-badges",
    workflow: "ci.yml",
    branch: "main",
    event: "push",
    mode: "head",
    maxAgeSeconds: null,
  }),
  Object.freeze({
    id: "atlas-dep-audit",
    repo: "atlas-dep-audit",
    workflow: "audit.yml",
    branch: "main",
    event: "schedule",
    mode: "scheduled",
    maxAgeSeconds: 8 * 24 * 60 * 60,
  }),
  Object.freeze({
    id: "atlas-journey-watch",
    repo: "atlas-journey-watch",
    workflow: "journey-watch.yml",
    branch: "main",
    event: "schedule",
    mode: "scheduled",
    maxAgeSeconds: 8 * 60 * 60,
  }),
]);

const META = {
  name: "github-pulse",
  description: "Read-only GitHub activity feed for atlas-systems.uk, cached at the edge",
  version: "1.2.0",
  endpoints: [
    { method: "GET", path: "/pulse", description: "Aggregate public GitHub stats across the account" },
    { method: "GET", path: "/pulse?repo=<name>", description: "Detailed stats for one repository" },
    { method: "GET", path: "/pulse/heatmap", description: "Per-day commit counts for the last 90 days" },
    { method: "GET", path: "/pulse/workflows", description: "Freshness-aware health for allowlisted Atlas tools and scheduled workflows" },
    { method: "POST", path: "/pulse/purge", description: "Purge cached pulse snapshots; Bearer PULSE_PURGE_TOKEN required" },
    { method: "GET", path: "/pulse/_meta", description: "This document" },
  ],
  source: "https://github.com/AtlasReaper311/github-pulse",
};

class GitHubError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const meta = handleMeta(url, META);
    if (meta) return meta;

    const cors = corsHeaders(request, env);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }
    if (request.method === "POST" && url.pathname.endsWith("/pulse/purge")) {
      const auth = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
      if (!env.PULSE_PURGE_TOKEN || auth !== env.PULSE_PURGE_TOKEN) {
        return json(401, { error: "unauthorized" }, cors);
      }
      // Purge both the aggregate cache and the heatmap cache so a manual
      // purge is a single button, not two.
      await Promise.all([
        env.PULSE_CACHE.delete("pulse:v1:all"),
        env.PULSE_CACHE.delete("pulse:v1:heatmap"),
        env.PULSE_CACHE.delete("pulse:v1:workflow-health"),
      ]);
      return json(200, { ok: true, purged: true }, cors);
    }
    if (request.method !== "GET") {
      return json(405, { error: "GET only" }, { ...cors, Allow: "GET" });
    }

    if (!env.GITHUB_TOKEN) {
      // Without a token the API allows 60 requests/hour per IP, which a
      // single page load of aggregate mode can exhaust. Refusing to run
      // unauthenticated is the safer failure.
      return json(500, { error: "GITHUB_TOKEN secret is not set" }, cors);
    }

    const user = env.GITHUB_USER || "AtlasReaper311";
    const isHeatmap = url.pathname.endsWith("/pulse/heatmap");
    const isWorkflowHealth = url.pathname.endsWith("/pulse/workflows");
    const repoParam = url.searchParams.get("repo");

    if (!isHeatmap && !isWorkflowHealth && repoParam && !REPO_NAME_PATTERN.test(repoParam)) {
      return json(400, { error: "invalid repo name" }, cors);
    }

    // Heatmap data is heavier per build but stable enough to cache a
    // bit longer than the live aggregate. Tunable per-env if needed.
    const cacheKey = isHeatmap
      ? "pulse:v1:heatmap"
      : isWorkflowHealth
        ? "pulse:v1:workflow-health"
        : `pulse:v1:${repoParam || "all"}`;
    const ttl = isHeatmap
      ? Number(env.HEATMAP_TTL_SECONDS || 1800)
      : isWorkflowHealth
        ? Number(env.WORKFLOW_TTL_SECONDS || 300)
        : Number(env.CACHE_TTL_SECONDS || 3600);
    const browserTtl = isWorkflowHealth ? 60 : 300;

    // Serve from KV when possible. The x-pulse-cache header makes cache
    // behaviour observable from curl, which turns "is the cache working"
    // from a guess into a one-line check.
    const cached = await env.PULSE_CACHE.get(cacheKey);
    if (cached) {
      return new Response(cached, {
        status: 200,
        headers: {
          ...cors,
          "content-type": "application/json",
          "x-pulse-cache": "HIT",
          "Cache-Control": `public, max-age=${browserTtl}`,
        },
      });
    }

    try {
      const data = isHeatmap
        ? await heatmapStats(env, user)
        : isWorkflowHealth
          ? await workflowHealth(env, user)
          : repoParam
            ? await repoStats(env, user, repoParam)
            : await aggregateStats(env, user);

      const body = JSON.stringify(data);
      ctx.waitUntil(env.PULSE_CACHE.put(cacheKey, body, { expirationTtl: ttl }));

      return new Response(body, {
        status: 200,
        headers: {
          ...cors,
          "content-type": "application/json",
          "x-pulse-cache": "MISS",
          "Cache-Control": `public, max-age=${browserTtl}`,
        },
      });
    } catch (err) {
      // Upstream failures are worth knowing about even when nobody is
      // watching the site; fire-and-forget into atlas-notify if wired.
      ctx.waitUntil(alertFailure(env, err));

      if (err instanceof GitHubError) {
        // no-store: never let an upstream error get cached by a browser
        // or intermediary and outlive the outage itself.
        return json(err.status === 404 ? 404 : 502, { error: err.message }, { ...cors, "Cache-Control": "no-store" });
      }
      return json(500, { error: "internal error" }, { ...cors, "Cache-Control": "no-store" });
    }
  },
};

/* ------------------------------------------------------------------ */
/* GitHub API access                                                   */
/* ------------------------------------------------------------------ */

const RETRYABLE_STATUSES = new Set([502, 503, 504]);
const GH_MAX_RETRIES = 2;
const GH_RETRY_BASE_MS = 300;

/** Authenticated GitHub request returning parsed JSON or GitHubError. */
async function gh(env, path) {
  let lastError;

  for (let attempt = 0; attempt <= GH_MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, GH_RETRY_BASE_MS * 2 ** (attempt - 1)));
    }

    const response = await fetch(`${GITHUB_API}${path}`, {
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        // GitHub rejects requests without a User-Agent outright.
        "User-Agent": "github-pulse (atlas-systems.uk)",
      },
    });

    if (response.ok) {
      return response.json();
    }

    const detail = await response.text();
    lastError = new GitHubError(response.status, `GitHub ${path} returned ${response.status}: ${detail.slice(0, 200)}`);

    // 502/503/504 from GitHub's edge are usually transient; this is the
    // same failure class that used to hit /search/commits as an HTML
    // error page. Anything else is a real error, worth failing fast on.
    if (!RETRYABLE_STATUSES.has(response.status) || attempt === GH_MAX_RETRIES) {
      throw lastError;
    }
  }

  throw lastError;
}

function workflowEvidenceSource(user, target) {
  return `github-actions:${user}/${target.repo}/workflows/${target.workflow}`;
}

function unknownWorkflow(target, user, detail) {
  return {
    status: "unknown",
    evidence_source: workflowEvidenceSource(user, target),
    measured_at: null,
    detail,
    run_url: null,
    run_id: null,
    freshness_seconds: null,
    max_age_seconds: target.maxAgeSeconds,
    head_sha_matches: target.mode === "head" ? null : undefined,
  };
}

/**
 * Convert one GitHub Actions run into the estate's four-state health
 * vocabulary. Head-mode CI proves the current default-branch commit;
 * scheduled mode proves both conclusion and expected freshness.
 */
export function classifyWorkflowRun(
  target,
  run,
  { user = "AtlasReaper311", headSha = null, nowMs = Date.now() } = {},
) {
  if (!run) return unknownWorkflow(target, user, "no workflow run published");

  const measuredAt = run.updated_at ?? run.run_started_at ?? run.created_at ?? null;
  const measuredAtMs = Date.parse(measuredAt ?? "");
  const freshnessSeconds = Number.isFinite(measuredAtMs)
    ? Math.max(0, Math.round((nowMs - measuredAtMs) / 1000))
    : null;
  const headShaMatches = target.mode === "head"
    ? Boolean(headSha && run.head_sha === headSha)
    : undefined;
  const base = {
    evidence_source: workflowEvidenceSource(user, target),
    measured_at: measuredAt,
    run_url: run.html_url ?? null,
    run_id: Number.isFinite(run.id) ? run.id : null,
    freshness_seconds: freshnessSeconds,
    max_age_seconds: target.maxAgeSeconds,
    head_sha_matches: headShaMatches,
  };

  if (target.mode === "head" && !headSha) {
    return { ...base, status: "unknown", detail: "default-branch head unavailable" };
  }
  if (target.mode === "head" && !headShaMatches) {
    return { ...base, status: "degraded", detail: "current main commit awaits CI evidence" };
  }
  if (run.status !== "completed") {
    return { ...base, status: "degraded", detail: `workflow ${run.status || "pending"}` };
  }
  if (run.conclusion !== "success") {
    return {
      ...base,
      status: ["neutral", "skipped"].includes(run.conclusion) ? "degraded" : "down",
      detail: `workflow concluded ${run.conclusion || "without a verdict"}`,
    };
  }
  if (
    target.mode === "scheduled"
    && (!Number.isFinite(freshnessSeconds)
      || freshnessSeconds > target.maxAgeSeconds)
  ) {
    return { ...base, status: "degraded", detail: "successful run is overdue" };
  }
  return { ...base, status: "healthy", detail: "latest expected run succeeded" };
}

async function readWorkflowTarget(env, user, target, nowMs) {
  const query = new URLSearchParams({
    branch: target.branch,
    event: target.event,
    per_page: "1",
  });
  try {
    const runsPromise = gh(
      env,
      `/repos/${user}/${target.repo}/actions/workflows/${target.workflow}/runs?${query}`,
    );
    const headPromise = target.mode === "head"
      ? gh(env, `/repos/${user}/${target.repo}/commits/${target.branch}`)
      : Promise.resolve(null);
    const [runs, head] = await Promise.all([runsPromise, headPromise]);
    return classifyWorkflowRun(target, runs?.workflow_runs?.[0] ?? null, {
      user,
      headSha: head?.sha ?? null,
      nowMs,
    });
  } catch {
    return unknownWorkflow(target, user, "workflow evidence unavailable");
  }
}

export async function workflowHealth(env, user, nowMs = Date.now()) {
  const entries = await Promise.all(
    WORKFLOW_TARGETS.map(async (target) => [
      target.id,
      await readWorkflowTarget(env, user, target, nowMs),
    ]),
  );
  const workflows = Object.fromEntries(entries);
  return {
    ok: Object.values(workflows).some((item) => item.status !== "unknown"),
    generated_at: new Date(nowMs).toISOString(),
    workflows,
  };
}

/** Aggregate stats across the whole account. */
async function aggregateStats(env, user) {
  const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();

  const repos = await gh(env, `/users/${user}/repos?per_page=100&type=owner&sort=pushed`);

  // Forks out: the pulse reports what this account builds, not what it
  // has clicked "fork" on.
  const ownRepos = repos.filter((r) => !r.fork);

  // These three are independent once ownRepos is known, so they run in
  // parallel. Commit counting used to run in parallel with the repos call
  // itself via /search/commits; that endpoint is what threw intermittent
  // 503s, so it now goes through GraphQL history() instead (see
  // lib/commitHistory.js), which necessarily needs the repo list first
  // since GraphQL has no "search all my repos" equivalent to fall back on.
  const [languageMaps, commitTotal, recentCommitLists] = await Promise.all([
    Promise.all(ownRepos.slice(0, LANGUAGE_REPO_LIMIT).map((r) => gh(env, `/repos/${user}/${r.name}/languages`))),
    getCommitCountSince(env, user, ownRepos.map((r) => r.name), ninetyDaysAgo),
    Promise.all(
      ownRepos.slice(0, RECENT_COMMIT_REPO_LIMIT).map(async (r) => {
        const commits = await gh(env, `/repos/${user}/${r.name}/commits?per_page=5`);
        return commits.map((c) => ({
          repo: r.name,
          message: firstLine(c.commit?.message),
          sha: (c.sha || "").slice(0, 7),
          author: c.commit?.author?.name || "unknown",
          date: c.commit?.author?.date || null,
        }));
      }),
    ),
  ]);

  const byteTotals = {};
  for (const langMap of languageMaps) {
    for (const [lang, bytes] of Object.entries(langMap)) {
      byteTotals[lang] = (byteTotals[lang] || 0) + bytes;
    }
  }
  const totalBytes = Object.values(byteTotals).reduce((a, b) => a + b, 0) || 1;
  const languages = Object.entries(byteTotals)
    .map(([name, bytes]) => ({ name, percent: Math.round((bytes / totalBytes) * 1000) / 10 }))
    .filter((l) => l.percent >= 0.5)
    .sort((a, b) => b.percent - a.percent);

  const recentCommits = recentCommitLists
    .flat()
    .filter((c) => c.date)
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .slice(0, 10);

  return {
    generatedAt: new Date().toISOString(),
    user,
    totals: {
      publicRepos: ownRepos.length,
      stars: ownRepos.reduce((sum, r) => sum + r.stargazers_count, 0),
      // GraphQL history() counts default-branch commits only, same
      // trade-off the old search-based count had; feature-branch work
      // appears once merged. Documented trade-off (see README).
      commitsLast90Days: commitTotal,
    },
    languages,
    repos: ownRepos.map(repoCard),
    recentCommits,
  };
}

/** Detailed stats for a single repository. */
async function repoStats(env, user, repoName) {
  const [repo, languageMap, commits] = await Promise.all([
    gh(env, `/repos/${user}/${repoName}`),
    gh(env, `/repos/${user}/${repoName}/languages`),
    gh(env, `/repos/${user}/${repoName}/commits?per_page=10`),
  ]);

  const totalBytes = Object.values(languageMap).reduce((a, b) => a + b, 0) || 1;

  return {
    generatedAt: new Date().toISOString(),
    repo: repoCard(repo),
    languages: Object.entries(languageMap)
      .map(([name, bytes]) => ({ name, percent: Math.round((bytes / totalBytes) * 1000) / 10 }))
      .sort((a, b) => b.percent - a.percent),
    recentCommits: commits.map((c) => ({
      repo: repoName,
      message: firstLine(c.commit?.message),
      sha: (c.sha || "").slice(0, 7),
      author: c.commit?.author?.name || "unknown",
      date: c.commit?.author?.date || null,
    })),
  };
}

/**
 * Per-day commit counts for the last 90 days, plus the totals the Lab
 * heatmap header needs in one payload.
 *
 * Strategy: batched GraphQL history() queries per repo (see
 * lib/commitHistory.js), bucketing each commit's committedDate into its
 * YYYY-MM-DD. Uses the same GraphQL calls as the 90-day total on the
 * aggregate endpoint, so the heatmap's per-day sum matches the headline
 * number exactly.
 *
 * Caveat (worth knowing, not worth fixing here): history() indexes
 * default-branch commits only, same as the aggregate count. Work that
 * only ever lived on a feature branch won't appear until merged. This
 * matches the existing /pulse contract; better to be consistent than to
 * silently disagree with the headline number.
 */
async function heatmapStats(env, user) {
  const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();

  const repos = await gh(env, `/users/${user}/repos?per_page=100&type=owner&sort=pushed`);
  const ownRepos = repos.filter((r) => !r.fork);

  const { total, days, truncatedRepos } = await getCommitHeatmapSince(
    env,
    user,
    ownRepos.map((r) => r.name),
    ninetyDaysAgo,
  );

  // Top language across owned repos. Uses the single `language` field
  // on each repo (already in the repos payload) rather than the more
  // accurate per-repo /languages endpoint. That would cost N extra
  // subrequests for a header label, which isn't worth it.
  const langCounts = {};
  for (const r of ownRepos) {
    if (!r.language) continue;
    langCounts[r.language] = (langCounts[r.language] || 0) + 1;
  }
  const topLanguage =
    Object.entries(langCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || null;

  return {
    generatedAt: new Date().toISOString(),
    user,
    rangeDays: 90,
    totals: {
      publicRepos: ownRepos.length,
      commitsLast90Days: total,
      topLanguage,
    },
    days,
    // True if any single repo's 90-day window held more than 100 commits
    // on the default branch (GraphQL's per-query connection cap). For a
    // solo estate this is expected to stay false in practice.
    truncated: truncatedRepos.length > 0,
    truncatedRepos,
  };
}

/** The fields the frontend actually renders, nothing more. */
function repoCard(r) {
  return {
    name: r.name,
    description: r.description,
    stars: r.stargazers_count,
    language: r.language,
    topics: r.topics || [],
    pushedAt: r.pushed_at,
    url: r.html_url,
  };
}

function firstLine(message) {
  return message ? String(message).split("\n")[0] : "";
}

/* ------------------------------------------------------------------ */
/* CORS and responses                                                  */
/* ------------------------------------------------------------------ */

/**
 * Reflect the Origin only when it is on the allowlist. A wildcard would
 * work for a public read-only API, but an allowlist costs nothing and
 * means other sites cannot quietly build on this endpoint's cache and
 * rate-limit budget.
 */
function corsHeaders(request, env) {
  const allowed = (env.ALLOWED_ORIGINS ||
    "https://atlas-systems.uk,https://www.atlas-systems.uk,https://status.atlas-systems.uk,http://localhost:8788")
    .split(",")
    .map((s) => s.trim());

  const origin = request.headers.get("Origin");
  const headers = {
    // Caches must key on Origin or one allowed origin's response would
    // be replayed (without the CORS header) to a different origin.
    Vary: "Origin",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Expose-Headers": "x-pulse-cache",
  };
  if (origin && allowed.includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}

/** Best-effort failure alert into atlas-notify; silent if not wired. */
async function alertFailure(env, err) {
  if (!env.NOTIFY_URL || !env.NOTIFY_TOKEN) return;
  try {
    await fetch(env.NOTIFY_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.NOTIFY_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        source: "alert",
        level: "warning",
        title: "github-pulse upstream failure",
        message: String(err?.message ?? err),
        fields: { service: "github-pulse" },
      }),
    });
  } catch {
    // Alerting is best-effort by definition; nothing useful to do here.
  }
}

function json(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}
