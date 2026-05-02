import assert from "node:assert/strict";
import test from "node:test";

import { WhatToAnswerLLM } from "../llm/WhatToAnswerLLM";

test("WhatToAnswerLLM falls back cleanly when streamChat does not return an async iterable", async () => {
	let initialFailureKind: string | null = null;
	const helper = {
		streamChat() {
			return undefined as unknown as AsyncIterable<string>;
		},
	};

	const llm = new WhatToAnswerLLM(helper as any);
	const chunks: string[] = [];
	for await (const chunk of llm.generateStream(
		"Explain the tradeoffs",
		undefined,
		undefined,
		undefined,
		{
			onInitialStreamFailure(details) {
				initialFailureKind = details.kind;
			},
		},
	)) {
		chunks.push(chunk);
	}

	assert.equal(initialFailureKind, "error");
	assert.equal(
		chunks.join(""),
		"Could you repeat that? I want to make sure I address your question properly.",
	);
});

test("WhatToAnswerLLM falls back cleanly when streamChat is missing", async () => {
	let initialFailureKind: string | null = null;
	const helper = {};

	const llm = new WhatToAnswerLLM(helper as any);
	const chunks: string[] = [];
	for await (const chunk of llm.generateStream(
		"Explain the tradeoffs",
		undefined,
		undefined,
		undefined,
		{
			onInitialStreamFailure(details) {
				initialFailureKind = details.kind;
			},
		},
	)) {
		chunks.push(chunk);
	}

	assert.equal(initialFailureKind, "error");
	assert.equal(
		chunks.join(""),
		"Could you repeat that? I want to make sure I address your question properly.",
	);
});
