export interface MessageWithId {
  id: string;
}

export function createMessageId(prefix: string, now: number, sequence: number): string {
  return `${prefix}-${now}-${sequence}`;
}

export function updateMessageById<T extends MessageWithId>(
  prev: T[],
  messageId: string | null,
  updater: (message: T) => T,
): T[] {
  if (!messageId) {
    return prev;
  }

  let didUpdate = false;
  const updated = prev.map((message) => {
    if (message.id !== messageId) {
      return message;
    }

    didUpdate = true;
    return updater(message);
  });

  return didUpdate ? updated : prev;
}

export function updateOrPrependMessageById<T extends MessageWithId>(
  prev: T[],
  messageId: string | null,
  updater: (message: T) => T,
  fallbackMessage: T,
): T[] {
  const updatedMessages = updateMessageById(prev, messageId, updater);
  if (updatedMessages !== prev) {
    return updatedMessages;
  }

  return [fallbackMessage, ...prev];
}
