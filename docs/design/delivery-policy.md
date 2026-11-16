# Hive delivery recipe

The [Hive worker skill](../../skills/hive-worker/SKILL.md#default-delivery-recipe) defines the shared delivery defaults, including mandatory adversarial Hive review on the exact head. [AGENTS.md](../../AGENTS.md) is the entrypoint for Hive’s repository settings and overrides. A pickup brief can be just “Use the hive-worker skill. You own cell <id>.” Narrower task stop points remain binding.

## Hive settings and overrides

- Fetch main over HTTPS before starting. Publish through HTTPS to `<bead>-pub`, after a clean leak check and inspection for other private content. The commands, commit identity and local test entrypoint are in `AGENTS.md`.
- Feature PRs keep package versions unchanged. Named releases follow [the release guide](../releases.md).
- The builder merges its own PR using a merge commit after exact-head Hive approval and a green required `test` check from workflow `Test`. Main must require `test`, cover administrators and have no bypass actors; branches need not be up to date. Before each merge, verify classic branch protection and active rulesets through read-only `gh api` calls. If protections or check results cannot be verified, hand back to the queen without merging. Refresh the head and required checks immediately before `gh pr merge <url> --merge --match-head-commit <approved-full-head-sha>`.
- Ordinary delivery closes at verified merge with installation explicitly delegated to configured core extension auto-update. The builder retains the claim and finishes the cell after recording that delegation and its remaining operational obligation. Explicit runtime acceptance stays open for verification.

Record GitHub’s confirmed merge using `kind: "merge"`, the PR `url`, and `merged_head` containing the actual full merged PR head SHA, not the merge commit. Include the merge commit and check verification in `detail`. Hive’s evidence guard requires the head to match the latest approved review; the builder verifies GitHub’s actual merge. The queen does not perform routine Hive merges or prepare feature version bumps.

## Auto-update prerequisites and limits

Core extension auto-update requires a completed restart-survival check on a disposable instance. The installation must be unpinned, opted in, and have core’s update service available in Notify or Auto mode. Capability additions and downgrade confirmation retain their consent gates. Until those prerequisites are met or verified, record the install obligation and ask the queen through `hive_request_input` rather than claiming auto-update is active.

Core installs Hive from main after a merge. The new generation loads at the next supervised core restart; client assets remain with the active generation until activation. Core restarts automatically once nothing is working and waits for in-flight requests and writes before restarting. Busy sessions can delay activation. The queen owns pending installation/activation and may trigger a restart if activation remains pending well after installation; the same in-flight write wait applies. Workers never hand-install Hive, and the queen does not run per-PR install scripts.

This route follows main’s head, not an exact CI-selected SHA, and does not drain interactive workers. A successful install proves disk state; runtime acceptance requires verification of the loaded SHA and active extension. Record the remaining installation/activation obligation and its queen owner when delegating it. Do not claim a running revision without verification.

## Proposal for core repository instructions

Core’s `AGENTS.md` covers public-repository confidentiality, and its `CONTRIBUTING.md` supplies `AW_BROWSER_TESTS=0 npm test` and the prohibition on bare `node --test`. The following delivery facts need a durable home in core’s own instructions rather than queen-written pickup briefs. This is a proposal for core; this Hive change does not edit core’s instructions.

- Require one human approval per PR, tied to its head and supported by review and check evidence. Workers request it through Hive for queen forwarding; queen approval does not replace human approval.
- Name the queen as merger after approval and required repository checks, with upstream maintainers merging where permissions require it. Specify the required checks and permitted merge method in core’s own recipe.
- Name the queen as installation owner: fast-forward the configured checkout, restart the configured instance and verify its running revision. Human merge approval includes this installation/restart. Keep the cell open until verification succeeds.
- Supply the approved publication route and the operational installation details: configured target, commands, revision mapping, success signal, maximum wait and handoff owner. Resolve private configuration with the queen rather than embedding it in public instructions.

Hive’s test command, builder merge authority and extension auto-update delegation do not supply core’s recipe.

## Supporting investigations

- [Holistic review](../investigations/holistic-review.md): rationale for builder merges, repository instructions and core auto-update.
- [Hive release flow](../investigations/hive-release-flow.md): installation, restart and provenance behavior.
- [CI and deploy watching](../investigations/ci-and-deploy-watching.md): merge boundaries, opt-in verification and bounded waits.
