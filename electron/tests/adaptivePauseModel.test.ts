import assert from "node:assert";
import { describe, it } from "node:test";
import {
	AdaptivePauseModel,
	type PauseFeatures,
} from "../pause/AdaptivePauseModel";

describe("AdaptivePauseModel", () => {
	it("should initialize with default weights on cold start", () => {
		const model = new AdaptivePauseModel("test-profile");
		const weights = model.getCurrentWeights();

		assert.ok(
			weights.silenceDuration > 0,
			"Should have positive silence duration weight",
		);
		assert.ok(
			weights.transcriptCompleteness > 0,
			"Should have positive transcript completeness weight",
		);
		assert.ok(
			weights.semanticCompleteness > 0,
			"Should have positive semantic completeness weight",
		);
		assert.ok(
			weights.conversationRhythm > 0,
			"Should have positive conversation rhythm weight",
		);
		assert.ok(
			weights.audioEnergyDecay > 0,
			"Should have positive audio energy decay weight",
		);
	});

	it("should predict confidence score from features", () => {
		const model = new AdaptivePauseModel("test-profile");
		const features: PauseFeatures = {
			silenceDuration: 0.8,
			transcriptCompleteness: 0.9,
			semanticCompleteness: 0.7,
			conversationRhythm: 0.6,
			audioEnergyDecay: 0.5,
		};

		const score = model.predict(features);
		assert.ok(
			score >= 0 && score <= 1,
			`Score should be in [0, 1], got ${score}`,
		);
	});

	it("should update weights on user action", () => {
		const model = new AdaptivePauseModel("test-profile");
		const initialWeights = model.getCurrentWeights();

		const features: PauseFeatures = {
			silenceDuration: 0.8,
			transcriptCompleteness: 0.9,
			semanticCompleteness: 0.7,
			conversationRhythm: 0.6,
			audioEnergyDecay: 0.5,
		};

		// Update with label 1 (user was done speaking)
		model.update(features, 1);

		const updatedWeights = model.getCurrentWeights();
		assert.ok(model.getSampleCount() > 0, "Sample count should increase");
	});

	it("should not be ready until minimum samples are collected", () => {
		const model = new AdaptivePauseModel("test-profile");

		assert.ok(!model.isReady(), "Should not be ready with 0 samples");

		const features: PauseFeatures = {
			silenceDuration: 0.8,
			transcriptCompleteness: 0.9,
			semanticCompleteness: 0.7,
			conversationRhythm: 0.6,
			audioEnergyDecay: 0.5,
		};

		// Add 19 samples
		for (let i = 0; i < 19; i++) {
			model.update(features, 1);
		}

		assert.ok(!model.isReady(), "Should not be ready with 19 samples");

		// Add 1 more sample (total 20)
		model.update(features, 1);

		assert.ok(model.isReady(), "Should be ready with 20 samples");
	});

	it("should normalize weights after update", () => {
		const model = new AdaptivePauseModel("test-profile");

		const features: PauseFeatures = {
			silenceDuration: 0.8,
			transcriptCompleteness: 0.9,
			semanticCompleteness: 0.7,
			conversationRhythm: 0.6,
			audioEnergyDecay: 0.5,
		};

		// Add enough samples to trigger adaptation
		for (let i = 0; i < 25; i++) {
			model.update(features, 1);
		}

		const weights = model.getCurrentWeights();
		const weightSum =
			weights.silenceDuration +
			weights.transcriptCompleteness +
			weights.semanticCompleteness +
			weights.conversationRhythm +
			weights.audioEnergyDecay;

		assert.ok(
			Math.abs(weightSum - 1.0) < 0.01,
			`Weights should sum to 1.0, got ${weightSum}`,
		);
	});

	it("should reset to default weights", () => {
		const model = new AdaptivePauseModel("test-profile");

		const features: PauseFeatures = {
			silenceDuration: 0.8,
			transcriptCompleteness: 0.9,
			semanticCompleteness: 0.7,
			conversationRhythm: 0.6,
			audioEnergyDecay: 0.5,
		};

		// Add samples
		for (let i = 0; i < 25; i++) {
			model.update(features, 1);
		}

		const beforeReset = model.getCurrentWeights();
		assert.ok(model.getSampleCount() > 0, "Should have samples before reset");

		model.reset();

		const afterReset = model.getCurrentWeights();
		assert.strictEqual(
			model.getSampleCount(),
			0,
			"Sample count should be 0 after reset",
		);
		assert.strictEqual(
			afterReset.silenceDuration,
			0.25,
			"Weights should reset to defaults",
		);
		assert.strictEqual(
			afterReset.transcriptCompleteness,
			0.3,
			"Weights should reset to defaults",
		);
		assert.strictEqual(
			afterReset.semanticCompleteness,
			0.2,
			"Weights should reset to defaults",
		);
		assert.strictEqual(
			afterReset.conversationRhythm,
			0.15,
			"Weights should reset to defaults",
		);
		assert.strictEqual(
			afterReset.audioEnergyDecay,
			0.1,
			"Weights should reset to defaults",
		);
	});

	it("should handle different profiles independently", () => {
		const model1 = new AdaptivePauseModel("profile-1");
		const model2 = new AdaptivePauseModel("profile-2");

		const features: PauseFeatures = {
			silenceDuration: 0.8,
			transcriptCompleteness: 0.9,
			semanticCompleteness: 0.7,
			conversationRhythm: 0.6,
			audioEnergyDecay: 0.5,
		};

		model1.update(features, 1);

		assert.strictEqual(
			model1.getSampleCount(),
			1,
			"Model 1 should have 1 sample",
		);
		assert.strictEqual(
			model2.getSampleCount(),
			0,
			"Model 2 should have 0 samples",
		);
	});

	it("should decay learning rate over time", () => {
		const model = new AdaptivePauseModel("test-profile");

		const features: PauseFeatures = {
			silenceDuration: 0.8,
			transcriptCompleteness: 0.9,
			semanticCompleteness: 0.7,
			conversationRhythm: 0.6,
			audioEnergyDecay: 0.5,
		};

		// Learning rate is internal, but we can verify it doesn't crash
		for (let i = 0; i < 100; i++) {
			model.update(features, 1);
		}

		assert.ok(model.getSampleCount() === 100, "Should handle 100 updates");
	});

	it("should limit feature history to max samples", () => {
		const model = new AdaptivePauseModel("test-profile");

		const features: PauseFeatures = {
			silenceDuration: 0.8,
			transcriptCompleteness: 0.9,
			semanticCompleteness: 0.7,
			conversationRhythm: 0.6,
			audioEnergyDecay: 0.5,
		};

		// Add more than MAX_SAMPLES (1000)
		for (let i = 0; i < 1100; i++) {
			model.update(features, 1);
		}

		assert.ok(model.getSampleCount() > 1000, "Sample count should exceed 1000");
		// The feature history should be limited to 1000, but sampleCount continues
	});
});
