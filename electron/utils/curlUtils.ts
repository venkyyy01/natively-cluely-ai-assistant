const curl2Json: (curl: string) => any = require("@bany/curl-to-json");

export interface CurlValidationResult {
	isValid: boolean;
	message?: string;
	json?: any;
}

/**
 * Validates if the cURL command is parseable and contains required variables
 */
export const validateCurl = (curl: string): CurlValidationResult => {
	if (!curl?.trim()) {
		return { isValid: false, message: "Command cannot be empty." };
	}

	if (!curl.trim().toLowerCase().startsWith("curl")) {
		return { isValid: false, message: "Command must start with 'curl'." };
	}

	try {
		const json = curl2Json(curl);

		// Ensure at least one supported input placeholder is present.
		// This supports text-only, image-only, and mixed providers.
		const hasSupportedPlaceholder =
			curl.includes("{{TEXT}}") ||
			curl.includes("{{PROMPT}}") ||
			curl.includes("{{USER_MESSAGE}}") ||
			curl.includes("{{SYSTEM_PROMPT}}") ||
			curl.includes("{{CONTEXT}}") ||
			curl.includes("{{IMAGE_BASE64}}") ||
			curl.includes("{{IMAGE_BASE64S}}") ||
			curl.includes("{{IMAGE_COUNT}}") ||
			curl.includes("{{OPENAI_USER_CONTENT}}") ||
			curl.includes("{{OPENAI_MESSAGES}}");

		if (!hasSupportedPlaceholder) {
			return {
				isValid: false,
				message:
					"Your cURL must include at least one supported placeholder (e.g. {{TEXT}} or {{IMAGE_BASE64}}).",
			};
		}

		return { isValid: true, json };
	} catch (_error) {
		return { isValid: false, message: "Invalid cURL syntax." };
	}
};

/**
 * Replaces {{KEY}} placeholders with actual values
 */
export function deepVariableReplacer(
	node: any,
	variables: Record<string, unknown>,
): any {
	if (typeof node === "string") {
		const exactPlaceholder = node.match(/^\{\{([A-Z0-9_]+)\}\}$/);
		if (exactPlaceholder) {
			const key = exactPlaceholder[1];
			if (Object.hasOwn(variables, key)) {
				return variables[key];
			}
		}

		let result = node;
		for (const [key, value] of Object.entries(variables)) {
			const replacement =
				typeof value === "string"
					? JSON.stringify(value).slice(1, -1)
					: JSON.stringify(value);
			// Global replace of {{KEY}}
			result = result.replace(
				new RegExp(`\\{\\{${key}\\}\\}`, "g"),
				replacement,
			);
		}
		return result;
	}
	if (Array.isArray(node)) {
		return node.map((item) => deepVariableReplacer(item, variables));
	}
	if (node && typeof node === "object") {
		const newNode: { [key: string]: any } = {};
		for (const key in node) {
			newNode[key] = deepVariableReplacer(node[key], variables);
		}
		return newNode;
	}
	return node;
}

/**
 * Helper to traverse a JSON object via dot notation (e.g. "choices[0].message.content")
 */
export function getByPath(obj: any, path: string): any {
	if (!path) return obj;
	return path
		.replace(/\[/g, ".")
		.replace(/\]/g, "")
		.split(".")
		.reduce((o, k) => o?.[k], obj);
}
