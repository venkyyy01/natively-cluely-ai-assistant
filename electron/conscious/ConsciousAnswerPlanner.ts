import type { AnswerHypothesis } from './AnswerHypothesisStore';
import type { QuestionReaction } from './QuestionReactionClassifier';

export type ConsciousAnswerShape =
  | 'direct_answer'
  | 'tradeoff_defense'
  | 'metric_backed_answer'
  | 'example_answer'
  | 'clarification_answer'
  | 'depth_extension'
  | 'pushback_defense';

export interface ConsciousAnswerPlan {
  answerShape: ConsciousAnswerShape;
  focalFacets: string[];
  maxWords: number;
  confidence: number;
  questionMode: 'general' | 'live_coding' | 'system_design' | 'behavioral';
  deliveryFormat: string;
  deliveryStyle: string;
  groundingHint: string;
  rationale: string;
}

function uniqueFacets(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function isLiveCodingQuestion(question: string): boolean {
  return /(write|implement|debug|fix|refactor|function|typescript|javascript|python|java|sql|query|code|snippet|algorithm|console|output)/i.test(question);
}

function isBehavioralQuestion(question: string): boolean {
  return /(tell me about a time|describe a situation|how do you handle|leadership|conflict|disagreement|feedback|failure|mistake|team|mentor|stakeholder|culture|values)/i.test(question);
}

function isSystemDesignQuestion(question: string): boolean {
  return /(design|architecture|distributed|cache|queue|throughput|latency|database|api|microservice|scal(?:e|ing)|rate limiter|failover|partition)/i.test(question);
}

function detectQuestionMode(question: string): ConsciousAnswerPlan['questionMode'] {
  if (isLiveCodingQuestion(question)) {
    return 'live_coding';
  }
  if (isBehavioralQuestion(question)) {
    return 'behavioral';
  }
  if (isSystemDesignQuestion(question)) {
    return 'system_design';
  }
  return 'general';
}

export class ConsciousAnswerPlanner {
  plan(input: {
    question: string;
    reaction?: QuestionReaction | null;
    hypothesis?: AnswerHypothesis | null;
  }): ConsciousAnswerPlan {
    const reaction = input.reaction;
    const focalFacets = reaction?.targetFacets?.length ? reaction.targetFacets : input.hypothesis?.targetFacets || [];
    const questionMode = detectQuestionMode(input.question);
    const buildPlan = (plan: Omit<ConsciousAnswerPlan, 'questionMode' | 'deliveryFormat' | 'deliveryStyle' | 'groundingHint'>): ConsciousAnswerPlan => {
      const modeAdjusted: ConsciousAnswerPlan = {
        ...plan,
        focalFacets: uniqueFacets(plan.focalFacets),
        questionMode,
        deliveryFormat: 'spoken_concise',
        deliveryStyle: 'high_signal_spoken',
        groundingHint: 'Ground every claim in transcript, evidence, or profile context.',
      };

      switch (questionMode) {
        case 'live_coding':
          return {
            ...modeAdjusted,
            focalFacets: uniqueFacets([...modeAdjusted.focalFacets, 'implementationPlan', 'codeTransition']),
            maxWords: Math.min(modeAdjusted.maxWords, 70),
            deliveryFormat: 'code_first_or_short_steps',
            deliveryStyle: 'compact_technical',
            groundingHint: 'Ground the answer in visible code, screenshot details, and the active transcript. Avoid invented APIs or outputs.',
            rationale: `${modeAdjusted.rationale} Live-coding questions should stay code-first and compact.`,
          };
        case 'system_design':
          return {
            ...modeAdjusted,
            focalFacets: uniqueFacets([...modeAdjusted.focalFacets, 'implementationPlan', 'tradeoffs', 'scaleConsiderations']),
            maxWords: Math.min(modeAdjusted.maxWords, 110),
            deliveryFormat: 'architecture_then_tradeoffs',
            deliveryStyle: 'structured_architectural',
            groundingHint: 'Ground the answer in the current system-design nouns, constraints, and prior thread state.',
            rationale: `${modeAdjusted.rationale} System-design answers should cover architecture and tradeoffs before details.`,
          };
        case 'behavioral':
          return {
            ...modeAdjusted,
            answerShape: modeAdjusted.answerShape === 'direct_answer' ? 'example_answer' : modeAdjusted.answerShape,
            focalFacets: uniqueFacets([...modeAdjusted.focalFacets, 'openingReasoning', 'behavioralAnswer']),
            maxWords: Math.min(modeAdjusted.maxWords, 250),
            deliveryFormat: 'full_star_narrative',
            deliveryStyle: 'first_person_professional',
            groundingHint: 'Ground the answer in concrete past experience from transcript or profile. Do not invent stories.',
            rationale: `${modeAdjusted.rationale} Behavioral answers should target 1.5–2.5 minutes spoken with full STAR structure.`,
          };
        default:
          return modeAdjusted;
      }
    };

    switch (reaction?.kind) {
      case 'tradeoff_probe':
        return buildPlan({
          answerShape: 'tradeoff_defense',
          focalFacets,
          maxWords: 110,
          confidence: 0.92,
          rationale: 'Interviewer is explicitly probing tradeoffs; answer should defend one chosen approach with tradeoff clarity.',
        });
      case 'metric_probe':
        return buildPlan({
          answerShape: 'metric_backed_answer',
          focalFacets: focalFacets.length ? focalFacets : ['metrics', 'scaleConsiderations'],
          maxWords: 110,
          confidence: 0.92,
          rationale: 'Interviewer is asking how success or risk would be measured.',
        });
      case 'example_request':
        return buildPlan({
          answerShape: 'example_answer',
          focalFacets,
          maxWords: 120,
          confidence: 0.9,
          rationale: 'Interviewer asked for a concrete example, so the answer should anchor on one scenario.',
        });
      case 'clarification':
        return buildPlan({
          answerShape: 'clarification_answer',
          focalFacets,
          maxWords: 90,
          confidence: 0.86,
          rationale: 'Interviewer wants the previous idea unpacked, not a fresh broad answer.',
        });
      case 'challenge':
        return buildPlan({
          answerShape: 'pushback_defense',
          focalFacets: focalFacets.length ? focalFacets : ['pushbackResponses'],
          maxWords: 110,
          confidence: 0.88,
          rationale: 'Interviewer is challenging the choice and needs a direct defense.',
        });
      case 'deep_dive':
        return buildPlan({
          answerShape: 'depth_extension',
          focalFacets: focalFacets.length ? focalFacets : ['implementationPlan', 'edgeCases'],
          maxWords: 120,
          confidence: 0.86,
          rationale: 'Interviewer is digging deeper into the same thread.',
        });
      default:
        return buildPlan({
          answerShape: 'direct_answer',
          focalFacets,
          maxWords: 95,
          confidence: input.hypothesis?.confidence ?? 0.6,
          rationale: 'No strong reaction signal; answer directly and keep it focused.',
        });
    }
  }

  buildContextBlock(plan: ConsciousAnswerPlan): string {
    return [
      '<conscious_answer_plan>',
      `ANSWER_SHAPE: ${plan.answerShape}`,
      `QUESTION_MODE: ${plan.questionMode}`,
      `FOCAL_FACETS: ${plan.focalFacets.join(', ') || 'none'}`,
      `DELIVERY_FORMAT: ${plan.deliveryFormat}`,
      `DELIVERY_STYLE: ${plan.deliveryStyle}`,
      `GROUNDING_HINT: ${plan.groundingHint}`,
      `MAX_WORDS: ${plan.maxWords}`,
      `PLAN_CONFIDENCE: ${plan.confidence.toFixed(2)}`,
      `RATIONALE: ${plan.rationale}`,
      '</conscious_answer_plan>',
    ].join('\n');
  }
}
