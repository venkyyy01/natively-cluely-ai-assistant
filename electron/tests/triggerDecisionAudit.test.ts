import test from 'node:test';
import assert from 'node:assert/strict';

import { TriggerAuditLog, type TriggerDecisionAuditEntry } from '../observability/TriggerAuditLog';

test('TriggerAuditLog records structured trigger decisions with reason codes', () => {
  const persisted: string[] = [];
  const log = new TriggerAuditLog({
    persistEnabled: true,
    persistLine: async (line) => {
      persisted.push(line);
    },
  });

  const entry: TriggerDecisionAuditEntry = {
    timestamp: 123,
    utteranceId: 'utterance-7',
    speaker: 'interviewer',
    textSnippet: 'Walk me through the design?',
    reasonCode: 'fired',
    outcome: 'accepted',
    cohort: 'utterance_level',
  };

  log.record(entry);

  assert.deepEqual(log.getEntries(), [entry]);
  assert.equal(persisted.length, 1);
  assert.match(persisted[0], /"reasonCode":"fired"/);
  assert.match(persisted[0], /"utteranceId":"utterance-7"/);
});

test('TriggerAuditLog bounds memory while preserving recent entries', () => {
  const log = new TriggerAuditLog({ maxEntries: 2, persistEnabled: false });

  log.record({ timestamp: 1, speaker: 'interviewer', textSnippet: 'one', reasonCode: 'declined_too_short', outcome: 'declined' });
  log.record({ timestamp: 2, speaker: 'interviewer', textSnippet: 'two', reasonCode: 'declined_no_punctuation', outcome: 'declined' });
  log.record({ timestamp: 3, speaker: 'interviewer', textSnippet: 'three', reasonCode: 'completed', outcome: 'completed' });

  assert.deepEqual(log.getEntries().map((entry) => entry.textSnippet), ['two', 'three']);
});
