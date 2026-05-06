import fs from "fs";
import path from "path";

type ElectronApp = {
	isPackaged: boolean;
	getAppPath(): string;
};

function getElectronApp(): ElectronApp | null {
	try {
		const electron = require("electron") as { app?: ElectronApp };
		return electron.app ?? null;
	} catch {
		return null;
	}
}

function existingDir(paths: string[]): string {
	for (const candidate of paths) {
		if (fs.existsSync(candidate)) {
			return candidate;
		}
	}
	return paths[0];
}

export function resolveBundledModelsPath(): string {
	const app = getElectronApp();
	const candidates = app?.isPackaged
		? [path.join(process.resourcesPath, "models")]
		: [
				path.join(process.cwd(), "resources", "models"),
				...(app ? [path.join(app.getAppPath(), "resources", "models")] : []),
				path.join(__dirname, "..", "..", "resources", "models"),
				path.join(__dirname, "..", "..", "..", "resources", "models"),
			];

	return existingDir(candidates);
}

export function isElectronAppPackaged(): boolean {
	return getElectronApp()?.isPackaged ?? false;
}
