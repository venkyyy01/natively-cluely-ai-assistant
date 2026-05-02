import { createHash } from "crypto";

export interface ResponseFingerprintEntry {
	hash: string;
	timestamp: number;
	preview: string;
	contextKey: string | null;
}

export interface DuplicateCheckResult {
	isDupe: boolean;
	matchedPreview?: string;
}

export class ResponseFingerprinter {
	private recentFingerprints: ResponseFingerprintEntry[] = [];
	private readonly maxHistory: number;
	private readonly minDuplicateGapMs: number;

	constructor(maxHistory: number = 20, minDuplicateGapMs: number = 30_000) {
		this.maxHistory = Math.max(1, maxHistory);
		this.minDuplicateGapMs = minDuplicateGapMs;
	}

	fingerprint(text: string): string {
		const normalized = text
			.toLowerCase()
			.replace(/[^\w\s]/g, "")
			.replace(/\s+/g, " ")
			.trim();

		return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
	}

	private normalizeContextKey(contextKey?: string): string | null {
		const normalized = (contextKey || "")
			.toLowerCase()
			.replace(/[^\w\s]/g, "")
			.replace(/\s+/g, " ")
			.trim();

		return normalized || null;
	}

	isDuplicate(text: string, contextKey?: string): DuplicateCheckResult {
		const normalizedText = text.trim();
		if (!normalizedText) {
			return { isDupe: false };
		}

		const now = Date.now();
		const normalizedContextKey = this.normalizeContextKey(contextKey);
		const candidateEntries =
			normalizedContextKey === null
				? this.recentFingerprints
				: this.recentFingerprints.filter(
						(entry) => entry.contextKey === normalizedContextKey,
					);

		// Only consider entries older than minDuplicateGapMs as duplicates.
		// Recent entries (within the gap) are likely legitimate re-answers to
		// the same question (e.g., interviewer asks again after a pause).
		const eligibleEntries = candidateEntries.filter(
			(entry) => now - entry.timestamp >= this.minDuplicateGapMs,
		);

		const hash = this.fingerprint(normalizedText);
		const exact = eligibleEntries.find((entry) => entry.hash === hash);
		if (exact) {
			return { isDupe: true, matchedPreview: exact.preview };
		}

		const firstSentence =
			normalizedText.split(/[.!?]/)[0]?.trim().toLowerCase() || "";
		if (firstSentence.length >= 12) {
			const fuzzy = eligibleEntries.find((entry) =>
				entry.preview
					.toLowerCase()
					.startsWith(
						firstSentence.slice(0, Math.min(40, firstSentence.length)),
					),
			);
			if (fuzzy) {
				return { isDupe: true, matchedPreview: fuzzy.preview };
			}
		}

		return { isDupe: false };
	}

	record(text: string, contextKey?: string): void {
		const trimmed = text.trim();
		if (!trimmed) return;

		this.recentFingerprints.push({
			hash: this.fingerprint(trimmed),
			timestamp: Date.now(),
			preview: trimmed.slice(0, 50),
			contextKey: this.normalizeContextKey(contextKey),
		});

		if (this.recentFingerprints.length > this.maxHistory) {
			this.recentFingerprints = this.recentFingerprints.slice(-this.maxHistory);
		}
	}

	clear(): void {
		this.recentFingerprints = [];
	}

	getHashes(): string[] {
		return this.recentFingerprints.map((entry) => entry.hash);
	}

	restore(hashes: string[]): void {
		this.recentFingerprints = hashes
			.filter((hash) => typeof hash === "string" && hash.trim().length > 0)
			.slice(-this.maxHistory)
			.map<ResponseFingerprintEntry>((hash) => ({
				hash,
				timestamp: Date.now(),
				preview: "",
				contextKey: null,
			}));
	}
}
