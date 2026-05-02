/**
 * ModelVersionManager — Self-Improving Model Rotation (v3)
 *
 * Three-tier retry system for BOTH vision (screenshot analysis) and text
 * (chat fallback chains) that auto-discovers newer models and promotes
 * them through tiers:
 *
 *   Tier 1 (Primary):      Pinned stable models. Promoted only when 2+ minor
 *                           versions behind OR previous stable on major jump.
 *   Tier 2 (Fallback):     Auto-discovered latest models from each provider.
 *   Tier 3 (Retry):        Same as Tier 2. Pure retry pass with backoff.
 *
 * Vision and Text use SEPARATE family sets with distinct baselines, since
 * the same provider may use different models for each (e.g., Groq uses
 * llama-4-scout for vision but llama-3.3-70b for text).
 *
 * Background discovery runs every ~14 days. Event-driven discovery can be
 * triggered on 404/model-not-found errors.
 *
 * State is persisted to disk with rollback support.
 */

// ─── Types ──────────────────────────────────────────────────────────────

export interface ModelVersion {
	major: number;
	minor: number;
	patch: number;
	raw: string;
}

export enum ModelFamily {
	OPENAI = "openai",
	GEMINI_FLASH = "gemini_flash",
	GEMINI_PRO = "gemini_pro",
	CLAUDE = "claude",
	GROQ_LLAMA = "groq_llama",
}

/** Text model families — separate from vision since providers use different models */
export enum TextModelFamily {
	OPENAI = "text_openai",
	GEMINI_FLASH = "text_gemini_flash",
	GEMINI_PRO = "text_gemini_pro",
	CLAUDE = "text_claude",
	GROQ = "text_groq",
}

export interface TieredModels {
	tier1: string;
	tier2: string;
	tier3: string;
}

export interface FamilyState {
	/** The original hardcoded baseline (never changes) */
	baseline: string;
	/** Current Tier 1 (promoted stable) */
	tier1: string;
	/** Current Tier 2/3 (latest discovered) */
	latest: string;
	/** Parsed version of latest discovered model */
	latestVersion: ModelVersion | null;
	/** Parsed version of current tier1 model */
	tier1Version: ModelVersion | null;
	/** Previous tier1 before last promotion (for rollback) */
	previousTier1: string | null;
	/** Previous latest before last update (for rollback) */
	previousLatest: string | null;
}

export interface PersistedState {
	families: Record<string, FamilyState>;
	lastDiscoveryTimestamp: number;
	/** Counts consecutive discovery failures per provider for backoff */
	discoveryFailureCounts: Record<string, number>;
	schemaVersion: number;
}

// ─── Constants ──────────────────────────────────────────────────────────

/** Hardcoded baseline models for vision Tier 1 (initial pinned stable) */
export const BASELINE_MODELS: Record<ModelFamily, string> = {
	[ModelFamily.OPENAI]: "gpt-5.4-chat",
	[ModelFamily.GEMINI_FLASH]: "gemini-3.1-flash-lite-preview",
	[ModelFamily.GEMINI_PRO]: "gemini-3.1-pro-preview",
	[ModelFamily.CLAUDE]: "claude-sonnet-4-6",
	[ModelFamily.GROQ_LLAMA]: "meta-llama/llama-4-scout-17b-16e-instruct",
};

/** Hardcoded baseline models for text Tier 1 */
export const TEXT_BASELINE_MODELS: Record<TextModelFamily, string> = {
	[TextModelFamily.OPENAI]: "gpt-5.4-chat",
	[TextModelFamily.GEMINI_FLASH]: "gemini-3.1-flash-lite-preview",
	[TextModelFamily.GEMINI_PRO]: "gemini-3.1-pro-preview",
	[TextModelFamily.CLAUDE]: "claude-sonnet-4-6",
	[TextModelFamily.GROQ]: "llama-3.3-70b-versatile",
};

/** Vision-capable model ordering for screenshot analysis */
export const VISION_PROVIDER_ORDER: ModelFamily[] = [
	ModelFamily.OPENAI,
	ModelFamily.GEMINI_FLASH,
	ModelFamily.CLAUDE,
	ModelFamily.GEMINI_PRO,
	ModelFamily.GROQ_LLAMA,
];

/** Text model ordering for chat fallback chains */
export const TEXT_PROVIDER_ORDER: TextModelFamily[] = [
	TextModelFamily.GROQ,
	TextModelFamily.OPENAI,
	TextModelFamily.CLAUDE,
	TextModelFamily.GEMINI_FLASH,
	TextModelFamily.GEMINI_PRO,
];

export const SCHEMA_VERSION = 3;
export const DISCOVERY_INTERVAL_MS = 14 * 24 * 60 * 60 * 1000; // 14 days
export const PERSISTENCE_FILENAME = "model_versions.json";
export const MAX_DISCOVERY_FAILURES_BEFORE_BACKOFF = 3;
export const DISCOVERY_BACKOFF_MULTIPLIER = 2; // exponential backoff on repeated failures

/** Cooldown to prevent event-driven discovery from firing too often */
export const EVENT_DISCOVERY_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour

// ─── Version Parsing ────────────────────────────────────────────────────

/**
 * Extract a semantic version from a model identifier string.
 *
 * Handles diverse and irregular naming conventions:
 *   "gpt-5.4-chat-latest"                     → { major:5, minor:4, patch:0 }
 *   "gpt-5.4"                                  → { major:5, minor:4, patch:0 }
 *   "gemini-3.1-flash-lite-preview"            → { major:3, minor:1, patch:0 }
 *   "gemini-3.1-pro-preview"                   → { major:3, minor:1, patch:0 }
 *   "claude-sonnet-4-6"                        → { major:4, minor:6, patch:0 }
 *   "claude-opus-4-6"                          → { major:4, minor:6, patch:0 }
 *   "meta-llama/llama-4-scout-17b-16e-instruct"→ { major:4, minor:0, patch:0 }
 *   "llama-4-scout-17b-16e-instruct"           → { major:4, minor:0, patch:0 }
 *
 * NOTE: Hardware specifiers (17b, 16e) and tags (preview, latest, instruct)
 * are intentionally stripped before parsing. They are NOT version indicators.
 */
