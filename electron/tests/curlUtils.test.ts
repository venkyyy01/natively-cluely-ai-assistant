import assert from "node:assert/strict";
import test from "node:test";
import {
	deepVariableReplacer,
	getByPath,
	validateCurl,
} from "../utils/curlUtils";

test("validateCurl rejects empty commands and non-curl commands", () => {
	assert.deepEqual(validateCurl(""), {
		isValid: false,
		message: "Command cannot be empty.",
	});
	assert.deepEqual(validateCurl("   "), {
		isValid: false,
		message: "Command cannot be empty.",
	});
	assert.deepEqual(validateCurl("POST https://example.com"), {
		isValid: false,
		message: "Command must start with 'curl'.",
	});
});

test("validateCurl rejects commands without supported placeholders", () => {
	assert.deepEqual(validateCurl("curl https://example.com"), {
		isValid: false,
		message:
			"Your cURL must include at least one supported placeholder (e.g. {{TEXT}} or {{IMAGE_BASE64}}).",
	});
});

test("validateCurl accepts parseable commands with text or image placeholders and rejects bad syntax", () => {
	const valid = validateCurl(
		"curl https://example.com -H 'Content-Type: application/json' -d '{\"prompt\":\"{{TEXT}}\"}'",
	);
	assert.equal(valid.isValid, true);
	assert.ok(valid.json);

	const imageOnlyValid = validateCurl(
		"curl https://example.com -H 'Content-Type: application/json' -d '{\"image\":\"{{IMAGE_BASE64}}\"}'",
	);
	assert.equal(imageOnlyValid.isValid, true);
	assert.ok(imageOnlyValid.json);

	const openAiCompatibleValid = validateCurl(
		"curl https://example.com -H 'Content-Type: application/json' -d '{\"messages\":{{OPENAI_MESSAGES}}}'",
	);
	assert.equal(openAiCompatibleValid.isValid, true);
	assert.ok(openAiCompatibleValid.json);

	assert.deepEqual(validateCurl('curl "unterminated {{TEXT}}'), {
		isValid: false,
		message: "Invalid cURL syntax.",
	});
});

test("deepVariableReplacer replaces strings recursively and preserves primitives", () => {
	const replaced = deepVariableReplacer(
		{
			url: "https://example.com/{{ID}}",
			headers: ["Bearer {{TOKEN}}", 42, false, null],
			nested: {
				body: "{{TEXT}}",
			},
		},
		{ ID: "123", TOKEN: "abc", TEXT: "hello" },
	);

	assert.deepEqual(replaced, {
		url: "https://example.com/123",
		headers: ["Bearer abc", 42, false, null],
		nested: {
			body: "hello",
		},
	});
});

test("deepVariableReplacer preserves non-string placeholder types when value is exact token", () => {
	const replaced = deepVariableReplacer(
		{
			images: "{{IMAGE_BASE64S}}",
			count: "{{IMAGE_COUNT}}",
		},
		{
			IMAGE_BASE64S: ["a", "b"],
			IMAGE_COUNT: "2",
		},
	);

	assert.deepEqual(replaced, {
		images: ["a", "b"],
		count: "2",
	});
});

test("getByPath resolves nested keys, arrays, missing paths, and empty path", () => {
	const obj = {
		choices: [{ message: { content: "hi" } }],
		plain: { value: 7 },
	};

	assert.equal(getByPath(obj, ""), obj);
	assert.equal(getByPath(obj, "choices[0].message.content"), "hi");
	assert.equal(getByPath(obj, "plain.value"), 7);
	assert.equal(getByPath(obj, "choices[1].message.content"), undefined);
});
