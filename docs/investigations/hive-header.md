# Hive header proposal

Prefer a two-row header: identity and navigation first, local status and human actions second. Keep global capacity in All hives, give human waits a consistent **Needs you** entry, and leave search and map controls on the map. This makes the header answer three questions in order: where am I, does anything need me, and what is happening?

This is a proposal for discussion, not an approved implementation. It is based on code inspection of main at `e51486624505fa45517f3b8a76410e5f58280f6f` on 15 November 2026. No browser or rendered measurements were used. Widths below are estimates for ordinary desktop fonts, not measured bounds; the mockups are schematic at roughly 1100px and 360–420px of available pane width. A split pane can be narrow on a wide screen.

## Current inventory: one hive

Sources: [cellHeader, queenPill and headProgress](../../public/cell-view.js), [title editor](../../public/cell-settings.js), [capacity](../../public/capacity-control.js), [settings](../../public/settings-view.js), [closed workstreams](../../public/workstream-view.js), [warnings](../../public/widgets.js), and [responsive styles](../../public/styles.css).

| Element | What it tells the human / action | When it matters | Space today (approximate) |
| --- | --- | --- | --- |
| Back button, “All hives”, then `/` | Returns to the hive overview; identifies the parent view. | Every switch between hives. | About 110–130px including separator and gaps. Compact mode hides the words and separator, keeping the arrow and accessible name. |
| Hive title | Names the task/hive; clicking edits its name inline. Snapshot and retired titles are read only. Settings also offers rename. | Identity always; rename occasionally. | Variable, 18px text, minimum 4em normally; ellipsizes. Editing adds input, Save, Cancel, and possibly an error. |
| `Off` or `Retired · outcome` badge | Whether agents can use the hive, or its recorded final outcome. Retirement summary is in the tooltip. No normal “On” badge. | Exceptional lifecycle states; essential before interpreting inactivity. | Roughly 30–160px, depending on outcome. |
| Global capacity control | `N of L in progress` (or `N in progress` when unlimited); opens All hives settings. Counts claimed work, additional open reviews, launches/reservations and helper slots across all hives. Reviews/launches can share a work slot. | When controlling concurrency or diagnosing why new work is not starting. | About 120–160px, plus optional outside-hive count and a full over-limit sentence. The control uses `display: contents`, so notes become separate flex items. |
| Queen pill | Status dot plus `Queen working`, `idle`, `waiting for input`, `stopped`, `archived`, or `not on the board`; opens queen management. Adds brief-delivery failure/unconfirmed text. Missing queen shows setup/launch state; off shows `Queen`; snapshot shows captured time and read-only state. | Management occasionally; failed launch, missing queen and undelivered brief immediately. Routine queen activity is useful orientation. | Usually 90–200px; exceptional text can be substantially wider. Pill does not shrink within the status group. |
| Progress | Small bar and `N of M closed`, or `No work yet`. Tooltip includes active, review, not-active, prerequisite-waiting and open counts. Counts descendants of the root; shown with a root when enabled or retired. | Quick assessment of work size and closure, not an ETA. | Text about 95–130px plus bar and gaps. Can shrink/clip. Closed includes outcomes other than successful completion. |
| `N waiting for you` | Opens the hive's waiting dialog: human-stage Hive requests (including answer-delivery repair), agents currently needing input, and PRs explicitly ready/stuck for human action. Items deduplicate by identity, not bead occurrence. Off/snapshot hives return none. | Highest priority when nonzero. | About 110–150px; may shrink/clip in the shared status group. Absent at zero. |
| `Closed workstreams (N)` | Opens archived workstream history, with show/reopen actions. Only enabled, live hives with archived workstreams show it. | Occasional history/recovery. | About 160–200px. Distinct from all closed beads or Show done. |
| `Turn on` / `Reopen hive…` | Recovery action for off/retired state. | Only in the relevant lifecycle state. | About 75–120px. |
| Cog | Opens the modal, initially This hive for a live local hive, with All hives also available; snapshot opens global settings. Sections hold General, Agents, Lifecycle and Advanced; global sections are General and Advanced. | Occasional configuration. | 18px icon plus button padding, roughly 30px. No Info section. |
| “To reconcile” attention section | Interrupted hive creation, failed/unconfirmed queen launch, or failed/uncertain goal setup, with check/resolve/retry actions. Normal fresh pending operations are suppressed. Scoped to this hive. | Rare, but the human must understand uncertain outcomes before retrying. | Separate, variable-height block under the row; capped at 30vh with scrolling in the hive header. |
| Refresh notice | `Some work could not be refreshed. Showing available work…` when the backend snapshot is incomplete. It is global data-health information even inside one hive. Other operation feedback uses toasts. | Whenever displayed; missing work must not look like no work. | Separate full-width wrapping warning, not a permanent status label. |
| Search and hamburger | Search launcher beside `☰` in the map, **not** the header. Hamburger holds zoom, Show done, Key and Arrange; Resume live updates sits alongside when relevant. Search opens a panel with field, scope in a hive, matches/navigation and hidden-done reveal. | Finding work and adjusting the map. | Two small buttons when closed; controls at bottom right, search panel at top left. Menu opens above its trigger. |

