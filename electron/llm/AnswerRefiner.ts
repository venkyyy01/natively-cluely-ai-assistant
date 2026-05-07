import type { LLMHelper } from "../LLMHelper";

export type ConversationState =
	| "fresh_main"
	| "followup_same_topic"
	| "topic_shift_new_problem"
	| "behavioral_star";

export type ConsciousThreadAction =
	| "start"
	| "continue"
	| "reset"
	| "ignore";

export interface ThreadContext {
	followUpCount: number;
	rootQuestion?: string;
	conversationState: ConversationState;
}

export function threadActionToConversationState(
	threadAction: ConsciousThreadAction | undefined,
): ConversationState {
	switch (threadAction) {
		case "start":
			return "fresh_main";
		case "continue":
			return "followup_same_topic";
		case "reset":
			return "topic_shift_new_problem";
		case "ignore":
		default:
			return "fresh_main";
	}
}

const STAR_PATTERNS = [
	/\bSituation\s*[:\n]/i,
	/\bTask\s*[:\n]/i,
	/\bAction\s*[:\n]/i,
	/\bResult\s*[:\n]/i,
	/\bQuestion\s*[:\n].*\bHeadline\s*[:\n]/is,
];

function isBehavioralStarAnswer(value: string): boolean {
	const normalized = value.trim();
	if (normalized.length > 8000) return false;
	const matches = STAR_PATTERNS.filter((p) => p.test(normalized)).length;
	return matches >= 2;
}

const MIN_REFINED_LENGTH = 10;
const WALL_OF_TEXT_THRESHOLD = 3000;
const FOLLOW_UP_WALL_THRESHOLD = 800;
const PROBLEM_RESTATEMENT_PATTERN = /^(1\.\s*)?Problem\s*restatement/i;
const SECTION_HEADER_PATTERN = /^#{1,3}\s+/gm;
const MAX_SECTION_HEADERS = 3;

const STATE_PROMPTS: Record<ConversationState, string> = {
	fresh_main: `
RULES FOR FRESH ANSWER (first response to a new problem):
1. This is the FIRST answer to "{rootQuestion}"
2. KEEP the full walkthrough: brute-force approach, optimized solution, and all code blocks
3. KEEP explanations for each approach — the user needs this context
4. REMOVE ONLY: section headers like "1. Problem restatement", "Brute-force overview:", "Optimized approach:" — make them flow naturally instead
5. REMOVE ONLY: meta-commentary like "Let me walk you through...", "Here's what I'd do:", "Let me break this down"
6. PRESERVE: all code blocks, complexity analysis, edge cases, tradeoffs
7. Make the answer flow naturally as speech, not as a numbered list of sections`,

	followup_same_topic: `
RULES FOR CONTINUATION ANSWER (follow-up #{followUpCount} on the same problem):
CRITICAL — THE USER ALREADY HAS THE FULL SOLUTION. DO NOT RESTATE IT.
1. Answer ONLY what the NEW follow-up question "{question}" asks
2. CUT any "Problem restatement" or preamble about the original problem ENTIRELY
3. For sub-questions ("what data structure?", "what complexity?", "how would you change X?"): 2-4 sentences MAX
4. Keep all code blocks intact — if the question relates to specific code, include only that code fragment
5. Remove any explanation that was already covered in the original full answer
6. If the question is about a specific implementation detail, give that detail — not the whole problem again
7. Remove all section headers — just give the direct answer`,

	topic_shift_new_problem: `
RULES FOR TOPIC SHIFT ANSWER (interviewer moved to a completely different topic):
1. The interviewer changed subjects — treat this as a FRESH first answer to a NEW problem
2. Do NOT reference the previous topic or thread
3. KEEP the full walkthrough for this NEW problem: approach, explanation, code blocks
4. REMOVE ONLY: preamble fluff, section headers, meta-commentary
5. This is NOT a follow-up — give the complete structured answer the interviewer asked for`,

	behavioral_star: `
RULES FOR BEHAVIORAL ANSWER:
1. This is a behavioral/STAR format interview answer
2. RETURN THE ORIGINAL ANSWER COMPLETELY UNCHANGED
3. Do NOT trim, shorten, restructure, or modify ANY part
4. STAR answers need full Situation, Task, Action, Result detail — preserving them is CORRECT behavior`,
};

