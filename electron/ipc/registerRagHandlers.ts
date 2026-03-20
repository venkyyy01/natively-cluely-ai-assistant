import type { AppState } from '../main';
import type { SafeHandle } from './registerTypes';

type RegisterRagHandlersDeps = {
  appState: AppState;
  safeHandle: SafeHandle;
};

export function registerRagHandlers({ appState, safeHandle }: RegisterRagHandlersDeps): void {
  const activeRAGQueries = new Map<string, AbortController>();

  safeHandle('rag:query-meeting', async (event, { meetingId, query }: { meetingId: string; query: string }) => {
    const ragManager = appState.getRAGManager();
    if (!ragManager || !ragManager.isReady()) return { fallback: true };
    if (!ragManager.isMeetingProcessed(meetingId) && !ragManager.isLiveIndexingActive(meetingId)) return { fallback: true };

    const abortController = new AbortController();
    const queryKey = `meeting-${meetingId}`;
    activeRAGQueries.set(queryKey, abortController);

    try {
      const stream = ragManager.queryMeeting(meetingId, query, abortController.signal);
      for await (const chunk of stream) {
        if (abortController.signal.aborted) break;
        event.sender.send('rag:stream-chunk', { meetingId, chunk });
      }
      event.sender.send('rag:stream-complete', { meetingId });
      return { success: true };
    } catch (error: any) {
      if (error.name !== 'AbortError') {
        const msg = error.message || '';
        if (msg.includes('NO_RELEVANT_CONTEXT') || msg.includes('NO_MEETING_EMBEDDINGS')) return { fallback: true };
        event.sender.send('rag:stream-error', { meetingId, error: msg });
      }
      return { success: false, error: error.message };
    } finally {
      activeRAGQueries.delete(queryKey);
    }
  });

  safeHandle('rag:query-live', async (event, { query }: { query: string }) => {
    const ragManager = appState.getRAGManager();
    if (!ragManager || !ragManager.isReady()) return { fallback: true };
    if (!ragManager.isLiveIndexingActive('live-meeting-current')) return { fallback: true };

    const abortController = new AbortController();
    const queryKey = `live-${Date.now()}`;
    activeRAGQueries.set(queryKey, abortController);

    try {
      const stream = ragManager.queryMeeting('live-meeting-current', query, abortController.signal);
      for await (const chunk of stream) {
        if (abortController.signal.aborted) break;
        event.sender.send('rag:stream-chunk', { live: true, chunk });
      }
      event.sender.send('rag:stream-complete', { live: true });
      return { success: true };
    } catch (error: any) {
      if (error.name !== 'AbortError') {
        const msg = error.message || '';
        if (msg.includes('NO_RELEVANT_CONTEXT') || msg.includes('NO_MEETING_EMBEDDINGS')) return { fallback: true };
        event.sender.send('rag:stream-error', { live: true, error: msg });
      }
      return { success: false, error: error.message };
    } finally {
      activeRAGQueries.delete(queryKey);
    }
  });

  safeHandle('rag:query-global', async (event, { query }: { query: string }) => {
    const ragManager = appState.getRAGManager();
    if (!ragManager || !ragManager.isReady()) return { fallback: true };

    const abortController = new AbortController();
    const queryKey = `global-${Date.now()}`;
    activeRAGQueries.set(queryKey, abortController);

    try {
      const stream = ragManager.queryGlobal(query, abortController.signal);
      for await (const chunk of stream) {
        if (abortController.signal.aborted) break;
        event.sender.send('rag:stream-chunk', { global: true, chunk });
      }
      event.sender.send('rag:stream-complete', { global: true });
      return { success: true };
    } catch (error: any) {
      if (error.name !== 'AbortError') {
        event.sender.send('rag:stream-error', { global: true, error: error.message });
      }
      return { success: false, error: error.message };
    } finally {
      activeRAGQueries.delete(queryKey);
    }
  });

  safeHandle('rag:cancel-query', async (_event, { meetingId, global }: { meetingId?: string; global?: boolean }) => {
    const queryKey = global ? 'global' : `meeting-${meetingId}`;
    for (const [key, controller] of activeRAGQueries) {
      if (key.startsWith(queryKey) || (global && key.startsWith('global'))) {
        controller.abort();
        activeRAGQueries.delete(key);
      }
    }
    return { success: true };
  });

  safeHandle('rag:is-meeting-processed', async (_event, meetingId: string) => {
    try {
      const ragManager = appState.getRAGManager();
      if (!ragManager) throw new Error('RAGManager not initialized');
      return ragManager.isMeetingProcessed(meetingId);
    } catch {
      return false;
    }
  });

  safeHandle('rag:reindex-incompatible-meetings', async () => {
    try {
      const ragManager = appState.getRAGManager();
      if (!ragManager) throw new Error('RAGManager not initialized');
      await ragManager.reindexIncompatibleMeetings();
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });

  safeHandle('rag:get-queue-status', async () => {
    const ragManager = appState.getRAGManager();
    if (!ragManager) return { pending: 0, processing: 0, completed: 0, failed: 0 };
    return ragManager.getQueueStatus();
  });

  safeHandle('rag:retry-embeddings', async () => {
    const ragManager = appState.getRAGManager();
    if (!ragManager) return { success: false };
    await ragManager.retryPendingEmbeddings();
    return { success: true };
  });
}
