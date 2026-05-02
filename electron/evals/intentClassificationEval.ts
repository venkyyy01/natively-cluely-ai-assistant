import type { ConversationIntent } from "../llm/IntentClassifier";
import {
	FOUNDATION_INTENT_PROMPT_VERSION,
	FOUNDATION_INTENT_SCHEMA_VERSION,
} from "../llm/providers/FoundationIntentPromptAssets";
import { getIntentProviderErrorCode } from "../llm/providers/IntentInferenceProvider";

export interface IntentEvalCase {
	id: string;
	description: string;
	expectedIntent: ConversationIntent;
	lastInterviewerTurn: string;
	preparedTranscript: string;
	assistantResponseCount: number;
	tags?: string[];
}

export interface IntentEvalClassifierInput {
	lastInterviewerTurn: string;
	preparedTranscript: string;
	assistantResponseCount: number;
}

export interface IntentEvalClassifierResult {
	intent: ConversationIntent;
	confidence: number;
	providerUsed: string;
	fallbackReason?: string;
}

export interface IntentEvalOutcome {
	caseId: string;
	expectedIntent: ConversationIntent;
	predictedIntent: ConversationIntent;
	confidence: number;
	providerUsed: string;
	fallbackReason?: string;
}

export interface IntentEvalBucketSummary {
	label: string;
	minInclusive: number;
	maxInclusive: number;
	count: number;
	correct: number;
	accuracy: number;
}

export interface IntentEvalSummary {
	promptVersion?: string;
	schemaVersion?: string;
	total: number;
	correct: number;
	accuracy: number;
	providerSplit: Record<string, number>;
	fallbackRate: {
		count: number;
		rate: number;
	};
	fallbackReasons: Record<string, number>;
	perIntent: Record<
		ConversationIntent,
		{ total: number; correct: number; accuracy: number }
	>;
	confusionMatrix: Record<
		ConversationIntent,
		Record<ConversationIntent, number>
	>;
	confidenceBuckets: IntentEvalBucketSummary[];
}

export const INTENT_LABELS: readonly ConversationIntent[] = [
	"behavioral",
	"coding",
	"deep_dive",
	"clarification",
	"follow_up",
	"example_request",
	"summary_probe",
	"general",
];

interface ConfidenceBucketRange {
	label: string;
	minInclusive: number;
	maxInclusive: number;
}

const CONFIDENCE_BUCKET_RANGES: readonly ConfidenceBucketRange[] = [
	{ label: "0.00-0.19", minInclusive: 0.0, maxInclusive: 0.19 },
	{ label: "0.20-0.39", minInclusive: 0.2, maxInclusive: 0.39 },
	{ label: "0.40-0.59", minInclusive: 0.4, maxInclusive: 0.59 },
	{ label: "0.60-0.79", minInclusive: 0.6, maxInclusive: 0.79 },
	{ label: "0.80-1.00", minInclusive: 0.8, maxInclusive: 1.0 },
];

function createBaseSummary(): IntentEvalSummary {
	const perIntent = Object.fromEntries(
		INTENT_LABELS.map((intent) => [
			intent,
			{ total: 0, correct: 0, accuracy: 0 },
		]),
	) as Record<
		ConversationIntent,
		{ total: number; correct: number; accuracy: number }
	>;

	const confusionMatrix = Object.fromEntries(
		INTENT_LABELS.map((expectedIntent) => [
			expectedIntent,
			Object.fromEntries(
				INTENT_LABELS.map((predictedIntent) => [predictedIntent, 0]),
			) as Record<ConversationIntent, number>,
		]),
	) as Record<ConversationIntent, Record<ConversationIntent, number>>;

	return {
		promptVersion: FOUNDATION_INTENT_PROMPT_VERSION,
		schemaVersion: FOUNDATION_INTENT_SCHEMA_VERSION,
		total: 0,
		correct: 0,
		accuracy: 0,
		providerSplit: {},
		fallbackRate: {
			count: 0,
			rate: 0,
		},
		fallbackReasons: {},
		perIntent,
		confusionMatrix,
		confidenceBuckets: CONFIDENCE_BUCKET_RANGES.map((bucket) => ({
			...bucket,
			count: 0,
			correct: 0,
			accuracy: 0,
		})),
	};
}

