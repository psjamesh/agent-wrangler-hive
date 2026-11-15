# Global delivery policy

Accepted design; not yet implemented. The human has set the defaults below to let agents deliver work without repeatedly asking for permission. One global policy applies to every hive, with exact repository, `owner/*` and `*` rules.

## Default flow

Each bead uses its own worktree and branch. The builder commits, pushes that branch (or the approved upstream fork), opens a mandatory PR, and obtains adversarial PR review without asking. It fixes findings and reuses the reviewer for up to **N rounds**, default **2**. If round N still requests changes, it escalates through one Hive request rather than continuing indefinitely or treating the limit as approval.

Once review and repository checks pass, the agent requests human merge approval: **one Hive request per PR**. The request identifies the PR, reviewed change and current head; it authorizes the agent to merge when repository requirements permit. A rule can delegate merge to the queen or allow eligible automatic merge. A repository's maintainers still control merge where the agent lacks permission; an approval cannot grant missing organization rights.

Delivery after merge is already authorized. For ordinary repos, agents monitor the existing CI/CD pipeline and report its outcome. For self-hosted AW core and Hive, the responsible agent installs or fast-forwards the configured checkout, restarts the configured AW instance and verifies the running version/commit. It does **not** request another install or restart approval. A narrower explicit task instruction or a repository-required environment approval remains binding; agents do not invent extra gates.

## Policy, storage and settings

Store a single root `deliveryPolicy` in `<AW_DATA_DIR>/hive/metadata.json`, using the existing metadata store, outside `cells`. It contains a schema version, revision and ordered repository rules. Edit it once in **Hive → Settings → Settings for all hives → Delivery policy** (`public/settings-view.js`). The human can save changes there; queens may propose changes through Hive rather than edit metadata directly. Record who changed the policy and when. This is a coordination contract for agents using the supported UI/tools, not protection against a same-user process rewriting local files.

Reuse the existing Reviewers form's validation and save/error pattern. Reviewer model/provider selection stays in **Settings → This hive → Reviewers** and `cell.reviewPolicy`; delivery rules decide whether review is required and its round limit. A new hive or successor queen simply reads the same global policy. No per-cell policy copies or cross-cell grant negotiation are needed.

| Rule field | Built-in default and `*` rule | Available override |
| --- | --- | --- |
| `workspace` | Own worktree and branch per bead; no direct work on the default branch | Repository-approved isolated checkout procedure where worktrees are unavailable |
| `push` | Commit and push to the bead branch without asking | Approved fork mapping; builder or queen executor |
| `pr` | Required; builder may open without asking | Queen opens instead |
| `review` | Adversarial PR review required; `maxRounds: 2` | Round limit and additional human review if explicitly wanted; reviewer configuration uses existing hive settings |
| `merge` | `human_approval`: one Hive merge request per PR | `queen`, `maintainer`, or `auto` with the checks below; permitted merge method |
| `delivery` | Authorized after merge; monitor existing CI/CD | `self_install` for AW core/Hive, named install/pipeline procedure, or `none` where merge is the handoff boundary |
| `completion` | Delivery verified, or merge/handoff recorded when delivery is `none` | Bead-specific acceptance may require more evidence |

Defaults are real permissions: neither an unmatched repository nor an explicit `*` rule adds a publication approval, push approval or separate install approval. A missing environment/path is a configuration issue to resolve once, not a reason to ask on every delivery. If a repo has no delivery pipeline or applicable install step, report merge as the handoff with `delivery: none`; never claim a deployment that did not happen. The current design-only assignment stops at its committed, reviewed artifact because its brief prohibits publication.

## Repository matching and validation

