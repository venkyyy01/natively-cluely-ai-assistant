import { render, screen } from "@testing-library/react";
import {
	ConsciousModeAnswer,
	classifyAssistRender,
	parseConsciousModeAnswer,
	validateConsciousModeGuardrails,
} from "../../src/lib/consciousMode";

const structuredAnswer = [
	"Opening reasoning: I would start with a write-through cache so reads stay fast and invalidation remains predictable.",
	"Implementation plan:",
	"- Put the cache behind a small interface so eviction policy stays swappable.",
	"- Add a backing store fallback for misses and warm frequently used keys.",
	"Tradeoffs:",
	"- The cache reduces latency but adds invalidation complexity.",
	"Edge cases:",
	"- Handle cold starts and stale writes explicitly.",
	"Scale considerations:",
	"- Shard by tenant once a single node stops fitting in memory.",
	"Pushback responses:",
	"- If they push on consistency, I would tighten invalidation before adding more layers.",
	"Likely follow-ups:",
	"- They may ask how I would test stale data behavior.",
	"Code transition: If they ask for code, I would sketch the cache interface first.\n```ts\nconst cache = new Map<string, string>();\n```",
].join("\n");

const behavioralStructuredAnswer = [
	"Question: Handled disagreement with a PM during a release",
	"Headline:",
	"I helped stabilize a risky release by aligning the PM and QA team around a narrower rollback decision.",
	"Situation:",
	"We were in the middle of a release and there was disagreement on whether we should keep pushing or roll back after a risky behavior change.",
	"Task: I needed to get the release back to a safe state quickly without creating more confusion across the team.",
	"Action:",
	"I pulled the logs, checked the deployment diff, and isolated the smallest safe rollback. Then I aligned with QA on a quick validation pass and kept the PM updated on the tradeoff between speed and blast radius.",
	"Result:",
	"We stabilized the release the same day and added a clearer rollback checklist for future launches.",
	"Why this answer works:",
	"- Shows ownership under pressure",
	"- Shows conflict resolution with evidence",
	"- Ends with a process improvement",
].join("\n");

test("parses backend Conscious Mode text into the five speaking blocks", () => {
	const parsed = parseConsciousModeAnswer(structuredAnswer);

	expect(parsed).not.toBeNull();
	expect(
		parsed?.sections.map((section: { title: string }) => section.title),
	).toEqual([
		"Say This First",
		"Then Build It",
		"Tradeoffs",
		"If They Push Back",
		"If They Ask For Code",
	]);
	expect(parsed?.sections[0].items).toEqual([
		"I would start with a write-through cache so reads stay fast and invalidation remains predictable.",
	]);
});

test("keeps opening reasoning first and does not surface code before the final block", () => {
	const guardrails = validateConsciousModeGuardrails(structuredAnswer);
	expect(guardrails.isValid).toBe(true);

	const { container } = render(<ConsciousModeAnswer text={structuredAnswer} />);

	const text = container.textContent ?? "";
	expect(text.indexOf("Say This First")).toBeLessThan(
		text.indexOf("Then Build It"),
	);
	expect(text.indexOf("If They Ask For Code")).toBeLessThan(
		text.indexOf("const cache = new Map"),
	);
	expect(text.indexOf("Say This First")).toBeLessThan(
		text.indexOf("const cache = new Map"),
	);

	expect(screen.getByText("If They Ask For Code")).toBeInTheDocument();
	expect(
		screen.getByText("const cache = new Map<string, string>();"),
	).toBeInTheDocument();
});

test("rejects malformed code-first Conscious Mode text for guarded rendering", () => {
	const malformed = [
		"Opening reasoning: ```ts\nconst queue = [];\n```",
		"Implementation plan:",
		"- Add retries.",
	].join("\n");

	expect(validateConsciousModeGuardrails(malformed)).toEqual({
		isValid: false,
		reason: "opening_reasoning_contains_code",
	});
	expect(parseConsciousModeAnswer(malformed)).toBeNull();
});

test("rejects overly long opening reasoning that is not short spoken language", () => {
	const overlyLongOpening = [
		"Opening reasoning: I would start by exhaustively framing the entire distributed architecture, the data consistency profile, the failure cascade matrix, the deployment sequencing, the migration posture, the contingency plans, the observability rollout, and the future extensions before I even commit to a first implementation step because I want to narrate every possible branch in detail.",
		"Implementation plan:",
		"- Start with a cache.",
	].join("\n");

	expect(validateConsciousModeGuardrails(overlyLongOpening)).toEqual({
		isValid: false,
		reason: "opening_reasoning_too_long",
	});
	expect(parseConsciousModeAnswer(overlyLongOpening)).toBeNull();
});

test("placeholder-renders streaming Conscious Mode text until the payload is guardrail-valid", () => {
	render(
		<ConsciousModeAnswer
			text={[
				"Opening reasoning: I would start with a cache.",
				"Implementation plan:",
			].join("\n")}
			isStreaming
		/>,
	);

	expect(
		screen.getByText("Preparing Conscious Mode response..."),
	).toBeInTheDocument();
	expect(
		screen.queryByText("Opening reasoning: I would start with a cache."),
	).not.toBeInTheDocument();
	expect(screen.queryByText("Say This First")).not.toBeInTheDocument();
});

test("classifies Conscious Mode analytics separately from standard interview assist", () => {
	expect(
		classifyAssistRender({
			answerText: structuredAnswer,
			threadAction: "continue",
		}),
	).toEqual({
		output_variant: "conscious_mode",
		thread_type: "follow_up_extension",
	});

	expect(
		classifyAssistRender({
			answerText: "Start with the data model and then write the endpoint.",
		}),
	).toEqual({
		output_variant: "standard_interview_assist",
		thread_type: "fresh_answer",
	});
});

test("parses the behavioral STAR layout used by Conscious Mode grounded interview answers", () => {
	const parsed = parseConsciousModeAnswer(behavioralStructuredAnswer);

	expect(parsed).not.toBeNull();
	expect(
		parsed?.sections.map((section: { title: string }) => section.title),
	).toEqual([
		"Question",
		"Headline",
		"Situation",
		"Task",
		"Action",
		"Result",
		"Why this answer works",
	]);

	expect(
		classifyAssistRender({
			answerText: behavioralStructuredAnswer,
			threadAction: "start",
		}),
	).toEqual({
		output_variant: "conscious_mode",
		thread_type: "fresh_reasoning_thread",
	});
});
