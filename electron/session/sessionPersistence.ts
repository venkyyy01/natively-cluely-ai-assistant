// sessionPersistence.ts
// Session persistence: save, load, restore, and memory-state helpers.

import type { ExtractedConstraint } from "../conscious";
import type {
	PersistedSession,
	PersistedSessionMemoryEntry,
	PersistedSessionMemoryEntryValue,
	PersistedSessionMemoryState,
	SessionEvent,
} from "../memory/SessionPersistence";
import type { SessionTracker } from "../SessionTracker";
import { buildPseudoEmbedding, inferItemPhase } from "./sessionContext";
import {
	COLD_MEMORY_CEILING_BYTES,
	HOT_MEMORY_CEILING_BYTES,
	HOT_MEMORY_WINDOW_MS,
	MAX_ASSISTANT_HISTORY,
	MAX_TRANSCRIPT_ENTRIES,
	mapSpeakerToRole,
	type TranscriptSegment,
	type UsageInteraction,
	WARM_MEMORY_CEILING_BYTES,
} from "./sessionTypes";

export function createSessionDisposedError(): Error {
	return new Error("session_disposed");
}

export function rejectPendingWorkOnDispose(tracker: SessionTracker): void {
	const t = tracker as any;
	t.restoreRequestId += 1;
	t.pendingRestorePromise = null;
	t.isRestoring = false;
	t.writeBuffer = [];
	t.pendingCompactionPromise = null;
}

export function toMemoryEntry(
	id: string,
	value: PersistedSessionMemoryEntryValue,
): PersistedSessionMemoryEntry {
	return {
		id,
		sizeBytes: Buffer.byteLength(JSON.stringify(value), "utf8"),
		createdAt: value.timestamp,
		value,
	};
}

export function toTranscriptMemoryEntry(
	segment: TranscriptSegment,
	id: string,
): PersistedSessionMemoryEntry {
	return toMemoryEntry(id, {
		kind: "transcript",
		text: segment.text,
		timestamp: segment.timestamp,
		speaker: segment.speaker,
		final: segment.final,
		confidence: segment.confidence,
	});
}

export function toUsageMemoryEntry(
	entry: UsageInteraction,
	id: string,
): PersistedSessionMemoryEntry {
	return toMemoryEntry(id, {
		kind: "usage",
		timestamp: entry.timestamp,
		usageType: entry.type,
		question: entry.question,
		answer: entry.answer,
		items: entry.items,
	});
}

export function applyMemoryCeiling(
	entries: PersistedSessionMemoryEntry[],
	ceilingBytes: number,
): PersistedSessionMemoryEntry[] {
	let totalBytes = 0;
	const retained: PersistedSessionMemoryEntry[] = [];

	for (const entry of [...entries].sort(
		(left, right) => right.createdAt - left.createdAt,
	)) {
		if (retained.length > 0 && totalBytes + entry.sizeBytes > ceilingBytes) {
			continue;
		}

		retained.push(entry);
		totalBytes += entry.sizeBytes;
	}

	return retained.sort((left, right) => left.createdAt - right.createdAt);
}

export function getHotState(
	tracker: SessionTracker,
	now: number = Date.now(),
): PersistedSessionMemoryEntry[] {
	const t = tracker as any;
	const cutoff = now - HOT_MEMORY_WINDOW_MS;
	const transcriptEntries = t.fullTranscript
		.filter((segment: TranscriptSegment) => segment.timestamp >= cutoff)
		.map((segment: TranscriptSegment, index: number) =>
			toTranscriptMemoryEntry(segment, `hot-transcript-${index}`),
		);
	const usageEntries = t.fullUsage
		.filter((entry: UsageInteraction) => entry.timestamp >= cutoff)
		.map((entry: UsageInteraction, index: number) =>
			toUsageMemoryEntry(entry, `hot-usage-${index}`),
		);

	return applyMemoryCeiling(
		[...transcriptEntries, ...usageEntries],
		HOT_MEMORY_CEILING_BYTES,
	);
}

