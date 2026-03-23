# Remaining TODO Completion Design

## Goal

Complete every unchecked item in `TODO.md` by decomposing the work into independent implementation tracks, sequencing shared-file changes to avoid conflicts, and verifying each tranche before moving on.

## Why This Needs Multiple Tracks

The unchecked work is not a single feature. It spans:

- a new product behavior (`Conscious Mode`)
- intelligence pipeline and prompt architecture changes
- IPC validation and typing hardening
- OAuth/callback security architecture
- runtime loader cleanup
- renderer/component decomposition and test replacement
- lower-priority architecture cleanup

Trying to implement all of this as one undifferentiated change would create heavy merge pressure in `electron/main.ts`, `electron/ipcHandlers.ts`, `electron/preload.ts`, `src/types/electron.d.ts`, and `src/components/NativelyInterface.tsx`. The design therefore treats the remaining TODO as a program of work with explicit boundaries.

## Scope Mapping From TODO

### Track 0 - TODO Reconciliation and Completion Accounting

This track exists because the goal is not only to implement code changes, but to fully eliminate remaining unchecked work in `TODO.md`.

Responsibilities:

- reconcile stale unchecked items in `Recommended Execution Order`
- reconcile unchecked `Exit Criteria` items against current source truth after each tranche
- update `TODO.md` whenever verification proves an item is complete or needs to be rewritten to reflect current reality

Primary files expected to change:

- `TODO.md`

Acceptance:

- no unchecked item remains in `TODO.md` unless it represents verified unfinished work still being actively carried
- final `TODO.md` accurately matches implemented source state and verification status

### Track A - Conscious Mode Product and UX

Covers `TODO.md` items 13 through 23.

Responsibilities:

- add the `Conscious Mode` live interview toggle
- persist and synchronize state across renderer and Electron
- introduce a structured reasoning-first response contract
- update prompt architecture for spoken reasoning before code
- route qualifying interviewer questions through the reasoning-first path
- preserve a rolling reasoning thread across follow-ups
- render explicit speaking blocks in the UI
- add analytics and tests for the new flow

Primary files expected to change:

- `electron/IntelligenceManager.ts`
- `electron/IntelligenceEngine.ts`
- `electron/main.ts`
- `electron/llm/prompts.ts`
- `electron/ipcHandlers.ts`
- `electron/preload.ts`
- `src/types/electron.d.ts`
- `src/components/NativelyInterface.tsx`
- `src/components/SuggestionOverlay.tsx` or the active assist surface
- `electron/SessionTracker.ts`

### Track B - IPC Safety and Contract Hardening

Covers the unchecked IPC items at `TODO.md:413`, `TODO.md:428`, and `TODO.md:432`.

Responsibilities:

- add validation to remaining raw IPC handlers
- finish typed preload/renderer coverage for active IPC surfaces
- standardize success/error result envelopes across remaining handlers

Handler inventory to close the TODO explicitly:

- `electron/ipcHandlers.ts`: remaining direct `safeHandle(...)` channels that still return ad hoc primitives or unvalidated payloads
- `electron/ipc/registerProfileHandlers.ts`: profile upload/status/mode/file-selection/research handlers currently using raw arguments and mixed return shapes
- `electron/ipc/registerRagHandlers.ts`: query/cancel/status/retry handlers currently accepting inline objects and returning mixed success/fallback booleans
- `electron/ipc/registerSettingsHandlers.ts`: remaining raw getters/setters and simple toggle handlers that are not yet fully normalized

Typed-coverage completion means:

- every renderer-callable IPC used by the app has an explicit preload wrapper
- every preload wrapper is declared in `src/types/electron.d.ts`
- shared request/response payload types exist for non-trivial channels instead of repeating anonymous object literals
- renderer call sites consume the typed preload API rather than untyped ad hoc arguments

Primary files expected to change:

- `electron/ipcHandlers.ts`
- `electron/ipc/registerProfileHandlers.ts`
- `electron/ipc/registerRagHandlers.ts`
- `electron/ipc/registerSettingsHandlers.ts`
- `electron/preload.ts`
- `src/types/electron.d.ts`
- shared IPC payload/type files if needed

