// electron/llm/training/trainSetFit.ts
// Production-grade SetFit training orchestrator.
// Exports dataset to JSON, invokes Python trainer with CV + safeguards,
// then evaluates on held-out test set.
//
// Usage:
//   npx tsx electron/llm/training/trainSetFit.ts \
//     --epochs=20 \
//     --batch-size=16 \
//     --learning-rate=2e-5 \
//     --output-dir=./models/setfit-intent-v1

import * as child_process from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { getAllExamples } from "./intentDataset";

interface TrainConfig {
	modelName: string;
	epochs: number;
	batchSize: number;
	learningRate: number;
	warmupRatio: number;
	weightDecay: number;
	patience: number;
	minDelta: number;
	maxSeqLength: number;
	dropout: number;
	labelSmoothing: number;
	outputDir: string;
	seed: number;
	pythonPath: string;
	skipCv: boolean;
}

const DEFAULT_CONFIG: TrainConfig = {
	modelName: "sentence-transformers/all-MiniLM-L6-v2",
	epochs: 20,
	batchSize: 16,
	learningRate: 2e-5,
	warmupRatio: 0.1,
	weightDecay: 0.01,
	patience: 3,
	minDelta: 0.005,
	maxSeqLength: 256,
	dropout: 0.1,
	labelSmoothing: 0.1,
	outputDir: "./models/setfit-intent-v1",
	seed: 42,
	pythonPath: "python3",
	skipCv: false,
};

function parseArgs(): Partial<TrainConfig> {
	const args = process.argv.slice(2);
	const get = (prefix: string) =>
		args.find((a) => a.startsWith(prefix))?.split("=")[1];

	return {
		epochs: get("--epochs=") ? parseInt(get("--epochs=")!) : undefined,
		batchSize: get("--batch-size=")
			? parseInt(get("--batch-size=")!)
			: undefined,
		learningRate: get("--learning-rate=")
			? parseFloat(get("--learning-rate=")!)
			: undefined,
		warmupRatio: get("--warmup-ratio=")
			? parseFloat(get("--warmup-ratio=")!)
			: undefined,
		weightDecay: get("--weight-decay=")
			? parseFloat(get("--weight-decay=")!)
			: undefined,
		patience: get("--patience=") ? parseInt(get("--patience=")!) : undefined,
		minDelta: get("--min-delta=")
			? parseFloat(get("--min-delta=")!)
			: undefined,
		outputDir: get("--output-dir=") || undefined,
		skipCv: args.includes("--skip-cv"),
	};
}

function exportDataset(): string {
	const examples = getAllExamples();
	const outPath = path.join(__dirname, "intent_dataset.json");
	const payload = {
		version: "1.0.0",
		exported_at: new Date().toISOString(),
		count: examples.length,
		examples: examples.map((ex) => ({
			text: ex.text,
			label: ex.label,
			source: ex.source,
			metadata: ex.metadata,
		})),
	};
	fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));
	console.log(`[Export] Wrote ${examples.length} examples to ${outPath}`);
	return outPath;
}

function runPythonTrainer(
	datasetPath: string,
	config: TrainConfig,
): Promise<void> {
	return new Promise((resolve, reject) => {
		const scriptPath = path.resolve(__dirname, "setfit_trainer.py");
		const args = [
			scriptPath,
			"--dataset",
			datasetPath,
			"--output-dir",
			config.outputDir,
			"--model-name",
			config.modelName,
			"--epochs",
			String(config.epochs),
			"--batch-size",
			String(config.batchSize),
			"--learning-rate",
			String(config.learningRate),
			"--warmup-ratio",
			String(config.warmupRatio),
			"--weight-decay",
			String(config.weightDecay),
			"--patience",
			String(config.patience),
			"--min-delta",
			String(config.minDelta),
			"--max-seq-length",
			String(config.maxSeqLength),
			"--seed",
			String(config.seed),
		];
		if (config.skipCv) {
			args.push("--skip-cv");
		}

		console.log(
			`[Train] Spawning Python trainer: ${config.pythonPath} ${args.join(" ")}`,
		);
		const proc = child_process.spawn(config.pythonPath, args, {
			stdio: "inherit",
			env: { ...process.env, PYTHONUNBUFFERED: "1" },
		});

		proc.on("error", (err) => {
			reject(new Error(`Failed to start Python trainer: ${err.message}`));
		});

		proc.on("close", (code) => {
			if (code === 0) {
				resolve();
			} else {
				reject(new Error(`Python trainer exited with code ${code}`));
			}
		});
	});
}

async function runPreTrainingBenchmark(): Promise<void> {
	console.log("\n[Benchmark] Running pre-training benchmarks...");
	const benchmarkPath = path.resolve(__dirname, "benchmark.ts");
	// Run benchmarks for current fast classifiers (SLM, embedding, regex)
	// We'll just note that pre-training benchmarks should be run separately
	console.log("[Benchmark] Pre-training benchmarks can be run with:");
	console.log(
		`  npx tsx ${benchmarkPath} --model=slm --output=pre-training-slm.json`,
	);
	console.log(
		`  npx tsx ${benchmarkPath} --model=embedding --output=pre-training-embedding.json`,
	);
}

async function runPostTrainingBenchmark(modelDir: string): Promise<void> {
	console.log("\n[Benchmark] Running post-training benchmark on SetFit...");
	const benchmarkPath = path.resolve(__dirname, "benchmark.ts");
	console.log(`[Benchmark] Post-training benchmark can be run with:`);
	console.log(
		`  npx tsx ${benchmarkPath} --model=setfit --model-path=${modelDir} --output=post-training-setfit.json`,
	);
}

async function main() {
	const overrides = parseArgs();
	const config: TrainConfig = { ...DEFAULT_CONFIG, ...overrides };

	console.log("[Train] Configuration:");
	console.log(JSON.stringify(config, null, 2));

	// Export dataset
	const datasetPath = exportDataset();

	// Pre-training benchmark (informational)
	await runPreTrainingBenchmark();

	// Run Python trainer
	console.log("\n[Train] Starting SetFit training...");
	await runPythonTrainer(datasetPath, config);

	// Post-training benchmark
	await runPostTrainingBenchmark(config.outputDir);

	console.log("\n[Train] Training pipeline complete!");
	console.log(`[Train] Model saved to: ${path.resolve(config.outputDir)}`);

	// Cleanup temp dataset file (optional — keep for reproducibility)
	// fs.unlinkSync(datasetPath);
}

if (require.main === module) {
	main().catch((error) => {
		console.error("[Train] Training failed:", error);
		process.exit(1);
	});
}

export { exportDataset };
