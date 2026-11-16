# Create responses delayed across host sleep

## Finding

The two reported silent `hive_create_beads` calls on 16 November 2026 line up
with host suspension, to the second. The evidence does not establish minutes
of active Beads/Dolt execution or database contention. Separately, the incident
revision has a post-write snapshot wait with no overall deadline. A stuck or
continually coalesced refresh can withhold already-confirmed IDs even while
the host is awake.

## Incident evidence

Read-only inspection of the caller's JSONL transcript, the core server log
and the host's `pmset -g log` produced this timeline. All times are UTC on
16 November 2026; power events have whole-second precision.

| Event | First call | Second call |
| --- | --- | --- |
| Create tool invocation | 01:15:20.423 | 02:20:43.111 |
| Host enters sleep | 01:15:20 | 02:20:43 |
| Host dark wake | 01:25:49 | 02:36:36 |
| Sleep duration in power log | 629 s | 953 s |
| Client abort, no response/progress | 01:25:49.479 | 02:36:36.389 |
| Silence reported by client | 628 s | 952 s |

The first sleep is labelled `Maintenance Sleep`; the second is
`Sleep Service Back to Sleep`. The server's snapshot timeout at
01:25:49.689 occurs immediately after the first wake. Another hierarchy-busy
worker-startup refusal at 01:42:39.582 and snapshot timeout at 01:42:39.713
coincide with a dark wake following sleep from 01:26:02, lasting 997 seconds.
These are elapsed wall-clock intervals during which neither a JavaScript
deadline nor a subprocess can make normal progress.

Both created beads were found after the client aborted. The retained logs
do not timestamp the create command's commit, its callback, queue admission,
or each export. They therefore cannot establish whether each write committed
before sleep or completed after wake, or the exact await active at sleep.
"The write landed but the response was lost" does not prove that all the
silent time was spent after commit.

The caller's historical transcript also contains a read-only export at
01:43:28 taking 0.661 seconds, and a later create at 02:37:02.084 returning
its IDs at 02:37:05.656. These observations demonstrate recovery between
sleep intervals, not a latency distribution. This investigation runs no
`bd` command against the live store and makes no power-setting changes.

## Response path and independent unbounded wait

[`hiveTool`](../../server/tools.js) awaits
[`createBeads`](../../server/ops.js), with no outer handler deadline. The
create operation passes pre-write admission, prepares an atomic graph plan,
and calls the adapter through the operation journal.

[`createMany`](../../server/beads.js) increments the hierarchy generation
and outstanding hierarchy-write count before its queued work. It writes a
scratch plan and awaits `bd create --graph ... --json`, then parses the
returned IDs. Its `finally` settles the hierarchy generation and notifies
the snapshot cache, which starts or queues a refresh.

At incident revision `89232d58`, create sets `phase.applied` once the adapter
returns IDs, then awaits `rt.snapshots.refresh()` inside the journal callback.
Only after that await does the journal save `state: applied` with those IDs
and the tool construct its response. The operation can thus remain recorded
as pending even though Hive has already received a confirmed native result.

[`createSnapshotCache`](../../server/snapshots.js) returns the same `running`
promise to every overlapping `refresh()` caller. Each such call sets `again`;
the promise resolves only after the refresh loop drains. Context calls,
hierarchy settlements and other refresh callers can request further passes
while an export is running. A finite stream extends the wait; a continuous
stream can keep it open indefinitely. It is not a promise for just one
post-create read. Neither this loop nor queue wait has an overall deadline.

## What the existing bounds cover

| Bound | Coverage and limit |
| --- | --- |
| Hierarchy admission | `waitForHierarchy` uses an overall 10 s deadline before effects. It cannot bound a later create or post-write refresh. |
| Adapter command timeout | 20 s per read, 30 s per write, 120 s for init. These start when the subprocess launches, excluding queue wait. A guarded adapter job can run several commands. |
| Adapter queue | At most 64 pending jobs; a count limit is not an elapsed-time bound. |
| Process termination | `execFile` sends `SIGTERM`; there is no escalation. Its callback depends on process termination/stream closure. A non-exiting child can hold the queue. This failure mode is not established for these incidents. |
| Host suspension | Neither subprocess nor JavaScript deadlines can provide a response while the machine is asleep. Timer callbacks may be delivered after wake, when the client's idle deadline has also expired. |

The adapter serializes its own subprocesses. Another client could contend
for the embedded Dolt store, but there is no retained process/lock trace to
establish that here. The snapshot timeout text alone is insufficient: it is
also consistent with deadlines firing on wake. No database repair or live
store stress test is justified by this evidence.

## Bounded response after confirmed creation

Create records its confirmed IDs and `applied` journal receipt before waiting
for the snapshot. It allows up to 10 seconds for the shared refresh. If that
wait expires, fails, or leaves an incomplete/stale snapshot, the tool returns
the normal `op_id`, `ids` and `cross_cell` fields with a `note` explaining
that the beads were created, the snapshot is still settling in the background,
and the create call must not be repeated.

The refresh continues through the existing cache. Nothing retries creation,
cancels a database write, declares a stale graph safe, or bypasses admission.
Subsequent work still requires a complete current hierarchy. A quick refresh
preserves the ordinary response without a note. An uncertain native create
retains the uncertain-operation path and does not return invented IDs.

This bounds only the optional wait after a confirmed native result while
the event loop can run. It does not impose a transaction deadline or promise
a response during host suspension. Ensuring unattended service availability
across clamshell/maintenance sleep belongs to the host/core operating policy;
changing that policy requires separate work. Queue deadlines and subprocess
termination escalation also need a separate design that preserves single-store
serialization and uncertain-write recovery.

## Regression fixture and validation

[`create-settlement.test.mjs`](../../test/create-settlement.test.mjs) exercises
the actual MCP handler, operation journal and snapshot cache with an isolated
in-memory adapter. Controlled read gates reproduce a confirmed write followed
by a stuck export and a coalesced follow-up export. Mock timers advance the
response budget without database access or real sleep. The tests verify returned
IDs, an applied receipt before settlement, the settling note, continued hierarchy
protection, eventual refresh, ordinary success and uncertain-native-write handling.

Against the incident code, the deadline test fails because no response arrives,
and the early-receipt test finds `pending` rather than `applied`. This is an
awake-host reproduction of the independent post-write bug, not a reproduction
of the host's power transition. The documented repository test entrypoint runs
the regression as part of `npm test`; no local browser is involved.