### Track C - Platform, Runtime, and Security Hardening

Covers `TODO.md:418`, `TODO.md:420`, `TODO.md:433`, and `TODO.md:434`.

Responsibilities:

- replace the current loopback Calendar OAuth callback flow with a production-grade redirect/callback design appropriate for Electron
- remove the eval-based transformers loader without regressing packaging/runtime behavior
- improve token/context budgeting and retry consistency in `electron/LLMHelper.ts`
- add narrow LLM-side caching only for repeatedly rebuilt or repeated exact-match prompt/request work in `electron/LLMHelper.ts`

Primary files expected to change:

- `electron/services/CalendarManager.ts`
- `electron/utils/transformersLoader.js`
- `electron/llm/IntentClassifier.ts`
- `electron/rag/providers/LocalEmbeddingProvider.ts`
- `electron/LLMHelper.ts`

### Track D - Renderer Cleanup and Test Debt

Covers `TODO.md:427` and `TODO.md:435`.

Responsibilities:

- continue decomposing `src/components/SettingsOverlay.tsx` into smaller sections/components
- replace boilerplate renderer tests with app-relevant tests

Primary files expected to change:

- `src/components/SettingsOverlay.tsx`
- new extracted settings subcomponents/hooks
- `renderer/src/App.test.tsx`
- any renderer test utilities added to support realistic coverage

### Track E - Lower-Priority Architecture Cleanup

Covers `TODO.md:439` through `TODO.md:442`.

Responsibilities:

- continue shrinking `electron/ipcHandlers.ts`
- revisit shared renderer state / `QueryClient` architecture in `src/App.tsx`
- evaluate heavy `postinstall` work in `package.json`
- consider stricter Electron TypeScript settings in `electron/tsconfig.json`

This track only begins after Tracks A-D are green, because it has the loosest user-facing acceptance criteria and the broadest potential blast radius.

## Execution Strategy

### Phase 1 - Build feature-internal foundations first

Start with Track A work that does not collide with shared IPC hot files:

1. define the structured reasoning-first response contract
2. update prompts for reasoning-first interview coaching
3. define renderer presentation sections for structured output

These slices can proceed before shared IPC work because they mainly touch the intelligence and prompt layers.

### Phase 2 - Land shared IPC/state slices needed by Conscious Mode

Serialize only the hot-file changes that `Conscious Mode` depends on:

1. define the standard IPC success/error envelope for the new toggle path
2. add/finish shared typings in preload and renderer-facing declarations
3. normalize the handlers needed by `Conscious Mode` state plumbing

### Phase 3 - Complete the new product behavior

Implement Track A first. It is the highest-priority remaining product work and drives several exit criteria in `TODO.md`.

Within Track A, the dependency order is:

1. define the structured reasoning-first response contract
2. add persisted `Conscious Mode` state and IPC plumbing on top of the Track B foundation
3. update prompts and engine routing
4. preserve reasoning thread across follow-ups
5. render explicit speaking blocks in the renderer
6. add analytics and tests

Track A must be further serialized into hot-file ownership slices:

- `A1` contract and types: `electron/IntelligenceEngine.ts`, `electron/IntelligenceManager.ts`, optional shared types
- `A2` state ownership and plumbing: `electron/ipcHandlers.ts`, `electron/preload.ts`, `src/types/electron.d.ts`, persistence path
- `A3` trigger/routing integration: `electron/main.ts`, transcript-trigger path(s)
- `A4` renderer controls: `src/components/NativelyInterface.tsx` and dropdown/menu surfaces
- `A5` renderer output sections: assist surface components such as `src/components/SuggestionOverlay.tsx`
- `A6` analytics and tests: analytics integration points and focused tests

### Phase 4 - Complete the rest of IPC hardening

Finish the remaining non-`Conscious Mode` handler validation and contract normalization in Track B after the feature-specific IPC foundation is proven.

