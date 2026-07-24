<div align="center">
  <img src="https://raw.githubusercontent.com/AtlasReaper311/AtlasReaper311/main/atlas-icon-dark-256.png" width="88" alt="Atlas Systems"/>
</div>

# github-pulse
  
```
┌─────────────────────────────────────────────┐
│  ATLAS SYSTEMS // github-pulse              │
│  live GitHub stats on the portfolio,        │
│  token stays server-side                    │
└─────────────────────────────────────────────┘
```

![Cloudflare Worker](https://img.shields.io/badge/cloudflare-worker-f5a623?style=flat-square&labelColor=0a0a0f)
![Cache](https://img.shields.io/badge/cache-workers%20kv-4ade80?style=flat-square&labelColor=0a0a0f)
![Upstream](https://img.shields.io/badge/upstream-GitHub%20API-aaa9a0?style=flat-square&labelColor=0a0a0f)
![Cost](https://img.shields.io/badge/cost-%C2%A30-aaa9a0?style=flat-square&labelColor=0a0a0f)

Read-only proxy between atlas-systems.uk and the GitHub API. The site fetches clean, bounded JSON documents; the Worker handles authentication, aggregation, workflow evidence, and caching.

```
browser ──▶ api.atlas-systems.uk/pulse ──▶ KV cache (1 h)
                    │                          │ miss
                    │                          ▼
                    └◀── one JSON doc ◀── GitHub API (token server-side)
```

Why a proxy instead of calling GitHub from the page: the token never ships to the browser, the KV cache means an hour of visitors costs one burst of API calls instead of one per view, and during a GitHub outage the site keeps serving the last cached snapshot.

## Prerequisites

- Node 20+ and `npx`
- A Cloudflare account holding the `atlas-systems.uk` zone, with the proxied `api` DNS record in place (the [atlas-notify README](https://github.com/AtlasReaper311/atlas-notify#setup) covers it; both Workers share that one record)
- A GitHub fine-grained personal access token with public repository read access

## Setup

```bash
npm install
npx wrangler login

# Create the cache namespace, then paste the printed id into
# wrangler.toml where it says REPLACE_WITH_NAMESPACE_ID:
npx wrangler kv namespace create PULSE_CACHE

npx wrangler secret put GITHUB_TOKEN
npx wrangler deploy
```

Verify the cache works end to end:

```bash
curl -sSi "https://api.atlas-systems.uk/pulse" | grep -i x-pulse-cache   # MISS
curl -sSi "https://api.atlas-systems.uk/pulse" | grep -i x-pulse-cache   # HIT
```

### Local development

```bash
cp .dev.vars.example .dev.vars   # add your GitHub token
npx wrangler dev                 # http://localhost:8787/pulse
```

`wrangler dev` simulates the KV binding locally; no extra setup.

## Usage

| Request | Returns |
|---|---|
| `GET /pulse` | Aggregate stats across the account |
| `GET /pulse?repo=<name>` | One repository in detail |
| `GET /pulse/heatmap` | Per-day commit counts for the last 90 days |
| `GET /pulse/workflows` | Freshness-aware health for the three allowlisted non-runtime Atlas tools |

`/pulse/workflows` is deliberately not a generic Actions proxy. It exposes only `atlas-badges`, `atlas-dep-audit`, and `atlas-journey-watch`, with no logs, actors, or arbitrary repository input. `atlas-badges` is healthy only when CI succeeded for the current `main` commit. The weekly dependency audit and six-hour journey watch accept their latest scheduled run or an explicitly dispatched recovery run of the same workflow; the newest accepted run must be successful and fresh. Running or overdue reads as `degraded`, a completed failure reads as `down`, and unavailable evidence reads as `unknown`.

Aggregate response shape:

```json
{
  "generatedAt": "2026-06-12T10:30:00.000Z",
  "user": "AtlasReaper311",
  "totals": { "publicRepos": 9, "stars": 14, "commitsLast90Days": 187 },
  "languages": [
    { "name": "Python", "percent": 41.2 },
    { "name": "JavaScript", "percent": 22.7 }
  ],
  "repos": [
    {
      "name": "ollama-rag-kit",
      "description": "Containerised local RAG pipeline",
      "stars": 3,
      "language": "Python",
      "topics": ["rag", "ollama"],
      "pushedAt": "2026-06-11T18:02:11Z",
      "url": "https://github.com/AtlasReaper311/ollama-rag-kit"
    }
  ],
  "recentCommits": [
    {
      "repo": "atlas-systems",
      "message": "Add pulse stats section to homepage",
      "sha": "a1b2c3d",
      "author": "Atlas Reaper",
      "date": "2026-06-11T18:02:11Z"
    }
  ]
}
```

Caching is observable: the `x-pulse-cache` header reads `HIT` or `MISS`, KV entries expire after an hour (`CACHE_TTL_SECONDS` in `wrangler.toml`), and browsers additionally cache for five minutes. Forks are excluded throughout. One documented trade-off: the 90-day commit count comes from the search API, which counts default-branch commits only, so feature-branch work appears once merged.

## Wiring it into the site

[`examples/fetch-snippet.js`](examples/fetch-snippet.js) is a dependency-free embed. Drop the markup into any page:

```html
<section data-pulse-root hidden>
  <p>
    <span data-pulse="repos"></span> repos //
    <span data-pulse="stars"></span> stars //
    <span data-pulse="commits90"></span> commits in 90 days
  </p>
  <div data-pulse="languages"></div>
  <ul data-pulse="recent-commits"></ul>
</section>
<script src="/js/fetch-snippet.js" defer></script>
```

The section stays hidden until data arrives and simply never appears if the API is unreachable. Rendering uses `textContent` only, so commit messages cannot inject markup into the page.

## How it fits into Atlas Systems

This is the live-data layer of the portfolio: the homepage stops claiming activity and starts showing it, straight from the source. It shares the `api.atlas-systems.uk` hostname with [`atlas-notify`](https://github.com/AtlasReaper311/atlas-notify), and optionally reports its own upstream failures there (set `NOTIFY_URL` and `NOTIFY_TOKEN`; silent if unset).

The transferable pattern is backend-for-frontend: a thin server-side gateway that holds the credential, reshapes a third-party API into exactly what one page needs, and absorbs traffic with a cache.

---

Part of [atlas-systems.uk](https://atlas-systems.uk)
