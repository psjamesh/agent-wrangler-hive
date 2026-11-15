# PR observations and query budget

Hive's PR sweep runs every 60 seconds. Each non-terminal ledger record gets one state observation per sweep. A successful MERGED or CLOSED observation with a verified GraphQL node id is retained and ends routine state reads, including across restarts. Legacy records without a node id get one migration read before terminal filtering applies. Each state observation verifies the node id and PR creation time; a changed id replaces stale state and attribution with the current session link, or an unassigned record when no link exists. For legacy records, a PR created after first sight proves URL reuse; records without a trustworthy first-sight time are replaced conservatively. Pending attribution labels remain eligible for completion after a PR ends.

Discovery searches each known repository for the 100 most recently updated open PRs labelled `hive`, at most once every five minutes per running tracker. Failures use the existing per-query, repository and authentication backoff. Restarting a tracker resets the successful-search cooldown. An open search result schedules a fresh state read, so a reopened labelled PR resumes observations. A new current link association, or a newer core link observation (core keeps links only while open), also schedules verification of terminal records. This can recover an unlabelled reopened PR through its session link. Reopening an unlinked PR without the label, or outside the bounded result set, is not discovered automatically. Search hits never synthesize OPEN state with stale check data.

Closed-bead PR attention requires a successful OPEN observation taken after the bead closed. A failed refresh or an older cached OPEN state cannot confirm that the link is stale. A known MERGED/CLOSED state clears this attention.

## Steady-state cost

`test/pr-tracking.test.mjs` exercises 20 open and 100 historical PRs over 60 one-minute sweeps. It asserts 1,200 state queries and 12 searches per repository. Without terminal filtering and the discovery cooldown, that fixture makes 7,200 state queries and 60 searches per repository.

Using the small-response measurements in [the investigation](investigations/ci-and-deploy-watching.md), state queries cost approximately one GraphQL point each. Each search adds approximately one GraphQL repository-resolution point plus one REST search request (pagination can add requests). For N open PRs and R repositories, Hive's hourly estimate is **60N + 12R GraphQL points**, plus **12R REST search requests**. This excludes the one-time identity migration (one state query per legacy record), initial label checks/writes, final transitions, relink/core-observation reconciliation, retries, restarts and other clients sharing the same GitHub budget.

At 20 open PRs in five repositories, Hive adds approximately **1,260 GraphQL points and 60 REST search requests/hour**, regardless of historical ledger size. With core's existing 2,400-point estimate for 20 unique open links, the combined estimate is **3,660 GraphQL points/hour**. Duplicate owner links in core add cost.

## Shared core observer dependency

The extension consumes core through its public host API only. `host.links.get(sessionId)` exposes stored session links and derived check status/head metadata. It does not provide Hive's full state observation (raw check rollup, draft flag, merge state, title and review fields), or retain the final observation after core removes a merged/closed link. A missing link cannot prove a merge.

Replacing Hive's active-state reads requires a URL-keyed host observation API with freshness/error information, full PR state fields including stable node identity/creation time and retained terminal observations. Derived notifications alone cannot preserve Hive's existing readiness behavior. The queen tracks that API addition separately; this implementation keeps the independent state reads until that contract exists.
