import assert from "node:assert";
import { describe, it } from "node:test";
import { PauseDetector } from "../pause/PauseDetector";

describe("PauseDetector", () => {
	it("scores complete thoughts higher than incomplete fragments", () => {
		const completeDetector = new PauseDetector();
		completeDetector.updateTranscripts(["How would you scale this system?"]);
		completeDetector.onSpeechStarted();
		(completeDetector as any).silenceStartMs = Date.now() - 1200;
		const completeScore = completeDetector.getCurrentConfidence().score;

		const incompleteDetector = new PauseDetector();
		incompleteDetector.updateTranscripts(["and then"]);
		incompleteDetector.onSpeechStarted();
		(incompleteDetector as any).silenceStartMs = Date.now() - 1200;
		const incompleteScore = incompleteDetector.getCurrentConfidence().score;

		assert(completeScore > incompleteScore);
	});

	it("triggers no speculative action for obviously incomplete pauses", async () => {
		const detector = new PauseDetector({
			minSilenceMs: 0,
			evalIntervalMs: 25,
			maxEvaluationMs: 80,
		});
		const actions: string[] = [];
		detector.setActionHandler((action) => {
			actions.push(action);
		});

		detector.updateTranscripts(["but"]);
		detector.onSpeechStarted();
		detector.onSpeechEnded();

		await new Promise((resolve) => setTimeout(resolve, 120));
		assert(actions.every((action) => action === "none"));
	});
});
