# Neural Prompt Optimization + Lightweight RL Scorer

**Date**: 2026-03-21  
**Status**: Draft  
**Goal**: Make interview responses sound like a real FAANG engineer, not AI text dumps

## Problem Statement

Current prompts produce two failure modes:
1. **Super plain**: Generic, unimpressive responses lacking technical depth
2. **Verbose LLM dump**: Wall of text that no human would speak

Neither sounds like a skilled engineer in a real interview. We need responses that are:
- Natural and conversational
- Technically precise
- Appropriately concise
- Company-context aware
- Measurably high quality

## Solution Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    Neural Prompt Optimization System                     │
├───────────────────┬───────────────────┬─────────────────────────────────┤
│  Distilled Prompt │  Company Context  │  Quality Scorer                 │
│  Engine           │  Layer            │  (RL-trained)                   │
├───────────────────┼───────────────────┼─────────────────────────────────┤
│ • Few-shot        │ • Signal-based    │ • ONNX model (~10MB)            │
│   exemplars from  │   company detect  │ • Scores 0-100                  │
│   real interviews │ • 5 company       │ • Re-gen if score < 70          │
│ • Anti-pattern    │   presets:        │ • Features:                     │
│   blocklist       │   - Google        │   - Lexical diversity           │
│ • 3-tier response │   - Meta          │   - Technical density           │
│   templates       │   - Amazon        │   - Conciseness ratio           │
│                   │   - Stripe        │   - Naturalness score           │
│                   │   - OpenAI        │ • <50ms CPU inference           │
└───────────────────┴───────────────────┴─────────────────────────────────┘
```

## Component 1: Distilled Prompt Engine

### 1.1 Few-Shot Exemplars

Replace verbose instructions with 2-3 high-quality examples per interview phase.

**Current Problem** (prompts.ts):
```
YOUR TASK:
- Help them ask smart clarifying questions
- Suggest assumptions to validate
- Guide them to uncover hidden constraints
```

**Solution**: Distilled exemplar format:
```
<exemplar type="requirements">
INTERVIEWER: "Design a URL shortener"
GOOD: "Before I dive in—what's our read-to-write ratio? And are we optimizing for latency or throughput on redirects?"
BAD: "Great question! Let me help you think through the requirements systematically. First, we should consider..."
</exemplar>
```

### 1.2 Anti-Pattern Blocklist

Hard-coded phrases that trigger re-generation:

```typescript
const LLM_SPEAK_BLOCKLIST = [
  // Opening fluff
  "Great question",
  "That's a great point", 
  "Let me help you",
  "I'd be happy to",
  "Absolutely",
  
  // Meta-commentary
  "Let me think about this",
  "Here's my thought process",
  "I'll break this down",
  "Systematically",
  
  // Filler
  "It's worth noting",
  "It's important to consider",
  "Essentially",
  "Basically",
  "In essence",
  
  // Excessive hedging
  "might potentially",
  "could possibly",
  "may or may not",
  
  // Tutorial mode
  "Let me explain",
  "As you may know",
  "For context",
];
```

### 1.3 Three-Tier Response Templates

Adaptive length based on mode:

| Tier | Mode | Target Length | Use Case |
|------|------|---------------|----------|
| Terse | Standard | 15-20 seconds | Quick conceptual answers |
| Standard | Standard | 25-30 seconds | Most responses |
| Deep | Conscious Mode | 45-90 seconds | Complex system design, coding |

## Component 2: Company Context Layer

### 2.1 Signal-Based Detection

Detect company from available signals:

```typescript
interface CompanySignals {
  meetingTitle: string;      // "Google Phone Screen", "Meta E5 Loop"
  calendarOrganizer: string; // @google.com, @meta.com
  participantDomains: string[];
  transcriptMentions: string[]; // "leadership principles", "Googleyness"
}
```

### 2.2 Company Presets

| Company | Focus Areas | Style Modifiers |
|---------|-------------|-----------------|
| Google | Scale (billions), code quality, Googleyness | Precise numbers, humble confidence |
| Meta | Iteration speed, impact, move fast | Action-oriented, metric-driven |
| Amazon | Leadership Principles, ownership, frugality | LP references, customer obsession |
| Stripe | Pragmatism, developer experience, clarity | Clear tradeoffs, production focus |
| OpenAI | Research depth, safety, scaling laws | First principles, acknowledge uncertainty |

### 2.3 Dynamic Prompt Injection

```typescript
function getCompanyModifier(company: Company): string {
  const modifiers: Record<Company, string> = {
    google: `
GOOGLE INTERVIEW CONTEXT:
- Reference scale in billions where appropriate
- Mention distributed systems tradeoffs
- Show intellectual humility ("One approach would be...")
- Avoid over-confidence on uncertain claims`,
    
    amazon: `
AMAZON INTERVIEW CONTEXT:
- Weave in Leadership Principles naturally (don't force them)
- Lead with customer impact
- Show ownership ("I drove...", "I owned...")
- Be specific about metrics and outcomes`,
    
    // ... other companies
  };
  return modifiers[company] || '';
}
```

## Component 3: Quality Scorer (RL-Trained)

### 3.1 Model Architecture

**Option A: Tiny Transformer (Recommended)**
- Architecture: DistilBERT-tiny or custom 6-layer transformer
- Size: ~10MB ONNX
- Inference: <50ms CPU
- Training: Supervised on (response, quality_score) pairs

**Option B: Feature-Based Regression**
- Extract 15-20 features from response
- Train gradient boosting (XGBoost/LightGBM)
- Size: <1MB
- Inference: <10ms
- Less accurate but faster

### 3.2 Quality Features

```typescript
interface QualityFeatures {
  // Lexical
  lexicalDiversity: number;     // Type-token ratio
  avgSentenceLength: number;    // Target: 12-20 words
  avgWordLength: number;        // Target: 4-6 chars
  
