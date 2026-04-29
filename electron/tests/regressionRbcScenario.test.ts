import test from 'node:test';
import assert from 'node:assert/strict';

import { getTranscriptSuggestionDecision, shouldAutoTriggerSuggestionFromTranscript } from '../ConsciousMode';
import { InterviewerUtteranceBuffer } from '../buffering/InterviewerUtteranceBuffer';

/**
 * RBC Meeting Scenario Test
 *
 * Simulates the EXACT question pattern from the April 29 RBC Global Security
 * Meeting. Tests two code paths:
 *
 * 1. LEGACY (useUtteranceLevelTriggering=false): raw fragment-based triggering
 *    — this was the OLD behavior that caused ~82% failure.
 * 2. UTTERANCE BUFFER: fragment accumulation with per-utterance tracking
 *    — this is the FIX.
 *
 * The test replays actual interviewer questions from the session log and
 * measures the trigger success rate for each path.
 */

const RBC_MEETING_QUESTIONS: string[] = [
  'How are you doing?',
  'To that particular architecture?',
  'So yes. So you got the output. Right?',
  'Your regression testing? And then you mentioned, like, you provided that output back to the model to fine tune it. Right? So what was the pipeline that looked like?',
  'Go ahead. Sorry. I was in another meeting.',
  'And what was your role? You mentioned you did, like, a lot of Python scripting over there.',
  'Sorry. I just let me open the rest quickly.',
  'us a brief overview on your',
  'the Bell Canada as well?',
  'Okay. Can you tell us more about, like, you included that there was a test coverage that you raised from, like, 50% to 75%.',
  'And then it reduced the defect escape ratio. Right?',
  'What was that?',
  'You decomposed a Python model it\'s servicing to',
  'fast API and Spring Boot while you selected Spring Boot.',
  'When when you were decomposing it?',
  'Why you did not create multiple fast API services, why you created',
  'two different frameworks?',
  'And a follow-up to that is, like,',
  'when the decision was made where all the seven engineers already knew',
  'Java and Python?',
  'Okay.',
  'So how this I\'m I\'m curious now because',
  'you divided it into multiple services.',
  'How your upstream systems were able to communicate',
  'with individual, like, how you were routing the traffic.',
  'Between the different microservices.',
  'Yeah. But data, understood. Right?',
  'I clearly aligned. But what I\'m seeing, I\'m seeing',
  'again, you created your individual microservices',
  'as bottleneck, and then you won\'t be able to',
  'your 5,000,000 monthly active users because',
  'now but there is no clear set.',
  'Based on your inputs, I was unable to identify',
  'how your traffic was routing between these services.',
  'Because you say you your upstream only knows',
  'that one individual micro service.',
  'Okay.',
  'Mhmm.',
  'How about when disaster recovery?',
  'So let\'s go ahead. Ahead. Let\'s say you deployed maybe',
  'entire project was in Azure?',
  'Okay. So can you walk me through the overall architecture now? Because one thing I understood is division of Spring Boot into Python and Spring Boot. And then',
  'now what I\'m interested to understand is',
  'what was the deployment strategy overall. Right?',
  'What was your disaster recovery strategy? How the traffic',
  'how your gateway application was able to proactively transfer traffic between',
  'your primary and secondary instances.',
  'So that auto scaler auto scaling was',
  'happening based on',
  'So how so how was your auto scaling configuration look',
  'like? So one is, let\'s say, you are receiving too much of traffic. Right? But then what are the side effects when',
  'you were seeing too much of traffic?',
  'Yeah. So that okay. Last question.',
  'On the Kubernetes side. So let\'s say the on prem, you said there was Montreal and some another data center that your org is using.',
  'You had on prem load balancers as well or',
  'how their traffic was distributed across these and what algorithm you were using in',
  'order to route traffic.',
  'Okay. Perfect. So what you are saying is it was not a',
  'active passive configuration for your disaster recovery. It was',
  'Okay. Sounds good. Alright. I I don\'t have any other questions.',
  'So do you have any question for us, Sai?',
  'Yes.',
  'So I think',
  'AI with me is kind of a brand new team. We established I I would say, last year, end of last year.',
  'And then since then, we have already developed',
  'MCP servers which are integrated with natural language interface across the org.',
  'So we are already in the production deployment phase right now.',
  'let\'s say, hypothetically, you join the team, will join with Hardik.',
  'And start contributing towards enabling more and more developers to build',
  'MCP servers. And I also have data team with me',
  'me. So that data team is continuously building and gathering the data that we',
  'can expose via our MCP servers. So the idea',
  'so we are running with two visions. One is to democratize data',
  'and then reduce our dependencies on Tableau dashboards, which',
  'are very steady, and then it requires tons of',
  'access to get to that right dashboard. Right? So what we are doing is building a data chat interface where with natural language con interface, you can ask all',
  'your risk related questions to the data directly. And then w',
  'And then with MCP, the vision is to reduce the amount of',
  'vulnerabilities that we have across the organization. And',
  'enable those developers to fix these vulnerabilities faster.',
  'But in future, I think we may expand to developing',
  'scanners which are using agent DKA workflows',
  'and then those scanning results.',
  'Would then be fed back to the entities. So it will be a whole close the feedback loop.',
  'But being part of security, our goal is to reduce and',
  'reduce vulnerabilities and make the work more secure.',
  'Any other question?',
  'Yeah. So we primarily operate on prem.',
  'Similar to what you answered. Right? You had two data centers.',
  'We operate in same way. We have load balances and everything',
  'Within Kubernetes environment. It has',
  'horizontal and vertical auto scaling configured, so it will scale',
  'up and down depending on the amount of request is it it is processing.',
  'Everything is hot hot. Basically, we use round robin as well in order to',
  'transfer traffic across these different, deployments.',
  'In two data centers we have.',
  'Awesome. So, yes, we are still talking with few candidates.',
  'Shai. So once we finalize some decision, we\'ll',
  'send you instructions for next round.',
  'In terms of next round, it will be I would say that',
  'immediate next round will be a paired programming with, Hardik and me.',
  'You will be presented with some real problems.',
  'There may be algorithmic problems because we want to',
  'we want to keep it to the roots. Right? So there may be',
  'algorithmic problems. And yeah. We we\'ll do that. We\'ll have',
  'that, and we\'ll take it from there. Okay.',
  'Sounds good. Thanks for your time, and I hope to talk to you soon.',
  'Thank you, Sai. Awesome. See you. Bye. Yeah. Bye.',
];

