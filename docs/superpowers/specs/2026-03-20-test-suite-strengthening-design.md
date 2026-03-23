# Test Suite Strengthening Design

## Goal

Strengthen the Electron test suite by adding high-value unit coverage for three currently untested or lightly tested logic modules:

- `electron/llm/postProcessor.ts`
- `electron/llm/transcriptCleaner.ts`
- `electron/services/RateLimiter.ts`

The repo's current Electron coverage gate already passes at 100%, but that result comes from a narrow tested surface area. This work expands protection around branch-heavy helper logic and timer-driven queue behavior without introducing broad integration-test overhead.

## Scope

In scope:

- Add new Electron unit tests under `electron/tests/`
- Reuse the existing `node:test` and `node:assert/strict` style already used in the repo
- Verify observable behavior only, not private internal state
- Re-run `npm run test:electron:coverage` after implementation

Out of scope:

- Refactoring application code unless a test exposes a real defect that blocks reliable testing
- Expanding renderer coverage
- Adding integration or end-to-end UI tests

## Approaches Considered

### 1. Focused unit hardening for helper modules (recommended)

Add compact, deterministic tests for pure-string utilities and the rate limiter. This gives the best ROI because the target files contain meaningful branching, require limited setup, and are isolated from app wiring.

Why this is recommended:

- Most coverage added per line of test code
- Lowest mocking burden
- Fast execution and straightforward failures
- Protects bug-prone logic paths that current tests do not exercise

### 2. Pure-function-only expansion

Test only `postProcessor` and `transcriptCleaner`, skipping `RateLimiter`.

Trade-off:

- Lower flake risk and less setup
- Leaves queueing, timeout, and destroy behavior untested

### 3. Broader service-level coverage

Target larger Electron services with mocks.

Trade-off:

- Potentially broader surface coverage
- Much more setup and mocking complexity
- Higher maintenance cost and slower feedback

## Selected Design

Use approach 1.

Add three dedicated Electron test files:

- `electron/tests/postProcessor.test.ts`
- `electron/tests/transcriptCleaner.test.ts`
- `electron/tests/rateLimiter.test.ts`

Each file will stay focused on one module and follow existing Electron test conventions.

## Test Design

### `postProcessor`

Test the public exports:

- `clampResponse`
- `validateResponse`

Key behaviors to cover:

- empty and non-string input returns an empty string
- markdown stripping removes formatting while preserving text content
- prefix stripping removes leading labels such as `Answer:` and `Refined:`
- trailing filler phrase stripping removes low-value endings cleanly
- sentence clamping limits prose to the configured maximum
- word clamping truncates long prose and adds ellipsis when cut mid-sentence
- validation reports markdown, sentence overflow, and word overflow independently
- fenced code blocks remain preserved and skip prose clamping rules

This file is a good candidate for regression coverage because the code-block placeholder flow is easy to break during markdown cleanup.

### `transcriptCleaner`

Test the public exports:

- `cleanTranscript`
- `sparsifyTranscript`
- `formatTranscriptForLLM`
- `prepareTranscriptForWhatToAnswer`

Key behaviors to cover:

- filler-only or acknowledgement-only turns are dropped
- interviewer turns use their special keep logic
- non-interviewer turns must satisfy both minimum word-count and minimum cleaned-length rules
- repeated words and punctuation are normalized consistently
- `sparsifyTranscript` keeps recent interviewer turns, then fills remaining slots with recent non-interviewer turns, then sorts by timestamp
- formatting maps roles to `INTERVIEWER`, `ME`, and `ASSISTANT`
- the full pipeline preserves order and removes non-meaningful turns

These tests should emphasize realistic transcript snippets so failures are easy to interpret.

### `RateLimiter`

Test the public exports:

- `RateLimiter`
- `createProviderRateLimiters`

Key behaviors to cover:

- immediate acquire succeeds when tokens are available
- queued acquires resolve only after enough simulated time has passed
- queue overflow rejects with the documented error
- timed-out waiters reject and are removed cleanly
- `destroy()` resolves pending waiters and stops further timer use for the test
- provider factory exposes the expected providers and callable methods

These tests should be deterministic. They should control time in a stable way rather than waiting on real-world delays.

## Determinism And Reliability

`RateLimiter` tests are the main flake risk because the implementation depends on both `setInterval` and `Date.now()`. The tests should therefore:

- control timers deterministically
- flush microtasks after advancing time when needed
- call `destroy()` during cleanup to avoid leaked intervals between tests
- assert only externally observable promise resolution or rejection behavior

The `postProcessor` and `transcriptCleaner` tests are pure and should require no mocks.

## File Placement

New tests will live in `electron/tests/` to match the existing TypeScript Electron test layout and current build-and-run pattern used by `npm run test:electron:coverage`.

## Verification

After implementation:

1. Run `npm run test:electron:coverage`
2. Confirm the new test files pass
3. Report any production defects surfaced by the new tests

## Risks

- `RateLimiter` tests may expose a real edge-case bug in queue cleanup or destroy behavior; if so, implementation changes may be needed before the tests can be stabilized
- `postProcessor` may contain an existing bug around code-block placeholder handling; if the regression test reveals it, fixing the production code is in scope because it directly serves the test-hardening goal

## Success Criteria

This work is successful when:

- the Electron suite includes focused coverage for all three target modules
- tests are deterministic and easy to understand
- `npm run test:electron:coverage` passes after the additions
- the suite provides better protection against string-processing regressions and rate-limiter edge cases than the current baseline
