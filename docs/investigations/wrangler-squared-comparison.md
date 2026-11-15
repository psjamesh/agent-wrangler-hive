# Hive beads and Wrangler² jobs and steps

Investigation: 15 November 2026. Recommendations, not an approved implementation plan.

## Finding

**A leaf bead is closest to a Wrangler² step. A bounded outcome represented by a subtree is closest to a job. A Hive cell is broader than either.** The overlap is substantial: both describe outcomes, dependencies, agent work, evidence, human decisions and continuations. They differ chiefly in who executes the protocol. Wrangler² has a deterministic runner around approved plans; Hive combines a durable work graph, automated dispatch and reconciliation with a queen and workers that interpret acceptance and delivery instructions.

Keep Hive as a general interface to work. Adopt explicit execution and result contracts from Wrangler², and share infrastructure through Agent Wrangler. Do not make every bead a PR pipeline, turn every workstream into a closed plan, or run the same deliverable under two independent schedulers.

Wrangler² is already broader than code: its step kinds are `pr`, `session`, `human` and `write`. Research, documents and external actions therefore belong in the comparison, rather than being reasons to dismiss it as a PR tool.

## Scope and evidence

This is a read-only source comparison, not a runtime trial. The inspected Wrangler² checkout was clean at `295b8e7c66e19dfe821b0029614c0f3572ab03b0`; Hive was inspected at `db1988990b16ae05a682e7fdcda5f4fd3e002723`. No Wrangler² files were changed, no browser was launched, and no live jobs, deployments or restarts were exercised. Source behavior does not establish that a particular installed host exposes the same capabilities.

Wrangler² source references below are paths within its separately supplied checkout. They identify evidence without publishing machine paths or deployment details:

| Reference | Sources inspected |
| --- | --- |
| W1: work and planning | `README.md`, `AGENTS.md`, `server/jobs-schema.js` (`subJobSchema`, `planSchema`), `server/job-prompts.js` (`SPLIT_PRINCIPLE`, `PLAN_SESSION_RULE`, `jobPrompt`) |
| W2: execution and dependencies | `server/job-lifecycle.js` (`LIFECYCLE`, `transition`, `halted`), `server/job-gate.js` (`edgeKind`, `dependenciesSatisfied`, `redsAbove`), `server/job-runner.js`, `docs/notes/lifecycle.md` |
| W3: results and checkpoints | `skills/job-worker/SKILL.md`, `server/job-store.js` (`report`), `server/jobs-schema.js` (`proofSchema`, `REVIEW_DEFAULTS`), `docs/notes/code-pipeline.md`, `docs/notes/proof.md`, `docs/notes/writes.md` |
| W4: recovery and resources | `server/job-runtime.js` (`launch`, `noteDispatch`), `server/job-tries.js`, `docs/notes/tries.md`, `docs/notes/replans.md`, `docs/notes/runner.md` |
| W5: delivery, agents and UI | `server/job-github.js` (`merge`, `deployment`, `successor`), `server/job-deploys.js` (`inferDeploys`), `server/job-agents.js`, `docs/notes/new-job-form.md`, `docs/notes/merging.md`, `docs/notes/job-page.md`, `public/job-tries.js` |

Hive evidence is linked at the point of comparison. The investigation documents discussed below are dated analyses; their recommendations are distinguished from current source and the accepted delivery recipe.

## Model mapping

| Wrangler² concept | Closest Hive concept | Limit of the mapping |
| --- | --- | --- |
| Job: one outcome worth shipping, dropping or deferring as a whole | Bounded outcome bead and its descendants; sometimes a workstream | A long-running workstream can contain many independent jobs. A cell can coordinate unrelated outcomes. Wrangler²'s planner explicitly keeps dependent work in one job; it has no cross-job dependency mechanism in this model. |
| Approved plan and `after` graph | Child beads and blocking links | Hive can discover and restructure work continuously. Parent placement groups work; links establish dependencies. A Wrangler² Jira story is a tracking group, not a second scheduler. |
| PR or session step | Executable leaf bead | A bead persists across worker replacement, review and handoff. A step also persists across multiple runs, despite the simplifying “one session” description. Neither is identical to a terminal session. |
| Human step | External prerequisite or human-owned work | A task only a human can perform differs from a decision request. Approval of an agent's result should be a checkpoint, not another fake implementation task. |
| Write step owned by a session | External action or output recorded on work | Wrangler² distinguishes the action's destination, approval and result link. Hive's general evidence does not offer the same typed write protocol. |
| Run and try | Worker launch/binding and execution attempt | Hive records launches, operations and review rounds, but these are not a single user-facing history of attempts to satisfy acceptance. |
| Runner | Hive dispatch, watchdog, queen and worker responsibilities together | The queen is a planning authority, not an equivalent of a four-second deterministic runner. Moving routine transitions into product behavior can reduce that burden. |

