import type { QuestionReaction } from './QuestionReactionClassifier';

export interface ConsciousSemanticFact {
  category: 'project' | 'experience' | 'skill' | 'requirement' | 'company_context' | 'identity';
  title: string;
  text: string;
  tags: string[];
  score?: number;
}

function tokenize(value: string): string[] {
  return Array.from(new Set(
    value
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((token) => token.length >= 3)
  ));
}

function overlapScore(tokens: string[], text: string, tags: string[]): number {
  const haystack = `${text} ${tags.join(' ')}`.toLowerCase();
  let score = 0;
  for (const token of tokens) {
    if (haystack.includes(token)) {
      score += 1;
    }
  }
  return score;
}

export class ConsciousSemanticFactStore {
  private facts: ConsciousSemanticFact[] = [];

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
  }

  getTopFacts(input: { question: string; reaction?: QuestionReaction | null; limit?: number }): ConsciousSemanticFact[] {
    const tokens = tokenize(`${input.question} ${(input.reaction?.targetFacets || []).join(' ')} ${input.reaction?.kind || ''}`);
    const scored = this.facts
      .map((fact) => ({ ...fact, score: overlapScore(tokens, fact.text, fact.tags) }))
      .filter((fact) => (fact.score || 0) > 0)
      .sort((a, b) => (b.score || 0) - (a.score || 0));

    return scored.slice(0, input.limit || 5);
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
