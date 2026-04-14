import type { LLMHelper } from '../LLMHelper';
import type { HoverCapture } from './HoverModeManager';
import type { HoverAnalysisResult, QuestionType } from './HoverQuestionClassifier';

const ALLOWED_LANGUAGES = ['python', 'javascript', 'typescript', 'java', 'cpp', 'go', 'rust', 'c', 'csharp', 'ruby', 'php', 'swift', 'kotlin', 'scala'] as const;
type AllowedLanguage = typeof ALLOWED_LANGUAGES[number];

export interface HoverResponse {
  type: 'code' | 'mcq' | 'subjective';
  content: string;
  language?: string;
  optionLabel?: string;
  justification?: string;
}

interface ImageAnalysisResult {
  text: string;
  timestamp: number;
}

const CODE_RESPONSE_PROMPT = `You are an expert programmer. Analyze the coding question in this image and provide a complete, working solution.

Rules:
1. If a programming language is identifiable (syntax highlighting, file extension, language label), use that language
2. If no language is identifiable, default to Python
3. Return ONLY the runnable code - no explanations unless the question specifically asks for one
4. The code must be complete and ready to run
5. Include necessary imports
6. Handle edge cases properly

Return the solution code only.`;

const MCQ_RESPONSE_PROMPT = `You are an expert test-taker. Analyze the multiple choice question in this image and determine the correct answer.

Rules:
1. Carefully read the question and all options
2. Identify the correct option based on your knowledge
3. Return a JSON object with:
- "optionLabel": the letter (A, B, C, D) or number of the correct option
- "justification": ONE sentence explaining why this is correct

Return ONLY valid JSON, no other text.`;

const SUBJECTIVE_RESPONSE_PROMPT = `You are an expert academic assistant. Analyze the question in this image and provide a concise, direct answer.

Rules:
1. Identify the question type (explanation, discussion, analysis, etc.)
2. Provide a clear, well-structured answer appropriate for the question type
3. Be concise - aim for 2-4 sentences unless the question demands more
4. Be accurate and factual
5. If it's an essay prompt, provide key points and a brief outline

Return the answer directly, no formatting markers.`;

export class HoverLLMResponder {
  private llmHelper: LLMHelper;

  constructor(llmHelper: LLMHelper) {
    this.llmHelper = llmHelper;
  }

  private validateLanguage(language: string | undefined): AllowedLanguage {
    if (!language) return 'python';
    const normalized = language.toLowerCase();
    if (ALLOWED_LANGUAGES.includes(normalized as AllowedLanguage)) {
      return normalized as AllowedLanguage;
    }
    return 'python';
  }

  private validateMcqResponse(parsed: unknown): { optionLabel: string; justification?: string } | null {
    if (!parsed || typeof parsed !== 'object') return null;
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.optionLabel !== 'string' || obj.optionLabel.length === 0) return null;
    if (!/^[A-Za-z]|[1-9]$/.test(obj.optionLabel)) return null;
    return {
      optionLabel: obj.optionLabel.toUpperCase(),
      justification: typeof obj.justification === 'string' ? obj.justification.slice(0, 500) : undefined,
    };
  }

  public async generateResponse(
    capture: HoverCapture,
    analysis: HoverAnalysisResult
  ): Promise<HoverResponse> {
    switch (analysis.questionType) {
      case 'coding':
        return this.generateCodeResponse(capture, analysis);
      case 'mcq':
        return this.generateMcqResponse(capture, analysis);
      case 'subjective':
        return this.generateSubjectiveResponse(capture, analysis);
      default:
        return this.generateUnknownResponse(capture);
    }
  }

  private async generateCodeResponse(
    capture: HoverCapture,
    analysis: HoverAnalysisResult
  ): Promise<HoverResponse> {
    const safeLanguage = this.validateLanguage(analysis.detectedLanguage);
    const prompt = analysis.detectedLanguage
      ? `${CODE_RESPONSE_PROMPT}\n\nDetected language: ${safeLanguage}. Use this language.`
      : `${CODE_RESPONSE_PROMPT}\n\nNo language detected. Use Python as default.`;

    try {
      const result: ImageAnalysisResult = await this.llmHelper.analyzeImageFiles([capture.path]);
      const response = result.text;

      return {
        type: 'code',
        content: response || 'Unable to generate solution',
        language: safeLanguage,
      };
    } catch (error) {
      console.error('[HoverLLMResponder] Code response generation failed:', error);
      return {
        type: 'code',
        content: '// Error generating solution',
        language: safeLanguage,
      };
    }
  }

  private async generateMcqResponse(
    capture: HoverCapture,
    _analysis: HoverAnalysisResult
  ): Promise<HoverResponse> {
    try {
      const result: ImageAnalysisResult = await this.llmHelper.analyzeImageFiles([capture.path]);
      const response = result.text;

      if (!response) {
        return this.getDefaultMcqResponse();
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(response);
      } catch {
        console.error('[HoverLLMResponder] MCQ JSON parse failed');
        return this.getDefaultMcqResponse();
      }

      const validated = this.validateMcqResponse(parsed);
      if (!validated) {
        console.error('[HoverLLMResponder] MCQ response validation failed');
        return this.getDefaultMcqResponse();
      }

      return {
        type: 'mcq',
        content: `The correct answer is ${validated.optionLabel}.`,
        optionLabel: validated.optionLabel,
        justification: validated.justification,
      };
    } catch (error) {
      console.error('[HoverLLMResponder] MCQ response generation failed:', error);
      return this.getDefaultMcqResponse();
    }
  }

  private getDefaultMcqResponse(): HoverResponse {
    return {
      type: 'mcq',
      content: 'Unable to determine answer',
    };
  }

  private async generateSubjectiveResponse(
    capture: HoverCapture,
    _analysis: HoverAnalysisResult
  ): Promise<HoverResponse> {
    try {
      const result: ImageAnalysisResult = await this.llmHelper.analyzeImageFiles([capture.path]);
      const response = result.text;

      return {
        type: 'subjective',
        content: response || 'Unable to generate answer',
      };
    } catch (error) {
      console.error('[HoverLLMResponder] Subjective response generation failed:', error);
      return {
        type: 'subjective',
        content: 'Error generating answer',
      };
    }
  }

  private async generateUnknownResponse(capture: HoverCapture): Promise<HoverResponse> {
    const fallbackPrompt = `Analyze this image and provide a helpful response to any visible question or content. If there's no clear question, describe what you see briefly.`;

    try {
      const result: ImageAnalysisResult = await this.llmHelper.analyzeImageFiles([capture.path]);
      const response = result.text;

      return {
        type: 'subjective',
        content: response || 'No content detected',
      };
    } catch (error) {
      console.error('[HoverLLMResponder] Unknown response generation failed:', error);
      return {
        type: 'subjective',
        content: 'Unable to analyze',
      };
    }
  }
}

export default HoverLLMResponder;
