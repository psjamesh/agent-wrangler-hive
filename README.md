# Hive for Agent Wrangler

Hive is an experimental [Agent Wrangler](https://github.com/PortSwigger/agent-wrangler) extension for coordinating agents around durable work. Each task can become a hive: a queen session maintains its work graph, workers own individual items, and you steer the work through a hexagonal map and a shared conversation.

Expect changes to workflows and compatibility. Try a throwaway task first and back up your data before updating. Report bugs with versions and a synthetic reproduction that contains no private work data.

## Requirements

- Hive 0.1.100 with Agent Wrangler host API **>=1.80.0 <2.0.0** (`^1.80.0`). Follow the host repository's installation instructions; the API version is separate from its application version.
- **Node.js >=20** and Git.
- [Beads (`bd`)](https://github.com/gastownhall/beads) **>=1.3.4 <1.4.0**, JSON schema 1, with the embedded Dolt engine. Install a compatible release using its installation guide; no separate Dolt server is needed. Check `bd --version` rather than assuming the latest release is compatible.
- Optional: authenticated [GitHub CLI](https://cli.github.com/) for PR tracking and labels. On macOS, `sips` produces conversation image thumbnails; other platforms use a placeholder that opens the original.

## Install

In Agent Wrangler, open **Settings → Extensions → + Add extension → Git URL** and enter:

```text
https://github.com/psjamesh/agent-wrangler-hive.git
```

Installation uses the default branch. Enable Hive after reviewing its requested capabilities.

Hive reads and creates tasks, reads and launches sessions, delivers messages and refreshes the board. It reads session PR links through `links:read`. Its own GitHub CLI integration can create labels and edit eligible PR labels using your GitHub credentials. Review the [host contract](docs/host-contract.md) for exact capabilities and PR behavior.

## Quick start

1. Open **Hive** on the rail. Install a compatible `bd` if prompted, then press **Recheck**. If the server cannot find it, configure **Hive → Settings → bd executable**.
2. Press **Create Hive store**. Hive requires this explicit action before initializing its local Beads workspace.
3. Choose **New hive**, give it a name and an optional goal, and launch a fresh queen. **Add existing task** also launches a fresh queen. Each form offers one optional handover source and **Archive source after handover**, checked by default; clearing the source requests no handover and archives nobody.
4. Ask the queen to map the work, define acceptance criteria and assign bounded items to workers. The included `hive-queen` and `hive-worker` skills describe the workflow.
5. Select a bead to inspect its summary, evidence and attached sessions. Use the conversation for questions and decisions. Answer native requests with **Answer request** or **Dismiss request**; reading or replying in the conversation does not settle a request.

Drag the background to pan, zoom to inspect the map, and use **Fit** to see everything. Placement is visual only; dependencies are explicit links.

## Features

- **Waiting for you.** A person icon on a bead shows everything waiting on you: live agent input, a Hive decision or action request, or a PR ready for your review. Unread queen messages appear in Topics and Inbox. Click it for the actions, and Details lists each wait.
- **Request images.** Attach screenshots to `hive_request_input` with `attachments: [{file: "before.png", alt: "Settings before the change"}]`. Save PNG/JPEG/GIF/WebP files in `attachments_inbox` from `hive_context`: up to four, each at most 5 MB, bare names only. Each caller gets its own `inbox/<sessionId>` directory: identical filenames stay separate, and tools adopt only from the caller’s inbox. Legacy files in the shared `inbox/` are ignored and left untouched. Every requester may attach; stored request images stay private until the queen forwards the request, and open full size from the conversation or request card.
- **Approval versions.** For `kind: "approval"`, `hive_request_input` accepts an optional `subject_pin: {kind: "pr", url: "https://github.com/example/project/pull/1", revision: "<full head SHA>"}` or `{kind: "document", url: "https://example.com/design", revision: "revision-7"}`. The pin is shown with the question and retained on the attributed answer, including negative answers; it does not imply approval was granted. Pins cannot change through dedupe updates. Keep PRs linked to a session or task for core observations. A requester or current queen reports document changes with `hive_observe_request_subject({request_id, revision})`; Document pins can use `path: "docs/design.md"` instead of `url`. Hive does not fetch documents. Fresh observed changes show the original and current revisions on the request and notify the current queen once per change. Queen context retains mismatches under `approval_subject_changes`, including notification delivery status. Merge evidence automatically retains a matching human answer under `human_answer`, with its request ID and original `subject_pin`; `matches_merged_head` is true or false when merge evidence supplies a head, otherwise null. This references the answered head without claiming the answer granted approval or enforcing a new merge gate. Failed or uncertain subject notifications remain in queen context and are not retried automatically for the same queen; a successor queen receives the current mismatch. Answers remain intact and no approval gate is added. Missing observations leave the last known version unchanged; monitoring lasts while the request is retained in native request history.
- **Session links.** Pass `session_id` and an optional `session_label` to `hive_request_input` or `hive_publish` when the human should act in a particular board session. Forwarded requests also link their requester. Markdown `[Open session](#session=<full id>)` links stay in the app in both messages and requests; archived and unknown sessions display as plain text. Watchdog attention includes `session_link` for available sessions, and its digest includes the same link.
- **Idle ready work.** Open, unclaimed, bounded work that is unmarked, held, missing a worker profile or awaiting explicit rearm after a previous worker raises `idle_ready_work` after 15 continuous minutes with free capacity. Configure `idleReadyMinutes` in the hive’s watchdog settings. Deferred work, open prerequisites, reviews, and delivery handoffs are excluded. Investigations can warn too; warnings never authorize a launch or replacement worker. Holding work keeps it visible; defer it with a resume condition or record a wait when it should intentionally stay idle. The queen receives one digest per episode; unresolved flags also count toward the queen-response timeout shown in All hives › Needs you.
- **Watchdog.** Hive flags stalled workers, stuck reviews, unanswered messages, stale waits, deferred beads that are due and abandoned claims, and sends the queen one digest. Active flags appear in `hive_context`. An in-progress holder with an exposed API error flags on the next check. `watchdog_settings.idleMinutes` (default 30, configured in the cell's watchdog settings) controls how long an idle holder can go without a recorded handoff or terminal report; `workerMinutes` controls dormant claims. Open reviews, open input requests from the holder, recorded waits and completion reports in the bead summary, next action or latest evidence suppress idle attention. Recorded waits, open reviews, open input requests and completion reports also suppress API-error attention. Completion reports do not suppress dormant-claim attention. Cells with saved `workerMinutes` inherit that idle threshold until `idleMinutes` is set. Provider failures that the host leaves as plain idle use the idle timeout; see the [host contract](docs/host-contract.md#watchdog-session-signals).
- **Withdraw.** Take one of your own messages out of the queen's waiting list without asking for a reply. A withdrawn message is shown as such, and Undo restores it.
- **Retire.** Retire a finished hive with an outcome and summary. You can optionally archive its live sessions, and you can reopen it later.
- **Reviews and PRs.** A queen or worker can request a bound review on a bead. Hive tracks associated PRs and can label them.

## Concepts

- **Hive / cell:** one opted-in Agent Wrangler task with its own goal, conversation and work graph.
- **Queen:** the freshly launched session that coordinates work and keeps the record coherent. Replacing the queen preserves the record.
- **Bead:** a durable goal, workstream, work item, investigation or decision, with acceptance criteria, status, summary and evidence.
- **Worker and claim:** a session responsible for a bounded bead. A session stopping or going idle does not finish its work.
- **Link:** an explicit dependency or association. Blocking links make work wait; neighbouring hexagons do not imply dependencies.
- **Request:** a tracked question needing a decision or action. Worker requests go privately to the queen until forwarded; a missing or archived queen routes requests to the human.
- **Delegation.** Tracked delegation uses Hive's tools, which claim a bead before launching a session. Hive adds no tool deny list to Claude, Codex or Gemini launches. Sessions they start outside Hive appear under `attention.untracked_descendants` in `hive_context`. A helper, advisor or investigation is its own claimed bead launched with `hive_spawn_worker`; a code review uses `role: "review"` on the work bead. Codex approvals are configured per hive in **Settings → This hive** (see below). `codex_approval` on `hive_spawn_worker` accepts `"on-request"` or `"never"` and is ignored when the resolved agent is not Codex. A retained reviewer keeps its stored launch configuration and rejects `codex_approval`; the hive setting still applies when it resumes.
- **Hive orchestration.** Launch work with `hive_spawn_worker` and reviews with `role: "review"` (`hive_request_review` is its alias). Follow global review and merge requirements using Hive launch mechanisms. Follow Hive archive and handover rules: a closed PR alone does not authorize archiving; archive an ordinary worker after its bead is closed following verified delivery, with no open claims, reviews or remaining obligations, and archive a handover source only when requested by the current launch and its handover requirements are met. Archived workers need a fresh Hive launch after claim reconciliation.
- **Queen handoff.** The current queen calls `hive_handoff_queen` to hand the cell to one Hive-launched successor at a time. The handoff is generation-fenced: if the queen changes meanwhile, the successor is refused before it acts. Workers keep their claims and reviews; the old queen loses queen and coordinator authority, and claims it holds personally are not transferred. The human can launch a replacement queen at any time.

### Settings and hive details

The cog at the top right opens **Settings**. **This hive** contains editable Goal and Done when fields, queen instructions, watchdog thresholds, Codex approvals, reviewers and hive lifecycle actions. **All hives** contains worker capacity, decorative bees, the bd executable and request notifications. On the All hives map and in captured snapshots, settings open directly to **All hives**. Click a hive title to rename its Agent Wrangler task in place: Enter saves and Escape cancels. Click its queen pill for queen status and management. Snapshot and retired hives stay read-only; snapshot board briefs appear in Details.

### Codex approvals

Each hive has a **Codex approvals** selector in **Settings → This hive**:

| Choice | Behavior |
| --- | --- |
| Use my Codex config (default) | Hive adds no policy or approval flag; Agent Wrangler's stored session policy and configured defaults apply. |
| Approve for me | Uses Codex `--approve-for-me` through the extension policy hook. |
| Ask me | Uses approval `on-request`. |
| Never ask | Uses approval `never`. |

The setting applies to Codex queens, workers and reviewers at launch, resume and fork, including existing sessions on their next start. It does not change a running terminal. A session dispatched directly from the board into the hive task receives the hive policy from its next resume, because core assigns its task after the first dispatch. Existing hives with no saved setting use **Use my Codex config**. Sessions outside an enabled hive keep core defaults. A fork inherits its parent's hive policy before its own binding is established; an existing membership takes precedence. If a session belongs to several hives, Hive leaves the policy to core rather than choosing between them.

An explicit hive choice takes precedence over `codex_approval` on `hive_spawn_worker` (or its review alias), as core gives extension policy answers precedence over stored launch settings. With **Use my Codex config**, an explicit `codex_approval` controls that launch and is stored by core for resume and fork; omitting it leaves core/user defaults untouched. Returning to **Use my Codex config** restores that stored policy, including an approval choice saved by an earlier launch. The hook answers the whole policy rather than merging with core's stored sandbox choice: **Ask me** and **Never ask** use core's default workspace-write sandbox, and **Approve for me** implies workspace-write. Agent Wrangler's existing host API requirement `^1.80.0` supports both the policy hook and per-launch approval option.

## Data and evaluation

Data lives under `<AW_DATA_DIR>/hive/`; `AW_DATA_DIR` defaults to `~/.agent-wrangler`.

| Folder or file | Contents |
| --- | --- |
| `beads/` | Local Beads workspace: work, dependencies, claims and evidence. |
| `metadata.json` | Cells, bindings, layout, conversations and request/delivery records. |
| `attachments/` | Conversation image inboxes, originals and thumbnails. |
| `bd-home/` | Isolated home configuration used by `bd`. |

Store creation refuses a Git work tree and does not initialize product repositories. Hive disables Beads usage metrics for its CLI calls. Turning Hive off or uninstalling it retains these folders. Back up the complete data directory, including the Beads workspace, before changing an installation.

For isolated evaluation, run a separate Agent Wrangler instance with a separate `AW_DATA_DIR` (for example `~/hive-sandbox`) and an unused port, following the host's instructions. Install Hive into that instance and use synthetic tasks only.

## Automatic pickup

Enabled hives start ready-marked work automatically, bounded by the global work limit. The queen marks each bounded deliverable with `hive_set_pickup` and an explicit worker profile; the human can also use bead details. Each mark allows one attempt, and failed or uncertain starts require reconciliation and deliberate rearming. See [automatic pickup](docs/automatic-pickup.md) for eligibility, rate guards and recovery.

## Tests

`npm test` runs the fast automated suites in `test/`, `public/` and `server/`. `npm run test:native` runs the native release suites in `test/native/`; run it for changes touching the Beads, `bd` or Dolt integration, or the release and install path. `npm run test:browser` runs the browser fixtures separately. Test data uses temporary directories and honours `TMPDIR`; to keep it inside the checkout, run:

```sh
mkdir -p .scratch
echo '{}' > .scratch/package.json
TMPDIR="$PWD/.scratch" npm test
TMPDIR="$PWD/.scratch" npm run test:native
```

Browser tests are opt-in: set `HIVE_TEST_CHROME` to a Chrome executable and `HIVE_CORE_PUBLIC` to an Agent Wrangler core `public/` directory, then run `npm run test:browser`. The runner starts an isolated headless Chrome debugging port, enables the individual browser gates, and runs each fixture sequentially (including the global inbox through its test wrapper). Screenshots and measurements go under `HIVE_SCREENSHOT_DIR`, defaulting to a temporary directory. Without `HIVE_TEST_CHROME`, browser fixtures skip with a setup message; an explicitly configured browser that cannot start fails the run. The default `npm test` command does not opt into browser coverage.

The Test workflow runs browser coverage on Ubuntu with Chrome and a pinned core renderer checkout. The disposable runner permits unprivileged user namespaces so Chrome's sandbox can start under Ubuntu's AppArmor policy. It fetches Git history for the map-search and UI-polish baseline comparisons, and uploads browser artifacts for diagnosis.

Use the explicit file globs in `npm test`. A bare `node --test` can discover tests in local scratch directories.

The empty `.scratch/package.json` keeps Node's module detection inside scratch fixtures. Native release tests limit Git discovery to their temporary directory so a checkout-local `TMPDIR` does not inherit the source repository. They require compatible `bd` and `dolt` executables; set `HIVE_TEST_BD` and `HIVE_TEST_DOLT` if these are not installed under `/opt/homebrew/bin`. Missing executables produce visible skips. The native suite can take about 13 minutes; CI runs the fast suite without installing the native toolchain.

## Licence

Hive is licensed under [Apache-2.0](LICENSE). See the [host contract](docs/host-contract.md) for integration details. Third-party icon notices follow.

## Third-party icons

The robot, person, review and approved marks reuse the geometry of the `bot`, `user`, `search-check` and `rocket` icons from [Lucide](https://lucide.dev). The robot and person match the icons Agent Wrangler and its Needs You extension draw. Lucide is distributed under the ISC licence:

> ISC License
>
> Copyright (c) for portions of Lucide are held by Cole Bemis 2013-2022 as part of Feather (MIT). All other copyright (c) for Lucide are held by Lucide Contributors 2022.
>
> Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted, provided that the above copyright notice and this permission notice appear in all copies.
>
> THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.

Named releases and the feature-PR version policy are described in [the release guide](docs/releases.md). Feature PRs never bump the package version.
