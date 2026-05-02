import { ipcSchemas, parseIpcInput } from "../ipcValidation";
import type { AppState } from "../main";
import type { SafeHandle, SafeHandleValidated } from "./registerTypes";

type RegisterRagHandlersDeps = {
	appState: AppState;
	safeHandle: SafeHandle;
	safeHandleValidated: SafeHandleValidated;
};

type RuntimeCoordinatorLike = {
	getSupervisor?: (name: string) => unknown;
};

type InferenceSupervisorLike = {
	getRAGManager?: () => unknown;
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

function getRagManager(
	appState: AppState,
): ReturnType<AppState["getRAGManager"]> {
	if (
		"getCoordinator" in appState &&
		typeof appState.getCoordinator === "function"
	) {
		const coordinator = appState.getCoordinator() as RuntimeCoordinatorLike;
		if (typeof coordinator.getSupervisor === "function") {
			const supervisor = coordinator.getSupervisor(
				"inference",
			) as InferenceSupervisorLike;
			if (typeof supervisor?.getRAGManager === "function") {
				return supervisor.getRAGManager() as ReturnType<
					AppState["getRAGManager"]
				>;
			}
		}
	}

	return appState.getRAGManager();
}

export function registerRagHandlers({
	appState,
	safeHandle,
	safeHandleValidated,
}: RegisterRagHandlersDeps): void {
	const activeRAGQueries = new Map<string, AbortController>();

	safeHandleValidated(
		"rag:query-meeting",
		(args) =>
			[
				parseIpcInput(ipcSchemas.ragMeetingQuery, args[0], "rag:query-meeting"),
			] as const,
		async (event, { meetingId, query }) => {
			const ragManager = getRagManager(appState);
			if (!ragManager?.isReady()) return ragSuccess({ fallback: true });
			if (
				!ragManager.isMeetingProcessed(meetingId) &&
				!ragManager.isLiveIndexingActive(meetingId)
			)
				return ragSuccess({ fallback: true });

			const abortController = new AbortController();
			const queryKey = `meeting-${meetingId}`;
			activeRAGQueries.set(queryKey, abortController);

			try {
				const stream = ragManager.queryMeeting(
					meetingId,
					query,
					abortController.signal,
				);
				for await (const chunk of stream) {
					if (abortController.signal.aborted) break;
					event.sender.send("rag:stream-chunk", { meetingId, chunk });
				}
				event.sender.send("rag:stream-complete", { meetingId });
				return ragSuccess({ success: true });
			} catch (error: any) {
				if (error.name !== "AbortError") {
					const msg = error.message || "";
					if (
						msg.includes("NO_RELEVANT_CONTEXT") ||
						msg.includes("NO_MEETING_EMBEDDINGS")
					)
						return ragSuccess({ fallback: true });
					event.sender.send("rag:stream-error", { meetingId, error: msg });
				}
				return ragError(
					"RAG_QUERY_FAILED",
					error?.message || "Unable to query meeting context",
				);
			} finally {
				activeRAGQueries.delete(queryKey);
			}
		},
	);

	safeHandleValidated(
		"rag:query-live",
		(args) =>
			[
				parseIpcInput(ipcSchemas.ragLiveQuery, args[0], "rag:query-live"),
			] as const,
		async (event, { query }) => {
			const ragManager = getRagManager(appState);
			if (!ragManager?.isReady()) return ragSuccess({ fallback: true });
			if (!ragManager.isLiveIndexingActive("live-meeting-current"))
				return ragSuccess({ fallback: true });

			const abortController = new AbortController();
			const queryKey = `live-${Date.now()}`;
			activeRAGQueries.set(queryKey, abortController);

			try {
				const stream = ragManager.queryMeeting(
					"live-meeting-current",
					query,
					abortController.signal,
				);
				for await (const chunk of stream) {
					if (abortController.signal.aborted) break;
					event.sender.send("rag:stream-chunk", { live: true, chunk });
				}
				event.sender.send("rag:stream-complete", { live: true });
				return ragSuccess({ success: true });
			} catch (error: any) {
				if (error.name !== "AbortError") {
					const msg = error.message || "";
					if (
						msg.includes("NO_RELEVANT_CONTEXT") ||
						msg.includes("NO_MEETING_EMBEDDINGS")
					)
						return ragSuccess({ fallback: true });
					event.sender.send("rag:stream-error", { live: true, error: msg });
				}
				return ragError(
					"RAG_QUERY_FAILED",
					error?.message || "Unable to query live context",
				);
			} finally {
				activeRAGQueries.delete(queryKey);
			}
		},
	);

	safeHandleValidated(
		"rag:query-global",
		(args) =>
			[
				parseIpcInput(ipcSchemas.ragGlobalQuery, args[0], "rag:query-global"),
			] as const,
		async (event, { query }) => {
			const ragManager = getRagManager(appState);
			if (!ragManager?.isReady()) return ragSuccess({ fallback: true });

			const abortController = new AbortController();
			const queryKey = `global-${Date.now()}`;
			activeRAGQueries.set(queryKey, abortController);

			try {
				const stream = ragManager.queryGlobal(query, abortController.signal);
				for await (const chunk of stream) {
					if (abortController.signal.aborted) break;
					event.sender.send("rag:stream-chunk", { global: true, chunk });
				}
				event.sender.send("rag:stream-complete", { global: true });
				return ragSuccess({ success: true });
			} catch (error: any) {
				if (error.name !== "AbortError") {
					event.sender.send("rag:stream-error", {
						global: true,
						error: error.message,
					});
				}
				return ragError(
					"RAG_QUERY_FAILED",
					error?.message || "Unable to query global context",
				);
			} finally {
				activeRAGQueries.delete(queryKey);
			}
		},
	);

	safeHandleValidated(
		"rag:cancel-query",
		(args) =>
			[
				parseIpcInput(ipcSchemas.ragCancelQuery, args[0], "rag:cancel-query"),
			] as const,
		async (_event, { meetingId, global, live }) => {
			for (const [key, controller] of activeRAGQueries) {
				let shouldCancel = false;
				if (meetingId && key.startsWith(`meeting-${meetingId}`)) {
					shouldCancel = true;
				}
				if (global && key.startsWith("global")) {
					shouldCancel = true;
				}
				if (live && key.startsWith("live")) {
					shouldCancel = true;
				}
				if (shouldCancel) {
					controller.abort();
					activeRAGQueries.delete(key);
				}
			}
			return ragSuccess({ success: true });
		},
	);

	safeHandleValidated(
		"rag:is-meeting-processed",
		(args) =>
			[
				parseIpcInput(
					ipcSchemas.providerId,
					args[0],
					"rag:is-meeting-processed",
				),
			] as const,
		async (_event, meetingId) => {
			try {
				const ragManager = getRagManager(appState);
				if (!ragManager) return ragSuccess(false);
				return ragSuccess(ragManager.isMeetingProcessed(meetingId));
			} catch {
				return ragSuccess(false);
			}
		},
	);

	safeHandle("rag:reindex-incompatible-meetings", async () => {
		try {
			const ragManager = getRagManager(appState);
			if (!ragManager)
				return ragError(
					"RAG_MANAGER_UNAVAILABLE",
					"RAGManager not initialized",
				);
			await ragManager.reindexIncompatibleMeetings();
			return ragSuccess({ success: true });
		} catch (error: any) {
			return ragError(
				"RAG_REINDEX_FAILED",
				error?.message || "Unable to reindex incompatible meetings",
			);
		}
	});

	safeHandle("rag:get-queue-status", async () => {
		const ragManager = getRagManager(appState);
		if (!ragManager)
			return ragSuccess({ pending: 0, processing: 0, completed: 0, failed: 0 });
		return ragSuccess(ragManager.getQueueStatus());
	});

	safeHandle("rag:retry-embeddings", async () => {
		try {
			const ragManager = getRagManager(appState);
			if (!ragManager)
				return ragError(
					"RAG_MANAGER_UNAVAILABLE",
					"RAGManager not initialized",
				);
			await ragManager.retryPendingEmbeddings();
			return ragSuccess({ success: true });
		} catch (error: any) {
			return ragError(
				"RAG_RETRY_FAILED",
				error?.message || "Unable to retry embeddings",
			);
		}
	});
}
