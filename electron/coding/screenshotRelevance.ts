/**
 * NAT-SCREENSHOT-RELEVANCE: Lightweight relevance gates used by the
 * conscious-mode auto-trigger to decide whether queued screenshots
 * should be attached to a freshly-arrived interviewer turn.
 *
 * Two questions are answered here, both cheap (no model calls):
 *
 *   1. Is the spoken question shaped like a coding / problem-solving
 *      ask, or is it behavioral / culture / off-topic? Coding-shaped
 *      questions are the only kind where attaching the screenshot
 *      tends to help.
 *   2. Was the screenshot captured recently enough to plausibly relate
 *      to the *current* question, rather than a previous topic?
 *
 * Intentional limits:
 *   - These are heuristics, not a classifier. They favour false
 *     negatives (don't attach when unsure) over false positives
 *     (attach a stale screenshot to a behavioral question, which
 *     produces a confused, wrong answer).
 *   - They run on every transcript turn, so they must stay regex-fast
 *     and allocation-light.
 *
 * Tunables here (default 45s freshness window) are chosen so the
 * common "screenshot-then-question-immediately" flow works while a
 * minute-old prep screenshot doesn't bleed into a new question.
 *
 * Mirrors `IntelligenceEngine.isLiveCodingQuestion` /
 * `isAmbiguousScreenshotCodingPrompt` so the auto-trigger path uses
 * the same semantic gate as the manual-trigger conscious route. Keep
 * the regex sources in sync if either side is updated.
 */

const LIVE_CODING_PATTERNS =
  /(write|implement|debug|fix|refactor|solve|code|function|typescript|javascript|python|java|sql|query|algorithm|bug|error|test case|complexity)/i;

const AMBIGUOUS_SCREENSHOT_CODING_PATTERNS =
  /(solve this|approach this|show me how|what'?s wrong|why is this failing|look at this|this screenshot|screen|editor|terminal|leetcode|coding problem|test cases?)/i;

const BEHAVIORAL_PATTERNS =
  /(tell me about a time|describe a time|describe a situation|share an experience|give me an example|walk me through|talk about|how do you handle|how do you manage|leadership|conflict|disagreed|disagreement|feedback|failure|mistake|project you led|owned end to end|team challenge|culture|values|mentor|stakeholder)/i;

/** Default freshness window for auto-attach. Tuned so a "screenshot,
 *  then ask the question" flow works while a minute-old prep
 *  screenshot doesn't leak into a new question. */
export const DEFAULT_SCREENSHOT_FRESHNESS_MS = 45_000;

/**
 * True when the question text reads like a coding / problem-solving ask
 * (or an ambiguous screenshot prompt that's almost always coding in
 * practice). Used as the positive signal for auto-attach.
 */
export function isCodingShapedQuestion(question: string | null | undefined): boolean {
  if (!question) return false;
  const text = question.trim();
  if (!text) return false;
  return LIVE_CODING_PATTERNS.test(text) || AMBIGUOUS_SCREENSHOT_CODING_PATTERNS.test(text);
}

/**
 * True when the question is recognisably behavioral / culture-fit. Used
 * as a negative signal — even if some coding cue accidentally matches,
 * a clear behavioral framing should suppress the auto-attach. Live
 * coding screenshots paired with "tell me about a time you led X" land
 * as confused answers.
 */
export function isBehavioralQuestion(question: string | null | undefined): boolean {
  if (!question) return false;
  const text = question.trim();
  if (!text) return false;
  return BEHAVIORAL_PATTERNS.test(text);
}

/**
 * Combined gate: should the auto-trigger path attach the queued
 * screenshots to this transcript turn?
 *
 * Returns true only when the question is coding-shaped AND not also
 * matching a behavioral pattern. Behavioral patterns win in case of
 * collision because attaching the screenshot in that case is the more
 * costly mistake.
 */
export function shouldAutoAttachScreenshotsForQuestion(
  question: string | null | undefined,
): boolean {
  if (!isCodingShapedQuestion(question)) return false;
  if (isBehavioralQuestion(question)) return false;
  return true;
}
