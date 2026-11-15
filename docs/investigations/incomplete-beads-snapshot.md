# Incomplete or out-of-date Beads snapshots

## Finding

The refusal can be normal concurrency protection, even when the last export
succeeded. It is not evidence by itself of a damaged store or failed refresh.
The guard is global to the runtime, so a hierarchy change in one cell can
temporarily refuse a worker update or reviewer launch in another.

[`requireCompleteHierarchy`](../../server/access.js) refuses when
`current.error` is truthy **or** `hierarchyCurrent === false`.
[`ensureWritable`](../../server/ops.js) calls it before mutations, including
ordinary summary/evidence updates. [`requestReview`](../../server/reviews.js)
also calls `ensureWritable` before its explicit refresh, then checks bead
access again after that refresh. An attempted launch therefore need not reach
the refresh that its caller expects to repair a stale snapshot.

## What makes a successful snapshot stale

[`hierarchyWrite`](../../server/beads.js) wraps create, delete and updates
containing `parentId`, `kind` or `issueType`, including redundant values. It
increments the hierarchy generation and outstanding-write count **before**
the operation runs or waits in the shared adapter queue. Its `finally` block
decrements the count, increments the generation again and notifies listeners,
including on failure. Summary, status, claim and evidence writes alone do not
use this wrapper, but their queued work can delay a hierarchy write or export.

[`createSnapshotCache`](../../server/snapshots.js) captures the generation
before awaiting `loadSnapshot`, which queues a read-only export behind other
adapter operations. A snapshot is current only with a ready backend, a loaded
error-free snapshot, no outstanding hierarchy writes, and an unchanged
generation since that read started. A read that overlaps a hierarchy write
can publish a fresh `loadedAt` and `error: null` while remaining unusable for
admission. Context's snapshot timestamp and error field do not expose this
generation mismatch.

Every hierarchy settlement immediately requests a refresh. If one is already
running, `again` requests a follow-up iteration on the same refresh promise.
The final settlement's follow-up read restores currency once it completes
without another hierarchy change. An ordinary refresh does not invalidate a
previously current snapshot. There is no busy-worker/load threshold gating
refreshes and no missing settlement callback in this traced path.

## Evidence and duration

Investigation on 15 November 2026 used main `0ff1e888` and compared these files
with the revisions installed before the reported approximately 20:55 and 21:30
UTC incidents (`0663e685` and `f85fb8f5`); the guard, adapter and cache files
have no differences across those revisions. The core log has no snapshot,
store-read or refresh failure in those incident windows. Successful refreshes,
generation changes and these access refusals are not logged by this path, so
the historical duration and exact overlapping operation cannot be recovered
from that log. The concurrency explanation fits the symptoms; it does not
establish which operation caused either incident.

An isolated replay using the actual cache with a controlled adapter produced:
current initially; stale with `error: null` when a hierarchy write starts;
still stale after an overlapping export publishes, with one follow-up pending;
current after that follow-up completes. Starting an ordinary refresh then
leaves currency true. No live writes or restart were needed.

Three consecutive live bead-context calls, each awaiting a refresh, took
1,791, 2,389 and 1,380 ms end to end. These include transport and tool overhead;
they suggest seconds for a quiet refresh, not a measured distribution of
refusal durations under load. A separate direct read-only export timing
attempt was denied by the local sandbox because the database needs lock-file
access; it supplied no timing evidence and was not retried with extra access.

The expected refusal interval is the remaining queued hierarchy work plus a
successful export started after its final settlement. Concurrent hierarchy
changes can extend it repeatedly. Command timeouts (20 seconds per read,
30 seconds per write) exclude queue wait and do not bound this interval;
guarded jobs can contain multiple commands. The queue cap is 64 pending jobs.
There is no fixed retry-after duration. The 60-second sweep is a fallback,
not the normal settlement refresh delay. The 30-second `maybeRefresh` cooldown
applies to actual snapshot errors, not generation-only staleness.

## Recommendation

Keep the fail-closed hierarchy guard. Treat the observed stale-generation
window as expected protection with misleading feedback, rather than remove
it or infer corruption from a healthy error field. As immediate guidance,
after this explicit pre-write refusal, allow a short backoff and call context
before retrying. Do not replay an uncertain write or launch on that basis.

A follow-up implementation should distinguish `hierarchy-writing`,
`refresh-needed` and actual export errors; expose outstanding writes,
generation/read age and refresh duration. For safe pre-mutation admission,
await a coalesced refresh and retry the guard with a bounded backoff (for
example 250 ms, 500 ms and 1 second, with an overall deadline), then return a
specific transient-busy message if still stale. Revalidate access after the
await, and never retry an operation after side effects or an uncertain result.
This would absorb short normal windows without hiding sustained queue delay
or weakening ownership checks. This note makes no runtime change.
