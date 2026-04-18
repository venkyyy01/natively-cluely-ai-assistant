export type ConsciousResponseQuestionMode = 'general' | 'live_coding' | 'system_design' | 'behavioral';

export type ConsciousResponsePreferenceFlag =
  | 'first_person'
  | 'conversational'
  | 'concise'
  | 'indian_english'
  | 'plain_language'
  | 'avoid_robotic'
  | 'follow_framework';

export interface PersistedConsciousResponseDirective {
  rawText: string;
  normalizedText: string;
  appliesTo: ConsciousResponseQuestionMode[];
  priority: 'hard' | 'soft';
  flags: ConsciousResponsePreferenceFlag[];
  createdAt: number;
  updatedAt: number;
}

export interface PersistedConsciousResponsePreferenceState {
  directives: PersistedConsciousResponseDirective[];
}

export interface ConsciousPlannerPreferenceSummary {
  preferFirstPerson: boolean;
  preferConversational: boolean;
  preferConcise: boolean;
  preferIndianEnglish: boolean;
  preferPlainLanguage: boolean;
  avoidRoboticTone: boolean;
  relevantFrameworkHints: string[];
  hardPreferenceCount: number;
}

const MAX_DIRECTIVES = 8;

const TARGET_HINT_PATTERN = /(answer|answers|response|responses|voice|tone|sound|framework|format|structure|english|jargon|robotic|slide\s*show|slides|star)/i;
const DIRECTIVE_CUE_PATTERN = /(need|want|keep|make|use|follow|sound|speak|talk|say|answer|be|avoid|don't|do not|should|must)/i;
const FIRST_PERSON_PATTERN = /(first person|use\s+["']?i["']?|say\s+["']?i["']?|own it with\s+["']?i["']?)/i;
const CONVERSATIONAL_PATTERN = /(conversational|conversation|human|natural|talk like|sound like a person)/i;
const CONCISE_PATTERN = /(concise|short|brief|crisp|to the point)/i;
const INDIAN_ENGLISH_PATTERN = /indian english/i;
const PLAIN_LANGUAGE_PATTERN = /(no jargon|avoid jargon|simple words|plain english|plain language|no fancy words|avoid big words)/i;
const AVOID_ROBOTIC_PATTERN = /(robotic|ai|scripted|slide\s*show|slides|corporate)/i;
const FRAMEWORK_PATTERN = /(framework|format|structure|star|situation\b.*task\b.*action\b.*result|use this structure|follow this structure|follow this framework)/i;
const BEHAVIORAL_SCOPE_PATTERN = /(behavioral|story|star|situation|task|action|result|learning|tell me about a time|leadership|conflict)/i;
const SYSTEM_DESIGN_SCOPE_PATTERN = /(system design|architecture|design round|high level design|distributed|scal(?:e|ing))/i;
const LIVE_CODING_SCOPE_PATTERN = /(live coding|live-coding|coding round|write code|implement|function|leetcode|algorithm)/i;

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}

function hasPreferenceSignal(text: string): boolean {
  return TARGET_HINT_PATTERN.test(text) && (DIRECTIVE_CUE_PATTERN.test(text) || FRAMEWORK_PATTERN.test(text));
}

function collectFlags(text: string): ConsciousResponsePreferenceFlag[] {
  const flags: ConsciousResponsePreferenceFlag[] = [];
  if (FIRST_PERSON_PATTERN.test(text)) flags.push('first_person');
  if (CONVERSATIONAL_PATTERN.test(text)) flags.push('conversational');
  if (CONCISE_PATTERN.test(text)) flags.push('concise');
  if (INDIAN_ENGLISH_PATTERN.test(text)) flags.push('indian_english');
  if (PLAIN_LANGUAGE_PATTERN.test(text)) flags.push('plain_language');
  if (AVOID_ROBOTIC_PATTERN.test(text)) flags.push('avoid_robotic');
  if (FRAMEWORK_PATTERN.test(text)) flags.push('follow_framework');
  return unique(flags);
}

function resolveScope(text: string, flags: ConsciousResponsePreferenceFlag[]): ConsciousResponseQuestionMode[] {
  const appliesTo = new Set<ConsciousResponseQuestionMode>();

  if (LIVE_CODING_SCOPE_PATTERN.test(text)) appliesTo.add('live_coding');
  if (BEHAVIORAL_SCOPE_PATTERN.test(text)) appliesTo.add('behavioral');
  if (SYSTEM_DESIGN_SCOPE_PATTERN.test(text)) appliesTo.add('system_design');

  if (appliesTo.size > 0) {
    return Array.from(appliesTo);
  }

  if (flags.includes('follow_framework')) {
    return ['general', 'behavioral', 'system_design'];
  }

  return ['general', 'behavioral', 'system_design', 'live_coding'];
}

