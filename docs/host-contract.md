# Host and Beads contract

This page lists exactly what Hive relies on from Agent Wrangler and from Beads. It is the checklist for an upgrade of either.

## Agent Wrangler host API

The manifest declares `engines.wranglerApi: ^1.71.0`. Hive needs the read-only `links:read` capability introduced in host API 1.70.0. Earlier hosts reject this build as incompatible. The session context and view also use the live `status` and `waitingReason` projections introduced in 1.59.0.

### Capabilities

| Capability | Used for |
| --- | --- |
| `tasks:read` | `host.tasks.get`, `forSession` and `adhocId`: cell titles, participation and adoption checks. |
| `tasks:write` | `host.tasks.create`: the task behind a new cell. Hive never renames, reassigns or archives tasks. |
| `sessions:read` | `host.sessions.get` and `forTask`: queen nomination checks, binding checks and the session list in `hive_context`. |
| `sessions:spawn` | `host.sessions.spawn`: launching a human-requested queen, or a queen/coordinator-requested tracked worker or reviewer. |
| `sessions:archive` | `host.sessions.archive(id, { cascade: false })`: only when the human ticks Archive these sessions too while retiring a hive. Each session is archived on its own and failures are reported without blocking the retirement. |
| `deliver` | `host.deliver`: human messages and activation briefs for the queen. |
| `board:rebuild` | `host.rebuild`: republishing the Hive projection after a change. |
| `links:read` | `host.links.get(sessionId)`: reading independent copies of session links, including PRs. Unknown sessions return `[]`. No `attach` method is granted. |

### Manifest surfaces

| Surface | Use |
| --- | --- |
| `stores.hive` | One `HiveRuntime` per activation: the metadata store, the bd adapter and the snapshot cache. |
| `graph` | Publishes a cached projection under the `hive` key. It never runs `bd`. |
| `tools` | The `hive_*` tools on AW's existing MCP server. |
| `handlers` | Human actions from the Hive view: setup, cells, queen, conversation, layout and reconciliation. |
| `skills`, `skillsFor` | `hive-queen` and `hive-worker`, offered only to sessions taking part in an enabled cell. |
| `hideTool` | Hides `hive_*` tools, and only those, from sessions outside every enabled cell. |
| `session.onArchive` | Release the archived session's unfinished claims through the guarded status-preserving release path. Recovery also scans archived claims. |
| `session.onBeforeDispatch` | Binds a UI-launched queen, or records a worker's minted session id before startup. |
| `hooks['session.launchContext']` | Claims and binds a reserved worker, and revalidates or reacquires its claim on every relaunch. Returns `refuse` if ownership or admission cannot be confirmed, before the agent starts. |
| `hooks['session.prepare']` | Notes a session that a participant is launching into the cell's own task, using the task the launch actually resolved to. |
| `sweeps` | Every 60 seconds: refreshes the snapshot and reconciles uncertain operations. A separate sweep labels eligible session PRs. |
| `settings.maxClaimedWork` | Maximum active workers: one global limit counting claimed beads, open reviews and launching workers, default 8; 0 means Unlimited. Read at each admission without restart; lowering it keeps current work. The view projects the same admission calculation, with shared slots counted once. |
| `settings.bdPath` | The human-owned absolute path to `bd`. |
| `activate` / `deactivate` | Attach the runtime to the host façade, and detach it. |
| `client`, `styles` | The `view` slot `overview` (label "Hive") on the rail. |

### Client API

