import React from 'react';

export const CONSCIOUS_MODE_SECTION_TITLES = [
  'Say This First',
  'Then Build It',
  'Tradeoffs',
  'If They Push Back',
  'If They Ask For Code',
] as const;

const MAX_OPENING_REASONING_CHARS = 220;
const MAX_OPENING_REASONING_SENTENCES = 3;

type ConsciousModeSectionTitle = (typeof CONSCIOUS_MODE_SECTION_TITLES)[number];
type SourceSectionKey =
  | 'openingReasoning'
  | 'implementationPlan'
  | 'tradeoffs'
  | 'edgeCases'
  | 'scaleConsiderations'
  | 'pushbackResponses'
  | 'likelyFollowUps'
  | 'codeTransition';

interface ParsedSourceSections {
  openingReasoning: string;
  implementationPlan: string[];
  tradeoffs: string[];
  edgeCases: string[];
  scaleConsiderations: string[];
  pushbackResponses: string[];
  likelyFollowUps: string[];
  codeTransition: string;
}

export interface ConsciousModeRenderSection {
  title: ConsciousModeSectionTitle;
  items: string[];
}

export interface ConsciousModeRenderModel {
  sections: ConsciousModeRenderSection[];
}

export interface ConsciousModeSimpleRenderModel {
  paragraphs: string[];
}

export interface ConsciousModeGuardrailResult {
  isValid: boolean;
  reason?:
    | 'missing_opening_reasoning'
    | 'opening_reasoning_contains_code'
    | 'opening_reasoning_too_long'
    | 'code_before_final_section';
}

export interface AssistRenderClassification {
  output_variant: 'conscious_mode' | 'standard_interview_assist';
  thread_type: 'fresh_reasoning_thread' | 'follow_up_extension' | 'fresh_answer';
}

const LABEL_TO_KEY: Record<string, SourceSectionKey> = {
  'Opening reasoning': 'openingReasoning',
  'Implementation plan': 'implementationPlan',
  Tradeoffs: 'tradeoffs',
  'Edge cases': 'edgeCases',
  'Scale considerations': 'scaleConsiderations',
  'Pushback responses': 'pushbackResponses',
  'Likely follow-ups': 'likelyFollowUps',
  'Code transition': 'codeTransition',
};

function createEmptySourceSections(): ParsedSourceSections {
  return {
    openingReasoning: '',
    implementationPlan: [],
    tradeoffs: [],
    edgeCases: [],
    scaleConsiderations: [],
    pushbackResponses: [],
    likelyFollowUps: [],
    codeTransition: '',
  };
}

function hasCodeFence(value: string): boolean {
  return /```/.test(value);
}

function countSentences(value: string): number {
  return value.split(/[.!?]+/).map((part) => part.trim()).filter(Boolean).length;
}

function hasCompleteStructuredSections(text: string): boolean {
  return Object.keys(LABEL_TO_KEY).every((label) => text.includes(`${label}:`));
}

function parseSourceSections(text: string): ParsedSourceSections | null {
  const trimmed = text.trim();
  if (!trimmed.includes('Opening reasoning:')) {
    return null;
  }

  const parsed = createEmptySourceSections();
  const lines = trimmed.split('\n');
  let currentKey: SourceSectionKey | null = null;

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const sectionMatch = line.match(/^([A-Za-z\- ]+):\s*(.*)$/);

    if (sectionMatch && LABEL_TO_KEY[sectionMatch[1]]) {
      currentKey = LABEL_TO_KEY[sectionMatch[1]];
      const initialValue = sectionMatch[2].trim();
      if (currentKey === 'openingReasoning' || currentKey === 'codeTransition') {
        parsed[currentKey] = initialValue;
      } else if (initialValue) {
        parsed[currentKey].push(initialValue.replace(/^-\s*/, '').trim());
      }
      continue;
    }

    if (!currentKey) {
      continue;
    }

    if (currentKey === 'openingReasoning' || currentKey === 'codeTransition') {
      parsed[currentKey] = parsed[currentKey]
        ? `${parsed[currentKey]}\n${line.trim()}`.trim()
        : line.trim();
      continue;
    }

    const cleaned = line.replace(/^-\s*/, '').trim();
    if (cleaned) {
      parsed[currentKey].push(cleaned);
    }
  }

  return parsed;
}

function looksLikeStructuredConsciousModeText(text: string): boolean {
  return /(Opening reasoning:|Implementation plan:|Tradeoffs:|Code transition:)/.test(text);
}

export function validateConsciousModeGuardrails(text: string): ConsciousModeGuardrailResult {
  const parsed = parseSourceSections(text);
  if (!parsed || !parsed.openingReasoning.trim()) {
    return { isValid: false, reason: 'missing_opening_reasoning' };
  }

  if (hasCodeFence(parsed.openingReasoning)) {
    return { isValid: false, reason: 'opening_reasoning_contains_code' };
  }

  if (
    parsed.openingReasoning.length > MAX_OPENING_REASONING_CHARS ||
    countSentences(parsed.openingReasoning) > MAX_OPENING_REASONING_SENTENCES
  ) {
    return { isValid: false, reason: 'opening_reasoning_too_long' };
  }

  if (!hasCompleteStructuredSections(text)) {
    return { isValid: false, reason: 'missing_opening_reasoning' };
  }

  const earlySections = [
    ...parsed.implementationPlan,
    ...parsed.tradeoffs,
    ...parsed.edgeCases,
    ...parsed.scaleConsiderations,
    ...parsed.pushbackResponses,
    ...parsed.likelyFollowUps,
  ].join('\n');

  if (hasCodeFence(earlySections)) {
    return { isValid: false, reason: 'code_before_final_section' };
  }

  return { isValid: true };
}

export function parseConsciousModeAnswer(text: string): ConsciousModeRenderModel | null {
  const parsed = parseSourceSections(text);
  const guardrails = validateConsciousModeGuardrails(text);

  if (!parsed || !guardrails.isValid) {
    return null;
  }

  return {
    sections: [
      {
        title: 'Say This First',
        items: [parsed.openingReasoning],
      },
      {
        title: 'Then Build It',
        items: [
          ...parsed.implementationPlan,
          ...parsed.edgeCases.map((item) => `Watch for: ${item}`),
          ...parsed.scaleConsiderations.map((item) => `At scale: ${item}`),
        ],
      },
      {
        title: 'Tradeoffs',
        items: parsed.tradeoffs,
      },
      {
        title: 'If They Push Back',
        items: [
          ...parsed.pushbackResponses,
          ...parsed.likelyFollowUps.map((item) => `They may also ask: ${item}`),
        ],
      },
      {
        title: 'If They Ask For Code',
        items: parsed.codeTransition ? [parsed.codeTransition] : [],
      },
    ],
  };
}

export function parseSimpleConsciousModeAnswer(text: string): ConsciousModeSimpleRenderModel | null {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }

  if (looksLikeStructuredConsciousModeText(trimmed)) {
    return null;
  }

  const paragraphs = trimmed
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);

  if (paragraphs.length === 0) {
    return null;
  }

  return { paragraphs };
}

function splitCodeBlocks(value: string): Array<{ type: 'text' | 'code'; value: string }> {
  return value
    .split(/(```[\s\S]*?```)/g)
    .filter(Boolean)
    .map((chunk) => {
      if (chunk.startsWith('```')) {
        return {
          type: 'code' as const,
          value: chunk.replace(/^```\w*\s*/u, '').replace(/```$/u, '').trim(),
        };
      }

      return { type: 'text' as const, value: chunk.trim() };
    })
    .filter((chunk) => chunk.value.length > 0);
}

