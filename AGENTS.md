# Repository instructions

This repository (`psjamesh/agent-wrangler-hive`) is **public**. Do not commit absolute home paths, private email addresses, private names or internal details. Use generic examples.

## Checks and commits

Run local tests only through this entrypoint:

```sh
mkdir -p .scratch && echo '{}' > .scratch/package.json && (npm ls zod || npm ci) && TMPDIR=$PWD/.scratch npm test
```

Never launch a browser. Browser tests are opt-in and CI-only.
Feature PRs must not bump the version in `package.json` or `package-lock.json`; named releases follow [the release guide](docs/releases.md).

Commit as `James Hargreaves <101585349+psjamesh@users.noreply.github.com>`, with succinct messages and no co-author lines.

## Publication

Fetch main through HTTPS:

```sh
git -c credential.helper= -c credential.helper='!gh auth git-credential' fetch https://github.com/psjamesh/agent-wrangler-hive.git main:refs/remotes/origin/main
```

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

Request adversarial review through `hive_spawn_worker` with `role: "review"` and the full head SHA. Fix findings and reuse the reviewer for up to two rounds; if round two still requests changes, ask the queen through `hive_request_input`. The round limit never grants approval.

Follow [the delivery policy](docs/design/delivery-policy.md), including its rollout gates and narrower task stop points. The builder merges only after exact-head Hive approval, the required `test` check from workflow `Test`, and verification of the prescribed protections. If those gates cannot be verified, hand back to the queen. Refresh head and checks immediately before merging; use a merge commit with `--match-head-commit`, never bypass protections. Record merge and any required installation/runtime evidence before closing the bead.