- `api.send` and `onMessage`: control frames and their replies.
- `api.settings()`, `api.settings.set(key, value)` and `api.settings.onChange`: read, save and subscribe to Hive settings. The Hive Settings panel saves `maxClaimedWork` through this host path; the host validates its number definition, persists it and broadcasts the updated settings/board. The count opens that panel in overview and cell headers; the setup screen exposes it even when bd is unavailable. Saving bdPath rechecks the backend without a reload. The same panel saves requestNotifications (default on), labelled “Pop up when a Hive request needs you”. These rows are hidden from extension settings, and Hive registers no extension settings panel. No custom settings-write handler is used.
- `api.storage`: the selected cell, bead and link mode.
- `api.mountSession`: embeds AW's own session panel, with its native Chat and Terminal controls, in the cell view. Falls back to `api.openSession`.
- `api.claimDrag`: holds board re-rendering while a tile is being dragged.
- `api.agents`: agent, model and effort choices for launching a queen.
- `api.ui.markdownPreview`: sanitised Markdown for messages and bead text.

Hive uses no task-pane or task-body replacement API and no task-selection API. It needs no core change.

### Rules Hive relies on

- **Identity.** `caller` (an MCP tool) and `sessionId` (a hook) are AW's advisory local identities. Every tool handler checks the caller's participation in the cell, and the cell of every bead id it is given. Hiding a tool is only a convenience. This model is for one local machine; a remote Hive service would need authenticated identities.
- **Delegation lineage.** Tracked delegation uses `hive_spawn_worker` and `host.sessions.spawn`. The host does not let extensions set agent `spawnedBy`; Hive records `requestedBy` durably and passes `parentSession` for board nesting. A worker's binding gives it participation before its first action. Hive passes `disallowedTools: ['mcp__agent-wrangler__spawn_session', 'mcp__agent-wrangler__spawn_workflow', 'mcp__agent-wrangler__schedule_session', 'mcp__agent-wrangler__update_schedule']` for every Claude queen, worker and reviewer launch (`server/launch-policy.js`); the host persists it across fork and resume and rejects nonempty lists for Codex and Gemini, which therefore stay unrestricted. Sessions nominated rather than launched keep their existing options. Ordinary spawns by participants outside Hive are reported by `hive_context.attention.untracked_descendants` from `host.sessions.list()` and `spawnedBy`; they are never claimed automatically.
- **Queen handoff.** `hive_handoff_queen` reserves a launch record with the source queen and generation, then calls `host.sessions.spawn` without `parentSession`. `onBeforeDispatch` installs the successor only if the generation is unchanged; the `session.launchContext` hook refuses a superseded, abandoned or replaced queen before its first action.
- **Launch binding.** A UI launch stores a launch record first, then calls `host.sessions.spawn({ taskId, intent, ext: { hive: { launchId } } })`. `onBeforeDispatch` receives `{ launchId }` as Hive's narrowed `ext` slice and records the new session id as queen before the skill gate or the agent's first tool call. AW saves the session entry only after that hook, so a missing entry is not proof of failure:
  - while the launch is still running in this process, Hive refuses to settle it;
  - otherwise a session on the board settles it as launched, and anything else stays uncertain until a human abandons it after checking;
  - every change of queen bumps the cell's queen generation, and a launch nominates its session (in the hook or on completion) only while the generation it started from is still current, so it never replaces a later choice.
