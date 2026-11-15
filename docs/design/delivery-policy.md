# Per-repository delivery recipes

Accepted delivery contract. Each repository's recipe names its checkout and push route, merger, required checks, delivery boundary and any install/deploy procedure. A narrower task instruction remains binding. This document defines agent practice; it does not install a policy engine or change repository settings.

## Shared flow

Use an isolated worktree and branch per bead. Commit, push through the approved route and open a PR within the task's publication authority. Check the destination and diff before public pushes; never publish private code or secrets. Keep unrelated work in separate PRs.

Obtain adversarial review through `hive_spawn_worker` with `role: "review"` and the commit to review. Fix findings and reuse the reviewer for at most two verdict rounds by default. If the second round still requests changes, escalate through `hive_request_input`; the limit never counts as approval. Record the reviewed commit and verify the current PR head before merging. New commits require review of the resulting head.

Respect repository protections, required reviews and environment approvals. Never bypass protections, use `--admin` or push directly to the default branch. Use the permitted merge method with `--match-head-commit` against the approved head; do not leave native auto-merge armed across later pushes. A green optional check does not establish an enforced merge gate.

## Repository recipes

| Repository | Merge authority and checks | Delivery boundary and owner |
| --- | --- | --- |
| Hive (`psjamesh/agent-wrangler-hive`) | Builder merges after Hive review approves the exact head and required `test` (workflow `Test`) passes. Main must require the check with strict branch protection, enforced for administrators and the executing credential. Verify these prerequisites before using builder merge; if unavailable, hand back to the queen without bypassing them. | Merge is the ordinary bead boundary. Core extension auto-update owns installation and its supervised restart; the queen does not run an install for every PR. Explicit runtime acceptance stays open for verification. |
| Agent Wrangler core | One human approval per PR through `hive_request_input`, identifying PR/head, review and check evidence. The queen merges after approval and repository requirements pass; upstream maintainers merge where permissions require it. Run core tests with `npm test`, never bare `node --test`. | The queen fast-forwards the configured checkout, restarts the configured instance and verifies the running revision. Merge approval includes this install/restart; no separate install approval is needed. Keep the bead open until this delivery is verified. |
| Other repositories | Follow the repository's merge authority and prescribed checks; absent a delegated recipe, request one human approval per PR and respect maintainer authority. | Merge is the default boundary. Record the verified merge and operational handoff. Deployment verification is opt-in through the recipe or bead acceptance, with a named owner and bounded procedure. |

Hive feature PRs do not bump the package version. Named releases follow [Hive releases](../releases.md). Configure the public push route and commit identity in the repository instructions rather than repeating them in every pickup brief.

### Hive auto-update prerequisites and limits

Enable core's existing extension auto-update only after a restart-survival check on a disposable instance. The installation must be unpinned, opted in, and have core's update service available in Notify or Auto mode. Capability additions and downgrade confirmation retain their consent gates. Until those prerequisites are met, record the install obligation with the queen rather than claiming auto-update is active.

This path follows main's head, not an exact CI-selected SHA. It can serve updated client assets before the server restarts, and its quietness check does not drain interactive workers or in-flight writes. These are accepted limits of this delivery recipe. A successful install proves disk state; runtime verification must check the loaded SHA and active extension when acceptance requires it. Use a separate delivery-service design only if this path proves inadequate.

## How workers receive the recipe

Keep durable repository instructions in `AGENTS.md` (with a `CLAUDE.md` import where needed). The workstream's brief template names the repository and instructions, checkout/branch, approved push route, merge authority, checks and stop point. A worker reads these before acting; bead-specific briefs contain only the task's additions or exceptions. A hive-wide worker profile cannot substitute for repository-specific instructions.

For an opted-in install/deploy step, name the target, command or workflow, commit/artifact mapping, success signal, maximum wait and handoff recipient. Resolve missing configuration once through the queen. Do not infer deployment from workflow names or treat PR checks, a main build, installation and application health as interchangeable.

## Evidence and handoff

Record PR/head, review verdict, check results, merge approval or delegation and verified merge commit on the bead. Add installed/running revision or deployment evidence only where the recipe requires it. Finish when that boundary and the bead's other acceptance are met; opening a PR or handing it back does not establish delivery.

When another owner must merge or install, record `merge-wait` or `install-wait` evidence, the owner and next action, then release the claim as open for that delivery handoff. Use existing host notices or a supported structured wait to resume. Without reliable wake-up, hand back with the pending obligation visible; never poll in terminal loops. Reconcile uncertain create, merge or install outcomes before retrying. For long release waits, use an owned external verification bead with a structured resume condition.

## Supporting investigations

- [Holistic review](../investigations/holistic-review.md): rationale for builder merges, repository instructions and core auto-update.
- [Hive release flow](../investigations/hive-release-flow.md): installation, restart and provenance behavior.
- [CI and deploy watching](../investigations/ci-and-deploy-watching.md): merge boundaries, opt-in verification and bounded waits.
