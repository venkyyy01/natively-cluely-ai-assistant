import test from 'node:test';
import assert from 'node:assert/strict';

import { AdaptiveContextWindow } from '../conscious/AdaptiveContextWindow';

test('NAT-046: force-includes last 4 recent turns even with low score', async () => {
  const window = new AdaptiveContextWindow('openai');
  const now = Date.now();

  // Create 6 candidates: 4 recent with low semantic relevance, 2 old with high relevance
  const candidates = [
    { text: 'Recent turn one.', timestamp: now - 1000, embedding: [0.1, 0.1] },
    { text: 'Recent turn two.', timestamp: now - 2000, embedding: [0.1, 0.1] },
    { text: 'Recent turn three.', timestamp: now - 3000, embedding: [0.1, 0.1] },
    { text: 'Recent turn four.', timestamp: now - 4000, embedding: [0.1, 0.1] },
    { text: 'Old highly relevant turn A.', timestamp: now - 60000, embedding: [0.9, 0.9] },
    { text: 'Old highly relevant turn B.', timestamp: now - 70000, embedding: [0.85, 0.85] },
  ];

  const queryEmbedding = [0.9, 0.9];
  const tokenBudget = 200; // generous enough for all

  const selected = await window.selectContext(
    'query',
    queryEmbedding,
    candidates as any,
    {
      tokenBudget,
      recencyWeight: 0.3,
      semanticWeight: 0.7,
      phaseAlignmentWeight: 0.0,
      embeddingModel: 'test',
    }
  );

  const selectedTexts = selected.map((s) => s.text);

  // All 4 recent turns must be present regardless of score
  assert.ok(selectedTexts.includes('Recent turn one.'));
  assert.ok(selectedTexts.includes('Recent turn two.'));
  assert.ok(selectedTexts.includes('Recent turn three.'));
  assert.ok(selectedTexts.includes('Recent turn four.'));

  // The high-score old turns should also be included since budget is generous
  assert.ok(selectedTexts.includes('Old highly relevant turn A.'));
  assert.ok(selectedTexts.includes('Old highly relevant turn B.'));
});

test('NAT-046: recent turn is included over high-score old turn when budget is tight', async () => {
  const window = new AdaptiveContextWindow('openai');
  const now = Date.now();

  const candidates = [
    { text: 'Recent low score.', timestamp: now - 1000, embedding: [0.1, 0.1] },
    { text: 'Old high score.', timestamp: now - 60000, embedding: [0.95, 0.95] },
  ];

  const queryEmbedding = [0.95, 0.95];
  // Tight budget: only enough for one entry
  const tokenBudget = 6;

  const selected = await window.selectContext(
    'query',
    queryEmbedding,
    candidates as any,
    {
      tokenBudget,
      recencyWeight: 0.3,
      semanticWeight: 0.7,
      phaseAlignmentWeight: 0.0,
      embeddingModel: 'test',
    }
  );

  const selectedTexts = selected.map((s) => s.text);

  // The recent turn must be force-included even though the old one has higher score
  assert.ok(
    selectedTexts.includes('Recent low score.'),
    'Expected recent low-score turn to be force-included over old high-score turn'
  );
});

test('NAT-046: deduplicates force-included turns from scored fill', async () => {
  const window = new AdaptiveContextWindow('openai');
  const now = Date.now();

  const candidates = [
    { text: 'Recent one.', timestamp: now - 1000, embedding: [0.9, 0.9] },
    { text: 'Recent two.', timestamp: now - 2000, embedding: [0.8, 0.8] },
    { text: 'Recent three.', timestamp: now - 3000, embedding: [0.7, 0.7] },
    { text: 'Recent four.', timestamp: now - 4000, embedding: [0.6, 0.6] },
  ];

  const queryEmbedding = [0.9, 0.9];
  const tokenBudget = 500;

  const selected = await window.selectContext(
    'query',
    queryEmbedding,
    candidates as any,
    {
      tokenBudget,
      recencyWeight: 0.3,
      semanticWeight: 0.7,
      phaseAlignmentWeight: 0.0,
      embeddingModel: 'test',
    }
  );

  // No duplicates should appear
  const texts = selected.map((s) => s.text);
  const uniqueTexts = new Set(texts);
  assert.strictEqual(
    texts.length,
    uniqueTexts.size,
    'Selected context should contain no duplicate entries'
  );
});
