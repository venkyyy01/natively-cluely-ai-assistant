export type ConstraintType =
	| "budget"
	| "deadline"
	| "headcount"
	| "duration"
	| "percentage"
	| "count";

export interface ExtractedConstraint {
	type: ConstraintType;
	raw: string;
	normalized: string;
}

const CONSTRAINT_PATTERNS: Record<ConstraintType, RegExp> = {
	budget:
		/\$[\d,]+(?:\.\d{2})?(?:\s?[kmb])?|\b\d+(?:\.\d+)?\s?(?:thousand|million|billion|k|m|b)\s?(?:usd|dollars?)?\b/gi,
	deadline:
		/(?:by|before|until|due)\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+\d{4})?|\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/gi,
	headcount:
		/\b\d+\s*(?:people|engineers?|developers?|designers?|employees?|team members?|ftes?|headcount)\b/gi,
	duration: /\b\d+\s*(?:weeks?|months?|quarters?|sprints?|days?)\b/gi,
	percentage: /\b\d+(?:\.\d+)?%|\b\d+(?:\.\d+)?\s*percent\b/gi,
	count:
		/\b\d+\s*(?:features?|requirements?|milestones?|deliverables?|items?)\b/gi,
};

function normalizeBudget(raw: string): string {
	const value = raw.trim().toLowerCase().replace(/,/g, "");

	const match = value.match(
		/\$?(\d+(?:\.\d+)?)(?:\s?([kmb])|\s?(thousand|million|billion))?/i,
	);
	if (!match) return raw.trim();

	const amount = Number.parseFloat(match[1]);
	if (!Number.isFinite(amount)) return raw.trim();

	const suffix = (match[2] || match[3] || "").toLowerCase();
	const multiplier =
		suffix === "k" || suffix === "thousand"
			? 1_000
			: suffix === "m" || suffix === "million"
				? 1_000_000
				: suffix === "b" || suffix === "billion"
					? 1_000_000_000
					: 1;

	const normalized = Math.round(amount * multiplier);
	return `$${normalized.toLocaleString("en-US")}`;
}

function normalizeConstraint(type: ConstraintType, raw: string): string {
	const trimmed = raw.trim();
	if (!trimmed) return trimmed;

	if (type === "budget") {
		return normalizeBudget(trimmed);
	}

	return trimmed.replace(/\s+/g, " ");
}

function deduplicateConstraints(
	items: ExtractedConstraint[],
): ExtractedConstraint[] {
	const seen = new Set<string>();
	const deduped: ExtractedConstraint[] = [];

	for (const item of items) {
		const key = `${item.type}:${item.normalized.toLowerCase()}`;
		if (seen.has(key)) continue;
		seen.add(key);
		deduped.push(item);
	}

	return deduped;
}

export function extractConstraints(text: string): ExtractedConstraint[] {
	const trimmed = text.trim();
	if (!trimmed) return [];

	const results: ExtractedConstraint[] = [];

	for (const [type, pattern] of Object.entries(CONSTRAINT_PATTERNS) as [
		ConstraintType,
		RegExp,
	][]) {
		const matches = trimmed.match(pattern) || [];
		for (const raw of matches) {
			results.push({
				type,
				raw,
				normalized: normalizeConstraint(type, raw),
			});
		}
	}

	return deduplicateConstraints(results);
}
