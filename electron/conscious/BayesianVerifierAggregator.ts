export interface VerifierResult {
	name: string;
	confidence: number; // 0-1 confidence in the response
	passed: boolean; // Whether the verifier passed
	weight: number; // Relative weight of this verifier
}

export interface BayesianAggregationResult {
	posterior: number; // 0-1 aggregated confidence
	decision: "accept" | "reject" | "reroute";
	verifierResults: VerifierResult[];
}

const ACCEPT_THRESHOLD = 0.85;
const REJECT_THRESHOLD = 0.55;

export class BayesianVerifierAggregator {
	/**
	 * Aggregate multiple verifier results using product-of-experts
	 * This is a Bayesian approach where each verifier provides a likelihood
	 * and we compute the posterior probability that the response is good
	 */
	aggregate(results: VerifierResult[]): BayesianAggregationResult {
		if (results.length === 0) {
			return {
				posterior: 0,
				decision: "reject",
				verifierResults: [],
			};
		}

		// Filter out verifiers with zero weight or missing data
		const validResults = results.filter(
			(r) => r.weight > 0 && r.confidence >= 0,
		);

		if (validResults.length === 0) {
			return {
				posterior: 0,
				decision: "reject",
				verifierResults: results,
			};
		}

		// Renormalize weights
		const totalWeight = validResults.reduce((sum, r) => sum + r.weight, 0);
		const normalizedResults = validResults.map((r) => ({
			...r,
			weight: r.weight / totalWeight,
		}));

		// Product-of-experts aggregation
		// Each verifier contributes: (confidence^weight) if passed, (1 - confidence)^weight if failed
		let posterior = 1;
		for (const result of normalizedResults) {
			const likelihood = result.passed
				? result.confidence
				: 1 - result.confidence;
			posterior *= likelihood ** result.weight;
		}

		// Clamp to [0, 1]
		posterior = Math.max(0, Math.min(1, posterior));

		// Determine decision based on thresholds
		let decision: "accept" | "reject" | "reroute";
		if (posterior >= ACCEPT_THRESHOLD) {
			decision = "accept";
		} else if (posterior <= REJECT_THRESHOLD) {
			decision = "reject";
		} else {
			decision = "reroute";
		}

		return {
			posterior,
			decision,
			verifierResults: results,
		};
	}

	/**
	 * Create a verifier result from deterministic rule-based verification
	 */
	static deterministicResult(
		passed: boolean,
		confidence: number = 0.5,
	): VerifierResult {
		return {
			name: "deterministic",
			confidence,
			passed,
			weight: 0.3,
		};
	}

	/**
	 * Create a verifier result from provenance verification
	 */
	static provenanceResult(passed: boolean, confidence: number): VerifierResult {
		return {
			name: "provenance",
			confidence,
			passed,
			weight: 0.35,
		};
	}

	/**
	 * Create a verifier result from LLM judge
	 */
	static judgeResult(passed: boolean, confidence: number): VerifierResult {
		return {
			name: "judge",
			confidence,
			passed,
			weight: 0.35,
		};
	}

	/**
	 * Get the thresholds
	 */
	getAcceptThreshold(): number {
		return ACCEPT_THRESHOLD;
	}

	getRejectThreshold(): number {
		return REJECT_THRESHOLD;
	}
}
