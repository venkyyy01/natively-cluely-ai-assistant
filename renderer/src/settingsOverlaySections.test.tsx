import fs from "node:fs";
import path from "node:path";

const settingsOverlayPath = path.resolve(
	__dirname,
	"../../src/components/SettingsOverlay.tsx",
);

const readSettingsOverlay = () => fs.readFileSync(settingsOverlayPath, "utf8");

test("keeps the extracted speech provider section wired into the audio tab", () => {
	const source = readSettingsOverlay();

	expect(source).toContain(
		"import { SpeechProviderSection } from './settings/SpeechProviderSection';",
	);
	expect(source).toContain("<SpeechProviderSection");
});

test("wires the general tab through the extracted general settings section", () => {
	const source = readSettingsOverlay();

	expect(source).toContain(
		"import { GeneralSettingsSection } from './settings/GeneralSettingsSection';",
	);
	expect(source).toContain("<GeneralSettingsSection");
});

test("keeps first-setup STT provider selection local until credentials are configured", () => {
	const source = readSettingsOverlay();

	expect(source).toContain("if (!hasConfiguredSttProvider(provider)) {");
	expect(source).toContain("if (sttProviderRef.current === provider) {");
	expect(source).toContain("await persistSttProvider(provider);");
	expect(source).toContain(
		"const handleGoogleServiceAccountSelected = React.useCallback",
	);
});