  // Technical
  technicalDensity: number;     // % technical terms
  codeToProseRatio: number;     // For coding responses
  
  // Naturalness
  firstPersonRatio: number;     // "I", "my", "we" usage
  questionRatio: number;        // Rhetorical questions
  contractionUsage: number;     // "I'd", "we'll" (more natural)
  
  // Anti-patterns
  llmPhraseCount: number;       // From blocklist
  hedgingScore: number;         // Excessive qualifiers
  
  // Structure
  bulletPointRatio: number;     // Too many = tutorial mode
  sentenceVariety: number;      // Varied lengths = natural
}
```

### 3.3 Scoring Pipeline

```typescript
async function scoreResponse(response: string, phase: InterviewPhase): Promise<number> {
  const features = extractFeatures(response);
  
  // Quick blocklist check (instant fail)
  if (features.llmPhraseCount > 2) {
    return 0; // Force regeneration
  }
  
  // ONNX inference
  const score = await onnxSession.run({
    input: featuresToTensor(features)
  });
  
  return score; // 0-100
}
```

### 3.4 Re-Generation Strategy

```typescript
const QUALITY_THRESHOLD = 70;
const MAX_RETRIES = 2;

async function generateWithQuality(prompt: string, phase: InterviewPhase): Promise<string> {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const response = await llm.generate(prompt);
    const score = await scoreResponse(response, phase);
    
    if (score >= QUALITY_THRESHOLD) {
      return response;
    }
    
    // Add feedback to prompt for retry
    prompt = addQualityFeedback(prompt, response, score);
  }
  
  // Fallback: use template-based response
  return getEmergencyResponse(phase);
}
```

## Component 4: Prompt Rewrite

### 4.1 Core Identity Rewrite

**Current** (verbose instructions):
```
<strict_behavior_rules>
- You are an INTERVIEW COPILOT. Every response should be something the user can SAY in an interview or meeting.
- NEVER engage in casual conversation, small talk, or pleasantries...
[40+ lines of rules]
```

**New** (distilled + exemplar-driven):
```
<voice>
You speak as a senior engineer in a live interview. No fluff. No teaching. Just what you'd actually say.
</voice>

<anti_patterns>
NEVER: "Great question", "Let me explain", "It's worth noting", "Essentially", excessive bullet points
</anti_patterns>

<exemplar_good>
"For the rate limiter, I'd use sliding window over fixed—fixed has that burst problem at boundaries. Quick implementation: Redis sorted set with timestamps as scores, ZREMRANGEBYSCORE to trim old entries."
</exemplar_good>

<exemplar_bad>
"Great question! Let me break this down systematically. A rate limiter is a mechanism that controls the rate of requests... There are several approaches we could consider: 1) Token bucket 2) Leaky bucket 3) Fixed window 4) Sliding window..."
</exemplar_bad>
```

### 4.2 Phase-Specific Prompt Rewrites

Each phase prompt gets:
1. **2-3 exemplars** (good/bad pairs)
2. **Phase-specific anti-patterns**
3. **Company modifier injection point**
4. **Simplified JSON contract**

## Integration Points

### 4.1 Where Quality Scorer Hooks In

```
IntelligenceEngine.processQuery()
    ↓
