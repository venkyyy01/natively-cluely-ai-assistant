// electron/conscious/InterviewPhase.ts

import type { RuntimeBudgetScheduler } from "../runtime/RuntimeBudgetScheduler";
import type { InterviewPhase } from "./types";

type ClassifierLane = Pick<RuntimeBudgetScheduler, "submit">;

interface PhaseSignal {
	phase: InterviewPhase;
	keywords: string[];
	patterns: RegExp[];
	transitionsFrom: (InterviewPhase | "any")[];
}

const PHASE_SIGNALS: PhaseSignal[] = [
	{
		phase: "requirements_gathering",
		keywords: [
			"clarify",
			"assume",
			"constraints",
			"requirements",
			"scope",
			"users",
			"scale",
		],
		patterns: [
			/what if/i,
			/how many/i,
			/can I assume/i,
			/do we need/i,
			/what's the/i,
		],
		transitionsFrom: ["any"],
	},
	{
		phase: "high_level_design",
		keywords: [
			"architecture",
			"components",
			"services",
			"API",
			"database",
			"system",
			"design",
		],
		patterns: [
			/high level/i,
			/overall design/i,
			/main components/i,
			/at a high level/i,
		],
		transitionsFrom: ["requirements_gathering", "behavioral_story"],
	},
	{
		phase: "deep_dive",
		keywords: [
			"specifically",
			"implementation",
			"algorithm",
			"data structure",
			"details",
		],
		patterns: [
			/how would you/i,
			/walk me through/i,
			/let's dive into/i,
			/explain how/i,
		],
		transitionsFrom: [
			"high_level_design",
			"scaling_discussion",
			"implementation",
		],
	},
	{
		phase: "implementation",
		keywords: [
			"code",
			"write",
			"implement",
			"class",
			"function",
			"method",
			"solution",
		],
		patterns: [
			/can you code/i,
			/write the/i,
			/implement a/i,
			/let me write/i,
			/coding/i,
		],
		transitionsFrom: ["deep_dive", "high_level_design", "complexity_analysis"],
	},
	{
		phase: "complexity_analysis",
		keywords: [
			"complexity",
			"Big O",
			"time",
			"space",
			"optimize",
			"runtime",
			"performance",
		],
		patterns: [
			/what's the complexity/i,
			/can you optimize/i,
			/time and space/i,
			/O\(.*\)/i,
		],
		transitionsFrom: ["implementation", "deep_dive"],
	},
	{
		phase: "scaling_discussion",
		keywords: [
			"scale",
			"million",
			"distributed",
			"sharding",
			"replication",
			"load",
			"throughput",
		],
		patterns: [
			/how would this scale/i,
			/million users/i,
			/what if.*10x/i,
			/at scale/i,
		],
		transitionsFrom: ["high_level_design", "complexity_analysis", "deep_dive"],
	},
	{
		phase: "failure_handling",
		keywords: [
			"failure",
			"fallback",
			"retry",
			"error",
			"crash",
			"recovery",
			"resilience",
		],
		patterns: [
			/what happens if/i,
			/how do you handle/i,
			/what about failures/i,
			/if.*fails/i,
		],
		transitionsFrom: ["scaling_discussion", "deep_dive", "high_level_design"],
	},
	{
		phase: "behavioral_story",
		keywords: [
			"tell me about",
			"experience",
			"example",
			"time when",
			"challenge",
			"conflict",
		],
		patterns: [
			/tell me about a time/i,
			/describe a situation/i,
			/give me an example/i,
			/past experience/i,
		],
		transitionsFrom: ["any"],
	},
	{
		phase: "wrap_up",
		keywords: [
			"questions for me",
			"anything else",
			"thank you",
			"next steps",
			"timeline",
		],
		patterns: [
			/any questions/i,
			/that's all/i,
			/we're done/i,
			/questions for us/i,
		],
		transitionsFrom: ["any"],
	},
];