export function getWarmState(
	tracker: SessionTracker,
	now: number = Date.now(),
): PersistedSessionMemoryEntry[] {
	const t = tracker as any;
	const entries: PersistedSessionMemoryEntry[] = [];
	const activeThread = t.consciousThreadStore
		.getThreadManager()
		.getActiveThread();

	if (activeThread) {
		entries.push(
			toMemoryEntry(`warm-thread-${activeThread.id}`, {
				kind: "active-thread",
				timestamp: now,
				topic: activeThread.topic,
				goal: activeThread.goal,
				phase: activeThread.phase,
				turnCount: activeThread.turnCount,
			}),
		);
	}

	t.pinnedItems.forEach((item: any, index: number) => {
		entries.push(
			toMemoryEntry(`warm-pin-${index}-${item.id}`, {
				kind: "pinned-item",
				text: item.text,
				timestamp: item.pinnedAt,
				label: item.label,
			}),
		);
	});

	t.extractedConstraints.forEach(
		(constraint: ExtractedConstraint, index: number) => {
			entries.push(
				toMemoryEntry(`warm-constraint-${index}`, {
					kind: "constraint",
					text: constraint.raw,
					timestamp: now,
					normalized: constraint.normalized,
					raw: constraint.raw,
					constraintType: constraint.type,
				}),
			);
		},
	);

	t.transcriptEpochSummaries.forEach((summary: string, index: number) => {
		entries.push(
			toMemoryEntry(`warm-epoch-${index}`, {
				kind: "epoch-summary",
				text: summary,
				timestamp: now,
			}),
		);
	});

	return applyMemoryCeiling(entries, WARM_MEMORY_CEILING_BYTES);
}

export function getColdState(
	tracker: SessionTracker,
	now: number = Date.now(),
): PersistedSessionMemoryEntry[] {
	const t = tracker as any;
	const cutoff = now - HOT_MEMORY_WINDOW_MS;
	const transcriptEntries = t.fullTranscript
		.filter((segment: TranscriptSegment) => segment.timestamp < cutoff)
		.map((segment: TranscriptSegment, index: number) =>
			toTranscriptMemoryEntry(segment, `cold-transcript-${index}`),
		);
	const usageEntries = t.fullUsage
		.filter((entry: UsageInteraction) => entry.timestamp < cutoff)
		.map((entry: UsageInteraction, index: number) =>
			toUsageMemoryEntry(entry, `cold-usage-${index}`),
		);

	// NAT-014: cap the snapshot at COLD_MEMORY_CEILING_BYTES (8 MB).
	// Without this the persisted session JSON grows unbounded on long
	// meetings. `applyMemoryCeiling` keeps the most recent entries that
	// fit in the budget and discards older overflow from the snapshot
	// (the on-disk record in `MeetingPersistence` is unaffected).
	return applyMemoryCeiling(
		[...transcriptEntries, ...usageEntries],
		COLD_MEMORY_CEILING_BYTES,
	);
}

export function buildPersistedSession(
	tracker: SessionTracker,
	now: number = Date.now(),
): PersistedSession {
	const t = tracker as any;
	const threadManager = t.consciousThreadStore.getThreadManager();
	const activeThread = threadManager.getActiveThread();
	const memoryState: PersistedSessionMemoryState = {
		hot: getHotState(tracker, now),
		warm: getWarmState(tracker, now),
		cold: getColdState(tracker, now),
	};

	return {
		version: 1,
		sessionId: t.sessionId,
		meetingId: t.activeMeetingId,
		createdAt: t.sessionStartTime,
		lastActiveAt: now,
		activeThread: activeThread
			? {
					id: activeThread.id,
					topic: activeThread.topic,
					goal: activeThread.goal,
					phase: activeThread.phase,
					turnCount: activeThread.turnCount,
				}
			: null,
		suspendedThreads: threadManager
			.getSuspendedThreads()
			.map((thread: any) => ({
				id: thread.id,
				topic: thread.topic,
				goal: thread.goal,
				suspendedAt: thread.suspendedAt || thread.lastActiveAt,
				phase: thread.phase,
				turnCount: thread.turnCount,
				resumeKeywords: Array.isArray(thread.resumeKeywords)
					? [...thread.resumeKeywords]
					: undefined,
				keyDecisions: Array.isArray(thread.keyDecisions)
					? [...thread.keyDecisions]
					: undefined,
				constraints: Array.isArray(thread.constraints)
					? [...thread.constraints]
					: undefined,
			})),
		pinnedItems: t.pinnedItems,
		constraints: t.extractedConstraints,
		epochSummaries: [...t.transcriptEpochSummaries],
		responseHashes: t.fingerprinter.getHashes(),
		consciousState: {
			threadState: t.consciousThreadStore.getPersistenceSnapshot(),
			hypothesisState: t.answerHypothesisStore.getPersistenceSnapshot(),
			designState: t.designStateStore.getPersistenceSnapshot(),
			preferenceState: t.responsePreferenceStore.getPersistenceSnapshot(),
		},
		memoryState,
	};
}

