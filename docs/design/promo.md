# Introducing Hive

**Status: approved introduction design.** The implementation uses six pages in the order Welcome, Map, People, Inbox, Needs you and Delivery. Real captures of the running Hive UI illustrate a fictional hive. The capture uses isolated temporary data and a throwaway browser profile. A disposable dev-server demo requires human approval before merge.

Hive needs a short, beautiful introduction that answers three questions: what am I looking at, who keeps it current, and when does it need me? A new viewer should leave able to open a hive, select a bead and answer a request. An existing viewer should hear about meaningful additions without repeating the introduction after every release.

## Proposed direction and alternatives

Use a regular, flat-topped hexagon as the desktop tour's silhouette, with six numbered, labelled stops clockwise around its edges. Keep the reading area rectangular inside it: a headline, a short paragraph and one generous image. Honey-coloured edges, quiet background cells and a clear selected stop connect it to Hive's map. The hexagon stays still while its page changes. The screen behind it is dimmed; decorative bees pause while it is open.

Three approaches were considered:

| Approach | Advantage | Cost | Recommendation |
| --- | --- | --- | --- |
| Hexagonal dialog, rectangular inner page | Distinctive Hive identity; six sides give six memorable destinations | Requires a wide-screen layout and a rectangular fallback | **Selected** |
| Rectangular dialog with a small six-cell navigator | Most space for pictures; simpler responsive layout | The hexagon becomes a minor ornament | Fallback if the silhouette cannot keep screenshots readable |
| Six triangular panels or a rotating 3D hexagon | Strong visual spectacle | Clips copy, shrinks screenshots, complicates reading order and motion | Avoid |

Generic design principles: reuse the application's vocabulary and visual tokens; show one idea per page; keep navigation stable; make replay easy. Avoid a second interactive imitation of the product, permanent seen flags, automatic page advance, and promises that the product does not enforce. All prose and artwork here are original Hive material.

The proposal favours a calm presentation over an animation demo. Real screenshots establish recognition; captions explain the action. No screenshot contains a live control. A small “Demo hive” label makes the synthetic example explicit.

## Static mockups

These SVG files can be opened in an image viewer or viewed directly on GitHub. No server, scripts, browser launch, external fonts or network assets are needed. They are design drawings, **not screenshots of a running instance**. Their UI scenes are schematic placeholders for the captures specified below.

| Concept drawing | Mockup |
| --- | --- |
| 1 · Welcome | [Dark](promo/01-welcome-dark.svg), [light](promo/01-welcome-light.svg) |
| 2 · Map | [Dark](promo/02-map-dark.svg) |
| 3 · People | [Dark](promo/03-people-dark.svg) |
| Needs you | [Dark](promo/04-needs-you-dark.svg), [narrow](promo/04-needs-you-narrow.svg) |
| Delivery | [Dark](promo/05-delivery-dark.svg) |
| Intro artwork | [Inbox](../../public/promo/inbox.png) |

The static mockups are concept drawings. The running intro follows the page order and regular geometry specified below; the drawings are not renderings of the final implementation. Production captures cover **all six pages in both themes**. The copy below is authoritative.

## Six pages

Use a single fictional task throughout: **Launch a field guide**. Its goal is “Publish a printed and online field guide to local wildflowers, with a launch event, by the end of spring.” Beads include “Write chapters”, “Build search”, “Choose the cover” and “Publish the guide”. The queen is “Guide coordinator”; workers are “Writer” and “Search builder”; the reviewer is “Reviewer”. These are demo roles, not real people's names. Do not insert an organisation's work into this fixture.

### 1 · Welcome — Give your work a home

> A hive brings a goal, its agents and their decisions into one place. The queen keeps the work organised while you steer the outcome.

Show All hives with the field-guide cell selected and its goal visible. Caption: “One hive is one Agent Wrangler task, with a shared work record.” The image establishes the outer cell before introducing the smaller beads inside it. Next: **Explore the map**.

### 2 · Map — See the work and what it needs

> Each bead is a piece of work with an owner and a clear finish. Open it for the summary and evidence. Links show what must happen first.

Show the field-guide map with “Build search” selected and Details open. “Publish the guide” waits for “Write chapters” and “Build search” through explicit prerequisite links. Caption: “Select a bead for its record. Nearby hexagons do not imply a dependency.” Use the current UI's actual dependency marks rather than inventing a new legend. Next: **Meet the agents**.

