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
const HISTORY_PAGE_SIZE = 100;
const MAX_HEATMAP_PAGES_PER_REPO = 10;
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
                history(since: $since, first: ${HISTORY_PAGE_SIZE}) { ${historySelection} }
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

/** Fetch one continuation page for a repository that exceeded the batched page. */
async function repositoryHistoryPage(token, owner, name, since, after) {
  const query = `
    query RepoHistory($owner: String!, $name: String!, $since: GitTimestamp!, $after: String!) {
      repository(owner: $owner, name: $name) {
        defaultBranchRef {
          target {
            ... on Commit {
              history(since: $since, first: ${HISTORY_PAGE_SIZE}, after: $after) {
                nodes { committedDate }
                pageInfo { hasNextPage endCursor }
              }
            }
          }
        }
      }
    }
  `;
  const data = await graphqlRequest(token, query, { owner, name, since, after });
  return data?.repository?.defaultBranchRef?.target?.history ?? null;
}

function addCommitDates(days, nodes) {
  for (const node of nodes || []) {
    const key = node.committedDate?.slice(0, 10);
    if (!key) continue;
    days[key] = (days[key] || 0) + 1;
  }
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
 * endpoint reports so the two stay consistent. The first 100 commits for
 * every repository are fetched in the normal batched request. Only repos
 * that actually exceed that page are continued individually, avoiding the
 * previous false assumption that no repo would exceed 100 commits in a
 * 90-day window.
 *
 * Continuation is deliberately bounded to ten 100-commit pages per repo.
 * A repo that still has another page, or whose continuation cannot be read
 * after retries, remains listed in truncatedRepos so callers never turn a
 * partial distribution into measured zeroes.
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
      "totalCount, nodes { committedDate } pageInfo { hasNextPage endCursor }",
    );

    for (const [name, history] of Object.entries(results)) {
      if (!history) continue;
      total += history.totalCount ?? 0;
      addCommitDates(days, history.nodes);

      let hasNextPage = history.pageInfo?.hasNextPage === true;
      let cursor = history.pageInfo?.endCursor ?? null;
      let pagesFetched = 1;
      let continuationFailed = false;

      while (hasNextPage && cursor && pagesFetched < MAX_HEATMAP_PAGES_PER_REPO) {
        let page;
        try {
          page = await repositoryHistoryPage(env.GITHUB_TOKEN, user, name, since, cursor);
        } catch {
          continuationFailed = true;
          break;
        }
        if (!page) {
          continuationFailed = true;
          break;
        }
        addCommitDates(days, page.nodes);
        pagesFetched += 1;
        hasNextPage = page.pageInfo?.hasNextPage === true;
        cursor = page.pageInfo?.endCursor ?? null;
      }

      if (hasNextPage || continuationFailed) truncatedRepos.push(name);
    }
  }

  return { total, days, truncatedRepos };
}