- **Runtime lifetime.** The runtime and its metadata store share one lifetime token. Detach retires it before stopping sweeps or clearing the host. Every metadata mutation checks the token before its callback and before saving; an attached token also requires the same host and current host store. Spawn, delivery, rebuild, queued Beads commands, attachment helper starts, snapshot callbacks and PR sweep continuations use the same boundary. A retired runtime cannot be attached again, even to the same host; activation constructs a fresh runtime/store. Already dispatched native or remote work may finish, but the retired runtime cannot save its late success or failure receipt over the replacement. The replacement retains pending journals/reservations and reconciles outcomes through the existing observation paths. Recovery passes and delayed write batches belong to their runtime. Region migration, layout and conversation writes use the guarded metadata store too.
- **Worker launch gate.** Hive reserves the bead and global capacity before invoking spawn. `onBeforeDispatch` saves the session id and first records it in an in-memory dispatch map, so a failed metadata save still leaves an identity for refusal. The host does not forward dispatch `ext` to `session.launchContext`; that hook finds the worker reservation by session id or its durable binding. Resume, message, snooze wake and other launches use the same gate; assign/adopt context changes do not start an agent. For builders it makes a journaled, guarded claim and strict binding; for reviewers it validates the durable review/launch identity and binds role reviewer to the work without taking its builder claim. Either path returns `refuse` if it cannot confirm startup. Hook exceptions are logged and ignored by AW, so Hive catches its own gate errors and returns the explicit refusal result. `session.prepare` has a fail-open timeout and is not used for asynchronous claiming. Pending and uncertain reservations are durable; an unconfirmed launch is never repeated. Locks covering both a bead and admission use the shared sorted order. Every launch/review admission preflight reads a strict `export --all`, rejecting malformed lines instead of trusting the tolerant display snapshot. After each read, Hive rechecks the current review, launch identity/state, requester authority and scope before mutation, and checks again before dispatch/binding. Error handling preserves cancelled/archived/abandoned or ended-review launches; a refusal before host dispatch retires its reservation without uncertainty. Capacity counts the union of claimed work, open review waits and launch/claim reservations. Reviews attach to their persisted work bead id and create no bead or dependency, including after the builder releases or is archived; standalone work labelled review uses its own id. Only the current bound reviewer gives a verdict, recorded as evidence on that work. Recovery requires a managed verdict operation naming the same review, work, reviewer and verdict, plus its protected receipt evidence. Definitely failed intents are cleared before evidence is considered. Ordinary evidence inputs refuse the managed `Review ` label prefix. A queen/coordinator explicitly cancels; archived reviewers leave requested waits for deliberate replacement. Review state and live reviewer activity project onto the work bead and invalidate the cached map when activity changes. Missing reservation targets still count until reconciled. Starting a claimed blocked/deferred item uses a queued export and native holder/status guards; starting unclaimed work is refused.
- **Queen brief.** The `intent` Hive passes to `host.sessions.spawn` is its queen brief: the queen's role, the cell's saved queen instructions (`queenInstructions` on the cell, set by `hive-cell-create`, `hive-cell-adopt`, `hive-queen-launch`, `hive-queen-nominate` or `hive-cell-instructions` with `instructions`) and, when a handler is given the older `intent` field, that text as a note for this launch only. The activation brief sent to a nominated session carries the same saved instructions, and `hive_context` returns them as `queen_instructions`.

  If the spawn throws after the hook has bound a session, the launch is marked uncertain. It is never launched again automatically.
- **Spawn grace.** Before core assigns a new session to its task, `session.prepare` reports the task the launch resolved to. Hive treats the session as a participant only if it was spawned by a participant into that cell's own task, for at most ten minutes, and never once the session is assigned to a different task.
- **Delivery results.** A result with `outcome: 'unknown'` is treated as uncertain even when its `mode` is `error`. Only an error with no unknown outcome counts as not delivered.
- **Running sessions.** Nominating a running session sends it a brief through `host.deliver` and does not restart it. AW bakes skills and tool lists in at launch, so that session may need a resume before it sees the Hive tools.

### Watchdog session signals

The watchdog reads `host.sessions.get(id).status`, `.waitingReason`, `.lastActivity`, `.createdAt`, `.relaunchedAt`, `.archived` and `.hasBackgroundShell`. An in-progress holder with `waitingReason: 'api-error'` or `'api-error-blocking'` raises `stalled_worker` on the next watchdog pass, unless it is working again, has a recorded wait, has an open review or input request, or has recorded completion. API-error reason changes and activity updates retain the same flag and original start time; a new episode can notify after a recovery pass clears the flag. Error text is not copied into attention or notifications. Exited and error statuses retain their existing attention behavior.