### 3 · People — A queen coordinates. Workers own the work.

> The queen maintains the plan and brings decisions to you. Workers take bounded beads; reviewers examine their results. The record stays with the hive when a session changes.

Show a queen header and selected bead's attached worker and reviewer sessions. Caption: “The owner and attached sessions tell you who is doing what.” A session being idle is not evidence that its bead is finished. No claims about provider choice, fixed costs or guaranteed parallelism belong in the promo. Next: **Visit the inbox**.

### 4 · Inbox — Keep the conversation with the work

> The inbox brings Hive conversations together. Open a topic to read the context, follow a linked bead and reply to the queen. Unread messages and requests waiting on you are different things.

Show a demo inbox with a field-guide topic, a linked Plan the launch event bead and a conversation reply. Caption: “Read and reply in context. Use Answer request when a decision needs your answer.” Next: **See what needs you**.

### 5 · Needs you — Step in where it matters

> A person mark points to work waiting on you. Open the request, read the choices and send your answer. The queen handles worker questions first and forwards the ones that need you.

Show “Choose the cover” with a person mark and its forwarded request open. The fictional question is “Which cover should the guide use?” with “Meadow”, “Hedgerow” and “Foxglove” choices. Caption: “Answer request settles the question; a conversation reply alone does not.” Mention in supporting text: “If there is no available queen, requests can come directly to you.” Unread messages and requests are different; do not use an unread dot as a decision badge. This introduces Hive's own waiting surfaces without implying dependency on a separate Needs You extension. Next: **Follow delivery**.

### 6 · Delivery — Follow the result, with evidence

> A bead keeps its review, checks and delivery evidence together. Open the linked pull request or result to inspect it. Work closes when its agreed delivery boundary is met.

Show a selected completed “Build search” bead with review, test and merge evidence, plus “Install delegated” as a separately labelled obligation. Caption: “Reviewed, merged and running are different facts.” This is an example of one repository's delivery agreement, not a universal Hive merge or deployment policy. Do not imply a green check deploys work, or that Hive universally requires or grants merge authority. Final action: **Close intro**.

The final action is **Close intro**. Closing returns to the current Hive view without creating a task, initializing a store or launching an agent. Replay is available from **About Hive** in the overview, setup and cell headers, and in Hive Settings.

## Shape, navigation and narrow screens

Desktop layout: viewport at least 900 CSS px wide and 600 high at the viewer's current zoom. A regular hexagon is required at 1280 × 720 and 1366 × 768. Centre a regular hexagon, at most 1080 CSS px wide, within the viewport. Its height is width × √3 / 2: every edge is half its width, with six 120° internal angles. Six stops run clockwise: Welcome at the top, Map upper right, People lower right, Inbox at the bottom, Needs you lower left, Delivery upper left. Number and label every stop; the active one has an outline, filled marker and “current” accessible state. Completed visits may have a small tick, never a colour-only distinction. Labels and focus rings sit inside the dialog's rectangular hit boundary and outside the decorative clipping path.

The inner page has a maximum width around 720 px. The inner reading region scrolls when text or pictures need more room. The navigation and footer remain fixed and visible; content overflow never switches the shape to a rectangle. Back and Next are in a stable footer in ordinary left-to-right order. Page 1 hides Back without moving Next. Close sits inside the intro header, with another Close action in the fixed footer. The image caption remains visible outside the scrollable reading region. Clicking the backdrop does nothing, avoiding accidental dismissal. No swipe, rotation or hover is required. Selecting any stop jumps directly to it; Next and Back follow numeric order, independent of visual position. This is an ordered page navigator, not six product settings.

At genuinely narrow widths or tiny heights (below 900 × 600 CSS px), including browser zoom that no longer meets those dimensions, use a rounded rectangular dialog with a small decorative hexagon in the title. No text or pictures are clipped into a polygon. At 320 CSS px wide it has a single content column, a “Page 4 of 6” line and a labelled **Jump to page** select. Back and Next remain visible in the footer; the content region scrolls without covering text. Respect safe-area insets and the software keyboard. At 200–400% zoom this same layout applies. A picture can open in a larger, separately labelled image dialog through **Enlarge example**; it is never necessary for understanding the page.

