#!/usr/bin/env node

const { runConsciousEvalHarness, runConsciousReplayHarness } = require('../dist-electron/electron/conscious/ConsciousEvalHarness.js');
const { ConsciousVerifier } = require('../dist-electron/electron/conscious/ConsciousVerifier.js');
const { ConsciousVerifierLLM } = require('../dist-electron/electron/conscious/ConsciousVerifierLLM.js');
const { LLMHelper } = require('../dist-electron/electron/LLMHelper.js');

function buildVerifier() {
  const geminiApiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  const groqApiKey = process.env.GROQ_API_KEY;
  const openaiApiKey = process.env.OPENAI_API_KEY;
  const claudeApiKey = process.env.CLAUDE_API_KEY;
  const cerebrasApiKey = process.env.CEREBRAS_API_KEY;

  const helper = new LLMHelper(
    geminiApiKey,
    false,
    undefined,
    undefined,
    groqApiKey,
    openaiApiKey,
    claudeApiKey,
    cerebrasApiKey,
  );

  const useLiveJudge = process.env.CONSCIOUS_EVAL_LIVE === '1' && helper.hasStructuredGenerationCapability();
  return useLiveJudge
    ? new ConsciousVerifier(new ConsciousVerifierLLM(helper))
    : new ConsciousVerifier();
}

async function main() {
  const verifier = buildVerifier();
  const { results, summary } = await runConsciousEvalHarness({ verifier });
  const replay = await runConsciousReplayHarness({ verifier });

  console.log('\nConscious Mode Eval Summary');
  console.log('===========================');
  console.log(`Total: ${summary.total}`);
  console.log(`Passed: ${summary.passed}`);
  console.log(`Failed: ${summary.failed}`);

  for (const result of results) {
    console.log(`\n[${result.passed ? 'PASS' : 'FAIL'}] ${result.scenario.id}`);
    console.log(`Scenario: ${result.scenario.description}`);
    console.log(`Reaction: ${result.reaction.kind}`);
    console.log(`Verdict: ${result.verdict.ok ? 'accept' : 'reject'}${result.verdict.reason ? ` (${result.verdict.reason})` : ''}`);
  }

  console.log('\nReplay Trace Summary');
  console.log('====================');
  console.log(`Total: ${replay.summary.total}`);
  console.log(`Passed: ${replay.summary.passed}`);
  console.log(`Failed: ${replay.summary.failed}`);

  for (const result of replay.results) {
    console.log(`\n[${result.passed ? 'PASS' : 'FAIL'}] ${result.scenario.id}`);
    console.log(`Route: ${result.trace.route.threadAction}`);
    console.log(`Context: ${result.trace.selectedContextItemIds.join(', ') || 'none'}`);
    console.log(`Verifier: ${result.trace.verifierVerdict.ok ? 'accept' : 'reject'}${result.trace.fallbackReason ? ` (${result.trace.fallbackReason})` : ''}`);
  }

  if (summary.failed > 0 || replay.summary.failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('Conscious eval failed:', error);
  process.exitCode = 1;
});
