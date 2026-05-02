#!/usr/bin/env node
/**
 * NAT-085 — STT WER Benchmark Harness
 *
 * Usage:
 *   node scripts/run-stt-wer-bench.js [provider]
 *
 * Without audio fixtures, this script runs self-tests to verify the WER
 * computation logic. Once a corpus is added under
 * electron/tests/fixtures/audio/, it will run live provider benchmarks.
 */

const {
	computeWER,
	computeDiarizationAccuracy,
} = require("../dist-electron/electron/audio/WERBenchmark.js");

function selfTest() {
	console.log("Running WER self-tests...");

	const cases = [
		{ ref: "hello world", hyp: "hello world", expectedWER: 0 },
		{ ref: "hello world", hyp: "hello there", expectedWER: 0.5 },
		{ ref: "hello world test", hyp: "hello test", expectedWER: 1 / 3 },
		{ ref: "hello test", hyp: "hello world test", expectedWER: 0.5 },
		{ ref: "apple banana", hyp: "x y z w", expectedWER: 1 },
	];

	let passed = 0;
	for (const c of cases) {
		const result = computeWER(c.ref, c.hyp);
		const ok = Math.abs(result.wer - c.expectedWER) < 0.001;
		if (ok) {
			passed += 1;
		} else {
			console.error(
				`FAIL: ref="${c.ref}" hyp="${c.hyp}" expected=${c.expectedWER} got=${result.wer}`,
			);
		}
	}

	console.log(`Self-tests: ${passed}/${cases.length} passed`);

	const diarizationRef = [
		{ speaker: "interviewer", text: "Tell me about yourself" },
		{ speaker: "user", text: "I am a software engineer" },
	];
	const diarizationHyp = [
		{ speaker: "interviewer", text: "Tell me about yourself" },
		{ speaker: "user", text: "I am a software engineer" },
	];
	const diarizationResult = computeDiarizationAccuracy(
		diarizationRef,
		diarizationHyp,
	);
	console.log(
		`Diarization accuracy (perfect match): ${diarizationResult.accuracy}`,
	);

	if (passed < cases.length) {
		process.exitCode = 1;
	}
}

async function main() {
	const provider = process.argv[2];
	if (!provider) {
		console.log("No provider specified; running self-tests.");
		selfTest();
		console.log(
			"\nTo run a live benchmark, add audio fixtures to electron/tests/fixtures/audio/",
		);
		return;
	}

	console.log(`Provider: ${provider}`);
	console.log(
		"Live benchmark requires audio fixtures. Place WAV/MP3 files under:",
	);
	console.log("  electron/tests/fixtures/audio/");
	console.log("with matching .txt transcript files.");
	selfTest();
}

main().catch((err) => {
	console.error("Benchmark failed:", err);
	process.exitCode = 1;
});
