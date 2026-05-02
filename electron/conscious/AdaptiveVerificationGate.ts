/**
 * AdaptiveVerificationGate
 *
 * Conscious mode runs every response through:
 *   1. ConsciousProvenanceVerifier (factual claim grounding)
 *   2. ConsciousVerifier (deterministic rules)
 *   3. LLM judge (semantic correctness)
 *
 * That's the right behaviour for technical answers. It is the WRONG
 * behaviour for "thanks", "got it", "actually can you make it shorter?",
 * etc. — those have no factual claims to ground, and forcing them through
 * the full pipeline either wastes a verification budget or fails closed
 * (the response is rejected, the candidate gets nothing).
 *
 * This gate decides which verifiers to run for a given turn, based on the
 * `VerificationLevel` produced by `HumanLikeConversationEngine`. Standard
 * mode never had to think about this because it just streams the LLM's
 * free-form text directly. We're matching that ergonomics for conscious
 * mode without dropping the safety net for technical claims.
 */

import type { VerificationLevel } from "./HumanLikeConversationEngine";

export interface VerificationPlan {
	runProvenance: boolean;
	runDeterministic: boolean;
	runJudge: boolean;
	/** Reason logged on the latency tracker for observability. */
	reason: string;
}

export class AdaptiveVerificationGate {
	/**
	 * Map a verification level to a concrete plan of which verifiers to run.
	 *
	 * - `strict`   → run everything (default conscious mode behaviour).
	 * - `moderate` → skip the LLM judge but keep deterministic + provenance.
	 * - `relaxed`  → only deterministic (cheap, fast). Provenance/judge skipped.
	 * - `skip`     → run nothing. Pure conversational acknowledgement.
	 *
	 * Even at `skip` we never bypass the rule-based deterministic verifier
	 * if the caller forces it (e.g. the response *did* mention a number) —
	 * the gate is advisory, not authoritative.
	 */
	buildPlan(level: VerificationLevel): VerificationPlan {
		switch (level) {
			case "strict":
				return {
					runProvenance: true,
					runDeterministic: true,
					runJudge: true,
					reason: "level_strict",
				};
			case "moderate":
				return {
					runProvenance: true,
					runDeterministic: true,
					runJudge: false,
					reason: "level_moderate_skip_judge",
				};
			case "relaxed":
				return {
					runProvenance: false,
					runDeterministic: true,
					runJudge: false,
					reason: "level_relaxed_rules_only",
				};
			case "skip":
				return {
					runProvenance: false,
					runDeterministic: false,
					runJudge: false,
					reason: "level_skip_pure_conversational",
				};
			default:
				// Defensive default: behave like strict if we ever get an unknown level.
				return {
					runProvenance: true,
					runDeterministic: true,
					runJudge: true,
					reason: "level_unknown_defaulting_strict",
				};
		}
	}

	/**
	 * Mix in the orchestrator's degraded-mode override. When the circuit
	 * breaker is open, we still want to run rule-based gates but never the
	 * LLM judge — even on strict turns. This mirrors the existing logic in
	 * `ConsciousOrchestrator.executeReasoningFirst`.
	 */
	applyDegradedMode(
		plan: VerificationPlan,
		degradedMode: boolean,
	): VerificationPlan {
		if (!degradedMode) return plan;
		return {
			...plan,
			runJudge: false,
			reason: `${plan.reason}_with_degraded_mode`,
		};
	}

	/**
	 * If the caller asked us to skip the judge explicitly (e.g. the prompt
	 * is a low-stakes acknowledgement), respect that.
	 */
	applyExplicitSkipJudge(
		plan: VerificationPlan,
		skipJudge: boolean,
	): VerificationPlan {
		if (!skipJudge) return plan;
		return {
			...plan,
			runJudge: false,
			reason: `${plan.reason}_with_explicit_skip_judge`,
		};
	}
}
