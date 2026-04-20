// electron/tests/ollamaStreamErrorTyped.test.ts
//
// NAT-040 / audit P-9: `streamWithOllama` previously had a catch
// branch that did
//
//     yield "Error: Failed to stream from Ollama.";
//
// which surfaced a sentence-shaped pseudo-token to the IPC layer.
// Downstream, that string was rendered to the user as if it were a
// model response and indexed into the answer pipeline. Tickets that
// fed off `suggested_answer` were silently scored on bogus content.
//
// This test pins the post-fix behavior:
//
//   1. When the underlying transport fails, the generator MUST throw
//      (typed `Error`), not yield.
//   2. The literal "Error: Failed to stream from Ollama." string MUST
//      NOT appear in any yielded chunk.
//   3. The thrown error preserves the original cause's message — we
//      do not swallow detail in `sanitizeError`-only output.
//
// We invoke the private async generator via cast-to-any to exercise
// the real catch path without spinning up a fake Electron environment.

import test from 'node:test';
import assert from 'node:assert/strict';

import { LLMHelper } from '../LLMHelper';

// Force the global fetch to fail with a controllable error so we hit
// the catch branch. We restore it after the test to avoid bleed.
const originalFetch = (globalThis as { fetch?: typeof fetch }).fetch;

function installFailingFetch(thrown: Error) {
  (globalThis as { fetch: unknown }).fetch = (async () => {
    throw thrown;
  }) as typeof fetch;
}

function restoreFetch() {
  if (originalFetch) {
    (globalThis as { fetch: typeof fetch }).fetch = originalFetch;
  } else {
    delete (globalThis as { fetch?: typeof fetch }).fetch;
  }
}

function newOllamaHelper(): LLMHelper {
  // We exercise the streamWithOllama generator directly. Going through
  // the real LLMHelper constructor pulls in `initializeOllamaModel`
  // which calls out to /api/tags and hangs the test runner. We instead
  // build a bare object that has just the fields the generator reads:
  // `ollamaUrl`, `ollamaModel`, and the `cleanupExpiredCaches` /
  // rate-limiter scaffolding that the catch path uses (`sanitizeError`
  // is a module-level free function, so no instance state needed).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const helper = Object.create(LLMHelper.prototype) as Record<string, unknown>;
  helper.ollamaUrl = 'http://127.0.0.1:11434';
  helper.ollamaModel = 'llama3.2';
  helper.useOllama = true;
  return helper as unknown as LLMHelper;
}

test('NAT-040: streamWithOllama throws a typed Error on transport failure', async () => {
  const cause = new Error('econn-refused: ollama not running');
  installFailingFetch(cause);

  const helper = newOllamaHelper();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const gen = (helper as any).streamWithOllama('hi', undefined, 'test-system') as AsyncGenerator<string>;

  let threw: unknown = null;
  const collected: string[] = [];
  try {
    for await (const chunk of gen) {
      collected.push(chunk);
    }
  } catch (e) {
    threw = e;
  } finally {
    restoreFetch();
  }

  assert.ok(threw instanceof Error, 'expected typed Error to be thrown');
  assert.match((threw as Error).message, /econn-refused|ollama/i);
  assert.equal(collected.length, 0, 'no fake-token chunks should leak');
});

test('NAT-040: the literal fake-token sentence never appears in yields', async () => {
  installFailingFetch(new Error('boom'));
  const helper = newOllamaHelper();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const gen = (helper as any).streamWithOllama('hi') as AsyncGenerator<string>;

  const collected: string[] = [];
  try {
    for await (const chunk of gen) {
      collected.push(chunk);
    }
  } catch {
    // expected
  } finally {
    restoreFetch();
  }

  for (const chunk of collected) {
    assert.doesNotMatch(
      chunk,
      /Error: Failed to stream from Ollama\./,
      'pre-NAT-040 fake-token sentence must not be yielded',
    );
  }
});
