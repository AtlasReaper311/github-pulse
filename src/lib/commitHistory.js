/**
 * commitHistory.js
 *
 * GitHub GraphQL replacement for the /search/commits usage in aggregateStats
 * and heatmapStats. The REST search API is what was throwing intermittent
 * 503s (an HTML edge error page, not a JSON error). It runs on a separate
 * 30 req/min rate limit pool from the 5000/hr core limit, and GitHub
 * documents it as best-effort and eventually consistent.
 *
 * GraphQL's history(since:) has no "search all my repos" equivalent, so
 * instead of one search call this issues one batched query per chunk of
 * repos (aliased sub-queries), using the repo list the caller already has
 * from /users/:user/repos. That REST call is unchanged by this file.
 */

const GRAPHQL_URL = "https://api.github.com/graphql";
const BATCH_SIZE = 20;
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 400;

class GraphQLError extends Error {}

function toAlias(repoName) {
  return `r_${repoName.replace(/[^a-zA-Z0-9_]/g, "_")}`;
}

function chunk(array, size) {
  const out = [];
  for (let i = 0; i < array.length; i += size) out.push(array.slice(i, i + size));
  return out;
}

/**
 * POST to the GraphQL endpoint with retry/backoff and a hard guard against
 * non-JSON responses. GitHub's edge error page during an outage is HTML,
 * not JSON; calling response.json() on it throws an opaque SyntaxError,
 * which is what silently corrupted the old /search/commits failures. This
 * checks content-type before parsing and retries instead.
 */
async function graphqlRequest(token, query, variables) {
  let lastError;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, RETRY_BASE_MS * 2 ** (attempt - 1)));
    }

    let response;
    try {
      response = await fetch(GRAPHQL_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "User-Agent": "github-pulse (atlas-systems.uk)",
        },
        body: JSON.stringify({ query, variables }),
      });
    } catch (err) {
      lastError = new GraphQLError(`network error calling GitHub GraphQL: ${err.message}`);
      continue;
    }

    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) {
      lastError = new GraphQLError(`non-JSON response from GitHub GraphQL, status ${response.status}`);
      continue;
    }

    const body = await response.json();

    if (body.errors?.length) {
      const message = body.errors.map((e) => e.message).join("; ");
      const retryable = /rate limit|secondary|timeout|abuse/i.test(message);
      lastError = new GraphQLError(`GraphQL error: ${message}`);
      if (!retryable) throw lastError;
      continue;
    }

    return body.data;
  }

  throw lastError ?? new GraphQLError("GraphQL request failed with no captured error");
}

/**
 * Runs one batched history query for a chunk of repos. historySelection is
 * the GraphQL field set under history(...), letting callers ask for just
 * totalCount (cheap, aggregate mode) or totalCount plus commit dates
 * (heatmap mode) without duplicating the batching and retry logic.
 */
async function batchedHistoryQuery(token, owner, repoNames, since, historySelection) {
  const aliasFields = repoNames
    .map((name) => {
      const alias = toAlias(name);
      return `
        ${alias}: repository(owner: $owner, name: "${name}") {
          defaultBranchRef {
            target {
              ... on Commit {
                history(since: $since, first: 100) { ${historySelection} }
              }
            }
          }
        }
      `;
    })
    .join("\n");

  const query = `query BatchHistory($owner: String!, $since: GitTimestamp!) { ${aliasFields} }`;
  const data = await graphqlRequest(token, query, { owner, since });

  const result = {};
  for (const name of repoNames) {
    result[name] = data[toAlias(name)]?.defaultBranchRef?.target?.history ?? null;
  }
  return result;
}

/**
 * Total commit count across the given repos since `since`. Replaces the
 * per_page=1 /search/commits call in aggregateStats.
 */
export async function getCommitCountSince(env, user, repoNames, since) {
  let total = 0;
  for (const batch of chunk(repoNames, BATCH_SIZE)) {
    const results = await batchedHistoryQuery(env.GITHUB_TOKEN, user, batch, since, "totalCount");
    for (const history of Object.values(results)) {
      total += history?.totalCount ?? 0;
    }
  }
  return total;
}

/**
 * Per-day commit counts since `since`, plus the same total the aggregate
 * endpoint reports so the two stay consistent. Replaces the paginated
 * /search/commits loop in heatmapStats.
 *
 * Each repo's history is capped at its first 100 commits in the window
 * (GraphQL connection default). For a solo estate that comfortably covers
 * 90 days per repo. truncatedRepos lists any repo that hit the cap so the
 * frontend can flag it, mirroring the old heatmap truncation notice.
 */
export async function getCommitHeatmapSince(env, user, repoNames, since) {
  const days = {};
  let total = 0;
  const truncatedRepos = [];

  for (const batch of chunk(repoNames, BATCH_SIZE)) {
    const results = await batchedHistoryQuery(
      env.GITHUB_TOKEN,
      user,
      batch,
      since,
      "totalCount, nodes { committedDate } pageInfo { hasNextPage }",
    );

    for (const [name, history] of Object.entries(results)) {
      if (!history) continue;
      total += history.totalCount ?? 0;
      if (history.pageInfo?.hasNextPage) truncatedRepos.push(name);
      for (const node of history.nodes || []) {
        const key = node.committedDate?.slice(0, 10);
        if (!key) continue;
        days[key] = (days[key] || 0) + 1;
      }
    }
  }

  return { total, days, truncatedRepos };
}
