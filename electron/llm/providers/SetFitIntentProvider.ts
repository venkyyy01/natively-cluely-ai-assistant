// electron/llm/providers/SetFitIntentProvider.ts
// SetFit-based few-shot intent classifier.
// Uses a persistent Python subprocess for SetFit inference when a trained model
// is available, falling back to Xenova/transformers SLM otherwise.
//
// Architecture:
//   SetFit (this) → 15-40ms via Python subprocess, few-shot trained on interview intents
//   Foundation Model → 2-3s, fallback for ambiguous/complex cases

import * as child_process from "node:child_process";
import * as path from "node:path";
import { traceLogger } from "../../tracing";
import {
	isElectronAppPackaged,
	resolveBundledModelsPath,
} from "../../utils/modelPaths";
import { loadTransformers } from "../../utils/transformersLoader";
import type { ConversationIntent, IntentResult } from "../IntentClassifier";
import { getAnswerShapeGuidance, SLM_LABEL_MAP } from "../IntentClassifier";
import {
	createIntentProviderError,
	type IntentClassificationInput,
	type IntentInferenceProvider,
} from "./IntentInferenceProvider";

export interface SetFitIntentProviderOptions {
	/** Model ID or local path. Defaults to bundled SetFit model if available. */
	modelName?: string;
	/** Minimum confidence to accept a classification. */
	minConfidence?: number;
	/** Timeout for a single inference call. */
	inferenceTimeoutMs?: number;
	/** Whether to use quantized model (Xenova fallback only). */
	quantized?: boolean;
	/** Path to Python executable. */
	pythonPath?: string;
}

const DEFAULT_MIN_CONFIDENCE = 0.65;
const DEFAULT_INFERENCE_TIMEOUT_MS = 150; // Slightly higher for IPC overhead
const SETFIT_MODEL_PATH = "setfit-intent-v1";

interface PendingRequest {
	resolve: (value: any) => void;
	reject: (reason: any) => void;
	timer: ReturnType<typeof setTimeout>;
}

export class SetFitIntentProvider implements IntentInferenceProvider {
	readonly name = "setfit";

	private pipe: any = null;
	private loadingPromise: Promise<void> | null = null;
	private loadFailed = false;
	private modelName: string;
	private minConfidence: number;
	private inferenceTimeoutMs: number;
	private quantized: boolean;
	private pythonPath: string;

	// Python subprocess state
	private pythonProc: child_process.ChildProcess | null = null;
	private pythonReady = false;
	private requestId = 0;
	private pendingRequests = new Map<number, PendingRequest>();

	constructor(options: SetFitIntentProviderOptions = {}) {
		this.modelName = options.modelName ?? SETFIT_MODEL_PATH;
		this.minConfidence = options.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
		this.inferenceTimeoutMs =
			options.inferenceTimeoutMs ?? DEFAULT_INFERENCE_TIMEOUT_MS;
		this.quantized = options.quantized ?? true;
		this.pythonPath = options.pythonPath ?? "python3";
	}

	async isAvailable(): Promise<boolean> {
		if (this.pythonReady || this.pipe) {
			return true;
		}
		if (this.loadFailed) {
			return false;
		}
		try {
			await this.ensureLoaded();
			return this.pythonReady || this.pipe !== null;
		} catch {
			return false;
		}
	}

	async classify(input: IntentClassificationInput): Promise<IntentResult> {
		await this.ensureLoaded();

		const question = input.lastInterviewerTurn?.trim();
		if (!question) {
			throw createIntentProviderError(
				"invalid_response",
				"Empty question for SetFit classification",
			);
		}

		const traceId = input.traceId;
		const modelStartTime = Date.now();
		const spanId = traceId ? `setfit-${modelStartTime}` : undefined;

		try {
			let result: {
				intent: ConversationIntent;
				confidence: number;
				latencyMs: number;
			};

			if (this.pythonReady && this.pythonProc) {
				result = await this.runPythonInference(question);
			} else if (this.pipe) {
				result = await this.runXenovaInference(question);
			} else {
				throw createIntentProviderError(
					"model_not_ready",
					"SetFit model not loaded",
				);
			}

			const modelLatencyMs = Date.now() - modelStartTime;

			// If confidence is below threshold, delegate to foundation
			if (result.confidence < this.minConfidence) {
				console.log(
					`[SetFitIntentProvider] Low confidence ${(result.confidence * 100).toFixed(1)}% ` +
						`for "${result.intent}" — delegating to foundation model`,
				);
				throw createIntentProviderError(
					"invalid_response",
					`SetFit confidence ${result.confidence.toFixed(3)} below threshold ${this.minConfidence}`,
				);
			}

			console.log(
				`[SetFitIntentProvider] Classified as "${result.intent}" ` +
					`(${result.confidence.toFixed(3)}) in ${modelLatencyMs}ms: "${question.substring(0, 60)}..."`,
			);

			if (traceId) {
				traceLogger.logModelInvocation(traceId, spanId, {
					modelName: this.name,
					modelVersion: this.modelName,
					latencyMs: modelLatencyMs,
					inputTokens: question.length / 4,
				});
			}

			return {
				intent: result.intent,
				confidence: result.confidence,
				answerShape: getAnswerShapeGuidance(result.intent),
				latencyMs: modelLatencyMs,
			};
		} catch (error) {
			if (traceId) {
				traceLogger.logModelInvocation(traceId, spanId, {
					modelName: this.name,
					modelVersion: this.modelName,
					latencyMs: Date.now() - modelStartTime,
					error: error instanceof Error ? error.message : String(error),
				});
			}
			throw error;
		}
	}

