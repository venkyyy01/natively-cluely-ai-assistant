import fs from "fs";
import path from "path";

const hookPath = path.resolve(
	__dirname,
	"../../src/hooks/useHumanSpeedAutoScroll.ts",
);

test("uses the updated human reading speed default", () => {
	const source = fs.readFileSync(hookPath, "utf8");

	expect(source).toContain("const HUMAN_WORDS_PER_MINUTE = 210;");
});

test("uses a shorter minimum scroll duration to avoid sluggish responses", () => {
	const source = fs.readFileSync(hookPath, "utf8");

	expect(source).toContain("const MIN_SCROLL_DURATION_MS = 5000;");
});

test("does not clear a manual pause when a new message starts streaming", () => {
	const source = fs.readFileSync(hookPath, "utf8");

	expect(source).not.toContain(
		"manualPauseUntilRef.current = 0;\n      container.scrollTop = targetOffset;",
	);
});
