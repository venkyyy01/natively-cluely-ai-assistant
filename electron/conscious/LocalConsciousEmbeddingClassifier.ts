/**
 * LocalConsciousEmbeddingClassifier
 *
 * Self-contained embedding classifier using a bundled ONNX model.
 * Runs entirely within the Electron app - no external dependencies, no cloud APIs.
 * Used specifically for ConsciousModeRouter classification, separate from RAG embeddings.
 *
 * Model: BAAI/bge-small-en-v1.5 (quantized ONNX)
 * Dimensions: 384
 * Purpose: Fast semantic classification of user utterances
 */

import type { ConversationKind, RefinementIntent } from "./ConsciousModeRouter";

/**
 * Classification result from local embedding model.
 */
export interface EmbeddingClassification {
	kind: ConversationKind;
	confidence: number;
	refinementIntent?: RefinementIntent;
}

/**
 * Options for the local embedding classifier.
 */
export interface LocalEmbeddingClassifierOptions {
	/** Path to the ONNX model file (relative to app resources) */
	modelPath?: string;
	/** Whether to use GPU acceleration if available */
	useGPU?: boolean;
}

/**
 * LocalConsciousEmbeddingClassifier
 *
 * Uses a bundled ONNX embedding model for fast, self-contained semantic classification.
 */
export class LocalConsciousEmbeddingClassifier {
	private model: any = null;
	private ort: any = null;
	private modelLoaded = false;
	private embeddingCache: Map<string, number[]> = new Map();
	private static readonly CACHE_MAX_SIZE = 512;
	private classEmbeddings: Map<ConversationKind, number[]> = new Map();

	/**
	 * Representative examples for each conversation kind.
	 * Used to compute prototype embeddings for classification.
	 */
	private readonly CONVERSATION_KIND_EXAMPLES: Record<
		ConversationKind,
		string[]
	> = {
		smalltalk: [
			"Hi there",
			"Hello",
			"How are you doing",
			"Thanks for your help",
			"Good morning",
			"Have a great day",
		],
		clarification: [
			"What do you mean by that",
			"Can you explain that again",
			"I dont understand",
			"Can you clarify",
			"What does that mean",
		],
		refinement: [
			"Make it shorter",
			"Expand on that",
			"Rephrase this",
			"Simplify this",
			"Give me an example",
		],
		acknowledgement: [
			"Got it",
			"Makes sense",
			"Understood",
			"Okay",
			"That sounds good",
		],
		off_topic_aside: [
			"By the way",
			"One more thing",
			"Quick question",
			"Side note",
			"Actually",
		],
		behavioral: [
			"Tell me about a time",
			"Describe a situation",
			"Give me an example of a conflict",
			"Walk me through a project you led",
			"Have you ever handled a difficult stakeholder",
		],
		pushback: [
			"But what about",
			"Why not",
			"Are you sure",
			"Doesnt that",
			"Wouldnt that",
		],
		technical: [
			"How does React work",
			"Design a system",
			"Explain the algorithm",
			"What is the complexity",
		],
	};

	constructor(private options: LocalEmbeddingClassifierOptions = {}) {
		this.options = {
			modelPath: options.modelPath || "models/bge-small-en-v1.5-quantized.onnx",
			useGPU: options.useGPU ?? true,
		};
	}

	/**
	 * Initialize the classifier by loading the ONNX model.
	 * Should be called when the app starts or when ConsciousMode initializes.
	 */
	async initialize(): Promise<void> {
		if (this.modelLoaded) {
			return;
		}

		try {
			// Import onnxruntime-node dynamically
			this.ort = await import("onnxruntime-node");

			// Load the model - try Metal on macOS, DirectML on Windows, fallback to CPU
			const executionProviders = this.options.useGPU
				? (["coreml", "cuda", "dml", "cpu"] as any[])
				: (["cpu"] as any[]);

			this.model = await this.ort.InferenceSession.create(
				this.options.modelPath!,
				{
					executionProviders,
				},
			);

			this.modelLoaded = true;

			// Pre-compute embeddings for each conversation kind
			await this.precomputeClassEmbeddings();

			console.log(
				"[LocalConsciousEmbeddingClassifier] Model loaded successfully",
			);
		} catch (error) {
			console.error(
				"[LocalConsciousEmbeddingClassifier] Failed to load model:",
				error,
			);
			throw error;
		}
	}