const FINAL_REFINEMENT_PROMPT = `You are a response refiner. Your job is to produce a trimmed version of an interview answer that matches a strict conversational state policy.

CONVERSATIONAL STATE: {conversationState}
ROOT QUESTION OF THIS THREAD: "{rootQuestion}"
CURRENT QUESTION: "{question}"
FOLLOW-UP #: {followUpCount}

{stateRules}

INPUT DATA:

ORIGINAL ANSWER TO REFINE:
{originalAnswer}

OUTPUT: Only the refined answer text. No meta-commentary about what you changed.`;

const COMPLIANCE_CHECK_PROMPT = `You are a compliance checker. Verify the refined answer against the conversational state policy.

CONVERSATIONAL STATE: {conversationState}
ORIGINAL ANSWER LENGTH: {originalLength} chars
REFINED ANSWER LENGTH: {refinedLength} chars

ORIGINAL ANSWER:
{originalAnswer}

REFINED ANSWER:
{refinedAnswer}

COMPLIANCE CHECKS:
1. If state is "followup_same_topic": does the refined answer AVOID restating the full problem? (FAIL if it starts with problem restatement)
2. If state is "followup_same_topic": is the refined answer FOCUSED on the specific follow-up question, not the whole problem?
3. If state is "fresh_main" or "topic_shift_new_problem": did we PRESERVE code blocks and substantive explanations?
4. If state is "behavioral_star": is the refined answer IDENTICAL to the original?
5. Did the refined answer become TOO short to be useful (< 50 chars)?

Respond with ONLY one word:
PASS — if all checks pass
FAIL — if any check fails, followed by a one-line reason

Answer:`;

export class AnswerRefiner {
	private llmHelper: LLMHelper;

	constructor(llmHelper: LLMHelper) {
		this.llmHelper = llmHelper;
	}

	needsTrimming(
		answer: string,
		threadContext: ThreadContext,
	): boolean {
		const trimmed = answer.trim();
		if (!trimmed) return false;

		if (threadContext.conversationState === "behavioral_star") {
			return false;
		}

		const isWallOfText = trimmed.length > WALL_OF_TEXT_THRESHOLD;
		const isBigFollowUp =
			threadContext.followUpCount > 0 && trimmed.length > FOLLOW_UP_WALL_THRESHOLD;
		if (!isWallOfText && !isBigFollowUp) {
			return false;
		}

		if (PROBLEM_RESTATEMENT_PATTERN.test(trimmed)) {
			return true;
		}

		const sectionHeaders = trimmed.match(SECTION_HEADER_PATTERN);
		if (sectionHeaders && sectionHeaders.length > MAX_SECTION_HEADERS) {
			return true;
		}

		return false;
	}

	private formatPrompt(
		rawAnswer: string,
		question: string,
		threadContext: ThreadContext,
	): string {
		const stateRules = STATE_PROMPTS[threadContext.conversationState];
		return FINAL_REFINEMENT_PROMPT
			.replace(/{conversationState}/g, threadContext.conversationState)
			.replace("{rootQuestion}", threadContext.rootQuestion || "a topic")
			.replace("{question}", question || "the current question")
			.replace("{followUpCount}", String(threadContext.followUpCount))
			.replace("{stateRules}", stateRules)
			.replace("{originalAnswer}", rawAnswer);
	}

