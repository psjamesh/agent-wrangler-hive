# Holistic review: how Hive works and what to change

Adversarial review, 15 November 2026. It tests today's investigations, the accepted delivery-policy design and the plan already under way against the code, the live cell record and GitHub. It proposes changes; it changes no code, settings or skills.

Evidence: Hive main at `8f5b77f`; Agent Wrangler core at `2c4998a`; one cell's full record read through `hive_context` at about 15:57Z (31 open and 214 closed beads, 84 PR records); read-only `gh` queries; read-only inspection of the local installation's provenance and process environment. No tests were run and no browser was launched. Where a cause is inferred rather than observed, it says so.

## Verdict

Hive's record-keeping is sound: claims, journaled writes, link-derived waits, review rounds and pickup authorization are careful and well tested. The failures come from three structural gaps around that core:

1. **The queen sits in the delivery path by contract, not by necessity.** The only delivery path the skills and docs describe is: the builder hands back, the queen merges, installs, restarts and closes. The repository is also configured so that, under the accepted delivery policy, nothing else is allowed to merge. A1 and A2 remove the version bump and the install, but leave the queen merging every Hive PR.
2. **Product behaviour lives in prose that each agent must reproduce.** This covers the delivery recipe repeated in every pickup brief, a ten-step release procedure passed between queens in a handoff summary, and queen instructions that load personas contradicting Hive's own rules. Nothing checks that a fresh agent receives any of it.
3. **Hive's view of the outside world is unreliable at exactly the points automation will depend on.** PR records are keyed by URL with a bead association that is never revised, and new PRs now collide with old ones. Free-text waits silence the watchdog. Closure, the only "delivered" signal, is unguarded.

The plan under way targets the right area, but it is ordered expensive-first. It builds a core API, structured CI waits and an external delivery service, while three cheaper levers would remove the queen from most of Hive delivery:

- require the `test` check (from workflow `Test`) on Hive's main branch, enforced for administrators too;
- let the builder merge its own approved PR;
- after a restart-survival check on a disposable instance, turn on core's existing extension auto-update for Hive, which this installation already supports. This is a deliberately weaker interim option: it follows the main branch head, not an exact CI-green SHA.

Two items in the plan are harmful as scoped and were raised with the queen early:

- **D (hive-wvdf):** its terminal-record skip would freeze wrong PR states.
- **B (hive-nn3r):** one default profile per hive would launch workers into the wrong repository, with no delivery instructions.

## Today's failures, explained

