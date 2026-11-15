# Where Hive should stop: CI and deployment watching

Investigation: 15 November 2026. This is a recommendation, not an implemented policy.

## Recommendation

Make a verified PR merge the default delivery boundary for a code-change bead. Continue through installation, release or deployment when the task's acceptance explicitly requires it, using a named, bounded verification contract. Do not infer that every repository has an automatic deployment or that a green workflow proves production health.

Use Agent Wrangler's existing observations to finish pre-merge waits. Hive should own the durable wait, its deadline and the action after it resolves; it should share GitHub observations with core rather than create another worker polling loop. Fix that ownership gap before adding general deployment watching.

For post-merge failures, rely on the repository's existing operational notifications by default. Offer repository opt-in verification where the exact workflow or deployment environment and commit relationship are known. A webhook-backed shared observer is a useful future transport, but does not remove the need to define what “delivered” means.

## Evidence and limits

Read-only investigation used `gh` and source inspection. No workflows were dispatched or rerun. Five repositories were surveyed: public Agent Wrangler core and Hive, plus three private/internal examples. Private examples are anonymized here; their identities, workflow references and operational detail were provided privately to the coordinator.

For each repository, the initial sample was its latest 100 runs, using:

```sh
gh run list --repo OWNER/REPO --limit 100 \
  --json workflowName,event,status,conclusion,createdAt,startedAt,updatedAt
```

Up to 20 additional runs per selected release workflow were retrieved where frequent unrelated jobs crowded the initial sample. Duration means `updatedAt - startedAt` for completed runs, not runner billing or a job's execution time. It includes queueing and orchestration after the run starts, can include final metadata-update delay, and excludes waiting for a future scheduled release. Medians include successes and failures; supplementary release summaries exclude cancelled/skipped runs. A quick failure can therefore make a long suite look deceptively fast. Samples describe recent observed activity, not an SLA or a statistically representative history.

Remote default-branch workflow inventories were compared with local files. Changed definitions were read through `gh api`; local private checkouts were sufficiently stale to give a wrong account of release triggers. The initial 100-run windows covered 14–15 November for core, Hive and the application example, 10–15 November for experiment tooling, and 12–14 November for infrastructure. Supplementary release samples extend further back.

## Pipeline shapes

| Repository or anonymized example | Triggers and observed durations | After merge / deployment | Failure signals found |
| --- | --- | --- | --- |
| Agent Wrangler core | `Test` on PR opened/synchronize/reopened: median **135.5s**, range 121–147s, n=50. Two weekly/manual maintenance workflows: median 25s each, n=9 and n=3. Dependabot helper runs on PRs but skips ordinary authors. | No push-to-main test or deployment workflow in the four-file inventory. Maintenance workflows open refresh PRs; they are not deployment gates. A user's local install/restart is separate acceptance work. | PR checks and linked-PR Wrangler notifications. Maintenance workflows explicitly notify Slack on failure when configured; the ordinary test workflow has no custom failure sender. |
| Hive | `Test` on PR opened/synchronize/reopened: **51s**, range 45–78s, n=62. Push to main: **49s**, range 45–56s, n=38. | Main runs tests again. No release/deploy workflow in the one-file inventory; a successful main test does not prove the extension was installed in a running Wrangler. | GitHub Actions/check results; linked-PR Wrangler notifications before merge. No custom failure-notification step in the workflow. |
| Large application example | PR validation includes several independent suites; sampled ordinary checks take roughly 9–37 minutes. Scheduled suites can take about 3 hours. Manual long-running experiments also exist. | Push-driven continuous delivery, reusable release workflows, scheduled/manual releases and completion-triggered downstream workflows coexist. Sampled continuous delivery: **56m15s** median, n=17 non-cancelled runs. A separate release-test sample: **45m36s**, n=18. There is no single “all CI for this PR has finished” boundary. | Explicit release success/failure chat notifications; suite-specific chat notifications and PR feedback. Coverage varies by workflow and configuration. |
| Experiment tooling example | Path-filtered PR tests: **230.5s**, n=28; corresponding main-push tests: **226s**, n=6. Manual experiment sample: **2h02m59s**, n=21, range 4m54s–5h32m01s; successful-run median **2h21m25s**, n=17. Scheduled/manual reporting and diagnostics are distinct workflows. | Selected main-branch changes publish a supporting artifact; experiments are separately dispatched or scheduled. Merging a tooling change does not imply running an experiment or deploying a service. | GitHub results and artifacts. A reporting path can post to chat, but that is not a universal failure notifier; no general failure sender was found in the sampled long experiment workflow. |
| Infrastructure example | PR validation: **16s**, n=27. Main-push change notification/orchestration: **51s**, n=23, range 17–98s; manual invocation also supported. | The post-merge workflow hands work to an external coordinator and streams its result. Success proves the represented orchestration finished; further rollout/health guarantees must come from that contract. | External errors fail the Actions step and appear in its log. No separate chat failure sender in the two repository workflow files. Downstream alert subscriptions were outside this inspection. |

