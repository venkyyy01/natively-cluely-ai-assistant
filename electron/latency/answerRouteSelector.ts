import { classifyConsciousModeQuestion } from "../ConsciousMode";
import type { AnswerRoute } from "./AnswerLatencyTracker";

function normalizeQuestion(text: string | null | undefined): string {
	return (text || "")
		.toLowerCase()
		.replace(/[.,!?;:()[\]{}"“”]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

const PROFILE_PHRASES = [
	"tell me about yourself",
	"walk me through your resume",
	"walk me through your background",
	"tell me about your background",
	"why are you a fit for this role",
	"tell me about a project you worked on",
] as const;

const PROFILE_BEHAVIORAL_PATTERNS = [
	/\btell me about a time\b/i,
	/\bdescribe a time\b/i,
	/\bdescribe a situation\b/i,
	/\bshare an experience\b/i,
	/\bgive me an example\b/i,
	/\bwalk me through\b/i,
	/\bhow (did|do) you handle\b/i,
	/\bhow do you manage\b/i,
	/\bwhat is your .*style\b/i,
	/\bhow do you make .*decision/i,
	/\bhow do you influence\b/i,
	/\bhow do you prioritize\b/i,
	/\bconflict\b/i,
	/\bdisagreed\b/i,
	/\bdisagreement\b/i,
	/\bfailure\b/i,
	/\bmistake\b/i,
	/\bstakeholder\b/i,
	/\bmentor\b/i,
	/\bproject you led\b/i,
	/\bowned end to end\b/i,
] as const;

const KNOWLEDGE_DIRECT = [
	"why this company",
	"why do you want to work here",
	"why do you want to join",
	"what do you know about our company",
	"what do you know about us",
	"why this role",
	"why this team",
	"why are you interested in this role",
] as const;

const KNOWLEDGE_QUALIFIERS = [
	"our company",
	"our team",
	"this company",
	"this team",
	"this role",
] as const;
const KNOWLEDGE_STEMS = [
	"why",
	"what do you know",
	"how would you fit",
	"how do you align",
] as const;

export interface RouteSelectorInput {
	explicitManual: boolean;
	explicitFollowUp: boolean;
	consciousModeEnabled: boolean;
	profileModeEnabled: boolean;
	hasProfile: boolean;
	hasKnowledgeData: boolean;
	latestQuestion: string | null | undefined;
	activeReasoningThread: any;
}

export function isProfileRequiredQuestion(
	latestQuestion: string | null | undefined,
): boolean {
	const normalized = normalizeQuestion(latestQuestion);
	if (!normalized) return false;
	if (PROFILE_PHRASES.some((phrase) => normalized.includes(phrase)))
		return true;
	if (PROFILE_BEHAVIORAL_PATTERNS.some((pattern) => pattern.test(normalized)))
		return true;
	return /^what experience do you have with .+ in your previous role$/.test(
		normalized,
	);
}

export function isKnowledgeRequiredQuestion(
	latestQuestion: string | null | undefined,
): boolean {
	const normalized = normalizeQuestion(latestQuestion);
	if (!normalized) return false;
	if (KNOWLEDGE_DIRECT.some((phrase) => normalized.includes(phrase)))
		return true;
	return (
		KNOWLEDGE_QUALIFIERS.some((q) => normalized.includes(q)) &&
		KNOWLEDGE_STEMS.some((s) => normalized.includes(s))
	);
}

export function selectAnswerRoute(input: RouteSelectorInput): AnswerRoute {
	if (input.explicitManual) return "manual_answer";
	if (input.explicitFollowUp) return "follow_up_refinement";

	const resolvedQuestion = input.latestQuestion || "";
	if (input.consciousModeEnabled) {
		const route = classifyConsciousModeQuestion(
			resolvedQuestion,
			input.activeReasoningThread,
		);
		if (route.qualifies) return "conscious_answer";
	}

	if (
		input.profileModeEnabled &&
		input.hasProfile &&
		isProfileRequiredQuestion(resolvedQuestion)
	) {
		return "enriched_standard_answer";
	}

	if (input.hasKnowledgeData && isKnowledgeRequiredQuestion(resolvedQuestion)) {
		return "enriched_standard_answer";
	}

	return "fast_standard_answer";
}
