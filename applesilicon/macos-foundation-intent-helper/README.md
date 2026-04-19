# macOS Foundation Intent Helper

Small Swift CLI helper that classifies interview intents using Apple's Foundation Models on supported Apple Silicon macOS hosts.

## Request / Response contract

Reads a single JSON payload from stdin and prints a single JSON response to stdout.

Request:

```json
{
  "version": 1,
  "question": "Tell me about a conflict you resolved.",
  "preparedTranscript": "[INTERVIEWER]: Tell me about a conflict you resolved.",
  "assistantResponseCount": 2,
  "promptVersion": "foundation_intent_prompt_v2",
  "schemaVersion": "foundation_intent_schema_v1",
  "locale": "en-US",
  "candidateIntents": ["behavioral", "coding", "deep_dive", "clarification", "follow_up", "example_request", "summary_probe", "general"]
}
```

Success:

```json
{
  "ok": true,
  "intent": "behavioral",
  "confidence": 0.92,
  "answerShape": "Give one concrete story in STAR format.",
  "provider": "apple_foundation_models",
  "promptVersion": "foundation_intent_prompt_v2",
  "schemaVersion": "foundation_intent_schema_v1"
}
```

Failure:

```json
{
  "ok": false,
  "errorType": "unavailable | model_not_ready | unsupported_locale | timeout | refusal | invalid_response | unknown",
  "message": "Model unavailable: ..."
}
```

## Build

```bash
swift build -c release --package-path applesilicon/macos-foundation-intent-helper
```

## Notes

- Requires Foundation Models support and Apple Intelligence availability at runtime (macOS 26+).
- Intended to be invoked by Electron provider code, not directly by end users.
