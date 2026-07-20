import worker from "./index.js";
import { getCommitCountSince, getCommitHeatmapSince } from "./lib/commitHistory.js";

const GITHUB_API = "https://api.github.com";
const LANGUAGE_REPO_LIMIT = 30;
const RECENT_COMMIT_REPO_LIMIT = 5;
const CACHE_ALL = "pulse:v2:all";
const CACHE_HEATMAP = "pulse:v2:heatmap";

async function gh(env, path) {
  const response = await fetch(`${GITHUB_API}${path}`, {
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "github-pulse (atlas-systems.uk)",
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub ${path} returned ${response.status}`);
  }
  return response.json();
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

function json(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function publicRepos(repos) {
  return repos.filter(
    (repo) => !repo.fork && repo.private !== true && repo.visibility !== "private",
  );
}

async function ownedRepos(env) {
  const repos = await gh(
    env,
    "/user/repos?per_page=100&affiliation=owner&visibility=all&sort=pushed",
  );
  return repos.filter((repo) => !repo.fork);
}

function repoCard(repo) {
  return {
    name: repo.name,
    description: repo.description,
    stars: repo.stargazers_count,
    language: repo.language,
    topics: repo.topics || [],
    pushedAt: repo.pushed_at,
    url: repo.html_url,
  };
}

function firstLine(message) {
  return message ? String(message).split("\n")[0] : "";
}

async function aggregateStats(env, user) {
  const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
  const allRepos = await ownedRepos(env);
  const visibleRepos = publicRepos(allRepos);

  const [languageMaps, commitTotal, recentCommitLists] = await Promise.all([
    Promise.all(
      visibleRepos
        .slice(0, LANGUAGE_REPO_LIMIT)
        .map((repo) => gh(env, `/repos/${user}/${repo.name}/languages`)),
    ),
    getCommitCountSince(env, user, allRepos.map((repo) => repo.name), ninetyDaysAgo),
    Promise.all(
      visibleRepos.slice(0, RECENT_COMMIT_REPO_LIMIT).map(async (repo) => {
        const commits = await gh(env, `/repos/${user}/${repo.name}/commits?per_page=5`);
        return commits.map((commit) => ({
          repo: repo.name,
          message: firstLine(commit.commit?.message),
          sha: (commit.sha || "").slice(0, 7),
          author: commit.commit?.author?.name || "unknown",
          date: commit.commit?.author?.date || null,
        }));
      }),
    ),
  ]);

  const byteTotals = {};
  for (const languageMap of languageMaps) {
    for (const [language, bytes] of Object.entries(languageMap)) {
      byteTotals[language] = (byteTotals[language] || 0) + bytes;
    }
  }
  const totalBytes = Object.values(byteTotals).reduce((sum, bytes) => sum + bytes, 0) || 1;
  const languages = Object.entries(byteTotals)
    .map(([name, bytes]) => ({ name, percent: Math.round((bytes / totalBytes) * 1000) / 10 }))
    .filter((language) => language.percent >= 0.5)
    .sort((a, b) => b.percent - a.percent);

  const recentCommits = recentCommitLists
    .flat()
    .filter((commit) => commit.date)
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .slice(0, 10);

  return {
    generatedAt: new Date().toISOString(),
    user,
    totals: {
      publicRepos: visibleRepos.length,
      stars: visibleRepos.reduce((sum, repo) => sum + repo.stargazers_count, 0),
      commitsLast90Days: commitTotal,
    },
    languages,
    repos: visibleRepos.map(repoCard),
    recentCommits,
  };
}

async function heatmapStats(env, user) {
  const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
  const allRepos = await ownedRepos(env);
  const visibleRepos = publicRepos(allRepos);
  const visibleNames = new Set(visibleRepos.map((repo) => repo.name));

  const { total, days, truncatedRepos } = await getCommitHeatmapSince(
    env,
    user,
    allRepos.map((repo) => repo.name),
    ninetyDaysAgo,
  );

  const languageCounts = {};
  for (const repo of visibleRepos) {
    if (!repo.language) continue;
    languageCounts[repo.language] = (languageCounts[repo.language] || 0) + 1;
  }
  const topLanguage =
    Object.entries(languageCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || null;

  return {
    generatedAt: new Date().toISOString(),
    user,
    rangeDays: 90,
    totals: {
      publicRepos: visibleRepos.length,
      commitsLast90Days: total,
      topLanguage,
    },
    days,
    truncated: truncatedRepos.length > 0,
    truncatedRepos: truncatedRepos.filter((name) => visibleNames.has(name)),
  };
}

async function cached(env, key, ttl, build, ctx) {
  const hit = await env.PULSE_CACHE.get(key);
  if (hit) return { body: hit, cache: "HIT" };
  const value = JSON.stringify(await build());
  const write = env.PULSE_CACHE.put(key, value, { expirationTtl: ttl });
  if (ctx?.waitUntil) ctx.waitUntil(write);
  else await write;
  return { body: value, cache: "MISS" };
}

async function publicRepoAllowed(env, user, name) {
  const repo = await gh(env, `/repos/${user}/${name}`);
  return repo.private !== true && repo.visibility !== "private";
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const user = env.GITHUB_USER || "AtlasReaper311";
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

    if (request.method === "GET" && isPulse && repoParam) {
      try {
        if (!(await publicRepoAllowed(env, user, repoParam))) {
          return json(404, { error: "repository not found" }, corsHeaders(request, env));
        }
      } catch {
        return json(404, { error: "repository not found" }, corsHeaders(request, env));
      }
      return worker.fetch(request, env, ctx);
    }

    if (request.method === "GET" && (isPulse || isHeatmap) && !repoParam) {
      if (!env.GITHUB_TOKEN) return worker.fetch(request, env, ctx);
      try {
        const ttl = Number(
          isHeatmap
            ? env.HEATMAP_TTL_SECONDS || 1800
            : env.CACHE_TTL_SECONDS || 3600,
        );
        const result = await cached(
          env,
          isHeatmap ? CACHE_HEATMAP : CACHE_ALL,
          ttl,
          () => (isHeatmap ? heatmapStats(env, user) : aggregateStats(env, user)),
          ctx,
        );
        return new Response(result.body, {
          status: 200,
          headers: {
            ...corsHeaders(request, env),
            "content-type": "application/json",
            "x-pulse-cache": result.cache,
            "Cache-Control": "public, max-age=300",
          },
        });
      } catch {
        return json(502, { error: "GitHub aggregate unavailable" }, {
          ...corsHeaders(request, env),
          "Cache-Control": "no-store",
        });
      }
    }

    return worker.fetch(request, env, ctx);
  },
};