function toSafeConfidence(value: number): number {
	if (!Number.isFinite(value)) {
		return 0;
	}
	return Math.min(1, Math.max(0, value));
}

function getBucketIndex(confidence: number): number {
	const safeConfidence = toSafeConfidence(confidence);
	for (let index = 0; index < CONFIDENCE_BUCKET_RANGES.length; index += 1) {
		if (safeConfidence <= CONFIDENCE_BUCKET_RANGES[index]!.maxInclusive) {
			return index;
		}
	}

	return CONFIDENCE_BUCKET_RANGES.length - 1;
}

function toRate(count: number, total: number): number {
	if (total <= 0) {
		return 0;
	}

	return count / total;
}

export async function runIntentEval(
	cases: IntentEvalCase[],
	classify: (
		input: IntentEvalClassifierInput,
	) => Promise<IntentEvalClassifierResult>,
): Promise<{ outcomes: IntentEvalOutcome[]; summary: IntentEvalSummary }> {
	const outcomes: IntentEvalOutcome[] = [];

	for (const testCase of cases) {
		try {
			const result = await classify({
				lastInterviewerTurn: testCase.lastInterviewerTurn,
				preparedTranscript: testCase.preparedTranscript,
				assistantResponseCount: testCase.assistantResponseCount,
			});

			outcomes.push({
				caseId: testCase.id,
				expectedIntent: testCase.expectedIntent,
				predictedIntent: result.intent,
				confidence: toSafeConfidence(result.confidence),
				providerUsed: result.providerUsed,
				fallbackReason: result.fallbackReason,
			});
		} catch (error) {
			const errorCode = getIntentProviderErrorCode(error);
			outcomes.push({
				caseId: testCase.id,
				expectedIntent: testCase.expectedIntent,
				predictedIntent: "general",
				confidence: 0,
				providerUsed: "error",
				fallbackReason: `classifier_error:${errorCode}`,
			});
		}
	}

	return {
		outcomes,
		summary: summarizeIntentEvalOutcomes(outcomes),
	};
}

export function summarizeIntentEvalOutcomes(
	outcomes: IntentEvalOutcome[],
): IntentEvalSummary {
	const summary = createBaseSummary();
	summary.total = outcomes.length;

	for (const outcome of outcomes) {
		const isCorrect = outcome.expectedIntent === outcome.predictedIntent;
		if (isCorrect) {
			summary.correct += 1;
		}

		summary.providerSplit[outcome.providerUsed] =
			(summary.providerSplit[outcome.providerUsed] ?? 0) + 1;

		const perIntentRow = summary.perIntent[outcome.expectedIntent];
		perIntentRow.total += 1;
		if (isCorrect) {
			perIntentRow.correct += 1;
		}

		summary.confusionMatrix[outcome.expectedIntent][outcome.predictedIntent] +=
			1;

		const bucket =
			summary.confidenceBuckets[getBucketIndex(outcome.confidence)];
		bucket.count += 1;
		if (isCorrect) {
			bucket.correct += 1;
		}

		if (outcome.fallbackReason) {
			summary.fallbackRate.count += 1;
			summary.fallbackReasons[outcome.fallbackReason] =
				(summary.fallbackReasons[outcome.fallbackReason] ?? 0) + 1;
		}
	}

	summary.accuracy = toRate(summary.correct, summary.total);
	summary.fallbackRate.rate = toRate(summary.fallbackRate.count, summary.total);

	for (const intent of INTENT_LABELS) {
		const row = summary.perIntent[intent];
		row.accuracy = toRate(row.correct, row.total);
	}

	for (const bucket of summary.confidenceBuckets) {
		bucket.accuracy = toRate(bucket.correct, bucket.count);
	}

	return summary;
}

