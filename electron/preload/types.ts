import { ipcRenderer } from "electron";
import type {
	CustomProviderPayload,
	FastResponseConfig,
	FollowUpEmailInput,
	GeminiChatOptions,
	OverlayBounds,
	TranscriptTextEntry,
} from "../../shared/ipc";

export type IpcErrorContract = { code: string; message: string };
export type IpcResult<T> =
	| { success: true; data: T }
	| { success: false; error: IpcErrorContract };
export type StatusResult = { success: boolean; error?: string };
export type SuggestedAnswerMetadata = {
	route:
		| "fast_standard_answer"
		| "enriched_standard_answer"
		| "conscious_answer"
		| "manual_answer"
		| "follow_up_refinement";
	attemptedRoute?:
		| "fast_standard_answer"
		| "enriched_standard_answer"
		| "conscious_answer"
		| "manual_answer"
		| "follow_up_refinement";
	fallbackOccurred: boolean;
	fallbackReason?: string;
	intentConfidence?: number;
	intentProviderUsed?: string;
	intentRetryCount?: number;
	intentFallbackReason?:
		| "primary_unavailable"
		| "primary_retries_exhausted"
		| "primary_failed"
		| "primary_low_confidence"
		| "primary_contradiction";
	prefetchedIntentUsed?: boolean;
	schemaVersion: "standard_answer_v1" | "conscious_mode_v1";
	evidenceHash: string;
	contextSelectionHash?: string;
	transcriptRevision: number;
	threadAction?: "start" | "continue" | "reset" | "ignore";
	thread?: {
		rootQuestion: string;
		lastQuestion: string;
		followUpCount: number;
		updatedAt: number;
	} | null;
	threadState: {
		activeThread: {
			rootQuestion: string;
			lastQuestion: string;
			followUpCount: number;
			updatedAt: number;
		} | null;
		threadAction: "start" | "continue" | "reset" | "ignore";
		transcriptRevision: number;
	};
	cooldownSuppressedMs?: number;
	cooldownReason?: "duplicate_question_debounce";
	verifier?: {
		deterministic: "pass" | "fail" | "skipped";
		judge?: "pass" | "fail" | "skipped";
		provenance: "pass" | "fail" | "skipped";
		reasons?: string[];
	};
	stealthContainmentActive: boolean;
};
export type IntelligenceSuggestedAnswerEvent = {
	answer: string;
	question: string;
	confidence: number;
	metadata?: SuggestedAnswerMetadata;
};

export const isIpcResult = <T>(value: unknown): value is IpcResult<T> => {
	return (
		Boolean(value) &&
		typeof value === "object" &&
		"success" in (value as Record<string, unknown>)
	);
};

export const getErrorMessage = (error: unknown): string => {
	return error instanceof Error ? error.message : "IPC request failed";
};

export const invokeAndUnwrap = async <T>(
	channel: string,
	...args: unknown[]
): Promise<T> => {
	const result = await ipcRenderer.invoke(channel, ...args);
	if (!isIpcResult<T>(result)) {
		return result as T;
	}

	if (result.success) {
		return result.data;
	}

	throw new Error(
		(result as { success: false; error: IpcErrorContract }).error.message,
	);
};

export const invokeVoid = async (
	channel: string,
	...args: unknown[]
): Promise<void> => {
	await invokeAndUnwrap<unknown>(channel, ...args);
};

export const invokeStatus = async (
	channel: string,
	...args: unknown[]
): Promise<StatusResult> => {
	try {
		await invokeVoid(channel, ...args);
		return { success: true };
	} catch (error) {
		return { success: false, error: getErrorMessage(error) };
	}
};
