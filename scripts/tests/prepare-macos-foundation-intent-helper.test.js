const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const repoRoot = path.resolve(__dirname, "..", "..");
const packageJson = require(path.join(repoRoot, "package.json"));
const {
	prepareMacosFoundationIntentHelper,
	findBuiltBinary,
	isTruthyFlag,
} = require(
	path.join(repoRoot, "scripts", "prepare-macos-foundation-intent-helper.js"),
);

test("prepare-macos-foundation-intent-helper stages helper binary output", () => {
	const tempDir = fs.mkdtempSync(
		path.join(os.tmpdir(), "foundation-intent-helper-stage-"),
	);
	const builtBinary = path.join(tempDir, "foundation-intent-helper");
	const outputDir = path.join(tempDir, "out");
	const outputBinary = path.join(outputDir, "foundation-intent-helper");

	fs.writeFileSync(builtBinary, "#!/bin/sh\nexit 0\n");

	const staged = prepareMacosFoundationIntentHelper({
		platform: "darwin",
		shouldBuild: false,
		shouldCodesign: false,
		builtBinary,
		outputDir,
		outputBinary,
		logFn: () => {},
	});

	assert.equal(staged.outputBinary, outputBinary);
	assert.equal(fs.existsSync(outputBinary), true);
	assert.equal((fs.statSync(outputBinary).mode & 0o111) > 0, true);
});

test("prepare-macos-foundation-intent-helper locates architecture-specific build outputs", () => {
	const tempDir = fs.mkdtempSync(
		path.join(os.tmpdir(), "foundation-intent-helper-find-"),
	);
	const archSpecific = path.join(
		tempDir,
		".build",
		"arm64-apple-macosx",
		"release",
		"foundation-intent-helper",
	);
	fs.mkdirSync(path.dirname(archSpecific), { recursive: true });
	fs.writeFileSync(archSpecific, "binary");

	assert.equal(findBuiltBinary(tempDir, "release"), archSpecific);
});

test("prepare-macos-foundation-intent-helper skips gracefully when Swift is unavailable and no existing binary is present", () => {
	const result = prepareMacosFoundationIntentHelper({
		platform: "darwin",
		packageDir: "/tmp/foundation-intent-helper-package",
		shouldBuild: true,
		shouldCodesign: false,
		commandExists: () => false,
		logFn: () => {},
	});

	assert.equal(result.skipped, true);
	assert.match(result.reason ?? "", /Swift toolchain unavailable/);
});

test("prepare-macos-foundation-intent-helper can require helper availability explicitly", () => {
	assert.throws(() => {
		prepareMacosFoundationIntentHelper({
			platform: "darwin",
			packageDir: "/tmp/foundation-intent-helper-package",
			shouldBuild: true,
			shouldCodesign: false,
			requireHelper: true,
			commandExists: () => false,
			logFn: () => {},
		});
	}, /Swift toolchain unavailable/);
});

test("isTruthyFlag handles expected truthy and falsy values", () => {
	assert.equal(isTruthyFlag("1"), true);
	assert.equal(isTruthyFlag("true"), true);
	assert.equal(isTruthyFlag("yes"), true);
	assert.equal(isTruthyFlag("on"), true);
	assert.equal(isTruthyFlag("0"), false);
	assert.equal(isTruthyFlag("false"), false);
	assert.equal(isTruthyFlag(""), false);
});

test("package.json mac build config includes foundation intent helper preparation and resource staging", () => {
	assert.match(
		packageJson.scripts["prepare:macos:foundation-intent-helper"],
		/prepare-macos-foundation-intent-helper\.js/,
	);
	assert.match(
		packageJson.scripts["app:build"],
		/prepare:macos:foundation-intent-helper/,
	);
	assert.match(
		packageJson.scripts["app:build:arm64"],
		/prepare:macos:foundation-intent-helper/,
	);
	assert.match(
		packageJson.scripts["app:build:x64"],
		/prepare:macos:foundation-intent-helper/,
	);

	const extraResources = packageJson.build.extraResources ?? [];
	assert.deepEqual(
		extraResources.some(
			(entry) =>
				entry.from === "assets/bin/macos" &&
				entry.to === "bin/macos" &&
				Array.isArray(entry.filter) &&
				entry.filter.includes("foundation-intent-helper"),
		),
		true,
	);
});
