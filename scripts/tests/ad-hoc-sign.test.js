const assert = require('node:assert/strict');
const test = require('node:test');

const adHocSign = require('../ad-hoc-sign.js').default;

test('ad-hoc-sign skips non-mac packaging targets even on a macOS host', async () => {
  await assert.doesNotReject(async () => {
    await adHocSign({
      electronPlatformName: 'win32',
      appOutDir: '/tmp/win-unpacked',
      packager: {
        appInfo: {
          productFilename: 'Natively',
        },
        info: {
          projectDir: '/tmp/project',
        },
      },
    });
  });
});
