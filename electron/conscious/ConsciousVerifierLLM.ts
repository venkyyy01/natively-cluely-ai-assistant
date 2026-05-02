import type {
	ConsciousVerificationResult,
	ConsciousVerifierJudge,
	ConsciousVerifierJudgeInput,
} from "./ConsciousVerifier";

interface StructuredJudgeClient {
	generateContentStructured(message: string): Promise<string>;
	hasStructuredGenerationCapability?(): boolean;
}

interface JudgePayload {
	ok: boolean;
	reason?: string;
	confidence?: number;
}

const CONSCIOUS_VERIFIER_JUDGE_TIMEOUT_MS = 900;

function parseJudgePayload(raw: string): JudgePayload | null {
	const trimmed = raw.trim();
	if (!trimmed) {
		return null;
	}

	const jsonCandidate = trimmed
		.replace(/^```json\s*/i, "")
		.replace(/^```\s*/i, "")
		.replace(/```$/i, "")
		.trim();

	try {
		const parsed = JSON.parse(jsonCandidate) as Partial<JudgePayload>;
		if (typeof parsed.ok !== "boolean") {
			return null;
		}
		return {
			ok: parsed.ok,
			reason: typeof parsed.reason === "string" ? parsed.reason : undefined,
			confidence:
				typeof parsed.confidence === "number" ? parsed.confidence : undefined,
		};
	} catch {
		return null;
	}
}

export class ConsciousVerifierLLM implements ConsciousVerifierJudge {
	constructor(
		private readonly client: StructuredJudgeClient,
		private readonly timeoutMs: number = CONSCIOUS_VERIFIER_JUDGE_TIMEOUT_MS,
	) {}

	async judge(
		input: ConsciousVerifierJudgeInput,
	): Promise<ConsciousVerificationResult | null> {
		if (typeof this.client.generateContentStructured !== "function") {
			return null;
		}

		if (
			this.client.hasStructuredGenerationCapability &&
			!this.client.hasStructuredGenerationCapability()
		) {
			return null;
		}

		const prompt = [
			"You are a strict but conservative verifier for interview answer suggestions.",
			"The interviewer audio is confirmed. The user answer state may be inferred from previous suggestions.",
			"Reject only when the answer is clearly weak, off-target, duplicate, or missing the type of content the interviewer requested.",
			'Return ONLY valid JSON: {"ok": boolean, "reason": string, "confidence": number}.',
			`QUESTION: ${input.question}`,
			`ROUTE_THREAD_ACTION: ${input.route.threadAction}`,
			`REACTION_KIND: ${input.reaction?.kind ?? "none"}`,
			`REACTION_TARGETS: ${input.reaction?.targetFacets?.join(", ") || "none"}`,
			`HYPOTHESIS_SUMMARY: ${input.hypothesis?.latestSuggestedAnswer || "none"}`,
			`HYPOTHESIS_CONFIDENCE: ${input.hypothesis?.confidence?.toFixed(2) ?? "0.00"}`,
			`STRUCTURED_RESPONSE_JSON: ${JSON.stringify(input.response)}`,
			"If acceptable, return ok=true. If not acceptable, return ok=false with a short snake_case reason.",
		].join("\n\n");

		const timeoutSentinel = Symbol("judge-timeout");
		const judged = await Promise.race([
			this.client.generateContentStructured(prompt),
			new Promise<symbol>((resolve) =>
				setTimeout(() => resolve(timeoutSentinel), this.timeoutMs),
			),
		]);

		if (judged === timeoutSentinel) {
			return null;
		}

		const parsed = parseJudgePayload(judged as string);
		if (!parsed) {
			return null;
		}

		return {
			ok: parsed.ok,
			reason: parsed.reason,
		};
	}
}
