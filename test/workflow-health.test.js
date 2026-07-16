import assert from "node:assert/strict";
import test from "node:test";

import worker, {
  WORKFLOW_TARGETS,
  classifyWorkflowRun,
} from "../src/index.js";

const NOW = Date.parse("2026-07-16T12:00:00.000Z");

function run(overrides = {}) {
  return {
    id: 42,
    status: "completed",
    conclusion: "success",
    head_sha: "abc123",
    updated_at: "2026-07-16T11:00:00.000Z",
    html_url: "https://github.com/AtlasReaper311/example/actions/runs/42",
    ...overrides,
  };
}

test("head-mode workflow health proves the current main commit", () => {
  const target = WORKFLOW_TARGETS.find((item) => item.id === "atlas-badges");
  const healthy = classifyWorkflowRun(target, run(), {
    headSha: "abc123",
    nowMs: NOW,
  });
  assert.equal(healthy.status, "healthy");
  assert.equal(healthy.head_sha_matches, true);

  const awaiting = classifyWorkflowRun(target, run(), {
    headSha: "new-head",
    nowMs: NOW,
  });
  assert.equal(awaiting.status, "degraded");
  assert.match(awaiting.detail, /awaits CI/);

  const failed = classifyWorkflowRun(
    target,
    run({ conclusion: "failure" }),
    { headSha: "abc123", nowMs: NOW },
  );
  assert.equal(failed.status, "down");
});

test("scheduled workflow health distinguishes overdue, running, and failed", () => {
  const target = WORKFLOW_TARGETS.find(
    (item) => item.id === "atlas-journey-watch",
  );
  const overdue = classifyWorkflowRun(
    target,
    run({ updated_at: "2026-07-16T00:00:00.000Z" }),
    { nowMs: NOW },
  );
  assert.equal(overdue.status, "degraded");
  assert.match(overdue.detail, /overdue/);

  const running = classifyWorkflowRun(
    target,
    run({ status: "in_progress", conclusion: null }),
    { nowMs: NOW },
  );
  assert.equal(running.status, "degraded");

  const failed = classifyWorkflowRun(
    target,
    run({ conclusion: "timed_out" }),
    { nowMs: NOW },
  );
  assert.equal(failed.status, "down");
});

test("missing workflow evidence fails closed to unknown", () => {
  const target = WORKFLOW_TARGETS[0];
  const result = classifyWorkflowRun(target, null, { nowMs: NOW });
  assert.equal(result.status, "unknown");
  assert.equal(result.measured_at, null);
  assert.match(result.evidence_source, /atlas-badges/);
});

test("workflow endpoint exposes only the three allowlisted evidence records", async () => {
  const realFetch = globalThis.fetch;
  const stored = new Map();
  const tasks = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/commits/main")) {
      return Response.json({ sha: "abc123" });
    }
    const repo = url.pathname.split("/")[2];
    const updatedAt = repo === "atlas-dep-audit"
      ? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
      : new Date(Date.now() - 60 * 60 * 1000).toISOString();
    return Response.json({
      workflow_runs: [run({ updated_at: updatedAt })],
    });
  };

  try {
    const env = {
      GITHUB_TOKEN: "test-token",
      GITHUB_USER: "AtlasReaper311",
      PULSE_CACHE: {
        async get(key) {
          return stored.get(key) ?? null;
        },
        async put(key, value) {
          stored.set(key, value);
        },
        async delete(key) {
          stored.delete(key);
        },
      },
    };
    const ctx = {
      waitUntil(promise) {
        tasks.push(promise);
      },
    };
    const response = await worker.fetch(
      new Request("https://api.atlas-systems.uk/pulse/workflows"),
      env,
      ctx,
    );
    await Promise.all(tasks);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(Object.keys(body.workflows), [
      "atlas-badges",
      "atlas-dep-audit",
      "atlas-journey-watch",
    ]);
    assert.equal(body.workflows["atlas-badges"].status, "healthy");
    assert.equal(response.headers.get("x-pulse-cache"), "MISS");
    assert.ok(stored.has("pulse:v1:workflow-health"));
  } finally {
    globalThis.fetch = realFetch;
  }
});
