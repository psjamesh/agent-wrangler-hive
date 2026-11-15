# Releasing Hive without a queen-operated deployment

## Recommendation

Remove package-version edits from ordinary Hive PRs. Identify each deployment by its full Git commit SHA, and use a local delivery service, independent of the queen and the Agent Wrangler process it restarts, to deploy an eligible merged commit. Keep SemVer for named public releases, with version changes owned by release automation. Keep the host API compatibility range, dependency lockfile and capability consent checks.

The fundamental problem is the coupling of source publication, replacement of live files, server activation and agent refresh into one manually operated sequence. A version number cannot solve that lifecycle problem. Git installation itself is reasonable for Hive; moving HEAD and replacing a directory still used by the running process are the problematic parts when delivery must be reproducible and low interruption.

This is a read-only investigation of runtime behavior, with a proposed delivery design. It does not implement or authorize a deployment. Evidence baseline: Hive [`c56973b`](https://github.com/psjamesh/agent-wrangler-hive/tree/c56973b4e11c3f443625e68074b216fefe1a87c3) and core [`2c4998a`](https://github.com/PortSwigger/agent-wrangler/tree/2c4998a1ab74433f5f37502c18cb3f73be762455), inspected on 15 November 2026. Core includes [PortSwigger/agent-wrangler#508 (Install extensions at exact commits and report loaded versions)](https://github.com/PortSwigger/agent-wrangler/pull/508).

## How core installs and updates extensions

### Source selection and provenance

The installer accepts HTTPS, SSH and SCP-style Git URLs. It rejects local paths, `file://` and Git's command-executing `ext::` transport. Without an explicit `ref`, it shallow-clones the remote's default branch. An extension can declare an early-adopter branch; an existing installation's separate opt-in selects that branch while it exists, falling back to the default branch when it disappears. Hive currently declares no early-adopter branch.

An explicit `ref` selects a full 40-hex commit SHA or a plain tag. Tags are resolved to commits, including annotated-tag peeling; a name that is both a tag and a branch is refused. Abbreviated SHAs, branch-only names and revision expressions are not exact-install targets. The installer fetches the resolved commit and checks it out detached, verifying the SHA. Pass URL and `ref` separately to core's install operation; npm's URL fragment conventions are not this API.

Core persists `originUrl`, resolved `sha`, optional requested `ref`, installation time, consented capabilities, dependency identities and update preferences in `extensions.json`. **An explicit ref makes the installation pinned.** Built-in automatic updates will not advance it, even if its auto-update preference remains on. Reinstalling without a ref returns it to branch tracking. Update checks can still report that a pinned installation differs from remote HEAD; this is not an offer to track newer tags automatically.

Sources: core [`install.js`](https://github.com/PortSwigger/agent-wrangler/blob/2c4998a1ab74433f5f37502c18cb3f73be762455/server/extensions/install.js), [`provenance.js`](https://github.com/PortSwigger/agent-wrangler/blob/2c4998a1ab74433f5f37502c18cb3f73be762455/server/extensions/provenance.js).

### Consent, compatibility and replacement

Installation has two control frames:

1. `ext-install` clones into a temporary staging directory, reads the static `wranglerExtension` declaration and lockfile, checks host compatibility, and returns a disclosure with the actual SHA. It does not execute the extension or install dependencies at this stage.
2. `ext-consent` either discards staging or runs `npm ci --ignore-scripts --omit=dev`, imports and validates the staged manifest, checks its declared capabilities and host compatibility, then replaces the destination and writes provenance.

A dependency-bearing extension must ship a lockfile. The disclosure includes capabilities, dependency changes and available commit history. Reconsent is triggered by **added capabilities**, not by a new package version or dependency churn. Unchanged or narrowed capabilities permit the automatic path. Downgrades, diverged history and unknown commit relationships require explicit downgrade confirmation. At boot, capabilities outside recorded consent quarantine an extension. These checks disclose trust; extensions and their dependencies run in the server process with its privileges.

The installer serializes installs within the process, holding its lock across disclosure and consent. An abandoned consent can be reclaimed after ten minutes. Compatibility is checked before replacement, but this is not a transactional deployment with rollback: replacement removes the old destination, renames staging into place and subsequently writes provenance. Failures or crashes across these steps need reconciliation. The core checkout's rollback launcher is not a Hive-code/data rollback facility.

A fresh, previously unregistered extension can register and activate immediately. Replacing any registered extension deliberately returns `restartRequired: true`. Its reply includes `installedSha`, `runningSha` and `restartPending`; the extension graph continues to expose installed versus boot-loaded SHA after a board reload. Treat an installed receipt as a disk-state receipt, and check activation separately. For a disabled or quarantined extension, matching SHAs alone do not establish a healthy runtime.

Sources: core [`extensions-install.js`](https://github.com/PortSwigger/agent-wrangler/blob/2c4998a1ab74433f5f37502c18cb3f73be762455/server/control/handlers/extensions-install.js), [`external.js`](https://github.com/PortSwigger/agent-wrangler/blob/2c4998a1ab74433f5f37502c18cb3f73be762455/server/extensions/external.js), [`extensions/index.js`](https://github.com/PortSwigger/agent-wrangler/blob/2c4998a1ab74433f5f37502c18cb3f73be762455/server/extensions/index.js).

### Update detection and existing automation

Manual checks compare the recorded installed SHA with `git ls-remote` HEAD, or the selected early-adopter branch. Background checks additionally count commits behind. **No package-version comparison participates.** A docs-only commit can therefore appear as an update. A different remote SHA means different history, not necessarily a newer release.

Core already has an unattended path: the installation must opt into extension auto-update, the global update mode must be Notify or Auto, and the core update service must be available. The scheduled check defaults to hourly. In either of those modes, an opted-in, unpinned extension can be installed automatically through the same staging/consent handlers when no new consent or downgrade confirmation is needed. There is no GitHub CI, PR approval, tag or release-eligibility check. The check observes a remote SHA, but automatic installation clones the branch again and may get a later HEAD.

Successful automatic installs are queued for one supervised restart. Core retries its quietness test every minute while blocked. Here, “quiet” means no headless runs, no launch in flight and no schedule due within two minutes. It **does not mean all interactive workers are idle, no MCP writes are in flight, or Hive has finished its queued Beads operations**. A manual board restart has no such quietness test. The normal restart exits Node after a 250 ms acknowledgement window; it is not a drain protocol.

The background extension check is nested under the availability of core's updater: its tick returns before extension checking for an unavailable core updater, including package-managed core installs. Supervision alone provides restart support, not this entire automatic path. A manual install without restart also does not add itself to the automatic install's in-memory restart queue.

Sources: core [`update-check.js`](https://github.com/PortSwigger/agent-wrangler/blob/2c4998a1ab74433f5f37502c18cb3f73be762455/server/extensions/update-check.js), [`update-service.js`](https://github.com/PortSwigger/agent-wrangler/blob/2c4998a1ab74433f5f37502c18cb3f73be762455/server/update-service.js), [`index.js`](https://github.com/PortSwigger/agent-wrangler/blob/2c4998a1ab74433f5f37502c18cb3f73be762455/server/index.js).

## Why restart, and what survives it?

### Reloading the extension

The server uses Node ES modules. Removing hooks, tools and contributions cannot unload an imported module or undo arbitrary top-level listeners and timers. Cache-busting only the entry module does not establish clean lifetime control over the complete dependency graph. Core therefore keeps the old registered runtime until restart. Manifest validation also imports the consented staged module inside the live process; extensions must avoid import-time side effects even before activation.

A client-only change could, in principle, be delivered through new asset URLs and a page reload without restarting Node, provided its server contract and manifest remain unchanged. Core has no supported differential update path for this: every replacement of a registered extension asks for a server restart. The browser loader detects changed asset URLs for an already-mounted extension and reloads the page; it deliberately avoids mounting another version beside the old listeners and DOM. A server-side hot swap would require controlled module isolation, lifecycle disposal, operation draining and state transfer. Running extension code in a replaceable child process is a possible longer-term architecture, but substantially more work than fixing delivery.

There is also a concrete consistency gap: replacing `extensions/hive` changes the files served by `/ext/hive/` immediately, while the server manifest and runtime still describe the old SHA. Assets use a SHA query for browser identity, but the HTTP route ignores the query and reads the current directory. A newly opened tab can therefore fetch new client files against the old server before restart. Lazy server imports or file reads can have the same class of problem. This is an inference from the replacement and serving code, not a reproduced incident. Immutable directories per SHA with an active-generation pointer would remove this overlap and retain a rollback target.

Sources: core [`extensions/index.js`](https://github.com/PortSwigger/agent-wrangler/blob/2c4998a1ab74433f5f37502c18cb3f73be762455/server/extensions/index.js), [`http-handler.js`](https://github.com/PortSwigger/agent-wrangler/blob/2c4998a1ab74433f5f37502c18cb3f73be762455/server/http-handler.js), [`public/extensions.js`](https://github.com/PortSwigger/agent-wrangler/blob/2c4998a1ab74433f5f37502c18cb3f73be762455/public/extensions.js).

### Preserving workers

An ordinary server restart does not call session teardown. Agents run in separate tmux panes, and core reloads mappings, discovers living panes and adopts session context on startup. Session tokens are persisted, and the session API tries to rebind its saved port. MCP uses a per-request, stateless HTTP transport. These mechanisms support surviving workers without creating replacement agents.

That is **process survival, not uninterrupted service**. Browser terminals and HTTP/MCP connections drop while Node is absent. An in-flight tool call can fail after its write succeeded, leaving an uncertain outcome. A port conflict can make the restarted API select another port, stranding existing client URLs. Supervisor behavior also matters: the shipped systemd example does not override cgroup kill behavior, so a service stop/restart must not be assumed to preserve all descendants. Validate the actual supervisor and tmux ownership on each supported platform; a server self-exit and a supervisor stop command are different operations.

Tools, launch permissions and skills are also separate from loaded server code. Agents can retain launch-time or cached schemas and instructions. Core fingerprints extension tool schemas and adds a refresh note on resume. Its optional automatic idle-session refresh compares **core's** `codeVersion`; an extension-only restart leaves that unchanged and does not by itself trigger that mechanism. Added or incompatible tools and changed launch instructions need an explicit client refresh or a deliberate resume at a safe boundary. Resuming an existing card kills and relaunches its owned pane, so it must not be forced on a busy worker.

Hive stores claims, bindings, launch records and operation receipts durably. Its startup recovery observes unfinished operations and fences uncertainty; automatic pickup does not blindly replay unknown launches. Keep the same worker identity and claim when its pane survives. If a client cannot reconnect, checkpoint and resume that card. If it really died, reconcile its launch/claim and uncertain actions before a coordinator authorizes a replacement. Never infer from a restart alone that a claim should be released or another worker launched.

Sources: core [`session-manager.js`](https://github.com/PortSwigger/agent-wrangler/blob/2c4998a1ab74433f5f37502c18cb3f73be762455/server/session-manager.js), [`session-api/index.js`](https://github.com/PortSwigger/agent-wrangler/blob/2c4998a1ab74433f5f37502c18cb3f73be762455/server/session-api/index.js), [`session-api/tokens.js`](https://github.com/PortSwigger/agent-wrangler/blob/2c4998a1ab74433f5f37502c18cb3f73be762455/server/session-api/tokens.js), [`mcp/server.js`](https://github.com/PortSwigger/agent-wrangler/blob/2c4998a1ab74433f5f37502c18cb3f73be762455/server/mcp/server.js), [`session-refresh.js`](https://github.com/PortSwigger/agent-wrangler/blob/2c4998a1ab74433f5f37502c18cb3f73be762455/server/session-refresh.js), [`systemd example`](https://github.com/PortSwigger/agent-wrangler/blob/2c4998a1ab74433f5f37502c18cb3f73be762455/scripts/agent-wrangler.service.example); Hive [`runtime.js`](https://github.com/psjamesh/agent-wrangler-hive/blob/c56973b4e11c3f443625e68074b216fefe1a87c3/server/runtime.js), [`recovery.js`](https://github.com/psjamesh/agent-wrangler-hive/blob/c56973b4e11c3f443625e68074b216fefe1a87c3/server/recovery.js), [`workers.js`](https://github.com/psjamesh/agent-wrangler-hive/blob/c56973b4e11c3f443625e68074b216fefe1a87c3/server/workers.js).

## What Hive's package version actually controls

| Identifier | Current use | Release consequence |
| --- | --- | --- |
| `package.json` version, currently `0.1.152` | Package metadata, repeated at the lockfile root and root package entry; README carries a separate compatibility example | Keep these fields consistent when making a named release; ordinary Git deployments can share that version and differ by SHA |
| `wranglerExtension.engines.wranglerApi` and manifest `engines.wranglerApi`, both `^1.80.0` | Admission to the host API, meaning `>=1.80.0 <2.0.0` | Change when required host APIs change; unrelated to the Hive package version |
| Provenance installed/running SHA and optional ref | Core update detection, deployment receipts and client entry-asset identity | Use the full SHA as deployment identity |
| Manifest `version` | Optional core extension field used for telemetry attribution | Hive currently omits it; core does not derive it automatically from Hive's package version |
| Metadata schema, layout revision, Beads version/schema, pickup `nativeVersion` | Persisted-data compatibility, cache invalidation or a bead's native modification receipt | Separate contracts; none requires a Hive patch bump for each PR |

Hive is marked `private: true` and is installed from Git, not published to npm. Inspection found no Hive runtime consumer of its package version and no CI assertion that each PR increments it. Git history contains separate “Bump version” commits; that demonstrates release practice, rather than a technical requirement. The only workflow installs locked dependencies and runs the fast suite on PRs and pushes to main. It does not release, tag, install or restart Hive. Native suites are separate and are not run by that workflow.

Thus the versioning **practice is too strict for this delivery model**. SemVer itself does not require every PR to edit one shared number. Its immutable-release principle still matters: once a numbered release is published, do not reuse that number for another numbered release. For a development channel, show both the last named version and deployed SHA so nobody mistakes the shared package label for an exact build identity.

Sources: Hive [`package.json`](https://github.com/psjamesh/agent-wrangler-hive/blob/c56973b4e11c3f443625e68074b216fefe1a87c3/package.json), [`package-lock.json`](https://github.com/psjamesh/agent-wrangler-hive/blob/c56973b4e11c3f443625e68074b216fefe1a87c3/package-lock.json), [`manifest.js`](https://github.com/psjamesh/agent-wrangler-hive/blob/c56973b4e11c3f443625e68074b216fefe1a87c3/server/manifest.js), [`test workflow`](https://github.com/psjamesh/agent-wrangler-hive/blob/c56973b4e11c3f443625e68074b216fefe1a87c3/.github/workflows/test.yml), [`host contract`](../host-contract.md); [SemVer specification](https://semver.org/).

## Common release models

There is no single de facto release mechanism across registries and Git-installed plugins. The common separation is development changes, release identity and installation. Registry consumers resolve package versions; Git consumers can resolve exact commits. npm itself supports commit-ish, tagged SemVer and default-branch Git dependencies, although core implements its own narrower installer. See [npm's Git dependency documentation](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/#git-urls-as-dependencies).

| Model | Where the version changes | Fit for Hive |
| --- | --- | --- |
| Changesets with release automation | Feature PRs add independent change descriptions; automation maintains a release PR that owns package versions and changelogs, then publishes | Good for deliberate public releases and multiple packages; removes shared version edits from feature PRs but adds a release-PR boundary |
| semantic-release | CI determines the next SemVer from commit conventions, generates notes and publishes/tags after successful builds; plugins choose whether version files are committed | Good for automated numbered releases; needs commit discipline. Git installs need an explicit plan for any generated version file to exist in the tagged source |
| Tags and GitHub Releases | A release tag identifies the source commit; a GitHub Release adds notes/assets | Good stable milestones and rollback selection. Core can install a tag but does not discover the newest release/tag or follow a SemVer range |
| Continuous delivery of green main commits | No shared version-file edit per change; a full SHA identifies each deployment | Best for Hive's actively developed installation. Requires a deployer to select a tested commit and verify its activation |
| Calendar versioning | Release automation assigns a date-based version, with a counter or patch component if needed | Useful when release date/support window matters; changing the numbering scheme alone fixes neither shared-file conflicts nor activation interruptions |

Primary references: [Changesets action](https://github.com/changesets/action), [semantic-release introduction](https://semantic-release.org/intro/), [GitHub Releases](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases), [CalVer](https://calver.org/). These establish available practices, not a claim about their relative market share.

For Hive, use continuous SHA-based delivery now and optional SemVer milestones for wider consumers. If release files are desired, let one release workflow or release PR update `package.json` and both lockfile version fields once per named release, test that resulting source and tag that exact commit. Do not attach a version to a different, untested follow-up commit or use a moving tag as immutable provenance. Changesets is a reasonable later choice; it is not needed merely to remove the current conflict.

## A delivery flow independent of the queen

### Ownership and eligibility

The builder owns implementation and the PR. Existing human/delegated merge policy and required reviews remain authoritative. A GitHub merge queue or authorized merger can merge an approved, green PR; automating deployment does not grant new merge authority. Feature PRs do not bump package versions. Independent PRs do not wait for a release train.

CI validates the actual resulting main commit, including applicable native integration tests for Beads/install changes. A PR's green head is not proof that a different merge SHA was tested. On successful main CI, publish a small deployment intent containing repository, full target SHA, eligible check results and release classification. A compatible docs-only change can finish at the repository boundary without restarting the runtime; define that boundary explicitly in delivery policy.

A local service consumes those intents and runs outside both Hive and the AW process. Hosted CI should identify eligible source; it should not need an unrestricted shell or inbound access to the developer's machine. The service has a configured repository/instance and uses the same install validation and consent semantics as core. It reconciles durable desired, installed and running SHA receipts after its own restart. One instance has one active deployment; newer intents remain visible rather than racing replacements.

### Install, activate and verify

1. **Select:** validate the exact eligible SHA and existing approval evidence. Persist target and prior running SHA before effects. A later commit must earn its own eligibility; never replace the requested SHA with whatever HEAD now names.
2. **Prepare:** stage and disclose that exact SHA through `ext-install`. Reuse dependency locking, compatibility and capability checks. Within preauthorized policy, unchanged-capability forward updates proceed automatically; added capabilities or an unsafe history relationship surface one actionable request through the existing approval channel. Never silently answer a new trust question. The current two-frame control handlers provide the mechanics, but a durable supported deployment entry point and its policy integration are still work to build. Do not hold a consent staging token across an unbounded approval or drain wait; restage and revalidate if necessary.
3. **Quiesce:** pause new launches/pickup and mutating requests, allow in-flight MCP/Hive/Beads operations to settle, and wait for an idle boundary for any agent that must reload its tool contract. Apply a bounded deadline: leave the target visibly pending when it expires. Do not force-kill working agents. With the current installer, drain before final `ext-consent`, which combines dependency installation, manifest validation and destination replacement. A better prepare/commit API would complete expensive validation in an isolated generation before the drain window.
4. **Activate:** complete consented installation and immediately request a supervised server self-restart that preserves tmux, not a blanket session restart. Immutable generation storage is the stronger fix for serving consistent assets across activation. The external service observes shutdown/startup and continues verification even though the initiating connection disappears. Compatible workers keep their panes and claims; the service accounts for actual surviving sessions rather than assuming survival.
5. **Verify:** require healthy core and Hive activation, compatible/ready Beads state, `installedSha == runningSha == target`, no quarantine and cleared restart-pending state. Check the session API is reachable at the expected endpoint and representative existing workers can call it. Record deployment evidence against the PR/bead. A passed installer command is insufficient.
6. **Recover:** on failed activation, stop further rollout, preserve diagnostics and use the retained prior exact commit for code rollback. Confirm data compatibility before rolling back; code rollback cannot undo an incompatible store migration. Reconcile ambiguous writes/launches from durable receipts before retrying. Resume affected existing cards only at a safe boundary, and authorize fresh workers only after proving their predecessors stopped and settling ownership.

Steps 3–6 need lifecycle work in core and a delivery owner; they are recommendations, not features already provided by the current quietness check. Restart quiescence should cover requests and stores, not require every interactive worker to stop doing unrelated computation. For a tool/skill-breaking release, wait for affected clients' safe boundaries or retain a compatible transition contract. Extension generation/schema identity must participate in client refresh independently of core's code version.

Exact installation leaves a pin, so this design's service must explicitly advance that pin for each eligible deployment. Do not also enable the built-in branch-following updater for the same installation and expect it to advance pins. A same-target retry first observes installed/running state; lost acknowledgements must not cause repeated installs or worker launches. Report what actually ran if a newer eligible target supersedes pending work; do not claim an intermediate SHA ran when it did not. Process ready work promptly, without deliberately accumulating a batch.

### A smaller interim option

The lowest-effort supported automation is core's existing per-extension auto-update, with global Notify mode, a compatible supervised Git-checkout host and an unpinned Hive install. It already eliminates routine consent clicks and queen-operated restarts for capability-compatible updates. Select this only if following default-branch HEAD, accepting its existing quietness test and tolerating service interruptions are acceptable. It does not meet exact-green-commit delivery or full operation-drain requirements.

A bounded bridge is a designated delivery worker that uses exact install, requests restart and reports verified running SHA under existing authorization. That removes the queen as the operator but retains agent-liveness and reconnect risks; it is not the durable service above. Neither interim approach requires per-PR package bumps. Neither provides safe server hot reload.

## Delivery acceptance before relying on automation

Verify these against a disposable instance and synthetic stores, rather than testing by restarting active workers:

- Two approved PRs merge close together: the intended tested SHAs are recorded; no version-file conflict or moving-HEAD substitution occurs; no false activation receipt is issued.
- Initial consent, added capability, incompatible host and downgrade cases stop at their actual gates; ordinary compatible updates require no queen interaction.
- Replacement/activation failure and controller crash recover without losing the previous generation or replaying uncertain install/write/launch actions. Data migrations have explicit compatibility/restore rules.
- A working tmux worker survives the selected restart path on each supported supervisor, retains its session/token/claim and successfully calls MCP after recovery. An in-flight write with a lost response is reconciled rather than duplicated.
- Changed tools/skills reach affected clients at safe boundaries during an extension-only deployment. Unchanged core SHA does not suppress their refresh, and a busy worker is never resumed automatically.
- New and existing board tabs receive assets matching the active server generation. No test relies solely on the installed SHA while old code still runs.

The investigation establishes code paths and gaps through source inspection and release-tool documentation. It does not claim these restart experiments have run. The recommended implementation order is: remove the per-PR bump convention; delegate delivery under existing policy with exact SHA receipts; add durable CI-driven delivery plus draining and generation-safe activation; then consider client-only delivery or process-isolated reload if restart cost still justifies it.
