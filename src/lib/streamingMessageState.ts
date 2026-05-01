export interface MessageWithId {
  id: string;
}

export type ActiveStreamingIds = Record<string, string>;

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

export function setActiveStreamingIds(
  activeIds: ActiveStreamingIds,
  keys: string[],
  messageId: string,
): ActiveStreamingIds {
  const next = { ...activeIds };

  for (const key of keys) {
    next[key] = messageId;
  }

  return next;
}

export function getActiveStreamingId(
  activeIds: ActiveStreamingIds,
  keys: string[],
): string | null {
  for (const key of keys) {
    const messageId = activeIds[key];
    if (messageId) {
      return messageId;
    }
  }

  return null;
}

export function clearActiveStreamingIdsByMessageId(
  activeIds: ActiveStreamingIds,
  messageId: string | null,
): ActiveStreamingIds {
  if (!messageId) {
    return activeIds;
  }

  let didClear = false;
  const next: ActiveStreamingIds = {};

  for (const [key, activeMessageId] of Object.entries(activeIds)) {
    if (activeMessageId === messageId) {
      didClear = true;
      continue;
    }

    next[key] = activeMessageId;
  }

  return didClear ? next : activeIds;
}
