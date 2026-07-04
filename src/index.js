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
 */

import { handleMeta } from "./_meta.js";

const REPO_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,100}$/;

// The free plan allows 50 subrequests per invocation. Aggregate mode
// spends: 1 repos + 1 search + N languages + M recent-commits + 2 KV.
// Capping language lookups at 30 and recent-commit lookups at 5 keeps
// the worst case at 39, comfortable headroom under the limit.
const LANGUAGE_REPO_LIMIT = 30;
const RECENT_COMMIT_REPO_LIMIT = 5;

// Heatmap mode uses search/commits pagination instead of per-repo loops.
// 100 commits per page × HEATMAP_MAX_PAGES = ceiling on how far back we
// can reliably colour. 10 pages = up to 1000 commits in the window,
// which comfortably covers 90 days for any normal account while
// spending at most 10 subrequests on the search itself (+1 repos call
// for totals/topLanguage). Increase if you regularly push >1000
// commits in 90 days.
const HEATMAP_MAX_PAGES = 10;
const HEATMAP_PER_PAGE = 100;

const GITHUB_API = "https://api.github.com";

const META = {
  name: "github-pulse",
  description: "Read-only GitHub activity feed for atlas-systems.uk, cached at the edge",
  version: "1.0.0",
  endpoints: [
    { method: "GET", path: "/pulse", description: "Aggregate public GitHub stats across the account" },
    { method: "GET", path: "/pulse?repo=<name>", description: "Detailed stats for one repository" },
    { method: "GET", path: "/pulse/heatmap", description: "Per-day commit counts for the last 90 days" },
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
    const repoParam = url.searchParams.get("repo");

    if (!isHeatmap && repoParam && !REPO_NAME_PATTERN.test(repoParam)) {
      return json(400, { error: "invalid repo name" }, cors);
    }

    // Heatmap data is heavier per build but stable enough to cache a
    // bit longer than the live aggregate. Tunable per-env if needed.
    const cacheKey = isHeatmap
      ? "pulse:v1:heatmap"
      : `pulse:v1:${repoParam || "all"}`;
    const ttl = isHeatmap
      ? Number(env.HEATMAP_TTL_SECONDS || 1800)
      : Number(env.CACHE_TTL_SECONDS || 3600);

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
          "Cache-Control": "public, max-age=300",
        },
      });
    }

    try {
      const data = isHeatmap
        ? await heatmapStats(env, user)
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
          "Cache-Control": "public, max-age=300",
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

/** Authenticated GitHub request returning parsed JSON or GitHubError. */
async function gh(env, path) {
  const response = await fetch(`${GITHUB_API}${path}`, {
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      // GitHub rejects requests without a User-Agent outright.
      "User-Agent": "github-pulse (atlas-systems.uk)",
    },
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new GitHubError(response.status, `GitHub ${path} returned ${response.status}: ${detail.slice(0, 200)}`);
  }
  return response.json();
}

/** Aggregate stats across the whole account. */
async function aggregateStats(env, user) {
  // The two top-level calls are independent; running them in parallel
  // keeps cold-path latency near the slowest call instead of the sum.
  const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);

  const [repos, commitSearch] = await Promise.all([
    gh(env, `/users/${user}/repos?per_page=100&type=owner&sort=pushed`),
    gh(env, `/search/commits?q=author:${user}+author-date:>=${ninetyDaysAgo}&per_page=1`),
  ]);

  // Forks out: the pulse reports what this account builds, not what it
  // has clicked "fork" on.
  const ownRepos = repos.filter((r) => !r.fork);

  // Language bytes per repo, aggregated. Capped to stay inside the free
  // plan's subrequest budget; repos are pre-sorted by pushed date, so
  // the cap drops only the longest-dormant ones.
  const languageMaps = await Promise.all(
    ownRepos.slice(0, LANGUAGE_REPO_LIMIT).map((r) => gh(env, `/repos/${user}/${r.name}/languages`)),
  );
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

  // Recent commits: ground truth from each repo's real Commits API,
  // not the public events feed. GitHub's events feed marks a push's
  // commits "non-distinct" (and omits them entirely) when it judges
  // them already visible from an earlier push to the same branch,
  // which a day of small successive web-UI commits trips constantly,
  // silently producing an empty "no recent activity" read. Since repos
  // are already sorted by pushed date above, only the handful most
  // likely to actually contain the most recent commits are queried
  // directly here, keeping this well inside the subrequest budget.
  const recentCommitLists = await Promise.all(
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
  );
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
      // Search counts default-branch commits only; feature-branch work
      // appears once merged. Documented trade-off (see README).
      commitsLast90Days: commitSearch.total_count,
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
 * Strategy: paginate /search/commits with author + author-date >=
 * cutoff, bucket each commit's author.date into its YYYY-MM-DD. This
 * is dramatically cheaper than iterating /repos/.../commits per repo,
 * and uses the same data source as the 90-day total on the aggregate
 * endpoint — so the heatmap's per-day sum will match the headline
 * number exactly.
 *
 * Caveat (worth knowing, not worth fixing here): search/commits indexes
 * default-branch commits only, same as the aggregate count. Work that
 * only ever lived on a feature branch won't appear until merged. This
 * matches the existing /pulse contract — better to be consistent than
 * to silently disagree with the headline number.
 */
async function heatmapStats(env, user) {
  const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);

  // Repos call is reused for publicRepos + topLanguage. Done in
  // parallel with the first search page to keep cold-path latency low.
  const firstPagePromise = gh(
    env,
    `/search/commits?q=author:${user}+author-date:>=${ninetyDaysAgo}&per_page=${HEATMAP_PER_PAGE}&page=1`,
  );
  const reposPromise = gh(env, `/users/${user}/repos?per_page=100&type=owner&sort=pushed`);

  const [firstPage, repos] = await Promise.all([firstPagePromise, reposPromise]);
  const ownRepos = repos.filter((r) => !r.fork);

  const days = {};
  const bucket = (items) => {
    for (const item of items || []) {
      const iso = item.commit?.author?.date;
      if (!iso) continue;
      const key = iso.slice(0, 10); // YYYY-MM-DD
      days[key] = (days[key] || 0) + 1;
    }
  };

  bucket(firstPage.items);

  const totalCount = firstPage.total_count || 0;
  const totalPages = Math.min(
    HEATMAP_MAX_PAGES,
    Math.ceil(totalCount / HEATMAP_PER_PAGE),
  );

  // Pages 2..N in parallel. Search API caps at 1000 results regardless,
  // so HEATMAP_MAX_PAGES=10 is the natural ceiling anyway.
  if (totalPages > 1) {
    const rest = await Promise.all(
      Array.from({ length: totalPages - 1 }, (_, i) =>
        gh(
          env,
          `/search/commits?q=author:${user}+author-date:>=${ninetyDaysAgo}&per_page=${HEATMAP_PER_PAGE}&page=${i + 2}`,
        ),
      ),
    );
    for (const page of rest) bucket(page.items);
  }

  // Top language across owned repos. Uses the single `language` field
  // on each repo (already in the repos payload) rather than the more
  // accurate per-repo /languages endpoint — that would cost N extra
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
      commitsLast90Days: totalCount,
      topLanguage,
    },
    days,
    // Truncated flag lets the frontend show a small note if we hit the
    // pagination ceiling and the real total exceeds what we bucketed.
    truncated: totalCount > HEATMAP_MAX_PAGES * HEATMAP_PER_PAGE,
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