Custom notification steps show that a sender exists, not that its secret is configured or that somebody received the message. GitHub's own notification delivery depends on the recipient's settings; neither the absence of a custom sender nor a green PR establishes an operational alert guarantee. See [GitHub notification settings](https://docs.github.com/en/account-and-profile/managing-subscriptions-and-notifications-on-github/setting-up-notifications/configuring-notifications).

Public workflow evidence: [core workflows](https://github.com/PortSwigger/agent-wrangler/tree/2c4998a1ab74433f5f37502c18cb3f73be762455/.github/workflows), [Hive Test](https://github.com/psjamesh/agent-wrangler-hive/blob/c56973b4e11c3f443625e68074b216fefe1a87c3/.github/workflows/test.yml). Example observations: [core Test run](https://github.com/PortSwigger/agent-wrangler/actions/runs/43725917578), [Hive PR run](https://github.com/psjamesh/agent-wrangler-hive/actions/runs/43731107242), [Hive main run](https://github.com/psjamesh/agent-wrangler-hive/actions/runs/43730088968).

The important distinction is between PR readiness, a main-branch build, publication, installation and healthy deployment. These may run on different commits, schedules, repositories and systems. Following every new main-branch run would also attach unrelated work to the original bead.

## What Wrangler already observes

Core's links feature is a **poller**, not a GitHub webhook consumer. Its default interval is **60 seconds**, with a positive configuration override. A guarded full sweep prevents overlapping full sweeps; a targeted refresh on attaching/changing links is separate. Links are fetched sequentially. There is no cross-owner URL deduplication in this sweep: the same PR attached to a task and two sessions costs three observations.

For each open stored link it runs:

1. `gh pr view` for PR state, head SHA, check/status rollup, merge state and review decision.
2. A separate GraphQL query for unresolved review threads, capped at the first 100 threads.

The returned data produces local board/pane events for mergeable, failing, awaiting-review and changes-requested transitions, merge conflicts and new unresolved review threads. These are derived Wrangler events, not subscriptions to GitHub `check_run`, `status` or deployment webhooks. “Failing” is derived from the observed rollup, which can include optional checks; merge readiness also consults GitHub's merge state.

Task links produce board notifications. Session links can notify the worker when effective Auto-fix PR checks is enabled; session configuration overrides the installation default. Auto-merge has a separate gate. Check notifications are deduplicated by the last notified status and head SHA; pending/none do not notify, and startup seeds the baseline. A failing same-head rerun can finish without another failure notice. Worker delivery can also be delayed or unavailable. Existing notifications are useful hints, not durable acknowledgement that a particular wait completed.

Core removes links when it observes `MERGED` or `CLOSED`, skipping the thread query on that final observation. Merge/close pane notification only targets a live pane. It does **not** follow main-branch Actions runs or deployments after that removal.

Sources: [poll loop and lifecycle](https://github.com/PortSwigger/agent-wrangler/blob/2c4998a1ab74433f5f37502c18cb3f73be762455/server/index.js), [query and rollup derivation](https://github.com/PortSwigger/agent-wrangler/blob/2c4998a1ab74433f5f37502c18cb3f73be762455/server/pr-status.js), [notifier gates/deduplication](https://github.com/PortSwigger/agent-wrangler/blob/2c4998a1ab74433f5f37502c18cb3f73be762455/server/notifier.js), [poll interval](https://github.com/PortSwigger/agent-wrangler/blob/2c4998a1ab74433f5f37502c18cb3f73be762455/server/config-store.js), [links guidance](https://github.com/PortSwigger/agent-wrangler/blob/2c4998a1ab74433f5f37502c18cb3f73be762455/agent-skills/skills/links/SKILL.md).

### Hive adds a second observer today

Hive's PR-label sweep also runs every **60 seconds**. It discovers session links, searches known repositories for PRs with the `hive` label, and separately reads state/check/review fields for every known PR record. Its discovery map deduplicates URLs, but the state loop does not exclude merged/closed historical records. Search has no open-state restriction and allows up to 1,000 results per repository. Negative caching backs off failures; successful unchanged historical reads are still repeated.

Consequently, cost depends on **historical tracked PRs**, not just concurrent open PRs. This is a more immediate scaling issue than extending one short deployment wait. Hive's retained state is not a post-merge Actions/deployment observer, and the current waiting projection does not implement a CI completion subscription.

Sources: [sweep cadence](https://github.com/psjamesh/agent-wrangler-hive/blob/c56973b4e11c3f443625e68074b216fefe1a87c3/server/manifest.js), [discovery and state loop](https://github.com/psjamesh/agent-wrangler-hive/blob/c56973b4e11c3f443625e68074b216fefe1a87c3/server/pr-label-discovery.js), [tracker queries/backoff](https://github.com/psjamesh/agent-wrangler-hive/blob/c56973b4e11c3f443625e68074b216fefe1a87c3/server/pr-tracking.js), [waiting projection](https://github.com/psjamesh/agent-wrangler-hive/blob/c56973b4e11c3f443625e68074b216fefe1a87c3/server/waiting.js).

## API cost at 20 concurrent PRs

Measured with `gh` 2.104.0: core's PR-view command made one GraphQL HTTP request for the sampled PR. Replaying its exact query with `rateLimit { cost }` returned **1 primary GraphQL point**. Hive's PR-view query and the unresolved-thread query also each returned cost **1**. This is a small-PR measurement, not a promise for arbitrarily large/paginated queries.

The exact Hive search command made a GraphQL repository-resolution request plus a REST search request, even with no matching results. Search pages and repository resolution must therefore be budgeted separately. Authentication reported **5,000 GraphQL points/hour**, **5,000 REST core requests/hour**, and a separate REST search limit of **30 requests/minute**. The same user's other Wrangler instances, agents and tools share the relevant credential/user budgets; a new process does not create a new allowance.

The following are steady-state estimates for 20 unique open links held for a full hour, one observation/minute, small responses and no errors. Attach refreshes, label writes, merge mutations, retries and pagination are additional.

| Strategy | Estimated hourly cost | Implication |
| --- | --- | --- |
| Core's existing two queries | **2,400 GraphQL points** | 48% of the observed 5,000-point allowance. Per link: 120 points/hour. Duplicate owner links multiply it. |
| Core plus current Hive state reads | **3,600 GraphQL points + about 60R**, plus REST search pages | `R` is known repositories searched. At R=5: approximately **3,900 GraphQL points/hour**, or 78%, plus at least 300 REST search requests/hour. Repository-resolution cost assumes one small GraphQL query per search. |
| Another independent copy of core's two-query watcher | **+2,400 GraphQL points** | With the preceding R=5 example: about **6,300/hour**, exceeding the measured primary allowance. |
| One REST run lookup per watched post-merge change/minute | **1,200 REST core requests** | A run+jobs pair is 2,400/hour. These use the REST budget, not GraphQL's allowance. Twenty-minute or three-hour waits keep paying while pending. |
| Deployment lookup plus one status lookup per change/minute | **2,400 REST core requests** | More deployments, environments or pages increase cost; absence of a deployment is not success. |
| Shared repository Actions listing, R=5, once/minute | **300 REST core requests**, plus details on changes | Cheaper when many PRs share a repository. Requires pagination, exact SHA/workflow filtering and a separate completion contract. |
| One selected run every five minutes for 20 waits | **240 REST core requests** | Up to five-minute detection latency; useful after an initial short interval. Run+jobs doubles this. |
| Webhook ingestion | **No periodic GitHub read per idle wait** | Coalesced verification and recovery reads still cost requests; events can be numerous and require infrastructure. |

For a three-hour run, one lookup/minute costs about 180 requests; two lookups/minute cost 360. A five-minute interval reduces those to about 36 and 72. Duration matters through accumulated requests and how long observations remain concurrent, not because a pending request is intrinsically expensive. Most sampled Hive checks finish within one interval; the hourly table deliberately models sustained concurrency, not every PR's lifetime cost.

GitHub also documents secondary limits including 100 concurrent requests, 900 REST points/minute and 2,000 GraphQL points/minute, plus CPU limits. Read-only GraphQL queries cost one *secondary* point independently of their primary query cost. The current sequential core sweep at 40 requests/minute for 20 links is well below those headline secondary thresholds; primary GraphQL headroom is the nearer concern. A slow sweep skips overlapping ticks, so its effective cadence can be worse than 60 seconds. At five repositories, ten search pages each minute would be 50 REST search requests/minute, above the separately observed search limit. Historical Hive records make even a 20-open-PR estimate optimistic.

Use shared URL/SHA caches, stop routine terminal-record reads, restrict discovery, coalesce queries, bound concurrency, jitter/back off and honor `Retry-After`/rate-limit headers before increasing coverage. Authenticated REST conditional GETs returning 304 can avoid primary charges where supported; they still make network requests and do not solve GraphQL polling or secondary limits. See [GraphQL limits](https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api), [REST limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api), and [GitHub API best practices](https://docs.github.com/en/rest/guides/best-practices-for-using-the-rest-api).

## Options

| Option | Advantages | Limits and suitable use |
| --- | --- | --- |
| Merge is final by default | Clear boundary, bounded ownership, no new deployment traffic; respects existing release ownership. | Cannot claim a production outcome. Requires an explicit operational handoff and preserves any task-specific install/deploy acceptance. Recommended default. |
| Existing Wrangler notifications only | Reuses existing reads; already wakes eligible sessions for useful pre-merge changes. | Stops at merge, depends on link scope/settings and transient notification baselines; cannot on its own reliably resolve a durable CI wait. Use as transport/input, not the entire wait mechanism. |
| Per-repository opt-in verification | Can name the correct workflow, environment, artifact and health signal; costs can be capped. | Configuration and maintenance required; releases may batch many commits or cross repository boundaries. Recommended extension when deployment is part of acceptance. |
| GitHub deployment/status events | Deployment status carries an environment/outcome; commit statuses and checks can represent external CI. Useful where pipelines publish them consistently. | A commit `status` is not a deployment; check completion is not application health. Coverage is producer-dependent and publication can precede readiness. Combine with an explicit repository contract. |
| GitHub App/webhooks into one Wrangler observer | No per-PR idle polling; can fan out observations to multiple beads and handle long waits cheaply. | Requires app installation, permissions, authenticated payload verification, reachable receiver/relay, durable delivery deduplication and reconciliation after downtime. A transport investment, not a prerequisite for fixing waits. |
| Bounded shared polling plus external handoff | Works without webhook infrastructure; repository-level batching and increasing intervals reduce cost. | Some latency and recovery reads remain. On deadline or unsupported pipelines, hand off explicitly rather than wait indefinitely. Practical initial implementation. |

For an event-driven observer, relevant GitHub events are `pull_request` (merge/close/synchronize), `check_run`/`check_suite`, `status`, `workflow_run`, and `deployment`/`deployment_status`. Subscribe only to what the configured contract needs. Many per-job events can arrive for one change: coalesce them, then verify the authoritative state once before a consequential action. Reconcile persisted waits after restart or missed delivery. See [GitHub webhook event definitions](https://docs.github.com/en/webhooks/webhook-events-and-payloads).

## What “waiting on CI” should mean

Today a free-text `waiting_for` can suppress idle/dormant-worker attention. It does not register a GitHub subscription. Hive has generic stale-wait attention (24 hours by default) and time-based overdue detection where the text names a recognizable time, but neither establishes which CI result ends the wait. The current idle-worker path skips any bead with `waitingFor`. See [watchdog](https://github.com/psjamesh/agent-wrangler-hive/blob/c56973b4e11c3f443625e68074b216fefe1a87c3/server/watchdog.js).

Proposed semantics:

1. A wait names its **purpose**, bead and responsible worker, PR URL and expected head SHA, selected check/workflow/run (including attempt when known), desired outcome and a deadline/review time. A post-merge wait instead pins the resulting merge commit or a documented release/artifact ancestry relationship, plus target environment. PR head SHA alone is insufficient after squash/rebase merge.
2. Register and persist the wait before yielding. Read current state at registration so an already-finished check is not missed. Distinguish `checks completed`, `PR mergeable`, `PR merged`, and `deployment healthy`; review approval is a separate wait.
3. A shared observer updates the wait on authoritative observations, regardless of whether a pane notice was enabled, deduplicated or delivered. Persist a pending wake/action until the worker acknowledges it, and reconcile it after restart. This is proposed infrastructure; the current toast path does not provide that guarantee.
4. End the CI wait on its selected terminal outcome: success continues the authorized workflow; failure resumes investigation; cancellation, timeout, action-required or a superseded run triggers reconciliation. An early failing check may end a readiness wait before all jobs finish. A head change invalidates the old target and registers a new one only if the worker still owns that continuation. Same-head reruns are tracked by run/attempt, not merely aggregate PR status.
5. Merge/close resolves or cancels an outstanding pre-merge wait. At the default boundary, record the verified merge and finish the bead when its other acceptance is satisfied. An opted-in delivery wait transitions to the explicitly selected post-merge target; it does not keep following arbitrary branch activity.
6. Missing permissions, an unavailable observer, no qualifying run/deployment, lost ownership or an expired deadline become visible **verification unavailable/overdue** outcomes with a named recipient. They never imply success. A valid structured wait can suppress idle alarms until its review time; bare prose must not hide a worker indefinitely. Track observation freshness and the original deadline separately from routine bead updates.

For long scheduled releases, use an external/release verification bead with its own owner and structured resume condition. Let the implementation worker yield without an agent sleep loop. Notification observation authorizes a wake and verification; it does not itself authorize merge, deployment, rollback or a new fix outside the task's authority.

## Suggested delivery sequence

1. Confirm the default boundary with the human: merge unless acceptance requires further delivery. Record that boundary in each bead's acceptance; deployment-required work stays open until verified or explicitly handed off with the remaining obligation visible.
2. Implement structured pre-merge waits and reliable completion/wake reconciliation using shared Wrangler observations. Fix terminal-record polling and duplicate reads at the same time, and expose freshness/error/deadline attention.
3. Add a small opt-in verification contract: workflow/environment selector, commit/artifact mapping, terminal success predicate, maximum wait, recipient and handoff. Start with bounded shared REST polling; do not guess a repository's deployment from workflow names.
4. Consider webhook ingestion when the measured active-wait count, latency need or shared API budget justifies it. Preserve bounded reconciliation polling for gaps.

The immediate product defect is an unowned continuation disguised as a wait. Fixing that does not require Hive to become a universal release monitor.
