# Approval subjects implementation plan

**Goal:** Retain the optional exact subject revision on approval requests and their answers; show and report later changes without adding approval gates.

**Architecture:** Extend the native request record with an immutable subject pin and a separately observed current revision. Reuse core PR observations; accept explicit document revision reports from the requester or queen. Keep human and queen answer attribution unchanged.

**Scope:** Existing request lifecycle, tool schemas, request cards and tests. No new connector, version bump, approval enforcement or polling service.

- [x] Add lifecycle tests for pin validation, dedupe immutability, human receipts, observations, queen notification dedupe and permissions.
- [x] Run the repository test entrypoint and confirm the new tests fail.
- [x] Implement optional subject pins and explicit document observation; subscribe to core PR observations and reconcile on recovery.
- [x] Show pinned and current revisions in request cards and answer deliveries; test changed and unchanged states and retained answer controls.
- [ ] Run the full prescribed test entrypoint, inspect public diff, publish PR and request exact-head Hive review.

Review focus: old requests without pins; stale/missing PR observations; repeated and out-of-order observations; queen handover and delivery failures; immutable answered revisions; document reporters lacking request access. A change warning must not alter answers or reopen requests.
