/**
 * NAT-085 — WER (Word Error Rate) and diarization benchmark utilities.
 *
 * Computes WER using the standard formula:
 *   WER = (S + D + I) / N
 * where S = substitutions, D = deletions, I = insertions, N = reference length.
 *
 * Uses Levenshtein distance at the word level.
 */

export interface DiarizedTurn {
	speaker: string;
	text: string;
}

export interface BenchmarkResult {
	reference: string;
	hypothesis: string;
	wer: number;
	substitutions: number;
	deletions: number;
	insertions: number;
	refWordCount: number;
}

export interface DiarizationResult {
	turns: Array<{
		refSpeaker: string;
		hypSpeaker: string;
		text: string;
		correct: boolean;
	}>;
	accuracy: number;
}

function tokenize(text: string): string[] {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9\s]/g, "")
		.split(/\s+/)
		.filter((w) => w.length > 0);
}

function levenshteinDistanceMatrix(a: string[], b: string[]): number[][] {
	const m = a.length;
	const n = b.length;
	const dp: number[][] = Array.from({ length: m + 1 }, () =>
		new Array(n + 1).fill(0),
	);

	for (let i = 0; i <= m; i++) dp[i][0] = i;
	for (let j = 0; j <= n; j++) dp[0][j] = j;

	for (let i = 1; i <= m; i++) {
		for (let j = 1; j <= n; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			dp[i][j] = Math.min(
				dp[i - 1][j] + 1, // deletion
				dp[i][j - 1] + 1, // insertion
				dp[i - 1][j - 1] + cost, // substitution
			);
		}
	}

	return dp;
}

export function computeWER(
	reference: string,
	hypothesis: string,
): BenchmarkResult {
	const refWords = tokenize(reference);
	const hypWords = tokenize(hypothesis);
	const dp = levenshteinDistanceMatrix(refWords, hypWords);

	let i = refWords.length;
	let j = hypWords.length;
	let substitutions = 0;
	let deletions = 0;
	let insertions = 0;

	while (i > 0 || j > 0) {
		if (i === 0) {
			insertions += 1;
			j -= 1;
		} else if (j === 0) {
			deletions += 1;
			i -= 1;
		} else {
			const cost = refWords[i - 1] === hypWords[j - 1] ? 0 : 1;
			if (dp[i][j] === dp[i - 1][j - 1] + cost) {
				if (cost === 1) substitutions += 1;
				i -= 1;
				j -= 1;
			} else if (dp[i][j] === dp[i - 1][j] + 1) {
				deletions += 1;
				i -= 1;
			} else {
				insertions += 1;
				j -= 1;
			}
		}
	}

	const refWordCount = refWords.length;
	const rawWER =
		refWordCount === 0
			? hypWords.length > 0
				? 1
				: 0
			: (substitutions + deletions + insertions) / refWordCount;
	const wer = Math.min(1, rawWER);

	return {
		reference,
		hypothesis,
		wer,
		substitutions,
		deletions,
		insertions,
		refWordCount,
	};
}

export function computeDiarizationAccuracy(
	reference: DiarizedTurn[],
	hypothesis: DiarizedTurn[],
): DiarizationResult {
	const maxLen = Math.max(reference.length, hypothesis.length);
	const turns: DiarizationResult["turns"] = [];
	let correct = 0;

	for (let i = 0; i < maxLen; i++) {
		const ref = reference[i];
		const hyp = hypothesis[i];
		if (ref && hyp) {
			const speakerMatch = ref.speaker === hyp.speaker;
			if (speakerMatch) correct += 1;
			turns.push({
				refSpeaker: ref.speaker,
				hypSpeaker: hyp.speaker,
				text: ref.text,
				correct: speakerMatch,
			});
		} else if (ref) {
			turns.push({
				refSpeaker: ref.speaker,
				hypSpeaker: "missing",
				text: ref.text,
				correct: false,
			});
		} else if (hyp) {
			turns.push({
				refSpeaker: "missing",
				hypSpeaker: hyp.speaker,
				text: hyp.text,
				correct: false,
			});
		}
	}

	const accuracy = maxLen === 0 ? 1 : correct / maxLen;
	return { turns, accuracy };
}

export interface STTCorpusEntry {
	id: string;
	audioPath: string;
	reference: string;
	referenceTurns?: DiarizedTurn[];
}

export interface STTBenchmarkReport {
	provider: string;
	entries: Array<{
		id: string;
		result: BenchmarkResult;
		diarization?: DiarizationResult;
	}>;
	meanWER: number;
	meanDiarizationAccuracy?: number;
}

export function runSTTBenchmark(
	_provider: string,
	_corpus: STTCorpusEntry[],
	_runProvider: (
		audioPath: string,
	) => Promise<{ text: string; turns?: DiarizedTurn[] }>,
): Promise<STTBenchmarkReport> {
	// Placeholder: real implementation would iterate corpus, call provider, compute metrics.
	throw new Error(
		"runSTTBenchmark not yet implemented without live audio fixtures",
	);
}
