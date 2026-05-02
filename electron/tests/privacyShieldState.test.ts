import assert from "node:assert/strict";
import test from "node:test";

import { derivePrivacyShieldState } from "../stealth/privacyShieldState";

test("PrivacyShieldState activates when capture-risk warnings are present", () => {
	assert.deepEqual(
		derivePrivacyShieldState({ warnings: ["chromium_capture_active"] }),
		{
			active: true,
			reason: "Sensitive content hidden while capture risk is detected.",
		},
	);
});

test("PrivacyShieldState treats SCStream and persistent capture-tool warnings as capture-risk warnings", () => {
	assert.deepEqual(
		derivePrivacyShieldState({ warnings: ["scstream_capture_detected"] }),
		{
			active: true,
			reason: "Sensitive content hidden while capture risk is detected.",
		},
	);

	assert.deepEqual(
		derivePrivacyShieldState({ warnings: ["capture_tools_still_running"] }),
		{
			active: true,
			reason: "Sensitive content hidden while capture risk is detected.",
		},
	);
});

test("PrivacyShieldState activates on stealth faults until protection is restored", () => {
	assert.deepEqual(
		derivePrivacyShieldState({ faultReason: "stealth heartbeat missed" }),
		{
			active: true,
			reason: "Sensitive content hidden until privacy protection is restored.",
		},
	);
});

test("PrivacyShieldState activates while startup visibility intent is protected", () => {
	assert.deepEqual(
		derivePrivacyShieldState({ visibilityIntent: "protected_shield" }),
		{
			active: true,
			reason: "Sensitive content hidden while privacy mode is active.",
		},
	);
});

test("PrivacyShieldState keeps local controls visible for invisible mode safe-controls intent", () => {
	assert.deepEqual(
		derivePrivacyShieldState({
			visibilityIntent: "visible_safe_controls",
			captureProtectionEnabled: true,
		}),
		{
			active: false,
			reason: null,
		},
	);
});

test("PrivacyShieldState activates for enhanced stealth degradation warnings", () => {
	assert.deepEqual(
		derivePrivacyShieldState({ warnings: ["private_api_failed"] }),
		{
			active: true,
			reason: "Sensitive content hidden while capture risk is detected.",
		},
	);

	assert.deepEqual(
		derivePrivacyShieldState({ warnings: ["virtual_display_failed"] }),
		{
			active: true,
			reason: "Sensitive content hidden while capture risk is detected.",
		},
	);

	assert.deepEqual(
		derivePrivacyShieldState({ warnings: ["virtual_display_exhausted"] }),
		{
			active: true,
			reason: "Sensitive content hidden while capture risk is detected.",
		},
	);
});

test("PrivacyShieldState ignores unrelated non-capture warnings", () => {
	assert.deepEqual(
		derivePrivacyShieldState({ warnings: ["unrelated_warning"] }),
		{
			active: false,
			reason: null,
		},
	);
});

test("PrivacyShieldState ignores capture-risk warnings when capture protection is disabled", () => {
	assert.deepEqual(
		derivePrivacyShieldState({
			warnings: ["window_visible_to_capture"],
			captureProtectionEnabled: false,
		}),
		{
			active: false,
			reason: null,
		},
	);
});

test("PrivacyShieldState prioritizes active faults over warning-derived reasons", () => {
	assert.deepEqual(
		derivePrivacyShieldState({
			faultReason: "stealth heartbeat missed",
			warnings: ["window_visible_to_capture"],
		}),
		{
			active: true,
			reason: "Sensitive content hidden until privacy protection is restored.",
		},
	);
});
