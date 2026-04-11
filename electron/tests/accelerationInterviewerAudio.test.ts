import test from 'node:test';
import assert from 'node:assert/strict';

import { ConsciousAccelerationOrchestrator } from '../conscious/ConsciousAccelerationOrchestrator';

test('interviewer audio activity updates RMS without canceling pause evaluation', () => {
  const orchestrator = new ConsciousAccelerationOrchestrator();
  orchestrator.setEnabled(true);

  try {
    const prefetcher = orchestrator.getPrefetcher();
    const pauseDetector = orchestrator.getPauseDetector();
    let userSpeakingCalls = 0;
    let speechStartedCalls = 0;

    const originalUserSpeaking = prefetcher.onUserSpeaking.bind(prefetcher);
    const originalSpeechStarted = pauseDetector.onSpeechStarted.bind(pauseDetector);
    prefetcher.onUserSpeaking = () => {
      userSpeakingCalls += 1;
      originalUserSpeaking();
    };
    pauseDetector.onSpeechStarted = () => {
      speechStartedCalls += 1;
      originalSpeechStarted();
    };

    const before = orchestrator.getPauseConfidence().signals.find((signal) => signal.name === 'audio_energy_decay');

    for (let i = 0; i < 10; i += 1) {
      orchestrator.onInterviewerAudioActivity(80);
    }

    const confidence = orchestrator.getPauseConfidence();
    const energyDecay = confidence.signals.find((signal) => signal.name === 'audio_energy_decay');

    assert.ok(before);
    assert.ok(energyDecay);
    assert.equal(userSpeakingCalls, 0);
    assert.equal(speechStartedCalls, 0);
    assert.equal(before?.value, 0.5);
    assert.notEqual(energyDecay?.value, 0.5);
  } finally {
    orchestrator.setEnabled(false);
  }
});
