# Introducing Hive

**Status: proposal for human approval.** This document and the static mockups describe a future feature; they do not enable a promo or change onboarding. Merging this document records the proposal, not approval to implement it.

Hive needs a short, beautiful introduction that answers three questions: what am I looking at, who keeps it current, and when does it need me? A new viewer should leave able to open a hive, select a bead and answer a request. An existing viewer should hear about meaningful additions without repeating the introduction after every release.

## Proposed direction and alternatives

Use a broad, flat-topped hexagon as the desktop tour's silhouette, with six numbered, labelled stops clockwise around its edges. Keep the reading area rectangular inside it: a headline, a short paragraph and one generous image. Honey-coloured edges, quiet background cells and a clear selected stop connect it to Hive's map. The hexagon stays still while its page changes. The screen behind it is dimmed; decorative bees pause while it is open.

Three approaches were considered:

| Approach | Advantage | Cost | Recommendation |
| --- | --- | --- | --- |
| Hexagonal dialog, rectangular inner page | Distinctive Hive identity; six sides give six memorable destinations | Requires a wide-screen layout and a rectangular fallback | **Proposed** |
| Rectangular dialog with a small six-cell navigator | Most space for pictures; simpler responsive layout | The hexagon becomes a minor ornament | Fallback if the silhouette cannot keep screenshots readable |
| Six triangular panels or a rotating 3D hexagon | Strong visual spectacle | Clips copy, shrinks screenshots, complicates reading order and motion | Avoid |

Generic design principles: reuse the application's vocabulary and visual tokens; show one idea per page; keep navigation stable; make replay easy. Avoid a second interactive imitation of the product, permanent seen flags, automatic page advance, and promises that the product does not enforce. All prose and artwork here are original Hive material.

The proposal favours a calm presentation over an animation demo. Real screenshots establish recognition; captions explain the action. No screenshot contains a live control. A small “Demo hive” label makes the synthetic example explicit.

## Static mockups

These SVG files can be opened in an image viewer or viewed directly on GitHub. No server, scripts, browser launch, external fonts or network assets are needed. They are design drawings, **not screenshots of a running instance**. Their UI scenes are schematic placeholders for the captures specified below.

| Page | Mockup |
| --- | --- |
| 1 · Welcome | [Dark](promo/01-welcome-dark.svg), [light](promo/01-welcome-light.svg) |
| 2 · Map | [Dark](promo/02-map-dark.svg) |
| 3 · People | [Dark](promo/03-people-dark.svg) |
| 4 · Needs you | [Dark](promo/04-needs-you-dark.svg), [narrow](promo/04-needs-you-narrow.svg) |
| 5 · Delivery | [Dark](promo/05-delivery-dark.svg) |
| 6 · Start | [Dark](promo/06-start-dark.svg) |

The light and narrow drawings demonstrate the visual system; production captures cover **all six pages in both themes**. The copy below is authoritative if a compact drawing abbreviates it.

## Six pages

Use a single fictional task throughout: **Launch a field guide**. Its goal is “Publish a small guide with searchable chapters.” Beads include “Write chapters”, “Build search”, “Choose the cover” and “Publish the guide”. The queen is “Guide coordinator”; workers are “Writer” and “Search builder”; the reviewer is “Reviewer”. These are demo roles, not real people's names. Do not insert an organisation's work into this fixture.

### 1 · Welcome — Give your work a home

> A hive brings a goal, its agents and their decisions into one place. The queen keeps the work organised while you steer the outcome.

Show All hives with the field-guide cell selected and its goal visible. Caption: “One hive is one Agent Wrangler task, with a shared work record.” The image establishes the outer cell before introducing the smaller beads inside it. Next: **Explore the map**.

### 2 · Map — See the work and what it needs

> Each bead is a piece of work with an owner and a clear finish. Open it for the summary and evidence. Links show what must happen first.

Show the field-guide map with “Build search” selected and Details open. “Publish the guide” waits for “Write chapters” and “Build search” through explicit prerequisite links. Caption: “Select a bead for its record. Nearby hexagons do not imply a dependency.” Use the current UI's actual dependency marks rather than inventing a new legend. Next: **Meet the agents**.

### 3 · People — A queen coordinates. Workers own the work.

> The queen maintains the plan and brings decisions to you. Workers take bounded beads; reviewers examine their results. The record stays with the hive when a session changes.

