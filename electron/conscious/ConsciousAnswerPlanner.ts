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
        deliveryStyle: 'conversational_first_person',
        groundingHint: 'Say it like you\'re actually in the room. Use everyday words, not jargon.',
      };

      switch (questionMode) {
        case 'live_coding':
          return {
            ...modeAdjusted,
            focalFacets: uniqueFacets([...modeAdjusted.focalFacets, 'implementationPlan', 'codeTransition']),
            maxWords: Math.min(modeAdjusted.maxWords, 50),
            deliveryFormat: 'code_first_or_short_steps',
            deliveryStyle: 'compact_technical',
            groundingHint: 'Keep it short. Show the code, explain briefly. Don\'t narrate every line.',
            rationale: `${modeAdjusted.rationale} Live-coding — code-first, stay compact, no lectures.`,
          };
        case 'system_design':
          return {
            ...modeAdjusted,
            focalFacets: uniqueFacets([...modeAdjusted.focalFacets, 'tradeoffs', 'scaleConsiderations']),
            maxWords: Math.min(modeAdjusted.maxWords, 80),
            deliveryFormat: 'architecture_then_tradeoffs',
            deliveryStyle: 'conversational_architect',
            groundingHint: 'Speak like you\'re whiteboarding with a colleague. One or two key tradeoffs, not a slide deck.',
            rationale: `${modeAdjusted.rationale} System design — cover architecture then tradeoffs, but stay conversational.`,
          };
        case 'behavioral':
          return {
            ...modeAdjusted,
            answerShape: modeAdjusted.answerShape === 'direct_answer' ? 'example_answer' : modeAdjusted.answerShape,
            focalFacets: uniqueFacets([...modeAdjusted.focalFacets, 'behavioralAnswer']),
            maxWords: Math.min(modeAdjusted.maxWords, 200),
            deliveryFormat: 'full_star_narrative',
            deliveryStyle: 'first_person_professional',
            groundingHint: 'Ground in real experience from transcript or profile. One story, own it with "I". Don\'t invent.',
            rationale: `${modeAdjusted.rationale} Behavioral — one concrete story, 1.5–2 minutes spoken, STAR structure.`,
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
          maxWords: 70,
          confidence: 0.92,
          rationale: 'They\'re asking about tradeoffs. Pick one approach, defend it, mention one real tradeoff. Don\'t list five options.',
        });
      case 'metric_probe':
        return buildPlan({
          answerShape: 'metric_backed_answer',
          focalFacets: focalFacets.length ? focalFacets : ['metrics', 'scaleConsiderations'],
          maxWords: 70,
          confidence: 0.92,
          rationale: 'How would you measure success? Give specifics if you can, don\'t handwave.',
        });
      case 'example_request':
        return buildPlan({
          answerShape: 'example_answer',
          focalFacets,
          maxWords: 80,
          confidence: 0.9,
          rationale: 'They want a concrete example. Tell one story, own it. Don\'t give a menu of options.',
        });
      case 'clarification':
        return buildPlan({
          answerShape: 'clarification_answer',
          focalFacets,
          maxWords: 60,
          confidence: 0.86,
          rationale: 'They want the previous idea unpacked. Keep it short, answer what they actually asked.',
        });
      case 'challenge':
        return buildPlan({
          answerShape: 'pushback_defense',
          focalFacets: focalFacets.length ? focalFacets : ['pushbackResponses'],
          maxWords: 70,
          confidence: 0.88,
          rationale: 'Pushback. Stand your ground, explain your reasoning, don\'t flip-flop.',
        });
      case 'deep_dive':
        return buildPlan({
          answerShape: 'depth_extension',
          focalFacets: focalFacets.length ? focalFacets : ['implementationPlan', 'edgeCases'],
          maxWords: 80,
          confidence: 0.86,
          rationale: 'Going deeper on the same thread. Don\'t start a new topic.',
        });
      default:
        return buildPlan({
          answerShape: 'direct_answer',
          focalFacets,
          maxWords: 65,
          confidence: input.hypothesis?.confidence ?? 0.6,
          rationale: 'Just answer directly. Short and conversational.',
        });
    }
  }

  buildContextBlock(plan: ConsciousAnswerPlan): string {
    const shapeGuide = this.describeShape(plan.answerShape);
    const modeGuide = this.describeMode(plan.questionMode);
    const facetsGuide = plan.focalFacets.length
      ? `Focus on: ${plan.focalFacets.join(', ')}.`
      : '';
    const styleGuide = this.describeStyle(plan.deliveryStyle);

    return [
      '<conscious_answer_plan>',
      `How to answer: ${shapeGuide}`,
      plan.questionMode !== 'general' ? `Question type: ${modeGuide}` : '',
      facetsGuide,
      `Speak like: ${styleGuide}`,
      `Stay grounded: ${plan.groundingHint}`,
      `Keep it under ${plan.maxWords} words. Less is more.`,
      `Why this approach: ${plan.rationale}`,
      '</conscious_answer_plan>',
    ].filter(Boolean).join('\n');
  }

  private describeShape(shape: ConsciousAnswerShape): string {
    switch (shape) {
      case 'direct_answer': return 'Answer straight, no fluff.';
      case 'tradeoff_defense': return 'Pick one approach, explain one real tradeoff. Don\'t list five options.';
      case 'metric_backed_answer': return 'Give specifics with numbers if you have them. No vague claims.';
      case 'example_answer': return 'Tell one concrete story. Not a list of examples.';
      case 'clarification_answer': return 'Clarify what they\'re really asking, then answer that specific thing.';
      case 'depth_extension': return 'Go deeper on the same thread. Don\'t start a new topic.';
      case 'pushback_defense': return 'Stand your ground respectfully. Explain why you chose this, don\'t just switch.';
      default: return 'Answer directly and keep it short.';
    }
  }

  private describeMode(mode: ConsciousAnswerPlan['questionMode']): string {
    switch (mode) {
      case 'live_coding': return 'Live coding — give code first, explain after. Stay compact.';
      case 'system_design': return 'System design — talk through your thinking like you\'re whiteboarding with a friend.';
      case 'behavioral': return 'Behavioral — tell one real story, own your work, don\'t just list achievements.';
      default: return '';
    }
  }

  private describeStyle(style: string): string {
    switch (style) {
      case 'compact_technical': return 'Short, technical, code-first. Like talking to a teammate at your desk.';
      case 'conversational_architect': return 'Think out loud. Like explaining to a colleague over coffee, not presenting slides.';
      case 'conversational_first_person': return 'Natural first-person. Like you\'re actually in the room talking.';
      case 'first_person_professional': return 'Professional but human. Own your work with "I", not "we".';
      default: return 'Natural first-person conversation.';
    }
  }
}