function resolvePriority(text: string): 'hard' | 'soft' {
  return /(must|need|follow|use|keep|avoid|don't|do not|only|exactly)/i.test(text) ? 'hard' : 'soft';
}

function summarizeVoice(summary: ConsciousPlannerPreferenceSummary): string {
  const parts: string[] = [];
  if (summary.preferFirstPerson) parts.push('First person.');
  if (summary.preferConversational) parts.push('Conversational and human.');
  if (summary.preferIndianEnglish) parts.push('Natural Indian English.');
  if (summary.preferConcise) parts.push('Keep it concise.');
  if (summary.preferPlainLanguage) parts.push('Use simple words and avoid jargon.');
  if (summary.avoidRoboticTone) parts.push('No robotic or slide-deck phrasing.');
  return parts.join(' ');
}

export class ConsciousResponsePreferenceStore {
  private directives: PersistedConsciousResponseDirective[] = [];

  noteUserTranscript(text: string, timestamp: number): boolean {
    const rawText = text.trim().replace(/\s+/g, ' ');
    if (!rawText || !hasPreferenceSignal(rawText)) {
      return false;
    }

    const flags = collectFlags(rawText);
    if (flags.length === 0) {
      return false;
    }

    const normalizedText = normalizeText(rawText);
    const directive: PersistedConsciousResponseDirective = {
      rawText,
      normalizedText,
      appliesTo: resolveScope(rawText, flags),
      priority: resolvePriority(rawText),
      flags,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    const existingIndex = this.directives.findIndex((entry) => entry.normalizedText === normalizedText);
    if (existingIndex >= 0) {
      const existing = this.directives[existingIndex];
      this.directives[existingIndex] = {
        ...existing,
        rawText,
        appliesTo: unique([...existing.appliesTo, ...directive.appliesTo]),
        priority: existing.priority === 'hard' || directive.priority === 'hard' ? 'hard' : 'soft',
        flags: unique([...existing.flags, ...directive.flags]),
        updatedAt: timestamp,
      };
    } else {
      this.directives.push(directive);
    }

    this.directives = this.directives
      .sort((left, right) => left.updatedAt - right.updatedAt)
      .slice(-MAX_DIRECTIVES);

    return true;
  }

  getPlannerPreferenceSummary(questionMode: ConsciousResponseQuestionMode): ConsciousPlannerPreferenceSummary {
    const directives = this.getApplicableDirectives(questionMode);
    const flagSet = new Set(directives.flatMap((directive) => directive.flags));
    return {
      preferFirstPerson: flagSet.has('first_person'),
      preferConversational: flagSet.has('conversational'),
      preferConcise: flagSet.has('concise'),
      preferIndianEnglish: flagSet.has('indian_english'),
      preferPlainLanguage: flagSet.has('plain_language'),
      avoidRoboticTone: flagSet.has('avoid_robotic'),
      relevantFrameworkHints: directives
        .filter((directive) => directive.flags.includes('follow_framework'))
        .map((directive) => directive.rawText)
        .slice(-3),
      hardPreferenceCount: directives.filter((directive) => directive.priority === 'hard').length,
    };
  }

  buildContextBlock(questionMode: ConsciousResponseQuestionMode): string {
    const summary = this.getPlannerPreferenceSummary(questionMode);
    const voiceSummary = summarizeVoice(summary);
    if (!voiceSummary && summary.relevantFrameworkHints.length === 0) {
      return '';
    }

    const lines = [
      '<conscious_response_preferences>',
      'These are saved user instructions for conscious mode. Follow them when they fit this question.',
    ];

    if (voiceSummary) {
      lines.push(`VOICE: ${voiceSummary}`);
    }

    if (summary.relevantFrameworkHints.length > 0) {
      lines.push('STRUCTURE_HINTS:');
      for (const hint of summary.relevantFrameworkHints) {
        lines.push(`- ${hint}`);
      }
    }

    lines.push('</conscious_response_preferences>');
    return lines.join('\n');
  }

  getPersistenceSnapshot(): PersistedConsciousResponsePreferenceState {
    return {
      directives: this.directives.map((directive) => ({ ...directive })),
    };
  }

  restorePersistenceSnapshot(snapshot: PersistedConsciousResponsePreferenceState | null | undefined): void {
    this.directives = (snapshot?.directives || []).map((directive) => ({
      ...directive,
      appliesTo: unique((directive.appliesTo || []).filter(Boolean)) as ConsciousResponseQuestionMode[],
      flags: unique((directive.flags || []).filter(Boolean)) as ConsciousResponsePreferenceFlag[],
    }));
  }

  reset(): void {
    this.directives = [];
  }

  private getApplicableDirectives(questionMode: ConsciousResponseQuestionMode): PersistedConsciousResponseDirective[] {
    return this.directives.filter((directive) => directive.appliesTo.includes(questionMode));
  }
}
