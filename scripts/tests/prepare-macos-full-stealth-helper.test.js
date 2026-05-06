const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const repoRoot = path.resolve(__dirname, "..", "..");
const packageJson = require(path.join(repoRoot, "package.json"));
const {
	prepareMacosFullStealthHelper,
	createInfoPlistContent,
	findBuiltBinary,
	stageBundle,
} = require(
	path.join(repoRoot, "scripts", "prepare-macos-full-stealth-helper.js"),
);

test("prepare-macos-full-stealth-helper stages an XPC bundle with executable and Info.plist", () => {
	const tempDir = fs.mkdtempSync(
		path.join(os.tmpdir(), "full-stealth-helper-stage-"),
	);
	const builtBinary = path.join(tempDir, "macos-full-stealth-helper");
	const outputBundleDir = path.join(tempDir, "macos-full-stealth-helper.xpc");

	fs.writeFileSync(builtBinary, "#!/bin/sh\nexit 0\n");

	const staged = stageBundle({
		builtBinary,
		outputBundleDir,
		bundleIdentifier: "com.test.full-stealth-helper",
		logFn: () => {},
	});

	assert.equal(fs.existsSync(staged.stagedBinary), true);
	assert.equal(fs.existsSync(staged.infoPlistPath), true);
	assert.match(
		fs.readFileSync(staged.infoPlistPath, "utf8"),
		/CFBundlePackageType[\s\S]*XPC!/,
	);
	assert.match(
		fs.readFileSync(staged.infoPlistPath, "utf8"),
		/com.test.full-stealth-helper/,
	);
});

test("prepare-macos-full-stealth-helper locates architecture-specific build outputs", () => {
	const tempDir = fs.mkdtempSync(
		path.join(os.tmpdir(), "full-stealth-helper-find-"),
	);
	const archSpecific = path.join(
		tempDir,
		".build",
		"arm64-apple-macosx",
		"release",
		"macos-full-stealth-helper",
	);
	fs.mkdirSync(path.dirname(archSpecific), { recursive: true });
	fs.writeFileSync(archSpecific, "binary");

	assert.equal(findBuiltBinary(tempDir, "release"), archSpecific);
});

test("prepare-macos-full-stealth-helper skips gracefully when Swift is unavailable and no existing binary is present", () => {
	const result = prepareMacosFullStealthHelper({
		platform: "darwin",
		packageDir: "/tmp/helper-package",
		shouldBuild: true,
		shouldCodesign: false,
		commandExists: () => false,
		logFn: () => {},
	});

	assert.equal(result.skipped, true);
	assert.match(result.reason ?? "", /Swift toolchain unavailable/);
});

test("prepare-macos-full-stealth-helper can require Swift availability explicitly", () => {
	assert.throws(() => {
		prepareMacosFullStealthHelper({
			platform: "darwin",
			packageDir: "/tmp/helper-package",
			shouldBuild: true,
			shouldCodesign: false,
			requireHelper: true,
			commandExists: () => false,
			logFn: () => {},
		});
	}, /Swift toolchain unavailable/);
});

test("prepare-macos-full-stealth-helper plist content declares an application XPC service", () => {
	const plist = createInfoPlistContent("com.test.service");
	assert.match(plist, /CFBundleExecutable/);
	assert.match(plist, /macos-full-stealth-helper/);
	assert.match(plist, /XPCService/);
	assert.match(plist, /ServiceType/);
	assert.match(plist, /Application/);
});

test("package.json mac build config stages the full stealth helper into Contents/XPCServices", () => {
	assert.match(
		packageJson.scripts["prepare:macos:full-stealth-helper"],
		/prepare-macos-full-stealth-helper\.js/,
	);
	assert.match(
		packageJson.scripts["app:build"],
		/prepare:macos:full-stealth-helper/,
	);
	assert.match(
		packageJson.scripts["app:build:arm64"],
		/prepare:macos:full-stealth-helper/,
	);
	assert.match(
		packageJson.scripts["app:build:x64"],
		/prepare:macos:full-stealth-helper/,
	);

	const extraFiles = packageJson.build.extraFiles ?? [];
	assert.deepEqual(
		extraFiles.some(
			(entry) =>
				entry.from === "assets/xpcservices/macos-full-stealth-helper.xpc" &&
				entry.to === "XPCServices/macos-full-stealth-helper.xpc",
		),
		true,
	);
});
