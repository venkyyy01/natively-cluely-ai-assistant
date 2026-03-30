// electron/tests/consciousModeIntegration.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionTracker } from '../SessionTracker';
import { ThreadManager } from '../conscious/ThreadManager';
import { InterviewPhaseDetector } from '../conscious/InterviewPhase';
import { ConfidenceScorer } from '../conscious/ConfidenceScorer';
import { FallbackExecutor } from '../conscious/FallbackExecutor';
import { RESUME_THRESHOLD } from '../conscious/types';

test('Conscious Mode Integration - Thread Resume Flow', () => {
  const session = new SessionTracker();
  session.setConsciousModeEnabled(true);
  const threadManager = session.getThreadManager();
  
  // Start system design discussion
  const designThread = threadManager.createThread(
    'Design YouTube video streaming',
    'high_level_design'
  );
  assert.equal(designThread.status, 'active');
  
  // Add keywords to make resume confidence calculation work
  threadManager.addKeywordsToActive(['youtube', 'video', 'streaming', 'design']);
  
  // Behavioral interruption
  threadManager.createThread(
    'Leadership experience story',
    'behavioral_story'
  );
  
  // Original thread should be suspended
  const suspended = threadManager.getSuspendedThreads();
  assert.equal(suspended.length, 1);
  assert.ok(suspended[0].topic.includes('YouTube'));
  
  // Resume original thread with explicit resume markers
  const scorer = new ConfidenceScorer();
  const confidence = scorer.calculateResumeConfidence(
    "Let's go back to the YouTube video streaming design",
    suspended[0],
    'high_level_design'
  );
  
  // With explicit markers + keywords + aligned phase, confidence is strong
  assert.ok(confidence.explicitMarkers > 0);
  assert.ok(confidence.bm25Score > 0);
  assert.ok(confidence.total > 0.5);
  
  // Actually resume
  threadManager.resumeThread(suspended[0].id);
  assert.ok(threadManager.getActiveThread()?.topic.includes('YouTube'));
});

test('Conscious Mode Integration - Phase Detection Flow', () => {
  const session = new SessionTracker();
  session.setConsciousModeEnabled(true);
  const detector = session.getPhaseDetector();
  
  // Start with requirements
  let result = detector.detectPhase(
    'Can I assume we have unlimited storage?',
    'requirements_gathering',
    []
  );
  assert.equal(result.phase, 'requirements_gathering');
  
  // Transition to high-level design with strong signals
  result = detector.detectPhase(
    'Let me draw the high-level architecture with main components',
    'requirements_gathering',
    []
  );
  assert.equal(result.phase, 'high_level_design');
  
  // Deep dive with explicit pattern
  result = detector.detectPhase(
    'Walk me through how the caching layer works in detail',
    'high_level_design',
    []
  );
  assert.equal(result.phase, 'deep_dive');
});

test('Conscious Mode Integration - Fallback Chain', () => {
  const executor = new FallbackExecutor();
  
  // Simulate failures
  executor.recordFailure('full_conscious');
  executor.recordFailure('full_conscious');
  
  assert.equal(executor.getStartTier(), 1); // Skip tier 0
  
  // Get emergency response
  const emergency = executor.getEmergencyResponse('high_level_design');
  assert.ok(emergency.length > 10);
  
  // Recovery
  executor.recordSuccess();
  assert.equal(executor.getFailureState().consecutiveFailures, 0);
});

test('Conscious Mode Integration - Full Interview Scenario', () => {
  const session = new SessionTracker();
  session.setConsciousModeEnabled(true);
  const threadManager = session.getThreadManager();
  const phaseDetector = session.getPhaseDetector();
  const scorer = new ConfidenceScorer();
  
  // Phase 1: Requirements
  let phase = phaseDetector.detectPhase(
    'Can I assume we target YouTube scale? What are the constraints?',
    'requirements_gathering',
    []
  );
  assert.equal(phase.phase, 'requirements_gathering');
  
  const youtubeThread = threadManager.createThread('Design YouTube', phase.phase);
  threadManager.addDecisionToActive('Target 1B DAU');
  threadManager.addKeywordsToActive(['youtube', 'video', 'streaming', 'architecture']);
  
  // Phase 2: High-level design with strong signals
  phase = phaseDetector.detectPhase(
    'Let me show you the high-level architecture with main components',
    'requirements_gathering',
    []
  );
  threadManager.updateActiveThread({ phase: phase.phase });
  
  // Interruption: Behavioral question
  phase = phaseDetector.detectPhase(
    'Tell me about a time you led a challenging project',
    'high_level_design',
    []
  );
  assert.equal(phase.phase, 'behavioral_story');
  
  threadManager.createThread('Leadership story', 'behavioral_story');
  
  // YouTube thread should be suspended
  const suspended = threadManager.getSuspendedThreads();
  assert.equal(suspended[0].topic, 'Design YouTube');
  assert.ok(suspended[0].keyDecisions.includes('Target 1B DAU'));
  
  // Resume YouTube discussion
  const resumeConfidence = scorer.calculateResumeConfidence(
    "Let's go back to the YouTube video streaming architecture",
    suspended[0],
    'behavioral_story'
  );
  
  assert.ok(resumeConfidence.explicitMarkers > 0);
  assert.ok(resumeConfidence.bm25Score > 0);
  assert.ok(resumeConfidence.total > 0.5);
  
  threadManager.resumeThread(suspended[0].id);
  assert.equal(threadManager.getActiveThread()?.topic, 'Design YouTube');
  assert.equal(threadManager.getActiveThread()?.resumeCount, 1);
});