Show a queen header and selected bead's attached worker and reviewer sessions. Caption: “The owner and attached sessions tell you who is doing what.” A session being idle is not evidence that its bead is finished. No claims about provider choice, fixed costs or guaranteed parallelism belong in the promo. Next: **See what needs you**.

### 4 · Needs you — Step in where it matters

> A person mark points to work waiting on you. Open the request, read the choices and send your answer. The queen handles worker questions first and forwards the ones that need you.

Show “Choose the cover” with a person mark and its forwarded request open. The fictional question is “Which cover should the guide use?” with “Illustrated” and “Typographic” choices. Caption: “Answer request settles the question; a conversation reply alone does not.” Mention in supporting text: “If there is no available queen, requests can come directly to you.” Unread messages and requests are different; do not use an unread dot as a decision badge. This introduces Hive's own waiting surfaces without implying dependency on a separate Needs You extension. Next: **Follow delivery**.

### 5 · Delivery — Follow the result, with evidence

> A bead keeps its review, checks and delivery evidence together. Open the linked pull request or result to inspect it. Work closes when its agreed delivery boundary is met.

Show a selected completed “Build search” bead with review, test and merge evidence, plus “Install delegated” as a separately labelled obligation. Caption: “Reviewed, merged and running are different facts.” This is an example of one repository's delivery agreement, not a universal Hive merge or deployment policy. Do not imply a green check deploys work, or that Hive universally requires or grants merge authority. Next: **Start small**.

### 6 · Start — Start with one clear outcome

> Try a small task. Give the queen a goal and what “done” means, then ask it to map the work. You can adjust the plan together.

Show the existing New hive form, without a fake submission or a preselected model. Supporting checklist: “Open Hive · Complete setup if prompted · Choose New hive or Add existing task · Describe the outcome”. Show the read-only example prompt: “Help me plan a small field guide. Start by clarifying the goal and what done means.” Caption: “The queen launches only when you submit the normal creation form.”

Final action: **Open Hive setup** when setup is incomplete; **New hive…** when ready. Close the promo and navigate to setup or open the existing creation form; neither route initializes a store, creates a task, archives a session or launches an agent. Keep **Close intro** as a quiet alternative. Existing-task adoption remains available through the normal creation UI. Replay is always available from **About Hive** in the overview and cell headers and in Hive Settings.

## Shape, navigation and narrow screens

Desktop target: viewport at least 1200 CSS px wide and 820 high at the viewer's current zoom. Centre a maximum 1120 × 740 CSS px hexagonal silhouette within the viewport, including navigation hit areas. Six stops run clockwise: Welcome at the top, Map upper right, People lower right, Needs you at the bottom, Delivery lower left, Start upper left. Number and label every stop; the active one has an outline, filled marker and “current” accessible state. Completed visits may have a small tick, never a colour-only distinction. Labels and focus rings sit inside the dialog's rectangular hit boundary and outside the decorative clipping path.

The inner page has a maximum width around 720 px. Reserve a consistent image frame and footer row; text is allowed to grow. Back and Next are in a stable footer in ordinary left-to-right order. Page 1 hides Back without moving Next. Close is always reachable at the top right of the dialog's rectangular boundary. Clicking the backdrop does nothing, avoiding accidental dismissal. No swipe, rotation or hover is required. Selecting any stop jumps directly to it; Next and Back follow numeric order, independent of visual position. This is an ordered page navigator, not six product settings.

At smaller widths **or heights**, at browser zoom that no longer meets those dimensions, or when translated content cannot fit, use a rounded rectangular dialog with a small decorative hexagon in the title. No text or pictures are clipped into a polygon. At 320 CSS px wide it has a single content column, a “Page 4 of 6” line and a labelled **Jump to page** select. Back and Next remain visible in the footer; the content region scrolls without covering text. Respect safe-area insets and the software keyboard. At 200–400% zoom this same layout applies. A picture can open in a larger, separately labelled image dialog through **Enlarge example**; it is never necessary for understanding the page.

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

Close intro (the top-right control or footer), Escape and the final action all persist the opened edition, build version and time; merely opening, visiting a page, reloading, switching views or disabling/unmounting Hive does not. Manual replay does not erase older state on entry. On explicit dismissal, re-read storage and preserve a higher known content version and its accompanying build/time; write only when the opened edition is at least as new. Thus replay after a downgrade does not make a previously dismissed edition look new. Use a promo-specific write and read-back check; the existing client `save()` helper swallows errors and cannot establish success. Best-effort local writes cannot promise atomic cross-tab updates; re-read-on-write and the in-memory guard cover ordinary use. If saving fails after opening, close normally, suppress more automatic offers for that tab lifetime, and show a quiet “Dismissal could not be saved on this browser” status. Manual replay still works.

