import type { TranscriptSegment } from '../../SessionTracker';

export interface ConsciousModeTranscriptFixture {
  partialInterviewer: TranscriptSegment;
  revisedPartialInterviewer: TranscriptSegment;
  unrelatedInterviewerNearRevisionWindow: TranscriptSegment;
  finalInterviewer: TranscriptSegment;
  duplicateFinalInterviewer: TranscriptSegment;
  lateInterviewer: TranscriptSegment;
  duplicateLateInterviewer: TranscriptSegment;
  overlapFailureInterviewer: TranscriptSegment;
  lowConfidenceNoise: TranscriptSegment;
  emptyTurn: TranscriptSegment;
  userHeartbeat: TranscriptSegment;
}

export function createConsciousModeTranscriptFixture(baseTimestamp: number = Date.now()): ConsciousModeTranscriptFixture {
  return {
    partialInterviewer: {
      speaker: 'interviewer',
      text: 'How would you design a rate limiter',
      timestamp: baseTimestamp,
      final: false,
      confidence: 0.93,
    },
    revisedPartialInterviewer: {
      speaker: 'interviewer',
      text: 'How would you design a rate limiter for a global API?',
      timestamp: baseTimestamp + 120,
      final: false,
      confidence: 0.95,
    },
    unrelatedInterviewerNearRevisionWindow: {
      speaker: 'interviewer',
      text: 'Can you walk me through the database failover plan?',
      timestamp: baseTimestamp + 160,
      final: true,
      confidence: 0.96,
    },
    finalInterviewer: {
      speaker: 'interviewer',
      text: 'How would you design a rate limiter for a global API?',
      timestamp: baseTimestamp + 240,
      final: true,
      confidence: 0.98,
    },
    duplicateFinalInterviewer: {
      speaker: 'interviewer',
      text: 'How would you design a rate limiter for a global API?',
      timestamp: baseTimestamp + 360,
      final: true,
      confidence: 0.98,
    },
    lateInterviewer: {
      speaker: 'interviewer',
      text: 'Can you summarize the last question again?',
      timestamp: baseTimestamp - 3_000,
      final: true,
      confidence: 0.91,
    },
    duplicateLateInterviewer: {
      speaker: 'interviewer',
      text: 'Can you summarize the last question again?',
      timestamp: baseTimestamp - 2_400,
      final: true,
      confidence: 0.9,
    },
    overlapFailureInterviewer: {
      speaker: 'interviewer',
      marker: 'speaker_overlap',
      text: 'How would you design a queue worker?',
      timestamp: baseTimestamp + 480,
      final: true,
      confidence: 0.9,
    },
    lowConfidenceNoise: {
      speaker: 'interviewer',
      text: 'ok',
      timestamp: baseTimestamp + 600,
      final: true,
      confidence: 0.2,
    },
    emptyTurn: {
      speaker: 'interviewer',
      text: '   ',
      timestamp: baseTimestamp + 720,
      final: true,
      confidence: 0.99,
    },
    userHeartbeat: {
      speaker: 'user',
      text: 'Let me think about that for a second.',
      timestamp: baseTimestamp + 900,
      final: true,
      confidence: 0.97,
    },
  };
}
