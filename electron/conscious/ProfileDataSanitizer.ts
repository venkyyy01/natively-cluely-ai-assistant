export interface ProfileDataSanitizationResult {
	data: unknown;
	warnings: string[];
	truncatedFields: string[];
	removedInjectionFields: string[];
}

export interface ProfileDataSanitizerOptions {
	maxStringLength?: number;
	maxArrayItems?: number;
	maxObjectKeys?: number;
	maxTotalCharacters?: number;
}

const DEFAULT_MAX_STRING_LENGTH = 4_000;
const DEFAULT_MAX_ARRAY_ITEMS = 50;
const DEFAULT_MAX_OBJECT_KEYS = 80;
const DEFAULT_MAX_TOTAL_CHARACTERS = 24_000;

const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const PROMPT_INJECTION_PATTERNS = [
	/\bignore\s+(all\s+)?(previous|prior|above|earlier)\s+instructions\b/i,
	/\bdisregard\s+(all\s+)?(previous|prior|above|earlier)\s+instructions\b/i,
	/\breveal\s+(the\s+)?(system|developer)\s+(prompt|message|instructions)\b/i,
	/\bsystem\s+prompt\b/i,
	/\bdeveloper\s+message\b/i,
	/\bjailbreak\b/i,
	/\bact\s+as\s+(?:a|an|the)?\s*(different|uncensored|unrestricted)?\s*(ai|assistant|model)\b/i,
];

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function sanitizeProfileData(
	profileData: unknown,
	options: ProfileDataSanitizerOptions = {},
): ProfileDataSanitizationResult {
	const maxStringLength = options.maxStringLength ?? DEFAULT_MAX_STRING_LENGTH;
	const maxArrayItems = options.maxArrayItems ?? DEFAULT_MAX_ARRAY_ITEMS;
	const maxObjectKeys = options.maxObjectKeys ?? DEFAULT_MAX_OBJECT_KEYS;
	const maxTotalCharacters =
		options.maxTotalCharacters ?? DEFAULT_MAX_TOTAL_CHARACTERS;
	const warnings = new Set<string>();
	const truncatedFields: string[] = [];
	const removedInjectionFields: string[] = [];
	let totalCharacters = 0;

	const sanitizeString = (value: string, path: string): string => {
		const withoutControls = value
			.replace(CONTROL_CHARS, " ")
			.replace(/\s+/g, " ")
			.trim();
		if (withoutControls !== value.trim()) {
			warnings.add("control_chars_stripped");
		}

		const lines = withoutControls
			.split(/(?:\\n|\n|\. )/)
			.map((line) => line.trim())
			.filter(Boolean);
		const retainedLines = lines.filter((line) => {
			const isInjection = PROMPT_INJECTION_PATTERNS.some((pattern) =>
				pattern.test(line),
			);
			if (isInjection) {
				removedInjectionFields.push(path);
				warnings.add("prompt_injection_directive_removed");
			}
			return !isInjection;
		});

		let sanitized = retainedLines.join(". ");
		if (sanitized.length > maxStringLength) {
			sanitized = sanitized.slice(0, maxStringLength).trim();
			truncatedFields.push(path);
			warnings.add("string_truncated");
		}

		const remainingBudget = maxTotalCharacters - totalCharacters;
		if (remainingBudget <= 0) {
			if (sanitized) {
				truncatedFields.push(path);
				warnings.add("total_character_budget_exceeded");
			}
			return "";
		}

		if (sanitized.length > remainingBudget) {
			sanitized = sanitized.slice(0, remainingBudget).trim();
			truncatedFields.push(path);
			warnings.add("total_character_budget_exceeded");
		}

		totalCharacters += sanitized.length;
		return sanitized;
	};

	const visit = (value: unknown, path: string): unknown => {
		if (typeof value === "string") {
			return sanitizeString(value, path);
		}

		if (
			typeof value === "number" ||
			typeof value === "boolean" ||
			value === null ||
			value === undefined
		) {
			return value;
		}

		if (Array.isArray(value)) {
			if (value.length > maxArrayItems) {
				truncatedFields.push(path);
				warnings.add("array_truncated");
			}
			return value
				.slice(0, maxArrayItems)
				.map((item, index) => visit(item, `${path}[${index}]`))
				.filter((item) => item !== "" && item !== undefined);
		}

		if (!isPlainObject(value)) {
			warnings.add("unsupported_profile_value_dropped");
			return undefined;
		}

		const entries = Object.entries(value);
		if (entries.length > maxObjectKeys) {
			truncatedFields.push(path);
			warnings.add("object_keys_truncated");
		}

		const sanitizedObject: Record<string, unknown> = {};
		for (const [key, item] of entries.slice(0, maxObjectKeys)) {
			const sanitizedKey = key.replace(CONTROL_CHARS, "").trim();
			if (!sanitizedKey) {
				warnings.add("empty_profile_key_dropped");
				continue;
			}

			const sanitizedValue = visit(
				item,
				path ? `${path}.${sanitizedKey}` : sanitizedKey,
			);
			if (sanitizedValue !== undefined && sanitizedValue !== "") {
				sanitizedObject[sanitizedKey] = sanitizedValue;
			}
		}

		return sanitizedObject;
	};

	return {
		data: profileData ? visit(profileData, "profile") : profileData,
		warnings: Array.from(warnings),
		truncatedFields,
		removedInjectionFields: Array.from(new Set(removedInjectionFields)),
	};
}
