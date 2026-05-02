import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
	analyzeCanaryVisibility,
	type CaptureAdapterSession,
	type CaptureMatrixAdapter,
	type CaptureMatrixArtifact,
	type CaptureMatrixRow,
	type CaptureMatrixRowResult,
	validateCaptureMatrixRow,
} from "./CaptureMatrixHarness";
import {
	type CanaryPixelDetectionResult,
	detectCanaryMarkerInImage,
} from "./CaptureMatrixLocalAdapters";

export interface ExternalCaptureResult {
	capturePath: string;
	log?: string;
	externalAppVersion?: string;
	externalCaptureMode?: string;
}

export type BrowserGetDisplayMediaRunner = (
	row: CaptureMatrixRow,
	artifactDir: string,
	testPagePath: string,
) => Promise<ExternalCaptureResult>;

export type ManualArtifactResolver = (
	row: CaptureMatrixRow,
	artifactDir: string,
) => Promise<ExternalCaptureResult | null>;

export interface BrowserGetDisplayMediaAdapterOptions {
	platform?: NodeJS.Platform;
	enabled?: boolean;
	testPagePath?: string;
	runner?: BrowserGetDisplayMediaRunner;
	detector?: typeof detectCanaryMarkerInImage;
}

export interface ManualExternalCaptureAdapterOptions {
	platform?: NodeJS.Platform;
	artifactResolver?: ManualArtifactResolver;
	detector?: typeof detectCanaryMarkerInImage;
	versionResolver?: (row: CaptureMatrixRow) => string | undefined;
}

interface ExternalCaptureSession extends CaptureAdapterSession {
	artifactDir: string;
}

export class BrowserGetDisplayMediaAdapter implements CaptureMatrixAdapter {
	readonly name = "browser-get-display-media";
	private readonly platform: NodeJS.Platform;
	private readonly enabled: boolean;
	private readonly testPagePath: string;
	private readonly runner?: BrowserGetDisplayMediaRunner;
	private readonly detect: typeof detectCanaryMarkerInImage;

	constructor(options: BrowserGetDisplayMediaAdapterOptions = {}) {
		this.platform = options.platform ?? process.platform;
		this.enabled =
			options.enabled ??
			process.env.NATIVELY_CAPTURE_MATRIX_ENABLE_BROWSER_GDM === "1";
		this.testPagePath =
			options.testPagePath ??
			path.resolve(
				"stealth-projects/integration-harness/capture-matrix/browser/get-display-media.html",
			);
		this.runner = options.runner;
		this.detect = options.detector ?? detectCanaryMarkerInImage;
	}

	async prepare(row: CaptureMatrixRow): Promise<void> {
		assertValidRow(row);
		if (row.mode !== "browser") {
			throw new Error(
				`browser getDisplayMedia adapter requires browser mode, got ${row.mode}`,
			);
		}
	}

	async startCapture(row: CaptureMatrixRow): Promise<ExternalCaptureSession> {
		return {
			id: `browser-gdm-${row.id}`,
			artifactDir: await mkdtemp(
				path.join(os.tmpdir(), `capture-matrix-browser-${row.id}-`),
			),
		};
	}

	async triggerVisibility(
		_row: CaptureMatrixRow,
		_session: CaptureAdapterSession,
	): Promise<void> {
		return;
	}

	async collectArtifact(
		row: CaptureMatrixRow,
		session: CaptureAdapterSession,
	): Promise<CaptureMatrixArtifact> {
		const externalSession = asExternalCaptureSession(session);
		const baseMetadata = this.createMetadata(row);
		if (!this.enabled) {
			return {
				canaryVisible: false,
				log: "browser getDisplayMedia adapter is explicit opt-in; set NATIVELY_CAPTURE_MATRIX_ENABLE_BROWSER_GDM=1 for release qualification",
				metadata: { ...baseMetadata, artifactProvided: false },
			};
		}
		if (!this.runner) {
			return {
				canaryVisible: false,
				log: "browser getDisplayMedia runner is not configured; provide a Playwright runner for release qualification",
				metadata: { ...baseMetadata, artifactProvided: false },
			};
		}

		const capture = await this.runner(
			row,
			externalSession.artifactDir,
			this.testPagePath,
		);
		const detection = await this.detect(capture.capturePath);
		return {
			canaryVisible: detection.visible,
			capturePath: capture.capturePath,
			log: createDetectionLog(session.id, capture, detection),
			metadata: {
				...baseMetadata,
				artifactProvided: true,
				testPagePath: this.testPagePath,
				externalAppVersion:
					capture.externalAppVersion ?? baseMetadata.externalAppVersion,
				externalCaptureMode:
					capture.externalCaptureMode ?? baseMetadata.externalCaptureMode,
			},
		};
	}

