const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

// ─── Helper Disguise Configuration ───
// Display name used for helper processes in Activity Monitor
const DISGUISE_BASE = "CoreServices";

const HELPER_SUFFIXES = ["", " (GPU)", " (Renderer)", " (Plugin)"];

/**
 * Update the display names inside each helper's Info.plist so Activity Monitor
 * shows "CoreServices Helper" instead of "Natively Helper".
 *
 * IMPORTANT: We only modify CFBundleDisplayName and CFBundleName.
 * We do NOT rename the .app folders or the executable binaries — doing so
 * would break Electron's internal process spawning (Chromium hardcodes the
 * helper paths based on productName).
 */
function disguiseHelperPlists(appOutDir, appName) {
	const frameworksDir = path.join(
		appOutDir,
		`${appName}.app`,
		"Contents",
		"Frameworks",
	);

	if (!fs.existsSync(frameworksDir)) {
		console.log("[Helper Disguise] Frameworks directory not found, skipping.");
		return;
	}

	for (const suffix of HELPER_SUFFIXES) {
		const helperName = `${appName} Helper${suffix}`;
		const disguisedName = `${DISGUISE_BASE} Helper${suffix}`;
		const helperAppPath = path.join(frameworksDir, `${helperName}.app`);
		const plistPath = path.join(helperAppPath, "Contents", "Info.plist");

		if (!fs.existsSync(plistPath)) {
			console.log(`[Helper Disguise] Skipping (not found): ${helperName}.app`);
			continue;
		}

		console.log(
			`[Helper Disguise] ${helperName} → display as "${disguisedName}"`,
		);

		try {
			// Update CFBundleDisplayName (Activity Monitor display)
			execSync(
				`/usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName '${disguisedName}'" "${plistPath}"`,
				{ stdio: "pipe" },
			);
			// Update CFBundleName (Dock / menu bar fallback)
			execSync(
				`/usr/libexec/PlistBuddy -c "Set :CFBundleName '${disguisedName}'" "${plistPath}"`,
				{ stdio: "pipe" },
			);
		} catch (err) {
			console.warn(
				`[Helper Disguise] PlistBuddy warning for ${helperName}:`,
				err.message,
			);
		}
	}

	console.log("[Helper Disguise] All helper plists updated successfully.");
}

exports.default = async (context) => {
	const targetPlatform =
		context.electronPlatformName ?? context.packager?.platform?.name;

	// Only process packaged macOS app bundles.
	if (process.platform !== "darwin" || targetPlatform !== "darwin") {
		return;
	}

	const appOutDir = context.appOutDir;
	const appName = context.packager.appInfo.productFilename;
	const appPath = path.join(appOutDir, `${appName}.app`);
	const helperPath = [
		path.join(
			appPath,
			"Contents",
			"Resources",
			"bin",
			"macos",
			"system-services-helper",
		),
		path.join(
			appPath,
			"Contents",
			"Resources",
			"bin",
			"macos",
			"stealth-virtual-display-helper",
		),
	].find((candidate) => fs.existsSync(candidate));
	const foundationIntentHelperPath = path.join(
		appPath,
		"Contents",
		"Resources",
		"bin",
		"macos",
		"foundation-intent-helper",
	);
	const fullStealthHelperBundlePath = path.join(
		appPath,
		"Contents",
		"XPCServices",
		"macos-full-stealth-helper.xpc",
	);

	// ── Step 1: Disguise helper display names (before signing) ──
	try {
		disguiseHelperPlists(appOutDir, appName);
	} catch (error) {
		console.error("[Helper Disguise] Failed to update helper plists:", error);
		// Non-fatal: continue to signing
	}

	// ── Step 2: Ad-hoc sign the application ──
	// Resolve the path to the entitlements file so V8 gets JIT memory permissions
	const entitlementsPath = path.join(
		context.packager.info.projectDir,
		"assets",
		"entitlements.mac.plist",
	);
	console.log(
		`[Ad-Hoc Signing] Signing ${appPath} with entitlements from ${entitlementsPath}...`,
	);

	try {
		if (helperPath) {
			console.log(`[Ad-Hoc Signing] Signing helper binary ${helperPath}...`);
			execSync(`codesign --force --sign - "${helperPath}"`, {
				stdio: "inherit",
			});
		}

		if (fs.existsSync(fullStealthHelperBundlePath)) {
			console.log(
				`[Ad-Hoc Signing] Signing XPC helper bundle ${fullStealthHelperBundlePath}...`,
			);
			execSync(
				`codesign --force --entitlements "${entitlementsPath}" --sign - "${fullStealthHelperBundlePath}"`,
				{ stdio: "inherit" },
			);
		}

		if (fs.existsSync(foundationIntentHelperPath)) {
			console.log(
				`[Ad-Hoc Signing] Signing foundation intent helper ${foundationIntentHelperPath}...`,
			);
			execSync(
				`codesign --force --entitlements "${entitlementsPath}" --sign - "${foundationIntentHelperPath}"`,
				{ stdio: "inherit" },
			);
		}

		// --force: replace existing signature
		// --deep: sign nested code
		// --entitlements: attach JIT/memory entitlements (critical for Apple Silicon)
		// --sign -: ad-hoc signature
		execSync(
			`codesign --force --deep --entitlements "${entitlementsPath}" --sign - "${appPath}"`,
			{ stdio: "inherit" },
		);
		console.log(
			"[Ad-Hoc Signing] Successfully signed the application with entitlements.",
		);
	} catch (error) {
		console.error("[Ad-Hoc Signing] Failed to sign the application:", error);
		throw error;
	}
};