## Screenshots from a disposable instance

The SVG scenes in this PR are intentionally drawn placeholders. Production needs real captures of the **running UI with synthetic state**, not screenshots of these drawings or a viewer's working board. No capture runs as part of this design bead.

The repository prohibits local browser launches and reserves browser tests for opt-in CI. A follow-up **Claude helper** owns the capture work, invoked through Hive on the screenshot bead. It configures and reviews an opt-in CI capture job and downloads its output; it must not launch a browser on this machine. The helper can inspect rendered PNGs without a browser. A local live-dev capture would require an explicit repository-policy exception from the human; it is not the default plan.

### Capture feasibility and repository scope

Require a real disposable core server, not a Hive-side shim that merely imitates one. Before the capture package is ready, a bounded feasibility package must identify and exercise the pinned core's fixture injection seams for sessions, GitHub observations and delivery. The current browser job supplies static core assets only; it does not prove these seams exist. If test-only hooks are missing, the queen creates a separate **core-repository prerequisite** with its own review and delivery contract. Capture waits for that prerequisite's verified delivery; this Hive proposal does not authorize core changes. Prefer existing supported dependency injection, and keep any added hooks inaccessible to production launches.

### Isolated capture contract

1. Start a real disposable Agent Wrangler server **inside the CI job**, on loopback with an ephemeral port and fresh temporary data, config, Beads/Dolt store, extension generation, home and browser profile. Pin compatible public core, Hive and Beads revisions. The existing [.github/workflows/test.yml](../../.github/workflows/test.yml) browser job demonstrates the separate CI environment; its current fixtures are not themselves the full seeded-instance pipeline proposed here.
2. Create only the field-guide fixture through supported host/Hive paths, with deterministic IDs and a fixed clock where supported. Seed genuine Beads hierarchy/links and synthetic conversation, request, evidence and session projection data. Session adapters return fixture statuses; GitHub observations are fixture responses; there are no real agents or network writes. Put those adapters behind a capture-only harness, absent from production entrypoints. Exercise the real UI and read paths; do not paint HTML over a blank board. No secrets, production credentials, shared data paths, real tmux sessions or automatic updates. Refuse a non-temporary data directory or non-loopback target before seeding.
3. Use a readiness endpoint plus explicit fixture assertions, rather than sleep-based timing. Verify expected hive name, bead titles, selected page and current theme before capture. Block non-loopback browser requests, and prevent server subprocesses from invoking real providers, GitHub writes or mail delivery. The fixture produces no real PRs, mail or agent launches.
4. A browser running **only in that opt-in CI job** visits the disposable URL, sets a fixed viewport, freezes decoration/timestamps and captures each named view. Do not capture the host's real board or log in to external services. Use public pinned dependencies without production secrets, including on pull requests.
5. Upload captures and a provenance manifest as CI artifacts; terminate the browser, server and store and remove temporary state on success or failure. The helper inspects all images for unintended content, clipping, misleading state and consistency with captions before proposing selected crops in a PR.

### Shot list

Capture at 1440 × 1000 CSS px, device scale 2, in light and dark. Crop to the relevant UI, keeping readable text and enough surrounding navigation to locate it. The starting target is a 960 × 540 asset displayed around 720 × 405 CSS px; adjust the crop rather than downscaling an entire huge board. Retain full-resolution originals as CI artifacts. Also capture the actual narrow promo at 390 × 844 and 320 × 640 in both themes for QA; these are not replacements for the in-page scene assets.

| Asset stem | Real view and fixture state | Point to preserve |
| --- | --- | --- |
| `welcome` | All hives, field-guide cell selected | Task, goal, hive entry |
| `map` | Cell map + Details, Build search selected | Two explicit prerequisites for Publish the guide |
| `people` | Cell header + bead sessions | Queen, owning worker, reviewer |
| `needs-you` | Choose the cover, forwarded request open | Person mark, choices, Answer request |
| `delivery` | Build search Details + evidence | Review, checks, merge and a separate installation obligation |
| `start` | New hive form, unsubmitted | Name, Goal, Done when; normal launch boundary |

