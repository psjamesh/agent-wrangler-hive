import test from 'node:test';

if (process.env.HIVE_TEST_CDP) await import('./global-inbox.browser.mjs');
else test('merged inbox browser fixtures (set HIVE_TEST_CDP to an isolated Chrome port)', { skip: true }, () => {});