The main row is normally non-wrapping. Title and parts of the state group shrink; the queen pill and most actions do not. Compact mode wraps the row and makes the back button icon-only. Any capacity note also forces wrapping. This means an exceptional capacity message changes the whole layout, and the human-action label competes with routine status. Inline rename temporarily increases the competition.

## Current inventory: All hives

Source: [overview header, map and cellTile](../../public/hive-view.js), plus the shared components above. There is no back/breadcrumb, inline overview-title editor, queen pill, aggregate progress bar, or header-level waiting-for-you button here.

| Element | What it tells the human / action | When it matters | Space today (approximate) |
| --- | --- | --- | --- |
| Honeycomb mark + `All hives` | View identity; mark is decorative. | Orientation. | 18×20px mark, gap, roughly 85px title at 21px. |
| Global capacity | Same global control and notes as inside a hive. | Cross-hive resource decisions; this is its natural scope. | 120–160px plus notes. |
| `N hives, M beads` | Size of the currently shown hive collection and sum of its bead counts (roots excluded). The shown collection changes with Show retired. | Occasional overview context; not a throughput or activity measure. | Roughly 100–150px. |
| `Inbox` toggle | Shows/hides the cross-hive inbox panel. No count on the header button. Present when there are shown hives. | Reading across hives and finding pending conversations. | Roughly 45–65px. |
| `New hive` | Starts creation. | When starting work, not on each visit. | About 85px. |
| `Add existing task` | Opens adoption of a task already on the board. | Occasional setup. | About 120px. |
| Cog | Opens All hives settings: global capacity, backend and notification settings, etc. | Occasional configuration. | Roughly 30px. |
| Refresh notice; attention section | Same incomplete-snapshot warning and reconciliation cases, now across hives. | Exceptional and actionable; may become a large block. | Full-width blocks below header. With inbox open the overview header region is capped at 40vh and scrolls. |
| Short map introduction | `Drag hives to arrange; drag the background to pan.` Empty state instead tells the human to create or add a task. This is inside the map, not in the header. | Learning/empty state. | One 12px text line at the map bottom; can wrap. |
| Search + hamburger | Same paired launchers on map; overview options include Show retired when applicable, plus zoom. Overview search finds hives by name or matching work. | Navigation; adjusting overview. | Small buttons bottom right, lifted above the intro; expanded search at top left. |

The overview header wraps as a flex row, with actions normally pushed right. Below 820px action alignment changes. There is no explicit priority scheme for keeping one action ahead of another as the row wraps.

### Adjacent signals the header must agree with

