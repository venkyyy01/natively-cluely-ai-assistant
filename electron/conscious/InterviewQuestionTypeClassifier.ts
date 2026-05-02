/**
 * InterviewQuestionTypeClassifier
 *
 * Recognises the *kind* of interview question being asked so the response
 * strategy can match what the candidate actually needs to do to win:
 *
 *   - technical_deep_dive   System design, algorithm, language internals.
 *   - behavioral_star       "Tell me about a time…", STAR-format prompts.
 *   - cultural_fit          Values, team dynamics, why-this-company.
 *   - pushback_grilling     "Why?", "Are you sure?", "But what about…".
 *   - hypothetical          "What would you do if…", scenario simulations.
 *   - self_assessment       "What's your weakness?", "Why should we hire you?".
 *   - curveball             Off-script creative ("If you were an animal…").
 *   - logistical            Salary, start date, location, visa, notice period.
 *   - closing               "Do you have questions for us?", wrap-up.
 *   - general              Anything that doesn't fit above; fall back to
 *                          technical-deep-dive defaults but with a softer rigor.
 *
 * The classifier is deterministic and pure. Heavy reasoning happens in the
 * conscious LLM path; this is the cheap router that picks the strategy.
 */

import type { QuestionReaction } from "./QuestionReactionClassifier";

export type InterviewQuestionType =
	| "technical_deep_dive"
	| "behavioral_star"
	| "cultural_fit"
	| "pushback_grilling"
	| "hypothetical"
	| "self_assessment"
	| "curveball"
	| "logistical"
	| "closing"
	| "general";

export interface InterviewQuestionClassification {
	type: InterviewQuestionType;
	confidence: number;
	/** Specific cues that triggered the classification (debug + telemetry). */
	cues: string[];
	/** Optional secondary type when two categories tie (e.g. behavioral + cultural). */
	secondaryType?: InterviewQuestionType;
}

export interface InterviewClassificationContext {
	/** Most recent reaction signal from the orchestrator, when available. */
	reaction?: QuestionReaction | null;
	/** Whether this question lands inside an active reasoning thread. */
	insideActiveThread?: boolean;
	/** Whether the candidate is mid-coding-task (screenshot path). */
	liveCoding?: boolean;
}

interface CueMatcher {
	pattern: RegExp;
	type: InterviewQuestionType;
	weight: number;
	cue: string;
}

/**
 * Patterns are ordered by specificity. The classifier walks them in order and
 * accumulates weights per type; the highest weighted type wins. This lets a
 * single utterance vote for two types (e.g. "Tell me about a time you
 * disagreed with your manager" votes both `behavioral_star` and `cultural_fit`).
 */
