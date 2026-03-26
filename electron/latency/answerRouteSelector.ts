import { classifyConsciousModeQuestion } from '../ConsciousMode';
import { AnswerRoute } from './AnswerLatencyTracker';

function normalizeQuestion(text: string | null | undefined): string {
  return (text || '')
    .toLowerCase()
    .replace(/[.,!?;:()[\]{}"“”]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const PROFILE_PHRASES = [
  'tell me about yourself',
  'walk me through your resume',
  'walk me through your background',
  'tell me about your background',
  'why are you a fit for this role',
  'tell me about a project you worked on',
] as const;

const KNOWLEDGE_DIRECT = [
  'why this company',
  'why do you want to work here',
  'why do you want to join',
  'what do you know about our company',
  'what do you know about us',
  'why this role',
  'why this team',
  'why are you interested in this role',
] as const;

const KNOWLEDGE_QUALIFIERS = ['our company', 'our team', 'this company', 'this team', 'this role'] as const;
const KNOWLEDGE_STEMS = ['why', 'what do you know', 'how would you fit', 'how do you align'] as const;

export interface RouteSelectorInput {
  explicitManual: boolean;
  explicitFollowUp: boolean;
  consciousModeEnabled: boolean;
  profileModeEnabled: boolean;
  hasProfile: boolean;
  hasKnowledgeData: boolean;
  latestQuestion: string | null | undefined;
  activeReasoningThread: any;
}

export function isProfileRequiredQuestion(latestQuestion: string | null | undefined): boolean {
  const normalized = normalizeQuestion(latestQuestion);
  if (!normalized) return false;
  if (PROFILE_PHRASES.some((phrase) => normalized.includes(phrase))) return true;
  return /^what experience do you have with .+ in your previous role$/.test(normalized);
}

export function isKnowledgeRequiredQuestion(latestQuestion: string | null | undefined): boolean {
  const normalized = normalizeQuestion(latestQuestion);
  if (!normalized) return false;
  if (KNOWLEDGE_DIRECT.some((phrase) => normalized.includes(phrase))) return true;
  return KNOWLEDGE_QUALIFIERS.some((q) => normalized.includes(q)) && KNOWLEDGE_STEMS.some((s) => normalized.includes(s));
}

export function selectAnswerRoute(input: RouteSelectorInput): AnswerRoute {
  if (input.explicitManual) return 'manual_answer';
  if (input.explicitFollowUp) return 'follow_up_refinement';

  const resolvedQuestion = input.latestQuestion || '';
  if (input.consciousModeEnabled) {
    const route = classifyConsciousModeQuestion(resolvedQuestion, input.activeReasoningThread);
    if (route.qualifies) return 'conscious_answer';
  }

  if (input.profileModeEnabled && input.hasProfile && isProfileRequiredQuestion(resolvedQuestion)) {
    return 'enriched_standard_answer';
  }

  if (input.hasKnowledgeData && isKnowledgeRequiredQuestion(resolvedQuestion)) {
    return 'enriched_standard_answer';
  }

  return 'fast_standard_answer';
}