### Phase 5 - Address runtime/security debt

Implement Track C after the shared IPC surfaces are stabilized. These changes are more operationally sensitive and should land with targeted verification.

### Phase 6 - Cleanup and test debt

Implement Track D once feature and platform work are stable. The `SettingsOverlay` decomposition should follow existing UI behavior exactly while reducing local complexity.

### Phase 7 - Complete lower-priority architecture items

Implement Track E last, only after all higher-priority tracks are passing. These are legitimate TODOs, but they are best handled after the product and safety items are complete.

## Parallel-Agent Boundaries

Parallel agents are appropriate only when edits do not collide.

Safe parallel groupings:

- `Track A` sub-work on prompting/reasoning logic vs renderer rendering only after the structured response contract is defined
- `Track C` Calendar OAuth redesign vs transformers-loader removal, since they live in separate domains
- `Track D` renderer test replacement vs `SettingsOverlay` extraction only if the tests do not depend on the extracted components in flight
- `Track 0` TODO reconciliation can run alongside implementation only for bookkeeping reads; final `TODO.md` edits must wait for verification evidence

Not safe in parallel:

- multiple agents editing `electron/main.ts`
- multiple agents editing `electron/ipcHandlers.ts`
- multiple agents editing `electron/preload.ts`
- multiple agents editing `src/types/electron.d.ts`
- multiple agents editing `src/components/NativelyInterface.tsx`

The implementation plan must therefore identify shared-file serialization points before dispatching subagents.

## Architecture Details

### Reasoning-First Response Contract

Track A should stop treating interview assistance as a single answer blob and instead adopt a typed structured response with sections such as:

- `mode`
- `openingReasoning`
- `implementationPlan`
- `tradeoffs`
- `edgeCases`
- `scaleConsiderations`
- `pushbackResponses`
- `likelyFollowUps`
- `codeTransition`

Backward compatibility requirement:

- existing non-`Conscious Mode` flows must continue to function without requiring every caller to consume the structured format
- the engine may normalize all outputs internally, but renderer presentation must keep current behavior when the mode is off

### Conscious Mode State Flow

`Conscious Mode` needs an explicit state-ownership rule because current session toggles are mixed between renderer-local and backend-backed patterns.

Design decision:

- `Conscious Mode` is backend-backed and persisted through the app settings path
- renderer loads the initial value from backend on startup
- renderer updates through an explicit IPC result contract rather than relying on localStorage-only truth
- if existing adjacent live toggles need alignment for consistency, that alignment is planned explicitly rather than assumed

Acceptance:

- a restart preserves the toggle state
- backend and renderer cannot silently drift
- the final UI behavior remains consistent with neighboring toggles from the user perspective even if internal ownership differs

### Follow-Up Reasoning Thread

The session layer should retain the active reasoning thread for the current technical question so follow-ups can extend prior reasoning rather than restart. Reset conditions should be explicit and conservative:

- reset on clearly new technical question/topic
- continue on pushback, scale, tradeoff, or clarification follow-ups

Verification matrix must include explicit examples:

- continue: "why this approach?"
- continue: "what if this scales to 10x?"
- continue: "what are the tradeoffs here?"
- continue: "walk me through your thinking again"
- reset: a clearly new problem or different prompt/topic
- reset: a non-technical transition unrelated to the current solution thread

The implementation plan should turn these into concrete tests.

### Qualifying-Question Routing

Routing into `Conscious Mode` must be validated against both trigger and non-trigger examples.

Required positive examples:

- "how would you..."
- "walk me through..."
- "why this approach?"
- "what if this scales?"
- "what are the tradeoffs?"
- "what if the input is 10x larger?"

Required negative examples:

- casual conversation unrelated to technical problem solving
- administrative meeting chatter
- generic transcript continuation that is not a final interviewer technical question

Acceptance:

- qualifying technical interviewer questions route into reasoning-first generation when `Conscious Mode` is enabled
- non-qualifying utterances do not spuriously trigger the mode

### IPC Contract Pattern