- **Hive tiles:** name, up to two goal lines, Off/retired/empty-work wording, closed-work progress, and four counters: Inbox, Waiting for queen, Needs you, In progress. Needs you currently uses `requestCounts.human`; In progress uses `occupiedCount`. Zero counters are omitted by the tile renderer. Queen status also supplies a large activity/input mark, text in accessible descriptions/tooltips, and no-queen setup wording. The planned removal of the large queen mark should not remove the local queen-management entry.
- **Work map:** marks locate work activity, review and human waits. A single human wait can appear on several beads. Counts of marked beads therefore cannot be summed to obtain a header action count. Workstream progress and the header closure count summarize overlapping work at different scales.
- **Waiting dialog and Details:** [waiting-model](../../public/waiting-model.js) collects requests, sessions needing input and explicitly actionable PRs. [waiting-view](../../public/waiting-view.js) presents the same items from the header, map or bead Details. This is useful duplication: summary, location, then action.
- **Cross-hive inbox:** [global-inbox](../../public/global-inbox.js) merges unread topics and human-stage Hive requests; filters are Inbox and Waiting for queen. Its Needs you total comes from Hive requests, whereas its Inbox filter count is topics and its top message total is messages. It does not currently collect all agent-input/PR items from the waiting model. Tile unread counts and topic counts need not match numerically.
- **Conversation:** local Topics/Inbox already distinguishes reading from answering. A new header Needs you count should not absorb unread messages, nor messages awaiting the queen. Queen-stage requests remain private to the queen until forwarded.

## What to change and what to preserve

1. **Make scope explicit.** The same phrase “in progress” currently describes global occupied capacity, a tile's occupied count, and work status. Keep the detailed global capacity control on All hives, label it `Capacity: 5/8 used`, and expose its breakdown on activation. Unlimited should read `Capacity: 5 used · unlimited`. Inside a hive, retain a conditional `Global capacity full · 8/8` shortcut when global usage reaches/exceeds the limit; it opens the existing global editor and explains why starts wait. Full does not itself mean the hive has ready work waiting. This preserves diagnosis without a permanent global meter in every local header.
2. **Give human action priority and consistent vocabulary.** Rename `N waiting for you` to `Needs you N`, keep it untruncated when nonzero, and use the same underlying item identities across local header and any future overview aggregate. Preserve the dialog and map marks. A stuck queen belongs in this action model under the pending hive-h34z work; it must not become both a session wait and a second queen issue for the same action. Current counts are not yet interchangeable: aligning them is a prerequisite to presenting them as equal.
3. **Separate reading from action.** Show `Inbox N` on the overview toggle, with N explicitly defined as unread messages and named as such accessibly. Needs you opens a distinct action list, not a filtered unread list. Requests can still be visible in conversation context; showing them there does not add another action to the total. Waiting for queen stays a filter/counter in the inbox, not another header pill.
4. **Keep exceptional states visible.** Off, retired outcome, snapshot/read-only, missing queen, launch failure, brief delivery trouble and incomplete data must survive any compaction. Data-health warnings stay in an inline strip; transient success stays in toasts. Reconciliation gets `To reconcile N` plus an expandable list below the header, initially expanded for a new issue. Do not silently fold these cases into Needs you until every case has an actionable shared item; reconciliation and Needs you counts are not additive today.
5. **Move history to the map's controls.** Put `Closed workstreams (N)…` in the map hamburger, grouped separately from Show done: one opens archived workstream history, the other changes visibility of done beads. It opens the existing history drawer. On non-map/inspector views, keep an equivalent link in Details so history remains reachable. Keep Turn on/Reopen explicit beside the lifecycle state; retain their Settings → Lifecycle routes.
6. **Keep queen management discoverable.** In the recommended layout the local pill stays visible on the second row. Routine status is useful after the overview queen mark is removed. Management popover still contains Send brief, session access and replacement/launch. Queen instructions stay in settings. Avoid another always-visible agent count; map marks and Details already explain agents.
7. **Remove low-value totals from primary navigation.** Move overview hive/bead totals to a muted map caption, explicitly `Shown: N hives · M beads` so Show retired has an intelligible effect. Keep closed/total wording locally; it is a closure ratio across a changing scope, not percent complete, delivered value or a forecast. Do not label all closed work “done”.
8. **Improve access to purpose without another long line.** Offer `Goal` beside the local status summary to open the root's goal and Done when in Details; keep editing in General settings. Overview tiles already show a goal excerpt, but the local header has no direct purpose entry. Long goal text does not belong permanently in the header. This adds an entry point, not a new information panel.

