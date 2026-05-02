import { pipeline } from "@xenova/transformers";

export interface EntailmentResult {
	label: "entailment" | "contradiction" | "neutral";
	score: number;
}

export class SemanticEntailmentVerifier {
	private model: any | null = null;
	private modelLoadPromise: Promise<void> | null = null;
	private modelLoadError = false;

	private static readonly ENTAILMENT_THRESHOLD = 0.7;
	private static readonly MAX_TOKENS = 512;

	constructor() {
		// Lazy load model on first use
	}

	private async ensureModelLoaded(): Promise<void> {
		if (this.model) {
			return;
		}

		if (this.modelLoadError) {
			throw new Error(
				"NLI model failed to load, semantic entailment verification disabled",
			);
		}

		if (this.modelLoadPromise) {
			return this.modelLoadPromise;
		}

		this.modelLoadPromise = (async () => {
			try {
				// Use the correct NLI model - cross-encoder for NLI tasks
				this.model = await pipeline(
					"text-classification",
					"Xenova/cross-encoder-nli-deberta-v3-small",
				);
			} catch (error) {
				console.warn(
					"[SemanticEntailmentVerifier] Failed to load NLI model:",
					error,
				);
				this.modelLoadError = true;
				throw error;
			}
		})();

		return this.modelLoadPromise;
	}

	/**
	 * Check if a claim is entailed by the grounding text using NLI.
	 * Returns true if the claim is supported (entailment or neutral with high confidence).
	 * Returns false if the claim is contradicted or not supported.
	 */
	async checkEntailment(
		claim: string,
		groundingText: string,
	): Promise<EntailmentResult> {
		try {
			await this.ensureModelLoaded();
			if (!this.model) {
				throw new Error("Model not initialized");
			}

			// Truncate to max tokens if needed
			const truncatedClaim = this.truncateToTokens(
				claim,
				SemanticEntailmentVerifier.MAX_TOKENS / 2,
			);
			const truncatedGrounding = this.truncateToTokens(
				groundingText,
				SemanticEntailmentVerifier.MAX_TOKENS / 2,
			);

			// For cross-encoder NLI, we format as [CLS] premise [SEP] hypothesis [SEP]
			const input = `${truncatedGrounding} ${truncatedClaim}`;

			const result = await this.model(input);

			// The model returns labels and scores
			// Map the output to our standard format
			const labelMap: Record<
				string,
				"entailment" | "contradiction" | "neutral"
			> = {
				LABEL_0: "contradiction",
				LABEL_1: "entailment",
				LABEL_2: "neutral",
			};

			const topLabel = result[0]?.label || "neutral";
			const topScore = result[0]?.score || 0;

			return {
				label: labelMap[topLabel] || "neutral",
				score: topScore,
			};
		} catch (error) {
			console.warn(
				"[SemanticEntailmentVerifier] Entailment check failed:",
				error,
			);
			// On failure, return neutral to be conservative
			return {
				label: "neutral",
				score: 0,
			};
		}
	}

	/**
	 * Check if a single unsupported term can be semantically verified against grounding.
	 * Used as a defensive check after token-based verification fails.
	 */
	async verifyTermSemantically(
		term: string,
		groundingText: string,
	): Promise<boolean> {
		const claim = `The system uses ${term}.`;
		const result = await this.checkEntailment(claim, groundingText);

		// If the claim is entailed with high confidence, consider it supported
		if (
			result.label === "entailment" &&
			result.score >= SemanticEntailmentVerifier.ENTAILMENT_THRESHOLD
		) {
			return true;
		}

		// If neutral, conservatively consider it unsupported (caller will use original verdict)
		return false;
	}

	/**
	 * Batch verify multiple terms against grounding text.
	 * Returns a map of term -> isSupported (true if semantically supported).
	 */
	async verifyTermsSemantically(
		terms: string[],
		groundingText: string,
	): Promise<Map<string, boolean>> {
		const results = new Map<string, boolean>();

		for (const term of terms) {
			const isSupported = await this.verifyTermSemantically(
				term,
				groundingText,
			);
			results.set(term, isSupported);
		}

		return results;
	}

	/**
	 * Truncate text to approximately the given number of tokens.
	 * Rough approximation: 1 token ≈ 4 characters for English text.
	 */
	private truncateToTokens(text: string, maxTokens: number): string {
		const maxChars = maxTokens * 4;
		if (text.length <= maxChars) {
			return text;
		}

		// Truncate at word boundary
		const truncated = text.slice(0, maxChars);
		const lastSpace = truncated.lastIndexOf(" ");
		if (lastSpace > 0) {
			return truncated.slice(0, lastSpace);
		}

		return truncated;
	}

	isModelLoaded(): boolean {
		return this.model !== null;
	}

	hasLoadError(): boolean {
		return this.modelLoadError;
	}
}
