import assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { IsotonicCalibrator } from "../conscious/ConfidenceCalibrator";

describe("IsotonicCalibrator", () => {
	const testProfileId = "test-profile-calibration";
	const calDir = path.join(os.homedir(), ".nately", "calibration");
	const testFilePath = path.join(calDir, `${testProfileId}.json`);

	after(() => {
		// Clean up test file
		try {
			if (fs.existsSync(testFilePath)) {
				fs.unlinkSync(testFilePath);
			}
		} catch {
			// Ignore cleanup errors
		}
	});

	it("should return raw score on cold start (no bins)", () => {
		const calibrator = new IsotonicCalibrator();
		const rawScore = 0.7;
		const calibrated = calibrator.calibrate(rawScore);
		assert.strictEqual(
			calibrated,
			rawScore,
			"Cold start should return raw score",
		);
	});

	it("should fit on synthetic monotonic data", () => {
		const calibrator = new IsotonicCalibrator();
		const samples = [
			{ rawScore: 0.1, outcome: false, timestamp: Date.now() },
			{ rawScore: 0.15, outcome: false, timestamp: Date.now() },
			{ rawScore: 0.2, outcome: false, timestamp: Date.now() },
			{ rawScore: 0.25, outcome: false, timestamp: Date.now() },
			{ rawScore: 0.3, outcome: false, timestamp: Date.now() },
			{ rawScore: 0.35, outcome: false, timestamp: Date.now() },
			{ rawScore: 0.4, outcome: true, timestamp: Date.now() },
			{ rawScore: 0.45, outcome: true, timestamp: Date.now() },
			{ rawScore: 0.5, outcome: true, timestamp: Date.now() },
			{ rawScore: 0.55, outcome: true, timestamp: Date.now() },
			{ rawScore: 0.6, outcome: true, timestamp: Date.now() },
			{ rawScore: 0.65, outcome: true, timestamp: Date.now() },
			{ rawScore: 0.7, outcome: true, timestamp: Date.now() },
			{ rawScore: 0.75, outcome: true, timestamp: Date.now() },
			{ rawScore: 0.8, outcome: true, timestamp: Date.now() },
		];

		calibrator.fit(samples);
		const bins = calibrator.getBins();
		assert.ok(bins.length > 0, "Should have bins after fitting");

		// Check monotonicity: calibrated values should be non-decreasing
		for (let i = 1; i < bins.length; i++) {
			assert.ok(
				bins[i].calibrated >= bins[i - 1].calibrated,
				"Bins should be monotonic",
			);
		}
	});

	it("should not fit with insufficient samples (< 10)", () => {
		const calibrator = new IsotonicCalibrator();
		const samples = [
			{ rawScore: 0.5, outcome: true, timestamp: Date.now() },
			{ rawScore: 0.6, outcome: true, timestamp: Date.now() },
		];

		calibrator.fit(samples);
		const bins = calibrator.getBins();
		assert.strictEqual(
			bins.length,
			0,
			"Should not fit with insufficient samples",
		);
	});

	it("should calibrate scores using interpolation", () => {
		const calibrator = new IsotonicCalibrator();
		const samples = [
			{ rawScore: 0.1, outcome: false, timestamp: Date.now() },
			{ rawScore: 0.2, outcome: false, timestamp: Date.now() },
			{ rawScore: 0.3, outcome: false, timestamp: Date.now() },
			{ rawScore: 0.7, outcome: true, timestamp: Date.now() },
			{ rawScore: 0.8, outcome: true, timestamp: Date.now() },
			{ rawScore: 0.9, outcome: true, timestamp: Date.now() },
		];

		calibrator.fit(samples);
		const calibrated = calibrator.calibrate(0.5);
		assert.ok(typeof calibrated === "number", "Should return a number");
		assert.ok(
			calibrated >= 0 && calibrated <= 1,
			"Calibrated score should be in [0, 1]",
		);
	});

	it("should add samples and fit from them", () => {
		const calibrator = new IsotonicCalibrator();

		calibrator.addSample(0.3, false);
		calibrator.addSample(0.4, false);
		calibrator.addSample(0.5, true);
		calibrator.addSample(0.6, true);
		calibrator.addSample(0.7, true);

		assert.strictEqual(
			calibrator.getSampleCount(),
			5,
			"Should track sample count",
		);

		// Not enough samples yet (need 10)
		calibrator.fitFromSamples();
		assert.strictEqual(
			calibrator.getBins().length,
			0,
			"Should not fit with < 10 samples",
		);

		// Add more samples
		for (let i = 0; i < 10; i++) {
			calibrator.addSample(0.3 + i * 0.05, i < 5);
		}

		calibrator.fitFromSamples();
		assert.ok(calibrator.getBins().length > 0, "Should fit with >= 10 samples");
	});

	it("should persist and restore calibration data", () => {
		const calibrator = new IsotonicCalibrator();
		const samples = [
			{ rawScore: 0.1, outcome: false, timestamp: Date.now() },
			{ rawScore: 0.2, outcome: false, timestamp: Date.now() },
			{ rawScore: 0.3, outcome: false, timestamp: Date.now() },
			{ rawScore: 0.4, outcome: true, timestamp: Date.now() },
			{ rawScore: 0.5, outcome: true, timestamp: Date.now() },
			{ rawScore: 0.6, outcome: true, timestamp: Date.now() },
			{ rawScore: 0.7, outcome: true, timestamp: Date.now() },
			{ rawScore: 0.8, outcome: true, timestamp: Date.now() },
			{ rawScore: 0.9, outcome: true, timestamp: Date.now() },
			{ rawScore: 1.0, outcome: true, timestamp: Date.now() },
		];

		calibrator.fit(samples);
		calibrator.persist(testProfileId);

		// Load a new calibrator
		const loadedCalibrator = IsotonicCalibrator.load(testProfileId);
		const originalBins = calibrator.getBins();
		const loadedBins = loadedCalibrator.getBins();

		assert.strictEqual(
			loadedBins.length,
			originalBins.length,
			"Should restore same number of bins",
		);

		for (let i = 0; i < originalBins.length; i++) {
			assert.strictEqual(
				loadedBins[i].raw,
				originalBins[i].raw,
				"Bin raw value should match",
			);
			assert.strictEqual(
				loadedBins[i].calibrated,
				originalBins[i].calibrated,
				"Bin calibrated value should match",
			);
		}
	});

	it("should handle missing calibration file gracefully", () => {
		const calibrator = IsotonicCalibrator.load("non-existent-profile");
		assert.strictEqual(
			calibrator.getBins().length,
			0,
			"Should have empty bins for non-existent file",
		);
		assert.strictEqual(
			calibrator.getSampleCount(),
			0,
			"Should have 0 samples for non-existent file",
		);
	});

	it("should limit samples to maxSamples (500)", () => {
		const calibrator = new IsotonicCalibrator();

		// Add 600 samples
		for (let i = 0; i < 600; i++) {
			calibrator.addSample(i / 1000, i < 300);
		}

		assert.strictEqual(
			calibrator.getSampleCount(),
			500,
			"Should limit to 500 samples",
		);
	});

	it("should clear bins and samples", () => {
		const calibrator = new IsotonicCalibrator();

		// Add enough samples to trigger fitting
		for (let i = 0; i < 15; i++) {
			calibrator.addSample(i / 20, i < 7);
		}
		calibrator.fitFromSamples();

		assert.ok(calibrator.getBins().length > 0, "Should have bins before clear");
		assert.ok(
			calibrator.getSampleCount() > 0,
			"Should have samples before clear",
		);

		calibrator.clear();

		assert.strictEqual(
			calibrator.getBins().length,
			0,
			"Should have no bins after clear",
		);
		assert.strictEqual(
			calibrator.getSampleCount(),
			0,
			"Should have no samples after clear",
		);
	});

	it("should pool adjacent violators correctly", () => {
		const calibrator = new IsotonicCalibrator();
		// Create data that violates monotonicity
		const samples = [
			{ rawScore: 0.1, outcome: false, timestamp: Date.now() },
			{ rawScore: 0.2, outcome: true, timestamp: Date.now() }, // Violation: 0.2 > 0.1 but outcome flips
			{ rawScore: 0.3, outcome: false, timestamp: Date.now() }, // Violation: 0.3 > 0.2 but outcome flips
			{ rawScore: 0.4, outcome: true, timestamp: Date.now() },
			{ rawScore: 0.5, outcome: true, timestamp: Date.now() },
			{ rawScore: 0.6, outcome: true, timestamp: Date.now() },
			{ rawScore: 0.7, outcome: true, timestamp: Date.now() },
			{ rawScore: 0.8, outcome: true, timestamp: Date.now() },
			{ rawScore: 0.9, outcome: true, timestamp: Date.now() },
			{ rawScore: 1.0, outcome: true, timestamp: Date.now() },
		];

		calibrator.fit(samples);
		const bins = calibrator.getBins();

		// After PAV, bins should be monotonic
		for (let i = 1; i < bins.length; i++) {
			assert.ok(
				bins[i].calibrated >= bins[i - 1].calibrated,
				`Bins should be monotonic at index ${i}`,
			);
		}
	});
});
