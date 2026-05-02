export interface TranscriptSegment {
	id: string;
	text: string;
	timestamp: number;
	embedding?: number[];
}

export interface SearchResult {
	segment: TranscriptSegment;
	similarity: number;
}

const SIMILARITY_THRESHOLD = 0.85;
const MAX_SEGMENTS = 100;
const TOP_K = 5;

export class TranscriptIndex {
	private segments: TranscriptSegment[] = [];
	private embeddingCache = new Map<string, number[]>();

	/**
	 * Add a transcript segment to the index
	 */
	addSegment(segment: TranscriptSegment): void {
		// Enforce max segment limit
		if (this.segments.length >= MAX_SEGMENTS) {
			this.segments.shift();
		}
		this.segments.push(segment);
	}

	/**
	 * Search for semantically similar segments
	 * Returns top-K segments with similarity above threshold
	 */
	search(query: string, queryEmbedding?: number[]): SearchResult[] {
		if (this.segments.length === 0) {
			return [];
		}

		const results: SearchResult[] = [];

		for (const segment of this.segments) {
			const similarity = this.cosineSimilarity(
				queryEmbedding,
				segment.embedding,
			);

			if (similarity >= SIMILARITY_THRESHOLD) {
				results.push({ segment, similarity });
			}
		}

		// Sort by similarity descending and return top-K
		results.sort((a, b) => b.similarity - a.similarity);
		return results.slice(0, TOP_K);
	}

	/**
	 * Get all segments in the index
	 */
	getAllSegments(): TranscriptSegment[] {
		return [...this.segments];
	}

	/**
	 * Clear the index
	 */
	clear(): void {
		this.segments = [];
		this.embeddingCache.clear();
	}

	/**
	 * Get the size of the index
	 */
	size(): number {
		return this.segments.length;
	}

	/**
	 * Calculate cosine similarity between two embeddings
	 */
	private cosineSimilarity(
		a: number[] | undefined,
		b: number[] | undefined,
	): number {
		if (!a || !b || a.length === 0 || b.length === 0) {
			return 0;
		}

		let dotProduct = 0;
		let normA = 0;
		let normB = 0;

		for (let i = 0; i < Math.min(a.length, b.length); i++) {
			dotProduct += a[i] * b[i];
			normA += a[i] * a[i];
			normB += b[i] * b[i];
		}

		if (normA === 0 || normB === 0) {
			return 0;
		}

		return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
	}

	/**
	 * Get the similarity threshold
	 */
	getSimilarityThreshold(): number {
		return SIMILARITY_THRESHOLD;
	}

	/**
	 * Get the max segments limit
	 */
	getMaxSegments(): number {
		return MAX_SEGMENTS;
	}

	/**
	 * Get the top-K limit
	 */
	getTopK(): number {
		return TOP_K;
	}
}
