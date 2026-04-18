import test from 'node:test';
import assert from 'node:assert/strict';
import { ConsciousAnswerPlanner } from '../conscious/ConsciousAnswerPlanner';
import { ConsciousResponsePreferenceStore } from '../conscious/ConsciousResponsePreferenceStore';
import { SessionTracker } from '../SessionTracker';

test('ConsciousResponsePreferenceStore ignores ordinary interview answer content', () => {
  const store = new ConsciousResponsePreferenceStore();

  store.noteUserTranscript('I built a Redis cache last year and cut latency by around 40 percent.', 100);

  assert.equal(store.buildContextBlock('general'), '');
});

test('ConsciousResponsePreferenceStore keeps voice preferences global and scopes framework hints by question mode', () => {
  const store = new ConsciousResponsePreferenceStore();

  store.noteUserTranscript('I need the answers in first person voice, Indian English, conversational, concise, no jargon, no robotic slide show stuff.', 100);
  store.noteUserTranscript('For system design, use this framework: clarify the goal, say the approach, mention one tradeoff, then stop.', 200);

  const systemDesignBlock = store.buildContextBlock('system_design');
  assert.match(systemDesignBlock, /first person/i);
  assert.match(systemDesignBlock, /Indian English/i);
  assert.match(systemDesignBlock, /clarify the goal, say the approach, mention one tradeoff, then stop/i);

  const liveCodingBlock = store.buildContextBlock('live_coding');
  assert.match(liveCodingBlock, /first person/i);
  assert.doesNotMatch(liveCodingBlock, /clarify the goal, say the approach, mention one tradeoff, then stop/i);
});

test('ConsciousAnswerPlanner tightens system design answers when hard concise voice preferences exist', () => {
  const store = new ConsciousResponsePreferenceStore();
  const planner = new ConsciousAnswerPlanner();

  store.noteUserTranscript('Keep it first person, conversational, concise, Indian English, simple words only. No robotic or jargon-heavy slide deck phrasing.', 100);

  const plan = planner.plan({
    question: 'How would you design a rate limiter for a multi-tenant API?',
    reaction: null,
    hypothesis: null,
    preferenceSummary: store.getPlannerPreferenceSummary('system_design'),
  });

  assert.equal(plan.questionMode, 'system_design');
  assert.ok(plan.maxWords <= 60);
  assert.match(plan.groundingHint, /first person/i);
  assert.match(plan.groundingHint, /simple words|avoid jargon/i);
  assert.match(plan.rationale, /user preference/i);
});

test('SessionTracker records and restores conscious response preferences without leaking them into live coding structure', async () => {
  const tracker = new SessionTracker();
  tracker.setConsciousModeEnabled(true);

  tracker.handleTranscript({
    speaker: 'user',
    text: 'Use first person, keep it concise, and for behavioral answers follow this framework: situation, task, action, result, learning.',
    timestamp: Date.now(),
    final: true,
  });

  assert.match(tracker.getConsciousResponsePreferenceContext('behavioral'), /situation, task, action, result, learning/i);
  assert.doesNotMatch(tracker.getConsciousResponsePreferenceContext('live_coding'), /situation, task, action, result, learning/i);

  const persistence = (tracker as any).persistence;
  const originalFindByMeeting = persistence.findByMeeting.bind(persistence);
  persistence.findByMeeting = async (meetingId: string) => {
    if (meetingId !== 'meeting-pref-restore') {
      return originalFindByMeeting(meetingId);
    }

    const now = Date.now();
    return {
      version: 1,
      sessionId: 'session-pref-restore',
      meetingId,
      createdAt: now - 1000,
      lastActiveAt: now,
      activeThread: null,
      suspendedThreads: [],
      pinnedItems: [],
      constraints: [],
      epochSummaries: [],
      responseHashes: [],
      consciousState: {
        preferenceState: {
          directives: [
            {
              rawText: 'Use first person and keep it concise. For system design, use this framework: requirements, approach, one tradeoff, stop.',
              normalizedText: 'use first person and keep it concise for system design use this framework requirements approach one tradeoff stop',
              appliesTo: ['system_design'],
              priority: 'hard',
              flags: ['first_person', 'concise', 'follow_framework'],
              createdAt: now,
              updatedAt: now,
            },
          ],
        },
      },
    };
  };

  try {
    const restored = await tracker.restoreFromMeetingId('meeting-pref-restore');
    assert.equal(restored, true);
    assert.match(tracker.getConsciousResponsePreferenceContext('system_design'), /requirements, approach, one tradeoff, stop/i);
    assert.equal(tracker.getConsciousResponsePreferenceSummary('system_design').preferFirstPerson, true);
  } finally {
    persistence.findByMeeting = originalFindByMeeting;
  }
});