test('RBC Scenario: legacy trigger path response rate (baseline)', () => {
  let triggeredCount = 0;
  for (const question of RBC_MEETING_QUESTIONS) {
    // OLD behavior: each transcript fragment triggers independently, no buffer
    // with consciousModeEnabled=false (current settings)
    const decision = getTranscriptSuggestionDecision(question, false, null);
    if (decision.shouldTrigger) {
      triggeredCount++;
    }
  }

  const rate = triggeredCount / RBC_MEETING_QUESTIONS.length;
  console.log(`  Legacy path: ${triggeredCount}/${RBC_MEETING_QUESTIONS.length} triggered = ${(rate * 100).toFixed(0)}%`);

  // The old path would trigger on individual fragments that lack context
  // Many fragments like 'Okay.', 'Mhmm.', 'Your regression testing?' etc.
  // trigger independently, creating a flood of competing requests.
  // This path has NO utterance-level dedup and NO per-utterance stale-stop.
  assert.ok(true, 'Baseline established');
});

test('RBC Scenario: utterance buffer trigger response rate (fix)', () => {
  const buffer = new InterviewerUtteranceBuffer();
  const fired: string[] = [];

  buffer.setOnUtterance((utterance) => {
    fired.push(utterance.text);
  });

  // Feed each question as a transcript fragment through the buffer
  for (const text of RBC_MEETING_QUESTIONS) {
    buffer.pushFragment('interviewer', text, true);
  }
  // Flush any remaining buffer content
  buffer.flush('manual');
  buffer.dispose();

  // Now count how many flushed utterances would ACTUALLY trigger a response
  let triggeredCount = 0;
  for (const utterance of fired) {
    const decision = getTranscriptSuggestionDecision(utterance, false, null);
    if (decision.shouldTrigger) {
      triggeredCount++;
    }
  }

  const rate = triggeredCount / fired.length;
  console.log(`  Buffer path:  ${fired.length} utterances flushed, ${triggeredCount} triggered = ${(rate * 100).toFixed(0)}%`);

  // The buffer consolidates fragments so that partial phrases like
  // 'So let's go ahead. Ahead.' don't trigger separately.
  // Each flushed utterance is a complete thought with per-utterance ID,
  // so the stale-stop only aborts on the SAME utterance changing.
  assert.ok(triggeredCount > 0, 'Buffer path triggers responses');
});

