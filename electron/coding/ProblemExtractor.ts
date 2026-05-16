/**
 * NAT-301: ProblemExtractor — coding_problem_v1 extraction pipeline.
 *
 * Pipeline:
 *  1. Native OCR cascade (Apple Vision on macOS, Windows OCR on Windows,
 *     Tesseract.js as universal fallback) via the shared `OcrService`.
 *  2. If active provider supports vision, parallel multimodal call for
 *     structured JSON.
 *  3. JSON-merge (prefer multimodal, fall back to OCR-derived).
 *  4. SHA-256 cache by problemStatement.
 *
 * The cascade speeds up OCR ~50x on supported platforms (Apple Vision is
 * ~80ms vs Tesseract's 3-10s) and improves accuracy on UI screenshots
 * with mixed fonts. Tesseract.js is retained for Linux and as a last-
 * resort fallback when native providers fail.
 */
import crypto from 'crypto';
import Tesseract from 'tesseract.js';
import fs from 'fs';
import { createOcrService, type OcrService } from '../ocr';
import {
  CODING_PROBLEM_SCHEMA_VERSION,
  type CodingProblem,
  type CodingExample,
  type ProblemType,
} from './types';

const PROBLEM_TYPE_REGEX: Array<{ pattern: RegExp; type: ProblemType }> = [
  { pattern: /\bdynamic programming\b|\bdp\b|\bmemoiz/i, type: 'dynamic_programming' },
  { pattern: /\bbacktrack/i, type: 'backtracking' },
  { pattern: /\bbinary search\b/i, type: 'binary_search' },
  { pattern: /\bgraph\b|\bBFS\b|\bDFS\b|\badjacency/i, type: 'graphs' },
  { pattern: /\btree\b|\binorder\b|\bpreorder\b|\bpostorder\b|\bBST\b/i, type: 'trees' },
  { pattern: /\blinked list\b|\bsingly linked\b|\bdoubly linked\b/i, type: 'linked_list' },
  { pattern: /\bheap\b|\bpriority queue\b/i, type: 'heap_priority_queue' },
  { pattern: /\bhash map\b|\bhashmap\b|\bhash table\b/i, type: 'hash_map' },
  { pattern: /\btwo pointer\b|\btwo-pointer\b/i, type: 'two_pointers' },
  { pattern: /\bsliding window\b/i, type: 'sliding_window' },
  { pattern: /\bstack\b|\bqueue\b/i, type: 'stack_queue' },
  { pattern: /\bgreedy\b/i, type: 'greedy' },
  { pattern: /\bsystem design\b/i, type: 'system_design' },
  { pattern: /\bdesign\b|\bimplement a\b/i, type: 'design' },
  { pattern: /\bstring\b|\bsubstring\b|\bpalindrome\b/i, type: 'strings' },
  { pattern: /\barray\b|\bsubarray\b|\bmatrix\b/i, type: 'arrays' },
];

function classifyProblemType(text: string): ProblemType {
  for (const { pattern, type } of PROBLEM_TYPE_REGEX) {
    if (pattern.test(text)) return type;
  }
  return 'unknown';
}

