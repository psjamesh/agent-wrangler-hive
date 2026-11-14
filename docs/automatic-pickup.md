# Automatic work pickup

Every enabled, fully set-up hive automatically starts work marked ready when there is global work capacity. **Maximum active workers** controls concurrency across hives (default 8, 0 means Unlimited). One work bead occupies one slot, including its reviews. Each helper enrolled through the before-spawn hook occupies an additional slot in the same global budget, from its pending admission through its live binding. Known exited or archived claimants, launch sessions, reviewers and helpers release their capacity; dormant live sessions still count. An exited session keeps its binding so it can resume. Releasing capacity does not clear a bead claim, launch reservation or unsettled-write fence. The rolling start guard permits one automatic start per hive and two across all hives in 60 seconds. It remains active with Unlimited capacity. Explicit worker, review and queen-handoff launches retain their existing capacity behavior and do not consume these automatic-start debits.

The queen keeps responsibility for decomposition, priorities, dependencies, sufficiently clear briefs, readiness judgments, reviews, recovery, acceptance and integration. Pickup never closes work, launches a review, replaces a worker or merges code.

## Mark work ready

The current queen calls `hive_set_pickup`:

```json
{
  "bead_id": "hive-example",
  "ready": true,
  "profile": {
    "agent": "claude",
    "model": "sonnet",
    "effort": "medium",
    "cwd": "/path/to/repository",
    "worktree": { "auto": true },
    "intent": "Build the bounded deliverable described by this bead."
  }
}
```

The human can also mark or remove readiness in bead details. Ordinary workers and coordinators ask the queen to change readiness. Marking work requires a goal and acceptance criteria, and a validated explicit provider/model/effort/folder profile. A provider without effort controls uses an empty effort. The optional worktree specification uses the same fields as `hive_spawn_worker`. Omitting it explicitly selects a shared working folder. Terra providers, requested models and resolved model identities are refused for pickup and explicit worker launches. Explicit worker and review launches allow unresolved models or unavailable catalogs, refusing Terra when the requested or a known resolved identity identifies it. Pickup requires a resolved identity, which is saved and checked before dispatch. Catalog outages and missing provider/model information hold an existing mark without consuming it; Hive retries validation on later passes, tries other eligible beads in the same hive, and notifies the queen at most once per readiness token and cause. Rearming resets these notice receipts. A changed resolved identity requires reconciliation and rearming; no substitute is selected. Working folders are limited to 2,000 characters at mark time and launch time.

The marking response includes the current `pickup.state`, `eligible`, all `reasons` and any `blocking_session_ids`, including on an idempotent repeat. A mark authorizes one launch attempt. Repeating an unused, unchanged mark is idempotent. Direct claims and manual worker launches also consume an active mark. Returning work to pickup requires `rearm: true`, the mark's `expected_token`, a reason and reconciliation of any old claim/session/launch. Removing readiness cancels a pending start before it claims work; it does not stop a worker already running.

Eligibility is stricter than a planning queue: work must be open, unassigned, below this hive's goal, without open descendants, reviews, write fences, explicit waits or missing/unresolved blocking prerequisites. The task and current queen must be available; an idle or dormant queen is fine. A queen transition suspends pickup. Live untracked descendants also suspend pickup across the cell; the hold names their session ids. Dormant, archived, exited and other sessions without live terminals remain visible in `attention.untracked_descendants` without imposing this hold. Armed work may wait for a dependency or capacity; details and `hive_ready.pickup` explain why. `hive_ready.ready` preserves manual planning candidates, including decision items, recorded/native waits and unsettled writes or reservations when they otherwise meet its open/unassigned/leaf criteria. Missing blocking prerequisites conservatively exclude candidates. Each entry's `pickup` field and the separate `hive_ready.pickup` list explain the stricter automatic eligibility, so a planning candidate is never an automatic launch authorization.

A continuous reconciliation hold observed for five minutes raises `pickup_held` in the queen’s watchdog digest, with every reason and the live untracked sessions to reconcile. The per-hive `pickupHeldMinutes` setting controls this threshold. Cell-state, live untracked descendant, profile, receipt, version, brief and hierarchy problems qualify; ordinary prerequisite, recorded wait, open descendant/review, capacity and rate holds do not wake the queen. The flag clears when reconciliation holds resolve, on launch or on disarming. One arm token receives one notification per continuous reconciliation episode, even when reasons or blocking sessions change.

## Durable authorization and recovery

Readiness is a journaled Beads field. A native-version receipt confirms the arming write. Unexpected external edits, including claim/release or close/reopen between sweeps, hold readiness. Recognized Hive summary and evidence edits advance a matching receipt. Changes to the executable brief, kind, parent/hive or profile require a fresh mark.

Worker reservation, token consumption, rate debit and fairness cursor are saved together before host spawn. The shared worker startup path rechecks authorization and claims/binds work before the first agent action. One coalescing runtime dispatcher visits hives round-robin; priority, arming time and bead id order work within a hive. Own writes request a pass, with the regular sweep covering missed events. Rendering never launches work.

A failed or unknown start is never retried automatically. Its durable token tombstone survives operation-history pruning and process restart. Unknown outcomes reserve capacity until reconciled with `hive_reconcile_worker_launch` or their known session exits or is archived. Their bead remains fenced against a duplicate launch until reconciled. Details show **Starting worker**, **Pickup needs attention** or the consumed state with the launch id and reason. A failed attempt is reported to the current queen once; an uncertain notification is not resent. Replacement runtimes observe existing attempts rather than replaying spawn.

## Design interpretation

The readiness mark itself carries the queen's launch profile. There is no human profile-configuration prerequisite or per-hive pickup switch. No additional per-hive concurrency limit, launch allowance, spend pause or usage permission applies. The start-rate guards prevent bursts; they are not spending limits. An optional per-hive default profile is not required: each mark supplies its profile explicitly.