export function persistState(tracker: SessionTracker): void {
	const t = tracker as any;
	if (!t.activeMeetingId || t.activeMeetingId === "unspecified") return;
	const snapshot = buildPersistedSession(tracker);
	t.persistence.scheduleSave(snapshot);
}

function clearLiveMeetingScopedState(tracker: SessionTracker): void {
	const t = tracker as any;

	t.contextItemsBuffer.clear();
	t.fullTranscript = [];
	t.fullUsage = [];
	t.lastAssistantMessage = null;
	t.assistantResponseHistory = [];
	t.lastInterimInterviewer = null;
	t.transcriptEpochSummaries = [];
	t.consciousThreadStore.reset();
	t.observedQuestionStore.reset();
	t.answerHypothesisStore.reset();
	t.responsePreferenceStore.reset();
	t.designStateStore.reset();
	t.consciousSemanticContext = "";
	t.transcriptRevision = 0;
	t.contextAssembleCache.clear();
	t.compactSnapshotCache.clear();
	t.semanticEmbeddingCache.clear();
	t.pinnedItems = [];
	t.extractedConstraints = [];
	t.fingerprinter.clear();
}

type DurableSessionEventType = SessionEvent["type"];

export async function appendSessionEvent(
	tracker: SessionTracker,
	type: DurableSessionEventType,
	payload: Record<string, unknown>,
	timestamp: number = Date.now(),
): Promise<void> {
	const t = tracker as any;
	if (!t.activeMeetingId || t.activeMeetingId === "unspecified") return;
	t.eventCount += 1;
	await t.persistence.appendEvent(t.sessionId, {
		eventId: `evt-${t.eventCount}-${Date.now()}`,
		type,
		timestamp,
		payload,
	});
	// NAT-059: periodic snapshot every N events
	if (t.eventCount % t.EVENT_SNAPSHOT_INTERVAL === 0) {
		const snapshot = buildPersistedSession(tracker);
		await t.persistence
			.snapshotEvents(t.sessionId, snapshot)
			.catch((err: any) => {
				console.warn("[SessionTracker] Periodic event snapshot failed:", err);
			});
	}
}

export async function appendTranscriptEvent(
	tracker: SessionTracker,
	segment: TranscriptSegment,
): Promise<void> {
	return appendSessionEvent(
		tracker,
		"transcript",
		{
			speaker: segment.speaker,
			text: segment.text,
			final: segment.final,
		},
		segment.timestamp,
	);
}

export async function restoreFromMeetingId(
	tracker: SessionTracker,
	meetingId: string,
	requestId: number = (tracker as any).restoreRequestId,
): Promise<boolean> {
	const t = tracker as any;
	if (t.disposed) {
		throw createSessionDisposedError();
	}
	const normalizedMeetingId = meetingId.trim();
	if (!normalizedMeetingId) return false;

	t.activeMeetingId = normalizedMeetingId;
	t.isRestoring = true;
	try {
		if (t.disposed) {
			throw createSessionDisposedError();
		}
		const session = await t.persistence.findByMeeting(normalizedMeetingId);
		if (t.disposed) {
			throw createSessionDisposedError();
		}
		if (requestId !== t.restoreRequestId) return false;
		if (!session) return false;

		const tooOld = Date.now() - session.lastActiveAt > 2 * 60 * 60 * 1000;
		if (tooOld) {
			return false;
		}

		if (requestId !== t.restoreRequestId) return false;

		t.sessionId = session.sessionId;
		t.sessionStartTime = session.createdAt;
		t.contextItemsBuffer.clear();
		t.fullTranscript = [];
		t.fullUsage = [];
		t.lastAssistantMessage = null;
		t.assistantResponseHistory = [];
		t.pinnedItems = session.pinnedItems || [];
		t.extractedConstraints = (session.constraints ||
			[]) as ExtractedConstraint[];
		t.transcriptEpochSummaries = session.epochSummaries || [];
		t.fingerprinter.restore(session.responseHashes || []);
		t.consciousThreadStore.reset();
		t.observedQuestionStore.reset();
		t.answerHypothesisStore.reset();
		t.responsePreferenceStore.reset();
		t.designStateStore.reset();
		t.consciousSemanticContext = "";

		if (t.consciousModeEnabled) {
			t.answerHypothesisStore.restorePersistenceSnapshot(
				session.consciousState?.hypothesisState,
			);
			t.responsePreferenceStore.restorePersistenceSnapshot(
				session.consciousState?.preferenceState,
			);
			t.designStateStore.restorePersistenceSnapshot(
				session.consciousState?.designState,
			);
			if (session.activeThread) {
				t.consciousThreadStore.restoreActiveThread({
					id: session.activeThread.id,
					topic: session.activeThread.topic,
					goal: session.activeThread.goal,
					phase:
						(session.activeThread.phase as any) || "requirements_gathering",
					turnCount: session.activeThread.turnCount,
				});
			}
			t.consciousThreadStore
				.getThreadManager()
				.restoreSuspendedThreads(session.suspendedThreads as any);
			t.consciousThreadStore.restorePersistenceSnapshot(
				session.consciousState?.threadState,
			);
		}

		restorePersistedMemoryState(tracker, session.memoryState);

		t.transcriptRevision = t.fullTranscript.length;
		t.contextAssembleCache.clear();
		t.compactSnapshotCache.clear();
		return true;
	} finally {
		t.isRestoring = false;
		const bufferedWrites = t.writeBuffer.splice(0);
		for (const write of bufferedWrites) {
			write();
		}
	}
}