	// ---------------------------------------------------------------------------
	// Python subprocess inference
	// ---------------------------------------------------------------------------

	private async runPythonInference(text: string): Promise<{
		intent: ConversationIntent;
		confidence: number;
		latencyMs: number;
	}> {
		return new Promise((resolve, reject) => {
			const id = ++this.requestId;
			const timer = setTimeout(() => {
				this.pendingRequests.delete(id);
				reject(
					createIntentProviderError(
						"timeout",
						`SetFit Python inference timed out after ${this.inferenceTimeoutMs}ms`,
					),
				);
			}, this.inferenceTimeoutMs);

			this.pendingRequests.set(id, {
				resolve: (resp: any) => {
					clearTimeout(timer);
					if (resp.error) {
						reject(createIntentProviderError("invalid_response", resp.error));
						return;
					}
					const intent = SLM_LABEL_MAP[resp.intent] || resp.intent;
					resolve({
						intent: intent as ConversationIntent,
						confidence: resp.confidence ?? 0.8,
						latencyMs: resp.latency_ms ?? 0,
					});
				},
				reject: (reason: any) => {
					clearTimeout(timer);
					reject(reason);
				},
				timer,
			});

			if (this.pythonProc?.stdin && !this.pythonProc.stdin.destroyed) {
				this.pythonProc.stdin.write(`${JSON.stringify({ id, text })}\n`);
			} else {
				this.pendingRequests.delete(id);
				clearTimeout(timer);
				reject(
					createIntentProviderError(
						"model_not_ready",
						"Python subprocess not available",
					),
				);
			}
		});
	}

	// ---------------------------------------------------------------------------
	// Xenova fallback inference
	// ---------------------------------------------------------------------------

	private async runXenovaInference(text: string): Promise<{
		intent: ConversationIntent;
		confidence: number;
		latencyMs: number;
	}> {
		const start = Date.now();
		const result = await new Promise<any>((resolve, reject) => {
			const timer = setTimeout(() => {
				reject(
					createIntentProviderError(
						"timeout",
						`SetFit Xenova inference timed out after ${this.inferenceTimeoutMs}ms`,
					),
				);
			}, this.inferenceTimeoutMs);

			this.pipe(text, { top_k: 3 })
				.then((r: unknown) => {
					clearTimeout(timer);
					resolve(r);
				})
				.catch((e: unknown) => {
					clearTimeout(timer);
					reject(e);
				});
		});

		const top = Array.isArray(result) ? result[0] : result;
		if (
			!top ||
			typeof top.label !== "string" ||
			typeof top.score !== "number"
		) {
			throw createIntentProviderError(
				"invalid_response",
				"SetFit Xenova returned malformed output",
			);
		}

		return {
			intent: (SLM_LABEL_MAP[top.label] || top.label) as ConversationIntent,
			confidence: top.score,
			latencyMs: Date.now() - start,
		};
	}

	// ---------------------------------------------------------------------------
	// Loading
	// ---------------------------------------------------------------------------

	private async ensureLoaded(): Promise<void> {
		if (this.pythonReady || this.pipe) return;
		if (this.loadFailed) return;

		if (this.loadingPromise) {
			await this.loadingPromise;
			return;
		}

		this.loadingPromise = this.doLoad();

		try {
			await this.loadingPromise;
		} catch {
			this.loadingPromise = null;
		}
	}

	private async doLoad(): Promise<void> {
		// Try Python subprocess first (real SetFit model)
		try {
			await this.tryLoadPythonServer();
			if (this.pythonReady) {
				return;
			}
		} catch (e) {
			console.warn("[SetFitIntentProvider] Python server load failed:", e);
		}

		// Fall back to Xenova/transformers
		try {
			await this.tryLoadXenova();
			if (this.pipe) {
				return;
			}
		} catch (e) {
			console.warn("[SetFitIntentProvider] Xenova fallback load failed:", e);
		}

		this.loadFailed = true;
	}

