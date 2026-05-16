import type { QuestionReaction } from './QuestionReactionClassifier';
import { isBehavioralQuestionText } from '../ConsciousMode';

export interface ConsciousSemanticFact {
  category: 'project' | 'experience' | 'skill' | 'requirement' | 'company_context' | 'identity';
  title: string;
  text: string;
  tags: string[];
  score?: number;
  /** Inverse document frequency weight — rarer facts score higher when matched. */
  idfWeight?: number;
}

/** Stopwords excluded from scoring to reduce noise. */
const SCORING_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'have', 'your', 'about',
  'would', 'what', 'when', 'where', 'which', 'into', 'while', 'there', 'their',
  'then', 'than', 'been', 'were', 'will', 'could', 'should', 'does', 'did',
  'are', 'how', 'why', 'can', 'you', 'our', 'but', 'not', 'use', 'using',
  'also', 'just', 'like', 'make', 'need', 'want', 'work', 'working',
]);

function tokenize(value: string): string[] {
  return Array.from(new Set(
    value
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((token) => token.length >= 3 && !SCORING_STOPWORDS.has(token))
  ));
}

/**
 * TF-IDF-inspired scoring: tokens that appear in fewer facts are weighted higher.
 * This prevents common terms (e.g. "system", "design") from dominating retrieval
 * and surfaces genuinely relevant facts.
 */
function tfidfScore(tokens: string[], text: string, tags: string[], idfWeights: Map<string, number>): number {
  const haystack = `${text} ${tags.join(' ')}`.toLowerCase();
  let score = 0;
  for (const token of tokens) {
    if (haystack.includes(token)) {
      score += idfWeights.get(token) ?? 1;
    }
  }
  return score;
}

/**
 * Bigram overlap bonus: consecutive token pairs that match get extra weight.
 * This captures phrase-level relevance (e.g. "rate limiter" vs just "rate" + "limiter" separately).
 */
function bigramBonus(tokens: string[], text: string): number {
  if (tokens.length < 2) return 0;
  const lowered = text.toLowerCase();
  let bonus = 0;
  for (let i = 0; i < tokens.length - 1; i++) {
    const bigram = `${tokens[i]} ${tokens[i + 1]}`;
    if (lowered.includes(bigram)) {
      bonus += 1.5;
    }
  }
  return bonus;
}

function isBehavioralQuestion(question: string): boolean {
  return isBehavioralQuestionText(question);
}

function isSystemDesignQuestion(question: string): boolean {
  return /(design|architecture|distributed|cache|queue|throughput|latency|database|api|microservice|scal(?:e|ing)|rate limiter|failover|partition)/i.test(question);
}

function fallbackCategoryPriority(category: ConsciousSemanticFact['category']): number {
  switch (category) {
    case 'experience':
      return 0;
    case 'project':
      return 1;
    case 'identity':
      return 2;
    case 'skill':
      return 3;
    case 'company_context':
      return 4;
    case 'requirement':
      return 5;
    default:
      return 6;
  }
}

/**
 * Category relevance boost based on question type.
 * System design questions boost project/skill facts; behavioral boosts experience.
 */
function categoryRelevanceBoost(category: ConsciousSemanticFact['category'], question: string): number {
  if (isBehavioralQuestion(question)) {
    switch (category) {
      case 'experience': return 2.0;
      case 'project': return 1.5;
      case 'identity': return 1.2;
      default: return 1.0;
    }
  }
  if (isSystemDesignQuestion(question)) {
    switch (category) {
      case 'project': return 1.8;
      case 'skill': return 1.5;
      case 'company_context': return 1.3;
      case 'requirement': return 1.2;
      default: return 1.0;
    }
  }
  return 1.0;
}

export class ConsciousSemanticFactStore {
  private facts: ConsciousSemanticFact[] = [];
  /** IDF weights computed once at seed time for efficient retrieval. */
  private idfWeights: Map<string, number> = new Map();

