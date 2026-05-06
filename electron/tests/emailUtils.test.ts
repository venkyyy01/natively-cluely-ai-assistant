import assert from "node:assert/strict";
import test from "node:test";
import {
	buildFollowUpEmailPromptInput,
	buildGmailComposeUrl,
	buildMailtoLink,
	copyToClipboard,
	extractEmailsFromTranscript,
	extractRecipientName,
	generateEmailSubject,
} from "../utils/emailUtils";

test("extractEmailsFromTranscript normalizes and deduplicates matches", () => {
	const emails = extractEmailsFromTranscript([
		{ text: "Email JOHN.DOE@example.com and jane@example.com today." },
		{ text: "Follow up with john.doe@example.com as well." },
		{ text: "No email here." },
	]);

	assert.deepEqual(emails, ["john.doe@example.com", "jane@example.com"]);
});

test("buildMailtoLink encodes recipient and preserves %20 spacing", () => {
	const link = buildMailtoLink(
		"a@example.com,b@example.com",
		"Hello world",
		"Line one\nLine two",
	);

	assert.equal(
		link,
		"mailto:a%40example.com%2Cb%40example.com?subject=Hello%20world&body=Line%20one%0ALine%20two",
	);
});

test("buildGmailComposeUrl includes expected query parameters", () => {
	const url = new URL(
		buildGmailComposeUrl("to@example.com", "Status update", "Body text"),
	);

	assert.equal(url.origin, "https://mail.google.com");
	assert.equal(url.searchParams.get("view"), "cm");
	assert.equal(url.searchParams.get("fs"), "1");
	assert.equal(url.searchParams.get("to"), "to@example.com");
	assert.equal(url.searchParams.get("su"), "Status update");
	assert.equal(url.searchParams.get("body"), "Body text");
});

test("generateEmailSubject handles interview and default meeting types", () => {
	assert.equal(
		generateEmailSubject(' "Platform Review" ', "interview"),
		"Following up on our conversation - Platform Review",
	);
	assert.equal(
		generateEmailSubject("*Weekly Sync*"),
		"Following up - Weekly Sync",
	);
});

test("buildFollowUpEmailPromptInput includes only provided optional sections", () => {
	const prompt = buildFollowUpEmailPromptInput({
		meeting_type: "demo",
		title: "Q2 Demo",
		recipient_name: "Taylor",
		sender_name: "Alex",
		summary: "We reviewed the roadmap.",
		action_items: ["Send pricing", "Schedule next call"],
		key_points: ["Customers want SSO"],
		tone: "friendly",
	});

	assert.match(prompt, /Meeting Type: demo/);
	assert.match(prompt, /Title: Q2 Demo/);
	assert.match(prompt, /Recipient Name: Taylor/);
	assert.match(prompt, /Sender Name: Alex/);
	assert.match(prompt, /Summary: We reviewed the roadmap\./);
	assert.match(prompt, /Action Items:\n- Send pricing\n- Schedule next call/);
	assert.match(prompt, /Key Points:\n- Customers want SSO/);
	assert.match(prompt, /Tone: friendly/);

	const minimalPrompt = buildFollowUpEmailPromptInput({
		meeting_type: "meeting",
		title: "Standup",
		action_items: [],
		key_points: [],
	});

	assert.equal(minimalPrompt, "Meeting Type: meeting\n\nTitle: Standup");
});

test("extractRecipientName handles both email and full names", () => {
	assert.equal(extractRecipientName("john.doe@example.com"), "John");
	assert.equal(extractRecipientName("ALICE smith"), "Alice");
});

test("copyToClipboard delegates to navigator clipboard", async () => {
	let copied = "";
	Object.defineProperty(globalThis, "navigator", {
		configurable: true,
		value: {
			clipboard: {
				writeText: async (text: string) => {
					copied = text;
				},
			},
		},
	});

	await copyToClipboard("copied text");
	assert.equal(copied, "copied text");
});
