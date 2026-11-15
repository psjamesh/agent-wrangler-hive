# Hive Introduction Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Introduce Hive with six illustrated pages and a regular hexagonal desktop dialog.

**Architecture:** Separate pure content/edition policy, guarded browser storage and a persistent native modal. Integrate at Hive view entry and expose replay in headers and Settings. A tracked Claude helper owns the disposable server.

**Tech Stack:** Existing JavaScript modules, CSS, native dialog, Node test runner.

**Spec:** docs/design/promo.md, with approved revisions: regular hexagon; Welcome, Map, People, Inbox, Needs you, Delivery; Delivery closes the intro.

## Global Constraints

No version bump, local browser, live-instance writes or new dependencies. Use the repository test entrypoint. Demo approval through the queen is required before merge. Drawn example art is sufficient; real captures are separate work.

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

- [ ] Inspect public diff, leak-check, commit and publish bead PR.
- [ ] Obtain exact-head adversarial Hive review and required CI.
- [ ] Have tracked helper run branch on isolated localhost core instance with synthetic demo hive; send URL and stop command to queen.
- [ ] Hold merge until queen relays human demo approval. Verify protections/checks and approved full head before merging; record installation delegation and finish bead only at delivery boundary.