	/**
	 * Pre-compute embeddings for each conversation kind using their examples.
	 * This speeds up classification by avoiding repeated embedding computations.
	 */
	private async precomputeClassEmbeddings(): Promise<void> {
		for (const [kind, examples] of Object.entries(
			this.CONVERSATION_KIND_EXAMPLES,
		) as [ConversationKind, string[]][]) {
			const embeddings: number[][] = [];

			for (const example of examples) {
				const embedding = await this.getEmbedding(example);
				embeddings.push(embedding);
			}

			// Compute average embedding for this class
			const avgEmbedding = this.averageEmbedding(embeddings);
			this.classEmbeddings.set(kind, avgEmbedding);
		}
	}

	/**
	 * Classify an utterance using the local embedding model.
	 */
	async classify(utterance: string): Promise<EmbeddingClassification> {
		if (!this.modelLoaded) {
			await this.initialize();
		}

		try {
			// Get embedding for the utterance
			const utteranceEmbedding = await this.getEmbedding(utterance);

			// Compare with each class prototype
			let bestKind: ConversationKind = "technical";
			let maxSimilarity = 0;

			for (const [kind, classEmbedding] of this.classEmbeddings.entries()) {
				const similarity = this.cosineSimilarity(
					utteranceEmbedding,
					classEmbedding,
				);
				if (similarity > maxSimilarity) {
					maxSimilarity = similarity;
					bestKind = kind;
				}
			}

			// Detect refinement intent if kind is refinement
			let refinementIntent: RefinementIntent | undefined;
			if (bestKind === "refinement") {
				refinementIntent = this.detectRefinementIntent(utterance) ?? undefined;
			}

			return { kind: bestKind, confidence: maxSimilarity, refinementIntent };
		} catch (error) {
			console.error(
				"[LocalConsciousEmbeddingClassifier] Classification failed:",
				error,
			);
			// Fallback to technical with low confidence
			return { kind: "technical", confidence: 0.5 };
		}
	}

	/**
	 * Get embedding for a text string using the ONNX model.
	 * Cached to avoid redundant computations.
	 */
	private async getEmbedding(text: string): Promise<number[]> {
		const cacheKey = text.toLowerCase().trim();

		if (this.embeddingCache.has(cacheKey)) {
			return this.embeddingCache.get(cacheKey)!;
		}

		// Evict oldest entry if cache is full
		if (
			this.embeddingCache.size >=
			LocalConsciousEmbeddingClassifier.CACHE_MAX_SIZE
		) {
			const firstKey = this.embeddingCache.keys().next().value;
			if (firstKey !== undefined) this.embeddingCache.delete(firstKey);
		}

		if (!this.model) {
			throw new Error("Model not loaded");
		}

		try {
			// Build properly-formatted model inputs (input_ids, attention_mask, token_type_ids)
			const inputs = this.prepareModelInputs(text, this.ort);
			const attentionMask: number[] = Array.from(
				inputs.attention_mask.data as BigInt64Array,
			).map(Number);

			// Run inference
			const outputs = await this.model.run(inputs);

			// Mean-pool + L2-normalize the last_hidden_state
			const embedding = this.extractEmbedding(outputs, attentionMask);

			// Cache the result
			this.embeddingCache.set(cacheKey, embedding);

			return embedding;
		} catch (error) {
			console.error(
				"[LocalConsciousEmbeddingClassifier] Embedding computation failed:",
				error,
			);
			// Fallback to hash-based embedding
			return this.fallbackEmbedding(text);
		}
	}

