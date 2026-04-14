import type { LLMHelper } from '../LLMHelper';
import type { HoverCapture } from './HoverModeManager';

export type QuestionType = 'coding' | 'mcq' | 'subjective' | 'unknown';

export interface ClassifiedQuestion {
  type: QuestionType;
  detectedLanguage?: string;
  questionText?: string;
  options?: string[];
}

export interface HoverAnalysisResult {
  questionType: QuestionType;
  detectedLanguage?: string;
  questionText?: string;
  options?: string[];
  confidence: number;
}

const CLASSIFICATION_PROMPT = `Analyze this screenshot and classify the visible content:

1. Is there a coding/programming question visible?
   - Look for: syntax highlighting, code blocks, file extensions, IDE chrome, language labels
   - If yes, identify the programming language

2. Is there a multiple choice question (MCQ)?
   - Look for: options labeled A, B, C, D or numbered choices
   - Extract the question text and options

3. Is there a subjective/open-ended question?
   - Look for: essay prompts, discussion questions, explanation requests

Return a JSON object with this structure:
{
  "questionType": "coding" | "mcq" | "subjective" | "unknown",
  "detectedLanguage": "python" | "javascript" | "java" | "cpp" | "go" | "rust" | "typescript" | null,
  "questionText": "the full question text if visible",
  "options": ["A: ...", "B: ..."] for MCQs,
  "confidence": 0.0-1.0
}

Only return valid JSON, no other text.`;

interface ImageAnalysisResult {
  text: string;
  timestamp: number;
}

const CODE_LANGUAGE_INDICATORS: Record<string, RegExp[]> = {
  python: [/\.py\b/i, /python/i, /def\s+\w+\s*\(/, /import\s+\w+/, /from\s+\w+\s+import/],
  javascript: [/\.js\b/i, /\.mjs\b/i, /javascript/i, /const\s+\w+\s*=/, /let\s+\w+\s*=/, /function\s*\w*\s*\(/, /=>\s*{/],
  typescript: [/\.ts\b/i, /\.tsx\b/i, /typescript/i, /interface\s+\w+/, /type\s+\w+\s*=/, /:\s*\w+\s*[;,=)]/],
  java: [/\.java\b/i, /\bjava\b/i, /public\s+class/, /private\s+\w+/, /System\.out\.print/],
  cpp: [/\.cpp\b/i, /\.c\b/i, /\.h\b/i, /\bcpp\b/i, /#include\s*</, /std::/, /cout\s*<</],
  go: [/\.go\b/i, /\bgo\b/i, /func\s+\w+\s*\(/, /package\s+\w+/, /import\s*\(/, /fmt\./],
  rust: [/\.rs\b/i, /\brust\b/i, /fn\s+\w+\s*\(/, /let\s+mut/, /impl\s+\w+/, /pub\s+fn/],
};

const MCQ_PATTERNS = [
  /\b[A-D]\)\s*[^\n]+/g,
  /\b[1-4]\.\s*[^\n]+/g,
  /\boption\s*[A-D]\b/i,
  /\bchoice\s*[A-D]\b/i,
];

const SUBJECTIVE_PATTERNS = [
  /\bexplain\b/i,
  /\bdescribe\b/i,
  /\bdiscuss\b/i,
  /\bcompare\b/i,
  /\banalyze\b/i,
  /\bwhy\b.*\?/i,
  /\bhow\b.*\?/i,
  /\bwhat\b.*\?/i,
  /essay/i,
  /short answer/i,
  /free response/i,
];

export class HoverQuestionClassifier {
  private llmHelper: LLMHelper;

  constructor(llmHelper: LLMHelper) {
    this.llmHelper = llmHelper;
  }

  public async classify(capture: HoverCapture): Promise<HoverAnalysisResult> {
    const visualAnalysis = await this.analyzeWithLLM(capture.path);
    
    if (visualAnalysis && visualAnalysis.questionType !== 'unknown') {
      return visualAnalysis;
    }

    return this.fallbackClassification();
  }

  private async analyzeWithLLM(imagePath: string): Promise<HoverAnalysisResult | null> {
    try {
      const result: ImageAnalysisResult = await this.llmHelper.analyzeImageFiles([imagePath]);
      const response = result.text;

      if (!response) return null;

      const parsed = JSON.parse(response);
      return {
        questionType: this.validateQuestionType(parsed.questionType),
        detectedLanguage: parsed.detectedLanguage || undefined,
        questionText: parsed.questionText || undefined,
        options: Array.isArray(parsed.options) ? parsed.options : undefined,
        confidence: Math.max(0, Math.min(1, parsed.confidence || 0.5)),
      };
    } catch (error) {
      console.error('[HoverQuestionClassifier] LLM analysis failed:', error);
      return null;
    }
  }

  private fallbackClassification(): HoverAnalysisResult {
    return {
      questionType: 'unknown',
      confidence: 0,
    };
  }

  private validateQuestionType(type: unknown): QuestionType {
    if (type === 'coding' || type === 'mcq' || type === 'subjective' || type === 'unknown') {
      return type;
    }
    return 'unknown';
  }

  public detectLanguageFromText(text: string): string | undefined {
    const lowerText = text.toLowerCase();

    for (const [language, patterns] of Object.entries(CODE_LANGUAGE_INDICATORS)) {
      for (const pattern of patterns) {
        if (pattern.test(lowerText)) {
          return language;
        }
      }
    }

    return undefined;
  }

  public hasMCQIndicators(text: string): boolean {
    for (const pattern of MCQ_PATTERNS) {
      if (pattern.test(text)) {
        return true;
      }
    }
    return false;
  }

  public hasSubjectiveIndicators(text: string): boolean {
    for (const pattern of SUBJECTIVE_PATTERNS) {
      if (pattern.test(text)) {
        return true;
      }
    }
    return false;
  }
}

export default HoverQuestionClassifier;
