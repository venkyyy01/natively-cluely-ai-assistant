import {
	BASELINE_MODELS,
	ModelFamily,
	type ModelVersion,
	TEXT_BASELINE_MODELS,
	TextModelFamily,
} from "./modelVersionTypes";

export function parseModelVersion(modelId: string): ModelVersion | null {
	// Normalize: strip vendor prefixes and non-version suffixes
	const cleaned = modelId
		.replace(/^meta-llama\//, "") // vendor prefix
		.replace(/-chat-latest$/, "") // OpenAI suffix
		.replace(/-lite-preview$/, "") // Gemini suffix
		.replace(/-preview$/, "") // Gemini suffix
		.replace(/-latest$/, "") // generic suffix
		.replace(/-instruct$/, "") // instruction-tuned tag
		.replace(/-\d+b(-\d+e)?$/, "") // hardware specs like -17b-16e
		.replace(/-\d+b$/, ""); // hardware specs like -70b

	// Strategy 1: Dotted version (X.Y or X.Y.Z) — most OpenAI & Gemini models
	const dotVersion = cleaned.match(/(\d+)\.(\d+)(?:\.(\d+))?/);
	if (dotVersion) {
		return {
			major: parseInt(dotVersion[1], 10),
			minor: parseInt(dotVersion[2], 10),
			patch: dotVersion[3] ? parseInt(dotVersion[3], 10) : 0,
			raw: modelId,
		};
	}

	// Strategy 2: Claude-style hyphenated version (claude-TYPE-MAJOR-MINOR)
	//   "claude-sonnet-4-6" → major:4, minor:6
	//   "claude-opus-5-2"   → major:5, minor:2
	const claudePattern = cleaned.match(
		/claude-(?:sonnet|opus|haiku)-(\d+)-(\d+)/,
	);
	if (claudePattern) {
		return {
			major: parseInt(claudePattern[1], 10),
			minor: parseInt(claudePattern[2], 10),
			patch: 0,
			raw: modelId,
		};
	}

	// Strategy 3: Llama-style (llama-MAJOR-TYPE) — no minor version
	//   "llama-4-scout" → major:4, minor:0
	const llamaPattern = cleaned.match(/llama-(\d+)-/);
	if (llamaPattern) {
		return {
			major: parseInt(llamaPattern[1], 10),
			minor: 0,
			patch: 0,
			raw: modelId,
		};
	}

	// Strategy 4: Generic trailing hyphenated version (word-MAJOR-MINOR)
	const trailingVersion = cleaned.match(/(\d+)-(\d+)$/);
	if (trailingVersion) {
		return {
			major: parseInt(trailingVersion[1], 10),
			minor: parseInt(trailingVersion[2], 10),
			patch: 0,
			raw: modelId,
		};
	}

	// Strategy 5: Single version number after a word boundary
	const singleVersion = cleaned.match(/[a-z]-(\d+)(?:$|-[a-z])/i);
	if (singleVersion) {
		return {
			major: parseInt(singleVersion[1], 10),
			minor: 0,
			patch: 0,
			raw: modelId,
		};
	}

	console.warn(
		`[ModelVersionManager] ⚠️ Could not parse version from model ID: "${modelId}"`,
	);
	return null;
}

/**
 * Compare two ModelVersions.
 * Returns: negative if a < b, 0 if equal, positive if a > b
 */
export function compareVersions(a: ModelVersion, b: ModelVersion): number {
	if (a.major !== b.major) return a.major - b.major;
	if (a.minor !== b.minor) return a.minor - b.minor;
	return a.patch - b.patch;
}

/**
 * Calculate the "distance" between two versions in minor-version units.
 * Used to determine if tier promotion thresholds are reached.
 * A major version bump counts as 10 minor versions (always triggers promotion).
 */
export function versionDistance(
	older: ModelVersion,
	newer: ModelVersion,
): number {
	if (newer.major > older.major) {
		return (newer.major - older.major) * 10 + (newer.minor - older.minor);
	}
	return newer.minor - older.minor + (newer.patch - older.patch) * 0.1;
}

// ─── Model Family Classification ────────────────────────────────────────

/**
 * Determine which vision ModelFamily a discovered model ID belongs to.
 * Returns null if it doesn't match any known vision-capable family.
 */
export function classifyModel(modelId: string): ModelFamily | null {
	const lower = modelId.toLowerCase();

	// OpenAI GPT vision models (exclude instruct-only variants)
	if (lower.startsWith("gpt-") && !lower.includes("instruct")) {
		return ModelFamily.OPENAI;
	}

	// Gemini Flash variants
	if (
		lower.includes("gemini") &&
		(lower.includes("flash") || lower.includes("lite"))
	) {
		return ModelFamily.GEMINI_FLASH;
	}

	// Gemini Pro variants
	if (lower.includes("gemini") && lower.includes("pro")) {
		return ModelFamily.GEMINI_PRO;
	}

	// Claude vision-capable models (sonnet, opus, haiku)
	if (
		lower.startsWith("claude-") &&
		(lower.includes("sonnet") ||
			lower.includes("opus") ||
			lower.includes("haiku"))
	) {
		return ModelFamily.CLAUDE;
	}

	// Groq Llama Scout (vision-capable)
	if (lower.includes("llama") && lower.includes("scout")) {
		return ModelFamily.GROQ_LLAMA;
	}

	return null;
}

/**
 * Determine which TextModelFamily a discovered model ID belongs to.
 * Text families are broader than vision — e.g., Groq includes all llama/mixtral models.
 */
export function classifyTextModel(modelId: string): TextModelFamily | null {
	const lower = modelId.toLowerCase();

	// OpenAI GPT text models
	if (lower.startsWith("gpt-") && !lower.includes("instruct")) {
		return TextModelFamily.OPENAI;
	}

	// Gemini Flash variants
	if (
		lower.includes("gemini") &&
		(lower.includes("flash") || lower.includes("lite"))
	) {
		return TextModelFamily.GEMINI_FLASH;
	}

	// Gemini Pro variants
	if (lower.includes("gemini") && lower.includes("pro")) {
		return TextModelFamily.GEMINI_PRO;
	}

	// Claude text models (sonnet, opus, haiku — all text-capable)
	if (
		lower.startsWith("claude-") &&
		(lower.includes("sonnet") ||
			lower.includes("opus") ||
			lower.includes("haiku"))
	) {
		return TextModelFamily.CLAUDE;
	}

	// Groq text models — broader: llama, mixtral, gemma (NOT scout-only like vision)
	if (
		lower.includes("llama") ||
		lower.includes("mixtral") ||
		lower.includes("gemma")
	) {
		return TextModelFamily.GROQ;
	}

	return null;
}
