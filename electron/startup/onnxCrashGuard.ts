import {
	incrementOnnxFailureCount,
	resetOnnxFailureCount,
	shouldDisableOnnx,
} from "./StartupHealer";

/**
 * NAT-SELF-HEAL: ONNX / CoreML crash isolation wrapper.
 *
 * The onnxruntime-node binding can segfault during session teardown
 * (EXC_BAD_ACCESS in OrtApis::ReleaseIoBinding). When this happens in
 * the main Electron process it corrupts the heap and causes downstream
 * AI requests to return null.
 *
 * This wrapper:
 *   1. Catches creation failures and disables ANE after repeated crashes
 *   2. Wraps the session in a safe proxy that swallows teardown errors
 *   3. Tracks success so we can re-enable ANE once it stabilizes
 */

const SUCCESS_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
let onnxSuccessTimestamp = 0;

export type SafeOnnxSession = {
	run: (feeds: any, options?: any) => Promise<any>;
	release: () => Promise<void>;
};

/**
 * Wrap an ONNX InferenceSession so that release() never throws.
 */
function wrapSession(session: any): SafeOnnxSession {
	return {
		async run(feeds: any, options?: any): Promise<any> {
			return session.run(feeds, options);
		},
		async release(): Promise<void> {
			try {
				await session.release?.();
			} catch (err) {
				// Swallow — teardown segfaults are a known issue
				console.warn("[OnnxCrashGuard] Swallowed session release error:", err);
			}
		},
	};
}

/**
 * Create an ONNX InferenceSession with crash isolation.
 * Returns null if ANE should be disabled due to repeated crashes.
 */
export async function safeCreateOnnxSession(
	runtime: any,
	modelPath: string,
	options: any,
): Promise<SafeOnnxSession | null> {
	if (shouldDisableOnnx()) {
		console.warn(
			"[OnnxCrashGuard] ANE embeddings disabled due to repeated ONNX crashes.",
		);
		return null;
	}

	try {
		const session = await runtime.InferenceSession.create(modelPath, options);
		onnxSuccessTimestamp = Date.now();
		console.log("[OnnxCrashGuard] ONNX session created successfully.");

		// If we've had enough consecutive successes, reset the failure counter
		if (onnxSuccessTimestamp > 0) {
			resetOnnxFailureCount();
		}

		return wrapSession(session);
	} catch (error) {
		const count = incrementOnnxFailureCount();
		console.error(
			`[OnnxCrashGuard] ONNX session creation failed (failure #${count}):`,
			error,
		);
		if (count >= 3) {
			console.error(
				"[OnnxCrashGuard] ANE embeddings will be disabled for the remainder of this session. " +
					"Restart Natively to attempt re-enabling.",
			);
		}
		return null;
	}
}

/**
 * Record an ONNX crash that happened outside of our wrapper (e.g., segfault
 * caught by crash reporter). This bumps the failure count so the next
 * startup disables ANE.
 */
export function recordOnnxCrash(): void {
	const count = incrementOnnxFailureCount();
	console.error(
		`[OnnxCrashGuard] Recorded external ONNX crash. Failure count = ${count}`,
	);
}
