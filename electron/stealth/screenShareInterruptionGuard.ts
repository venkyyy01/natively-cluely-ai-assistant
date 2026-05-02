import { execFile } from "node:child_process";

export interface ExternalScreenShareSnapshot {
	active: boolean;
	reason: string;
	processLines: string[];
}

export interface ExternalScreenShareDetectionOptions {
	platform?: NodeJS.Platform | string;
	processEnumerator?: (command: string, args: string[]) => Promise<string>;
}

const EXTERNAL_CAPTURE_APP_PATTERN =
	"Google Chrome|Chromium|Microsoft Edge|Brave Browser|Microsoft Teams|teams2|zoom\\.us|Slack|Webex|Loom|Discord";

function defaultProcessEnumerator(
	command: string,
	args: string[],
): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(command, args, (error, stdout) => {
			if (!error) {
				resolve(stdout);
				return;
			}

			const err = error as NodeJS.ErrnoException & { code?: number };
			if (command === "pgrep" && err.code === 1) {
				resolve("");
				return;
			}

			reject(error);
		});
	});
}

function splitProcessLines(stdout: string): string[] {
	return stdout
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
}

export async function detectExternalScreenShare(
	options: ExternalScreenShareDetectionOptions = {},
): Promise<ExternalScreenShareSnapshot> {
	const platform = options.platform ?? process.platform;
	if (platform !== "darwin") {
		return { active: false, reason: "unsupported-platform", processLines: [] };
	}

	const processEnumerator =
		options.processEnumerator ?? defaultProcessEnumerator;
	const captureAgentLines = splitProcessLines(
		await processEnumerator("pgrep", ["-lf", "ScreenCaptureAgent"]),
	);

	if (captureAgentLines.length === 0) {
		return {
			active: false,
			reason: "no-screen-capture-agent",
			processLines: [],
		};
	}

	const externalAppLines = splitProcessLines(
		await processEnumerator("pgrep", ["-lf", EXTERNAL_CAPTURE_APP_PATTERN]),
	);

	return {
		active: true,
		reason:
			externalAppLines.length > 0
				? "screen-capture-agent-with-meeting-app"
				: "screen-capture-agent-active",
		processLines: [...captureAgentLines, ...externalAppLines],
	};
}

export function resolveSafeSystemAudioDeviceId(
	requestedDeviceId: string | undefined,
	snapshot: ExternalScreenShareSnapshot,
): string | undefined {
	if (!snapshot.active || requestedDeviceId !== "sck") {
		return requestedDeviceId;
	}

	return undefined;
}
