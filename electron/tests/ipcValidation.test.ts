import test from 'node:test';
import assert from 'node:assert/strict';
import { ipcSchemas, parseIpcInput } from '../ipcValidation';

test('gemini chat args validation accepts bounded valid payload', () => {
  const parsed = parseIpcInput(
    ipcSchemas.geminiChatArgs,
    ['hello', ['a.png'], 'ctx', { skipSystemPrompt: true }],
    'gemini-chat',
  );

  assert.equal(parsed[0], 'hello');
  assert.equal(parsed[1]?.[0], 'a.png');
  assert.equal(parsed[2], 'ctx');
  assert.equal(parsed[3]?.skipSystemPrompt, true);
});

test('follow-up email validation rejects malformed meeting type', () => {
  assert.throws(() => {
    parseIpcInput(
      ipcSchemas.followUpEmailInput,
      { meeting_type: 'weird', title: 't' },
      'generate-followup-email',
    );
  }, /Invalid IPC payload/);
});

test('ipc schemas validate additional accepted shapes', () => {
  const provider = parseIpcInput(
    ipcSchemas.customProvider,
    {
      id: 'provider-1',
      name: 'Provider 1',
      curlCommand: 'curl https://example.com -d "{{TEXT}}"',
      responsePath: 'choices[0].message.content',
    },
    'save-custom-provider',
  );
  assert.equal(provider.id, 'provider-1');

  const transcript = parseIpcInput(
    ipcSchemas.transcriptEntries,
    [{ text: 'hello' }, { text: 'world' }],
    'transcript-entries',
  );
  assert.equal(transcript.length, 2);

  const mailto = parseIpcInput(
    ipcSchemas.openMailtoInput,
    { to: 'test@example.com', subject: 'hello', body: 'body' },
    'open-mailto',
  );
  assert.equal(mailto.to, 'test@example.com');
});

test('parseIpcInput reports joined zod issue paths', () => {
  assert.throws(() => {
    parseIpcInput(
      ipcSchemas.customProvider,
      {
        id: 'provider-1',
        name: 'Provider 1',
        curlCommand: 'curl https://example.com -d "{{TEXT}}"',
      },
      'save-custom-provider',
    );
  }, /responsePath: Required/);

  assert.throws(() => {
    parseIpcInput(ipcSchemas.openMailtoInput, null, 'open-mailto');
  }, /root:/);
});

test('generate suggestion args validation accepts bounded valid payload', () => {
  const parsed = parseIpcInput(
    ipcSchemas.generateSuggestionArgs,
    ['context', 'last question'],
    'generate-suggestion',
  );

  assert.deepEqual(parsed, ['context', 'last question']);
});

test('overlay opacity validation rejects non-finite values', () => {
  assert.throws(() => {
    parseIpcInput(ipcSchemas.overlayOpacity, Number.NaN, 'set-overlay-opacity');
  }, /Invalid IPC payload/);
});

test('settings, profile, and rag validation schemas accept bounded payloads', () => {
  assert.equal(parseIpcInput(ipcSchemas.disguiseMode, 'activity', 'set-disguise'), 'activity');
  assert.equal(parseIpcInput(ipcSchemas.profileFilePath, '/tmp/resume.pdf', 'profile:upload-resume'), '/tmp/resume.pdf');
  assert.equal(parseIpcInput(ipcSchemas.profileCompanyName, 'Acme', 'profile:research-company'), 'Acme');

  assert.deepEqual(
    parseIpcInput(ipcSchemas.ragMeetingQuery, { meetingId: 'meeting-1', query: 'summarize blockers' }, 'rag:query-meeting'),
    { meetingId: 'meeting-1', query: 'summarize blockers' },
  );
  assert.deepEqual(
    parseIpcInput(ipcSchemas.ragCancelQuery, { global: true }, 'rag:cancel-query'),
    { global: true },
  );
});

test('settings, profile, and rag validation schemas reject malformed payloads', () => {
  assert.throws(() => {
    parseIpcInput(ipcSchemas.disguiseMode, 'spaceship', 'set-disguise');
  }, /Invalid IPC payload/);

  assert.throws(() => {
    parseIpcInput(ipcSchemas.profileFilePath, '   ', 'profile:upload-resume');
  }, /Invalid IPC payload/);

  assert.throws(() => {
    parseIpcInput(ipcSchemas.ragMeetingQuery, { meetingId: '', query: 'hello' }, 'rag:query-meeting');
  }, /Invalid IPC payload/);

  assert.throws(() => {
    parseIpcInput(ipcSchemas.ragCancelQuery, {}, 'rag:cancel-query');
  }, /Invalid IPC payload/);
});
