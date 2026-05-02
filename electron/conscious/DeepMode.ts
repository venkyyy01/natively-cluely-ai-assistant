// DeepMode.ts
// Deep Mode: conscious mode on steroids with cURL-only execution,
// full context, immediate streaming, background verification, and zero blocking.
//
// Architecture:
//   classifyDeepModeQuestion  → permissive gate (admin only)
//   extractClaims             → decompose structured response into atomic claims
//   verifyClaimAgainstContext → background parallel verification via cURL

import type {
	ConsciousBehavioralAnswer,
	ConsciousModeStructuredResponse,
} from "../ConsciousMode";

export interface DeepModeState {
	enabled: boolean;
	adaptiveContextBudget: number;
	consecutiveCurlFailures: number;
	lastSuccessfulContextSize: number;
}

export interface DeepModeConfig {
	enabled: boolean;
}

export const DEEP_MODE_ADMIN_BLOCKLIST = new Set([
	"okay",
	"ok",
	"got it",
	"fine",
	"sounds good",
	"repeat that",
	"say that again",
	"all set",
	"done already",
	"warmup is done",
	"calendar invite",
]);

export function classifyDeepModeQuestion(
	question: string | null | undefined,
): boolean {
	const normalized = typeof question === "string" ? question.trim() : "";
	if (!normalized) return false;

	const lower = normalized.toLowerCase();
	if (lower.split(/\s+/).filter(Boolean).length < 2) return false;
	if (DEEP_MODE_ADMIN_BLOCKLIST.has(lower)) return false;

	return true;
}

export type ClaimCategory =
	| "technology"
	| "metric"
	| "experience"
	| "design"
	| "behavioral";

export interface Claim {
	field: string;
	text: string;
	category: ClaimCategory;
}

export function extractClaims(
	response: ConsciousModeStructuredResponse,
): Claim[] {
	const claims: Claim[] = [];

	if (response.openingReasoning) {
		claims.push({
			field: "openingReasoning",
			text: response.openingReasoning,
			category: "design",
		});
	}

	for (const item of response.implementationPlan) {
		claims.push({
			field: "implementationPlan",
			text: item,
			category: "design",
		});
	}

	for (const item of response.tradeoffs) {
		claims.push({ field: "tradeoffs", text: item, category: "design" });
	}

	for (const item of response.edgeCases) {
		claims.push({ field: "edgeCases", text: item, category: "design" });
	}

	for (const item of response.scaleConsiderations) {
		claims.push({
			field: "scaleConsiderations",
			text: item,
			category: "metric",
		});
	}

	for (const item of response.pushbackResponses) {
		claims.push({ field: "pushbackResponses", text: item, category: "design" });
	}

	if (response.codeTransition) {
		claims.push({
			field: "codeTransition",
			text: response.codeTransition,
			category: "technology",
		});
	}

	if (response.behavioralAnswer) {
		claims.push(...extractBehavioralClaims(response.behavioralAnswer));
	}

	return claims;
}

function extractBehavioralClaims(answer: ConsciousBehavioralAnswer): Claim[] {
	const claims: Claim[] = [];
	if (answer.situation)
		claims.push({
			field: "behavioralAnswer.situation",
			text: answer.situation,
			category: "behavioral",
		});
	if (answer.task)
		claims.push({
			field: "behavioralAnswer.task",
			text: answer.task,
			category: "behavioral",
		});
	if (answer.action)
		claims.push({
			field: "behavioralAnswer.action",
			text: answer.action,
			category: "behavioral",
		});
	if (answer.result)
		claims.push({
			field: "behavioralAnswer.result",
			text: answer.result,
			category: "metric",
		});
	return claims;
}

export interface ClaimVerificationResult {
	claim: Claim;
	supported: boolean;
	reason: string;
}

export interface BackgroundVerificationOutcome {
	supported: boolean;
	unsupportedClaims: string[];
	results: ClaimVerificationResult[];
}

export function createDefaultDeepModeState(): DeepModeState {
	return {
		enabled: false,
		adaptiveContextBudget: Infinity,
		consecutiveCurlFailures: 0,
		lastSuccessfulContextSize: 0,
	};
}
