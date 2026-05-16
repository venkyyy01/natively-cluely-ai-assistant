import test from 'node:test';
import assert from 'node:assert/strict';

import { SessionTracker } from '../SessionTracker';

const COLD_CEILING_BYTES = 8 * 1024 * 1024; // mirrors COLD_MEMORY_CEILING_BYTES
const HOT_WINDOW_MS = 60_000;

function approxEntryBytes(entries: ReturnType<SessionTracker['getColdState']>): number {
  return entries.reduce((sum, entry) => sum + (entry.sizeBytes ?? 0), 0);
}

test('SessionTracker.getColdState honors COLD_MEMORY_CEILING_BYTES on long sessions', () => {
  const tracker = new SessionTracker();

  // Anchor "now" so every transcript falls outside HOT_WINDOW_MS and lands
  // in the cold tier. The exact timestamp does not matter; only that it is
  // strictly greater than (oldEntry.timestamp + HOT_WINDOW_MS).
  const sessionStart = 1_700_000_000_000;
  const longString = 'x'.repeat(2048); // 2 KiB body per transcript chunk

  // Push 6000 transcript segments. With ~2 KiB of payload each that is
  // ~12 MiB of raw text alone — well over the 8 MiB cold ceiling.
  for (let i = 0; i < 6000; i += 1) {
    tracker.handleTranscript({
      speaker: i % 2 === 0 ? 'interviewer' : 'user',
      text: `${longString}-${i}`,
      timestamp: sessionStart + i, // strictly increasing
      final: true,
    });
  }

  const now = sessionStart + 6000 + HOT_WINDOW_MS + 1; // every entry is cold
  const cold = tracker.getColdState(now);

  // Snapshot must be bounded by the ceiling. Allow one entry's worth of
  // slack because applyMemoryCeiling always retains at least one entry.
  const totalBytes = approxEntryBytes(cold);
  assert.equal(
    totalBytes <= COLD_CEILING_BYTES + 8 * 1024,
    true,
    `cold snapshot ${totalBytes} bytes exceeded ceiling ${COLD_CEILING_BYTES}`,
  );
  assert.equal(cold.length > 0, true);
});

test('SessionTracker.getColdState returns the most recent cold entries when over the ceiling', () => {
  const tracker = new SessionTracker();

  const sessionStart = 1_700_000_000_000;
  const body = 'y'.repeat(4096);

  for (let i = 0; i < 4000; i += 1) {
    tracker.handleTranscript({
      speaker: 'interviewer',
      text: `${body}-${i}`,
      timestamp: sessionStart + i,
      final: true,
    });
  }

  const now = sessionStart + 4000 + HOT_WINDOW_MS + 1;
  const cold = tracker.getColdState(now);

  // applyMemoryCeiling sorts by createdAt descending while filling, then
  // returns ascending. The newest cold entry's timestamp should always
  // appear in the snapshot (latency-wise we keep the closest history).
  const newestKept = cold[cold.length - 1]?.value.timestamp ?? 0;
  assert.equal(newestKept >= sessionStart + 3000, true);
});

test('SessionTracker.getColdState stays empty when no cold-tier entries exist', () => {
  const tracker = new SessionTracker();

  const now = Date.now();
  tracker.handleTranscript({
    speaker: 'interviewer',
    text: 'recent transcript',
    timestamp: now,
    final: true,
  });

  // The transcript above is inside the hot window, so cold should be empty.
  const cold = tracker.getColdState(now);
  assert.equal(cold.length, 0);
});
