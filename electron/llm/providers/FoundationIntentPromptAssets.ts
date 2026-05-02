export const FOUNDATION_INTENT_PROMPT_VERSION = "foundation_intent_prompt_v2";
export const FOUNDATION_INTENT_SCHEMA_VERSION = "foundation_intent_schema_v1";

export const FOUNDATION_INTENT_ALLOWED_INTENTS = [
	"behavioral",
	"coding",
	"deep_dive",
	"clarification",
	"follow_up",
	"example_request",
	"summary_probe",
	"general",
] as const;

export type FoundationIntentLabel =
	(typeof FOUNDATION_INTENT_ALLOWED_INTENTS)[number];
