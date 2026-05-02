import { pipeline } from "@xenova/transformers";
import type { QuestionReactionKind } from "./QuestionReactionClassifier";

interface ClassificationResult {
	kind: QuestionReactionKind;
	confidence: number;
}

export class SetFitReactionClassifier {
	private embedder: any | null = null;
	private modelLoadPromise: Promise<void> | null = null;
	private modelLoadError = false;

	private static readonly CONFIDENCE_THRESHOLD = 0.8;
	private static readonly EMBEDDING_MODEL = "Xenova/all-MiniLM-L6-v2";

	// Prototype examples for each reaction category (8-16 examples per category)
	private static readonly PROTOTYPES: Record<QuestionReactionKind, string[]> = {
		fresh_question: [
			"Tell me about your experience with distributed systems.",
			"What is your background in software engineering?",
			"How would you design a microservices architecture?",
			"What are your thoughts on event-driven architecture?",
			"Can you explain how Kubernetes works?",
		],
		challenge: [
			"Why did you choose this approach?",
			"Why not use a different database?",
			"Why this over that solution?",
			"What makes this better than the alternative?",
			"Why would you implement it this way?",
			"How do you justify this decision?",
			"What is the reasoning behind this choice?",
		],
		tradeoff_probe: [
			"What are the tradeoffs?",
			"What are the pros and cons?",
			"What is the downside?",
			"What is the upside?",
			"Where does this fall short?",
			"What are the limitations?",
			"What would you sacrifice with this approach?",
			"What are the drawbacks?",
		],
		metric_probe: [
			"How do you measure success?",
			"What are the metrics?",
			"What is the latency?",
			"What is the throughput?",
			"How do you monitor performance?",
			"What KPIs should we track?",
			"What is the success criteria?",
			"How do you measure this?",
		],
		example_request: [
			"Can you give me an example?",
			"For example?",
			"Show me a specific case.",
			"Walk me through a specific example.",
			"Give me a concrete example.",
			"Can you illustrate with an example?",
			"What would this look like in practice?",
		],
		clarification: [
			"What do you mean?",
			"Can you clarify?",
			"Can you explain that better?",
			"Can you unpack this?",
			"How so?",
			"What exactly do you mean by that?",
			"Can you elaborate on this point?",
			"I need more clarity on this.",
		],
		repeat_request: [
			"Can you repeat that?",
			"Say that again.",
			"Can you say that again?",
			"What did you just say?",
			"Repeat the last part.",
			"Can you restate that?",
		],
		deep_dive: [
			"What if?",
			"How would that change things?",
			"And then what happens?",
			"What are the edge cases?",
			"How would you handle failure?",
			"What happens in the worst case?",
			"How does this scale?",
			"What about error handling?",
		],
		topic_shift: [
			"Switch gears.",
			"Let's talk about something else.",
			"Move on to a different topic.",
			"New topic.",
			"Let's change the subject.",
			"I want to discuss something else.",
		],
		generic_follow_up: [
			"And then?",
			"So what?",
			"And?",
			"Tell me more.",
			"Go on.",
			"What else?",
			"Is that it?",
			"Continue.",
		],
	};

	private prototypeEmbeddings: Map<QuestionReactionKind, number[][]> =
		new Map();

	constructor() {
		// Lazy load model on first use
	}

	private async ensureModelLoaded(): Promise<void> {
		if (this.embedder) {
			return;
		}

		if (this.modelLoadError) {
			throw new Error(
				"Embedding model failed to load, SetFit classifier disabled",
			);
		}

		if (this.modelLoadPromise) {
			return this.modelLoadPromise;
		}

		this.modelLoadPromise = (async () => {
			try {
				this.embedder = await pipeline(
					"feature-extraction",
					SetFitReactionClassifier.EMBEDDING_MODEL,
				);
				await this.cachePrototypeEmbeddings();
			} catch (error) {
				console.warn(
					"[SetFitReactionClassifier] Failed to load embedding model:",
					error,
				);
				this.modelLoadError = true;
				throw error;
			}
		})();

		return this.modelLoadPromise;
	}

	private async cachePrototypeEmbeddings(): Promise<void> {
		if (!this.embedder) return;

		for (const [kind, examples] of Object.entries(
			SetFitReactionClassifier.PROTOTYPES,
		)) {
			const embeddings: number[][] = [];
			for (const example of examples) {
				const embedding = await this.embedder(example, {
					pooling: "mean",
					normalize: true,
				});
				embeddings.push(Array.from(embedding.data as number[]));
			}
			this.prototypeEmbeddings.set(kind as QuestionReactionKind, embeddings);
		}
	}

	async classify(question: string): Promise<ClassificationResult | null> {
		try {
			await this.ensureModelLoaded();
			if (!this.embedder) {
				return null;
			}

			const questionEmbedding = await this.embedder(question, {
				pooling: "mean",
				normalize: true,
			});
			const questionVector = Array.from(questionEmbedding.data as number[]);

			let bestKind: QuestionReactionKind = "generic_follow_up";
			let bestScore = 0;

			for (const [
				kind,
				prototypeEmbeddings,
			] of this.prototypeEmbeddings.entries()) {
				const avgSimilarity = this.computeAverageSimilarity(
					questionVector,
					prototypeEmbeddings,
				);
				if (avgSimilarity > bestScore) {
					bestScore = avgSimilarity;
					bestKind = kind;
				}
			}

			if (bestScore >= SetFitReactionClassifier.CONFIDENCE_THRESHOLD) {
				return {
					kind: bestKind,
					confidence: bestScore,
				};
			}

			return null; // Confidence too low, fall back to regex
		} catch (error) {
			console.warn("[SetFitReactionClassifier] Classification failed:", error);
			return null; // Fall back to regex on error
		}
	}

	private computeAverageSimilarity(
		vector: number[],
		prototypeEmbeddings: number[][],
	): number {
		if (prototypeEmbeddings.length === 0) return 0;

		let totalSimilarity = 0;
		for (const prototype of prototypeEmbeddings) {
			totalSimilarity += this.cosineSimilarity(vector, prototype);
		}

		return totalSimilarity / prototypeEmbeddings.length;
	}

	private cosineSimilarity(a: number[], b: number[]): number {
		if (a.length !== b.length) return 0;

		let dot = 0;
		let normA = 0;
		let normB = 0;

		for (let i = 0; i < a.length; i++) {
			dot += a[i] * b[i];
			normA += a[i] * a[i];
			normB += b[i] * b[i];
		}

		if (normA === 0 || normB === 0) return 0;
		return dot / (Math.sqrt(normA) * Math.sqrt(normB));
	}

	isModelLoaded(): boolean {
		return this.embedder !== null;
	}

	hasLoadError(): boolean {
		return this.modelLoadError;
	}
}
