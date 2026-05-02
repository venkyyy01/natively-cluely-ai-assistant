import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, it } from "node:test";
import { setOptimizationFlagsForTesting } from "../config/optimizations";
import { ANEEmbeddingProvider } from "../rag/providers/ANEEmbeddingProvider";

describe("ANEEmbeddingProvider", () => {
	let provider: ANEEmbeddingProvider;

	beforeEach(() => {
		setOptimizationFlagsForTesting({
			accelerationEnabled: false,
			useANEEmbeddings: true,
		});
		provider = new ANEEmbeddingProvider();
	});

	it("skips initialization when the master acceleration toggle is off", async () => {
		await provider.initialize();

		assert.equal(provider.isInitialized(), false);
		assert.equal(await provider.isAvailable(), false);
	});

	it("meanPool returns a normalized embedding for attended tokens", () => {
		const pooled = (provider as any).meanPool(
			Float32Array.from([1, 0, 0, 1]),
			[1, 1],
		);

		assert.equal(pooled.length, 2);
		assert.ok(Math.abs(pooled[0] - Math.SQRT1_2) < 1e-12);
		assert.ok(Math.abs(pooled[1] - Math.SQRT1_2) < 1e-12);
	});

	it("embedBatch delegates to embed for each input in order", async () => {
		const seen: string[] = [];
		(provider as any).embed = async (text: string) => {
			seen.push(text);
			return [text.length];
		};

		const embeddings = await provider.embedBatch([
			"Hello world",
			"Test input",
			"Sample text",
		]);

		assert.deepEqual(seen, ["Hello world", "Test input", "Sample text"]);
		assert.deepEqual(embeddings, [[11], [10], [11]]);
	});

	it("throws a clear error when embed is called before initialization", async () => {
		await assert.rejects(
			() => provider.embed("Hello world"),
			/ANEEmbeddingProvider not initialized/,
		);
	});

	it("normalizes tokenizer outputs that use inputIds without an explicit attention mask", () => {
		const normalized = (provider as any).normalizeTokenization({
			inputIds: Uint32Array.from([101, 102, 103]),
		});

		assert.deepEqual(normalized, {
			ids: [101, 102, 103],
			attentionMask: [1, 1, 1],
		});
	});

	it("resolves bundled model assets from the shared models directory helper", () => {
		const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ane-model-path-"));
		const modelsPath = path.join(tempRoot, "resources", "models");
		const originalCwd = process.cwd();

		fs.mkdirSync(modelsPath, { recursive: true });
		process.chdir(tempRoot);

		try {
			assert.equal(
				(provider as any).getModelPath(),
				path.join(
					fs.realpathSync(modelsPath),
					"Xenova",
					"all-MiniLM-L6-v2",
					"onnx",
					"model_quantized.onnx",
				),
			);
		} finally {
			process.chdir(originalCwd);
		}
	});
});