Sources: W1–W4; Hive [bead model](../../server/bead-model.js), [operations](../../server/ops.js), [pickup contract](../automatic-pickup.md), [worker skill](../../skills/hive-worker/SKILL.md).

## Comparison and recommendations

### Lifecycle and planning

Wrangler² declares legal stage/state moves per step kind in `LIFECYCLE`. A PR moves through implementation, review, PR observation, optional deployment, cleanup and done; a session has its own shorter route. `transition` checks fresh state inside the store update. Stale runner observations cannot overwrite a cancelled or advanced step. An identical final receipt can be retried after a lost response; a different second receipt is refused. Initial plans and proposed changes pass through configured checkpoints, with affected steps held and action pins checked when approved. Some red-step repair proposals apply automatically under the configured policy, so “agents never change the plan” is not an absolute description. [W1–W4]

Hive intentionally stores fewer statuses: open, in progress, deferred and closed. Waiting comes from links and explicit conditions; kinds distinguish goals, workstreams, investigations and other work. The queen can adapt the graph without presenting every structural edit as a new whole-plan approval. This suits exploratory and continuing work. [Bead model](../../server/bead-model.js), [link waits](../../server/link-waits.js), [operations](../../server/ops.js).

**Adopt:** typed transitions and results for execution attempts, with idempotency and stale-result guards. Keep the simple bead lifecycle and flexible decomposition. A code delivery phase belongs to an execution contract, not the universal bead status list. For material scope changes, borrow Wrangler²'s reviewable change proposal and stale-approval pins; do not require a human to approve every discovered child or dependency.

### Dependencies and waits

Wrangler² edges gate starts. Under its default “Carry on” policy, a PR after a PR in the same repository waits for merge; cross-repository and non-PR dependents wait for deployment. A post-merge failure pauses new downstream starts and merges, including through already completed steps, while allowing work already started and an explicit repair path. These are meaningful execution semantics, not merely graph arrows. [W2, W5]

Hive's blocking links wait for prerequisite closure, including external work; investigation and decision blockers appear as “Waiting on design”. Calendar/prerequisite review conditions are distinct from prose. CI waits pin a claimant, PR identity/head, selected outcome and deadline, retain terminal evidence, wake the owner and require acknowledgement. Unknown delivery, changed heads and stale observations produce reconciliation rather than guessed success. Workflow/run/attempt identities are explicitly unsupported by this wait API. [Pickup](../automatic-pickup.md), [CI waits](../ci-waits.md), [wait implementation](../../server/ci-waits.js).

**Keep:** Hive's general prerequisite model and durable owner/deadline/acknowledgement contract. **Adopt selectively:** expose the event a dependency actually needs—accepted research, approved decision, merged code or verified deployment—when a simple closed prerequisite is insufficient. An explicit milestone or verification bead is enough initially. Do not infer a dependency's delivery requirement solely from whether two repository paths match. **Converge:** shared observation and wake primitives, with one scheduler owning the continuation.

### Retries, failure and recovery

Wrangler² records a try for implementation/session work, including changes, checks, read failures and outcome. It stops on an unchanged fix, a repeated normalized failure, or a backstop count; the job spend limit is independent. Retry starts a new clock without erasing history. Red triage can repair or propose a plan change, but exhausted loops go to the human instead of asking another planner to repeat them. Its UI explains the specific stop and folds identical failures. [W4]

