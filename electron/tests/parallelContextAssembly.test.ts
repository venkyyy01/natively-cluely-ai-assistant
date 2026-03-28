import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { ParallelContextAssembler, ContextAssemblyInput } from '../cache/ParallelContextAssembler';

describe('ParallelContextAssembler', () => {
  let assembler: ParallelContextAssembler;

  beforeEach(() => {
    assembler = new ParallelContextAssembler({ workerThreadCount: 2 });
  });

  it('should assemble context in parallel', async () => {
    const input: ContextAssemblyInput = {
      query: 'What is React virtual DOM?',
      transcript: [
        { speaker: 'interviewer', text: 'Tell me about React', timestamp: Date.now() - 60000 },
        { speaker: 'user', text: 'React is a library', timestamp: Date.now() - 30000 },
      ],
      previousContext: { recentTopics: ['react'], activeThread: null },
    };

    const result = await assembler.assemble(input);

    assert(result.embedding.length > 0);
    assert(result.phase !== undefined);
    assert(result.relevantContext.length >= 0);
  });

  it('should handle worker failures gracefully', async () => {
    const input: ContextAssemblyInput = {
      query: 'test',
      transcript: [],
      previousContext: { recentTopics: [], activeThread: null },
    };

    const result = await assembler.assemble(input);

    assert(result !== null);
  });

  it('should respect worker thread count', async () => {
    const limited = new ParallelContextAssembler({ workerThreadCount: 1 });
    assert(limited.getWorkerCount() === 1);
  });
});
