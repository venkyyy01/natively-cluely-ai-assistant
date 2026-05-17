import { describe, it } from 'node:test';
import assert from 'node:assert';
import { TranscriptIndex, type TranscriptSegment } from '../conscious/TranscriptIndex';

describe('TranscriptIndex', () => {
  it('should add and retrieve segments', () => {
    const index = new TranscriptIndex();
    const segment: TranscriptSegment = {
      id: '1',
      text: 'The latency constraint is 100ms',
      timestamp: Date.now(),
    };

    index.addSegment(segment);
    assert.strictEqual(index.size(), 1);
  });

  it('should limit segments to max limit', () => {
    const index = new TranscriptIndex();
    const maxSegments = index.getMaxSegments();

    for (let i = 0; i < maxSegments + 10; i++) {
      index.addSegment({
        id: String(i),
        text: `Segment ${i}`,
        timestamp: Date.now(),
      });
    }

    assert.strictEqual(index.size(), maxSegments);
  });

  it('should return empty results for empty index', () => {
    const index = new TranscriptIndex();
    const results = index.search('test');
    assert.strictEqual(results.length, 0);
  });

  it('should search for semantically similar segments', () => {
    const index = new TranscriptIndex();
    
    index.addSegment({
      id: '1',
      text: 'The latency constraint is 100ms',
      timestamp: Date.now(),
      embedding: [0.9, 0.1, 0.2],
    });

    const results = index.search('latency constraint', [0.9, 0.1, 0.2]);
    assert.ok(results.length > 0, 'Should find similar segment');
  });

  it('should filter results by similarity threshold', () => {
    const index = new TranscriptIndex();
    
    index.addSegment({
      id: '1',
      text: 'The latency constraint is 100ms',
      timestamp: Date.now(),
      embedding: [0.9, 0.1, 0.2],
    });

    const results = index.search('unrelated query', [0.1, 0.9, 0.8]);
    assert.strictEqual(results.length, 0, 'Should not find dissimilar segment');
  });

  it('should return top-K results', () => {
    const index = new TranscriptIndex();
    const topK = index.getTopK();

    for (let i = 0; i < topK + 5; i++) {
      index.addSegment({
        id: String(i),
        text: `Segment ${i}`,
        timestamp: Date.now(),
        embedding: [0.9 - (i * 0.01), 0.1, 0.2],
      });
    }

    const results = index.search('query', [0.9, 0.1, 0.2]);
    assert.ok(results.length <= topK, `Should return at most ${topK} results`);
  });

  it('should clear the index', () => {
    const index = new TranscriptIndex();
    
    index.addSegment({
      id: '1',
      text: 'Test segment',
      timestamp: Date.now(),
    });

    assert.strictEqual(index.size(), 1);
    
    index.clear();
    assert.strictEqual(index.size(), 0);
  });

  it('should handle missing embeddings', () => {
    const index = new TranscriptIndex();
    
    index.addSegment({
      id: '1',
      text: 'Test segment without embedding',
      timestamp: Date.now(),
    });

    const results = index.search('query');
    assert.strictEqual(results.length, 0, 'Should handle missing embeddings');
  });

  it('should get all segments', () => {
    const index = new TranscriptIndex();
    
    index.addSegment({
      id: '1',
      text: 'Segment 1',
      timestamp: Date.now(),
    });

    index.addSegment({
      id: '2',
      text: 'Segment 2',
      timestamp: Date.now(),
    });

    const allSegments = index.getAllSegments();
    assert.strictEqual(allSegments.length, 2);
  });

  it('should provide similarity threshold getter', () => {
    const index = new TranscriptIndex();
    const threshold = index.getSimilarityThreshold();
    assert.strictEqual(threshold, 0.85);
  });

  it('should provide max segments getter', () => {
    const index = new TranscriptIndex();
    const maxSegments = index.getMaxSegments();
    assert.strictEqual(maxSegments, 100);
  });

  it('should provide top-K getter', () => {
    const index = new TranscriptIndex();
    const topK = index.getTopK();
    assert.strictEqual(topK, 5);
  });
});
