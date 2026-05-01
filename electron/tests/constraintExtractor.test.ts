import test from 'node:test';
import assert from 'node:assert/strict';
import { extractConstraints } from '../conscious/ConstraintExtractor';

test('extractConstraints extracts and normalizes common interview constraints', () => {
  const constraints = extractConstraints(
    'We have a $500k budget, 12 engineers, and a 3 month timeline due by Mar 15. Need 4 milestones and 99.9% uptime.'
  );

  const normalized = constraints.map((item) => `${item.type}:${item.normalized}`);

  assert.ok(normalized.some((entry) => entry.startsWith('budget:$500,000')));
  assert.ok(normalized.some((entry) => entry.startsWith('headcount:12 engineers')));
  assert.ok(normalized.some((entry) => entry.startsWith('duration:3 month')));
  assert.ok(normalized.some((entry) => entry.startsWith('count:4 milestones')));
  assert.ok(normalized.some((entry) => entry.startsWith('percentage:99.9%')));
});

test('extractConstraints deduplicates repeated constraints', () => {
  const constraints = extractConstraints('Budget is $200k and budget remains $200k.');
  const budgetItems = constraints.filter((item) => item.type === 'budget');
  assert.equal(budgetItems.length, 1);
});
