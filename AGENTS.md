# Repository instructions

This repository (`psjamesh/agent-wrangler-hive`) is **public**. Do not commit absolute home paths, private email addresses, private names or internal details. Use generic examples.

Apply the [Hive worker skill’s delivery defaults](skills/hive-worker/SKILL.md#default-delivery-recipe). This file supplies Hive’s repository settings and overrides.

## Start work

Before starting changes, fetch main through HTTPS:

```sh
git -c credential.helper= -c credential.helper='!gh auth git-credential' fetch https://github.com/psjamesh/agent-wrangler-hive.git main:refs/remotes/origin/main
```

## Checks and commits

Run local tests only through this entrypoint:

```sh
mkdir -p .scratch && echo '{}' > .scratch/package.json && (npm ls zod || npm ci) && TMPDIR=$PWD/.scratch npm test
```

Never launch a browser. Browser tests are opt-in and CI-only.
Feature PRs must not bump the version in `package.json` or `package-lock.json`; named releases follow [the release guide](docs/releases.md).

Commit as `James Hargreaves <101585349+psjamesh@users.noreply.github.com>`, with succinct messages and no co-author lines.

## Publication

Before **every push**, run this leak check and require no output. Adjacent shell quotes keep the pattern from matching this instruction itself:

```sh
git diff origin/main | grep -nE '/''Users/|@''portswigger|james\.hargreaves'
```

Inspect the diff for other private content too. Push the bead branch and open its PR:

```sh
git -c credential.helper= -c credential.helper='!gh auth git-credential' push https://github.com/psjamesh/agent-wrangler-hive.git HEAD:refs/heads/<bead>-pub
gh pr create --repo psjamesh/agent-wrangler-hive --base main --head <bead>-pub
```

## Review and delivery

The **builder merges its own Hive PR** after Hive records approval for the exact full head SHA and the required `test` check from workflow `Test` passes on that head.

Before every merge, use read-only `gh api` calls to inspect main’s classic branch protection and active rulesets. Confirm that `test` is required, administrators are covered and there are no bypass actors; branches need not be up to date. If these protections or check results cannot be verified, hand back to the queen without merging.

Use a merge commit against the approved head, following the worker skill’s final head and check refresh:

```sh
gh pr merge <pr-url> --merge --match-head-commit <approved-full-head-sha>
```

The queen does not perform routine Hive merges or prepare feature version bumps.

## Installation and completion

Installation is delegated to **configured core extension auto-update**. The builder retains its claim through merge and records that delegation before finishing the bead. Workers do not hand-install Hive, and the queen does not run an install script for every PR.

Auto-update requires an unpinned, opted-in installation with core’s update service available in Notify or Auto mode and a disposable-instance restart-survival check completed. Capability additions and downgrade confirmation retain their consent gates. If these prerequisites are unknown or unmet, record the install obligation and ask the queen through `hive_request_input` rather than claiming auto-update is active.

Core installs from main and activates the generation at a supervised core restart once nothing is working, after in-flight requests and writes finish. Busy sessions can delay activation. The queen owns any pending activation and may trigger a restart if it remains pending well after installation. This follows main’s head, not an exact CI-selected SHA, and does not drain interactive workers.

Ordinary work can close after verified merge and recorded installation delegation. Record the remaining installation/activation obligation and its queen owner; do not claim a running revision without verifying it. Explicit runtime acceptance keeps the bead open until the loaded SHA and active extension are verified. Finish your own bead with `hive_finish_bead` only after its acceptance and delivery boundary are met.

Record merge evidence as prescribed by the worker skill; Hive requires `merged_head` to match the latest approved review. See [the delivery policy](docs/design/delivery-policy.md) for Hive’s installation details and the proposal for core’s own instructions.
