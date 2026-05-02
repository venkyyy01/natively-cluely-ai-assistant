export type QuestionType =
	| "clarification"
	| "information"
	| "confirmation"
	| "rhetorical";

export interface QuestionDetection {
	isQuestion: boolean;
	confidence: number;
	questionType?: QuestionType;
}

const QUESTION_WORDS =
	/^(?:what|who|where|when|why|how|which|can|could|would|should|is|are|do|does|did|will|have|has)\b/i;
const QUESTION_ENDING = /\?\s*$/;
const CONFIRMATION_PATTERNS =
	/(?:right|correct|isn'?t it|don'?t you think|wouldn'?t you say)\b/i;
const CLARIFICATION_PATTERNS =
	/(?:what do you mean|could you clarify|can you explain|what exactly)\b/i;

export function detectQuestion(text: string): QuestionDetection {
	const trimmed = text.trim();
	if (!trimmed) {
		return { isQuestion: false, confidence: 0 };
	}

	const hasQuestionMark = QUESTION_ENDING.test(trimmed);
	const startsWithQuestionWord = QUESTION_WORDS.test(trimmed);

	let confidence = 0;
	if (hasQuestionMark) confidence += 0.6;
	if (startsWithQuestionWord) confidence += 0.3;

	let questionType: QuestionType | undefined;

	if (CLARIFICATION_PATTERNS.test(trimmed)) {
		questionType = "clarification";
		confidence = Math.max(confidence, 0.8);
	} else if (CONFIRMATION_PATTERNS.test(trimmed)) {
		questionType = "confirmation";
		confidence = Math.max(confidence, 0.7);
	} else if (confidence > 0.5) {
		questionType = "information";
	}

	return {
		isQuestion: confidence > 0.5,
		confidence: Math.min(confidence, 1),
		questionType,
	};
}