function formatPercent(value: number): string {
	return `${(value * 100).toFixed(1)}%`;
}

function formatRatio(correct: number, total: number): string {
	return `${correct}/${total}`;
}

function formatProviderSplit(providerSplit: Record<string, number>): string {
	const keys = Object.keys(providerSplit).sort();
	if (keys.length === 0) {
		return "none";
	}

	return keys
		.map((provider) => `${provider}:${providerSplit[provider]}`)
		.join(", ");
}

function formatFallbackReasons(reasons: Record<string, number>): string {
	const keys = Object.keys(reasons).sort();
	if (keys.length === 0) {
		return "none";
	}

	return keys.map((reason) => `${reason}:${reasons[reason]}`).join(", ");
}

function formatConfusionMatrix(summary: IntentEvalSummary): string[] {
	const header = ["expected\\predicted", ...INTENT_LABELS].join("\t");
	const rows = INTENT_LABELS.map((expectedIntent) => {
		const rowCounts = INTENT_LABELS.map((predictedIntent) =>
			String(summary.confusionMatrix[expectedIntent][predictedIntent]),
		);
		return [expectedIntent, ...rowCounts].join("\t");
	});

	return [header, ...rows];
}

export function formatIntentEvalSummary(summary: IntentEvalSummary): string {
	const lines: string[] = [];
	lines.push(`Prompt version: ${summary.promptVersion ?? "unknown"}`);
	lines.push(`Schema version: ${summary.schemaVersion ?? "unknown"}`);
	lines.push(`Total cases: ${summary.total}`);
	lines.push(
		`Overall accuracy: ${formatPercent(summary.accuracy)} (${formatRatio(summary.correct, summary.total)})`,
	);
	lines.push(`Provider split: ${formatProviderSplit(summary.providerSplit)}`);
	lines.push(
		`Fallback rate: ${formatPercent(summary.fallbackRate.rate)} (${formatRatio(summary.fallbackRate.count, summary.total)})` +
			` | reasons: ${formatFallbackReasons(summary.fallbackReasons)}`,
	);
	lines.push("");
	lines.push("Per-intent accuracy:");
	for (const intent of INTENT_LABELS) {
		const row = summary.perIntent[intent];
		lines.push(
			`- ${intent}: ${formatPercent(row.accuracy)} (${formatRatio(row.correct, row.total)})`,
		);
	}
	lines.push("");
	lines.push("Confidence buckets:");
	for (const bucket of summary.confidenceBuckets) {
		lines.push(
			`- ${bucket.label}: ${formatPercent(bucket.accuracy)} (${formatRatio(bucket.correct, bucket.count)})`,
		);
	}
	lines.push("");
	lines.push("Confusion matrix (expected x predicted):");
	lines.push(...formatConfusionMatrix(summary));

	return lines.join("\n");
}

