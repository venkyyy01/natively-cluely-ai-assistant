import fs from "node:fs";
import path from "node:path";

interface ResolveFoundationIntentHelperOptions {
	env?: NodeJS.ProcessEnv;
	cwd?: string;
	resourcesPath?: string;
	pathExists?: (candidate: string) => boolean;
}

function isEnvFlagEnabled(value: string | undefined): boolean {
	if (value === undefined) {
		return false;
	}

	const normalized = value.trim().toLowerCase();
	return ["1", "true", "yes", "on"].includes(normalized);
}

export function resolveFoundationModelsIntentHelperPath(
	options: ResolveFoundationIntentHelperOptions = {},
): string | null {
	const env = options.env ?? process.env;
	const cwd = options.cwd ?? process.cwd();
	const resourcesPath = options.resourcesPath ?? process.resourcesPath;
	const pathExists =
		options.pathExists ??
		((candidate: string): boolean => fs.existsSync(candidate));

	if (isEnvFlagEnabled(env.NATIVELY_DISABLE_MACOS_FOUNDATION_INTENT_HELPER)) {
		return null;
	}

	const envOverride = env.NATIVELY_MACOS_FOUNDATION_INTENT_HELPER;
	if (envOverride && pathExists(envOverride)) {
		return envOverride;
	}

	const candidates = [
		...(resourcesPath
			? [path.join(resourcesPath, "bin", "macos", "foundation-intent-helper")]
			: []),
		path.join(cwd, "assets", "bin", "macos", "foundation-intent-helper"),
		path.join(
			cwd,
			"applesilicon",
			"macos-foundation-intent-helper",
			".build",
			"debug",
			"foundation-intent-helper",
		),
		path.join(
			cwd,
			"applesilicon",
			"macos-foundation-intent-helper",
			".build",
			"release",
			"foundation-intent-helper",
		),
		path.join(
			cwd,
			"applesilicon",
			"macos-foundation-intent-helper",
			".build",
			"arm64-apple-macosx",
			"debug",
			"foundation-intent-helper",
		),
		path.join(
			cwd,
			"applesilicon",
			"macos-foundation-intent-helper",
			".build",
			"arm64-apple-macosx",
			"release",
			"foundation-intent-helper",
		),
		path.join(
			cwd,
			"applesilicon",
			"macos-foundation-intent-helper",
			".build",
			"x86_64-apple-macosx",
			"debug",
			"foundation-intent-helper",
		),
		path.join(
			cwd,
			"applesilicon",
			"macos-foundation-intent-helper",
			".build",
			"x86_64-apple-macosx",
			"release",
			"foundation-intent-helper",
		),
	];

	return candidates.find((candidate) => pathExists(candidate)) ?? null;
}
