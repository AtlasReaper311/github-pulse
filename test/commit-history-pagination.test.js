import assert from "node:assert/strict";
import test from "node:test";

import { getCommitHeatmapSince } from "../src/lib/commitHistory.js";

function jsonResponse(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

test("heatmap pagination completes repositories that exceed the first 100 commits", async (t) => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (_url, init) => {
    const request = JSON.parse(init.body);
    calls.push(request);
    if (calls.length === 1) {
      return jsonResponse({
        data: {
          r_busy_repo: {
            defaultBranchRef: {
              target: {
                history: {
                  totalCount: 150,
                  nodes: Array.from({ length: 100 }, () => ({ committedDate: "2026-08-09T12:00:00Z" })),
                  pageInfo: { hasNextPage: true, endCursor: "cursor-100" },
                },
              },
            },
          },
        },
      });
    }
    return jsonResponse({
      data: {
        repository: {
          defaultBranchRef: {
            target: {
              history: {
                nodes: Array.from({ length: 50 }, () => ({ committedDate: "2026-08-10T12:00:00Z" })),
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        },
      },
    });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const result = await getCommitHeatmapSince(
    { GITHUB_TOKEN: "test-token" },
    "AtlasReaper311",
    ["busy-repo"],
    "2026-05-13T00:00:00Z",
  );

  assert.equal(result.total, 150);
  assert.equal(result.days["2026-08-09"], 100);
  assert.equal(result.days["2026-08-10"], 50);
  assert.deepEqual(result.truncatedRepos, []);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].variables.after, "cursor-100");
});
