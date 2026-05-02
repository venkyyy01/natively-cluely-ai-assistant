#!/usr/bin/env node

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const TARGET_TEST_FILES = [
	"dist-electron/electron/tests/foundationModelsIntentProvider.test.js",
	"dist-electron/electron/tests/intentClassificationCoordinator.test.js",
	"dist-electron/electron/tests/intentClassificationEval.test.js",
	"dist-electron/electron/tests/aneClassifierLane.test.js",
	"dist-electron/electron/tests/consciousOrchestratorPurity.test.js",
	"dist-electron/electron/tests/consciousAnswerPlanner.test.js",
	"dist-electron/electron/tests/consciousEvalHarness.test.js",
	"dist-electron/electron/tests/consciousProvenanceVerifier.test.js",
	"dist-electron/electron/tests/consciousVerifier.test.js",
	"dist-electron/electron/tests/questionReactionClassifier.test.js",
	"dist-electron/electron/tests/consciousModeNodeImport.test.js",
	"dist-electron/electron/tests/answerLatencyTracker.test.js",
];

function runCommand(command, args, description) {
	const result = spawnSync(command, args, {
		stdio: "inherit",
		cwd: process.cwd(),
		env: process.env,
	});

	if (result.status !== 0) {
		throw new Error(`${description} failed`);
	}
}

function buildTscPath() {
	return path.join(
		process.cwd(),
		"node_modules",
		".bin",
		process.platform === "win32" ? "tsc.cmd" : "tsc",
	);
}

function buildClassifier(mode, providers) {
	if (mode === "foundation") {
		const provider = new providers.FoundationModelsIntentProvider();
		return async (input) => {
			const result = await provider.classify(input);
			return {
				intent: result.intent,
				confidence: result.confidence,
				providerUsed: provider.name,
			};
		};
	}

	if (mode === "legacy") {
		const provider = new providers.LegacyIntentProvider();
		return async (input) => {
			const result = await provider.classify(input);
			return {
				intent: result.intent,
				confidence: result.confidence,
				providerUsed: provider.name,
			};
		};
	}

	const coordinator = new providers.IntentClassificationCoordinator(
		new providers.FoundationModelsIntentProvider(),
		new providers.LegacyIntentProvider(),
	);
	return async (input) => {
		const result = await coordinator.classify(input);
		return {
			intent: result.intent,
			confidence: result.confidence,
			providerUsed: result.provider,
			fallbackReason: result.fallbackReason,
		};
	};
}

async function runIntentComparison(label, cases) {
	const intentEval = require("../dist-electron/electron/evals/intentClassificationEval.js");
	const providers = require("../dist-electron/electron/llm/providers/index.js");

	const coordinated = await intentEval.runIntentEval(
		cases,
		buildClassifier("coordinated", providers),
	);
	const legacy = await intentEval.runIntentEval(
		cases,
		buildClassifier("legacy", providers),
	);
	const foundation = await intentEval.runIntentEval(
		cases,
		buildClassifier("foundation", providers),
	);

	return {
		label,
		promptVersion: coordinated.summary.promptVersion,
		schemaVersion: coordinated.summary.schemaVersion,
		coordinated: coordinated.summary,
		legacy: legacy.summary,
		foundation: foundation.summary,
	};
}

async function runReleaseVerification(options = {}) {
	runCommand("npm", ["run", "typecheck"], "typecheck");
	runCommand(
		"npm",
		["run", "prepare:macos:foundation-intent-helper"],
		"helper preparation",
	);
	runCommand(
		buildTscPath(),
		["-p", "electron/tsconfig.json"],
		"electron compilation",
	);
	runCommand(
		"node",
		["--test", ...TARGET_TEST_FILES],
		"targeted intent/conscious tests",
	);

	const {
		runConsciousEvalHarness,
		runConsciousReplayHarness,
	} = require("../dist-electron/electron/conscious/ConsciousEvalHarness.js");
	const {
		ConsciousVerifier,
	} = require("../dist-electron/electron/conscious/ConsciousVerifier.js");
	const {
		DEFAULT_INTENT_EVAL_CASES,
	} = require("../dist-electron/electron/evals/intentClassificationEval.js");
	const {
		runFoundationIntentLatencySpike,
	} = require("./run-foundation-intent-latency-spike.js");

	const verifier = new ConsciousVerifier();
	const conscious = await runConsciousEvalHarness({ verifier });
	const replay = await runConsciousReplayHarness({ verifier });
	if (conscious.summary.failed > 0 || replay.summary.failed > 0) {
		throw new Error("conscious eval harness reported failures");
	}

	const comparisons = [
		await runIntentComparison("default", DEFAULT_INTENT_EVAL_CASES),
	];
	const includeGenerated =
		options.includeGenerated ??
		process.env.NATIVELY_FOUNDATION_RELEASE_INCLUDE_GENERATED !== "0";
	if (includeGenerated) {
		const generatedPath = path.join(
			process.cwd(),
			"electron",
			"evals",
			"intentEvalVariants.generated.json",
		);
		if (fs.existsSync(generatedPath)) {
			const generatedPayload = JSON.parse(
				fs.readFileSync(generatedPath, "utf8"),
			);
			const generatedCases = Array.isArray(generatedPayload)
				? generatedPayload
				: generatedPayload.cases;
			comparisons.push(await runIntentComparison("generated", generatedCases));
		}
	}

	for (const comparison of comparisons) {
		if (comparison.coordinated.accuracy < comparison.legacy.accuracy) {
			throw new Error(
				`coordinated accuracy regressed below legacy on ${comparison.label}`,
			);
		}
	}

	const latencySpike = await runFoundationIntentLatencySpike({ runs: 12 });
	if (!latencySpike.available) {
		throw new Error("foundation provider unavailable for latency spike");
	}

	return {
		conscious: {
			summary: conscious.summary,
			replaySummary: replay.summary,
		},
		intentComparisons: comparisons,
		latencySpike,
	};
}

async function main() {
	const report = await runReleaseVerification();
	console.log("\nFoundation Intent Release Verification");
	console.log("=====================================");
	console.log(JSON.stringify(report, null, 2));
}

if (require.main === module) {
	main().catch((error) => {
		console.error(
			"Foundation intent release verification failed:",
			error instanceof Error ? error.message : String(error),
		);
		process.exitCode = 1;
	});
}

module.exports = {
	TARGET_TEST_FILES,
	runReleaseVerification,
};
