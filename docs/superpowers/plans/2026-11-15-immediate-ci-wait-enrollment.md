# Immediate CI wait enrollment

A claimant must be able to register a wait immediately after linking a PR or recording PR evidence on its bead. Exact canonical GitHub PR URLs establish the expected repository; arbitrary URLs and other sessions' links do not establish an association. Existing node identity and head checks continue to govern observations.

- Add regression tests in `test/ci-waits.test.mjs` for session links, bead PR evidence, unrelated URLs and invalid requests without enrollment side effects.
- In `server/ci-waits.js`, validate the complete wait before enrolling a missing association. Preserve existing PR identity and other associations, then persist the wait before reading core observations.
- Preserve associations when discovery promotes evidence/search records to session links, and cover registration followed by discovery in regression tests.
- Document registration and the continued requirement to link PRs for core observation. Run the prescribed test entrypoint, request exact-head Hive review, and merge only after all delivery gates pass. Hand installation back to the queen.