ConsciousModeRouter.route() 
    ↓
LLMHelper.generateResponse()
    ↓
QualityScorer.score() ←── NEW
    ↓
[score >= 70?] → return
    ↓ [score < 70]
RetryWithFeedback()
    ↓
QualityScorer.score()
    ↓
[max retries?] → FallbackExecutor.execute()
```

### 4.2 File Changes Required

| File | Changes |
|------|---------|
| `electron/llm/prompts.ts` | Rewrite all prompts with exemplars, add company modifiers |
| `electron/quality/` | NEW: QualityScorer, FeatureExtractor, ONNX loader |
| `electron/quality/model.onnx` | NEW: Trained quality model |
| `electron/company/` | NEW: CompanyDetector, presets |
| `electron/LLMHelper.ts` | Add quality scoring wrapper |
| `electron/IntelligenceEngine.ts` | Integrate company detection |

## Training the Quality Scorer

### 5.1 Data Collection

1. **Synthetic pairs**: Generate (prompt, good_response, bad_response) using GPT-4
2. **Expert labels**: Have engineers rate responses 0-100
3. **A/B feedback**: Collect implicit feedback from real usage

### 5.2 Training Pipeline

```bash
# 1. Generate training data
python scripts/generate_training_data.py --count 10000

# 2. Train model
python scripts/train_quality_model.py \
  --data training_data.jsonl \
  --output electron/quality/model.onnx \
  --architecture distilbert-tiny

# 3. Validate
python scripts/evaluate_model.py --test test_data.jsonl
```

### 5.3 Model Export

Export to ONNX for cross-platform CPU inference:
- Node.js: onnxruntime-node
- Size target: <15MB
- Latency target: <50ms

## Constraints & Requirements

1. **OpenAI-Compatible**: All prompts work with standard chat completion API
2. **Provider Portable**: No provider-specific features (works with Groq, Claude, Together, etc.)
3. **Mode Adaptive**: Strict timing in standard mode, relaxed in Conscious Mode
4. **Low Latency**: Quality scoring adds <50ms overhead
5. **Graceful Degradation**: Falls back to templates if scoring fails

## Success Metrics

| Metric | Current | Target |
|--------|---------|--------|
| LLM-phrase rate | ~40% responses | <5% |
| Avg response length (non-code) | 150-300 words | 50-100 words |
| First-person usage | ~20% | >60% |
| User satisfaction (future A/B) | baseline | +30% |
| Quality score avg | N/A | >75 |

## Implementation Phases

### Phase 1: Prompt Rewrite (3-4 days)
- Rewrite all prompts with exemplars
- Add anti-pattern blocklist
- Implement company detection
- Add company modifiers

### Phase 2: Quality Scorer (4-5 days)
- Implement feature extraction
- Generate training data
- Train ONNX model
- Integrate into LLMHelper

### Phase 3: Integration & Testing (2-3 days)
- End-to-end integration
- Quality threshold tuning
- Performance optimization
- Test coverage

## Open Questions

1. **Model training data**: Generate synthetic or collect real interview samples?
2. **Quality threshold**: Start at 70, tune based on results?
3. **Company detection fallback**: Default to "generic FAANG" if undetected?
4. **Retry budget**: 2 retries acceptable for latency?

## Appendix: Example Prompt Rewrite

### Before (CONSCIOUS_MODE_REQUIREMENTS_PROMPT)

```
CURRENT PHASE: Requirements Gathering
The candidate is clarifying requirements and constraints before designing.

YOUR TASK:
- Help them ask smart clarifying questions
- Suggest assumptions to validate
- Guide them to uncover hidden constraints

NATURAL SPEECH RULES:
- Lead with reasoning before diving into implementation
- Prefer one clear approach over a list of alternatives
...
```

### After

```
<phase>requirements</phase>

<voice>
Senior engineer asking clarifying questions before designing. Direct. Purposeful. No fluff.
</voice>

<exemplar type="good">
PROMPT: Design a URL shortener
RESPONSE: "Before I dive in—what's our expected scale? Reads per second, writes per second? And do we need analytics on click-through, or just the redirect?"
</exemplar>

<exemplar type="bad">
PROMPT: Design a URL shortener
RESPONSE: "Great question! URL shorteners are fascinating systems. Let me think through the requirements systematically. First, we should consider the functional requirements..."
</exemplar>

<company_modifier>
{{COMPANY_CONTEXT}}
</company_modifier>

<constraints>
- 2-4 questions max
- Each question has clear purpose
- No "let me think" or "great question"
- Speak as the candidate
</constraints>
```
