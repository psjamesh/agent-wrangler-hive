# CI and PR waits

A wait belongs to a bead's claimant and pins one PR head. A canonical GitHub PR URL can be enrolled immediately when it appears as a PR link on the claimant's session or as `kind: "pr"` evidence on that bead. The exact URL declares the expected repository and PR, including a first PR in a new repository; links from other sessions or evidence on other beads do not authorize enrollment. Existing PR identity records are preserved.

Keep the PR linked to a session or task so core observes it, including when enrollment uses bead evidence. Linking an evidence-enrolled PR also enables normal Hive labeling without discarding its bead associations. The declared repository enters the existing open-only Hive-label search, bounded to 100 results and at most one successful search per repository per five-minute cooldown (failures back off).

Register it through `hive_report_pr_wait` before yielding:

```json
{
  "bead_id": "hive-example",
  "state": "wait",
  "url": "https://github.com/example/repo/pull/7",
  "head_sha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "target": "checks",
  "desired_outcome": "success",
  "reason": "Continue the authorized PR work after tests",
  "deadline": "2099-01-01T12:00:00Z"
}
```

The PR must be associated with the bead in Hive's PR ledger and linked to a session or task for core observation. The claimant, queen or coordinator can register a wait; it always names the bead's current claimant as its responsible worker. There is one current wait per bead. Identical registration does not extend its deadline. Cancel a pending wait and acknowledge its outcome before replacing it.

| Target | Meaning |
| --- | --- |
| `checks` | All checks already reported in the rollup. An empty rollup cannot succeed. This does not enumerate missing required checks. |
| `check` | The unique exact `check_name`, matched against CheckRun name or StatusContext context. A missing check stays pending until its deadline; ambiguous names need reconciliation. |
| `mergeable` | Core reports `checkStatus: passing` and the PR is not a draft. Review and merge requirements remain distinct from all checks succeeding. |
| `merge` | Core observed this PR and expected head as merged. This is the default code delivery boundary; installation/deployment still requires explicit acceptance and verification. |

`desired_outcome: success` returns early on a reported failure, cancellation or action requirement. For check targets, `completed` waits until all selected checks have a recognized terminal outcome, then reports that outcome. Run, attempt and workflow identities are unsupported and refused. A same-head rerun must be registered using an observed pending check state or reconciled explicitly: a cached successful rollup cannot identify a specific rerun. No workflow dispatch or GitHub polling is added by a wait.

The snapshot is read after persistence. Core's `pr:observation` events and the existing minute watchdog reconcile waits, including after restart, without relying on core pane notifications or Auto-fix settings. Changes to the expected head or PR node identity resolve as `superseded`; they never register a new continuation automatically. Closing an unmerged PR cancels its wait. An expected-head merge satisfies `merge` and `mergeable` targets. Check targets judge the retained rollup: a merge alone cannot prove that a selected check passed. If the merged snapshot cannot establish its outcome, the wait resolves as `reconciliation-required` and flags the queen. Outcomes also include `success`, `failure`, `cancelled`, `action-required` and `overdue`.

Open observations older than three minutes, fetch errors, missing observations and ambiguous selected checks raise `ci_wait_unavailable`. Empty rollups and checks that have not attached yet remain pending until their deadline. The three-minute freshness bound is conservative: long core poll intervals and restart timestamps can temporarily raise unavailable attention between observations; core change events still reconcile fresh terminal results immediately. Retained merged observations are immutable merge evidence and remain usable after link removal. A deadline ends an unfinished wait as `overdue`, even if the observer is unavailable. Valid terminal evidence takes precedence when a late sweep or restart reconciles a finished target; deadline expiry never overwrites that evidence. Routine bead edits do not change the stored deadline. Older hosts without `host.links.prObservation` retain the wait and raise unavailable attention; a missing observation never falls back to a GitHub call.

A resolved outcome is saved before wake delivery. The delivery attempt is saved as `sending` before contacting the host and bounded to 15 seconds. Confirmed live/dormant delivery is retained; failures, interrupted sends and uncertain delivery raise `ci_wait_delivery`. The queen checks the worker before using `state: retry-wake` with its exact `wait_id`. Retries are refused while this process still has that send in flight. A persisted `sending` receipt without an active send can be retried explicitly after restart reconciliation. Hive does not blindly retry a delivery that might have arrived. Delivered outcomes without acknowledgement raise `ci_wait_unacknowledged` after five minutes. Recover the record in `hive_context.focus.ci_wait` or the cell's `waits`; then acknowledge:

```json
{ "bead_id": "hive-example", "state": "acknowledge", "wait_id": "ciwait_returned_id" }
```

Worker errors, snoozing, disappearance or claim handoff raise queen attention while shared observation continues. A terminal result is retained, but Hive never wakes a former owner or unavailable session. Recovery of the same owner can deliver its pending outcome; after transfer, the queen inspects and acknowledges the prior outcome, then registers any new continuation under the current claimant. A builder releasing its claim for queen merge/install does not keep a worker continuation: the queen owns reconciliation of its retained merge result.

Use `state: cancel-wait` with the same ID to cancel a pending wait. Acknowledgement clears the wake obligation, not the bead or its acceptance. Completion notices authorize verification and continuation within the existing task, never merge, deployment or closure by themselves.

Pending, fresh structured waits suppress worker alarms only until their deadline. Plain `waiting_for` annotations grant the configured `waitGraceMinutes` (30 minutes by default) from their original anchor; unrelated bead edits do not renew it. Resolved or unavailable CI waits cannot hide an idle or stalled worker. Dependency and review/input waits keep their own rules.
