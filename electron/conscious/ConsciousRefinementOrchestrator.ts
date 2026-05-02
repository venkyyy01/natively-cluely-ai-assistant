/**
 * ConsciousRefinementOrchestrator
 *
 * Standard (non-conscious) mode supports refinement turns out of the box via
 * `IntelligenceEngine.runFollowUp(intent, userRequest)` and the various
 * "make it shorter / longer / casual / formal" prompt families.
 *
 * Conscious mode never had this affordance. When a candidate said
 * "actually, can you make that shorter?" the request fell through the
 * conscious path entirely (it didn't match a structured-question schema)
 * and either got dropped or routed back to standard mode.
 *
 * This orchestrator gives conscious mode the same human-like refinement
 * behaviour: detect the intent, build a constrained prompt that preserves
 * the prior conscious answer, and produce a short, natural rewrite.
 *
 * It is a *prompt builder*, not an LLM. Whoever owns the LLM (the
 * orchestrator or coordinator) is responsible for streaming the result —
 * keeping I/O concerns out of this module makes it easy to test.
 */

import type { ConsciousModeStructuredResponse } from "../ConsciousMode";
import type { RefinementIntent } from "./HumanLikeConversationEngine";

export interface RefinementBuildInput {
	intent: RefinementIntent;
	/** The previous conscious-mode answer the user is asking us to refine. */
	previousAnswer: string;
	/** The most recent interviewer turn (may be empty). */
	lastInterviewerQuestion?: string;
	/** The exact user refinement request (e.g. "make it shorter"). */
	userRefinementRequest: string;
}

export interface RefinementPrompt {
	/** System / persona prompt to use. */
	systemPrompt: string;
	/** User-facing message that contains the refinement instruction. */
	userMessage: string;
}

/**
 * Per-intent guidance. Each entry tells the LLM exactly what shape the
 * rewrite should take, while preserving the original meaning.
 */
const INTENT_INSTRUCTIONS: Record<RefinementIntent, string> = {
	shorten:
		"Cut the answer down. Keep ONLY the core point. Aim for one short sentence — at most two. Drop preambles, hedges, and side-remarks. The candidate is in a live interview and needs to be tighter.",
	expand:
		"Give the candidate more to say. Add one concrete detail, example, or tradeoff that strengthens the original answer. Keep the same first-person voice. Stay under 4 sentences.",
	rephrase:
		"Rewrite the answer with different wording but the SAME meaning. Keep it natural Indian English. Same length, fresh phrasing.",
	simplify:
		"Strip out jargon. Use plain words a non-engineer could follow. Keep the technical accuracy intact. 1-3 sentences max.",
	more_formal:
		'Tighten the tone to professional and confident. No filler ("basically", "see", "yeah"). Keep first-person. Same length.',
	more_casual:
		'Loosen the tone. Add natural Indian English markers like "so basically", "yeah", "the thing is". Keep first-person. Same length.',
	add_example:
		"Append ONE concrete example that supports the original answer. The example should be specific (system, metric, or scenario). Keep the original answer mostly intact and add 1-2 sentences for the example.",
	add_detail:
		"Add ONE specific detail (a number, system name, tradeoff, or constraint) that strengthens the answer. Stay under 4 sentences total.",
};

/** Hard cap on previous-answer text we feed back to the LLM. */
const MAX_PREVIOUS_ANSWER_CHARS = 4000;

/** Hard cap on the question we feed back to the LLM. */
const MAX_QUESTION_CHARS = 800;

const REFINEMENT_SYSTEM_PROMPT = `You are the candidate continuing a live interview answer. The interviewer just asked you to revise something you already said. Stay in first person. Speak naturally, like a real Indian engineer. Do NOT introduce new facts unless explicitly asked. Do NOT add preambles like "Sure, here is...". Output ONLY the revised spoken answer.`;

export class ConsciousRefinementOrchestrator {
	/**
	 * Build the prompt + user message that the LLM should consume to produce
	 * a refined answer. Pure function — no I/O.
	 */
	buildPrompt(input: RefinementBuildInput): RefinementPrompt {
		const instruction = INTENT_INSTRUCTIONS[input.intent];

		const previousAnswer = truncate(
			input.previousAnswer.trim(),
			MAX_PREVIOUS_ANSWER_CHARS,
		);
		const lastQuestion = truncate(
			(input.lastInterviewerQuestion ?? "").trim(),
			MAX_QUESTION_CHARS,
		);
		const userRequest = input.userRefinementRequest.trim();

		const userMessageParts: string[] = [
			`REFINEMENT_INTENT: ${input.intent}`,
			`INSTRUCTION: ${instruction}`,
		];

		if (lastQuestion) {
			userMessageParts.push(`ORIGINAL_QUESTION: ${lastQuestion}`);
		}
		userMessageParts.push(
			`PREVIOUS_ANSWER:\n${previousAnswer || "(no previous answer was captured)"}`,
		);
		userMessageParts.push(`USER_REQUEST: ${userRequest}`);
		userMessageParts.push(
			"Output ONLY the refined spoken answer. No quotes, no preamble.",
		);

		return {
			systemPrompt: REFINEMENT_SYSTEM_PROMPT,
			userMessage: userMessageParts.join("\n\n"),
		};
	}

	/**
	 * Convert a structured conscious-mode response into a flat spoken string
	 * suitable for refinement. We deliberately do NOT just dump the JSON —
	 * the candidate spoke this answer, so the refinement target should be
	 * the spoken form.
	 */
	flattenStructuredAnswer(response: ConsciousModeStructuredResponse): string {
		const parts: string[] = [];

		if (response.openingReasoning?.trim()) {
			parts.push(response.openingReasoning.trim());
		}

		if (response.behavioralAnswer) {
			const ba = response.behavioralAnswer;
			const behavioralParts = [
				ba.headline,
				ba.situation,
				ba.task,
				ba.action,
				ba.result,
			].filter((part) => typeof part === "string" && part.trim().length > 0);
			parts.push(behavioralParts.join(" "));
		}

		for (const item of response.implementationPlan) {
			if (item.trim()) parts.push(item.trim());
		}
		for (const item of response.tradeoffs) {
			if (item.trim()) parts.push(item.trim());
		}
		for (const item of response.edgeCases) {
			if (item.trim()) parts.push(item.trim());
		}
		for (const item of response.scaleConsiderations) {
			if (item.trim()) parts.push(item.trim());
		}
		for (const item of response.pushbackResponses) {
			if (item.trim()) parts.push(item.trim());
		}

		if (response.codeTransition?.trim()) {
			parts.push(response.codeTransition.trim());
		}

		return parts.filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
	}

	/**
	 * Decide whether a refinement intent is a no-op for the given previous
	 * answer. We avoid round-tripping the LLM when we'd just hand the user
	 * back what they already had.
	 */
	isRefinementUseful(input: {
		intent: RefinementIntent;
		previousAnswer: string;
	}): boolean {
		const len = input.previousAnswer.trim().length;
		if (len === 0) return false;

		if (input.intent === "shorten" && len < 80) {
			// Already short — refinement won't add value.
			return false;
		}
		if (input.intent === "expand" && len > 1200) {
			// Already very long — expanding further is unhelpful.
			return false;
		}
		return true;
	}
}

function truncate(value: string, maxChars: number): string {
	if (value.length <= maxChars) return value;
	return `${value.slice(0, maxChars)}…`;
}