Remaining raw handlers should converge on a consistent result shape rather than ad hoc primitives. The exact envelope can be finalized during implementation, but it should support:

- `success`
- typed `data` for success payloads
- structured `error` with machine-readable code and human-readable message

This same contract should drive preload typings and renderer consumption.

For TODO closure, Track B must produce a file-by-file completion pass that explicitly names which handlers were upgraded in:

- `electron/ipcHandlers.ts`
- `electron/ipc/registerProfileHandlers.ts`
- `electron/ipc/registerRagHandlers.ts`
- `electron/ipc/registerSettingsHandlers.ts`

and must verify the corresponding preload and renderer-facing typings in:

- `electron/preload.ts`
- `src/types/electron.d.ts`

### Conscious Mode Analytics Contract

The analytics work in Track A must be concrete enough to satisfy `TODO.md:403-410`.

Minimum events and properties:

- `mode_selected` when `Conscious Mode` is enabled or disabled, with a mode value reflecting conscious-state selection
- `command_executed` or a dedicated event when a reasoning-first suggestion is generated, with properties sufficient to distinguish conscious-mode output from normal interview assist
- follow-up update tracking when an existing reasoning thread is extended rather than restarted

Minimum verification:

- toggling `Conscious Mode` emits the expected analytics event
- an initial reasoning-first suggestion emits the expected analytics event/properties
- a follow-up extension emits update tracking distinct from a fresh thread where practical
- tests assert event calls or payload-shape behavior at the integration points used by the renderer

### Calendar OAuth Direction

The current loopback callback should be replaced by a stronger production-grade approach suited to Electron. The design target is:

- primary implementation path: use an app-to-browser-to-app redirect based on a registered app protocol / deep-link return if the Google OAuth configuration supports it for this Electron app
- fallback implementation path: if provider constraints prevent the app protocol path, use a hardened localhost callback limited to `127.0.0.1`, single-use listener lifetime, random high port, strict path matching, strict state/PKCE validation, and immediate server teardown after completion or timeout
- preserve PKCE/state protections already added

Concrete done conditions:

- the production path no longer depends on the current broad loopback HTTP callback pattern
- callback/listener lifetime is minimized and tightly scoped to an active auth attempt
- PKCE, state validation, and timeout handling remain intact
- the new flow is verified in both development and packaged-app scenarios before the TODO is marked complete

Implementation planning must verify what redirect mechanisms are supported by the current Google OAuth app configuration before coding the replacement path.

### Transformers Loader Direction

The eval-based loader should be removed in favor of a packaging-safe import/loading strategy that still works in Electron packaged builds. Any replacement must be validated in both development and built contexts.

Concrete done conditions:

- no eval-based loading remains in the target loader path
- `IntentClassifier` and `LocalEmbeddingProvider` still load transformers successfully in development
- a built/package-oriented verification step confirms the replacement does not regress Electron runtime packaging behavior before the TODO is marked complete

### LLMHelper Budgeting and Retry Completion Rules

The unchecked `electron/LLMHelper.ts` items require concrete behavior changes, not just generic tuning.

Budgeting done conditions:

- model-specific input budgets are explicit rather than relying on one broad default where that would overrun smaller-context models
- long contexts are trimmed/summarized predictably before request dispatch
- the helper chooses the correct budgeting path for recap/summarization vs normal interview-assist generation
- tests or focused verification cover at least one oversized-context case and show the request path remains stable

Retry-consistency done conditions:

- retry ownership is centralized enough that providers follow the same broad policy shape
- retry caps/backoff or non-retryable failure rules are explicit rather than drifting by call site
- the helper does not spin inconsistent repeated retries across stream vs non-stream paths
- tests or focused verification cover at least one transient failure and one non-retryable failure path

Caching done conditions:

- cache scope is limited to repeatedly rebuilt system-prompt/final-payload work and exact-match duplicate requests
- caching lives in `electron/LLMHelper.ts`, not scattered across renderer/session logic
- no partial stream token caching is introduced
- cached responses are reused only when provider/model/system-prompt/final-payload identity matches exactly
- tests or focused verification prove identical requests hit cache and changed payloads miss cache

