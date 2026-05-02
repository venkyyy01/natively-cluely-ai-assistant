export interface ObservedQuestion {
	text: string;
	timestamp: number;
}

export class ObservedQuestionStore {
	private readonly maxQuestions: number;
	private questions: ObservedQuestion[] = [];

	constructor(maxQuestions: number = 20) {
		this.maxQuestions = maxQuestions;
	}

	noteQuestion(text: string, timestamp: number = Date.now()): void {
		const trimmed = text.trim();
		if (!trimmed) {
			return;
		}

		this.questions.push({ text: trimmed, timestamp });
		if (this.questions.length > this.maxQuestions) {
			this.questions.shift();
		}
	}

	getLastQuestion(): string | null {
		return this.questions.length > 0
			? this.questions[this.questions.length - 1].text
			: null;
	}

	getQuestions(limit: number = this.maxQuestions): ObservedQuestion[] {
		return this.questions.slice(-limit);
	}

	isLikelyGeneralIntent(
		lastInterviewerTurn: string | null = this.getLastQuestion(),
	): boolean {
		const text = (lastInterviewerTurn || "").trim().toLowerCase();
		if (!text) return true;

		if (text.length <= 6) return true;
		if (/\?$/.test(text) && text.length <= 12) return true;

		if (
			/^(what if|why|how|and|then|ok|okay|sure|next|continue)\??$/.test(text)
		) {
			return true;
		}

		return false;
	}

	reset(): void {
		this.questions = [];
	}
}