## Appearance and accessibility

Use host font, background, foreground, surface, border and accent variables plus Hive's existing honey tokens. Honour the host's current light/dark theme, including theme changes while the tour is open. Use illustrations only as atmospheric borders; keep screenshot colours truthful. Verify 4.5:1 contrast for normal text and 3:1 for meaningful controls/focus indicators in both themes and forced colours. Amber highlights need a dark ink label in light mode.

Use one labelled modal dialog with a visible title. Keep its accessible name “Introducing Hive”; the changing page has its own heading. Trap Tab/Shift+Tab within it, make the background inert and restore focus to About Hive (or the Hive heading if the opener disappeared) on close. Escape closes and counts as dismissal. Set initial focus on the page heading with temporary `tabindex=-1`; give an automatic opening the same predictable focus as a manual one.

Represent the desktop stops as a labelled navigation region containing an ordered list of buttons, one per page, with `aria-current="step"` on the current button. All are reachable by Tab; Enter/Space selects. They are not ARIA tabs, so no tablist arrow-key contract is implied. Do not capture Left/Right globally: keys continue working in selects, inputs and assistive technology. Back/Next moves focus to the new page heading; a stop button keeps focus after selection and a polite status announces “Map, page 2 of 6”. Narrow select changes use that same status. Only the active page is in the accessibility tree and tab order.

Every screenshot has concise, scene-specific alt text and an adjacent HTML caption explaining its point. For example: “Build search selected in a demo map; Publish the guide waits for two prerequisites.” Long descriptions live in the page text, not in a microscopic annotation. Decorative SVGs are hidden from assistive technology. The production promo's text remains selectable HTML, never baked into an image.

No autoplay or timed reading. An optional 120 ms opacity transition respects `prefers-reduced-motion`; reduced motion and forced colours get immediate page changes with no bee animation. Inactive content owns no timers or live regions. Dispose the dialog and its listeners on unmount; a graph update must not reset its page, steal focus or record a dismissal.

## When it opens and what dismissal remembers

### Per-viewer scope

Use Hive's host-provided `api.storage`, already used for client preferences in [public/client.js](../../public/client.js). Its scope is this board origin and browser profile, not an authenticated person or an entire installation. Two people sharing a browser profile share the record; another browser/device starts fresh. No dismissal is stored in a cell, Beads, queen context, global extension settings or a server-side user record. No telemetry is added.

Proposed key: `promoState`. Store a JSON string with this schema (values below are illustrative):

```json
{
  "schema": 1,
  "dismissedContentVersion": 2,
  "dismissedHiveVersion": "0.1.200",
  "dismissedAt": "2026-12-01T12:00:00.000Z"
}
```

`dismissedAt` is the viewer's clock, for explanation only. The Hive version is the **active extension build**, not the installed-on-disk candidate or `bd` version. Expose that build's package version in the Hive projection as part of the implementation, and pin a promo opening to its content/build versions. If unavailable, write `dismissedHiveVersion: null`; never fabricate it. The content version alone controls eligibility.

### Content epochs, not release numbers

Ship a small static manifest with positive integer `contentVersion`, the six stable page IDs, and a curated change list. Each change records the content epoch, page ID and a short human-written headline. Begin at epoch 1. Increment only for a new capability worth showing again, following an editorial decision in its PR. Screenshot refreshes, typo fixes, package releases and release automation do not increment it. A change of storage schema is a separate migration, not a new promo edition.

“New since your last intro” means manifest changes with epoch **greater than** `dismissedContentVersion` and **at most** the opened edition. Skip-release viewers see the union, in page order. Mark those pages “New”; open at the first changed page, show a short digest, and retain access to all six pages. If a valid manifest has a higher epoch but no page-level change records (bad editorial metadata), open Welcome with a general “The Hive introduction has been updated” line rather than fail. Never derive newness from semantic-version comparison, timestamps, the latest GitHub release or private work data.

### Display policy

