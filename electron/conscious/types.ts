// electron/conscious/types.ts

// ============================================
// Interview Phases
// ============================================

export const INTERVIEW_PHASES = [
	"requirements_gathering",
	"high_level_design",
	"deep_dive",
	"implementation",
	"complexity_analysis",
	"scaling_discussion",
	"failure_handling",
	"behavioral_story",
	"wrap_up",
] as const;

export type InterviewPhase = (typeof INTERVIEW_PHASES)[number];

// ============================================
// Thread Management
// ============================================

export type ThreadStatus = "active" | "suspended" | "completed" | "expired";

export interface CodeSnippet {
	id: string;
	code: string;
	language: string;
	purpose: "implementation" | "example" | "interviewer_shared" | "pseudocode";
	lineCount: number;
	tokenCount: number;
	addedAt: number;
	lastReferencedAt: number;
	compressed?: string;
}

export interface ThreadCodeContext {
	snippets: CodeSnippet[];
	maxSnippets: number;
	totalTokenBudget: number;
}

export interface ConversationThread {
	id: string;
	status: ThreadStatus;
	topic: string;
	goal: string;
	phase: InterviewPhase;
	keyDecisions: string[];
	constraints: string[];
	codeContext: ThreadCodeContext;
	createdAt: number;
	lastActiveAt: number;
	suspendedAt?: number;
	ttlMs: number;
	resumeKeywords: string[];
	interruptedBy?: string;
	turnCount: number;
	tokenCount: number;
	resumeCount: number;
	embedding?: number[];
}

// ============================================
// Token Budget
// ============================================

export type LLMProvider =
	| "openai"
	| "claude"
	| "groq"
	| "gemini"
	| "ollama"
	| "custom";

export interface BucketAllocation {
	min: number;
	max: number;
	current: number;
}

export interface TokenBudgetAllocations {
	activeThread: BucketAllocation;
	recentTranscript: BucketAllocation;
	suspendedThreads: BucketAllocation;
	epochSummaries: BucketAllocation;
	entities: BucketAllocation;
	reserve: BucketAllocation;
}

export interface TokenBudget {
	provider: LLMProvider;
	totalBudget: number;
	allocations: TokenBudgetAllocations;
}

// ============================================
// Confidence Scoring
// ============================================

export interface ConfidenceScore {
	bm25Score: number;
	embeddingScore: number;
	explicitMarkers: number;
	temporalDecay: number;
	phaseAlignment: number;
	sttQuality: number;
	topicShiftPenalty: number;
	interruptionRecency: number;
	total: number;
}

export const CONFIDENCE_WEIGHTS = {
	bm25: 0.2,
	embedding: 0.25,
	explicitMarkers: 0.15,
	temporalDecay: 0.2,
	phaseAlignment: 0.2,
	sttQuality: 0.05,
	topicShiftPenalty: -0.1,
	interruptionRecency: -0.05,
} as const;

export const RESUME_THRESHOLD = 0.69;

// ============================================
// Fallback Chain
// ============================================

export type FallbackTier =
	| "full_conscious"
	| "reduced_conscious"
	| "normal_mode"
	| "emergency_local";

export interface FallbackTierConfig {
	name: FallbackTier;
	budgetMs: number;
	contextLevel: "full" | "reduced" | "minimal" | "none";
	outputType: "reasoning_first" | "direct" | "template";
	retryable: boolean;
}

export const FALLBACK_TIERS: FallbackTierConfig[] = [
	{
		name: "full_conscious",
		budgetMs: 1200,
		contextLevel: "full",
		outputType: "reasoning_first",
		retryable: true,
	},
	{
		name: "reduced_conscious",
		budgetMs: 800,
		contextLevel: "reduced",
		outputType: "reasoning_first",
		retryable: true,
	},
	{
		name: "normal_mode",
		budgetMs: 600,
		contextLevel: "minimal",
		outputType: "direct",
		retryable: true,
	},
	{
		name: "emergency_local",
		budgetMs: 400,
		contextLevel: "none",
		outputType: "template",
		retryable: false,
	},
];

// ============================================
// Failure State
// ============================================

export type DegradationLevel = "none" | "reduced" | "minimal" | "emergency";

export interface FailureState {
	consecutiveFailures: number;
	totalFailures: number;
	lastFailureTime: number | null;
	lastSuccessTime: number | null;
	degradationLevel: DegradationLevel;
	tierFailures: Record<FallbackTier, number>;
}

// ============================================
// Conscious Response
// ============================================

export type ConsciousResponseMode = "reasoning_first" | "direct" | "code_first";

export interface ConsciousResponse {
	success: boolean;
	mode: ConsciousResponseMode;
	openingReasoning: string;
	spokenResponse: string;
	implementationPlan: string[];
	codeBlock?: { language: string; code: string };
	tradeoffs: string[];
	edgeCases: string[];
	likelyFollowUps: string[];
	pushbackResponses: Record<string, string>;
	tier: number;
	phase: InterviewPhase;
	threadId: string;
	latencyMs: number;
	tokensUsed: number;
}

// ============================================
// Debounce Config
// ============================================

export interface DebounceConfig {
	baseWindowMs: number;
	lowConfidenceExtensionMs: number;
	sttConfidenceThreshold: number;
	maxWindowMs: number;
	minCharacterThreshold: number;
}

export const DEFAULT_DEBOUNCE_CONFIG: DebounceConfig = {
	baseWindowMs: 350,
	lowConfidenceExtensionMs: 150,
	sttConfidenceThreshold: 0.7,
	maxWindowMs: 600,
	minCharacterThreshold: 10,
};
