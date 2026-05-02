import { app } from "electron";
import * as fs from "fs";
import * as path from "path";

export interface PauseFeatures {
	silenceDuration: number;
	transcriptCompleteness: number;
	semanticCompleteness: number;
	conversationRhythm: number;
	audioEnergyDecay: number;
}

export interface AdaptivePauseWeights {
	silenceDuration: number;
	transcriptCompleteness: number;
	semanticCompleteness: number;
	conversationRhythm: number;
	audioEnergyDecay: number;
	bias: number;
}

export interface AdaptivePauseModelState {
	weights: AdaptivePauseWeights;
	sampleCount: number;
	lastUpdated: number;
	learningRate: number;
}

// Default hardcoded weights from PauseDetector
const DEFAULT_WEIGHTS: AdaptivePauseWeights = {
	silenceDuration: 0.25,
	transcriptCompleteness: 0.3,
	semanticCompleteness: 0.2,
	conversationRhythm: 0.15,
	audioEnergyDecay: 0.1,
	bias: 0,
};

const MIN_SAMPLES_FOR_ADAPTATION = 20;
const MAX_SAMPLES = 1000;
const INITIAL_LEARNING_RATE = 0.01;
const L2_REGULARIZATION = 0.001;
const LEARNING_RATE_DECAY = 0.9999;

export class AdaptivePauseModel {
	private state: AdaptivePauseModelState;
	private profileId: string;
	private featureHistory: Array<{ features: PauseFeatures; label: number }> =
		[];

	constructor(profileId: string) {
		this.profileId = profileId;
		this.state = this.loadState() || {
			weights: { ...DEFAULT_WEIGHTS },
			sampleCount: 0,
			lastUpdated: Date.now(),
			learningRate: INITIAL_LEARNING_RATE,
		};
	}

	predict(features: PauseFeatures): number {
		const w = this.state.weights;
		const score =
			w.silenceDuration * features.silenceDuration +
			w.transcriptCompleteness * features.transcriptCompleteness +
			w.semanticCompleteness * features.semanticCompleteness +
			w.conversationRhythm * features.conversationRhythm +
			w.audioEnergyDecay * features.audioEnergyDecay +
			w.bias;

		// Sigmoid activation
		return 1 / (1 + Math.exp(-score));
	}

	update(features: PauseFeatures, label: number): void {
		// label: 1 = user was done speaking (commit), 0 = user continued speaking
		const prediction = this.predict(features);
		const error = label - prediction;

		// Only adapt if we have enough samples
		if (this.state.sampleCount < MIN_SAMPLES_FOR_ADAPTATION) {
			// Use small adaptive influence during cold start
			this.state.learningRate = INITIAL_LEARNING_RATE * 0.1;
		}

		// SGD update with L2 regularization
		const lr = this.state.learningRate;
		const w = this.state.weights;

		w.silenceDuration +=
			lr *
			(error * features.silenceDuration -
				L2_REGULARIZATION * w.silenceDuration);
		w.transcriptCompleteness +=
			lr *
			(error * features.transcriptCompleteness -
				L2_REGULARIZATION * w.transcriptCompleteness);
		w.semanticCompleteness +=
			lr *
			(error * features.semanticCompleteness -
				L2_REGULARIZATION * w.semanticCompleteness);
		w.conversationRhythm +=
			lr *
			(error * features.conversationRhythm -
				L2_REGULARIZATION * w.conversationRhythm);
		w.audioEnergyDecay +=
			lr *
			(error * features.audioEnergyDecay -
				L2_REGULARIZATION * w.audioEnergyDecay);
		w.bias += lr * error;

		// Normalize weights to sum to 1 (excluding bias)
		const weightSum =
			w.silenceDuration +
			w.transcriptCompleteness +
			w.semanticCompleteness +
			w.conversationRhythm +
			w.audioEnergyDecay;

		if (weightSum > 0) {
			w.silenceDuration /= weightSum;
			w.transcriptCompleteness /= weightSum;
			w.semanticCompleteness /= weightSum;
			w.conversationRhythm /= weightSum;
			w.audioEnergyDecay /= weightSum;
		}

		// Update learning rate
		this.state.learningRate *= LEARNING_RATE_DECAY;

		// Track sample
		this.featureHistory.push({ features, label });
		if (this.featureHistory.length > MAX_SAMPLES) {
			this.featureHistory.shift();
		}

		this.state.sampleCount++;
		this.state.lastUpdated = Date.now();

		// Persist periodically
		if (this.state.sampleCount % 10 === 0) {
			this.saveState();
		}
	}

	getCurrentWeights(): AdaptivePauseWeights {
		return { ...this.state.weights };
	}

	getSampleCount(): number {
		return this.state.sampleCount;
	}

	isReady(): boolean {
		return this.state.sampleCount >= MIN_SAMPLES_FOR_ADAPTATION;
	}

	reset(): void {
		this.state = {
			weights: { ...DEFAULT_WEIGHTS },
			sampleCount: 0,
			lastUpdated: Date.now(),
			learningRate: INITIAL_LEARNING_RATE,
		};
		this.featureHistory = [];
		this.saveState();
	}

	private loadState(): AdaptivePauseModelState | null {
		try {
			const configPath = this.getConfigPath();
			if (!fs.existsSync(configPath)) {
				return null;
			}

			const data = fs.readFileSync(configPath, "utf-8");
			return JSON.parse(data);
		} catch (error) {
			console.warn("[AdaptivePauseModel] Failed to load state:", error);
			return null;
		}
	}

	private saveState(): void {
		try {
			const configPath = this.getConfigPath();
			const configDir = path.dirname(configPath);

			if (!fs.existsSync(configDir)) {
				fs.mkdirSync(configDir, { recursive: true });
			}

			fs.writeFileSync(configPath, JSON.stringify(this.state, null, 2));
		} catch (error) {
			console.warn("[AdaptivePauseModel] Failed to save state:", error);
		}
	}

	private getConfigPath(): string {
		const userDataPath = app.getPath("userData");
		return path.join(userDataPath, "pause_weights", `${this.profileId}.json`);
	}
}
