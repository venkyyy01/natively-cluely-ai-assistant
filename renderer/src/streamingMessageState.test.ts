import {
  createMessageId,
  updateMessageById,
  updateOrPrependMessageById,
} from '../../src/lib/streamingMessageState';

type TestMessage = {
  id: string;
  text: string;
  isStreaming?: boolean;
};

describe('streaming message state helpers', () => {
  test('createMessageId includes prefix, timestamp, and sequence', () => {
    expect(createMessageId('assistant', 1000, 7)).toBe('assistant-1000-7');
  });

  test('updateMessageById updates only matching message', () => {
    const prev: TestMessage[] = [
      { id: 'a', text: 'first' },
      { id: 'b', text: 'second' },
    ];

    const next = updateMessageById(prev, 'b', (message) => ({
      ...message,
      text: `${message.text}-updated`,
    }));

    expect(next).toEqual([
      { id: 'a', text: 'first' },
      { id: 'b', text: 'second-updated' },
    ]);
    expect(next).not.toBe(prev);
  });

  test('updateMessageById returns same array when id is missing', () => {
    const prev: TestMessage[] = [
      { id: 'a', text: 'first' },
      { id: 'b', text: 'second' },
    ];

    const next = updateMessageById(prev, 'missing', (message) => ({ ...message, text: 'x' }));

    expect(next).toBe(prev);
  });

  test('updateOrPrependMessageById prepends fallback when target is missing', () => {
    const prev: TestMessage[] = [{ id: 'a', text: 'existing' }];
    const fallback: TestMessage = { id: 'fallback', text: 'new', isStreaming: false };

    const next = updateOrPrependMessageById(
      prev,
      'missing',
      (message) => ({ ...message, text: 'updated' }),
      fallback,
    );

    expect(next).toEqual([
      { id: 'fallback', text: 'new', isStreaming: false },
      { id: 'a', text: 'existing' },
    ]);
  });
});