Each rule has a stable id, explicit host, selector and optional literal target branches (default: the repo's default branch). Match **exact `owner/name` before `owner/*` before `*`** on that host; unmatched repos receive the built-in defaults. Order is display-only: reject duplicate normalized selectors and unsupported glob/regex patterns. Choose the repo winner first. If its branch list excludes the requested branch, use the **built-in defaults**, never a broader matching rule. For an applicable rule, every omitted field also takes its **built-in default**, not a value from `owner/*` or `*`; an exact rule setting only `merge` retains default push, PR and review permissions. The UI previews that same result.

Resolve the assigned checkout, intended PR base and push remote with GitHub metadata; use immutable repository ids to detect accidental replacement/rename and show canonical names. For an upstream contribution, the upstream rule governs and the approved fork is only the push destination. A personal fork's wildcard rule cannot loosen an upstream restriction. Wildcards cover current and future repos in that canonical namespace on the specified host; the editor makes that scope clear. Keep this a normal remote/assignment check, not a separate provenance registration or approval protocol.

Before each public push, check the actual destination visibility, the intended source/diff and staged content for private code, secrets or other material that must not be published. Do not move private organization code into a public personal fork or unrelated repository. Unknown or suspicious destination/source mapping blocks that push for clarification. This leak check also applies to rules that delegate publication. Isolation makes branch commit/push routine; it does not make publishing private content safe.

Safety floors apply regardless of the matching rule:

- Never bypass branch protection, use `--admin`, push directly to the default branch, or force-push a default branch. Use the configured merge method and head matching for agent merges.
- Auto-merge requires **verified, non-empty server-enforced required checks on the actual target branch**, applying to the executing credential without bypass. Inspect classic branch protection and active rules with read-only `gh api` calls; optional green CI is insufficient. Missing/unknown protection, applicable bypass or a repo without strict required checks makes auto unavailable. Do not silently switch to an unapproved merge path. Never enable AW's independent merge-on-pass setting in conflict with this policy.
- Run AW-core tests only with `npm test`, never bare `node --test` (it has wiped live data). Follow each other repo's prescribed test command.
- Keep unrelated changes in their own branches/PRs. Do not create release trains, bundle beads into release PRs or wait for a batch before delivering a merged change.

For auto mode, wait for repository requirements and perform an immediate merge of the expected reviewed head; do not leave native `gh pr merge --auto` armed across later code pushes. If protection/merge-queue behavior cannot be verified, use the rule's human/maintainer path. Detection never changes repository protection or grants authority.

## Reviews, approvals and delivery

Request review through `hive_spawn_worker(bead_id, role: "review", commit, intent)`, record `hive_review_verdict`, and reuse the reviewer via `hive_request_review` after fixes. Initial verdict is round 1. At round N, one escalation presents remaining findings and fixes tried: the human can allow more rounds, explicitly accept the residual findings and approve merge, or stop. Acceptance serves as the merge approval in that same request, subject to repository checks/rights. The limit alone never permits merge.

Hive feature PRs never bump the package version; only named release PRs do so (see [Hive releases](../releases.md)).

Keep release preparation light. A mechanical version bump verified to touch only intended version fields in `package.json`/`package-lock.json` (or named version files), or a clean rebase verified by range-diff, retains **both adversarial review and existing human merge approval**. Record verification and applicable check results, then merge with head matching against the resulting head; do not ask again merely because its SHA changed. Only functional changes, conflict resolutions, uncertain equivalence or changed effective authority reopen review/the existing merge request as applicable. Prefer preparation before the first merge ask. Report reviewer lifecycle limitations instead of pretending a stale verdict covers new code.

Expose the global revision, matched rule, effective flow and next action in both full and bead-scoped `hive_context`, plus that hive's reviewer configuration. Launch briefs name the checkout/branch, upstream/fork mapping and stop point. Queens/workers refresh policy before consequential actions. On a policy edit, re-resolve pending work; only changed effective authority requires refreshing its merge request. An unrelated rule edit or display reorder must not ask the human again. No per-action approval fingerprints, publication provenance protocol or delivery leases are required for normal execution.

Use `hive_request_input` for the merge request, showing PR/head, review/check evidence, mechanical-preparation allowance and authorized delivery. Worker requests route through the queen; her answer is not the human's approval. Rule-delegated queen merge needs no human request. `maintainer` hands off a ready PR and waits for the actual merge. Keep requests per PR by default, without holding ready work to assemble a batch; do not split merge and already-authorized install/restart into separate asks.

After merge, act on the configured delivery procedure promptly and report verification. For AW core, fast-forward/install the configured checkout to the merged revision; for Hive, use the configured extension update/install operation. Restart only the configured AW instance, notify affected sessions and verify its running version/commit. If another update/restart is already in progress, wait for it to finish; no new durable lease system or merge-through-install serialization is introduced. Do not deliberately accumulate merged work for a combined install. If a default-branch updater includes intervening commits, report the actual installed range rather than inventing a one-bead artifact; pinned installation support is useful future work, not a prerequisite or recurring approval gate.

Use existing host notices or pipeline events to resume when checks/delivery change. Without reliable wake-up, record the pending outcome and hand back; do not poll in terminal loops. Record PR/head, review rounds, merge approval or delegation, merge commit and delivery/running-version result as bead evidence. Reconcile an uncertain PR create/merge/update before retrying. A passed installer command alone is not proof of the running version. Complete only the configured delivery boundary and bead acceptance; a stopped session is not completion, and existing claim-ownership rules still apply.

## Worked global rules and migration

These entries illustrate the intended initial configuration; no policy or repository change is made by this document.

| Selector / repo | PR and review | Merge | Delivery |
| --- | --- | --- | --- |
| `*` | Own worktree/branch; commit, push and mandatory PR allowed; adversarial review, N=2 | One human approval request per PR | CI/CD on merge, monitored and reported; `none` if no delivery step exists |
| `psjamesh/*` / `PortSwigger/*` | Same defaults; use the approved fork for upstream contributions | Human approval; org maintainers merge where required | Existing repo pipeline; no invented install target |
| `psjamesh/agent-wrangler-hive` | Builder commits/reviews; queen may prepare version, push publication branch over HTTPS and open PR | Existing queen delegation; checks green and expected-head merge; no automatic eligibility inferred | Extension update/install and AW restart authorized after merge; verify running version/commit; no separate human install request |
| `PortSwigger/agent-wrangler` | Builder pushes approved `psjamesh` fork and opens upstream PR without a new publication question under the human's corrected defaults; `npm test` only | Human merge request; respect upstream maintainer authority | Authorized self-install/fast-forward and restart of configured instance; verify running revision |
| Desktop-style repo without strict required checks | Default commit/push/PR/review flow | Human approval; auto unavailable despite optional green CI | Existing pipeline or configured install allowed after merge, report actual result |
| Burp, large private org repo | Default flow using approved internal/fork route; public-destination leak check; org review/CODEOWNERS still applies | Human/maintainer by default; auto only by explicit rule and verified enforced checks | Existing deploy pipeline and environment gates; monitor rollout, or report merge handoff when user delivery is outside this pipeline |

Migration is a small policy/UI/context change, not a new release system. Seed the built-in defaults and `*` identically, preserve reviewer configurations, and add the exact Hive queen-merge and AW/Hive self-install rules. Resolve configured checkouts/forks and delivery commands from existing practice; clarify only genuine unknowns. Preview effects on in-flight work and update queen/worker skills and launch briefs to consume the global rule instead of older approval-heavy instructions. The queen skill's statement that Hive adds no merge policy must describe this global contract. Supersede contradictory task-memory/brief guidance explicitly; do not retain per-PR upstream-publication or per-install permission gates that the human has replaced. Keep narrower task prohibitions and actual repository access restrictions.

Existing reviews, PRs and merges remain evidence; adopt their observed stage rather than replay actions. Remove stale publication/install approval waits under the corrected defaults, retain needed merge requests and deliver merged work without waiting for a train. This is a design-only change: implementation, pushes and PRs for this bead remain outside its assigned brief.

Before implementation ships, verify precedence/host/fork mapping, omitted-field defaults and non-listed-branch fallback; isolated branches and leak checks; review limits and same-request acceptance/merge; version-only bumps and clean rebases **after human approval without another ask**, versus functional/conflict/authority changes reopening it; one merge request per PR; no bypass/unsafe auto; policy edits during a wait; update/restart verification; and uncertain-action recovery.

## Decisions

The human accepted these on 14 Nov 2026:

1. **Default review budget:** at most N=2 adversarial verdict rounds per PR, configurable per rule. Human escalation at the limit presents unresolved findings; it never silently treats exhaustion as approval.
2. **Initial auto-merge grants:** none. Keep the exact Hive queen delegation and human/maintainer defaults elsewhere; add auto only to repos whose enforced checks and non-bypass execution are verified.
3. **Self-hosted delivery target:** one configured AW instance/checkout and named update/restart procedure for AW core and Hive, with a running-version/commit probe, configured once and reused without per-install requests.
