/**
 * github-pulse frontend snippet for atlas-systems.uk
 *
 * Vanilla JS, no dependencies, fails silently: if the API is down the
 * stats simply do not appear, and the rest of the page is untouched.
 *
 * Markup contract (data attributes, hidden until data arrives):
 *
 *   <section data-pulse-root hidden>
 *     <span data-pulse="repos"></span>
 *     <span data-pulse="stars"></span>
 *     <span data-pulse="commits90"></span>
 *     <div data-pulse="languages"></div>
 *     <ul data-pulse="recent-commits"></ul>
 *   </section>
 *
 * Include any subset; missing elements are skipped. All rendering uses
 * textContent and createElement, never innerHTML, so commit messages
 * (attacker-influenced strings, in principle) cannot inject markup.
 */

const PULSE_ENDPOINT = "https://api.atlas-systems.uk/pulse";

async function initPulse() {
  const root = document.querySelector("[data-pulse-root]");
  if (!root) return;

  let data;
  try {
    const response = await fetch(PULSE_ENDPOINT);
    if (!response.ok) return;
    data = await response.json();
  } catch {
    return; // No stats beats a broken page section.
  }

  setText(root, "repos", data.totals.publicRepos);
  setText(root, "stars", data.totals.stars);
  setText(root, "commits90", data.totals.commitsLast90Days);
  renderLanguages(root, data.languages);
  renderCommits(root, data.recentCommits);

  root.hidden = false;
}

function setText(root, key, value) {
  const el = root.querySelector(`[data-pulse="${key}"]`);
  if (el) el.textContent = String(value);
}

/** Render languages as labelled proportional bars. */
function renderLanguages(root, languages) {
  const el = root.querySelector('[data-pulse="languages"]');
  if (!el || !languages?.length) return;

  el.replaceChildren();
  for (const lang of languages.slice(0, 6)) {
    const row = document.createElement("div");
    row.className = "pulse-lang";

    const label = document.createElement("span");
    label.className = "pulse-lang-name";
    label.textContent = `${lang.name} ${lang.percent}%`;

    const track = document.createElement("div");
    track.className = "pulse-lang-track";
    const bar = document.createElement("div");
    bar.className = "pulse-lang-bar";
    bar.style.width = `${lang.percent}%`;
    track.appendChild(bar);

    row.append(label, track);
    el.appendChild(row);
  }
}

/** Render the recent commit feed as terminal-style lines. */
function renderCommits(root, commits) {
  const el = root.querySelector('[data-pulse="recent-commits"]');
  if (!el || !commits?.length) return;

  el.replaceChildren();
  for (const commit of commits) {
    const li = document.createElement("li");
    li.className = "pulse-commit";

    const sha = document.createElement("code");
    sha.textContent = commit.sha;

    const repo = document.createElement("span");
    repo.className = "pulse-commit-repo";
    repo.textContent = ` ${commit.repo} `;

    const message = document.createElement("span");
    message.textContent = commit.message;

    li.append(sha, repo, message);
    el.appendChild(li);
  }
}

/*
 * Suggested styles, matching the Atlas brand sheet:
 *
 *   .pulse-lang-track { background: #1a1a24; height: 6px; }
 *   .pulse-lang-bar   { background: #f5a623; height: 6px; }
 *   .pulse-commit code { color: #f5a623; }
 *   .pulse-commit-repo { color: #555560; }
 */

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initPulse);
} else {
  initPulse();
}
