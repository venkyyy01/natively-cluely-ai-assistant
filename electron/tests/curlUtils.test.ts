import test from 'node:test';
import assert from 'node:assert/strict';
import { deepVariableReplacer, getByPath, validateCurl } from '../utils/curlUtils';

test('validateCurl rejects empty commands and non-curl commands', () => {
  assert.deepEqual(validateCurl(''), { isValid: false, message: 'Command cannot be empty.' });
  assert.deepEqual(validateCurl('   '), { isValid: false, message: 'Command cannot be empty.' });
  assert.deepEqual(validateCurl('POST https://example.com'), {
    isValid: false,
    message: "Command must start with 'curl'.",
  });
});

test('validateCurl rejects commands without text placeholder', () => {
  assert.deepEqual(validateCurl('curl https://example.com'), {
    isValid: false,
    message: 'Your cURL must contain {{TEXT}} placeholder for the prompt.',
  });
});

test('validateCurl accepts parseable commands with placeholder and rejects bad syntax', () => {
  const valid = validateCurl("curl https://example.com -H 'Content-Type: application/json' -d '{\"prompt\":\"{{TEXT}}\"}'");
  assert.equal(valid.isValid, true);
  assert.ok(valid.json);

  assert.deepEqual(validateCurl('curl "unterminated {{TEXT}}'), {
    isValid: false,
    message: 'Invalid cURL syntax.',
  });
});

test('deepVariableReplacer replaces strings recursively and preserves primitives', () => {
  const replaced = deepVariableReplacer(
    {
      url: 'https://example.com/{{ID}}',
      headers: ['Bearer {{TOKEN}}', 42, false, null],
      nested: {
        body: '{{TEXT}}',
      },
    },
    { ID: '123', TOKEN: 'abc', TEXT: 'hello' },
  );

  assert.deepEqual(replaced, {
    url: 'https://example.com/123',
    headers: ['Bearer abc', 42, false, null],
    nested: {
      body: 'hello',
    },
  });
});

test('getByPath resolves nested keys, arrays, missing paths, and empty path', () => {
  const obj = {
    choices: [{ message: { content: 'hi' } }],
    plain: { value: 7 },
  };

  assert.equal(getByPath(obj, ''), obj);
  assert.equal(getByPath(obj, 'choices[0].message.content'), 'hi');
  assert.equal(getByPath(obj, 'plain.value'), 7);
  assert.equal(getByPath(obj, 'choices[1].message.content'), undefined);
});