### SettingsOverlay Decomposition Direction

`src/components/SettingsOverlay.tsx` should be reduced by extracting cohesive sections rather than performing cosmetic splitting.

Concrete tranche boundary:

- extract at least the STT/provider settings area into its own focused component/module
- extract at least one additional independent settings area (for example overlay appearance/behavior controls or startup/system controls)
- keep shared state ownership explicit, with helper hooks only where they reduce prop-drilling or repeated request-state logic

Completion bar for the TODO:

- the parent `src/components/SettingsOverlay.tsx` no longer directly owns both of the extracted concern areas above
- each extracted unit has a stable prop/type boundary
- regression coverage or smoke verification exists for each extracted area

Concrete done conditions:

- extracted units each own one clear settings concern
- no behavior, persistence, or validation regressions are introduced
- the parent file is measurably smaller because the identified sections have moved out
- focused renderer tests or smoke verification cover the extracted behavior

### Naturalness Guardrails

`Conscious Mode` output needs objective guardrails so "sounds natural under pressure" is testable.

Acceptance heuristics:

- `openingReasoning` is concise spoken language, not essay formatting
- default opening section should fit as a short spoken response rather than a long monologue
- the model should prefer one primary approach and one backup tradeoff over sprawling option lists
- code should not appear first when the interviewer is asking for reasoning

Verification should include fixture-style prompt/output checks or targeted tests that assert section ordering, presence/absence of code-first behavior, and bounded opening length where feasible.

### Cleanup Track Done Conditions

Track E items are considered complete only if each change has a visible outcome:

- `electron/ipcHandlers.ts` shrink work moves at least one cohesive remaining handler group out of the file into a focused register module without changing external behavior
- `src/App.tsx` work defines a clearer ownership boundary for shared renderer state vs query/bootstrap concerns, with the resulting code movement or provider extraction reflected in source and verified by app startup behavior
- `package.json` `postinstall` evaluation measures which steps are necessary for a fresh install/build path and either removes/reorders unnecessary work or records a justified keep decision in the implementation notes backed by observed behavior
- `electron/tsconfig.json` strictness work enables specific stricter flags that the repo can pass; if a proposed flag is not enabled, the tranche is not complete until either the code is fixed to pass it or the plan explicitly scopes the flag out of this TODO item based on source constraints discovered during implementation

### Track E Per-Item Completion Checklists

`electron/ipcHandlers.ts`

- identify a cohesive remaining handler cluster still living in the root file
- extract it to a dedicated register module
- preserve channel names and external behavior
- verify build/typecheck and impacted flows

`src/App.tsx`

- identify whether meeting lifecycle/bootstrap logic, shared app state, or query client ownership is currently over-coupled
- move at least one concern behind a clearer boundary such as a provider, hook, or bootstrap helper
- verify app startup and meeting start/stop flows still work

`package.json` `postinstall`

- measure/install-test the current postinstall path
- identify heavy or redundant work
- either simplify it safely or justify the remaining steps with evidence

`electron/tsconfig.json`

- evaluate at least one stricter TypeScript option set relevant to the current code
- enable the flags that can pass after fixes
- verify Electron typecheck passes with the stricter configuration

## Testing and Verification Strategy

Every track must end with explicit verification before the next one begins.

Core verification stack:

- `npm run build`
- `npm run typecheck`
- `npx tsc -p electron/tsconfig.json`
- focused renderer/electron tests for changed areas

Additional verification by track:

- Track A: tests for toggle persistence, reasoning-first routing, structured rendering, follow-up extension, and analytics emission where practical
- Track B: tests or focused validation for handler input validation and contract normalization
- Track C: callback flow verification, packaged/dev runtime checks for loader behavior, and targeted request budgeting/retry tests where possible
- Track D: renderer tests covering real app behavior and regression checks after `SettingsOverlay` extraction
- Track E: build, typecheck, and regression checks sufficient to prove cleanup did not alter behavior unexpectedly
- Track 0: reconcile `TODO.md` after each verified tranche so `Recommended Execution Order` and `Exit Criteria` no longer remain stale