function sha256(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function parseDifficulty(text: string): CodingProblem['difficulty'] {
  const lower = text.toLowerCase();
  if (/\beasy\b/.test(lower)) return 'easy';
  if (/\bmedium\b/.test(lower)) return 'medium';
  if (/\bhard\b/.test(lower)) return 'hard';
  return 'unknown';
}

function extractExamples(text: string): CodingExample[] {
  const examples: CodingExample[] = [];
  const exampleBlocks = text.match(/Example\s*\d*\s*:?([\s\S]*?)(?=Example\s*\d*\s*:|Constraints?:|Note:|$)/gi);
  if (!exampleBlocks) return examples;

  for (const block of exampleBlocks.slice(0, 5)) {
    const inputMatch = block.match(/Input\s*:\s*([^\n]+)/i);
    const outputMatch = block.match(/Output\s*:\s*([^\n]+)/i);
    const explanationMatch = block.match(/Explanation\s*:\s*([^\n]+)/i);
    if (inputMatch && outputMatch) {
      examples.push({
        input: inputMatch[1].trim(),
        output: outputMatch[1].trim(),
        explanation: explanationMatch?.[1]?.trim(),
      });
    }
  }
  return examples;
}

function extractConstraints(text: string): string[] {
  const match = text.match(/Constraints?\s*:?([\s\S]*?)(?=Follow-up|Note:|$)/i);
  if (!match) return [];
  return match[1]
    .split('\n')
    .map((l) => l.replace(/^[-•*]\s*/, '').trim())
    .filter((l) => l.length > 3 && l.length < 200)
    .slice(0, 10);
}

function extractTitle(text: string): string {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const firstLine = lines[0] ?? '';
  if (firstLine.length > 5 && firstLine.length < 100 && !/^example/i.test(firstLine)) {
    return firstLine;
  }
  return 'Untitled Problem';
}

function buildFromOcr(rawOcr: string): CodingProblem {
  const problemStatement = rawOcr.slice(0, 4000);
  return {
    schemaVersion: CODING_PROBLEM_SCHEMA_VERSION,
    title: extractTitle(rawOcr),
    difficulty: parseDifficulty(rawOcr),
    problemStatement,
    examples: extractExamples(rawOcr),
    constraints: extractConstraints(rawOcr),
    problemType: classifyProblemType(rawOcr),
    rawOcr,
    extractedAt: Date.now(),
    extraction_partial: true,
  };
}

function mergeWithVision(ocr: CodingProblem, vision: Partial<CodingProblem>): CodingProblem {
  return {
    ...ocr,
    title: vision.title || ocr.title,
    difficulty: vision.difficulty !== 'unknown' ? vision.difficulty ?? ocr.difficulty : ocr.difficulty,
    problemStatement: vision.problemStatement || ocr.problemStatement,
    examples: vision.examples?.length ? vision.examples : ocr.examples,
    constraints: vision.constraints?.length ? vision.constraints : ocr.constraints,
    problemType: vision.problemType !== 'unknown' ? vision.problemType ?? ocr.problemType : ocr.problemType,
    inputSpec: vision.inputSpec || ocr.inputSpec,
    outputSpec: vision.outputSpec || ocr.outputSpec,
    extraction_partial: false,
  };
}

/** Minimal structural check: must have a non-trivial problem statement and at least one example. */
export function isCodingProblemComplete(p: CodingProblem): boolean {
  return p.problemStatement.length >= 30 && p.examples.length >= 1;
}

/**
 * Looser gate for partial extractions: returns true when raw OCR is
 * present and looks like a coding-problem screenshot (contains coding /
 * algorithm keywords, an example block, or constraint markers). Used
 * by `ProcessingHelper.processScreenshots` to decide whether to push a
 * partial extraction into SessionTracker for the conscious-mode coding
 * path on text-only models. Conservative — false-negative > false-positive
 * because injecting non-coding context into the A/B/C/D contract would
 * derail the answer.
 */
export function hasPartialCodingSignal(p: CodingProblem): boolean {
  if (!p.rawOcr || p.rawOcr.length < 30) return false;
  if (p.examples.length >= 1) return true;
  if (p.constraints.length >= 1) return true;
  const text = p.rawOcr.toLowerCase();
  const keywordHits = [
    'example', 'input:', 'output:', 'constraint', 'leetcode',
    'function ', 'class solution', 'def ', 'return',
    'algorithm', 'time complexity', 'space complexity',
    '[]', '{}', '=>', '->'
  ].filter((kw) => text.includes(kw)).length;
  return keywordHits >= 2;
}

/** Parse vision LLM output into a partial CodingProblem. Never throws. */
function parseVisionOutput(raw: string): Partial<CodingProblem> | null {
  try {
    const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const jsonStr = fence ? fence[1].trim() : raw.trim();
    const first = jsonStr.indexOf('{');
    const last = jsonStr.lastIndexOf('}');
    if (first === -1) return null;
    return JSON.parse(jsonStr.slice(first, last + 1)) as Partial<CodingProblem>;
  } catch {
    return null;
  }
}

const VISION_EXTRACT_PROMPT = `Extract the coding problem from the screenshot as JSON with these fields:
{
  "title": string,
  "difficulty": "easy"|"medium"|"hard"|"unknown",
  "problemStatement": string (full verbatim problem text),
  "examples": [{"input":string,"output":string,"explanation":string}],
  "constraints": [string],
  "problemType": one of: arrays|strings|linked_list|trees|graphs|dynamic_programming|backtracking|binary_search|heap_priority_queue|hash_map|two_pointers|sliding_window|stack_queue|greedy|design|system_design|unknown,
  "inputSpec": string,
  "outputSpec": string
}
Return ONLY the JSON. No markdown, no explanation.`;

/** In-memory SHA-256 cache (process lifetime only) */
const extractionCache = new Map<string, CodingProblem>();

export type ProblemExtractorOptions = {
  /** Optional vision-capable LLM call. Receives image paths + prompt, returns raw JSON string. */
  visionCall?: (imagePaths: string[], prompt: string, signal?: AbortSignal) => Promise<string>;
  signal?: AbortSignal;
};

export async function extractCodingProblem(
  imagePaths: string[],
  opts: ProblemExtractorOptions = {},
): Promise<CodingProblem> {
  const validPaths = imagePaths.filter((p) => p && fs.existsSync(p));
  if (validPaths.length === 0) {
    return {
      schemaVersion: CODING_PROBLEM_SCHEMA_VERSION,
      title: 'No image',
      difficulty: 'unknown',
      problemStatement: '',
      examples: [],
      constraints: [],
      problemType: 'unknown',
      extractedAt: Date.now(),
      extraction_partial: true,
    };
  }

  const ocrText = await runTesseract(validPaths, opts.signal);
  const ocrProblem = buildFromOcr(ocrText);

  const cacheKey = sha256(ocrProblem.problemStatement.slice(0, 500));
  const cached = extractionCache.get(cacheKey);
  if (cached) return cached;

  let result = ocrProblem;

  if (opts.visionCall) {
    try {
      const visionRaw = await opts.visionCall(validPaths, VISION_EXTRACT_PROMPT, opts.signal);
      const visionPartial = parseVisionOutput(visionRaw);
      if (visionPartial && visionPartial.problemStatement) {
        result = mergeWithVision(ocrProblem, visionPartial);
      }
    } catch (err) {
      console.warn('[ProblemExtractor] Vision call failed, using OCR only:', err);
    }
  }

  extractionCache.set(cacheKey, result);
  return result;
}

/**
 * Lazily-initialised OCR cascade shared across coding-problem extractions
 * within the lifetime of the process. Building it is cheap (no work happens
 * until the first `recognize()` call) but keeping a single instance lets
 * the per-provider availability cache survive between extractions.
 */
let cachedOcrService: OcrService | null = null;
function getOcrServiceLazily(): OcrService {
  if (!cachedOcrService) {
    cachedOcrService = createOcrService();
  }
  return cachedOcrService;
}

/**
 * Extract text from `imagePaths` for the coding-problem extraction
 * pipeline. Despite the legacy name, this no longer goes straight to
 * Tesseract — it walks the OcrService cascade (Apple Vision on macOS,
 * Windows OCR on Windows, then Tesseract.js as the universal fallback).
 *
 * Tesseract is invoked as a per-image last-resort if the cascade returns
 * empty text for that image, so even on a machine where the native
 * provider misfires we never silently lose OCR coverage.
 */
async function runTesseract(imagePaths: string[], signal?: AbortSignal): Promise<string> {
  const chunks: string[] = [];
  const ocr = getOcrServiceLazily();

  for (let i = 0; i < imagePaths.length; i++) {
    if (signal?.aborted) break;

    let extracted = '';
    try {
      const result = await ocr.recognize(imagePaths[i]);
      extracted = result.text.trim();
    } catch (err) {
      console.warn('[ProblemExtractor] OCR cascade failed:', err);
    }

    if (!extracted) {
      // Hard fallback to direct Tesseract.js so behaviour matches the
      // pre-cascade extractor on any pathological image.
      try {
        const result = await Tesseract.recognize(imagePaths[i], 'eng');
        extracted = (result?.data?.text ?? '').trim();
      } catch {
        // Best effort — leave extracted empty.
      }
    }

    if (extracted) chunks.push(extracted);
  }
  return chunks.join('\n\n');
}
