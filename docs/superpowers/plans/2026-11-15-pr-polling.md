# Reduce Hive PR polling

Goal: bound GitHub costs by active PRs rather than historical records, preserving attribution and state features. The approved bead brief authorizes implementing terminal-record and search fixes independently of a missing core observation API.

Approach: retain the 60-second active-state sweep; skip confirmed MERGED/CLOSED records. Search open labelled PRs only, at most 100 per repository every five minutes, with existing failure backoff. An open search hit can reactivate a terminal record after reopening. Require a successful observation after bead closure before closed_bead_pr attention. Core's derived link fields cannot substitute for Hive's raw checks/draft/merge fields; report the host API gap to the queen rather than import core internals.

- [x] Add regression tests for terminal transitions/restarts, reopened discovery, bounded searches/backoff, query counts and closure freshness; run them red.
- [x] Update server/pr-label-discovery.js, server/pr-tracking.js and server/watchdog.js; run focused tests green.
- [x] Run the required npm test command; record hourly costs and remaining API dependency.
- [ ] Commit without version bump, scan public diff, push, create and attach PR; request Hive adversarial review, fix findings and re-review up to two rounds.
- [ ] Record merge/install wait and report to queen without closing the bead.

Review focus: failed reads retain last state but cannot confirm open after closure; persisted terminal records stay quiet after restart; reopened PRs become observable; discovery failure retry cannot spin each minute; bounded search may miss PRs beyond the most recently updated 100.

Identity review correction: every state read includes node id and creation time. Re-observe legacy terminal records once before skipping; replace stale URL attribution on changed identity, use current session links to assign replacements, and use newer core open-link observations to recover unlabelled reopenings. Never synthesize OPEN from search results. Add URL-reuse/migration/error/reassociation regressions before implementing.

Queen decision hreq_22c764c5b8d6: one final persisted terminal label opportunity, then unlabelled on failure; reopening/new identity restores eligibility. Missing-label/permission failures pause the whole repo for 15 minutes across restarts and surface one watchdog attention episode until recovery. Unlinked identity replacements must not claim an unverified label. Queen authorized one additional retained review limited to these fixes.

Final review correction: labeler preflight backoff returns deferred, which preserves the pending terminal opportunity; repository attention requires pending label work. Queen instructed tests/full suite/push followed by her own diff check, with no further reviewer round.