	async analyze(
		row: CaptureMatrixRow,
		artifact: CaptureMatrixArtifact,
	): Promise<
		Pick<CaptureMatrixRowResult, "actualResult" | "passed" | "reason">
	> {
		if (artifact.metadata?.artifactProvided !== true) {
			return {
				actualResult: "skipped",
				passed: false,
				reason: artifact.log,
			};
		}
		return analyzeCanaryVisibility(row, artifact.canaryVisible);
	}

	async cleanup(
		_row: CaptureMatrixRow,
		_session: CaptureAdapterSession,
	): Promise<void> {
		return;
	}

	private createMetadata(row: CaptureMatrixRow): Record<string, unknown> {
		return {
			platform: this.platform,
			externalAppName: row.externalAppName ?? "Chromium",
			externalAppVersion: row.externalAppVersion ?? "unknown",
			externalCaptureMode: row.externalCaptureMode ?? "getDisplayMedia",
		};
	}
}

export class ManualExternalCaptureAdapter implements CaptureMatrixAdapter {
	readonly name = "manual-external-capture";
	private readonly platform: NodeJS.Platform;
	private readonly artifactResolver?: ManualArtifactResolver;
	private readonly detect: typeof detectCanaryMarkerInImage;
	private readonly versionResolver?: (
		row: CaptureMatrixRow,
	) => string | undefined;

	constructor(options: ManualExternalCaptureAdapterOptions = {}) {
		this.platform = options.platform ?? process.platform;
		this.artifactResolver = options.artifactResolver;
		this.detect = options.detector ?? detectCanaryMarkerInImage;
		this.versionResolver = options.versionResolver;
	}

	async prepare(row: CaptureMatrixRow): Promise<void> {
		assertValidRow(row);
		if (row.mode !== "manual") {
			throw new Error(
				`manual external adapter requires manual mode, got ${row.mode}`,
			);
		}
	}

	async startCapture(row: CaptureMatrixRow): Promise<ExternalCaptureSession> {
		return {
			id: `manual-external-${row.id}`,
			artifactDir: await mkdtemp(
				path.join(os.tmpdir(), `capture-matrix-manual-${row.id}-`),
			),
		};
	}

	async triggerVisibility(
		_row: CaptureMatrixRow,
		_session: CaptureAdapterSession,
	): Promise<void> {
		return;
	}

	async collectArtifact(
		row: CaptureMatrixRow,
		session: CaptureAdapterSession,
	): Promise<CaptureMatrixArtifact> {
		const externalSession = asExternalCaptureSession(session);
		const baseMetadata = this.createMetadata(row);
		const capture = this.artifactResolver
			? await this.artifactResolver(row, externalSession.artifactDir)
			: null;

		if (!capture) {
			return {
				canaryVisible: false,
				log: [
					"manual external capture artifact is missing",
					`externalAppName=${baseMetadata.externalAppName}`,
					`externalAppVersion=${baseMetadata.externalAppVersion}`,
					`externalCaptureMode=${baseMetadata.externalCaptureMode}`,
				].join("\n"),
				metadata: { ...baseMetadata, artifactProvided: false },
			};
		}

		const detection = await this.detect(capture.capturePath);
		return {
			canaryVisible: detection.visible,
			capturePath: capture.capturePath,
			log: createDetectionLog(session.id, capture, detection),
			metadata: {
				...baseMetadata,
				artifactProvided: true,
				externalAppVersion:
					capture.externalAppVersion ?? baseMetadata.externalAppVersion,
				externalCaptureMode:
					capture.externalCaptureMode ?? baseMetadata.externalCaptureMode,
			},
		};
	}

	async analyze(
		row: CaptureMatrixRow,
		artifact: CaptureMatrixArtifact,
	): Promise<
		Pick<CaptureMatrixRowResult, "actualResult" | "passed" | "reason">
	> {
		if (artifact.metadata?.artifactProvided !== true) {
			return {
				actualResult: "skipped",
				passed: false,
				reason: "manual external capture artifact is missing",
			};
		}
		return analyzeCanaryVisibility(row, artifact.canaryVisible);
	}

	async cleanup(
		_row: CaptureMatrixRow,
		_session: CaptureAdapterSession,
	): Promise<void> {
		return;
	}

	private createMetadata(row: CaptureMatrixRow): Record<string, unknown> {
		return {
			platform: this.platform,
			externalAppName: row.externalAppName ?? row.captureTool,
			externalAppVersion:
				this.versionResolver?.(row) ?? row.externalAppVersion ?? "unknown",
			externalCaptureMode: row.externalCaptureMode ?? "manual-screen-share",
		};
	}
}

