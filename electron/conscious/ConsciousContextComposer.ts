import type { AssistantResponse, TemporalContext } from '../llm/TemporalContextBuilder';
import { buildTemporalContext } from '../llm/TemporalContextBuilder';
import { prepareTranscriptForReasoning } from '../llm/transcriptCleaner';
import type { ContextItem, TranscriptSegment } from '../SessionTracker';

export interface ConsciousContextComposition {
  contextItems: ContextItem[];
  preparedTranscript: string;
  temporalContext: TemporalContext;
}

/**
 * Detect whether a context item is substantive (contains real content)
 * vs filler (acknowledgements, short interjections).
 */
function isSubstantiveItem(item: ContextItem): boolean {
  const text = item.text.trim();
  if (text.length < 8) return false;
  const wordCount = text.split(/\s+/).length;
  if (wordCount < 3) return false;
  // Filter out pure acknowledgements
  if (/^(ok|okay|got it|makes sense|right|yes|no|sure|thanks|thank you|mm-?hmm|uh-?huh|hmm|alright|cool)[\s!.,?]*$/i.test(text)) {
    return false;
  }
  return true;
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
      const isDuplicate = lastItem
        && lastItem.role === 'interviewer'
        && (lastItem.text === lastInterim.text || Math.abs(lastItem.timestamp - lastInterim.timestamp) < 1000);

      if (!isDuplicate) {
        input.onInterimInjected?.(lastInterim.text);
        contextItems.push({
          role: 'interviewer',
          text: lastInterim.text,
          timestamp: lastInterim.timestamp,
        });
      }
    }

    // Smart windowing: keep all recent substantive turns, but also include
    // earlier interviewer questions that set up the current topic thread.
    // This prevents losing context when the conversation has many short
    // acknowledgement turns between substantive exchanges.
    const turnLimit = input.transcriptTurnLimit ?? 12;
    const substantiveItems = contextItems.filter(isSubstantiveItem);
    const recentSubstantive = substantiveItems.slice(-turnLimit);

    // Always include the last N raw items for immediate context continuity
    const immediateWindow = contextItems.slice(-Math.min(6, contextItems.length));

    // Merge: recent substantive + immediate window, deduplicated by timestamp
    const mergedSet = new Map<number, ContextItem>();
    for (const item of recentSubstantive) {
      mergedSet.set(item.timestamp, item);
    }
    for (const item of immediateWindow) {
      mergedSet.set(item.timestamp, item);
    }
    const mergedItems = Array.from(mergedSet.values()).sort((a, b) => a.timestamp - b.timestamp);

    const transcriptTurns = mergedItems.map((item) => ({
      role: item.role,
      text: item.text,
      timestamp: item.timestamp,
    }));

    const preparedTranscript = prepareTranscriptForReasoning(transcriptTurns, turnLimit);

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
