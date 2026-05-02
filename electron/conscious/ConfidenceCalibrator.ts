import * as fs from "fs";
import * as os from "os";
import * as path from "path";

interface CalibrationBin {
	raw: number;
	calibrated: number;
	count: number;
}

interface TrainingSample {
	rawScore: number;
	outcome: boolean;
	timestamp: number;
}

export class IsotonicCalibrator {
	private bins: CalibrationBin[] = [];
	private minSamplesPerBin = 10;
	private maxSamples = 500;
	private samples: TrainingSample[] = [];

	fit(samples: TrainingSample[]): void {
		if (samples.length < this.minSamplesPerBin) {
			return; // Not enough samples to calibrate
		}

		// Sort samples by raw score
		const sorted = [...samples].sort((a, b) => a.rawScore - b.rawScore);

		// Simple isotonic regression: group samples into bins and compute mean outcome
		// Divide into 10 equal-sized bins
		const binCount = 10;
		const samplesPerBin = Math.ceil(sorted.length / binCount);
		const bins: CalibrationBin[] = [];

		for (let i = 0; i < binCount; i++) {
			const startIdx = i * samplesPerBin;
			const endIdx = Math.min((i + 1) * samplesPerBin, sorted.length);
			const binSamples = sorted.slice(startIdx, endIdx);

			if (binSamples.length === 0) continue;

			const avgRaw =
				binSamples.reduce((sum, s) => sum + s.rawScore, 0) / binSamples.length;
			const positiveCount = binSamples.filter((s) => s.outcome).length;
			const calibrated = positiveCount / binSamples.length;

			bins.push({
				raw: avgRaw,
				calibrated,
				count: binSamples.length,
			});
		}

		// Ensure monotonicity: enforce that calibrated values are non-decreasing
		// Pool adjacent violators
		this.bins = this.enforceMonotonicity(bins);
	}

	private enforceMonotonicity(bins: CalibrationBin[]): CalibrationBin[] {
		if (bins.length === 0) return bins;

		const result = [bins[0]];

		for (let i = 1; i < bins.length; i++) {
			const last = result[result.length - 1];
			const current = bins[i];

			if (current.calibrated < last.calibrated) {
				// Violation: pool with previous bin
				const pooled = this.poolBins(last, current);
				result[result.length - 1] = pooled;
			} else {
				result.push(current);
			}
		}

		return result;
	}

	private poolBins(a: CalibrationBin, b: CalibrationBin): CalibrationBin {
		const totalCount = a.count + b.count;
		const weightedCalibrated =
			(a.calibrated * a.count + b.calibrated * b.count) / totalCount;

		return {
			raw: (a.raw * a.count + b.raw * b.count) / totalCount,
			calibrated: weightedCalibrated,
			count: totalCount,
		};
	}

	calibrate(rawScore: number): number {
		if (this.bins.length === 0) {
			return rawScore; // Cold start: return raw score
		}

		// Find the bin that contains the raw score
		const bin = this.bins.find((b) => Math.abs(b.raw - rawScore) < 0.05);
		if (bin) {
			return bin.calibrated;
		}

		// Linear interpolation between neighboring bins
		const leftBin = this.bins.filter((b) => b.raw < rawScore).pop();
		const rightBin = this.bins.find((b) => b.raw > rawScore);

		if (!leftBin && !rightBin) {
			return rawScore;
		}

		if (!leftBin) {
			return rightBin!.calibrated;
		}

		if (!rightBin) {
			return leftBin.calibrated;
		}

		// Linear interpolation
		const t = (rawScore - leftBin.raw) / (rightBin.raw - leftBin.raw);
		return leftBin.calibrated + t * (rightBin.calibrated - leftBin.calibrated);
	}

	addSample(rawScore: number, outcome: boolean): void {
		this.samples.push({
			rawScore,
			outcome,
			timestamp: Date.now(),
		});

		// Keep only the most recent samples
		if (this.samples.length > this.maxSamples) {
			this.samples.shift();
		}
	}

	fitFromSamples(): void {
		if (this.samples.length < this.minSamplesPerBin) {
			return;
		}
		this.fit(this.samples);
	}

	persist(profileId: string): void {
		try {
			const calDir = path.join(os.homedir(), ".nately", "calibration");
			if (!fs.existsSync(calDir)) {
				fs.mkdirSync(calDir, { recursive: true });
			}

			const filePath = path.join(calDir, `${profileId}.json`);
			const data = {
				bins: this.bins,
				samples: this.samples.slice(-100), // Persist last 100 samples
				timestamp: Date.now(),
			};

			fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
		} catch (error) {
			console.warn(
				"[IsotonicCalibrator] Failed to persist calibration data:",
				error,
			);
		}
	}

	static load(profileId: string): IsotonicCalibrator {
		const calibrator = new IsotonicCalibrator();

		try {
			const filePath = path.join(
				os.homedir(),
				".nately",
				"calibration",
				`${profileId}.json`,
			);
			if (fs.existsSync(filePath)) {
				const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
				calibrator.bins = data.bins || [];
				calibrator.samples = data.samples || [];
			}
		} catch (error) {
			console.warn(
				"[IsotonicCalibrator] Failed to load calibration data:",
				error,
			);
		}

		return calibrator;
	}

	getBins(): CalibrationBin[] {
		return [...this.bins];
	}

	getSampleCount(): number {
		return this.samples.length;
	}

	clear(): void {
		this.bins = [];
		this.samples = [];
	}
}
