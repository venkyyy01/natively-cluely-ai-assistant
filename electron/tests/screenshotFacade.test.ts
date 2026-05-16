import test from 'node:test';
import assert from 'node:assert/strict';

import { ScreenshotFacade } from '../runtime/ScreenshotFacade';

test('ScreenshotFacade delegates screenshot and queue operations', async () => {
  const calls: string[] = [];

  const facade = new ScreenshotFacade({
    deleteScreenshot: async (path: string) => {
      calls.push(`delete:${path}`);
      return { success: true };
    },
    takeScreenshot: async () => {
      calls.push('take');
      return '/tmp/user-data/screenshot.png';
    },
    takeSelectiveScreenshot: async () => {
      calls.push('takeSelective');
      return '/tmp/user-data/selective.png';
    },
    getImagePreview: async (filepath: string) => {
      calls.push(`preview:${filepath}`);
      return `preview:${filepath}`;
    },
    getView: () => {
      calls.push('view');
      return 'queue';
    },
    getScreenshotQueue: () => {
      calls.push('queue');
      return ['/tmp/user-data/one.png'];
    },
    getExtraScreenshotQueue: () => {
      calls.push('extraQueue');
      return ['/tmp/user-data/two.png'];
    },
    clearQueues: () => {
      calls.push('clear');
    },
  });

  assert.deepEqual(await facade.deleteScreenshot('/tmp/user-data/one.png'), { success: true });
  assert.equal(await facade.takeScreenshot(), '/tmp/user-data/screenshot.png');
  assert.equal(await facade.takeSelectiveScreenshot(), '/tmp/user-data/selective.png');
  assert.equal(await facade.getImagePreview('/tmp/user-data/one.png'), 'preview:/tmp/user-data/one.png');
  assert.equal(facade.getView(), 'queue');
  assert.deepEqual(facade.getScreenshotQueue(), ['/tmp/user-data/one.png']);
  assert.deepEqual(facade.getExtraScreenshotQueue(), ['/tmp/user-data/two.png']);
  facade.clearQueues();

  assert.deepEqual(calls, [
    'delete:/tmp/user-data/one.png',
    'take',
    'takeSelective',
    'preview:/tmp/user-data/one.png',
    'view',
    'queue',
    'extraQueue',
    'clear',
  ]);
});
