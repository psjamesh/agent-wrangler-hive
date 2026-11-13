# Hive for Agent Wrangler

Hive is an experimental [Agent Wrangler](https://github.com/PortSwigger/agent-wrangler) extension for coordinating agents around durable work. Each task can become a hive: a queen session maintains its work graph, workers own individual items, and you steer the work through a hexagonal map and a shared conversation.

Expect changes to workflows and compatibility. Try a throwaway task first and back up your data before updating. Report bugs with versions and a synthetic reproduction that contains no private work data.

## Requirements

- Hive 0.1.93 with Agent Wrangler host API **>=1.71.0 <2.0.0** (`^1.71.0`). Follow the host repository's installation instructions; the API version is separate from its application version.
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
3. Choose **New hive**, give it a name and an optional goal, and select the queen launch. Alternatively, use **Add existing task** to nominate an existing or new queen for a task.
4. Ask the queen to map the work, define acceptance criteria and assign bounded items to workers. The included `hive-queen` and `hive-worker` skills describe the workflow.
5. Select a bead to inspect its summary, evidence and attached sessions. Use the conversation for questions and decisions. Answer native requests with **Answer request** or **Dismiss request**; reading or replying in the conversation does not settle a request.

Drag the background to pan, zoom to inspect the map, and use **Fit** to see everything. Placement is visual only; dependencies are explicit links.

## Features

- **Waiting for you.** A person icon on a bead shows everything waiting on you: live agent input, an unacknowledged Hive message, a Needs You request, or a PR ready for your review. Click it for the actions, and Details lists each wait.
- **Watchdog.** Hive flags stalled workers, stuck reviews, unanswered messages, stale waits, deferred beads that are due and abandoned claims, and sends the queen one digest. Active flags appear in `hive_context`.
- **Withdraw.** Take one of your own messages out of the queen's waiting list without asking for a reply. A withdrawn message is shown as such, and Undo restores it.
- **Retire.** Retire a finished hive with an outcome and summary. You can optionally archive its live sessions, and you can reopen it later.
- **Reviews and PRs.** A queen or worker can request a bound review on a bead. Hive tracks associated PRs and can label them.

## Concepts

- **Hive / cell:** one opted-in Agent Wrangler task with its own goal, conversation and work graph.
- **Queen:** the nominated session that coordinates work and keeps the record coherent. Replacing the queen preserves the record.
- **Bead:** a durable goal, workstream, work item, investigation or decision, with acceptance criteria, status, summary and evidence.
- **Worker and claim:** a session responsible for a bounded bead. A session stopping or going idle does not finish its work.
- **Link:** an explicit dependency or association. Blocking links make work wait; neighbouring hexagons do not imply dependencies.
- **Request:** a tracked question needing a decision or action. Worker requests go privately to the queen until forwarded; a missing or archived queen routes requests to the human.

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

## Licence

Hive is licensed under [Apache-2.0](LICENSE). See the [host contract](docs/host-contract.md) for integration details. Third-party icon notices follow.

## Third-party icons

The robot and person marks reuse the geometry of the `bot` and `user` icons from [Lucide](https://lucide.dev), the same icons Agent Wrangler and its Needs You extension draw. Lucide is distributed under the ISC licence:

> ISC License
>
> Copyright (c) for portions of Lucide are held by Cole Bemis 2013-2022 as part of Feather (MIT). All other copyright (c) for Lucide are held by Lucide Contributors 2022.
>
> Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted, provided that the above copyright notice and this permission notice appear in all copies.
>
> THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
