import test from 'node:test';
import assert from 'node:assert/strict';

import { AudioFacade } from '../runtime/AudioFacade';

test('AudioFacade delegates native audio status reads', () => {
  const facade = new AudioFacade({
    getNativeAudioStatus: () => ({ connected: true, backend: 'native' }),
  });

  assert.deepEqual(facade.getNativeAudioStatus(), { connected: true, backend: 'native' });
});
