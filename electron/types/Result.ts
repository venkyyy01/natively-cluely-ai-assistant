/**
 * Typed Result Pattern for Robust Error Handling
 *
 * HIGH RELIABILITY FIX:
 * Replaces error swallowing with explicit success/failure states
 * that force callers to handle errors properly.
 */

export type Result<T, E = Error> =
	| { success: true; data: T; error?: never }
	| { success: false; error: E; data?: never };

/**
 * Specialized error type for LLM operations
 */
export class LLMError extends Error {
	public override readonly cause?: unknown;
	public readonly context?: Record<string, any>;
	// Override name property from Error base class
	public override readonly name: string = "LLMError";

	constructor(message: string, cause?: unknown, context?: Record<string, any>) {
		super(message);
		Object.setPrototypeOf(this, LLMError.prototype);
		this.cause = cause;
		this.context = context;

		// Preserve error stack trace
		if (cause instanceof Error) {
			this.stack = cause.stack;
		}
	}
}

/**
 * Helper functions for creating Results
 */
export const Ok = <T>(data: T): Result<T, never> => ({
	success: true,
	data,
});

export const Err = <E>(error: E): Result<never, E> => ({
	success: false,
	error,
});

/**
 * Helper to wrap async functions that might throw
 */
export async function wrapAsync<T>(
	fn: () => Promise<T>,
	errorMessage?: string,
	context?: Record<string, any>,
): Promise<Result<T, LLMError>> {
	try {
		const data = await fn();
		return Ok(data);
	} catch (error) {
		const llmError = new LLMError(
			errorMessage || "Operation failed",
			error,
			context,
		);
		return Err(llmError);
	}
}

/**
 * Helper to wrap sync functions that might throw
 */
export function wrapSync<T>(
	fn: () => T,
	errorMessage?: string,
	context?: Record<string, any>,
): Result<T, LLMError> {
	try {
		const data = fn();
		return Ok(data);
	} catch (error) {
		const llmError = new LLMError(
			errorMessage || "Operation failed",
			error,
			context,
		);
		return Err(llmError);
	}
}
