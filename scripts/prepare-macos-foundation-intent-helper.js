const fs = require("fs");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");

const root = path.resolve(__dirname, "..");
const defaultPackageDir = path.join(
	root,
	"applesilicon",
	"macos-foundation-intent-helper",
);
const defaultOutputDir = path.join(root, "assets", "bin", "macos");
const defaultOutputBinary = path.join(
	defaultOutputDir,
	"foundation-intent-helper",
);
const defaultEntitlementsPath = path.join(
	root,
	"assets",
	"entitlements.mac.plist",
);

function log(message) {
	process.stdout.write(`[prepare-macos-foundation-intent-helper] ${message}\n`);
}

function pathExists(candidate) {
	try {
		fs.accessSync(candidate, fs.constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

function isTruthyFlag(value) {
	if (typeof value !== "string") {
		return false;
	}

	return /^(1|true|yes|on)$/i.test(value.trim());
}

function commandExists(command, options = {}) {
	const spawn = options.spawn ?? spawnSync;
	const result = spawn(command, ["--version"], { stdio: "ignore" });
	return !result.error;
}

function findBuiltBinary(packageDir, configuration) {
	const candidates = [
		path.join(packageDir, ".build", configuration, "foundation-intent-helper"),
		path.join(
			packageDir,
			".build",
			"arm64-apple-macosx",
			configuration,
			"foundation-intent-helper",
		),
		path.join(
			packageDir,
			".build",
			"x86_64-apple-macosx",
			configuration,
			"foundation-intent-helper",
		),
	];

	return candidates.find(pathExists) ?? null;
}

function signBinary({
	binaryPath,
	entitlementsPath = defaultEntitlementsPath,
	identity = process.env.CODESIGN_IDENTITY || "-",
	execFile = execFileSync,
	logFn = log,
}) {
	if (!pathExists(entitlementsPath)) {
		logFn("Warning: entitlements file not found, skipping signing");
		return false;
	}

	try {
		execFile(
			"codesign",
			[
				"--sign",
				identity,
				"--force",
				"--options",
				"runtime",
				"--entitlements",
				entitlementsPath,
				binaryPath,
			],
			{ stdio: "inherit" },
		);
		logFn(`Signed ${binaryPath}`);
		return true;
	} catch (error) {
		logFn(`Warning: codesign failed: ${error.message}`);
		return false;
	}
}

function prepareMacosFoundationIntentHelper(options = {}) {
	const platform = options.platform ?? process.platform;
	const packageDir = options.packageDir ?? defaultPackageDir;
	const configuration =
		options.configuration ??
		process.env.MACOS_FOUNDATION_INTENT_HELPER_CONFIGURATION ??
		"release";
	const outputDir = options.outputDir ?? defaultOutputDir;
	const outputBinary = options.outputBinary ?? defaultOutputBinary;
	const execFile = options.execFile ?? execFileSync;
	const logFn = options.logFn ?? log;
	const shouldBuild = options.shouldBuild ?? true;
	const shouldCodesign =
		options.shouldCodesign ?? process.env.SKIP_CODESIGN !== "1";
	const entitlementsPath = options.entitlementsPath ?? defaultEntitlementsPath;
	const requireHelper =
		options.requireHelper ??
		isTruthyFlag(process.env.NATIVELY_REQUIRE_FOUNDATION_INTENT_HELPER ?? "");
	const commandExistsFn = options.commandExists ?? commandExists;

	const skipWithoutHelper = (reason) => {
		if (requireHelper) {
			throw new Error(reason);
		}

		logFn(
			`Warning: ${reason}. Continuing without foundation intent helper binary.`,
		);
		return {
			skipped: true,
			reason,
		};
	};

	if (platform !== "darwin") {
		logFn("Skipping helper build on non-macOS host");
		return { skipped: true };
	}

	let builtBinary =
		options.builtBinary ?? findBuiltBinary(packageDir, configuration);

	if (shouldBuild) {
		if (!commandExistsFn("swift")) {
			if (!builtBinary) {
				return skipWithoutHelper(
					"Swift toolchain unavailable; unable to build foundation intent helper",
				);
			}

			logFn(
				"Swift toolchain unavailable; using existing foundation intent helper build output",
			);
		} else {
			try {
				logFn(`Building macOS foundation intent helper (${configuration})`);
				execFile(
					"swift",
					["build", "-c", configuration, "--package-path", packageDir],
					{
						cwd: root,
						stdio: "inherit",
					},
				);
			} catch (error) {
				if (!builtBinary) {
					return skipWithoutHelper(
						`Swift build failed: ${error instanceof Error ? error.message : String(error)}`,
					);
				}

				logFn(
					`Warning: swift build failed, using existing helper binary: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
	}

	builtBinary =
		options.builtBinary ??
		findBuiltBinary(packageDir, configuration) ??
		builtBinary;
	if (!builtBinary) {
		return skipWithoutHelper(
			`Unable to locate built foundation intent helper for configuration '${configuration}'`,
		);
	}

	fs.mkdirSync(outputDir, { recursive: true });
	fs.copyFileSync(builtBinary, outputBinary);
	fs.chmodSync(outputBinary, 0o755);
	logFn(`Prepared helper at ${outputBinary}`);

	if (shouldCodesign) {
		signBinary({
			binaryPath: outputBinary,
			entitlementsPath,
			execFile,
			logFn,
		});
	}

	return {
		outputBinary,
	};
}

if (require.main === module) {
	try {
		prepareMacosFoundationIntentHelper();
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
}

module.exports = {
	commandExists,
	findBuiltBinary,
	isTruthyFlag,
	signBinary,
	prepareMacosFoundationIntentHelper,
};
