import test from 'node:test';
import assert from 'node:assert/strict';

import { SessionTracker } from '../SessionTracker';

test('NAT-022: SessionTracker.dispose clears pending compaction timer', async () => {
  const tracker = new SessionTracker();

  tracker.handleTranscript({
    speaker: 'interviewer',
    text: 'Please walk me through your architecture tradeoffs.',
    timestamp: Date.now(),
    final: true,
  });

  assert.ok((tracker as any).compactionTimer, 'expected compaction timer to be scheduled');
  await tracker.dispose();
  assert.equal((tracker as any).compactionTimer, null);
});

test('NAT-022: SessionTracker.dispose rejects pending work as session_disposed', async () => {
  const tracker = new SessionTracker();
  let flushed = false;

  (tracker as any).activeMeetingId = 'meeting-dispose-test';
  (tracker as any).isRestoring = true;
  (tracker as any).writeBuffer = [() => {
    throw new Error('buffered write should be dropped on dispose');
  }];
  (tracker as any).persistence = {
    scheduleSave() {},
    async flushScheduledSave() {
      flushed = true;
    },
    async findByMeeting(): Promise<null> {
      return null;
    },
  };

  await tracker.dispose();

  assert.equal(flushed, true);
  assert.equal((tracker as any).isRestoring, false);
  assert.equal((tracker as any).writeBuffer.length, 0);

  await assert.rejects(
    tracker.restoreFromMeetingId('meeting-dispose-test'),
    /session_disposed/,
  );
});