export const DEFAULT_INTENT_EVAL_CASES: IntentEvalCase[] = [
	{
		id: "behavioral-01-conflict",
		description: "Classic behavioral conflict story prompt",
		expectedIntent: "behavioral",
		lastInterviewerTurn:
			"Tell me about a time you disagreed with your manager and how you resolved it.",
		preparedTranscript:
			"[INTERVIEWER]: Tell me about a time you disagreed with your manager and how you resolved it.",
		assistantResponseCount: 0,
		tags: ["baseline", "behavioral"],
	},
	{
		id: "behavioral-02-influence",
		description: "Behavioral influence-without-authority prompt",
		expectedIntent: "behavioral",
		lastInterviewerTurn:
			"Describe a situation where you had to influence people without formal authority.",
		preparedTranscript:
			"[INTERVIEWER]: Describe a situation where you had to influence people without formal authority.",
		assistantResponseCount: 0,
		tags: ["baseline", "behavioral"],
	},
	{
		id: "behavioral-03-failure",
		description: "Behavioral failure and learning prompt",
		expectedIntent: "behavioral",
		lastInterviewerTurn:
			"Walk me through a failure you owned end to end and what you learned.",
		preparedTranscript:
			"[INTERVIEWER]: Walk me through a failure you owned end to end and what you learned.",
		assistantResponseCount: 0,
		tags: ["baseline", "behavioral", "adversarial_paraphrase"],
	},
	{
		id: "coding-01-debounce",
		description: "Direct implementation question",
		expectedIntent: "coding",
		lastInterviewerTurn: "Implement debouncing in JavaScript.",
		preparedTranscript: "[INTERVIEWER]: Implement debouncing in JavaScript.",
		assistantResponseCount: 0,
		tags: ["baseline", "coding"],
	},
	{
		id: "coding-02-debug-duplicates",
		description: "Debugging prompt",
		expectedIntent: "coding",
		lastInterviewerTurn:
			"Debug this function: it should deduplicate IDs but still returns duplicates.",
		preparedTranscript:
			"[INTERVIEWER]: Debug this function: it should deduplicate IDs but still returns duplicates.",
		assistantResponseCount: 0,
		tags: ["baseline", "coding"],
	},
	{
		id: "coding-03-lru",
		description: "Data structure implementation prompt",
		expectedIntent: "coding",
		lastInterviewerTurn: "Design and code an LRU cache in TypeScript.",
		preparedTranscript:
			"[INTERVIEWER]: Design and code an LRU cache in TypeScript.",
		assistantResponseCount: 0,
		tags: ["baseline", "coding", "adversarial_paraphrase"],
	},
	{
		id: "deep-dive-01-kafka-rabbitmq",
		description: "Tradeoff reasoning prompt",
		expectedIntent: "deep_dive",
		lastInterviewerTurn:
			"Why would you choose Kafka over RabbitMQ for this architecture?",
		preparedTranscript:
			"[INTERVIEWER]: Why would you choose Kafka over RabbitMQ for this architecture?",
		assistantResponseCount: 0,
		tags: ["baseline", "deep_dive"],
	},
	{
		id: "deep-dive-02-cap-theorem",
		description: "Reasoning question on consistency and availability",
		expectedIntent: "deep_dive",
		lastInterviewerTurn:
			"Explain the tradeoffs you made between consistency and availability.",
		preparedTranscript:
			"[INTERVIEWER]: Explain the tradeoffs you made between consistency and availability.",
		assistantResponseCount: 0,
		tags: ["baseline", "deep_dive"],
	},
	{
		id: "deep-dive-03-cache-freshness",
		description: "Adversarial phrasing with word conflict but technical target",
		expectedIntent: "deep_dive",
		lastInterviewerTurn:
			"How would you handle conflict between cache freshness and latency?",
		preparedTranscript:
			"[INTERVIEWER]: How would you handle conflict between cache freshness and latency?",
		assistantResponseCount: 0,
		tags: ["deep_dive", "ambiguous_negative", "adversarial_paraphrase"],
	},
	{
		id: "clarification-01-eventual-consistency",
		description: "Clarification with prior assistant claim",
		expectedIntent: "clarification",
		lastInterviewerTurn:
			"When you say eventual consistency here, what exactly do you mean?",
		preparedTranscript: [
			"[ASSISTANT]: I would prioritize availability and rely on eventual consistency for replicas.",
			"[INTERVIEWER]: When you say eventual consistency here, what exactly do you mean?",
		].join("\n"),
		assistantResponseCount: 1,
		tags: ["baseline", "clarification", "transcript_dependent"],
	},
	{
		id: "clarification-02-backpressure",
		description: "Clarification prompt with unpack language",
		expectedIntent: "clarification",
		lastInterviewerTurn:
			"Can you unpack what you meant by backpressure in your queue workers?",
		preparedTranscript: [
			"[ASSISTANT]: We add explicit backpressure by slowing producers when queue lag spikes.",
			"[INTERVIEWER]: Can you unpack what you meant by backpressure in your queue workers?",
		].join("\n"),
		assistantResponseCount: 1,
		tags: ["baseline", "clarification", "transcript_dependent"],
	},
	{
		id: "clarification-03-scope",
		description: "Clarification with short follow-up context",
		expectedIntent: "clarification",
		lastInterviewerTurn:
			"Sorry, can you clarify the scope boundary you drew between services?",
		preparedTranscript: [
			"[ASSISTANT]: I split ownership between ingestion and enrichment services.",
			"[INTERVIEWER]: Sorry, can you clarify the scope boundary you drew between services?",
		].join("\n"),
		assistantResponseCount: 1,
		tags: ["clarification", "transcript_dependent", "adversarial_paraphrase"],
	},
	{
		id: "follow-up-01-what-next",
		description: "Continuation after outage timeline response",
		expectedIntent: "follow_up",
		lastInterviewerTurn: "What happened next after you paused the deployment?",
		preparedTranscript: [
			"[ASSISTANT]: I paused the rollout and paged the on-call backend team.",
			"[INTERVIEWER]: What happened next after you paused the deployment?",
		].join("\n"),
		assistantResponseCount: 1,
		tags: ["baseline", "follow_up", "transcript_dependent"],
	},
	{
		id: "follow-up-02-then-what",
		description: "Continuation with pronoun-heavy phrasing",
		expectedIntent: "follow_up",
		lastInterviewerTurn: "And then what did you do once the queue recovered?",
		preparedTranscript: [
			"[ASSISTANT]: We drained the backlog after applying consumer throttling.",
			"[INTERVIEWER]: And then what did you do once the queue recovered?",
		].join("\n"),
		assistantResponseCount: 1,
		tags: ["follow_up", "transcript_dependent", "adversarial_paraphrase"],
	},
	{
		id: "follow-up-03-after-that",
		description: "Follow-up continuation with after-that cue",
		expectedIntent: "follow_up",
		lastInterviewerTurn: "After that, how did you roll out the fix safely?",
		preparedTranscript: [
			"[ASSISTANT]: We validated in staging and used canaries for 5% traffic.",
			"[INTERVIEWER]: After that, how did you roll out the fix safely?",
		].join("\n"),
		assistantResponseCount: 1,
		tags: ["follow_up", "transcript_dependent"],
	},
	{
		id: "example-request-01-concrete",
		description: "Concrete example ask",
		expectedIntent: "example_request",
		lastInterviewerTurn: "Can you give me one concrete example of that?",
		preparedTranscript: [
			"[ASSISTANT]: I usually start by instrumenting latency and queue lag first.",
			"[INTERVIEWER]: Can you give me one concrete example of that?",
		].join("\n"),
		assistantResponseCount: 1,
		tags: ["baseline", "example_request"],
	},
	{
		id: "example-request-02-specific-instance",
		description: "Specific instance request",
		expectedIntent: "example_request",
		lastInterviewerTurn:
			"What is one specific instance where this tradeoff hurt you?",
		preparedTranscript: [
			"[ASSISTANT]: We accepted eventual consistency to keep write latency low.",
			"[INTERVIEWER]: What is one specific instance where this tradeoff hurt you?",
		].join("\n"),
		assistantResponseCount: 1,
		tags: ["example_request", "transcript_dependent"],
	},
	{
		id: "example-request-03-api-payload",
		description: "Ambiguous example phrase but coding target",
		expectedIntent: "coding",
		lastInterviewerTurn:
			"Can you show an example API payload and handler code for this endpoint?",
		preparedTranscript:
			"[INTERVIEWER]: Can you show an example API payload and handler code for this endpoint?",
		assistantResponseCount: 0,
		tags: ["ambiguous_negative", "adversarial_paraphrase", "coding"],
	},
	{
		id: "summary-probe-01-you-saying",
		description: "Summary probe with confirmation framing",
		expectedIntent: "summary_probe",
		lastInterviewerTurn:
			"So you are saying writes stay synchronous while fan-out is async, right?",
		preparedTranscript: [
			"[ASSISTANT]: I keep writes synchronous for correctness and move fan-out async.",
			"[INTERVIEWER]: So you are saying writes stay synchronous while fan-out is async, right?",
		].join("\n"),
		assistantResponseCount: 1,
		tags: ["baseline", "summary_probe", "transcript_dependent"],
	},
	{
		id: "summary-probe-02-make-sure",
		description: "Summary probe with make-sure cue",
		expectedIntent: "summary_probe",
		lastInterviewerTurn:
			"Let me make sure I got this: you sharded by tenant before region?",
		preparedTranscript: [
			"[ASSISTANT]: Yes, tenant-first sharding gave us cleaner isolation.",
			"[INTERVIEWER]: Let me make sure I got this: you sharded by tenant before region?",
		].join("\n"),
		assistantResponseCount: 1,
		tags: ["summary_probe", "transcript_dependent"],
	},
	{
		id: "summary-probe-03-to-summarize",
		description: "Summary probe with explicit summarize phrase",
		expectedIntent: "summary_probe",
		lastInterviewerTurn:
			"So to summarize, your first step is hot partition isolation?",
		preparedTranscript: [
			"[ASSISTANT]: First I isolate hot partitions, then rebalance consumer capacity.",
			"[INTERVIEWER]: So to summarize, your first step is hot partition isolation?",
		].join("\n"),
		assistantResponseCount: 1,
		tags: ["summary_probe", "transcript_dependent", "adversarial_paraphrase"],
	},
	{
		id: "general-01-role-interest",
		description: "General interview motivation",
		expectedIntent: "general",
		lastInterviewerTurn: "What interests you most about this role?",
		preparedTranscript:
			"[INTERVIEWER]: What interests you most about this role?",
		assistantResponseCount: 0,
		tags: ["baseline", "general"],
	},
	{
		id: "general-02-team-style",
		description: "General team-fit question",
		expectedIntent: "general",
		lastInterviewerTurn:
			"What kind of team environment helps you do your best work?",
		preparedTranscript:
			"[INTERVIEWER]: What kind of team environment helps you do your best work?",
		assistantResponseCount: 0,
		tags: ["general"],
	},
	{
		id: "general-03-candidate-questions",
		description: "General closing question",
		expectedIntent: "general",
		lastInterviewerTurn: "Do you have any questions for us about the position?",
		preparedTranscript:
			"[INTERVIEWER]: Do you have any questions for us about the position?",
		assistantResponseCount: 0,
		tags: ["general"],
	},
	{
		id: "ambiguous-01-example-vs-behavioral",
		description:
			"Example ask without past-life cue should stay example_request",
		expectedIntent: "example_request",
		lastInterviewerTurn:
			"Can you give a concrete example of retry jitter in practice?",
		preparedTranscript:
			"[INTERVIEWER]: Can you give a concrete example of retry jitter in practice?",
		assistantResponseCount: 0,
		tags: ["ambiguous_negative", "example_request", "adversarial_paraphrase"],
	},
	{
		id: "ambiguous-02-clarify-vs-follow-up",
		description: "Clarify wording with prior answer should stay clarification",
		expectedIntent: "clarification",
		lastInterviewerTurn: "Can you clarify that part about replay protection?",
		preparedTranscript: [
			"[ASSISTANT]: We added nonce tracking to prevent replay attacks in webhook handlers.",
			"[INTERVIEWER]: Can you clarify that part about replay protection?",
		].join("\n"),
		assistantResponseCount: 1,
		tags: ["ambiguous_negative", "clarification", "transcript_dependent"],
	},
	{
		id: "ambiguous-03-follow-up-vs-summary",
		description:
			"Continuation prompt without summary framing should stay follow_up",
		expectedIntent: "follow_up",
		lastInterviewerTurn: "And what did you do after that?",
		preparedTranscript: [
			"[ASSISTANT]: I split traffic by tenant and observed the error budget burn rate.",
			"[INTERVIEWER]: And what did you do after that?",
		].join("\n"),
		assistantResponseCount: 1,
		tags: ["ambiguous_negative", "follow_up", "transcript_dependent"],
	},
];
