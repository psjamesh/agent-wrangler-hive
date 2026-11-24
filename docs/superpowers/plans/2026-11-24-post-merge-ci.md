# Post-merge CI implementation plan

**Goal:** Watch base-branch CI for an expected PR head through merge, chained runs, cancellation and verified superseding.

**Architecture:** Hive owns read-only GitHub polling through its existing bounded `runGh` adapter. A separate post-merge observer persists merge identity, selected runs/suites and quiet-period state in the existing durable CI wait; existing PR targets retain core observations.

**Spec:** The approved cell brief: all merge-SHA runs/suites, optional workflow name, 150-second quiet period, 600-second no-runs window, cancellation without success, ancestry-verified successors, durable wake and watchdog attention.

**Constraints:** No core change, browser, version bump or private content. Use the repository test entrypoint; exact-head Hive review and required protected CI precede builder merge.

## Implementation

- [x] Add failing tests for passed, failed with URLs, no-runs, cancelled, chained runs and verified superseding (including unrelated successors, retries and narrow selection).
- [x] Implement `server/post-merge-ci.js`: REST reads, pagination, identity validation, persisted observations, 60-second poll pacing and pure outcome evaluation.
- [x] Integrate target `post-merge` and optional `workflow_name` in `server/ci-waits.js` and `server/tools.js`, including runtime fencing, watchdog freshness, restart and existing wake/acknowledgement behavior. Test registration before/after merge and lifetime/ownership changes.
- [x] Update CI wait docs, host contract and worker registration guidance; run the full permitted test command.
- [ ] Publish, obtain exact-head Hive review outside the builder worktree, verify protections/checks and merge. Record configured core auto-update delegation with queen ownership.

## Review focus

Incomplete API pages or failed reads cannot establish success. New runs and reruns restart quiet time. An unrelated newer branch run cannot supersede a cancellation. Late responses cannot mutate replaced waits or retired runtimes. Persisted waits resume after restart without repeating confirmed wakes.
