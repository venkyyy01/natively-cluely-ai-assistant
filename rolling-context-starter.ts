export type RollingRole = "external" | "user" | "assistant";

export interface LiveTurn {
	role: RollingRole;
	text: string;
	timestamp: number;
	final: boolean;
}

export interface RollingContextItem {
	role: RollingRole;
	text: string;
	timestamp: number;
}

export interface AssistantMemoryItem {
	text: string;
	timestamp: number;
	sourceContext?: string;
}

export interface SummaryCompressor {
	summarize(input: string): Promise<string>;
}

export interface RollingContextOptions {
	recentWindowMs?: number;
	maxRecentItems?: number;
	transcriptCompactionThreshold?: number;
	transcriptCompactionBatchSize?: number;
	maxCompressedEpochs?: number;
	duplicateWindowMs?: number;
	assistantHistoryLimit?: number;
}

export interface PromptContextResult {
	recentTranscript: string;
	previousAssistantResponses: string[];
	compressedHistory: string[];
	pendingExternalTurn?: string;
}

const DEFAULT_OPTIONS: Required<RollingContextOptions> = {
	recentWindowMs: 120_000,
	maxRecentItems: 500,
	transcriptCompactionThreshold: 1800,
	transcriptCompactionBatchSize: 500,
	maxCompressedEpochs: 5,
	duplicateWindowMs: 500,
	assistantHistoryLimit: 10,
};

export class RollingContextManager {
	private readonly options: Required<RollingContextOptions>;
	private readonly compressor?: SummaryCompressor;

	private recentItems: RollingContextItem[] = [];
	private fullTranscript: LiveTurn[] = [];
	private assistantHistory: AssistantMemoryItem[] = [];
	private compressedEpochs: string[] = [];
	private pendingExternalTurn: LiveTurn | null = null;
	private compacting = false;

	constructor(
		options: RollingContextOptions = {},
		compressor?: SummaryCompressor,
	) {
		this.options = { ...DEFAULT_OPTIONS, ...options };
		this.compressor = compressor;
	}

	addTranscriptTurn(turn: LiveTurn): void {
		const text = normalizeText(turn.text);
		if (!text) return;

		if (!turn.final && turn.role === "external") {
			this.pendingExternalTurn = { ...turn, text };
			return;
		}

		if (!turn.final) return;

		const normalizedTurn = { ...turn, text };
		const duplicate = this.recentItems[this.recentItems.length - 1];
		if (
			duplicate &&
			duplicate.role === normalizedTurn.role &&
			duplicate.text === normalizedTurn.text &&
			Math.abs(duplicate.timestamp - normalizedTurn.timestamp) <
				this.options.duplicateWindowMs
		) {
			return;
		}

		this.recentItems.push({
			role: normalizedTurn.role,
			text: normalizedTurn.text,
			timestamp: normalizedTurn.timestamp,
		});

		this.fullTranscript.push(normalizedTurn);
		this.pendingExternalTurn = null;
		this.evictRecentWindow();
		void this.compactIfNeeded();
	}

	addAssistantMessage(text: string, sourceContext?: string): void {
		const cleaned = normalizeText(text);
		if (!cleaned || cleaned.length < 2) return;

		const now = Date.now();
		this.recentItems.push({ role: "assistant", text: cleaned, timestamp: now });
		this.fullTranscript.push({
			role: "assistant",
			text: cleaned,
			timestamp: now,
			final: true,
		});
		this.assistantHistory.push({
			text: cleaned,
			timestamp: now,
			sourceContext,
		});
		if (this.assistantHistory.length > this.options.assistantHistoryLimit) {
			this.assistantHistory = this.assistantHistory.slice(
				-this.options.assistantHistoryLimit,
			);
		}

		this.evictRecentWindow();
		void this.compactIfNeeded();
	}

	flushPendingExternalTurn(): void {
		if (!this.pendingExternalTurn) return;
		this.addTranscriptTurn({ ...this.pendingExternalTurn, final: true });
		this.pendingExternalTurn = null;
	}

	getRecentItems(windowMs = this.options.recentWindowMs): RollingContextItem[] {
		const cutoff = Date.now() - windowMs;
		return this.recentItems.filter((item) => item.timestamp >= cutoff);
	}

	buildPromptContext(
		windowMs = this.options.recentWindowMs,
	): PromptContextResult {
		const recentItems = this.getRecentItems(windowMs);
		return {
			recentTranscript: formatPromptTranscript(recentItems),
			previousAssistantResponses: this.assistantHistory
				.slice(-3)
				.map((item) =>
					item.text.length > 200 ? `${item.text.slice(0, 200)}...` : item.text,
				),
			compressedHistory: [...this.compressedEpochs],
			pendingExternalTurn: this.pendingExternalTurn?.text,
		};
	}