export interface PhaseDetectionResult {
	phase: InterviewPhase;
	confidence: number;
	signals: string[];
}

export interface PhaseDetectorOptions {
	classifierLane?: ClassifierLane;
}

export class InterviewPhaseDetector {
	private currentPhase: InterviewPhase = "requirements_gathering";
	private readonly classifierLane?: ClassifierLane;

	constructor(options: PhaseDetectorOptions = {}) {
		this.classifierLane = options.classifierLane;
	}

	detectPhase(
		transcript: string,
		currentPhase: InterviewPhase,
		recentContext: string[],
	): PhaseDetectionResult {
		if (this.classifierLane) {
			const detected = this.detectPhaseOnCurrentThread(
				transcript,
				currentPhase,
				recentContext,
			);
			void this.classifierLane
				.submit("semantic", async () => detected)
				.catch((error: unknown) => {
					console.warn(
						"[InterviewPhaseDetector] Semantic classifier lane rejected detection task:",
						error,
					);
				});
			return detected;
		}

		return this.detectPhaseOnCurrentThread(
			transcript,
			currentPhase,
			recentContext,
		);
	}

	private detectPhaseOnCurrentThread(
		transcript: string,
		currentPhase: InterviewPhase,
		_recentContext: string[],
	): PhaseDetectionResult {
		const scores = new Map<
			InterviewPhase,
			{ score: number; signals: string[] }
		>();
		const lowerTranscript = transcript.toLowerCase();

		for (const signal of PHASE_SIGNALS) {
			let score = 0;
			const matchedSignals: string[] = [];

			// Keyword matching (0.35 weight) - use minimum of 1 match = 0.15 base
			const keywordMatches = signal.keywords.filter((k) =>
				lowerTranscript.includes(k.toLowerCase()),
			);
			if (keywordMatches.length > 0) {
				const keywordScore = Math.min(
					0.35,
					0.15 + (keywordMatches.length / signal.keywords.length) * 0.2,
				);
				score += keywordScore;
				matchedSignals.push(...keywordMatches.map((k) => `keyword:${k}`));
			}

			// Pattern matching (0.45 weight) - use minimum of 1 match = 0.25 base
			const patternMatches = signal.patterns.filter((p) => p.test(transcript));
			if (patternMatches.length > 0) {
				const patternScore = Math.min(
					0.45,
					0.25 + (patternMatches.length / signal.patterns.length) * 0.2,
				);
				score += patternScore;
				matchedSignals.push(
					...patternMatches.map((p) => `pattern:${p.source.slice(0, 20)}`),
				);
			}

			// Transition validity (0.20 weight)
			if (
				signal.transitionsFrom.includes(currentPhase) ||
				signal.transitionsFrom.includes("any")
			) {
				score += 0.2;
				matchedSignals.push("valid_transition");
			}

			scores.set(signal.phase, { score, signals: matchedSignals });
		}

		// Find highest scoring phase
		let bestPhase = currentPhase;
		let bestScore = 0;
		let bestSignals: string[] = [];

		scores.forEach(({ score, signals }, phase) => {
			if (score > bestScore) {
				bestScore = score;
				bestPhase = phase;
				bestSignals = signals;
			}
		});

		// Require minimum confidence to change phase
		const PHASE_CHANGE_THRESHOLD = 0.4;
		if (bestPhase !== currentPhase && bestScore < PHASE_CHANGE_THRESHOLD) {
			return {
				phase: currentPhase,
				confidence: scores.get(currentPhase)?.score || 0,
				signals: scores.get(currentPhase)?.signals || [],
			};
		}

		this.currentPhase = bestPhase;
		return { phase: bestPhase, confidence: bestScore, signals: bestSignals };
	}

	getCurrentPhase(): InterviewPhase {
		return this.currentPhase;
	}

	setPhase(phase: InterviewPhase): void {
		this.currentPhase = phase;
	}

	reset(): void {
		this.currentPhase = "requirements_gathering";
	}
}