export function ensureMeetingContext(
	tracker: SessionTracker,
	meetingId?: string,
): void {
	const t = tracker as any;
	if (t.disposed) {
		return;
	}
	const normalizedMeetingId = meetingId?.trim();
	if (!normalizedMeetingId) return;

	if (normalizedMeetingId !== t.activeMeetingId) {
		clearLiveMeetingScopedState(tracker);
	}

	t.activeMeetingId = normalizedMeetingId;
	const requestId = ++t.restoreRequestId;

	t.pendingRestorePromise = restoreFromMeetingId(
		tracker,
		normalizedMeetingId,
		requestId,
	)
		.then(() => {
			// normalize to Promise<void> for pending gate
		})
		.catch((error: any) => {
			console.warn(
				"[SessionTracker] Failed to restore persisted session state:",
				error,
			);
		})
		.finally(() => {
			if (requestId === t.restoreRequestId) {
				t.pendingRestorePromise = null;
			}
		});
}

export async function flushPersistenceNow(
	tracker: SessionTracker,
): Promise<void> {
	persistState(tracker);
	const t = tracker as any;
	await t.persistence.flushScheduledSave();
}

export function restorePersistedMemoryState(
	tracker: SessionTracker,
	memoryState?: PersistedSessionMemoryState,
): void {
	const t = tracker as any;
	if (!memoryState) {
		return;
	}

	const memoryEntries = [
		...memoryState.cold,
		...memoryState.warm,
		...memoryState.hot,
	].sort((left, right) => left.createdAt - right.createdAt);

	t.fullTranscript = memoryEntries
		.filter((entry) => entry.value.kind === "transcript" && entry.value.text)
		.map((entry) => ({
			speaker: entry.value.speaker ?? "interviewer",
			text: entry.value.text ?? "",
			timestamp: entry.value.timestamp,
			final: entry.value.final ?? true,
			confidence: entry.value.confidence,
		}))
		.slice(-MAX_TRANSCRIPT_ENTRIES);

	t.fullUsage = memoryEntries
		.filter((entry) => entry.value.kind === "usage" && entry.value.usageType)
		.map((entry) => ({
			type: entry.value.usageType || "unknown",
			timestamp: entry.value.timestamp,
			question: entry.value.question,
			answer: entry.value.answer,
			items: entry.value.items,
		}));

	for (const segment of t.fullTranscript.slice(-t.maxContextItems)) {
		const role = mapSpeakerToRole(segment.speaker);
		const text = segment.text.trim();
		if (!text) {
			continue;
		}

		t.contextItemsBuffer.push({
			role,
			text,
			timestamp: segment.timestamp,
			phase: inferItemPhase(tracker, role, text),
			embedding: buildPseudoEmbedding(text),
		});
	}

	const assistantSegments = t.fullTranscript.filter(
		(segment: TranscriptSegment) => segment.speaker === "assistant",
	);
	t.lastAssistantMessage = assistantSegments.at(-1)?.text ?? null;
	t.assistantResponseHistory = assistantSegments
		.slice(-MAX_ASSISTANT_HISTORY)
		.map((segment: TranscriptSegment) => ({
			text: segment.text,
			timestamp: segment.timestamp,
			questionContext: "restored-session",
		}));
}
