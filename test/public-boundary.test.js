import assert from "node:assert/strict";
import test from "node:test";

import worker from "../src/public-boundary.js";

test("repository detail requests fail closed when GitHub marks the repository private", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    JSON.stringify({ name: "owner-private-service", private: true, visibility: "private" }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

  try {
    const response = await worker.fetch(
      new Request("https://api.atlas-systems.uk/pulse?repo=owner-private-service"),
      {
        GITHUB_TOKEN: "test-token",
        GITHUB_USER: "AtlasReaper311",
      },
      {},
    );
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: "repository not found" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
