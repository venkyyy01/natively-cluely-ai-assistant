/**
 * NAT-702: RobustJsonStreamParser unit tests.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RobustJsonStreamParser } from '../llm/RobustJsonStreamParser';

test('NAT-702: emits complete for a single-chunk JSON object', () => {
  const parser = new RobustJsonStreamParser();
  const results: Record<string, unknown>[] = [];
  parser.on('complete', (obj) => results.push(obj));
  parser.push('{"answer":"hello","confidence":0.9}');
  assert.equal(results.length, 1);
  assert.equal((results[0] as any).answer, 'hello');
  assert.equal((results[0] as any).confidence, 0.9);
});

test('NAT-702: emits complete when JSON arrives in many small chunks', () => {
  const parser = new RobustJsonStreamParser();
  const results: Record<string, unknown>[] = [];
  parser.on('complete', (obj) => results.push(obj));
  const full = '{"key":"value with spaces","n":42}';
  for (const ch of full) parser.push(ch);
  assert.equal(results.length, 1);
  assert.equal((results[0] as any).key, 'value with spaces');
  assert.equal((results[0] as any).n, 42);
});

test('NAT-702: ignores preamble text before opening brace', () => {
  const parser = new RobustJsonStreamParser();
  const results: Record<string, unknown>[] = [];
  parser.on('complete', (obj) => results.push(obj));
  parser.push('Sure, here is the JSON:\n{"x":1}');
  assert.equal(results.length, 1);
  assert.equal((results[0] as any).x, 1);
});

test('NAT-702: handles nested objects correctly', () => {
  const parser = new RobustJsonStreamParser();
  const results: Record<string, unknown>[] = [];
  parser.on('complete', (obj) => results.push(obj));
  parser.push('{"a":{"b":{"c":3}}}');
  assert.equal(results.length, 1);
  assert.deepEqual((results[0] as any).a, { b: { c: 3 } });
});

test('NAT-702: handles escaped quotes inside strings', () => {
  const parser = new RobustJsonStreamParser();
  const results: Record<string, unknown>[] = [];
  parser.on('complete', (obj) => results.push(obj));
  parser.push('{"msg":"say \\"hello\\""}');
  assert.equal(results.length, 1);
  assert.equal((results[0] as any).msg, 'say "hello"');
});

test('NAT-702: emits partial objects progressively', () => {
  const parser = new RobustJsonStreamParser();
  const partials: Record<string, unknown>[] = [];
  parser.on('partial', (obj) => partials.push(obj));
  // Feed char-by-char; partial events come after each chunk in in_object state
  parser.push('{"answer":"hi"}');
  // At least one partial should have been emitted before complete
  // (depends on when depth=1 + closing brace not yet seen)
  // More deterministically: push partial string and check
  const parser2 = new RobustJsonStreamParser();
  const partials2: Record<string, unknown>[] = [];
  parser2.on('partial', (obj) => partials2.push(obj));
  // Push a chunk that is a valid partial
  parser2.push('{"answer":"hi"');
  assert.ok(partials2.length > 0, 'Should have emitted at least one partial');
});

test('NAT-702: reset clears state for reuse', () => {
  const parser = new RobustJsonStreamParser();
  const results: Record<string, unknown>[] = [];
  parser.on('complete', (obj) => results.push(obj));
  parser.push('{"x":1}');
  assert.equal(results.length, 1);
  parser.reset();
  assert.equal(parser.getState(), 'waiting');
  assert.equal(parser.getBuffer(), '');
  parser.push('{"y":2}');
  assert.equal(results.length, 2);
  assert.equal((results[1] as any).y, 2);
});

test('NAT-702: does not crash on empty push', () => {
  const parser = new RobustJsonStreamParser();
  assert.doesNotThrow(() => parser.push(''));
});
