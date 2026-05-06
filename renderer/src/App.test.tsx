import { screen } from "@testing-library/react";
import { act } from "react";
import {
	getProfileToasterThresholdMs,
	getWindowAnalyticsPlan,
	resolveWindowContext,
	shouldListenForOverlayOpacity,
} from "../../src/appBootstrap";

describe("shared App bootstrap ownership", () => {
	test("defaults unknown or empty searches to the launcher window context", () => {
		expect(resolveWindowContext("")).toEqual({
			kind: "launcher",
			isDefaultLauncherWindow: true,
		});

		expect(resolveWindowContext("?window=unknown")).toEqual({
			kind: "launcher",
			isDefaultLauncherWindow: true,
		});

		expect(resolveWindowContext("?window=launcher")).toEqual({
			kind: "launcher",
			isDefaultLauncherWindow: false,
		});
	});

	test("keeps helper windows out of launcher analytics", () => {
		expect(
			getWindowAnalyticsPlan(resolveWindowContext("?window=settings")),
		).toEqual({
			trackAppLifecycle: false,
			trackAssistantLifecycle: false,
		});

		expect(
			getWindowAnalyticsPlan(resolveWindowContext("?window=model-selector")),
		).toEqual({
			trackAppLifecycle: false,
			trackAssistantLifecycle: false,
		});
	});

	test("routes overlay-specific lifecycle ownership through the overlay context only", () => {
		const overlayContext = resolveWindowContext("?window=overlay");

		expect(getWindowAnalyticsPlan(overlayContext)).toEqual({
			trackAppLifecycle: false,
			trackAssistantLifecycle: true,
		});
		expect(shouldListenForOverlayOpacity(overlayContext)).toBe(true);
		expect(
			shouldListenForOverlayOpacity(resolveWindowContext("?window=settings")),
		).toBe(false);
	});

	test("uses shorter meeting thresholds only in development builds", () => {
		expect(getProfileToasterThresholdMs("development")).toBe(10000);
		expect(getProfileToasterThresholdMs("production")).toBe(180000);
	});

	test("mounts the App component from the renderer entry path", async () => {
		document.body.innerHTML = '<div id="root"></div>';

		await act(async () => {
			await import("./index");
		});

		expect(
			screen.getByRole("link", { name: /learn react/i }),
		).toBeInTheDocument();
	});
});
