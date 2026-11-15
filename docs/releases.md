# Hive releases

Feature PRs never bump the package version. Keep `package.json`'s `version`, `package-lock.json`'s `version` and `package-lock.json`'s `packages[""].version` unchanged. Dependency versions may change normally. The Release version policy PR check rejects changes to these fields unless the PR has the `release` label; adding or removing that label reruns the check.

## Named releases

For an explicitly planned named release, start a separate release PR and run:

```sh
npm run release -- 0.2.0
npm test
```

Replace `0.2.0` with the intended new version. The command uses `npm version --no-git-tag-version --ignore-scripts`: it updates the package and lockfile versions without creating a commit or tag or invoking version lifecycle scripts. Feature PRs never run this command. Review the diff, commit the release files, and label the PR `release`. Follow the normal review and merge policy. If publishing a tag or GitHub Release, identify the tested release commit exactly; do not move an existing release tag. The command does not push, publish, install or restart Hive.

## Git SHA identifies installations

Core installs and detects extension updates independently of the package version. Source inspection of core commit `2c4998a1ab74433f5f37502c18cb3f73be762455` confirms:

- `server/extensions/install.js`, `readHead`, reads `git rev-parse HEAD`; `lsRemoteHead` resolves the remote SHA. Exact-ref installation verifies the checkout matches its target SHA.
- `server/extensions/provenance.js` stores the installed SHA.
- `server/extensions/update-check.js`, `createExtensionUpdateCheck`, detects an update using `remoteSha !== record.sha`. It does not compare package versions.

Thus different feature commits can retain the same package version and still be installed and detected as updates. Exact-ref pins deliberately block automatic branch-following updates. Installed files and running code are distinct: activation can still require a server restart. See [the release-flow investigation](investigations/hive-release-flow.md) for the install, consent and activation boundaries and linked core sources.
