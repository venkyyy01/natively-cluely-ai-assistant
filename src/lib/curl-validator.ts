import curl2Json from "@bany/curl-to-json";

export interface CurlValidationResult {
	isValid: boolean;
	message?: string;
	json?: any;
}

export const validateCurl = (curl: string): CurlValidationResult => {
	if (!curl?.trim()) {
		return { isValid: false, message: "Command cannot be empty." };
	}

	// Basic check for curl command
	if (!curl.trim().toLowerCase().startsWith("curl")) {
		return {
			isValid: false,
			message: "The command must start with 'curl'.",
		};
	}

	try {
		const json = curl2Json(curl);

		// Check for at least one supported placeholder so providers can be
		// text-only, image-only, or mixed multimodal.
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
		return {
			isValid: false,
			message: "Invalid cURL command syntax. Please check for typos.",
		};
	}
};
