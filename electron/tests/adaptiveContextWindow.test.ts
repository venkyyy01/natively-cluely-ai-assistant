import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { AdaptiveContextWindow, ContextSelectionConfig, ContextEntry } from '../conscious/AdaptiveContextWindow';
import { InterviewPhase } from '../conscious/types';

describe('AdaptiveContextWindow', () => {
  let window: AdaptiveContextWindow;

  beforeEach(() => {
    window = new AdaptiveContextWindow();
  });

  it('should select context based on semantic relevance', async () => {
    const config: ContextSelectionConfig = {
      tokenBudget: 500,
      recencyWeight: 0.3,
      semanticWeight: 0.5,
      phaseAlignmentWeight: 0.2,
    };

    const candidates: ContextEntry[] = [
      { text: 'React uses virtual DOM', timestamp: Date.now() - 1000, embedding: [1, 0, 0] },
      { text: 'I worked on a React project', timestamp: Date.now() - 5000, embedding: [0.9, 0.1, 0] },
      { text: 'Unrelated topic about weather', timestamp: Date.now() - 1000, embedding: [0, 0, 1] },
    ];

    const result = await window.selectContext(
      'Tell me about React',
      [1, 0, 0],
      candidates,
      config
    );

    assert(result.length > 0);
    assert(result.some(c => c.text.includes('React')));
  });

  it('should respect token budget', async () => {
    const config: ContextSelectionConfig = {
      tokenBudget: 10,
      recencyWeight: 0.5,
      semanticWeight: 0.3,
      phaseAlignmentWeight: 0.2,
    };

    const candidates: ContextEntry[] = Array(100).fill(null).map((_, i) => ({
      text: `Context item ${i} with some text`,
      timestamp: Date.now() - i * 1000,
      embedding: [Math.random(), Math.random(), Math.random()],
    }));

    const result = await window.selectContext('test', [0, 0, 0], candidates, config);

    const totalTokens = result.reduce((sum, c) => sum + c.text.split(/\s+/).length, 0);
    assert(totalTokens <= 20);
  });

  it('should weight recent entries higher with recencyWeight', async () => {
    const config: ContextSelectionConfig = {
      tokenBudget: 1000,
      recencyWeight: 0.9,
      semanticWeight: 0.05,
      phaseAlignmentWeight: 0.05,
    };

    const candidates: ContextEntry[] = [
      { text: 'Old context', timestamp: Date.now() - 100000, embedding: [0, 0, 0] },
      { text: 'Recent context', timestamp: Date.now() - 1000, embedding: [0, 0, 0] },
    ];

    const result = await window.selectContext('test', [0, 0, 0], candidates, config);

    assert(result[0].text === 'Recent context');
  });

  it('falls back to lexical relevance when embedding dimensions mismatch', async () => {
    const config: ContextSelectionConfig = {
      tokenBudget: 1000,
      recencyWeight: 0.05,
      semanticWeight: 0.9,
      phaseAlignmentWeight: 0.05,
      embeddingModel: 'query-model',
    };

    const now = Date.now();
    const candidates: ContextEntry[] = [
      // 4 recent entries with mismatched dimensions (force-included by recency floor)
      { text: 'Recent one', timestamp: now - 100, embedding: [0, 0, 1], embeddingModel: 'query-model', embeddingDimension: 3 },
      { text: 'Recent two', timestamp: now - 200, embedding: [0, 0, 1], embeddingModel: 'query-model', embeddingDimension: 3 },
      { text: 'Recent three', timestamp: now - 300, embedding: [0, 0, 1], embeddingModel: 'query-model', embeddingDimension: 3 },
      { text: 'Recent four', timestamp: now - 400, embedding: [0, 0, 1], embeddingModel: 'query-model', embeddingDimension: 3 },
      // Older entry with mismatched dimensions but high lexical relevance to query
      {
        text: 'Consistent hashing keeps cache resharding stable',
        timestamp: now - 20_000,
        embedding: [0.2, 0.8],
        embeddingModel: 'old-model',
        embeddingDimension: 2,
      },
      // Another old entry with low lexical relevance
      {
        text: 'Unrelated weather update',
        timestamp: now - 500,
        embedding: [0, 0, 1],
        embeddingModel: 'query-model',
        embeddingDimension: 3,
      },
    ];

    const result = await window.selectContext(
      'consistent hashing cache',
      [1, 0, 0],
      candidates,
      config
    );

    // The 4 recent entries are force-included first
    assert.equal(result[0].text, 'Recent one');
    // The lexically relevant older entry should appear in the scored fill
    const texts = result.map((r) => r.text);
    assert.ok(texts.includes('Consistent hashing keeps cache resharding stable'));
    // The low-relevance older entry should not beat the high-relevance one in scored fill
    const consistentIndex = texts.indexOf('Consistent hashing keeps cache resharding stable');
    const unrelatedIndex = texts.indexOf('Unrelated weather update');
    assert.ok(
      consistentIndex < unrelatedIndex || unrelatedIndex === -1,
      'Lexically relevant entry should rank above unrelated entry in scored fill'
    );
  });
});
