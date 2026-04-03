import type { AppState } from '../main';
import { ipcSchemas, parseIpcInput } from '../ipcValidation';
import type { SafeHandle, SafeHandleValidated } from './registerTypes';

type RegisterRagHandlersDeps = {
  appState: AppState;
  safeHandle: SafeHandle;
  safeHandleValidated: SafeHandleValidated;
};

type RagIpcSuccess<T> = {
  success: true;
  data: T;
};

type RagIpcFailure = {
  success: false;
  error: {
    code: string;
    message: string;
  };
};

function ragSuccess<T>(data: T): RagIpcSuccess<T> {
  return {
    success: true,
    data,
  };
}

function ragError(code: string, message: string): RagIpcFailure {
  return {
    success: false,
    error: {
      code,
      message,
    },
  };
}

export function registerRagHandlers({ appState, safeHandle, safeHandleValidated }: RegisterRagHandlersDeps): void {
  const activeRAGQueries = new Map<string, AbortController>();

  safeHandleValidated('rag:query-meeting', (args) => [parseIpcInput(ipcSchemas.ragMeetingQuery, args[0], 'rag:query-meeting')] as const, async (event, { meetingId, query, requestId }) => {
    const ragManager = appState.getRAGManager();
    if (!ragManager || !ragManager.isReady()) return ragSuccess({ fallback: true });
    if (!ragManager.isMeetingProcessed(meetingId) && !ragManager.isLiveIndexingActive(meetingId)) return ragSuccess({ fallback: true });

    const abortController = new AbortController();
    const resolvedRequestId = requestId ?? `meeting-${meetingId}-${Date.now()}`;
    const queryKey = resolvedRequestId;
    activeRAGQueries.set(queryKey, abortController);

    try {
      const stream = ragManager.queryMeeting(meetingId, query, abortController.signal);
      for await (const chunk of stream) {
        if (abortController.signal.aborted) break;
        event.sender.send('rag:stream-chunk', { meetingId, requestId: resolvedRequestId, chunk });
      }
      event.sender.send('rag:stream-complete', { meetingId, requestId: resolvedRequestId });
      return ragSuccess({ success: true });
    } catch (error: any) {
      if (error.name !== 'AbortError') {
        const msg = error.message || '';
        if (msg.includes('NO_RELEVANT_CONTEXT') || msg.includes('NO_MEETING_EMBEDDINGS')) return ragSuccess({ fallback: true });
        event.sender.send('rag:stream-error', { meetingId, requestId: resolvedRequestId, error: msg });
      }
      return ragError('RAG_QUERY_FAILED', error?.message || 'Unable to query meeting context');
    } finally {
      activeRAGQueries.delete(queryKey);
    }
  });

  safeHandleValidated('rag:query-live', (args) => [parseIpcInput(ipcSchemas.ragLiveQuery, args[0], 'rag:query-live')] as const, async (event, { query, requestId }) => {
    const ragManager = appState.getRAGManager();
    if (!ragManager || !ragManager.isReady()) return ragSuccess({ fallback: true });
    if (!ragManager.isLiveIndexingActive('live-meeting-current')) return ragSuccess({ fallback: true });

    const abortController = new AbortController();
    const resolvedRequestId = requestId ?? `live-${Date.now()}`;
    const queryKey = resolvedRequestId;
    activeRAGQueries.set(queryKey, abortController);

    try {
      const stream = ragManager.queryMeeting('live-meeting-current', query, abortController.signal);
      for await (const chunk of stream) {
        if (abortController.signal.aborted) break;
        event.sender.send('rag:stream-chunk', { live: true, requestId: resolvedRequestId, chunk });
      }
      event.sender.send('rag:stream-complete', { live: true, requestId: resolvedRequestId });
      return ragSuccess({ success: true });
    } catch (error: any) {
      if (error.name !== 'AbortError') {
        const msg = error.message || '';
        if (msg.includes('NO_RELEVANT_CONTEXT') || msg.includes('NO_MEETING_EMBEDDINGS')) return ragSuccess({ fallback: true });
        event.sender.send('rag:stream-error', { live: true, requestId: resolvedRequestId, error: msg });
      }
      return ragError('RAG_QUERY_FAILED', error?.message || 'Unable to query live context');
    } finally {
      activeRAGQueries.delete(queryKey);
    }
  });

  safeHandleValidated('rag:query-global', (args) => [parseIpcInput(ipcSchemas.ragGlobalQuery, args[0], 'rag:query-global')] as const, async (event, { query, requestId }) => {
    const ragManager = appState.getRAGManager();
    if (!ragManager || !ragManager.isReady()) return ragSuccess({ fallback: true });

    const abortController = new AbortController();
    const resolvedRequestId = requestId ?? `global-${Date.now()}`;
    const queryKey = resolvedRequestId;
    activeRAGQueries.set(queryKey, abortController);

    try {
      const stream = ragManager.queryGlobal(query, abortController.signal);
      for await (const chunk of stream) {
        if (abortController.signal.aborted) break;
        event.sender.send('rag:stream-chunk', { global: true, requestId: resolvedRequestId, chunk });
      }
      event.sender.send('rag:stream-complete', { global: true, requestId: resolvedRequestId });
      return ragSuccess({ success: true });
    } catch (error: any) {
      if (error.name !== 'AbortError') {
        event.sender.send('rag:stream-error', { global: true, requestId: resolvedRequestId, error: error.message });
      }
      return ragError('RAG_QUERY_FAILED', error?.message || 'Unable to query global context');
    } finally {
      activeRAGQueries.delete(queryKey);
    }
  });

  safeHandleValidated('rag:cancel-query', (args) => [parseIpcInput(ipcSchemas.ragCancelQuery, args[0], 'rag:cancel-query')] as const, async (_event, { meetingId, global }) => {
    const queryKey = global ? 'global' : `meeting-${meetingId}`;
    for (const [key, controller] of activeRAGQueries) {
      if (key.startsWith(queryKey) || (global && key.startsWith('global'))) {
        controller.abort();
        activeRAGQueries.delete(key);
      }
    }
    return ragSuccess({ success: true });
  });

  safeHandleValidated('rag:is-meeting-processed', (args) => [parseIpcInput(ipcSchemas.providerId, args[0], 'rag:is-meeting-processed')] as const, async (_event, meetingId) => {
    try {
      const ragManager = appState.getRAGManager();
      if (!ragManager) return ragSuccess(false);
      return ragSuccess(ragManager.isMeetingProcessed(meetingId));
    } catch {
      return ragSuccess(false);
    }
  });

  safeHandle('rag:reindex-incompatible-meetings', async () => {
    try {
      const ragManager = appState.getRAGManager();
      if (!ragManager) return ragError('RAG_MANAGER_UNAVAILABLE', 'RAGManager not initialized');
      await ragManager.reindexIncompatibleMeetings();
      return ragSuccess({ success: true });
    } catch (error: any) {
      return ragError('RAG_REINDEX_FAILED', error?.message || 'Unable to reindex incompatible meetings');
    }
  });

  safeHandle('rag:get-queue-status', async () => {
    const ragManager = appState.getRAGManager();
    if (!ragManager) return ragSuccess({ pending: 0, processing: 0, completed: 0, failed: 0 });
    return ragSuccess(ragManager.getQueueStatus());
  });

  safeHandle('rag:retry-embeddings', async () => {
    try {
      const ragManager = appState.getRAGManager();
      if (!ragManager) return ragError('RAG_MANAGER_UNAVAILABLE', 'RAGManager not initialized');
      await ragManager.retryPendingEmbeddings();
      return ragSuccess({ success: true });
    } catch (error: any) {
      return ragError('RAG_RETRY_FAILED', error?.message || 'Unable to retry embeddings');
    }
  });
}
