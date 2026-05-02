import type { ConsciousModeStructuredResponse } from "../ConsciousMode";
import type { ExtractedConstraint } from "./ConstraintExtractor";
import type { InterviewPhase } from "./types";

export type DesignStateFacet =
	| "requirements"
	| "assumptions"
	| "architecture"
	| "api_contracts"
	| "data_model"
	| "tradeoffs"
	| "scaling"
	| "failure_modes"
	| "metrics"
	| "open_questions";

export type DesignStateSource =
	| "interviewer"
	| "constraint"
	| "reasoning"
	| "pinned";

export interface DesignStateEntry {
	facet: DesignStateFacet;
	text: string;
	normalized: string;
	timestamp: number;
	source: DesignStateSource;
	phase?: InterviewPhase;
	boost: number;
	keywords: string[];
}

export interface PersistedDesignStateState {
	currentObjective: string | null;
	updatedAt: number;
	entries: DesignStateEntry[];
	overflowCount?: number;
	lastOverflowAt?: number;
}

export interface DesignStateRetrievalEntry {
	facet: DesignStateFacet;
	text: string;
	timestamp: number;
	phase?: InterviewPhase;
	boost: number;
	source: DesignStateSource;
}

export interface DesignStateStoreStats {
	entryCount: number;
	maxTotalEntries: number;
	overflowCount: number;
	lastOverflowAt: number;
}

const FACET_ORDER: DesignStateFacet[] = [
	"open_questions",
	"requirements",
	"assumptions",
	"architecture",
	"api_contracts",
	"data_model",
	"tradeoffs",
	"scaling",
	"failure_modes",
	"metrics",
];

const FACET_LABELS: Record<DesignStateFacet, string> = {
	open_questions: "OPEN_QUESTIONS",
	requirements: "REQUIREMENTS",
	assumptions: "ASSUMPTIONS",
	architecture: "ARCHITECTURE_DECISIONS",
	api_contracts: "API_CONTRACTS",
	data_model: "DATA_MODEL",
	tradeoffs: "TRADEOFFS",
	scaling: "SCALING_PLAN",
	failure_modes: "FAILURE_MODES",
	metrics: "METRICS",
};

const FACET_BOOSTS: Record<DesignStateFacet, number> = {
	open_questions: 0.28,
	requirements: 0.24,
	assumptions: 0.18,
	architecture: 0.22,
	api_contracts: 0.2,
	data_model: 0.2,
	tradeoffs: 0.2,
	scaling: 0.22,
	failure_modes: 0.2,
	metrics: 0.18,
};

const MAX_FACET_ENTRIES = 14;
const MAX_TOTAL_ENTRIES = 100;

function normalizeText(value: string): string {
	return value.trim().replace(/\s+/g, " ");
}

function normalizeKey(value: string): string {
	return normalizeText(value).toLowerCase();
}

function tokenize(value: string): string[] {
	return Array.from(
		new Set(
			value
				.toLowerCase()
				.replace(/[^a-z0-9\s]/g, " ")
				.split(/\s+/)
				.filter((token) => token.length >= 3),
		),
	);
}

function isQuestionLike(value: string): boolean {
	return (
		/\?$/.test(value) ||
		/^(how|what|why|when|where|which|can|could|would|walk me through|tell me)/i.test(
			value,
		)
	);
}