const CUE_MATCHERS: CueMatcher[] = [
	// technical_deep_dive
	{
		pattern:
			/\b(design a|implement|build|architect|how would you (design|implement|build))\b/i,
		type: "technical_deep_dive",
		weight: 0.9,
		cue: "design_or_build",
	},
	{
		pattern: /\b(explain how|how does|how do (you|they|we))\b/i,
		type: "technical_deep_dive",
		weight: 0.7,
		cue: "explain_how",
	},
	{
		pattern:
			/\b(complexity|big o|time complexity|space complexity|scalability|latency|throughput|concurrency|distributed)\b/i,
		type: "technical_deep_dive",
		weight: 0.85,
		cue: "technical_vocabulary",
	},
	{
		pattern:
			/\b(system design|architecture|algorithm|data structure|database schema|api design)\b/i,
		type: "technical_deep_dive",
		weight: 0.9,
		cue: "system_design_term",
	},
	{
		pattern:
			/\b(shard|partition|replica|cache|queue|message broker|load balancer|rate limiter)\b/i,
		type: "technical_deep_dive",
		weight: 0.85,
		cue: "infra_component",
	},
	{
		pattern:
			/\b(redis|kafka|postgres|mysql|mongodb|kubernetes|docker|aws|gcp|azure|s3|lambda|elasticsearch|graphql)\b/i,
		type: "technical_deep_dive",
		weight: 0.8,
		cue: "technology_name",
	},

	// behavioral_star
	{
		pattern:
			/\b(tell me about a time|describe a situation|have you ever|give me an example of|walk me through a time)\b/i,
		type: "behavioral_star",
		weight: 0.95,
		cue: "behavioral_prompt",
	},
	{
		pattern:
			/\b(challenge|conflict|disagree|fail|mistake|difficult|hard|tough)\b/i,
		type: "behavioral_star",
		weight: 0.7,
		cue: "behavioral_keyword",
	},
	{
		pattern:
			/\b(led|managed|handled|dealt with|resolved|fixed|improved|built|shipped)\b/i,
		type: "behavioral_star",
		weight: 0.6,
		cue: "action_verb",
	},
	{
		pattern: /\b(star|behavioral|situation|task|action|result)\b/i,
		type: "behavioral_star",
		weight: 0.8,
		cue: "star_mention",
	},

	// cultural_fit
	{
		pattern:
			/\b(why this company|why are you interested|why do you want to work here)\b/i,
		type: "cultural_fit",
		weight: 0.9,
		cue: "why_company",
	},
	{
		pattern:
			/\b(values|culture|team dynamics|team culture|work environment|work style)\b/i,
		type: "cultural_fit",
		weight: 0.8,
		cue: "culture_keywords",
	},
	{
		pattern: /\b(remote vs (in-)?office|hybrid|on-site|work from home)\b/i,
		type: "cultural_fit",
		weight: 0.85,
		cue: "remote_office",
	},
	{
		pattern:
			/\b(manage up|manage down|collaborate|cross-functional|stakeholder|communication style)\b/i,
		type: "cultural_fit",
		weight: 0.75,
		cue: "collaboration_style",
	},
	{
		pattern:
			/\b(disagreement|conflict resolution|feedback|receiving feedback|giving feedback)\b/i,
		type: "cultural_fit",
		weight: 0.7,
		cue: "interpersonal",
	},
	{
		pattern: /\b(learning|growth|mentorship|mentor|coach|coaching)\b/i,
		type: "cultural_fit",
		weight: 0.6,
		cue: "growth_keywords",
	},

	// pushback_grilling
	{
		pattern:
			/\b(but what about|why not|why did you|why would you|are you sure)\b/i,
		type: "pushback_grilling",
		weight: 0.9,
		cue: "pushback_phrase",
	},
	{
		pattern:
			/\b(doesn't that|wouldn't that|what if (scale|load|concurrency|traffic) changes|what about (edge case|failure|scenario))\b/i,
		type: "pushback_grilling",
		weight: 0.85,
		cue: "challenge_assumption",
	},
	{
		pattern:
			/\b(i disagree|i'm not sure|that's not (quite|exactly) right|are you certain)\b/i,
		type: "pushback_grilling",
		weight: 0.88,
		cue: "explicit_disagreement",
	},
	{
		pattern:
			/\b(how would you handle|what would you do if|what happens when)\b/i,
		type: "pushback_grilling",
		weight: 0.6,
		cue: "follow_up_challenge",
	},

	// hypothetical
	{
		pattern:
			/\b(what would you do if|imagine|suppose|say you (have to|need to))\b/i,
		type: "hypothetical",
		weight: 0.9,
		cue: "hypothetical_marker",
	},
	{
		pattern: /\b(scenario|simulation|assume|let's say|pretend)\b/i,
		type: "hypothetical",
		weight: 0.75,
		cue: "scenario_keyword",
	},
	{
		pattern: /\b(in a world|if you could|given that|assuming)\b/i,
		type: "hypothetical",
		weight: 0.7,
		cue: "assumption_marker",
	},

	// self_assessment
	{
		pattern:
			/\b(your (weakness|strength|biggest weakness|greatest strength))\b/i,
		type: "self_assessment",
		weight: 0.95,
		cue: "weakness_strength",
	},
	{
		pattern:
			/\b(why should we hire you|what makes you a good fit|what value do you bring)\b/i,
		type: "self_assessment",
		weight: 0.9,
		cue: "why_hire",
	},
	{
		pattern:
			/\b(how would your (manager|team|colleagues) describe you|how do you see yourself)\b/i,
		type: "self_assessment",
		weight: 0.85,
		cue: "self_description",
	},
	{
		pattern: /\b(rate yourself|scale of 1-10|how good are you at)\b/i,
		type: "self_assessment",
		weight: 0.8,
		cue: "rating_prompt",
	},
	{
		pattern:
			/\b(area for improvement|something to work on|what do you need to improve)\b/i,
		type: "self_assessment",
		weight: 0.85,
		cue: "improvement_prompt",
	},

	// curveball
	{
		pattern:
			/\b(if you were (a|an)|sell me this|how many|estimate|brain teaser)\b/i,
		type: "curveball",
		weight: 0.9,
		cue: "curveball_marker",
	},
	{
		pattern: /\b(animal|color|superpower|historical figure|celebrity)\b/i,
		type: "curveball",
		weight: 0.7,
		cue: "creative_analogy",
	},
	{
		pattern: /\b(lunch|dinner|coffee|drink|vacation|desert island)\b/i,
		type: "curveball",
		weight: 0.6,
		cue: "creative_scenario",
	},
	{
		pattern: /\b(random|unexpected|surprise|off the top of your head)\b/i,
		type: "curveball",
		weight: 0.5,
		cue: "randomness_marker",
	},

	// logistical
	{
		pattern:
			/\b(salary|compensation|pay|rate|hourly|annual|base|bonus|equity|stock|rsu)\b/i,
		type: "logistical",
		weight: 0.95,
		cue: "compensation_keyword",
	},
	{
		pattern:
			/\b(start date|when can you start|notice period|two weeks|one month)\b/i,
		type: "logistical",
		weight: 0.9,
		cue: "timing_keyword",
	},
	{
		pattern: /\b(visa|sponsorship|work permit|green card|h1b|citizenship)\b/i,
		type: "logistical",
		weight: 0.9,
		cue: "visa_keyword",
	},
	{
		pattern: /\b(location|remote|relocate|move|commute|office|site)\b/i,
		type: "logistical",
		weight: 0.75,
		cue: "location_keyword",
	},
	{
		pattern: /\b(benefits|insurance|pto|vacation|holiday|401k|pension)\b/i,
		type: "logistical",
		weight: 0.8,
		cue: "benefits_keyword",
	},
	{
		pattern: /\b(expectation|range|budget|offer|negotiate)\b/i,
		type: "logistical",
		weight: 0.85,
		cue: "negotiation_keyword",
	},

	// closing
	{
		pattern:
			/\b(any questions for (us|me)|do you have any questions|questions for us)\b/i,
		type: "closing",
		weight: 0.95,
		cue: "questions_prompt",
	},
	{
		pattern:
			/\b(is there anything else|anything else you'd like to know|anything we missed)\b/i,
		type: "closing",
		weight: 0.9,
		cue: "closing_prompt",
	},
	{
		pattern: /\b(wrap up|we're at time|out of time|end of interview)\b/i,
		type: "closing",
		weight: 0.85,
		cue: "time_signal",
	},
];

const REACTION_BONUS: Record<
	string,
	Partial<Record<InterviewQuestionType, number>>
> = {
	pushback: { pushback_grilling: 0.4 },
	doubt: { pushback_grilling: 0.3 },
	topic_shift: { general: 0.2, technical_deep_dive: 0.1 },
	clarification: { technical_deep_dive: 0.15, behavioral_star: 0.1 },
};

const MIN_CONFIDENCE = 0.55;
const MAX_CONFIDENCE = 0.98;
const SECONDARY_TYPE_GAP = 0.15;

export class InterviewQuestionTypeClassifier {
	/**
	 * Classify a question into an interview type.
	 *
	 * Pure function: no I/O, no LLM. Safe to call on the hot path.
	 */
	classify(
		question: string,
		context?: InterviewClassificationContext,
	): InterviewQuestionClassification {
		const trimmed = question.trim();

		if (!trimmed) {
			return {
				type: "general",
				confidence: 0.5,
				cues: ["empty_question"],
			};
		}

		// Accumulate weights per type from pattern matches
		const weights = new Map<InterviewQuestionType, number>();
		const cues: string[] = [];

		for (const { pattern, type, weight, cue } of CUE_MATCHERS) {
			if (pattern.test(trimmed)) {
				weights.set(type, (weights.get(type) ?? 0) + weight);
				cues.push(cue);
			}
		}

		// Apply reaction bonus if available
		const reactionKind = context?.reaction?.kind;
		if (reactionKind && REACTION_BONUS[reactionKind]) {
			const bonus = REACTION_BONUS[reactionKind];
			for (const [type, bonusWeight] of Object.entries(bonus)) {
				weights.set(
					type as InterviewQuestionType,
					(weights.get(type as InterviewQuestionType) ?? 0) + bonusWeight,
				);
				cues.push(`reaction_bonus_${reactionKind}`);
			}
		}

		// Inside active thread boosts pushback (continuations of disagreement)
		if (context?.insideActiveThread) {
			weights.set(
				"pushback_grilling",
				(weights.get("pushback_grilling") ?? 0) + 0.25,
			);
			cues.push("inside_active_thread");
		}

		// Live coding boosts technical
		if (context?.liveCoding) {
			weights.set(
				"technical_deep_dive",
				(weights.get("technical_deep_dive") ?? 0) + 0.3,
			);
			cues.push("live_coding");
		}

		// If no patterns matched, default to technical_deep_dive with low confidence
		if (weights.size === 0) {
			return {
				type: "general",
				confidence: 0.6,
				cues: ["no_pattern_matched"],
			};
		}

		// Find highest-weighted type
		let winner: InterviewQuestionType = "general";
		let winnerWeight = 0;
		for (const [type, weight] of weights.entries()) {
			if (weight > winnerWeight) {
				winner = type;
				winnerWeight = weight;
			}
		}

		// Compute confidence
		const totalWeight = Array.from(weights.values()).reduce(
			(sum, w) => sum + w,
			0,
		);
		const rawConfidence = totalWeight > 0 ? winnerWeight / totalWeight : 0.5;
		const confidence = Math.max(
			MIN_CONFIDENCE,
			Math.min(MAX_CONFIDENCE, rawConfidence),
		);

		// Check for secondary type (close second)
		let secondaryType: InterviewQuestionType | undefined;
		let secondWeight = 0;
		for (const [type, weight] of weights.entries()) {
			if (type !== winner && weight > secondWeight) {
				secondWeight = weight;
				secondaryType = type;
			}
		}
		if (secondaryType && winnerWeight - secondWeight < SECONDARY_TYPE_GAP) {
			cues.push(`secondary_${secondaryType}`);
		}

		return {
			type: winner,
			confidence,
			cues,
			secondaryType,
		};
	}
}