| Situation | Behaviour |
| --- | --- |
| First deliberate visit to the Hive rail; no valid record | Open Welcome once the view is mounted and stable; explain that it is a demo |
| Dismissed epoch equals active content epoch | Stay quiet; About Hive always replays |
| Active content epoch exceeds dismissed epoch | Open the first changed page at the next deliberate Hive visit |
| Downgrade; dismissed epoch is newer | Stay quiet; never reduce the saved epoch on replay |
| Malformed data in known schema | Treat as unseen; repair only on explicit dismissal |
| Unknown future storage schema | Keep it intact; suppress automatic opening and allow manual replay |
| Storage absent, throws, or cannot round-trip a harmless probe key | Manual replay only; do not reopen after every page load |
| Browser profile/data cleared | First-visit behaviour returns |
| Opened from a bead, message, session or request deep link | Serve that destination first; defer automatic promo to the next ordinary visit |
| Another dialog, text edit or active drag is underway | Defer until the next ordinary visit; do not seize focus when it ends |
| Host starts or Hive updates while the viewer is elsewhere | No dialog, toast or global notification |

Evaluate automatic eligibility once per deliberate Hive view entry, not every graph refresh or window focus. Hold an in-memory “offered this entry” flag. Read storage again just before opening, and observe cross-tab dismissal when available. Another tab's dismissal suppresses a pending offer; it does not forcibly close a dialog already being read. Simultaneous offers in two tabs are acceptable; no lease or server coordination is proposed.

Close intro (the header control or footer), Escape and the final action all persist the opened edition, build version and time; merely opening, visiting a page, reloading, switching views or disabling/unmounting Hive does not. Manual replay does not erase older state on entry. On explicit dismissal, re-read storage and preserve a higher known content version and its accompanying build/time; write only when the opened edition is at least as new. Thus replay after a downgrade does not make a previously dismissed edition look new. Use a promo-specific write and read-back check; the existing client `save()` helper swallows errors and cannot establish success. Best-effort local writes cannot promise atomic cross-tab updates; re-read-on-write and the in-memory guard cover ordinary use. If saving fails after opening, close normally, suppress more automatic offers for that tab lifetime, and show a quiet “Dismissal could not be saved on this browser” status. Manual replay still works.

## Screenshots from a disposable instance

The introduction uses real captures of the **running UI with synthetic state**. The SVG concept drawings above describe the design; they are not used as product screenshots. Captures never use the viewer's working board.

The human approved a bead-specific exception for a tracked Claude helper to take these captures locally through the browser-testing skill. It uses headless Chromium with a fresh temporary profile and may connect only to the isolated demo instance on localhost:65384. It never accesses the human's Chrome profile, tabs or live board on port 7777. The Codex builder does not launch a browser. CI capture remains a future route; this exception does not change the repository's general browser policy.

### Capture feasibility and repository scope

Require a real disposable core server, not a Hive-side shim that merely imitates one. Before the capture package is ready, a bounded feasibility package must identify and exercise the pinned core's fixture injection seams for sessions, GitHub observations and delivery. The current browser job supplies static core assets only; it does not prove these seams exist. If test-only hooks are missing, the queen creates a separate **core-repository prerequisite** with its own review and delivery contract. Capture waits for that prerequisite's verified delivery; this Hive proposal does not authorize core changes. Prefer existing supported dependency injection, and keep any added hooks inaccessible to production launches.

### Isolated capture contract

1. Start a real disposable Agent Wrangler server **inside the capture harness**, on loopback on port 65384 for the approved local run, with fresh temporary data, config, Beads/Dolt store, extension generation, home and browser profile. Pin compatible public core, Hive and Beads revisions. The existing [.github/workflows/test.yml](../../.github/workflows/test.yml) browser job demonstrates the separate CI environment; its current fixtures are not themselves the full seeded-instance pipeline proposed here.
2. Create only the field-guide fixture through supported host/Hive paths, with deterministic IDs and a fixed clock where supported. Seed genuine Beads hierarchy/links and synthetic conversation, request, evidence and session projection data. Session adapters return fixture statuses; GitHub observations are fixture responses; there are no real agents or network writes. Put those adapters behind a capture-only harness, absent from production entrypoints. Exercise the real UI and read paths; do not paint HTML over a blank board. No secrets, production credentials, shared data paths, real tmux sessions or automatic updates. Refuse a non-temporary data directory or non-loopback target before seeding.
3. Use a readiness endpoint plus explicit fixture assertions, rather than sleep-based timing. Verify expected hive name, bead titles, selected page and current theme before capture. Block non-loopback browser requests, and prevent server subprocesses from invoking real providers, GitHub writes or mail delivery. The fixture produces no real PRs, mail or agent launches.
4. The authorized helper’s headless browser visits the disposable URL, sets a fixed viewport, freezes decoration/timestamps and captures each named view. Do not capture the host's real board or log in to external services. Use public pinned dependencies without production secrets, including on pull requests.
5. Save captures and a provenance manifest; terminate the browser, server and store and remove temporary state on success or failure. The helper inspects all images for unintended content, clipping, misleading state and consistency with captions before proposing selected crops in a PR.

