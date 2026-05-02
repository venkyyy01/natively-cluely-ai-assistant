const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const root = path.resolve(__dirname, "..");
const packageDir = path.join(
	root,
	"stealth-projects",
	"macos-virtual-display-helper",
);
const outputDir = path.join(root, "assets", "bin", "macos");
const outputBinary = path.join(outputDir, "system-services-helper");

function log(message) {
	process.stdout.write(`[prepare-macos-virtual-display-helper] ${message}\n`);
}

function pathExists(candidate) {
	try {
		fs.accessSync(candidate, fs.constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

function signBinary(binaryPath) {
	const identity = process.env.CODESIGN_IDENTITY || "-";
	const entitlementsPath = path.join(packageDir, "entitlements.plist");

	if (!pathExists(entitlementsPath)) {
		log("Warning: entitlements.plist not found, skipping signing");
		return false;
	}

	try {
		const args = [
			"--sign",
			identity,
			"--force",
			"--options",
			"runtime",
			"--entitlements",
			entitlementsPath,
			binaryPath,
		];
		execFileSync("codesign", args, { stdio: "inherit" });
		log(`Signed ${binaryPath} with entitlements`);
		return true;
	} catch (error) {
		log(`Warning: codesign failed: ${error.message}`);
		return false;
	}
}

function findBuiltBinary(configuration) {
	const candidates = [
		path.join(
			packageDir,
			".build",
			configuration,
			"stealth-virtual-display-helper",
		),
		path.join(
			packageDir,
			".build",
			"arm64-apple-macosx",
			configuration,
			"stealth-virtual-display-helper",
		),
		path.join(
			packageDir,
			".build",
			"x86_64-apple-macosx",
			configuration,
			"stealth-virtual-display-helper",
		),
	];
	return candidates.find(pathExists);
}

function main() {
	if (process.platform !== "darwin") {
		log("Skipping helper build on non-macOS host");
		return;
	}

	const configuration =
		process.env.MACOS_VIRTUAL_DISPLAY_HELPER_CONFIGURATION || "release";
	log(`Building macOS virtual display helper (${configuration})`);
	execFileSync(
		"swift",
		["build", "-c", configuration, "--package-path", packageDir],
		{
			cwd: root,
			stdio: "inherit",
		},
	);

	const builtBinary = findBuiltBinary(configuration);
	if (!builtBinary) {
		throw new Error(
			`Unable to locate built helper binary for configuration '${configuration}'`,
		);
	}

	fs.mkdirSync(outputDir, { recursive: true });
	fs.copyFileSync(builtBinary, outputBinary);
	fs.chmodSync(outputBinary, 0o755);
	log(`Prepared helper at ${outputBinary}`);

	if (process.env.SKIP_CODESIGN !== "1") {
		signBinary(outputBinary);
	}
}

main();