  seedFromProfileData(profileData: any): void {
    const facts: ConsciousSemanticFact[] = [];

    const identity = profileData?.identity;
    if (identity?.name || identity?.summary) {
      facts.push({
        category: 'identity',
        title: identity?.name || 'Candidate',
        text: [identity?.role, identity?.summary].filter(Boolean).join('. '),
        tags: tokenize(`${identity?.name || ''} ${identity?.role || ''} ${identity?.summary || ''}`),
      });
    }

    for (const project of profileData?.projects || []) {
      facts.push({
        category: 'project',
        title: project.name,
        text: `${project.description || ''} Technologies: ${(project.technologies || []).join(', ')}`.trim(),
        tags: tokenize(`${project.name} ${project.description || ''} ${(project.technologies || []).join(' ')}`),
      });
    }

    for (const exp of profileData?.experience || []) {
      facts.push({
        category: 'experience',
        title: `${exp.role || 'Role'} @ ${exp.company || 'Company'}`,
        text: (exp.bullets || []).join(' '),
        tags: tokenize(`${exp.role || ''} ${exp.company || ''} ${(exp.bullets || []).join(' ')}`),
      });
    }

    for (const skill of profileData?.skills || []) {
      facts.push({
        category: 'skill',
        title: skill,
        text: skill,
        tags: tokenize(skill),
      });
    }

    const activeJD = profileData?.activeJD;
    if (activeJD) {
      facts.push({
        category: 'company_context',
        title: `${activeJD.title || 'Role'} @ ${activeJD.company || 'Company'}`,
        text: `Technologies: ${(activeJD.technologies || []).join(', ')}. Requirements: ${(activeJD.requirements || []).join(' | ')}`,
        tags: tokenize(`${activeJD.title || ''} ${activeJD.company || ''} ${(activeJD.technologies || []).join(' ')} ${(activeJD.keywords || []).join(' ')}`),
      });

      for (const requirement of activeJD.requirements || []) {
        facts.push({
          category: 'requirement',
          title: 'JD Requirement',
          text: requirement,
          tags: tokenize(requirement),
        });
      }
    }

    this.facts = facts;
    this.computeIdfWeights();
  }

  /**
   * Compute IDF weights across all facts. Tokens that appear in fewer facts
   * get higher weight, making retrieval more discriminative.
   */
  private computeIdfWeights(): void {
    const docFrequency = new Map<string, number>();
    const totalDocs = this.facts.length || 1;

    for (const fact of this.facts) {
      const allTokens = new Set([...tokenize(fact.text), ...fact.tags]);
      for (const token of allTokens) {
        docFrequency.set(token, (docFrequency.get(token) || 0) + 1);
      }
    }

    this.idfWeights = new Map();
    for (const [token, df] of docFrequency) {
      // Standard IDF: log(N / df) + 1 (smoothed)
      this.idfWeights.set(token, Math.log(totalDocs / df) + 1);
    }
  }

  getTopFacts(input: { question: string; reaction?: QuestionReaction | null; limit?: number }): ConsciousSemanticFact[] {
    const limit = input.limit || 5;
    const queryText = `${input.question} ${(input.reaction?.targetFacets || []).join(' ')} ${input.reaction?.kind || ''}`;
    const tokens = tokenize(queryText);

    const scored = this.facts
      .map((fact) => {
        const baseScore = tfidfScore(tokens, fact.text, fact.tags, this.idfWeights);
        const bigram = bigramBonus(tokens, fact.text);
        const categoryBoost = categoryRelevanceBoost(fact.category, input.question);
        return { ...fact, score: (baseScore + bigram) * categoryBoost };
      })
      .filter((fact) => (fact.score || 0) > 0)
      .sort((a, b) => (b.score || 0) - (a.score || 0));

    if (!isBehavioralQuestion(input.question)) {
      return scored.slice(0, limit).map(({ score, ...fact }) => fact);
    }

    const selected: ConsciousSemanticFact[] = scored.slice(0, limit).map(({ score, ...fact }) => fact);
    if (selected.length >= limit) {
      return selected;
    }

    const seenTitles = new Set(selected.map((fact) => `${fact.category}:${fact.title}`));
    const fallbackFacts = this.facts
      .filter((fact) => ['experience', 'project', 'identity'].includes(fact.category))
      .sort((a, b) => fallbackCategoryPriority(a.category) - fallbackCategoryPriority(b.category));

    for (const fact of fallbackFacts) {
      const key = `${fact.category}:${fact.title}`;
      if (seenTitles.has(key)) {
        continue;
      }
      selected.push(fact);
      seenTitles.add(key);
      if (selected.length >= limit) {
        break;
      }
    }

    return selected;
  }

  buildContextBlock(input: { question: string; reaction?: QuestionReaction | null; limit?: number }): string {
    const facts = this.getTopFacts(input);
    if (facts.length === 0) {
      return '';
    }

    const lines = ['<conscious_semantic_memory>'];
    for (const fact of facts) {
      lines.push(`[${fact.category.toUpperCase()}] ${fact.title}: ${fact.text}`);
    }
    lines.push('</conscious_semantic_memory>');
    return lines.join('\n');
  }
}