### Shot list

The local harness captures at 1120 × 630 CSS px, device scale 1.3, in light and dark. The Needs you scene uses 1318 × 741 at scale 1.105 to keep the question, choices and Send row visible. Crop to the relevant UI, keeping readable text and enough surrounding navigation to locate it. The 1456 × 819 assets preserve the source UI; adjust the crop rather than downscaling an entire huge board. Retain full-resolution originals in the capture output directory. Also capture the actual narrow promo at 390 × 844 and 320 × 640 in both themes for QA; these are not replacements for the in-page scene assets.

| Asset stem | Real view and fixture state | Point to preserve |
| --- | --- | --- |
| `welcome` | All hives, field-guide cell selected | Task, goal, hive entry |
| `map` | Cell map + Details, Build search selected | Two explicit prerequisites for Publish the guide |
| `people` | Cell header + bead sessions | Queen, owning worker, reviewer |
| `needs-you` | Choose the cover, forwarded request open | Person mark, choices, Answer request |
| `delivery` | Build search Details + evidence | Review, checks, merge and a separate installation obligation |
| `inbox` | Inbox with a field-guide topic open | Context, linked bead and reply |

Deliver `public/promo/<stem>.png` and `<stem>-light.png`; choose the active theme without a flash of the opposite theme. Alt text/captions ship as ordinary page data. Avoid real repository URLs or machine paths even inside fixture screenshots. Use generic repository labels such as `example/guide` and clearly synthetic IDs. A fixture-only PR link never triggers an external lookup.

### Refresh and ownership

The repeatable harness is [scripts/capture-promo.mjs](../../scripts/capture-promo.mjs). Its fixture and isolation setup live in [scripts/capture-promo/](../../scripts/capture-promo/). Only the authorized Claude helper runs the local browser capture.

Keep a source manifest next to the fixture: scenario revision, core/Hive/Beads full SHAs, viewport/scale, theme, shot name, selected UI state, caption/alt text and output checksum. Strip image metadata before publication. The screenshot bead's builder owns capture correctness and asset review; its Claude helper runs and inspects the capture, and the usual adversarial reviewer checks the final image diff. The queen coordinates capacity and readiness, not manual recurring screenshots.

Refresh affected shots when visible labels, marks, layout, forms or theme tokens change. A PR touching those surfaces must either refresh the affected assets or state why the existing images remain accurate. CI can validate the shot manifest, dimensions, asset pairs and fixture scene assertions; image comparisons are advisory because fonts and rendering vary. A maintainer chooses when visual drift merits new images. Updating images alone does not make the promo reappear. The six theme pairs total about 2.9 MiB to preserve readable UI text; load only the current page eagerly, and retain a captioned fallback if an image fails.

## Integration and verification

The introduction uses the existing client lifecycle and host storage. `public/promo-content.js` defines the pages and edition manifest. `public/promo-policy.js` owns eligibility, guarded storage and regular hexagon geometry. `public/promo-dialog.js` owns the native modal and focus. `server/manifest.js` exposes the executing extension build version in the Hive projection. The modal remains outside graph-driven page replacement and unmount disposes it without recording dismissal.

Node tests cover editions, denied storage, competing tabs, downgrade replay, equal edge lengths, page navigation, focus restoration, dismissal, enlargement and view-entry guards. CI-only browser coverage exercises the six pages in both themes, regular rendered geometry, responsive layouts, reduced motion and Escape. Existing browser fixtures explicitly remember a dismissed intro when testing other features. Screen-reader review supplements automated checks.

The implementation requires actual-UI captures for all six scenes and a repeatable recapture script. Refreshing imagery alone does not change the content edition. The development demo uses a separate core process, temporary data and a fictional seeded hive; it never uses the live board or launches demo agents.