The missing information is mostly **meaning and access**, not more counters: global versus local scope, what each count counts, whether no work is trustworthy, and a direct route to the hive's purpose. Avoid adding a last-refreshed clock to healthy headers; the incomplete-data warning carries the consequential case.

## Alternative A: two rows with visible local status (recommended)

Identity has a stable row; the second row groups local status and action. Global resource management stays in the overview. Brackets indicate controls; `⚙` means Settings; `☰` means Map controls, never Settings. Numbers are illustrative.

Desktop, one hive:

```text
[< All hives] / Release tooling (click to rename)                         [⚙]
[Queen working ▾]  12 of 20 closed [---]  [Goal]              [Needs you 3]
[Global capacity full · 8/8]                          <- only when full/over
[Some work could not be refreshed ...]                <- only on data fault
+-----------------------------------------------------------------------+
| Work map                                   | Conversation / Details   |
|                                            |                         |
|                            [Search] [☰]     |                         |
+-----------------------------------------------------------------------+
```

Desktop, All hives:

```text
All hives   [Capacity: 5/8 used]      [Needs you 7] [Inbox 4] [+ New hive] [⚙]
[To reconcile 1 ▾]                                    <- exception strip
+-----------------------------------------------------------------------+
| Hive tiles (their existing per-hive counters and goal excerpts)         |
|                                                       [Search] [☰]    |
| Shown: 6 hives · 84 beads                                              |
+-----------------------------------------------------------------------+
```

`New hive` becomes a split button: its main action creates a hive, its labelled dropdown offers Add existing task. Both retain clear text. The expanded button is allowed its own row at narrow widths; it must not displace a nonzero Needs you action. The overview Needs you action is a **proposed addition**, contingent on a consistent aggregate model, and opens the same kind of waiting dialog across hives, grouped by hive. The Inbox button still toggles the existing panel.

Narrow, one hive:

```text
[<] Release tooling                 [⚙]
[Needs you 3] [Queen working ▾]
12 of 20 closed [---]  [Goal]
+------------------------------------+
| Work map                           |
|                      [Search] [☰] |
+------------------------------------+
[Conversation] [Details]
```

Narrow, All hives:

```text
All hives                          [⚙]
[Needs you 7] [Inbox 4] [+ New hive ▾]
[Capacity: 5/8 used]
+------------------------------------+
| Hive tiles                         |
|                      [Search] [☰] |
| Shown: 6 hives · 84 beads           |
+------------------------------------+
```

Responsive rule: allocate identity and Settings first, wrap the title up to two lines, then put nonzero Needs you first on the next row. Queen/status and closure may occupy a third line. Never shrink a nonzero action into ellipsis. At narrower-than-example widths controls wrap as whole controls; lifecycle and warning text gets its own line. Title editing gets the full identity row, with Save/Cancel wrapping beneath. Zero Needs you disappears; Inbox remains available at zero without a number. Off/retired badge sits next to title with Turn on/Reopen on its own line if needed; snapshot read-only state stays explicit in the status row. Error strips wrap below these rows rather than being clipped into them.

Trade-off: this spends a predictable extra line versus the best-case current desktop row. It gains a readable title, stable control grouping and a prominent route to action. No routine capacity notes can evict local actions.

## Alternative B: minimal identity header, status in a summary

Keep identity and action alone at the top. Move queen status, purpose, closure and history behind a labelled `Summary` control at the top of Details. On desktop show a one-line summary at the map edge; narrow panes show its opener and exceptions only. All hives keeps capacity beside the map caption, with a header exception shortcut when full. This prioritizes map height and reduces routine monitoring cues.

Desktop:

```text
ONE HIVE
[< All hives] / Release tooling                         [Needs you 3] [⚙]
+-----------------------------------------------------------------------+
| [Summary: Queen working · 12/20 closed ▾]                               |
| Work map                                    | Conversation / Details  |
|                            [Search] [☰]      | [Summary ▾]             |
+-----------------------------------------------------------------------+

ALL HIVES
All hives                      [Needs you 7] [Inbox 4] [+ New hive ▾] [⚙]
+-----------------------------------------------------------------------+
| Hive tiles                                                            |
|                                                       [Search] [☰]    |
| Shown: 6 hives · 84 beads                     [Capacity: 5/8 used]      |
+-----------------------------------------------------------------------+
```