	async *refineStream(
		rawAnswer: string,
		question: string,
		threadContext: ThreadContext,
		options?: { abortSignal?: AbortSignal },
	): AsyncGenerator<string> {
		if (!this.needsTrimming(rawAnswer, threadContext)) {
			return;
		}

		if (options?.abortSignal?.aborted) {
			return;
		}

		const prompt = this.formatPrompt(rawAnswer, question, threadContext);

		const stream = this.llmHelper.streamChat(
			prompt,
			undefined,
			undefined,
			undefined,
			{
				skipKnowledgeInterception: true,
				abortSignal: options?.abortSignal,
			},
		);

		for await (const chunk of stream) {
			if (options?.abortSignal?.aborted) {
				return;
			}
			yield chunk;
		}
	}

	private async runComplianceCheck(
		originalAnswer: string,
		refinedAnswer: string,
		threadContext: ThreadContext,
		options?: { abortSignal?: AbortSignal },
	): Promise<boolean> {
		if (options?.abortSignal?.aborted) return true;

		const prompt = COMPLIANCE_CHECK_PROMPT
			.replace(/{conversationState}/g, threadContext.conversationState)
			.replace("{originalLength}", String(originalAnswer.length))
			.replace("{refinedLength}", String(refinedAnswer.length))
			.replace("{originalAnswer}", originalAnswer)
			.replace("{refinedAnswer}", refinedAnswer);

		try {
			let verdict = "";
			const stream = this.llmHelper.streamChat(
				prompt,
				undefined,
				undefined,
				undefined,
				{
					skipKnowledgeInterception: true,
					abortSignal: options?.abortSignal,
				},
			);

			for await (const chunk of stream) {
				if (options?.abortSignal?.aborted) return true;
				verdict += chunk;
			}

			const upper = verdict.trim().toUpperCase();
			if (upper.startsWith("FAIL")) {
				console.log(
					`[AnswerRefiner] Compliance FAIL — ${verdict.trim()}`,
				);
				return false;
			}

			console.log(
				`[AnswerRefiner] Compliance PASS for state=${threadContext.conversationState}`,
			);
			return true;
		} catch (error) {
			console.warn(
				"[AnswerRefiner] Compliance check error, accepting refined answer:",
				error,
			);
			return true;
		}
	}

	async refine(
		rawAnswer: string,
		question: string,
		threadContext: ThreadContext,
		options?: { abortSignal?: AbortSignal },
	): Promise<string> {
		if (options?.abortSignal?.aborted) {
			return rawAnswer;
		}

		if (
			threadContext.conversationState !== "behavioral_star" &&
			isBehavioralStarAnswer(rawAnswer)
		) {
			return rawAnswer;
		}

		if (!this.needsTrimming(rawAnswer, threadContext)) {
			return rawAnswer;
		}

		const startMs = Date.now();

		try {
			let refined = "";
			const stream = this.refineStream(rawAnswer, question, threadContext, options);
			for await (const chunk of stream) {
				refined += chunk;
			}

			const trimmed = refined.trim();
			if (trimmed.length < MIN_REFINED_LENGTH) {
				console.log(
					"[AnswerRefiner] Refined answer too short, using original",
				);
				return rawAnswer;
			}

			if (trimmed === rawAnswer.trim()) {
				return rawAnswer;
			}

			const compliant = await this.runComplianceCheck(
				rawAnswer,
				trimmed,
				threadContext,
				options,
			);

			if (!compliant) {
				console.warn(
					"[AnswerRefiner] Compliance check failed, using original answer",
				);
				return rawAnswer;
			}

			const reduction = rawAnswer.length - trimmed.length;
			const reductionPct = rawAnswer.length > 0
				? ((reduction / rawAnswer.length) * 100).toFixed(0)
				: "0";
			console.log(
				`[AnswerRefiner] Trimmed ${rawAnswer.length}→${trimmed.length} chars (-${reductionPct}%) state=${threadContext.conversationState} followUp=${threadContext.followUpCount} ${Date.now() - startMs}ms`,
			);

			return trimmed;
		} catch (error) {
			console.warn(
				"[AnswerRefiner] Refinement failed, using original answer:",
				error,
			);
			return rawAnswer;
		}
	}
}
