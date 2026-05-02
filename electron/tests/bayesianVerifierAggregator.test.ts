import assert from "node:assert";
import { describe, it } from "node:test";
import { BayesianVerifierAggregator } from "../conscious/BayesianVerifierAggregator";

describe("BayesianVerifierAggregator", () => {
	it("should accept when all verifiers pass", () => {
		const aggregator = new BayesianVerifierAggregator();
		const results = [
			BayesianVerifierAggregator.deterministicResult(true, 0.95),
			BayesianVerifierAggregator.provenanceResult(true, 0.9),
			BayesianVerifierAggregator.judgeResult(true, 0.85),
		];

		const aggregation = aggregator.aggregate(results);
		assert.strictEqual(aggregation.decision, "accept");
		assert.ok(
			aggregation.posterior >= 0.85,
			`Posterior should be >= 0.85, got ${aggregation.posterior}`,
		);
	});

	it("should reject when all verifiers fail", () => {
		const aggregator = new BayesianVerifierAggregator();
		const results = [
			BayesianVerifierAggregator.deterministicResult(false, 0.9), // High confidence in failure
			BayesianVerifierAggregator.provenanceResult(false, 0.85),
			BayesianVerifierAggregator.judgeResult(false, 0.8),
		];

		const aggregation = aggregator.aggregate(results);
		assert.strictEqual(aggregation.decision, "reject");
		assert.ok(
			aggregation.posterior <= 0.55,
			`Posterior should be <= 0.55, got ${aggregation.posterior}`,
		);
	});

	it("should reroute when single verifier fails on otherwise-good response", () => {
		const aggregator = new BayesianVerifierAggregator();
		const results = [
			BayesianVerifierAggregator.deterministicResult(false, 0.4), // Single failure
			BayesianVerifierAggregator.provenanceResult(true, 0.9),
			BayesianVerifierAggregator.judgeResult(true, 0.85),
		];

		const aggregation = aggregator.aggregate(results);
		assert.strictEqual(aggregation.decision, "reroute");
		assert.ok(
			aggregation.posterior > 0.55 && aggregation.posterior < 0.85,
			`Posterior should be in uncertain range, got ${aggregation.posterior}`,
		);
	});

	it("should handle missing verifiers gracefully", () => {
		const aggregator = new BayesianVerifierAggregator();
		const results = [
			BayesianVerifierAggregator.deterministicResult(true, 0.8),
			BayesianVerifierAggregator.provenanceResult(true, 0.85),
			// Judge missing
		];

		const aggregation = aggregator.aggregate(results);
		assert.ok(
			aggregation.decision !== undefined,
			"Should make a decision even with missing verifier",
		);
	});

	it("should handle zero-weight verifiers", () => {
		const aggregator = new BayesianVerifierAggregator();
		const results = [
			{ name: "zero_weight", confidence: 0.5, passed: true, weight: 0 },
			BayesianVerifierAggregator.deterministicResult(true, 0.8),
		];

		const aggregation = aggregator.aggregate(results);
		assert.ok(
			aggregation.decision !== undefined,
			"Should handle zero-weight verifiers",
		);
	});

	it("should return reject when no valid results", () => {
		const aggregator = new BayesianVerifierAggregator();
		const results = [
			{ name: "zero_weight", confidence: 0.5, passed: true, weight: 0 },
		];

		const aggregation = aggregator.aggregate(results);
		assert.strictEqual(aggregation.decision, "reject");
		assert.strictEqual(aggregation.posterior, 0);
	});

	it("should clamp posterior to [0, 1]", () => {
		const aggregator = new BayesianVerifierAggregator();

		// All pass should give posterior close to 1
		const passResults = [
			BayesianVerifierAggregator.deterministicResult(true, 1.0),
			BayesianVerifierAggregator.provenanceResult(true, 1.0),
			BayesianVerifierAggregator.judgeResult(true, 1.0),
		];
		const passAggregation = aggregator.aggregate(passResults);
		assert.ok(
			passAggregation.posterior <= 1,
			`Posterior should be <= 1, got ${passAggregation.posterior}`,
		);

		// All fail should give posterior close to 0
		const failResults = [
			BayesianVerifierAggregator.deterministicResult(false, 0.0),
			BayesianVerifierAggregator.provenanceResult(false, 0.0),
			BayesianVerifierAggregator.judgeResult(false, 0.0),
		];
		const failAggregation = aggregator.aggregate(failResults);
		assert.ok(
			failAggregation.posterior >= 0,
			`Posterior should be >= 0, got ${failAggregation.posterior}`,
		);
	});

	it("should provide threshold getters", () => {
		const aggregator = new BayesianVerifierAggregator();
		assert.strictEqual(aggregator.getAcceptThreshold(), 0.85);
		assert.strictEqual(aggregator.getRejectThreshold(), 0.55);
	});

	it("should normalize weights correctly", () => {
		const aggregator = new BayesianVerifierAggregator();
		const results = [
			{ name: "v1", confidence: 0.8, passed: true, weight: 2 },
			{ name: "v2", confidence: 0.8, passed: true, weight: 1 },
			{ name: "v3", confidence: 0.8, passed: true, weight: 1 },
		];

		const aggregation = aggregator.aggregate(results);
		assert.ok(
			aggregation.decision !== undefined,
			"Should handle uneven weights",
		);
	});
});