Narrow:

```text
ONE HIVE                         ALL HIVES
[<] Release tooling       [⚙]    All hives                  [⚙]
[Needs you 3] [Summary ▾]        [Needs you 7] [Inbox 4]
+---------------------------+   [+ New hive ▾]
| Map                       |   +----------------------------+
|            [Search] [☰]   |   | Tiles                      |
+---------------------------+   |              [Search] [☰] |
[Conversation] [Details]         | [Capacity: 5/8 used]        |
                                +----------------------------+
```

Summary opens Details and expands queen management, Goal/Done when, closure breakdown and history, with focus restored on close. It is one summary reachable from both map and Details, not two new competing panels. Any queen/setup/brief problem breaks out above the map as an inline action instead of hiding behind Summary. Lifecycle badges, recovery actions and warnings follow A's rules. Search/hamburger remain on-map; the caption wraps above them with reserved space, never underneath them.

Trade-off: saves space when healthy but makes “is the queen working?” an extra action in narrow panes and hides routine closure progress. A map-edge summary also competes with map content and creates a second place to look. Prefer A unless the human values maximum map height over routine status visibility.

## Choices for the human

These are decisions for the proposal's review, not blockers to writing it. No runtime change is authorized by this document.

| Choice | Options | Recommendation and consequence |
| --- | --- | --- |
| Header hierarchy | A: visible local status on a second row; B: minimal header with Summary | **A.** Keeps queen state and closure glanceable, with explicit wrapping rather than accidental clipping. B saves height. |
| Global capacity in a hive | Always show the global meter; show only full/over-limit shortcut locally; show it only in All hives/settings | **Full/over-limit shortcut locally.** Makes scope clear and preserves diagnosis when resource pressure matters; routine adjustment takes navigation or Settings → All hives. |
| What “Needs you” counts | Shared requests + agent input + actionable PRs + stuck-queen recovery; Hive requests only | **Shared action model**, with deduplication and private queen requests excluded. It matches the existing local waiting dialog and planned stuck-queen work. Align tile/inbox semantics before adding the overview total. Do not disguise a count-model change as styling. |
| Overview action access | Separate Needs you and Inbox; single Inbox entry with internal filters | **Separate entries.** Reading is different from acting, and an unread total does not tell the human that work is stuck. A unified panel would save one control but needs an equally visible action badge. |
| Closed workstream history | Keep header button; move to map hamburger with Details fallback | **Move to hamburger + Details.** History is occasional; preserve a named entry distinct from Show done. |
| Purpose access | Add Goal link opening root Details; leave purpose in root selection/settings | **Add Goal.** Cheap access to why the hive exists without showing a permanent paragraph or restoring an Info section. |
| Creating and adopting | Two permanent buttons; New hive split button with Add existing task | **Split button.** Keeps creation direct and adoption discoverable while returning about one button's width. Retaining two buttons is reasonable if adoption is frequent. |

## Implementation boundaries and validation for a later change

Implement the chosen hierarchy separately from any action-count unification. Preserve the cog sections, inline title rename, on-map search/hamburger and top-aligned request dialog. Coordinate with hive-h34z's stuck-queen Needs you semantics and the planned overview queen-mark removal; this proposal does not depend on the large mark remaining.

A later implementation should verify both views at desktop and narrow *pane* widths, long names and inline rename errors, large counts, unlimited/full/over-limit capacity, missing/launching/stopped queens, failed briefs, Off/retired/snapshot states, an open inspector, hidden done work, and simultaneous refresh/reconciliation warnings. Check keyboard access, visible labels for icon controls, focus return and that Needs you never disappears due to truncation. Verify action identities across header, tiles, map and inbox; compare distinct items, not sums of bead badges. Those checks require rendered validation; this code-only investigation does not establish pixel fit or usability outcomes.
