/**
 * OcrService cascade behaviour.
 *
 * These tests cover the contracts the rest of the codebase relies on:
 *   * `recognize` never throws, even when every provider misbehaves.
 *   * Empty / failed provider results fall through to the next provider.
 *   * "Unsupported on this platform" failures invalidate availability so
 *     subsequent calls don't re-probe a known-disabled provider.
 *   * A hung provider triggers the per-image timeout instead of stalling
 *     the cascade indefinitely.
 *   * `recognizeMany` honours the abort signal between images.
 *   * Availability TTL allows recovery from transient cold-start failures.
 *
 * These are the multi-screenshot reliability invariants for the
 * "screenshot → text-only LLM" fallback path. They run on every
 * platform because the fakes don't depend on the native module.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

import { OcrService, type OcrProvider } from '../ocr/OcrService';

function makeFakeImage(name: string): string {
  const p = path.join(os.tmpdir(), `nat-ocr-${process.pid}-${Date.now()}-${name}.png`);
  fs.writeFileSync(p, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  return p;
}

class StubProvider implements OcrProvider {
  public attempts = 0;
  public availabilityCalls = 0;

  constructor(
    public readonly name: string,
    private readonly behaviour: {
      available?: boolean | (() => Promise<boolean>);
      result?: string | (() => Promise<string>);
      delayMs?: number;
    } = {},
  ) {}

  async isAvailable(): Promise<boolean> {
    this.availabilityCalls += 1;
    if (typeof this.behaviour.available === 'function') return this.behaviour.available();
    return this.behaviour.available ?? true;
  }

  async recognize(_imagePath: string): Promise<string> {
    this.attempts += 1;
    if (this.behaviour.delayMs && this.behaviour.delayMs > 0) {
      await new Promise((r) => setTimeout(r, this.behaviour.delayMs));
    }
    if (typeof this.behaviour.result === 'function') return this.behaviour.result();
    return this.behaviour.result ?? '';
  }
}

test('returns empty result for missing path without invoking providers', async () => {
  const a = new StubProvider('a', { result: 'should-not-run' });
  const svc = new OcrService([a]);
  const result = await svc.recognize('/nonexistent/path/should-fail.png');
  assert.equal(result.text, '');
  assert.equal(result.provider, 'none');
  assert.equal(a.attempts, 0);
});

test('first provider with non-empty text wins; later providers untouched', async () => {
  const img = makeFakeImage('first-wins');
  try {
    const a = new StubProvider('a', { result: 'hello' });
    const b = new StubProvider('b', { result: 'should-not-run' });
    const svc = new OcrService([a, b]);
    const result = await svc.recognize(img);
    assert.equal(result.text, 'hello');
    assert.equal(result.provider, 'a');
    assert.equal(b.attempts, 0);
  } finally {
    fs.unlinkSync(img);
  }
});

test('empty result falls through to the next provider', async () => {
  const img = makeFakeImage('fallthrough-empty');
  try {
    const a = new StubProvider('a', { result: '' });
    const b = new StubProvider('b', { result: 'fallback' });
    const svc = new OcrService([a, b]);
    const result = await svc.recognize(img);
    assert.equal(result.text, 'fallback');
    assert.equal(result.provider, 'b');
    assert.equal(a.attempts, 1);
    assert.equal(b.attempts, 1);
  } finally {
    fs.unlinkSync(img);
  }
});

test('thrown provider error falls through to next provider', async () => {
  const img = makeFakeImage('fallthrough-throw');
  try {
    const a = new StubProvider('a', {
      result: async () => {
        throw new Error('Image not readable: corrupt');
      },
    });
    const b = new StubProvider('b', { result: 'recovered' });
    const svc = new OcrService([a, b]);
    const result = await svc.recognize(img);
    assert.equal(result.text, 'recovered');
    assert.equal(result.provider, 'b');
  } finally {
    fs.unlinkSync(img);
  }
});

test('Unsupported on this platform marks provider unavailable until TTL', async () => {
  const img = makeFakeImage('unsupported');
  try {
    const a = new StubProvider('a', {
      result: async () => {
        throw new Error('Unsupported on this platform');
      },
    });
    const b = new StubProvider('b', { result: 'ok' });
    const svc = new OcrService([a, b], { availabilityTtlMs: 1_000 });

    const r1 = await svc.recognize(img);
    assert.equal(r1.provider, 'b');
    assert.equal(a.attempts, 1);

    const r2 = await svc.recognize(img);
    assert.equal(r2.provider, 'b');
    // Provider 'a' should not have been retried after being marked
    // unavailable; the cache hit skipped its recognize() call.
    assert.equal(a.attempts, 1, 'unsupported provider must not be re-invoked within TTL');
  } finally {
    fs.unlinkSync(img);
  }
});

test('hung provider triggers per-image timeout and falls through', async () => {
  const img = makeFakeImage('timeout');
  try {
    const a = new StubProvider('a', { delayMs: 200, result: 'eventual' });
    const b = new StubProvider('b', { result: 'fast-fallback' });
    const svc = new OcrService([a, b]);

    const t0 = Date.now();
    const result = await svc.recognize(img, { timeoutMs: 30 });
    const elapsed = Date.now() - t0;

    assert.equal(result.provider, 'b');
    assert.equal(result.text, 'fast-fallback');
    assert.ok(elapsed < 200, `cascade should not wait for the hung provider (elapsed ${elapsed}ms)`);
  } finally {
    fs.unlinkSync(img);
  }
});

test('aborted signal short-circuits the cascade between providers', async () => {
  const img = makeFakeImage('abort');
  try {
    const a = new StubProvider('a', { result: '' });
    const b = new StubProvider('b', {
      result: async () => {
        throw new Error('should-not-run');
      },
    });
    const svc = new OcrService([a, b]);
    const ctrl = new AbortController();
    ctrl.abort();
    const result = await svc.recognize(img, { signal: ctrl.signal });
    assert.equal(result.provider, 'none');
    assert.equal(a.attempts, 0);
    assert.equal(b.attempts, 0);
  } finally {
    fs.unlinkSync(img);
  }
});

test('recognizeMany processes multiple images and stops at abort', async () => {
  const img1 = makeFakeImage('many-1');
  const img2 = makeFakeImage('many-2');
  const img3 = makeFakeImage('many-3');
  try {
    const ctrl = new AbortController();
    let calls = 0;
    const a = new StubProvider('a', {
      result: async () => {
        calls += 1;
        if (calls === 2) ctrl.abort();
        return `chunk-${calls}`;
      },
    });
    const svc = new OcrService([a]);
    const results = await svc.recognizeMany([img1, img2, img3], { signal: ctrl.signal });
    // First two complete; third aborts before recognize starts.
    assert.equal(results.length, 2);
    assert.equal(results[0].text, 'chunk-1');
    assert.equal(results[1].text, 'chunk-2');
  } finally {
    [img1, img2, img3].forEach((p) => fs.unlinkSync(p));
  }
});

test('availability cache TTL allows recovery from transient probe failure', async () => {
  const img = makeFakeImage('availability-recover');
  try {
    let availabilityCount = 0;
    const a = new StubProvider('a', {
      available: async () => {
        availabilityCount += 1;
        // Fail the first probe; succeed afterwards.
        return availabilityCount > 1;
      },
      result: 'eventual-success',
    });
    // 50ms TTL — fast for the test.
    const svc = new OcrService([a], { availabilityTtlMs: 50 });

    const r1 = await svc.recognize(img);
    assert.equal(r1.provider, 'none', 'first call should see unavailable provider');

    // Wait past TTL/2 (failure cache uses half the TTL) so probe re-runs.
    await new Promise((r) => setTimeout(r, 60));

    const r2 = await svc.recognize(img);
    assert.equal(r2.provider, 'a', 'second call after TTL should pick up recovered provider');
    assert.equal(r2.text, 'eventual-success');
  } finally {
    fs.unlinkSync(img);
  }
});

test('resetAvailabilityCache forces re-probe', async () => {
  const img = makeFakeImage('reset');
  try {
    let availabilityCount = 0;
    const a = new StubProvider('a', {
      available: async () => {
        availabilityCount += 1;
        return availabilityCount > 1;
      },
      result: 'after-reset',
    });
    const svc = new OcrService([a], { availabilityTtlMs: 60_000 });
    const r1 = await svc.recognize(img);
    assert.equal(r1.provider, 'none');

    svc.resetAvailabilityCache();
    const r2 = await svc.recognize(img);
    assert.equal(r2.provider, 'a');
    assert.equal(r2.text, 'after-reset');
  } finally {
    fs.unlinkSync(img);
  }
});

test('all providers failing yields empty result without throwing', async () => {
  const img = makeFakeImage('all-fail');
  try {
    const a = new StubProvider('a', {
      result: async () => {
        throw new Error('boom-a');
      },
    });
    const b = new StubProvider('b', {
      result: async () => {
        throw new Error('boom-b');
      },
    });
    const c = new StubProvider('c', { result: '' });
    const svc = new OcrService([a, b, c]);
    const result = await svc.recognize(img);
    assert.equal(result.text, '');
    assert.equal(result.provider, 'none');
  } finally {
    fs.unlinkSync(img);
  }
});

test('quiet failure tags do not log warnings (smoke test for cascade)', async () => {
  const img = makeFakeImage('quiet');
  try {
    // Capture console.warn to confirm quiet failure tags don't log.
    const original = console.warn;
    const captured: unknown[][] = [];
    console.warn = (...args: unknown[]) => captured.push(args);

    const a = new StubProvider('a', {
      result: async () => {
        throw new Error('Image not found: /tmp/missing.png');
      },
    });
    const b = new StubProvider('b', { result: 'ok' });
    const svc = new OcrService([a, b]);
    try {
      const r = await svc.recognize(img);
      assert.equal(r.provider, 'b');
      assert.equal(captured.length, 0, `expected no warnings, got ${captured.length}`);
    } finally {
      console.warn = original;
    }
  } finally {
    fs.unlinkSync(img);
  }
});