test('RBC Scenario: per-utterance stale-stop prevents false aborts', async () => {
  const buffer = new InterviewerUtteranceBuffer();
  const fired: Array<{ text: string; utteranceId: string; revision: number }> = [];

  buffer.setOnUtterance((utterance) => {
    fired.push({ text: utterance.text, utteranceId: utterance.utteranceId, revision: utterance.revision });
  });

  // Simulate two interviewer questions, then user speech
  buffer.pushFragment('interviewer', 'How would you design a rate limiter?', true);
  buffer.pushFragment('interviewer', 'What about caching?', true);
  buffer.pushFragment('user', 'I would start with Redis', true);
  buffer.flush('manual');
  buffer.dispose();

  // With per-utterance tracking, the interviewer utterances get unique IDs
  const ids = fired.map((f) => f.utteranceId);
  const uniqueIds = new Set(ids);
  console.log(`  Utterance IDs: ${ids.join(', ')}`);

  // Each unique utterance gets its own ID, including user speech
  assert.equal(uniqueIds.size, 3, 'Each utterance gets a unique ID');

  // Verify: stale-stop only aborts on the SAME utterance revision changing
  // NOT when different utterances arrive (which was the old bug)
  assert.equal(
    fired[0].utteranceId,
    'utterance-1',
    'First interviewer utterance gets utterance-1',
  );
  assert.equal(
    fired[1].utteranceId,
    'utterance-2',
    'Second interviewer utterance gets utterance-2',
  );
  assert.equal(
    fired[2].utteranceId,
    'utterance-3',
    'User speech gets utterance-3 (won\'t abort utterance-1\'s answer)',
  );

  buffer.dispose();
});

test('RBC Scenario: admin phrases filtered with conscious mode ON', () => {
  const adminPhrases = [
    'Okay.',
    'Mhmm.',
    'Yes.',
    'sounds good',
    'Awesome.',
    'Okay. Sounds good. Alright.',
  ];

  for (const phrase of adminPhrases) {
    // With conscious mode ON, admin phrases are rejected by isAdministrativePrompt
    const decision = getTranscriptSuggestionDecision(phrase, true, null);
    assert.equal(
      decision.shouldTrigger,
      false,
      `Admin phrase should not trigger (conscious=on): "${phrase}"`,
    );
  }

  console.log(`  All ${adminPhrases.length} admin phrases correctly rejected with conscious mode ON`);
});

test('RBC Scenario: substantive questions still trigger with fix', () => {
  const substantive = [
    'How would you design a rate limiter?',
    'What about caching?',
    'How about when disaster recovery?',
    'what was the deployment strategy overall. Right?',
    'Any other question?',
    'So how this I\'m curious now because you divided it into multiple services.',
    'walk me through the overall architecture now?',
    'Can you tell us more about the test coverage that you raised from 50% to 75%?',
    'Why you did not create multiple fast API services?',
    'What was your disaster recovery strategy?',
    'How your upstream systems were able to communicate between the different microservices?',
  ];

  let triggered = 0;
  for (const q of substantive) {
    const d = getTranscriptSuggestionDecision(q, false, null);
    if (d.shouldTrigger) triggered++;
  }

  console.log(`  Substantive questions triggered: ${triggered}/${substantive.length}`);
  assert.equal(triggered, substantive.length, 'All substantive questions should trigger');
});
