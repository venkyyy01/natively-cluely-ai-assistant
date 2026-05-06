// electron/rag/index.ts
// Barrel export for RAG modules

export { EmbeddingPipeline } from "./EmbeddingPipeline";
export type { AppAPIConfig } from "./EmbeddingProviderResolver";
export {
	buildRAGPrompt,
	GLOBAL_RAG_SYSTEM_PROMPT,
	MEETING_RAG_SYSTEM_PROMPT,
	NO_CONTEXT_FALLBACK,
	NO_GLOBAL_CONTEXT_FALLBACK,
	PARTIAL_CONTEXT_FALLBACK,
} from "./prompts";
export type { RAGManagerConfig } from "./RAGManager";
export { RAGManager } from "./RAGManager";
export type {
	QueryIntent,
	RetrievalOptions,
	RetrievedContext,
} from "./RAGRetriever";
export { RAGRetriever } from "./RAGRetriever";
export type { Chunk } from "./SemanticChunker";
export { chunkTranscript, formatChunkForContext } from "./SemanticChunker";
export type { CleanedSegment, RawSegment } from "./TranscriptPreprocessor";
export { estimateTokens, preprocessTranscript } from "./TranscriptPreprocessor";
export type { ScoredChunk, StoredChunk } from "./VectorStore";
export { VectorStore } from "./VectorStore";