	private async tryLoadPythonServer(): Promise<void> {
		// Resolve model path
		let modelPath = this.modelName;
		if (!path.isAbsolute(modelPath)) {
			const bundled = resolveBundledModelsPath();
			const candidate = path.join(bundled, modelPath);
			if (require("node:fs").existsSync(candidate)) {
				modelPath = candidate;
			} else {
				// Also check relative to project root
				const rootCandidate = path.resolve(modelPath);
				if (require("node:fs").existsSync(rootCandidate)) {
					modelPath = rootCandidate;
				}
			}
		}

		if (!require("node:fs").existsSync(modelPath)) {
			throw new Error(`SetFit model not found at ${modelPath}`);
		}

		const scriptPath = path.resolve(__dirname, "../training/setfit_server.py");
		if (!require("node:fs").existsSync(scriptPath)) {
			throw new Error(`SetFit server script not found at ${scriptPath}`);
		}

		console.log(
			`[SetFitIntentProvider] Starting Python server: ${this.pythonPath} ${scriptPath} --model ${modelPath}`,
		);

		const proc = child_process.spawn(
			this.pythonPath,
			[scriptPath, "--model", modelPath],
			{
				stdio: ["pipe", "pipe", "pipe"],
				env: { ...process.env, PYTHONUNBUFFERED: "1" },
			},
		);

		this.pythonProc = proc;

		// Handle stdout responses
		proc.stdout?.on("data", (data: Buffer) => {
			const lines = data.toString().split("\n");
			for (const line of lines) {
				const trimmed = line.trim();
				if (!trimmed) continue;
				try {
					const resp = JSON.parse(trimmed);
					if (resp.status === "ready") {
						console.log(
							`[SetFitIntentProvider] Python server ready in ${resp.load_ms?.toFixed(0) ?? "?"}ms`,
						);
						this.pythonReady = true;
						continue;
					}
					if (resp.status === "loading") {
						continue;
					}
					const reqId = resp.id;
					if (reqId !== undefined && this.pendingRequests.has(reqId)) {
						const pending = this.pendingRequests.get(reqId);
						if (!pending) continue;
						this.pendingRequests.delete(reqId);
						pending.resolve(resp);
					}
				} catch {
					// Ignore non-JSON lines
				}
			}
		});

		proc.stderr?.on("data", (data: Buffer) => {
			const text = data.toString().trim();
			if (text) {
				console.warn("[SetFitIntentProvider] Python stderr:", text);
			}
		});

		proc.on("error", (err) => {
			console.error("[SetFitIntentProvider] Python process error:", err);
			this.pythonReady = false;
			this.pythonProc = null;
		});

		proc.on("close", (code) => {
			console.warn(
				`[SetFitIntentProvider] Python process exited with code ${code}`,
			);
			this.pythonReady = false;
			this.pythonProc = null;
		});

		// Wait for ready signal
		await new Promise<void>((resolve, reject) => {
			const timeout = setTimeout(() => {
				reject(new Error("Python server failed to start within 30s"));
			}, 30000);

			const checkInterval = setInterval(() => {
				if (this.pythonReady) {
					clearTimeout(timeout);
					clearInterval(checkInterval);
					resolve();
					return;
				}
				if (!this.pythonProc || this.pythonProc.killed) {
					clearTimeout(timeout);
					clearInterval(checkInterval);
					reject(new Error("Python process died before ready"));
				}
			}, 100);
		});
	}

	private async tryLoadXenova(): Promise<void> {
		const { pipeline, env } = await loadTransformers();
		env.allowRemoteModels = false;
		env.localModelPath = resolveBundledModelsPath();

		const modelsToTry = [this.modelName, "Xenova/nli-deberta-v3-small"];
		let lastError: unknown;

		for (const model of modelsToTry) {
			try {
				console.log(`[SetFitIntentProvider] Loading Xenova model: ${model}...`);
				this.pipe = await pipeline("text-classification", model, {
					local_files_only: isElectronAppPackaged(),
					quantized: this.quantized,
				});
				console.log(`[SetFitIntentProvider] Xenova model loaded: ${model}`);
				return;
			} catch (e) {
				lastError = e;
				console.warn(`[SetFitIntentProvider] Failed to load ${model}:`, e);
			}
		}

		throw lastError;
	}

	warmup(): void {
		this.ensureLoaded().catch(() => {});
	}

	/** Shut down the Python subprocess. Call on app exit. */
	dispose(): void {
		if (this.pythonProc && !this.pythonProc.killed) {
			this.pythonProc.kill("SIGTERM");
		}
		this.pythonProc = null;
		this.pythonReady = false;
	}
}
