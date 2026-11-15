# Per-repository delivery recipes

Accepted delivery contract. Each repository's recipe names its checkout and push route, merger, required checks, delivery boundary and any install/deploy procedure. A narrower task instruction remains binding. This document defines agent practice; it does not install a policy engine or change repository settings.

## Shared flow

Use an isolated worktree and branch per bead. Commit, push through the approved route and open a PR within the task's publication authority. Check the destination and diff before public pushes; never publish private code or secrets. Keep unrelated work in separate PRs.

Obtain adversarial review through `hive_spawn_worker` with `role: "review"` and the commit to review. Fix findings and reuse the reviewer for at most two verdict rounds by default. If the second round still requests changes, escalate through `hive_request_input`; the limit never counts as approval. Record the reviewed commit and verify the current PR head before merging. New commits require review of the resulting head.

Respect repository protections, required reviews and environment approvals. Never bypass protections, use `--admin` or push directly to the default branch. Use the permitted merge method with `--match-head-commit` against the approved head; do not leave native auto-merge armed across later pushes. A green optional check does not establish an enforced merge gate.

## Repository recipes

The Hive builder-merge and auto-update recipe below requires rollout. Until its protections and worker instructions are in place, hand merge back to the queen. Until auto-update is enabled after restart verification, hand back with `install-wait` and keep the bead open until the queen verifies installation. Merge becomes the ordinary Hive boundary only after that rollout.

| Repository | Merge authority and checks | Delivery boundary and owner |
| --- | --- | --- |
| Hive (`psjamesh/agent-wrangler-hive`) | Builder merges after Hive review approves the exact head and required `test` (workflow `Test`) passes. Main must require the check with strict branch protection, enforced for administrators and the executing credential. Verify classic branch protection and active rulesets with read-only `gh api` calls, including admin enforcement and applicable bypass actors, before using builder merge; if unavailable, hand back to the queen without bypassing them. | Merge is the ordinary bead boundary. Core extension auto-update owns installation and its supervised restart; the queen does not run an install for every PR. Explicit runtime acceptance stays open for verification. |
| Agent Wrangler core | One human approval per PR through `hive_request_input`, identifying PR/head, review and check evidence. The queen merges after approval and repository requirements pass; upstream maintainers merge where permissions require it. Follow core's contribution instructions, currently `AW_BROWSER_TESTS=0 npm test` for local agent runs; never use bare `node --test`. | The queen fast-forwards the configured checkout, restarts the configured instance and verifies the running revision. Merge approval includes this install/restart; no separate install approval is needed. Keep the bead open until this delivery is verified. |
| Other repositories | Follow the repository's merge authority and prescribed checks; absent a delegated recipe, request one human approval per PR and respect maintainer authority. | Merge is the default boundary. Record the verified merge and operational handoff. Deployment verification is opt-in through the recipe or bead acceptance, with a named owner and bounded procedure. |

Hive feature PRs do not bump the package version. Named releases follow [Hive releases](../releases.md). Keep Hive's public push route and commit identity in its repository instructions.

### Hive auto-update prerequisites and limits

Enable core's existing extension auto-update only after a restart-survival check on a disposable instance. The installation must be unpinned, opted in, and have core's update service available in Notify or Auto mode. Capability additions and downgrade confirmation retain their consent gates. Until those prerequisites are met, record the install obligation with the queen rather than claiming auto-update is active.

This path follows main's head, not an exact CI-selected SHA. It can serve updated client assets before the server restarts, and its quietness check does not drain interactive workers or in-flight writes. These are accepted limits of this delivery recipe. A successful install proves disk state; runtime verification must check the loaded SHA and active extension when acceptance requires it. Use a separate delivery-service design only if this path proves inadequate.

## How workers receive the recipe

Keep durable repository instructions in `AGENTS.md` (with a `CLAUDE.md` import where needed). Workers read those instructions and linked contribution guidance before testing, committing or publishing. The workstream brief template can be just ‘Use the hive-worker skill’. Resolve delivery facts first from repository instructions, then from the user’s own agent instructions (such as global `CLAUDE.md` or Codex `AGENTS.md`) for personal workflow facts such as a fork push route. If neither supplies a required delivery fact, ask the queen through `hive_request_input` before pushing; do not guess. Bead-specific briefs identify the assigned work and any additions or exceptions to the repository recipe. A hive-wide worker profile cannot substitute for repository-specific instructions.

For an opted-in install/deploy step, name the target, command or workflow, commit/artifact mapping, success signal, maximum wait and handoff recipient. Resolve missing configuration once through the queen. Do not infer deployment from workflow names or treat PR checks, a main build, installation and application health as interchangeable.

## Evidence and handoff

A worker's `hive_request_input` goes to the queen, who must forward a required human merge approval to the human. A queen answer is not human merge approval.

Record PR/head, review verdict, check results, merge approval or delegation and verified merge commit on the bead. Add installed/running revision or deployment evidence only where the recipe requires it. Install reports show the running short SHA and the PRs it includes, retaining the full SHA as evidence. Finish when that boundary and the bead's other acceptance are met; opening a PR or handing it back does not establish delivery.

For Hive after the builder-merge rollout, refresh the PR head and required checks before `gh pr merge <url> --merge --match-head-commit <approved-head>`. Use a merge commit. Any changed head needs fresh exact-head Hive approval, including mechanical version bumps and clean rebases. The queen does not prepare Hive version bumps or perform routine Hive merges after rollout.

Record the confirmed Hive merge through `hive_update_bead.add_evidence` or `hive_finish_bead.evidence` with `kind: "merge"`, the PR `url` and `merged_head` (the actual full merged PR head SHA, not the merge commit). Include the merge commit and check verification in `detail`. The evidence guard refuses missing or mismatched heads against the latest approved review on the bead. The builder retains its claim and closes after verified installation or explicit delegation to configured core auto-update, with the remaining obligation recorded. Hive does not perform a GitHub merge itself; the evidence guard checks the supplied head, while the builder verifies GitHub's actual merge. Until rollout is complete, use the queen merge/install handoff above.

When another owner must merge or install, record `merge-wait` or `install-wait` evidence, the owner and next action, then release the claim as open for that delivery handoff. Use existing host notices or a supported structured wait to resume. Without reliable wake-up, hand back with the pending obligation visible; never poll in terminal loops. Reconcile uncertain create, merge or install outcomes before retrying. For long release waits, use an owned external verification bead with a structured resume condition.

## Supporting investigations

- [Holistic review](../investigations/holistic-review.md): rationale for builder merges, repository instructions and core auto-update.
- [Hive release flow](../investigations/hive-release-flow.md): installation, restart and provenance behavior.
- [CI and deploy watching](../investigations/ci-and-deploy-watching.md): merge boundaries, opt-in verification and bounded waits.