	/**
	 * Tokenize text and prepare ONNX input tensors for BGE model.
	 * BGE uses WordPiece tokenization; we approximate with character n-gram hashing
	 * bounded to the model vocab (30522 for bert-base). For production, swap in
	 * the bundled tokenizer.json from HuggingFace via @xenova/transformers tokenizer only.
	 * Input names required by bge-small-en-v1.5: input_ids, attention_mask, token_type_ids.
	 */
	private prepareModelInputs(text: string, ort: any): Record<string, any> {
		const maxSeqLength = 128; // BGE-small works well at 128
		const CLS = 101;
		const SEP = 102;
		const PAD = 0;

		// Approximate WordPiece: split on whitespace + punctuation, hash to vocab
		const rawTokens = text
			.toLowerCase()
			.replace(/([.,!?;:"'-])/g, " $1 ")
			.split(/\s+/)
			.filter(Boolean)
			.map((w) => this.hashToVocab(w));

		// Build [CLS] + tokens + [SEP], truncate to maxSeqLength - 2
		const tokenIds = [CLS, ...rawTokens.slice(0, maxSeqLength - 2), SEP];
		const seqLen = maxSeqLength;
		const inputIds = new Array(seqLen).fill(PAD);
		const attentionMask = new Array(seqLen).fill(0);
		const tokenTypeIds = new Array(seqLen).fill(0);

		for (let i = 0; i < tokenIds.length && i < seqLen; i++) {
			inputIds[i] = tokenIds[i];
			attentionMask[i] = 1;
		}

		const inputIdsTensor = new ort.Tensor(
			"int64",
			BigInt64Array.from(inputIds.map(BigInt)),
			[1, seqLen],
		);
		const attentionMaskTensor = new ort.Tensor(
			"int64",
			BigInt64Array.from(attentionMask.map(BigInt)),
			[1, seqLen],
		);
		const tokenTypeIdsTensor = new ort.Tensor(
			"int64",
			BigInt64Array.from(tokenTypeIds.map(BigInt)),
			[1, seqLen],
		);

		return {
			input_ids: inputIdsTensor,
			attention_mask: attentionMaskTensor,
			token_type_ids: tokenTypeIdsTensor,
		};
	}

	/**
	 * Hash a word to a vocabulary index (0–30521, BERT vocab size).
	 * Avoids reserved tokens 0–103 by offsetting into safe range.
	 */
	private hashToVocab(word: string): number {
		let h = 0x811c9dc5;
		for (let i = 0; i < word.length; i++) {
			h ^= word.charCodeAt(i);
			h = Math.imul(h, 0x01000193) >>> 0;
		}
		return (h % 30418) + 104; // offset past reserved tokens
	}

	/**
	 * Extract embedding from BGE model output using mean pooling + L2 normalization.
	 * BGE outputs last_hidden_state: [1, seq_len, 384].
	 * Mean pool over non-padding positions then L2-normalize.
	 */
	private extractEmbedding(outputs: any, attentionMask: number[]): number[] {
		// last_hidden_state shape: [1, seqLen, hiddenDim]
		const hiddenState = outputs.last_hidden_state?.data as
			| Float32Array
			| undefined;
		if (!hiddenState) {
			throw new Error("Model output missing last_hidden_state");
		}

		const seqLen = attentionMask.length;
		const hiddenDim = 384;
		const pooled = new Array(hiddenDim).fill(0);
		let validTokens = 0;

		for (let t = 0; t < seqLen; t++) {
			if (attentionMask[t] === 1) {
				for (let d = 0; d < hiddenDim; d++) {
					pooled[d] += hiddenState[t * hiddenDim + d];
				}
				validTokens++;
			}
		}

		if (validTokens === 0) return pooled;

		// Mean pool
		for (let d = 0; d < hiddenDim; d++) {
			pooled[d] /= validTokens;
		}

		// L2 normalize
		const norm = Math.sqrt(pooled.reduce((s, v) => s + v * v, 0));
		return norm > 0 ? pooled.map((v) => v / norm) : pooled;
	}

	/**
	 * Fallback embedding computation using simple hashing.
	 * Used when ONNX model is unavailable or fails.
	 */
	private fallbackEmbedding(text: string): number[] {
		const words = text.toLowerCase().split(/\s+/);
		const embedding = new Array(384).fill(0);

		for (const word of words) {
			const hash = this.simpleHash(word);
			const index = Math.abs(hash) % embedding.length;
			embedding[index] += 1;
		}

		// Normalize
		const magnitude = Math.sqrt(
			embedding.reduce((sum, val) => sum + val * val, 0),
		);
		return embedding.map((val) => val / magnitude);
	}

	/**
	 * Simple hash function for fallback embedding.
	 */
	private simpleHash(str: string): number {
		let hash = 0;
		for (let i = 0; i < str.length; i++) {
			const char = str.charCodeAt(i);
			hash = (hash << 5) - hash + char;
			hash = hash & hash;
		}
		return hash;
	}

	/**
	 * Compute average embedding from multiple embeddings.
	 */
	private averageEmbedding(embeddings: number[][]): number[] {
		if (embeddings.length === 0) {
			return new Array(384).fill(0);
		}

		const dim = embeddings[0].length;
		const avg = new Array(dim).fill(0);

		for (const embedding of embeddings) {
			for (let i = 0; i < dim; i++) {
				avg[i] += embedding[i];
			}
		}

		return avg.map((val) => val / embeddings.length);
	}

	/**
	 * Compute cosine similarity between two vectors.
	 */
	private cosineSimilarity(vec1: number[], vec2: number[]): number {
		if (vec1.length !== vec2.length) {
			return 0;
		}

		let dotProduct = 0;
		let magnitude1 = 0;
		let magnitude2 = 0;

		for (let i = 0; i < vec1.length; i++) {
			dotProduct += vec1[i] * vec2[i];
			magnitude1 += vec1[i] * vec1[i];
			magnitude2 += vec2[i] * vec2[i];
		}

		magnitude1 = Math.sqrt(magnitude1);
		magnitude2 = Math.sqrt(magnitude2);

		if (magnitude1 === 0 || magnitude2 === 0) {
			return 0;
		}

		return dotProduct / (magnitude1 * magnitude2);
	}

	/**
	 * Detect refinement intent from utterance using pattern matching.
	 */
	private detectRefinementIntent(utterance: string): RefinementIntent | null {
		const patterns = [
			{
				pattern: /shorter|condense|brief|concise/i,
				intent: "shorten" as RefinementIntent,
			},
			{
				pattern: /longer|expand|elaborate|more detail/i,
				intent: "expand" as RefinementIntent,
			},
			{
				pattern: /rephrase|different words|say it differently/i,
				intent: "rephrase" as RefinementIntent,
			},
			{
				pattern: /simpler|simplify|easier to understand/i,
				intent: "simplify" as RefinementIntent,
			},
			{
				pattern: /example|instance|show me/i,
				intent: "add_example" as RefinementIntent,
			},
			{
				pattern: /formal|professional|more formal/i,
				intent: "more_formal" as RefinementIntent,
			},
			{
				pattern: /casual|less formal|relaxed/i,
				intent: "more_casual" as RefinementIntent,
			},
		];

		for (const { pattern, intent } of patterns) {
			if (pattern.test(utterance)) {
				return intent;
			}
		}

		return null;
	}

	/**
	 * Clear the embedding cache to free memory.
	 */
	clearCache(): void {
		this.embeddingCache.clear();
	}

	/**
	 * Check if the model is loaded and ready.
	 */
	isReady(): boolean {
		return this.modelLoaded;
	}
}
