import fs from "node:fs";
import path from "node:path";

const helperPath = path.resolve(__dirname, "../../src/lib/electronApi.ts");
const preloadApiPath = path.resolve(__dirname, "../../electron/preload/api.ts");
const generalSettingsPath = path.resolve(
	__dirname,
	"../../src/components/settings/GeneralSettingsSection.tsx",
);
const settingsPopupPath = path.resolve(
	__dirname,
	"../../src/components/SettingsPopup.tsx",
);
const launcherPath = path.resolve(
	__dirname,
	"../../src/components/Launcher.tsx",
);
const appPath = path.resolve(__dirname, "../../src/App.tsx");

test("electron API helper provides a restart hint when a preload method is missing", () => {
	const source = fs.readFileSync(helperPath, "utf8");

	expect(source).toContain("requireElectronMethod");
	expect(source).toContain("getOptionalElectronMethod");
	expect(source).toContain(
		"Restart the app or Electron dev process to reload the preload bridge",
	);
});

test("settings toggles use the guarded Electron bridge helper for conscious mode and undetectable mode", () => {
	const generalSettingsSource = fs.readFileSync(generalSettingsPath, "utf8");
	const settingsPopupSource = fs.readFileSync(settingsPopupPath, "utf8");
	const launcherSource = fs.readFileSync(launcherPath, "utf8");

	expect(generalSettingsSource).toContain(
		"requireElectronMethod(\"setUndetectable\")",
	);
	expect(generalSettingsSource).toContain(
		"requireElectronMethod(\"setConsciousMode\")",
	);
	expect(settingsPopupSource).toContain(
		"requireElectronMethod(\"setUndetectable\")",
	);
	expect(settingsPopupSource).toContain(
		"requireElectronMethod(\"setConsciousMode\")",
	);
	expect(launcherSource).toContain("requireElectronMethod(\"setUndetectable\")");
});

test("meeting start paths use the guarded Electron bridge helper", () => {
	const launcherSource = fs.readFileSync(launcherPath, "utf8");
	const appSource = fs.readFileSync(appPath, "utf8");

	expect(launcherSource).toContain("requireElectronMethod(\"startMeeting\")");
	expect(appSource).toContain("requireElectronMethod(\"startMeeting\")");
});

test("privacy shield state is exposed through preload and hydrated on app boot", () => {
	const preloadSource = fs.readFileSync(preloadApiPath, "utf8");
	const appSource = fs.readFileSync(appPath, "utf8");

	expect(preloadSource).toContain("getPrivacyShieldState");
	expect(appSource).toContain(
		"\"getPrivacyShieldState\"",
	);
	expect(appSource).toContain("getPrivacyShieldState?.()");
	expect(appSource).toContain(
		"\"onPrivacyShieldChanged\"",
	);
});