function inferFacets(text: string, phase?: InterviewPhase): DesignStateFacet[] {
	const lower = text.toLowerCase();
	const facets = new Set<DesignStateFacet>();

	if (
		/(budget|timeline|deadline|month|week|quarter|engineer|team|region|tenant|user|qps|rps|throughput|latency|availability|consistency|compliance|privacy|cost|sla|slo|limit|constraint|requirement)/i.test(
			lower,
		)
	) {
		facets.add("requirements");
	}

	if (
		/(assume|assuming|let'?s assume|suppose|we can rely on|we can tolerate)/i.test(
			lower,
		)
	) {
		facets.add("assumptions");
	}

	if (
		/(architecture|component|service|pipeline|workflow|gateway|load balancer|cache|queue|database|redis|kafka|partitioner|coordinator|write path|read path)/i.test(
			lower,
		)
	) {
		facets.add("architecture");
	}

	if (
		/(api|endpoint|request|response|grpc|rest|contract|schema|interface|webhook|rpc)/i.test(
			lower,
		)
	) {
		facets.add("api_contracts");
	}

	if (
		/(data model|schema|table|index|entity|entities|ledger|partition key|primary key|secondary index|row|column|document shape)/i.test(
			lower,
		)
	) {
		facets.add("data_model");
	}

	if (
		/(tradeoff|trade-off|overhead|complexity|cost|operationally|consistency|availability|pros|cons)/i.test(
			lower,
		)
	) {
		facets.add("tradeoffs");
	}

	if (
		/(scale|scaling|shard|partition|hot key|hot tenant|fanout|capacity|millions?|billions?|burst|backpressure|replica)/i.test(
			lower,
		)
	) {
		facets.add("scaling");
	}

	if (
		/(failure|failover|retry|timeout|outage|degrade|degradation|recovery|clock skew|duplicate|idempot|poison|disaster|split brain)/i.test(
			lower,
		)
	) {
		facets.add("failure_modes");
	}

	if (
		/(metric|metrics|latency|p50|p95|p99|error rate|availability|throughput|saturation|queue depth|cpu|memory|utilization)/i.test(
			lower,
		)
	) {
		facets.add("metrics");
	}

	if (isQuestionLike(text)) {
		facets.add("open_questions");
	}

	if (facets.size === 0) {
		if (phase === "high_level_design" || phase === "deep_dive") {
			facets.add("architecture");
		} else if (phase === "requirements_gathering") {
			facets.add("requirements");
		}
	}

	return Array.from(facets);
}

function lexicalOverlap(queryTokens: string[], entryTokens: string[]): number {
	if (queryTokens.length === 0 || entryTokens.length === 0) {
		return 0;
	}

	const haystack = new Set(entryTokens);
	let hits = 0;
	for (const token of queryTokens) {
		if (haystack.has(token)) {
			hits += 1;
		}
	}

	return hits / queryTokens.length;
}

function facetAwareOverlap(
	facet: DesignStateFacet,
	queryTokens: string[],
	text: string,
	entryTokens: string[],
): number {
	const lexical = lexicalOverlap(queryTokens, entryTokens);
	const lower = text.toLowerCase();
	let bonus = 0;

	if (
		facet === "data_model" &&
		(queryTokens.includes("schema") ||
			queryTokens.includes("model") ||
			queryTokens.includes("data"))
	) {
		if (
			/(table|index|schema|append-only|ledger|entity|entities|partition key|secondary index)/i.test(
				lower,
			)
		) {
			bonus += 0.28;
		}
	}

	if (
		facet === "api_contracts" &&
		(queryTokens.includes("api") ||
			queryTokens.includes("contract") ||
			queryTokens.includes("interface"))
	) {
		if (
			/(api|endpoint|request|response|idempotent|webhook|grpc|rest|contract)/i.test(
				lower,
			)
		) {
			bonus += 0.26;
		}
	}

	if (
		facet === "failure_modes" &&
		(queryTokens.includes("failure") ||
			queryTokens.includes("failover") ||
			queryTokens.includes("reliability"))
	) {
		if (
			/(retry|timeout|failover|idempotent|duplicate|outage|degrade|recovery|clock skew)/i.test(
				lower,
			)
		) {
			bonus += 0.28;
		}
	}

	if (
		facet === "scaling" &&
		(queryTokens.includes("scale") ||
			queryTokens.includes("throughput") ||
			queryTokens.includes("hotspot"))
	) {
		if (
			/(shard|hot|throughput|capacity|partition|replica|fanout|backpressure)/i.test(
				lower,
			)
		) {
			bonus += 0.24;
		}
	}

	if (
		facet === "tradeoffs" &&
		(queryTokens.includes("tradeoff") || queryTokens.includes("tradeoffs"))
	) {
		bonus += 0.18;
	}

	return Math.min(1.2, lexical + bonus);
}