`watchdog_settings.idleMinutes` defaults to 30 minutes and accepts positive numbers up to 525600. It controls the idle-holder timeout separately from `workerMinutes`, which controls dormant claims and the activity projection. When `idleMinutes` is absent, a valid saved `workerMinutes` supplies the idle threshold, preserving existing cell settings; explicitly setting `idleMinutes` separates the two thresholds. The idle timer starts from the latest session activity, lifecycle timestamp or bead update; an approved review grants a fresh grace period. A recorded wait, open review, open request from the holder or terminal completion report in the bead summary, next action or latest evidence suppresses the idle flag. Completion reports suppress non-dormant idle/API-error stalls; they do not suppress `dormant_claim`, which still surfaces completed work held by a dormant session. A `hive_report_pr_wait` attention report alone does not suppress holder stalls: record a PR wait in `bead.waitingFor`. Reports must be recorded on the bead; private mail and terminal transcripts are not read. Replacing a completion report with ongoing-work text makes the holder eligible again.

The host session projection exposes no provider-neutral last-turn outcome. A provider failure that leaves a Codex or Claude holder plain `idle` with no API-error waiting reason is indistinguishable from a successful turn and uses the idle timeout. Immediate detection of that case requires core to expose a last-turn outcome (success or provider/API error) with a completion timestamp, cleared or superseded when a new turn starts. Hive uses the existing host fields and does not read provider transcripts, session files or live board data directly.

## GitHub label contract

`server/pr-label-discovery.js` enrolls PRs from `host.sessions.list()` and the read-only `host.links.get(sessionId)` API using Hive's existing `participation()` function. Only sessions participating in an enabled, non-snapshot cell can enroll a new PR. The sweep is a silent no-op unless the host reports API 1.70.0 or newer in the supported 1.x range and exposes the getter. Session PR URLs are deduplicated before enrollment.

Hive's metadata has an additive `prLabels` map, keyed by PR URL. A first-sight record contains `url`, `sessionId`, `cellIds`, `beadIds`, structured `associations`, `firstSeenAt`, `enrolledAt`, `status: pending`, `labelledAt: null`, `state: null` and `stateCheckedAt: null`. Each eligible cell contributes every active bead binding for that session; when it has none, its root contributes a distinguishable `kind: cell-root` association rather than `kind: binding`. The entire enrollment batch is saved atomically before any GitHub operation; a storage failure prevents unrecorded label work. This data is independent of AW links. The host removes merged or closed PR links in `~/vcs/agent-wrangler/server/index.js`, so a pending Hive record remains eligible after link removal, merge or close, session departure or cell disablement.

A successful label add or observation of an already-present label saves `status: labelled` and its confirmation time. Completed records are retained and never queried for labels or labelled again; their PR state is still refreshed. If GitHub succeeds but the completion save fails, the next attempt observes the existing label and saves completion without another add. Pending records survive process restart; the in-memory retry backoff resets on restart. Neither completed nor pending records are pruned by AW link cleanup.

`server/pr-labels.js` applies labels independently of link discovery, with a recorded-eligibility callback supplied by its caller. Another discovery mechanism can reuse it without a link capability. It accepts only canonical GitHub PR URLs and uses these argument-array commands:

- `gh pr view <url> --json labels` checks whether the label is already present.
- `gh pr edit <url> --add-label hive` adds the label without replacing existing labels or editing the body.
- If GitHub reports a missing label: `gh label create hive --repo <owner>/<repo> --description "Made with Hive" --color E0A82E`, then re-read labels and retry the add once while the record remains pending.

Existing label metadata is never overwritten. Concurrent creation reporting that the label already exists is safe to reuse. Creation is shared per repository and has a one-minute success cooldown. Each command has a 15-second timeout and a 2 MiB output limit. Errors produce no output. PR and repository negative caches use bounded in-memory backoff of 1, 2, 4, 8 and 15 minutes, with at most 1,000 entries each. Permission failures defer repository work. Authentication, missing-gh and rate-limit failures also back off all remote work.

