# cURL Provider Guide

This guide explains how to configure **Custom cURL Providers** in Natively so text, screenshots, and multimodal prompts all work reliably.

## 1) Where to configure

Open:

`Settings -> AI Providers -> Add Provider`

Fill:

- **Provider Name**
- **cURL Command**
- **Response JSON Path** (optional, but recommended)

## 2) Supported input modes

Your cURL template can be configured for any of these modes:

- **Text only**: use `{{TEXT}}` or `{{OPENAI_MESSAGES}}`
- **Image only**: use `{{IMAGE_BASE64}}` or `{{IMAGE_BASE64S}}`
- **Text + image**: use both text and image placeholders, or a single `{{OPENAI_MESSAGES}}`

You only need **one supported placeholder** in the template, but most real providers should include at least one text or image field explicitly.

## 3) Placeholder reference

Core placeholders:

- `{{TEXT}}`: combined system + context + user message
- `{{PROMPT}}`: alias of `{{TEXT}}`
- `{{USER_MESSAGE}}`: raw user message only
- `{{SYSTEM_PROMPT}}`: system prompt only
- `{{CONTEXT}}`: context only

Image placeholders:

- `{{IMAGE_BASE64}}`: first screenshot as base64 string
- `{{IMAGE_BASE64S}}`: array of all screenshots as base64 strings
- `{{IMAGE_COUNT}}`: number of attached screenshots

OpenAI-compatible placeholders:

- `{{OPENAI_USER_CONTENT}}`: OpenAI user content array (`text` + `image_url` parts)
- `{{OPENAI_MESSAGES}}`: OpenAI messages array (`system` + multimodal `user`)

API key placeholders:

- `{{API_KEY}}`: best-available configured key
- `{{OPENAI_API_KEY}}`, `{{GROQ_API_KEY}}`, `{{CEREBRAS_API_KEY}}`, `{{CLAUDE_API_KEY}}`, `{{GEMINI_API_KEY}}`

## 4) Recommended templates

### A) OpenAI-compatible multimodal (recommended)

```bash
curl https://api.openai.com/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer {{OPENAI_API_KEY}}" \
  -d '{
    "model": "gpt-4o-mini",
    "messages": {{OPENAI_MESSAGES}},
    "temperature": 0.2
  }'
```

Typical response path:

`choices[0].message.content`

### B) Text-only generic endpoint

```bash
curl https://example.com/generate \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "{{TEXT}}"
  }'
```

### C) Image-only endpoint

```bash
curl https://example.com/vision \
  -H "Content-Type: application/json" \
  -d '{
    "image": "{{IMAGE_BASE64}}"
  }'
```

### D) Multi-image endpoint

```bash
curl https://example.com/vision/batch \
  -H "Content-Type: application/json" \
  -d '{
    "images": {{IMAGE_BASE64S}},
    "count": "{{IMAGE_COUNT}}",
    "question": "{{USER_MESSAGE}}"
  }'
```

## 5) Response JSON Path examples

Use the path to extract just the final answer text from provider JSON:

- OpenAI chat completions: `choices[0].message.content`
- Anthropic-style: `content[0].text`
- Ollama-style: `response`

If path is empty, Natively tries common formats automatically.

## 6) Troubleshooting

- **Empty output**: set a concrete response path first.
- **HTTP 4xx/5xx**: verify URL, headers, and API key placeholders.
- **Image not received**: verify your payload includes `{{IMAGE_BASE64}}` or `{{IMAGE_BASE64S}}`.
- **Malformed payload**: use valid JSON in `-d '...'` body.

## 7) Security notes

- Keep real API keys out of saved plaintext templates when possible.
- Prefer provider placeholders (`{{OPENAI_API_KEY}}`, etc.) over hardcoded keys.
- Validate your cURL command before saving in production workflows.