export class DesignStateStore {
	private currentObjective: string | null = null;
	private updatedAt: number = 0;
	private entries: DesignStateEntry[] = [];
	private overflowCount = 0;
	private lastOverflowAt = 0;

	reset(): void {
		this.currentObjective = null;
		this.updatedAt = 0;
		this.entries = [];
		this.overflowCount = 0;
		this.lastOverflowAt = 0;
	}

	noteInterviewerTurn(input: {
		transcript: string;
		timestamp: number;
		phase?: InterviewPhase;
		constraints?: ExtractedConstraint[];
	}): void {
		const transcript = normalizeText(input.transcript);
		if (!transcript) {
			return;
		}

		if (isQuestionLike(transcript)) {
			this.currentObjective = transcript;
		}

		for (const facet of inferFacets(transcript, input.phase)) {
			this.addEntry({
				facet,
				text: transcript,
				timestamp: input.timestamp,
				source: "interviewer",
				phase: input.phase,
				boost: FACET_BOOSTS[facet],
			});
		}

		for (const constraint of input.constraints || []) {
			const text = `[${constraint.type}] ${constraint.raw}`;
			this.addEntry({
				facet: "requirements",
				text,
				timestamp: input.timestamp,
				source: "constraint",
				phase: input.phase,
				boost: FACET_BOOSTS.requirements + 0.05,
			});
		}
	}

	notePinnedItem(
		text: string,
		label: string | undefined,
		timestamp: number,
		phase?: InterviewPhase,
	): void {
		const normalized = normalizeText(text);
		if (!normalized) {
			return;
		}

		const entryText = label ? `[${label}] ${normalized}` : normalized;
		const facets = inferFacets(entryText, phase);
		if (facets.length === 0) {
			facets.push("requirements");
		}

		for (const facet of facets) {
			this.addEntry({
				facet,
				text: entryText,
				timestamp,
				source: "pinned",
				phase,
				boost: FACET_BOOSTS[facet] + 0.06,
			});
		}
	}

	noteStructuredResponse(input: {
		question: string;
		response: ConsciousModeStructuredResponse;
		timestamp: number;
		phase?: InterviewPhase;
	}): void {
		const question = normalizeText(input.question);
		if (question) {
			this.currentObjective = question;
			this.addEntry({
				facet: "open_questions",
				text: question,
				timestamp: input.timestamp,
				source: "reasoning",
				phase: input.phase,
				boost: FACET_BOOSTS.open_questions,
			});
		}

		const { response } = input;

		if (response.openingReasoning) {
			this.addEntry({
				facet: "architecture",
				text: response.openingReasoning,
				timestamp: input.timestamp,
				source: "reasoning",
				phase: input.phase,
				boost: FACET_BOOSTS.architecture,
			});
		}

		for (const item of response.implementationPlan) {
			const facets = inferFacets(item, input.phase).filter(
				(facet) => facet !== "open_questions",
			);
			const resolvedFacets: DesignStateFacet[] =
				facets.length > 0 ? facets : ["architecture"];
			for (const facet of resolvedFacets) {
				this.addEntry({
					facet,
					text: item,
					timestamp: input.timestamp,
					source: "reasoning",
					phase: input.phase,
					boost: FACET_BOOSTS[facet],
				});
			}
		}

		for (const tradeoff of response.tradeoffs) {
			this.addEntry({
				facet: "tradeoffs",
				text: tradeoff,
				timestamp: input.timestamp,
				source: "reasoning",
				phase: input.phase,
				boost: FACET_BOOSTS.tradeoffs,
			});
		}

		for (const edgeCase of response.edgeCases) {
			this.addEntry({
				facet: "failure_modes",
				text: edgeCase,
				timestamp: input.timestamp,
				source: "reasoning",
				phase: input.phase,
				boost: FACET_BOOSTS.failure_modes,
			});
		}

		for (const scaleItem of response.scaleConsiderations) {
			this.addEntry({
				facet: "scaling",
				text: scaleItem,
				timestamp: input.timestamp,
				source: "reasoning",
				phase: input.phase,
				boost: FACET_BOOSTS.scaling,
			});
		}

		for (const pushback of response.pushbackResponses) {
			this.addEntry({
				facet: "tradeoffs",
				text: pushback,
				timestamp: input.timestamp,
				source: "reasoning",
				phase: input.phase,
				boost: FACET_BOOSTS.tradeoffs,
			});
		}
	}

