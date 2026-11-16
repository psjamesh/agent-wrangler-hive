# Hive Introduction Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Introduce Hive with six pages with real UI captures and a regular hexagonal desktop dialog.

**Architecture:** Separate pure content/edition policy, guarded browser storage and a persistent native modal. Integrate at Hive view entry and expose replay in headers and Settings. A tracked Claude helper owns the disposable server.

**Tech Stack:** Existing JavaScript modules, CSS, native dialog, Node test runner.

**Spec:** docs/design/promo.md, with approved revisions: regular hexagon; Welcome, Map, People, Inbox, Needs you, Delivery; Delivery closes the intro.

## Global Constraints

No version bump or live-instance writes. Codex never launches a browser. The human-approved exception permits the tracked Claude helper to capture only the disposable localhost:65384 instance using headless Chromium with a fresh profile. Use the repository test entrypoint. Demo approval through the queen is required before merge. All six scenes require real actual-UI captures with synthetic data, both themes and a recapture script. Normal desktop windows retain a regular hexagon with a scrollable inner page and fixed footer; only genuinely narrow/tiny viewports use a rectangle.

## Review Focus

Storage denial or future schema must never cause repeated automatic opening.
Replay after downgrade must preserve the newer record.
Deep links and editing must keep priority over onboarding.
Graph refresh and unmount must not dismiss or steal focus.
Desktop scaling must preserve six equal edges; small viewports must remain usable.

### Task 1: Edition policy and geometry

Files: public/promo-content.js, public/promo-policy.js, public/promo-policy.test.js.
Interfaces: promoOffer(raw, manifest) returns eligibility, initial page and changes; createPromoStorage(storage) probes and preserves records; regularHexagon(width) returns points and dimensions.

- [x] Write policy tests covering corrupt/future records, first visit, skip editions, downgrade, storage denial and geometry.
- [x] Run the repository test entrypoint and confirm new tests fail.
- [x] Implement six-page content and policy; verify the suite.

### Task 2: Persistent modal and integration

Files: public/promo-dialog.js, public/client.js, public/settings-view.js, public/hive-view.js, public/cell-view.js, public/styles.css, server/manifest.js, test/promo-dialog.test.mjs.
Interfaces: createPromo controller exposes open, offer, dispose and isOpen; view entry evaluates one offer after rendering, independent of graph refresh.

- [x] Write DOM tests for page navigation, focus, dismissal, unmount, enlargement and guards.
- [x] Run the entrypoint to confirm failures, then implement modal, responsive styles, illustrations and replay.
- [x] Test active-build projection and client entry/deep-link behavior; run the full suite.

### Task 3: Review and disposable demo

- [x] Inspect public diff, leak-check, commit and publish bead PR.
- [ ] Obtain exact-head adversarial Hive review and required CI.
- [ ] Have tracked helper run branch on isolated localhost core instance with synthetic demo hive; send URL and stop command to queen.
- [ ] Hold merge until queen relays human demo approval. Verify protections/checks and approved full head before merging; record installation delegation and finish bead only at delivery boundary.

### Task 4: Correct the rejected demo

- [x] Require the regular hexagon at 1280 × 720 and 1366 × 768; test down to 900 × 600.
- [x] Keep footer and navigation fixed while the inner reading region scrolls; remove overflow-triggered shape switching.
- [x] Have the authorized Claude helper capture twelve real actual-UI scenes with synthetic state and provide a recapture script.
- [x] Inspect every asset and have the helper verify the running promo at ordinary desktop and narrow sizes before requesting another human demo.
- [ ] Obtain fresh exact-head review and CI, then queen-relayed human approval before merge.