Discovery sweeps do not overlap. Stopping the runtime prevents pending reads or label creation from causing later PR edits; an edit already dispatched cannot be recalled. Label attribution is independent of the host's model-tagging setting. The PR body is never read or submitted.

`server/pr-tracking.js` refreshes each recorded PR with `gh pr view <url> --json state,number,title,isDraft,headRefOid,reviewDecision,statusCheckRollup,mergeable,mergeStateStatus`, retaining the latest confirmed `OPEN`, `MERGED` or `CLOSED` value and its timestamp. Read failures preserve the last observation, persist `observationError` (message, attempt time and retry time), and suppress current readiness immediately. Backoff-suppressed reads retain that error; a successful observation clears it. Bounded backoff applies. Repository permission failures suppress other reads in that repository; authentication and rate-limit failures back off all tracker reads.

PR observations also retain the exact head, title, draft status, normalized check state and GitHub review/mergeability fields. Exact-head `ready` and `cannot-fix` reports are accepted only from the associated bead's claimant, queen or coordinator, behind complete-hierarchy and cell access checks; changing the observed head clears the report. Graph projection includes associated PR summaries, all outstanding conversation wait summaries and text-free topic/message-to-bead indexes for Needs You links beyond the conversation page window. It never reads Needs You stores. Waiting summaries and target indexes pass through `humanConversationDoc`, preserving native request privacy and selective forwarding. The browser also joins projected native `cell.requests` through the existing public `needsHuman` predicate, with exact topic/message navigation and no additional answer controls. The browser joins `graph.inbox` to Hive sessions/links; its 200-item boundary is disclosed as potentially incomplete. No Needs You write capability or new host grant is requested. PR readiness older than three minutes is stale. Hive offers GitHub navigation and queen help, with no merge write path.

The second read source is `gh search prs --repo <owner>/<repo> --label hive --limit 1000 --json url`, run only for repositories already represented in Hive's ledger. New labelled results are saved with `source: label-search`, a null session, empty cell/bead associations and confirmed label status. Search never infers identity from repository or branch names and never labels these unassigned discoveries. A later real AW session link can supply their session and bead associations without another label write. Existing known associations are preserved across search and state refreshes.

Both state polling and label search run with the roughly one-minute discovery sweep. Branch-name discovery and the PR UI are separate work. A link removed before any observation cannot enroll a PR; scoped label search can still discover it as unassigned if its repository is already known and it already has the label.

