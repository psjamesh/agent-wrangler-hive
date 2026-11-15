export function versionChanges(basePackage, headPackage, baseLock, headLock) {
  return [
    ['package.json version', basePackage.version, headPackage.version],
    ['package-lock.json version', baseLock.version, headLock.version],
    ['package-lock.json packages[""] version', baseLock.packages?.['']?.version, headLock.packages?.['']?.version],
  ].filter(([, before, after]) => before !== after).map(([label]) => label);
}