## Exit Criteria

This program is complete only when:

- every unchecked item in `TODO.md` is either implemented or intentionally rewritten as completed with matching source changes
- the new `Conscious Mode` flow works end-to-end and is persisted
- shared IPC surfaces are validated, typed, and contract-consistent
- the stronger Calendar OAuth callback design replaces the current loopback approach
- the eval-based transformers loader is removed without breaking runtime/package behavior
- renderer tests cover meaningful app behavior instead of boilerplate
- stale unchecked `Recommended Execution Order` and `Exit Criteria` entries are reconciled against source truth
- build and typecheck pass after the final tranche

## Risks and Mitigations

- shared-file contention: handled by phased execution and explicit serialization points
- prompt/renderer mismatch: handled by defining the structured response contract before UI work
- packaging regressions from loader changes: handled by dev and built verification
- security regressions in OAuth changes: handled by preserving PKCE/state protections and validating redirect constraints before editing
- scope creep in cleanup items: handled by treating Track E as separate cleanup work after user-facing items are complete

## Deliverables From Planning

The implementation plan should produce:

- one master execution plan document
- bite-sized tasks grouped by track and file ownership
- explicit points where parallel agents may be dispatched
- required verification commands after each tranche
- a final pass to update `TODO.md` so it accurately reflects completed work

## Appendix - IPC Closure Inventory

The implementation plan must treat the following current raw/mixed-contract areas as the closure inventory for `TODO.md:413`, `TODO.md:428`, and `TODO.md:432`.

### `electron/ipc/registerSettingsHandlers.ts`

Channels to normalize/verify:

- `get-recognition-languages`
- `get-ai-response-languages`
- `get-stt-language`
- `get-ai-response-language`
- `close-settings-window`
- `set-disguise`
- `get-undetectable`
- `get-disguise`
- `get-open-at-login`

Target:

- validated inputs where applicable
- consistent result envelopes for setters/actions
- explicit preload wrappers and renderer typings for all exposed calls

### `electron/ipc/registerProfileHandlers.ts`

Channels to normalize/verify:

- `profile:upload-resume`
- `profile:get-status`
- `profile:set-mode`
- `profile:delete`
- `profile:get-profile`
- `profile:select-file`
- `profile:upload-jd`
- `profile:delete-jd`
- `profile:research-company`
- `profile:generate-negotiation`
- `set-google-search-api-key`
- `set-google-search-cse-id`

Target:

- validated file path/string/boolean inputs
- no mixed `null`/boolean/object ambiguity without typed contracts
- preload wrappers and `electron.d.ts` entries aligned to the final contracts

### `electron/ipc/registerRagHandlers.ts`

Channels to normalize/verify:

- `rag:query-meeting`
- `rag:query-live`
- `rag:query-global`
- `rag:cancel-query`
- `rag:is-meeting-processed`
- `rag:reindex-incompatible-meetings`
- `rag:get-queue-status`
- `rag:retry-embeddings`

Target:

- validated object payloads for query/cancel channels
- explicit typed distinction between `success`, `fallback`, and `error`
- preload wrappers and renderer types for stream-related calls and responses

### `electron/ipcHandlers.ts`

Root-level channels to normalize/verify for remaining closure work:

- screenshot/window utility channels that still return primitives or ad hoc objects
- donation/update control channels
- provider/config getters still returning mixed shapes
- theme/overlay channels still using raw arguments or primitive returns

Explicit exclusion by owner instruction:

- do not modify licensing or premium-entitlement behavior
- leave `license:*` / premium-open-source behavior untouched unless the owner later requests otherwise

Typed-coverage closure standard:

- every actively used channel above has a named preload wrapper
- every wrapper is declared in `src/types/electron.d.ts`
- shared payload/result types are introduced for non-trivial objects
- renderer call sites compile against those types without `any`-style gaps