export function classifyAssistRender({
  answerText,
  threadAction,
}: {
  answerText: string;
  threadAction?: 'start' | 'continue' | 'reset' | 'ignore';
}): AssistRenderClassification {
  const parsed = parseConsciousModeAnswer(answerText);
  if (!parsed) {
    return {
      output_variant: 'standard_interview_assist',
      thread_type: 'fresh_answer',
    };
  }

  return {
    output_variant: 'conscious_mode',
    thread_type: threadAction === 'continue' ? 'follow_up_extension' : 'fresh_reasoning_thread',
  };
}

export function ConsciousModeAnswer({
  text,
  isStreaming = false,
}: {
  text: string;
  isStreaming?: boolean;
}) {
  const parsed = parseConsciousModeAnswer(text);

  if (!parsed) {
    if (isStreaming && looksLikeStructuredConsciousModeText(text)) {
      return (
        <div className="rounded-lg border border-white/10 bg-white/5 p-3 text-[13px] text-slate-300">
          Preparing Conscious Mode response...
        </div>
      );
    }

    const simple = parseSimpleConsciousModeAnswer(text);
    if (simple) {
      return (
        <div className="rounded-lg border border-white/10 bg-white/5 p-3">
          <div className="space-y-2 text-[13px] leading-relaxed text-slate-100">
            {simple.paragraphs.map((paragraph, index) => (
              <div key={`simple-${index}`} className="space-y-2">
                {splitCodeBlocks(paragraph).map((chunk, chunkIndex) =>
                  chunk.type === 'code' ? (
                    <pre
                      key={`simple-${index}-${chunkIndex}`}
                      className="overflow-x-auto rounded-lg border border-white/10 bg-black/30 p-3 font-mono text-xs text-slate-100"
                    >
                      <code>{chunk.value}</code>
                    </pre>
                  ) : (
                    <p key={`simple-${index}-${chunkIndex}`} className="whitespace-pre-wrap">
                      {chunk.value}
                    </p>
                  ),
                )}
              </div>
            ))}
          </div>
        </div>
      );
    }

    const raw = text.trim();
    if (!raw) {
      return null;
    }

    return (
      <div className="rounded-lg border border-amber-400/20 bg-amber-400/5 p-3 text-[13px] leading-relaxed text-slate-100">
        <p className="whitespace-pre-wrap">{raw}</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {parsed.sections.map((section) => (
        <section key={section.title} className="rounded-lg border border-white/10 bg-white/5 p-3">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-emerald-300">
            {section.title}
          </h3>
          {section.items.length > 0 ? (
            <div className="space-y-2 text-[13px] leading-relaxed text-slate-100">
              {section.items.map((item, index) => (
                <div key={`${section.title}-${index}`} className="space-y-2">
                  {splitCodeBlocks(item).map((chunk, chunkIndex) =>
                    chunk.type === 'code' ? (
                      <pre
                        key={`${section.title}-${index}-${chunkIndex}`}
                        className="overflow-x-auto rounded-lg border border-white/10 bg-black/30 p-3 font-mono text-xs text-slate-100"
                      >
                        <code>{chunk.value}</code>
                      </pre>
                    ) : (
                      <p key={`${section.title}-${index}-${chunkIndex}`} className="whitespace-pre-wrap">
                        {chunk.value}
                      </p>
                    ),
                  )}
                </div>
              ))}
            </div>
          ) : (
            <p className="text-[13px] text-slate-400">No guidance yet.</p>
          )}
        </section>
      ))}
    </div>
  );
}