Deliver `public/promo/<stem>-light.webp` and `-dark.webp` with fallback PNG if conversion is unavailable; choose the active theme without a flash of the opposite theme. Alt text/captions ship as ordinary page data. Avoid real repository URLs or machine paths even inside fixture screenshots. Use generic repository labels such as `example/guide` and clearly synthetic IDs. A fixture-only PR link never triggers an external lookup.

### Refresh and ownership

Keep a source manifest next to the fixture: scenario revision, core/Hive/Beads full SHAs, viewport/scale, theme, shot name, selected UI state, caption/alt text and output checksum. Strip image metadata before publication. The screenshot bead's builder owns capture correctness and asset review; its Claude helper runs and inspects the CI capture, and the usual adversarial reviewer checks the final image diff. The queen coordinates capacity and readiness, not manual recurring screenshots.

Refresh affected shots when visible labels, marks, layout, forms or theme tokens change. A PR touching those surfaces must either refresh the affected assets or state why the existing images remain accurate. CI can validate the shot manifest, dimensions, asset pairs and fixture scene assertions; image comparisons are advisory because fonts and rendering vary. A maintainer chooses when visual drift merits new images. Updating images alone does not make the promo reappear. Budget the six theme pairs to roughly 1.5 MB total, load only the current page eagerly, and retain a captioned fallback if an image fails.

## Integration and build split

Implement within Hive's existing client lifecycle and host capabilities. No new provider permissions, dependency on another extension or account system is proposed. A small content/policy module owns the manifest and pure eligibility logic; a separate dialog module owns focus and presentation. Integrate through [public/client.js](../../public/client.js), header rendering, Settings and setup navigation, using [server/manifest.js](../../server/manifest.js) only to expose the active build version. Keep the dialog outside graph-driven page replacement so graph changes cannot destroy it. Close/dispose on Hive unmount without persisting dismissal.

These are proposed bounded implementation beads, **not created or ready to launch**. Human design approval is the prerequisite for all of them.

| Work package | Deliverable and acceptance | Depends on |
| --- | --- | --- |
| A0 · Prove real-instance capture seams | CI proof that pinned core can run with temporary state and inert session/GitHub/delivery adapters; identify any separate core prerequisite and its acceptance before A is ready | Approved design |
| A · Demo fixture and isolated capture | Deterministic disposable AW/Beads server, deny-real-effects adapters, opt-in CI job, twelve scene captures and provenance; Claude helper inspects them | A0 and any delivered core prerequisite |
| B · Promo content and display policy | Six pages, curated epoch manifest, active build version, validated per-viewer record, all display/dismiss/replay rules | Approved design; runs parallel with A0 and A |
| C · Hexagonal dialog and narrow fallback | Desktop/narrow layouts, all six destinations, themed assets, captions, image failure fallback, keyboard/focus/reduced-motion behavior | A and B |
| D · Entry points and acceptance | About Hive, Settings replay, safe initial offer, setup/create routing; CI screenshots and accessibility checks; user-facing docs | C |

Builders may choose module names, exact breakpoints after content-fit checks, crop boundaries and WebP tooling within these contracts. Any change to automatic-show policy, storage scope, final action side effects, page count or the hexagon direction comes back for a product decision.

Implementation verification includes pure policy cases for every display-table row, skip-release changes and downgrade replay; storage failures, corrupt/future schema and competing tabs; DOM focus and dismissal routes; graph refresh/unmount without dismissal; initial deep-link routing; setup/final actions without writes or launches. CI-only browser coverage verifies both themes, six pages, keyboard-only use, Escape/focus restoration, reduced motion, narrow widths and high zoom, forced colours, readable crops and image failures. Manual screen-reader review supplements automated checks. This docs-only PR runs the repository's required local test entrypoint and checks SVG syntax and linked assets; it does not run browser tests locally.

## Open questions for the human

1. **Approve the broad hexagonal silhouette?** Recommended: keep it for spacious screens and use the rectangular sheet whenever content would feel cramped. The simpler alternative keeps only a small hexagonal navigator in a rectangular dialog.
2. **Should meaningful new content open automatically on the next ordinary Hive visit, including a one-time full tour for existing users who have no record?** Recommended: yes, starting at the first changed page, with all close routes remembering the edition. A quieter alternative shows an “Updated intro” badge and waits for a click. Routine releases stay quiet either way.
3. **Is browser-profile scope right for dismissal?** Recommended: use local per-board storage now. Cross-device identity would need a separate host capability and product design.

The queen should present these choices with the mockups. An approval to publish or merge this proposal does not answer these product questions or arm the implementation packages.