	getFullSessionTranscript(): LiveTurn[] {
		return [...this.fullTranscript];
	}

	getFullSessionContext(): string {
		const recentTranscript = this.fullTranscript
			.map((turn) => `[${turn.role.toUpperCase()}]: ${turn.text}`)
			.join("\n");

		if (!this.compressedEpochs.length) return recentTranscript;

		return [
			"[EARLIER SESSION HISTORY]",
			this.compressedEpochs.join("\n---\n"),
			"",
			"[RECENT SESSION TRANSCRIPT]",
			recentTranscript,
		].join("\n");
	}

	reset(): void {
		this.recentItems = [];
		this.fullTranscript = [];
		this.assistantHistory = [];
		this.compressedEpochs = [];
		this.pendingExternalTurn = null;
		this.compacting = false;
	}

	private evictRecentWindow(): void {
		const cutoff = Date.now() - this.options.recentWindowMs;
		this.recentItems = this.recentItems.filter(
			(item) => item.timestamp >= cutoff,
		);
		if (this.recentItems.length > this.options.maxRecentItems) {
			this.recentItems = this.recentItems.slice(-this.options.maxRecentItems);
		}
	}

	private async compactIfNeeded(): Promise<void> {
		if (this.compacting) return;
		if (
			this.fullTranscript.length <= this.options.transcriptCompactionThreshold
		)
			return;

		this.compacting = true;
		try {
			const batch = this.fullTranscript.slice(
				0,
				this.options.transcriptCompactionBatchSize,
			);
			const summaryInput = batch
				.map((turn) => `[${turn.role.toUpperCase()}]: ${turn.text}`)
				.join("\n");

			let summary: string;
			if (this.compressor) {
				try {
					summary = await this.compressor.summarize(summaryInput);
				} catch {
					summary = fallbackSummary(batch);
				}
			} else {
				summary = fallbackSummary(batch);
			}

			this.compressedEpochs.push(summary);
			if (this.compressedEpochs.length > this.options.maxCompressedEpochs) {
				this.compressedEpochs = this.compressedEpochs.slice(
					-this.options.maxCompressedEpochs,
				);
			}

			this.fullTranscript = this.fullTranscript.slice(
				this.options.transcriptCompactionBatchSize,
			);
		} finally {
			this.compacting = false;
		}
	}
}

export function cleanTranscriptForPrompt(
	turns: RollingContextItem[],
	maxTurns = 12,
): RollingContextItem[] {
	const cleaned = turns
		.map((turn) => ({ ...turn, text: stripFillerWords(turn.text) }))
		.filter((turn) => isMeaningful(turn.role, turn.text));

	if (cleaned.length <= maxTurns) return cleaned;

	const externalTurns = cleaned
		.filter((turn) => turn.role === "external")
		.slice(-6);
	const otherTurns = cleaned.filter((turn) => turn.role !== "external");
	const remaining = Math.max(maxTurns - externalTurns.length, 0);
	const selected = [...externalTurns, ...otherTurns.slice(-remaining)];
	return selected.sort((a, b) => a.timestamp - b.timestamp);
}

export function formatPromptTranscript(turns: RollingContextItem[]): string {
	return cleanTranscriptForPrompt(turns)
		.map((turn) => `[${turn.role.toUpperCase()}]: ${turn.text}`)
		.join("\n");
}

function normalizeText(text: string): string {
	return text.trim().replace(/\s+/g, " ");
}

function isMeaningful(role: RollingRole, text: string): boolean {
	if (role === "external") return text.length >= 5;
	const wordCount = text.split(/\s+/).filter(Boolean).length;
	if (wordCount < 3) return false;
	return text.length >= 10;
}

function stripFillerWords(text: string): string {
	const filler = new Set([
		"uh",
		"um",
		"ah",
		"hmm",
		"like",
		"basically",
		"actually",
		"so",
		"well",
		"okay",
		"ok",
		"yeah",
		"yes",
		"right",
		"sure",
		"gotcha",
		"alright",
	]);

	const words = text
		.toLowerCase()
		.split(/\s+/)
		.filter((word) => !filler.has(word.replace(/[.,!?;:]/g, "")));

	return words.join(" ").replace(/\s+/g, " ").trim();
}

function fallbackSummary(batch: LiveTurn[]): string {
	const preview = batch
		.slice(0, 3)
		.map((turn) => turn.text.slice(0, 60))
		.join("; ");
	return `[Earlier discussion compressed: ${batch.length} turns. Preview: ${preview}]`;
}
