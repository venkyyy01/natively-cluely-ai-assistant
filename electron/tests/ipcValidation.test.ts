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
