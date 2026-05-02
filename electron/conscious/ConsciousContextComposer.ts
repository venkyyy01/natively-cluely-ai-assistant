import type {
	AssistantResponse,
	TemporalContext,
} from "../llm/TemporalContextBuilder";
import { buildTemporalContext } from "../llm/TemporalContextBuilder";
import { prepareTranscriptForReasoning } from "../llm/transcriptCleaner";
import type { ContextItem, TranscriptSegment } from "../SessionTracker";

export interface ConsciousContextComposition {
	contextItems: ContextItem[];
	preparedTranscript: string;
	temporalContext: TemporalContext;
}

export class ConsciousContextComposer {
	compose(input: {
		contextItems: ContextItem[];
		lastInterim: TranscriptSegment | null;
		assistantHistory: AssistantResponse[];
		evidenceContextBlock?: string;
		transcriptTurnLimit?: number;
		temporalWindowSeconds?: number;
		onInterimInjected?: (text: string) => void;
	}): ConsciousContextComposition {
		const contextItems = [...input.contextItems];
		const lastInterim = input.lastInterim;

		if (lastInterim && lastInterim.text.trim().length > 0) {
			const lastItem = contextItems[contextItems.length - 1];
			const isDuplicate =
				lastItem &&
				lastItem.role === "interviewer" &&
				(lastItem.text === lastInterim.text ||
					Math.abs(lastItem.timestamp - lastInterim.timestamp) < 1000);

			if (!isDuplicate) {
				input.onInterimInjected?.(lastInterim.text);
				contextItems.push({
					role: "interviewer",
					text: lastInterim.text,
					timestamp: lastInterim.timestamp,
				});
			}
		}

		const transcriptTurns = contextItems.map((item) => ({
			role: item.role,
			text: item.text,
			timestamp: item.timestamp,
		}));

		const preparedTranscript = prepareTranscriptForReasoning(
			transcriptTurns,
			input.transcriptTurnLimit ?? 12,
		);

		return {
			contextItems,
			preparedTranscript: input.evidenceContextBlock
				? `${input.evidenceContextBlock}\n\n${preparedTranscript}`
				: preparedTranscript,
			temporalContext: buildTemporalContext(
				contextItems,
				input.assistantHistory,
				input.temporalWindowSeconds ?? 180,
			),
		};
	}
}