	getRetrievalEntries(
		query: string,
		maxPerFacet: number = 2,
	): DesignStateRetrievalEntry[] {
		const queryTokens = tokenize(query);
		const now = Date.now();

		const selected: DesignStateRetrievalEntry[] = [];
		for (const facet of FACET_ORDER) {
			const facetEntries = this.entries
				.filter((entry) => entry.facet === facet)
				.map((entry) => {
					const ageMinutes = Math.max(0, (now - entry.timestamp) / 60_000);
					const recency = Math.max(0, 1 - ageMinutes / 90);
					const overlap = facetAwareOverlap(
						entry.facet,
						queryTokens,
						entry.text,
						entry.keywords,
					);
					return {
						entry,
						score: overlap * 0.65 + recency * 0.15 + entry.boost,
					};
				})
				.sort(
					(left, right) =>
						right.score - left.score ||
						right.entry.timestamp - left.entry.timestamp,
				)
				.slice(0, maxPerFacet);

			for (const { entry } of facetEntries) {
				selected.push({
					facet: entry.facet,
					text: `${FACET_LABELS[entry.facet]}: ${entry.text}`,
					timestamp: entry.timestamp,
					phase: entry.phase,
					boost: entry.boost,
					source: entry.source,
				});
			}
		}

		return selected;
	}

	buildContextBlock(query: string, maxPerFacet: number = 3): string {
		if (this.entries.length === 0 && !this.currentObjective) {
			return "";
		}

		const lines = ["<design_state>"];
		if (this.currentObjective) {
			lines.push(`CURRENT_OBJECTIVE: ${this.currentObjective}`);
		}

		const queryTokens = tokenize(query);
		const now = Date.now();

		for (const facet of FACET_ORDER) {
			const facetEntries = this.entries
				.filter((entry) => entry.facet === facet)
				.map((entry) => {
					const ageMinutes = Math.max(0, (now - entry.timestamp) / 60_000);
					const recency = Math.max(0, 1 - ageMinutes / 120);
					const overlap = facetAwareOverlap(
						entry.facet,
						queryTokens,
						entry.text,
						entry.keywords,
					);
					return {
						entry,
						score: overlap * 0.6 + recency * 0.1 + entry.boost,
					};
				})
				.sort(
					(left, right) =>
						right.score - left.score ||
						right.entry.timestamp - left.entry.timestamp,
				)
				.slice(0, maxPerFacet);

			if (facetEntries.length === 0) {
				continue;
			}

			lines.push(`${FACET_LABELS[facet]}:`);
			for (const { entry } of facetEntries) {
				lines.push(`- ${entry.text}`);
			}
		}

		lines.push("</design_state>");
		return lines.join("\n");
	}

	getPersistenceSnapshot(): PersistedDesignStateState {
		return {
			currentObjective: this.currentObjective,
			updatedAt: this.updatedAt,
			entries: this.entries.map((entry) => ({
				...entry,
				keywords: [...entry.keywords],
			})),
			overflowCount: this.overflowCount,
			lastOverflowAt: this.lastOverflowAt,
		};
	}