| Failure | Cause found | Status |
| --- | --- | --- |
| The queen was the bottleneck on every release | The only delivery path in the skills and docs is "the queen merges" (`skills/hive-worker/SKILL.md:45`, `skills/hive-queen/SKILL.md:98`, `docs/automatic-pickup.md:48`). The release recipe has ten steps: bump, test, commit, leak-check, push, open PR, merge, release the bead, ask the human, then stage, consent and restart through operator scripts. It travels in the current queen launch's handoff summary, not in Hive. Hive main has no required status checks, zero required approvals and auto-merge disabled, so the accepted policy's `auto` merge mode is unavailable. 17 Hive PRs merged on 15 Nov. #70 and #71 merged at 15:04–15:06, but their beads closed only at 15:29, together with #72's, after one install. Installs were batched through the queen. | Open. A1 and A2 do not remove the merge step. |
| Scoped work sat unmarked while slots were free | Readiness is a per-bead queen act that needs a hand-written brief. No process, prompt or default decides it. The queen confirmed this to the human. At the snapshot, capacity was 10 of 16 while u03e, j543, grfu, 0ejw and xcbq had goals and acceptance but no mark. | Open. B targets it but is mis-scoped. |
| A worker waiting on CI was never woken, and its wait hid it from the watchdog | Any non-empty `waiting_for` suppresses the aborted-turn, API-error, dormant-claim and idle-worker flags (`server/watchdog.js:201`, `:214`, `:222`, `:228`).<br><br>For a plain, undated CI wait on an otherwise idle or sleeping worker, only `stale_wait` remains, after 24 hours, and it goes to the queen. Two other flags are not suppressed: `overdue_wait` fires when the wait text names a recognisable deadline that has passed (`:173-175`), and an exited or errored claimant is still flagged (`:210-212`).<br><br>Hive never wakes a worker. Core's pane notices need a session-scoped link and Auto-fix enabled. They are deduplicated by status and head, so pending to passing on the same head does notify, but a rerun that ends in the same status on the same head stays silent. | Open. C covers it, but behind a core dependency. |
| A builder closed its bead before merge, so a dependent started early | `finishBead` (`server/ops.js:1304`) checks reviews, children and prerequisites, but not associated PRs. Closing immediately resolves link waits and releases armed dependents. "Closed means delivered" is enforced only by skill text, while the mob-worker persona the queen's instructions require says to "complete autonomously". | Open. No bead covers a guard. |
| The queen asked the human the same thing twice in different threads | Requests deduplicate only per requester and only on an explicit `dedupe_key` (`server/requests.js:132`). A forwarded worker request and the queen's own request on the same subject are two items, and `hive_publish` accepts any prose. The queen's default context is about 185 KB, so compaction and loss of what was already asked are likely. The specific instance was not in the 20-message window available to this review, so this is the mechanism, not a reproduced trace. | Partly addressed by guidance (#65). |
| Private queen rules hid product behaviour | The standing-rules audit found 15 of 26 rules were product behaviour. Larger carriers remain outside its scope: every pickup mark holds a roughly 3 KB brief restating the delivery contract, and the handoff summary holds the release recipe and install-script locations. One script path in the current launch's handoff now points at a deleted temporary directory. The operator has since copied the scripts elsewhere, privately. | Open. |
| Restarts stopped workers | Each install ends in core's board restart (`restart-server`), one per change. At least one worker (hive-c8dh's) was stopped by restarts on 14 Nov, and on 14 Nov the queen itself had to be replaced because its tool list predated a Hive release. The release-flow investigation's claim that panes survive restarts is an untested code reading; the record contradicts it at least once. Why the worker stopped is not established. | Open. hive-xcbq investigates stale tools only. |
| `blocked` was hand-set and got stuck | Fixed. `blocked` writes are refused and waiting is derived from links (#66, #71; hive-eccw, hive-o0yk). | Fixed. |
| A review couldn't be reopened after approval | `startReviewRound` requires a `changes_requested` verdict (`server/reviews.js:21`). A retained reviewer cannot review a new commit after approving. | Open (hive-j543). Matters less once A1 removes post-approval version bumps. |
| False "open PR on closed bead" flags | Two causes. (a) Cached PR state lags a merge by up to one sweep; hive-u03e describes this. (b) The repository was recreated on 13 Nov, so PR numbers restarted. PR records are keyed by URL, a bead association is set once at discovery, and a known URL is never re-associated (`server/pr-label-discovery.js:38`, `:44`). New PRs #62, #77 and #78 are tied to beads closed on 12 Nov. At about 16:00Z on 15 Nov, #80 (n11m) and #81 (wvdf) were open on GitHub but recorded as MERGED against old beads; #80 has since merged. | (a) is in wvdf. (b) was unaddressed and was mailed to the queen. |

## Claims tested

### Release flow (`hive-release-flow.md`)

These claims hold:

- The package version has no runtime consumer.
- Core detects updates by SHA.
- An exact ref pins the installation.
- Replacing a registered extension needs a server restart.

These are wrong or missing:

- **Core's auto-update is available on this installation now.** The report rightly calls it the lowest-effort supported automation and lists its trade-offs. What it doesn't establish is that this host meets the preconditions: the running server is supervised by launchd with Git updates enabled, the global update mode is the default `notify`, and Hive is installed unpinned with `autoUpdate: false`. Turning that flag on installs main hourly and restarts on core's quiet test. That would remove the queen from installs with no new code.

  The report's objections stand and must be accepted explicitly:
  - The updater clones the branch head with no CI selection. A green PR head is not proof that the resulting main commit was tested.
  - Required PR checks only narrow that gap if they are strict and cannot be bypassed. Today `enforce_admins` is off, the merging credential has admin rights, and no branch rules are active.
  - Core installs before checking for quiet (`update-service.js` in core), and the install replaces the live asset directory. A long wait for a quiet moment therefore extends the window where new client files are served by an old server.
  - Core's quietness test ignores interactive workers and in-flight MCP or Beads writes.

  Treat it as a weaker interim option. Validate restart survival, in-flight writes and client/server generation mismatch on a disposable instance before enabling it on the live one.
- **Restart cost is treated as secondary.** At 17 merges a day, "deploy each green SHA promptly, without batching" means 17 restarts a day, and each is today's worker-stopping failure. Installing the latest green SHA at the next quiet point is coalescing, not a release train. Its rule against batching should say so.
- **Merge is assumed solved.** It is not: see the verdict.
- **The quiesce, drain and generation-safe activation steps are core lifecycle work.** A2 (hive-wy10) links no core prerequisite.
- **A1 removes the human-visible release signal.** The queen announces "Live in Hive 0.1.x"; something needs to replace it. Report the running short SHA and the PRs it contains.

### CI and deploy watching (`ci-and-deploy-watching.md`)

These hold:

- Merge should be the default boundary.
- Polling costs are dominated by historical records; the code confirms terminal records are re-read and search covers every state.
- The defect is "an unowned continuation disguised as a wait".

These are missing:

- **PR identity.** URL keys collide after a repository recreation or rename, and associations never refresh.
- **The fix is heavier than the defect.** Once merge is the boundary and the builder or Hive merges on green, the only continuation left before merge is "checks finished on the head that was reviewed". For Hive that takes about 50 seconds, and core already sends a "mergeable" notice. The part that needs no core API is to stop prose from silencing the watchdog, and to have Hive observe "PR merged" and finish or flag the bead. Run, attempt and deployment tracking is only needed for repositories with long CI where the builder must act on failures.

### Queen standing rules (`queen-standing-rules.md`)

These hold:

- Don't add `HIVE.md`.
- One home per fact.
- Hive has no `AGENTS.md` or `CLAUDE.md` (confirmed).

These are missing:

- **The two largest carriers of private behaviour are out of scope:** the per-mark pickup briefs and the queen handoff summary.
- **The instruction stack contradicts itself.** The hive's queen instructions require the mob-boss persona, and its workers the mob-worker persona. Mob-boss says to launch workers with `spawn_session` and to archive a worker once its PRs close. Mob-worker says to run `adversarial-pr-review`, a review spawned outside Hive. The Hive skills forbid both. Today the queen reconciles this privately, in each brief.

### Header (`hive-header.md`)

The analysis is sound, but the header does not cause today's problems. One point matters to the human's goal: Needs you does not cover a queen that is live but not acting. hive-h34z adds only a queen stuck at a terminal prompt. Implement the layout after the delivery changes.

### Delivery policy (`docs/design/delivery-policy.md`, accepted)

Parts are superseded but still about to be built (hive-snbv, hive-64or, hive-6k1u):

- It says to monitor CI/CD after merge, which contradicts merge as the boundary.
- It says agents install Hive and restart Agent Wrangler, which contradicts A2's external service.
- Its allowance that a mechanical version bump keeps review approval is moot after A1.
- Its Hive row keeps "queen may prepare version … queen delegation" for merge.

Its safety floor for `auto` merge requires server-enforced checks. Hive has none, so the design as accepted keeps the queen as Hive's merger permanently.

It is also heavy for one operator: global rules with exact, `owner/*` and `*` matching, branch lists, fork mapping and a settings editor. Its useful core is small:

- which checkout and push route a repository uses;
- who merges it;
- what happens after merge.

## The plan under way

| Item | Assessment | Change |
| --- | --- | --- |
| D, hive-wvdf: stop over-polling | Right target; the numbers check out. **Harmful as written:** "one final read, then stop" would freeze colliding records, such as #80 and #81 recorded as MERGED while open. | Before skipping terminal records, verify PR identity (node id, or head ref plus creation time) and re-associate from the current session link when it changes. Clean up records created before the repository's creation date. |
| A1, hive-n11m: no per-PR version bump | Right, cheap and low risk. | Add a replacement for "Live in Hive 0.1.x": the running SHA and the PRs it contains. |
| B, hive-nn3r: ready by default | Right goal. **Harmful as scoped.** (1) One `cwd` per hive is wrong for this cell, which spans the Hive repo, core and a fork. (2) A default profile carries none of the delivery contract that today's 3 KB briefs supply; the fallback intent is one sentence (`server/pickup.js:35`). (3) "Ready unless held" would start the old unprioritised backlog at once. (4) A bead handed back for merge is protected from re-pickup only by its `waiting_for` prose (`server/pickup.js:102`), which C plans to restructure. | Put profiles on the repository or workstream. Make ready-by-default apply to newly created beads. Exclude beads with an open PR or a delivery handoff by a structured check. Land the Hive `AGENTS.md` and the effective delivery rule first. |
| C, hive-v829: structured CI and PR waits | Right defect, too broad, and placed behind a human-merged core PR and a core restart (hive-5jyw). | Split. **C0, now:** prose waits suppress watchdog flags only for a short grace period; Hive observes a bead's PR merging and finishes the handed-back bead or raises a precise flag. **C1, later and only if needed:** structured check and run waits for long-CI repositories, on 5jyw. |
| hive-5jyw: expose core's PR observations | A sound core contract. | Keep it, but off the critical path once C is split. |
| A2, hive-wy10: external delivery service | Solves a real problem at the highest cost, and depends on core lifecycle work it doesn't link. | Defer the service. Do its first validation step now: restart survival, in-flight writes and client/server generation on a disposable instance. Then turn on core auto-update for Hive as an accepted weaker interim, and build A2 only if hourly, branch-following installs prove inadequate. |

## Structural problems

1. **Queen-mandatory delivery.** Each Hive PR costs the queen four or more turns: merge, claim, wait for install, close and refresh the workstream. The queen is also a long-lived, compacting session that has gone stale-tooled once already.
2. **Pickup and the watchdog depend on the queen.** Pickup halts for the whole hive when the queen session has exited (`server/pickup.js:124`). Watchdog digests go only to the queen, and nothing escalates when the queen doesn't act. "Work keeps moving without anyone checking on the queen" is therefore false by construction. Work moves only while the queen is live and attentive.
3. **Prose as protocol.** Delivery rules, readiness, waits (`waiting_for`), completion (regular-expression matching in `finished_open`) and human waits (heuristic matching) are all inferred from free text. Each new rule makes the queen's private prose longer.
4. **Unreliable external state.** PR identity collisions; cached PR state; stale workstream summaries. hive-5xs's next action still reads "Install 0.1.135 when approved", while the live version is past 0.1.150.
5. **An unguarded delivery signal.** Closure releases dependents immediately, but nothing ties it to a merge.
6. **Context weight.** The queen's default `hive_context` is about 185 KB, roughly 45k tokens. About 97 KB is open beads, inflated by full pickup briefs, and 38 KB is PR records, mostly 78 merged ones. Against the default 250k-token queen limit, every refresh costs nearly a fifth. That feeds compaction, repeated questions and lost instructions.
7. **Unmeasured restart cost.** Restarts are the dominant delivery cost and the source of stopped workers, yet no test or record measures what survives one.

## Prioritised changes

**P0: today, little or no code**

1. **wvdf:** gate terminal skipping on PR identity, and clean up records from before the repository was recreated. *Risk if skipped:* live PRs permanently treated as merged.
2. **nn3r:** rescope as above before more is built.
3. **Human, repository setting:** make `test` (from workflow `Test`) a required, strict check on Hive main, with enforcement for administrators. Without enforcement, the admin credential agents use can bypass it.
4. **Validate restarts on a disposable instance:**
   - does a working tmux worker survive with its claim, and can it still call MCP afterwards;
   - is a write whose response was lost during the restart reconciled rather than duplicated;
   - do new and existing board tabs receive assets that match the running server.

   This was a precondition for A2 and is now a precondition for change 5. Run it with hive-xcbq.
5. **Human, install setting, after change 4:** turn on core extension auto-update for Hive, then stop the queen's private stage, consent and restart scripts. *Accepted residual risk:*
   - it deploys the main branch head, not a CI-selected SHA;
   - it can serve new client assets to an old server until the quiet restart;
   - its quiet test does not drain interactive work or in-flight writes.

   Today's manual restarts share the last two risks and have no quiet test at all.
6. **The builder merges its own Hive PR** after Hive's review approves that exact head and the required check is green, using `--match-head-commit`. Hive records the merge as evidence. The queen stops merging Hive PRs. *Risk:* a builder merging after unreviewed later commits. The head match prevents that.

**P1: this week, small code**

7. **C0:** prose `waiting_for` suppresses idle, dormant and aborted flags for a bounded grace period only, and Hive observes a PR merging for its handed-back bead and finishes it or raises `finished_open` precisely. This makes the "release to open, the queen claims, the queen finishes" handoff unnecessary for merge-boundary repositories. Order it after change 1.
8. **Finish guard:** refuse `done` while a correctly associated PR is open, unless the repository's delivery rule says merge is not the boundary. Order it after change 1; it would misfire on colliding records otherwise.
9. **Hive `AGENTS.md`** with a `CLAUDE.md` import, covering the public-repository rules, commit identity, test command, push route and delivery boundary. Shrink pickup briefs to bead-specific content.
10. **Escalate an unresponsive queen to the human:** a Needs you item when watchdog flags have gone unactioned for a configurable time, or when the queen session has exited while armed work waits.
11. **Trim the default queen context:** a digest instead of full pickup intents, and no terminal PR records unless asked.

**P2: after the above**

12. Revise the delivery-policy design down to a per-repository recipe (checkout, push route, merger, post-merge step), projected into bead context. Then build hive-snbv, hive-64or and hive-6k1u against the revision.
13. hive-j543: only needed for design changes made after approval.
14. C1 structured check waits on hive-5jyw, for long-CI repositories.
15. A2, only if change 5 proves inadequate.
16. Header layout (hive-skst choices).

## Stop doing

- The queen bumping, merging, installing and restarting Hive.
- Asking the human per install, as in "Install Hive 0.1.x?" threads.
- Announcing releases by version number.
- Writing the delivery contract into every pickup brief.
- Treating `waiting_for` prose as a wait.
- Loading personas whose launch and review rules contradict Hive's, with no precedence rule.
- Building the accepted delivery-policy settings editor before revising its text.

## Choices for the human

| Choice | Options | Recommendation |
| --- | --- | --- |
| Who merges Hive PRs | Builder, after approved review and green required check; Hive server; queen (today); human | **Builder.** Smallest change that takes the queen out. A Hive-server merge is a larger, new GitHub-write capability. |
| Required checks on Hive main | Require `test` (workflow `Test`), strict and enforced for administrators; leave unprotected | **Require it, enforced for administrators.** It is the policy's own precondition for safe agent merges, and the check takes about 50 seconds. Without admin enforcement, the agents' admin credential can bypass it. |
| How Hive gets installed | Core auto-update after a disposable-instance restart check; build A2; a designated delivery worker; the queen (today) | **Core auto-update after the restart check**, accepted as weaker than exact-green delivery: it follows the branch head, and its quiet test does not drain work. A2 only on evidence. |
| Scope of "ready by default" (B) | Per-repository profiles for new beads; per-hive default as specified; keep explicit marks only | **Per-repository, new beads only**, with structured exclusion of beads awaiting delivery. |
| Delivery-policy design | Revise to a small per-repository recipe; implement as accepted | **Revise first.** The accepted text is partly superseded. |
| CI waits (C) | Split: watchdog and merge-observation half now, structured waits later; full C now | **Split.** |
| Personas inside Hive | Hive skills take precedence and queen instructions drop mob-boss/mob-worker; make the personas Hive-aware | **Hive takes precedence**; keep the personas for non-Hive work. |
| Unresponsive queen | Surface to Needs you after a threshold; leave with the queen | **Surface it**, default 30 minutes. |
| Core (upstream) merges | Human approves each; delegate | **Keep the human approval** for the upstream organisation repository; optionally group ready PRs into one request if the volume stays high. |