The `links:read` API is documented in [PortSwigger/agent-wrangler#468 (Add read-only session links capability)](https://github.com/PortSwigger/agent-wrangler/pull/468), merged as `1c6861a`. Deployment requires a host containing API 1.70.0.

## Beads (`bd`)

Hive supports bd **>=1.3.4 <1.4.0** with `bd schema` reporting `schema_version: 1`, on an embedded Dolt store (`metadata.json` with `backend: dolt` and `dolt_mode: embedded`). Anything else shows the setup screen, and every write is refused.

### Process rules

- All calls go through one queue, one subprocess at a time, as an `execFile` argument array with no shell, at most 64 queued.
- Reads time out after 20 s, writes after 30 s and `init` after 120 s, with a 64 MB output cap. Stdin is closed.
- The environment drops inherited `BEADS_*`, `BD_*`, `CLAUDE_SESSION_ID` and `XDG_CONFIG_HOME`, and sets `BEADS_DIR`, `HOME` and `XDG_CONFIG_HOME` under Hive's data folder, plus `DO_NOT_TRACK=1`, `BD_NON_INTERACTIVE=1`, `BD_LAST_TOUCHED_FALLBACK=0`, `BD_NO_DEP_TYPE_WARNING=1` and `NO_COLOR=1`.
- Immediately before each command, in the same queued job, Hive checks that the binary that job will run is the one the last probe accepted, and that the configured path and that binary's identity (real path, inode, size, modification time) still match. A probe drops readiness as it starts, so no command queued under an older check can run against a newer one. If they differ, the command is not run, readiness is dropped and Hive probes again. A binary that will not start, or a store that cannot be read, also drops readiness, which brings the setup screen back.
- Every read passes `--readonly`. Every write passes `--json --actor aw:<session id>`, or `--actor aw:human` for a human action.
- Outcomes:
  - Exit 0 is success.
  - Exit 13 is a failed guard, reported as a conflict, with nothing written.
  - Any other non-zero exit is a refusal.
  - A timeout or signal is **uncertain**, and is never retried.
  - A create that reports success without ids is uncertain too.

### Commands used

| Purpose | Command |
| --- | --- |
| Probe | `bd --version`, `bd schema`, `bd info --json` |
| Initialize | `bd init --non-interactive --skip-agents --skip-hooks --role maintainer --prefix hive --quiet`, run in `<AW_DATA_DIR>/hive/beads` without `BEADS_DIR`, and refused inside a git work tree |
| Snapshot | `bd export` (JSONL with dependencies) |
| Read one | `bd show <id> --json` |
| Create (atomic) | `bd create --graph <plan.json> --json`, with every node stamped `hive_op=<operation id>` and `hive_cell=<cell id>` |
| Reconcile a create | `bd list --all --flat --limit 0 --metadata-field hive_op=<id> --json` |
| Update | `bd update <id> --title/--description/--acceptance/--notes/--status/--type/--parent --set-metadata k=v` |
| Links (atomic) | `bd batch -f <file>` with `dep add <dependent> <prerequisite> <type>` and `dep remove` lines |
| Claim | `bd export --all` and capacity/ownership checks in one adapter queue job, then `bd update <id> --if-assignee '' --assignee aw:<sid> --status in_progress` |
| Release | One queued, journaled sequence: prepare blocked/deferred with `bd update --if-assignee <holder> --if-status <prior> --status open`; `bd unclaim <id> --if-assignee <holder>`; restore with `bd update --if-assignee '' --if-status open --status <target>` |
| Close | `bd close <id> --reason "<outcome>: <summary>"` |

Release intent records the holder, prior status and target status before writing. Each native step has a durable started/done receipt. Archive cleanup checks the current archive state and holder under the bead lock and rechecks the archive state inside the adapter queue before its first mutation. A replacement claim is guarded by the native release conditions; an unsettled release is fenced rather than replayed. A definite native guard refusal before any successful step records an ordinary conflict; a guard refusal after a successful step remains an uncertain partial release. Compound writes check every existing parent and link endpoint against the release fence. Incomplete releases remain visible for reconciliation and block further Hive writes affecting that item; recovery only observes the final status and empty assignee, and never repeats unclaim. Native unclaim performs lease and started-at cleanup and records its events. Restoring `in_progress` sets a fresh `started_at` through native update.

Hive does not use `bd update --claim`. It grants a lease that expires after a few minutes, and `bd reclaim` can then revert the claim, which would silently take long-running work away from its worker. Hive never runs `bd reclaim` and never forces an unclaim.

### Field mapping

| Hive | Beads |
| --- | --- |
| goal | `description` |
| acceptance | `acceptance_criteria` |
| summary (current understanding) | `notes` |
| kind | `hive_kind` metadata, plus `issue_type` `epic` for goals and workstreams |
| next action, waiting for, outcome | `hive_next_action`, `hive_waiting_for` and `hive_outcome` metadata |
| evidence | `hive_evidence` metadata (a JSON array) |
| hierarchy | `parent-child` dependencies |
| links | other dependency types; `blocks` (plus native `waits-for` and `conditional-blocks`) counts as blocking |
| claim | `assignee` `aw:<session id>` and status `in_progress` |

Hive writes metadata only with `--set-metadata key=value`, so keys other tools add are preserved.

## Native cell requests

Native requests use Hive's own schema-1 metadata `requests` map, added by default when older documents omit it. An invalid request map refuses the metadata load and is left untouched. Request/message/topic creation is one clone/write/rename transaction. Original requester identity is immutable. Admission uses the existing participation rule plus known, non-archived caller identity; it does not infer membership from ancestry or Beads assignees. Cell-wide creation does not require a working Beads backend. Optional bead context requires current validated hierarchy.

Content, route and mutation revisions fence stale actions; current queen nomination and generation are rechecked before queen mutations. Human handlers fix human attribution and use operation receipts for answer/dismiss replay. Answer and queen-notification attempts are stored before `host.deliver`, with separate receipts and guarded completion. Interrupted attempts become uncertain on restart; unresolved deliveries are never automatically repeated. A human can explicitly retry after checking receipt. Reads do not resolve requests. Disabled cells preserve request history and pause queen routing without exposing private requests; missing/archived queens route directly to human audience.

Admission allows 20 unresolved requests per requester and 1,000 overall, including answer-delivery repair. Text fields have fixed limits. The newest 500 settled request records remain; older references display unavailable rather than selecting another record. Unresolved request conversation messages survive ordinary message pruning. Own recovery is ownership-scoped after membership loss. Requester archive/missing resolves open requests with an explicit reason.

Notifications use existing client `api.ui.notify`/`withdraw`, view badges and the existing rebuild/deliver grants. Backlog is seeded without toasts; request-id/route episodes are persisted in tab storage. Phase 1 deduplication is single-tab; a multi-tab lease is deferred. Hive neither accesses the Needs You extension store/API nor registers its tool name. Its advisory tool-list veto hides standard creation only for participants and preserves legacy recovery.

Human projections and conversation history, paging and deep-link handlers filter queen-stage requests and their private topics. Queen answer-delivery failures stay with the agent queue/audit. Forwarding reveals the same canonical request; human answer and retry handlers refuse requests that have not reached the human.

Request visibility has one audience rule: the current queen and original requester can read a private question; other participants and human views see it after human routing. Conversation replies retain their request scope independently of parent-row retention. Request-origin topic titles use current visible request text unless an explicit rename has matching audience/content provenance. Old draft titles never become public through forwarding or pruning.

Human numbering counts visible messages with a preserved public pruning offset, independently of private requests entering a topic. Human-authored messages always remain public, including ordinary comments in selectively forwarded topics and topics whose request records have been retired. Private publications cannot answer public human messages; mixed-audience answer links are refused atomically and require a separate visible answer. History, inbox pages and deep links share that ordering; visible request/content changes and public pruning invalidate browser page caches without clearing drafts. Human inbox revisions are opaque fingerprints of visible obligations, rather than raw mutation counters. Image reads recheck visibility before and after I/O, and acknowledgement ranges include only visible rows. Private native ids receive the same unavailable response as unknown ids. Agent context uses the same audience view, including private discussion and topic filtering.

## Attached sessions and review policy

A bead's attached sessions are its active bindings (`worker`, `reviewer`, `investigator`, exposed as work, review, helper) plus the claim holder. `hive_spawn_worker` takes a `role`; the queen/coordinator may launch any role, the claim holder only review and helper for its own bead. Reviews use the cell's `reviewPolicy` (`primary` and `secondary`, defaults claude/opus/medium and codex/gpt-6.1-sol/medium; Terra models are refused on save and on override), choosing the config whose agent differs from the builder session's `agent`, else the primary with `sameProvider: true`. Departing from it requires `override_reason`, stored on the review's `policy`. `hive_bind_session` with role review joins a session started elsewhere and creates its review record. Work, in-review and idle are derived from attached sessions (`server/bead-sessions.js`) and add no stored status. The queen is delivered a notice when a review session starts or joins and when a verdict lands. Host fields used: `host.sessions.get(id).agent`, `.model`, `.effort`, `.status`, `.lastActivity`.