Hive is stronger at fencing uncertain actions across systems: pickup is a durable one-launch authorization, submitted or uncertain starts are not blindly replayed, and claims, bindings, journals and review receipts survive session changes. Proven pre-submission read failures have bounded retries; this is distinct from retrying the work. The watchdog and queen reconcile failed workers and uncertain writes. [Pickup recovery](../automatic-pickup.md#durable-authorization-and-recovery), [recovery implementation](../../server/recovery.js), [reviews](../../server/reviews.js).

**Adopt:** a concise, durable attempt history and explicit stop reason across worker replacements; compare the failures and results before retrying. Make attempt/spend bounds configurable for general work, rather than copying a CI-error fingerprint as a universal notion of progress. **Keep:** Hive's stricter launch uncertainty fence. A work retry, a model API retry, a wake retry and a possibly completed external write need different authorization; “retry” must never silently mean all four. Wrangler²'s dispatch implementation also notes a missing host correlation tag, making shared launch identity a concrete integration opportunity. [W4]

### Delivery and verification

Wrangler² workers report and leave PR monitoring, repairs, merge, post-merge observation and cleanup to the runner. Code review can pin an uncommitted tree hash; merge uses `--match-head-commit`. Session completion is a separate result. Its `show` items require corresponding structured proof or an explicit `couldNot`, and retain evidence per round. This gives the human an inspectable answer to “how do we know?”. It does not independently prove that the agent's claimed command ran. [W3, W5]

Its deployment inference reads push workflow triggers and changed paths, then observes non-PR runs on the merge commit, with rules for succeeding descendant runs. That is useful workflow evidence, but a passing run may only be tests, and a passing descendant can even contain a revert. It does not establish that an application is live or healthy. [W5]

Do not copy its merge policy wholesale: squash is the default, and an explicitly accepted-red head can take an administrator-bypass path in `job-github.js`. Hive's delivery policy forbids bypassing repository protections. Shared observation or runner infrastructure must preserve that stricter authority boundary. [W5]

Hive's repository recipe separates merger, checks, delivery boundary and installation owner. Merge is normally sufficient for a code-change bead; runtime acceptance remains explicit. Exact-head managed reviews are independent of a human code checkpoint. `finishBead` checks open reviews, children, blocking prerequisites and supplied merge-evidence heads. A `done` outcome also requires evidence and refuses PR evidence without a matching merge receipt or an observed merged/closed state. A queen/coordinator can bypass this evidence guard with an explicit recorded reason; evidence has no per-kind stage requirements. [Delivery policy](../design/delivery-policy.md), [finish operation](../../server/ops.js), [review records](../../server/reviews.js).

**Adopt:** acceptance-linked result receipts with artifact links and verifiable evidence references. Make missing evidence explicit, and enforce the selected completion contract before releasing dependents. **Keep:** delivery as an explicit contract, rather than equating every push workflow with deployment. Examples: a research bead completes when its report is accepted; an operations bead when the requested state is verified; a document bead when the agreed artifact is delivered. A PR is one possible output.

### Human checkpoints and external actions

Wrangler² has six checkpoint flags: plan, code, merge, session results, writes and red-step handling. Writes can override the job default, with drafts reviewed before execution and made artifacts reviewed afterward. A true human task launches no agent. Human feedback routes through the planner and back to the producing step; plan-change actions are pinned so an old approval cannot act on a newer result. Agentic code review is shelved in the inspected version; its “Code” checkpoint is not equivalent to Hive's independent adversarial review. [W1, W3–W5]

Hive routes worker questions privately through the queen, preserving the distinction between a queen answer and human approval. Requests carry options, evidence, a target session and a durable answer; approval of a review remains a separate operation. [Requests](../../server/requests.js), [worker protocol](../../skills/hive-worker/SKILL.md).

**Keep:** the queen's authority boundary and focused request channel. **Adopt:** visible, scoped checkpoints and typed output/write approval where required, with permissions and approval pinned to the relevant content or action. Do not add six global questions to every bead, treat a queen answer as human approval, or impose independent code review on a research-only task. Preserve authorizations already granted by the task.

### Assignment, model choice and resources

Wrangler² saves agent/model/effort and sandbox policy on the job; regular step launches use that pick. Capability flags control provider-specific behavior. Quick naming, classification and progress helpers have their own model setting. The picker uses the host's quality/cost/time data and available catalog rather than owning benchmark data. Its runner enforces a per-job spend limit, pause and top-ups. [W4, W5]

Hive supports inherited workstream launch profiles and explicit per-bead overrides, which fit a cell spanning repositories and kinds of work. Default pickup excludes investigations, decisions and external work; explicit readiness still permits bounded dispatch. Managed reviews have their own provider/model policy, including automatic catalog/front selection. Pickup validates the resolved identity and holds changed or unavailable selections instead of silently substituting. There is no additional per-hive spend cap in the pickup contract. [Pickup](../automatic-pickup.md), [review policy](../../server/review-policy.js), [reviewer front](../../public/reviewer-front.js).

**Keep:** workstream/bead granularity and distinct reviewer selection. **Converge:** host-owned catalogs, capability flags, quality/cost data, sandbox mechanics and usage accounting. Offer bounded budgets for a chosen outcome or attempt if needed; do not confuse burst-rate limits or capacity with spend controls. Hard-coded model-family exclusions in [review policy](../../server/review-policy.js) encode an operator reliability preference: retain any active restriction, but represent such choices as visible policy rather than an inherent property of general work.

### UI and the work interface

Wrangler² leads with a job outcome and drill-down to its graph, step proof, checks, sessions and history. The try view explains what changed, what repeated and why execution stopped. Job sessions live off the ordinary board and jobs deliberately have no Task; otherwise hidden sessions would distort task counts and task archiving could stop parked work. [W1, W4, W5]

Hive's map represents ongoing goals, workstreams, dependencies and owned work, with conversation and decision context. That broader scope is useful when the human asks what is happening across a task, rather than how one plan is executing. [Map](../../public/hex-grid.js), [conversation](../../public/conversation.js), [header investigation](hive-header.md).

**Adopt:** an outcome-focused detail view that shows the deliverable, acceptance evidence, current owner, wait and next authorized action, plus attempt history when relevant. **Keep:** cross-workstream navigation and general work vocabulary. A future job adapter must make sessions discoverable without drawing duplicate work cards or accidentally inheriting incompatible task-archive behavior. Sharing view components is safer than copying either complete UI.

## Overfitting audit of the current Hive investigations

Only the Hive-development workstream needs to ship Hive itself. Its release machinery must not define what every other hive considers work or completion.

| Area | General lesson to keep | Hive-development-specific choice to contain |
| --- | --- | --- |
| [Release-flow investigation](hive-release-flow.md) and [release guide](../releases.md) | Distinguish artifact identity, installed state and running state; reconcile uncertain writes; name the delivery owner. | Git-installed extension provenance, package versions, named releases, Node/tmux survival, extension consent and tool-schema refresh. These belong to the extension repository and host lifecycle. Most research or document beads have none of these stages. |
| Builder merges in the [holistic review](holistic-review.md) and [delivery recipe](../design/delivery-policy.md) | Remove unnecessary coordinator work; pin approval and checks to the artifact being delivered. | The builder as merger, merge commits, the `Test` workflow's `test` check, administrator enforcement and this repository's push route. Other repositories can require human or maintainer merges; non-code work needs no merge. Keep rollout gates and narrower task stop points binding. |
| Auto-update in the release and delivery documents | An explicit operational owner can discharge installation after a delivery handoff. | Following main, hourly checks, consent mode and a supervised host restart are one installation recipe. They neither prove runtime health nor authorize automatic deployment of other projects. Generation-safe activation is host infrastructure, not a mandatory bead lifecycle. |
| [CI/deploy watching](ci-and-deploy-watching.md) | An owned continuation, bounded wait, identity pin and shared observer generalize well. | This repository's short check duration cannot set the right policy for long external pipelines. Conversely, automatically interpreting all merge workflows as deploy gates would import Wrangler²'s software assumptions. Use opt-in post-merge verification with a named signal. |
| [Holistic review](holistic-review.md) | Reduce private protocol, oversized context, duplicate questions and coordinator bottlenecks. | A single operator's development-day failure sample is not a workload census. “Stop the queen merging/installing” is sound for its accepted recipe, not universal authority to merge or install elsewhere. |
| [Standing-rules audit](queen-standing-rules.md) | One authoritative home per fact; put behavior in product, choices in settings and repository facts in repository instructions. | Public push checks, commit identity, browser-test rules, model exclusions and installation targets are repository/operator policy. Do not turn them into universal Hive defaults. |
| [Header investigation](hive-header.md) | Clear identity, work state, decisions and queen availability are general interface needs. | Optimize around multiple hives and mixed outputs, not only a PR/release dashboard. Counters should describe work and attention even when there are no repositories. |

The dated investigations contain useful evidence and also snapshot claims. For example, the holistic review reports missing repository instructions, readiness and wait defects; the inspected tree contains `AGENTS.md`, inherited default pickup and structured CI waits. Read current source and the delivery recipe before acting. Preserve historical findings as evidence; place current behavior in maintained contracts. This comparison is also an investigation, not another permanent instruction layer.

## Adopt, keep and converge

1. **Adopt first:** typed attempt results with acceptance-linked proof and output links; a completion guard for the selected delivery boundary; a visible attempt/stop history. These improve research, operations and documents as well as software work. Specify contracts before proposing code.
2. **Keep:** the durable graph across outcomes, flexible workstreams, explicit ownership, queen-mediated authority, external prerequisites and conservative reconciliation. Retain Hive's exact-head independent review when the task or repository requires it.
3. **Converge infrastructure:** PR observations and identity, launch correlation/idempotency, wake receipts, provider capabilities, catalog/model data and usage. Expose supported host APIs; neither extension should import the other's internals or add a competing poller. Hive's [host contract](../host-contract.md) and [CI wait API](../ci-waits.md) already point in this direction.
4. **Consider an execution adapter later:** one bounded Hive outcome delegates to one Wrangler² job. The bead owns purpose, acceptance and cross-workstream links; the job owns its approved execution plan, sessions and runner. Project step progress into Hive with stable foreign IDs and provenance, without launching Hive workers for the same steps. Cancellation, pause, replanning, approval and task/session visibility need an explicit authority mapping before such an adapter is safe. No adapter is implemented or approved here.

A useful test of any proposed convergence is to model four outcomes: an accepted research report, an updated shared document, a verified operational change and a multi-repository feature. If all four acquire compulsory PR, release or extension-restart stages, the abstraction is still overfitted.
