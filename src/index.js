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
 * GET /pulse            aggregate stats across the account
 * GET /pulse?repo=name  one repository in detail
 */

const REPO_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,100}$/;

// The free plan allows 50 subrequests per invocation. Aggregate mode
// spends: 1 repos + 1 search + N languages + M recent-commits + 2 KV.
// Capping language lookups at 30 and recent-commit lookups at 5 keeps
// the worst case at 39, comfortable headroom under the limit.
const LANGUAGE_REPO_LIMIT = 30;
const RECENT_COMMIT_REPO_LIMIT = 5;

const GITHUB_API = "https://api.github.com";

class GitHubError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
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

    const repoParam = url.searchParams.get("repo");
    if (repoParam && !REPO_NAME_PATTERN.test(repoParam)) {
      return json(400, { error: "invalid repo name" }, cors);
    }

    const user = env.GITHUB_USER || "AtlasReaper311";
    const cacheKey = `pulse:v1:${repoParam || "all"}`;
    const ttl = Number(env.CACHE_TTL_SECONDS || 3600);

    // Serve from KV when possible. The x-pulse-cache header makes cache
    // behaviour observable from curl, which turns "is the cache
