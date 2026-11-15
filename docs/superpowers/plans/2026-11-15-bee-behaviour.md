# Bee behaviour implementation plan

**Goal:** Deliver the approved global levels 0 Plain, 1 Trails and 2 Acrobatics; default 0.

**Design authority:** Hive bead hive-e8z9 records the human's approved proposal. Each level includes those below it. All hives › General holds the slider beside Number of bees. Reduced motion disables decoration, hidden tabs stop it, and zero bees disables every level. No task-data reads, local browser or version bump. The builder merges after exact-head review and required tests; the queen installs.

**Architecture:** Extend the existing bee Web Animations lifecycle. Precompute paths once per visit. Trails use a bounded set of delayed dots following the same path over two seconds, with decreasing opacity. Acrobatics occasionally inserts one loop into the middle of a flight. Reuse the native slider presentation and persist a separate global setting through the host settings API.

**Approaches:** Delayed Web Animations reuse existing lifecycle and require no frame callbacks. A canvas trail would add a rendering loop; CSS-only paths would duplicate the random curve. Use Web Animations.

## Task 1: Setting and animation

- [x] Add failing tests in `test/bee-behaviour.test.mjs` for default/invalid settings, accessible range, level gating, delayed dotted trails, loop geometry, reduced motion, visibility and cleanup.
- [x] Run the repository test entrypoint and confirm the new tests fail for missing behavior.
- [x] Extend `public/bees.js`, `public/client.js`, `public/settings-view.js`, `public/styles.css` and `server/manifest.js`. Preserve plain flight behavior and quantity settings. Cancel existing flights when behavior changes.
- [x] Cover persistence and scope placement using the client/settings fixtures. Run the full test entrypoint and inspect failures.
- [ ] Commit without a version change, leak-check, publish the bead branch and open its PR.

## Task 2: Review and delivery

- [ ] Obtain exact-head Hive review; fix findings and rerun tests as required.
- [ ] Verify branch protections, exact head and required Test / test result immediately before merging.
- [ ] Record confirmed merge and hand installation to the queen; leave installation acceptance open until verified.

## Review focus

Rapid setting changes and failed saves must preserve the latest intent. Stopping or changing views must cancel every trail animation and remove every dot. Trails must follow the loop path too. Loops must turn continuously without a rotation snap. Max bee count bounds decoration and no frame callback reads map data.

Validation: repository test entrypoint passed with 2,869 passed, four skipped and zero failures. No local browser was launched.
