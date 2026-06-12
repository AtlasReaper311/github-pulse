# Why this exists

## Context

The portfolio site describes work; the GitHub account contains the
evidence. Bridging them with a static "see my GitHub" link asks the
visitor to do the work, and bridging them with hand-updated numbers
guarantees the numbers go stale. The site should render live activity:
repo count, stars, recent commits, language mix.

## Options considered

**Call the GitHub API from the browser.** No infrastructure, but
unauthenticated calls share a 60-requests-per-hour-per-IP budget that
one aggregate page load nearly exhausts, and authenticating means
shipping a token to every visitor's devtools. Not viable.

**Bake stats in at build time.** A GitHub Action regenerating a JSON
file on a schedule. Workable and free, but the data is only as fresh as
the cron, every refresh is a commit of generated noise into the site
repo, and it demonstrates nothing about API design.

**A Worker proxy with a KV cache.** The token lives in a Worker secret,
the cache makes an hour of visitors cost one burst of GitHub calls, and
a GitHub outage degrades to serving the last snapshot. Costs: another
deployed service, and a cache that can serve data up to an hour old.
Both fine for portfolio statistics.

## Decision

A read-only Worker at `api.atlas-systems.uk/pulse` returning one
aggregate JSON document, with `?repo=` for single-repo detail. KV
caching with a one-hour TTL and an `x-pulse-cache: HIT|MISS` header,
because a cache whose behaviour is observable from `curl` is a cache
that can be trusted and debugged.

Boundary decisions that mattered: CORS is an explicit allowlist rather
than a wildcard, so other sites cannot quietly build on this endpoint's
cache and rate budget; the `repo` parameter is regex-validated before
it touches a URL path; forks are excluded so the numbers describe work,
not clicks; and error responses carry `Cache-Control: no-store` so an
upstream failure can never get cached and outlive the outage. The
90-day commit count uses the search API and counts default-branch
commits only; documented rather than hidden, because a stat with a
known bias beats a stat with a secret one.

## Consequences

The homepage renders live numbers with a single fetch, the token never
leaves Cloudflare, and GitHub sees at most a handful of requests per
hour regardless of traffic. The accepted cost is staleness bounded at
one hour plus a second small service to own.

The transferable principle: when a frontend needs third-party data,
put a thin gateway in front of it that holds the credential, reshapes
the response to exactly what the page needs, and caches. The pattern is
backend-for-frontend, and it is the same shape at every scale from a
50-line Worker to an enterprise API gateway.