	restorePersistenceSnapshot(
		snapshot: PersistedDesignStateState | null | undefined,
	): void {
		if (!snapshot) {
			this.reset();
			return;
		}

		this.currentObjective = snapshot.currentObjective ?? null;
		this.updatedAt = snapshot.updatedAt ?? 0;
		this.overflowCount = snapshot.overflowCount ?? 0;
		this.lastOverflowAt = snapshot.lastOverflowAt ?? 0;
		this.entries = (snapshot.entries || []).map((entry) => ({
			...entry,
			text: normalizeText(entry.text),
			normalized: entry.normalized || normalizeKey(entry.text),
			keywords: entry.keywords?.length
				? Array.from(new Set(entry.keywords))
				: tokenize(entry.text),
			boost:
				typeof entry.boost === "number"
					? entry.boost
					: (FACET_BOOSTS[entry.facet] ?? 0.15),
		}));
		this.trimGlobalEntries(false);
	}

	getStorageStats(): DesignStateStoreStats {
		return {
			entryCount: this.entries.length,
			maxTotalEntries: MAX_TOTAL_ENTRIES,
			overflowCount: this.overflowCount,
			lastOverflowAt: this.lastOverflowAt,
		};
	}

	private addEntry(input: {
		facet: DesignStateFacet;
		text: string;
		timestamp: number;
		source: DesignStateSource;
		phase?: InterviewPhase;
		boost: number;
	}): void {
		const text = normalizeText(input.text);
		if (!text) {
			return;
		}

		const normalized = normalizeKey(text);
		const existingIndex = this.entries.findIndex(
			(entry) => entry.facet === input.facet && entry.normalized === normalized,
		);
		const entry: DesignStateEntry = {
			facet: input.facet,
			text,
			normalized,
			timestamp: input.timestamp,
			source: input.source,
			phase: input.phase,
			boost: input.boost,
			keywords: tokenize(text),
		};

		if (existingIndex >= 0) {
			this.entries[existingIndex] = {
				...this.entries[existingIndex],
				...entry,
				boost: Math.max(this.entries[existingIndex].boost, entry.boost),
			};
		} else {
			this.entries.push(entry);
		}

		this.updatedAt = Math.max(this.updatedAt, input.timestamp);
		this.trimFacet(input.facet);
		this.trimGlobalEntries();
	}

	private trimFacet(facet: DesignStateFacet): void {
		const facetEntries = this.entries
			.filter((entry) => entry.facet === facet)
			.sort((left, right) => right.timestamp - left.timestamp);

		if (facetEntries.length <= MAX_FACET_ENTRIES) {
			return;
		}

		const retain = new Set(
			facetEntries
				.slice(0, MAX_FACET_ENTRIES)
				.map((entry) => `${entry.facet}:${entry.normalized}`),
		);

		this.entries = this.entries.filter(
			(entry) =>
				entry.facet !== facet ||
				retain.has(`${entry.facet}:${entry.normalized}`),
		);
	}

	private trimGlobalEntries(emitAlert: boolean = true): void {
		if (this.entries.length <= MAX_TOTAL_ENTRIES) {
			return;
		}

		const before = this.entries.length;
		const sourceBoost: Record<DesignStateSource, number> = {
			pinned: 0.4,
			constraint: 0.25,
			reasoning: 0.15,
			interviewer: 0,
		};
		const retain = new Set(
			[...this.entries]
				.sort((left, right) => {
					const leftScore = left.boost + sourceBoost[left.source];
					const rightScore = right.boost + sourceBoost[right.source];
					return rightScore - leftScore || right.timestamp - left.timestamp;
				})
				.slice(0, MAX_TOTAL_ENTRIES)
				.map((entry) => `${entry.facet}:${entry.normalized}`),
		);

		this.entries = this.entries.filter((entry) =>
			retain.has(`${entry.facet}:${entry.normalized}`),
		);
		const removed = before - this.entries.length;
		if (removed <= 0) {
			return;
		}

		const previousOverflowCount = this.overflowCount;
		this.overflowCount += removed;
		this.lastOverflowAt = Date.now();
		if (
			emitAlert &&
			(previousOverflowCount === 0 || this.overflowCount % 25 === 0)
		) {
			console.warn("[DesignStateStore] Global entry cap applied:", {
				removed,
				entryCount: this.entries.length,
				maxTotalEntries: MAX_TOTAL_ENTRIES,
				overflowCount: this.overflowCount,
			});
		}
	}
}