export function createDefaultBrowserGetDisplayMediaRows(
	input: {
		platform?: NodeJS.Platform | "unknown";
		osVersion?: string;
		appVersion?: string;
		strict?: boolean;
	} = {},
): CaptureMatrixRow[] {
	return createExternalRows({
		...input,
		captureTool: "chromium-get-display-media",
		mode: "browser",
		externalAppName: "Chromium",
		externalAppVersion: "unknown",
		externalCaptureMode: "getDisplayMedia",
		protectedId: "chromium-gdm-protected",
		controlId: "chromium-gdm-control",
	});
}

export function createDefaultMeetingAppRows(
	input: {
		platform?: NodeJS.Platform | "unknown";
		osVersion?: string;
		appVersion?: string;
		strict?: boolean;
		externalApps?: Array<{
			name: string;
			captureTool: string;
			version?: string;
			captureMode: string;
		}>;
	} = {},
): CaptureMatrixRow[] {
	const apps = input.externalApps ?? [
		{
			name: "Zoom",
			captureTool: "zoom-screen-share",
			captureMode: "screen-share",
		},
		{
			name: "Google Meet",
			captureTool: "google-meet-screen-share",
			captureMode: "browser-screen-share",
		},
		{
			name: "Microsoft Teams",
			captureTool: "microsoft-teams-screen-share",
			captureMode: "screen-share",
		},
		{
			name: "OBS Studio",
			captureTool: "obs-display-capture",
			captureMode: "display-capture",
		},
	];

	return apps.flatMap((app) =>
		createExternalRows({
			...input,
			captureTool: app.captureTool,
			mode: "manual",
			externalAppName: app.name,
			externalAppVersion: app.version ?? "unknown",
			externalCaptureMode: app.captureMode,
			protectedId: `${slugify(app.name)}-protected`,
			controlId: `${slugify(app.name)}-control`,
		}),
	);
}

function createExternalRows(input: {
	platform?: NodeJS.Platform | "unknown";
	osVersion?: string;
	appVersion?: string;
	strict?: boolean;
	captureTool: string;
	mode: CaptureMatrixRow["mode"];
	externalAppName: string;
	externalAppVersion: string;
	externalCaptureMode: string;
	protectedId: string;
	controlId: string;
}): CaptureMatrixRow[] {
	const platform = input.platform ?? process.platform;
	const osVersion = input.osVersion ?? `${os.type()} ${os.release()}`;
	const appVersion =
		input.appVersion ?? process.env.NATIVELY_APP_VERSION ?? "local-dev";
	const strict = input.strict ?? true;

	return [
		{
			id: input.protectedId,
			platform,
			osVersion,
			appVersion,
			captureTool: input.captureTool,
			mode: input.mode,
			monitors: 1,
			strict,
			surface: "protected-canary-surface",
			expectedResult: "hidden",
			canaryToken: "NATIVELY_CAPTURE_CANARY_PROTECTED",
			externalAppName: input.externalAppName,
			externalAppVersion: input.externalAppVersion,
			externalCaptureMode: input.externalCaptureMode,
		},
		{
			id: input.controlId,
			platform,
			osVersion,
			appVersion,
			captureTool: input.captureTool,
			mode: input.mode,
			monitors: 1,
			strict: false,
			surface: "unprotected-canary-control",
			expectedResult: "visible",
			canaryToken: "NATIVELY_CAPTURE_CANARY_CONTROL",
			externalAppName: input.externalAppName,
			externalAppVersion: input.externalAppVersion,
			externalCaptureMode: input.externalCaptureMode,
		},
	];
}

function assertValidRow(row: CaptureMatrixRow): void {
	const errors = validateCaptureMatrixRow(row);
	if (errors.length > 0) {
		throw new Error(
			`invalid capture matrix row ${row.id || "<missing>"}: ${errors.join(", ")}`,
		);
	}
}

function asExternalCaptureSession(
	session: CaptureAdapterSession,
): ExternalCaptureSession {
	const externalSession = session as Partial<ExternalCaptureSession>;
	if (!externalSession.artifactDir) {
		throw new Error(
			`capture session ${session.id} does not include an artifact directory`,
		);
	}
	return externalSession as ExternalCaptureSession;
}

function createDetectionLog(
	sessionId: string,
	capture: ExternalCaptureResult,
	detection: CanaryPixelDetectionResult,
): string {
	return [
		`session=${sessionId}`,
		capture.log ?? "",
		`capture=${capture.capturePath}`,
		`externalAppVersion=${capture.externalAppVersion ?? "unknown"}`,
		`externalCaptureMode=${capture.externalCaptureMode ?? "unknown"}`,
		`primaryPixels=${detection.primaryPixels}`,
		`secondaryPixels=${detection.secondaryPixels}`,
		`markerRatio=${detection.markerRatio}`,
		`visible=${detection.visible}`,
	]
		.filter(Boolean)
		.join("\n");
}

function slugify(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "");
}
