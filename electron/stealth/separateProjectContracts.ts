export type DeepStealthProject =
	| "macos-virtual-display-helper"
	| "windows-idd-driver"
	| "windows-protected-render-host"
	| "kernel-security-program"
	| "integration-harness";

export type DeepStealthProjectStatus =
	| "scaffolded"
	| "claim_defined"
	| "contract_defined"
	| "architecture_defined"
	| "validation_ready"
	| "release_ready"
	| "no_go"
	| "deferred";

export interface DeepStealthProjectRecord {
	project: DeepStealthProject;
	scaffolded: true;
	implementationReady: false;
	status: DeepStealthProjectStatus;
	ownerSurface: "electron-broker" | "native-runtime" | "deferred";
	nextStep: string;
}

export const DEEP_STEALTH_SCAFFOLDS: DeepStealthProjectRecord[] = [
	{
		project: "macos-virtual-display-helper",
		scaffolded: true,
		implementationReady: false,
		status: "contract_defined",
		ownerSurface: "native-runtime",
		nextStep:
			"Expand into the macOS secure presenter, CGVirtualDisplay/compositor path, and Layer 3 feasibility program.",
	},
	{
		project: "windows-idd-driver",
		scaffolded: true,
		implementationReady: false,
		status: "scaffolded",
		ownerSurface: "native-runtime",
		nextStep: "Create the UMDF2/IddCx driver solution and installer pipeline.",
	},
	{
		project: "windows-protected-render-host",
		scaffolded: true,
		implementationReady: false,
		status: "scaffolded",
		ownerSurface: "native-runtime",
		nextStep:
			"Build protected swap-chain capability detection and rendering path.",
	},
	{
		project: "kernel-security-program",
		scaffolded: true,
		implementationReady: false,
		status: "deferred",
		ownerSurface: "deferred",
		nextStep:
			"Deferred: revisit only after the macOS Layer 3 program completes and product requirements still demand Layer 4.",
	},
	{
		project: "integration-harness",
		scaffolded: true,
		implementationReady: false,
		status: "claim_defined",
		ownerSurface: "native-runtime",
		nextStep:
			"Automate the macOS Layer 3 capture-validation matrix, including API-level probes and TCC workflows.",
	},
];

export type MacosLayer3PermissionState =
	| "granted"
	| "not-granted"
	| "not-required";

export type MacosLayer3PresentationMode =
	| "native-fullscreen-presenter"
	| "native-overlay-compositor";

export type MacosLayer3SessionState =
	| "creating"
	| "attached"
	| "presenting"
	| "blocked"
	| "failed";

export type MacosLayer3BlockerCode =
	| "cgvirtualdisplay-unavailable"
	| "physical-display-mechanism-unproven"
	| "screen-recording-permission-missing"
	| "native-presenter-unavailable"
	| "stealth-heartbeat-missed"
	| "session-not-found"
	| "surface-not-attached"
	| "surface-already-attached"
	| "invalid-surface-dimensions"
	| "presentation-mode-unsupported"
	| "teardown-failed"
	| "unsupported-macos-version"
	| "unsupported-machine-state";

export type MacosLayer3ControlPlaneOutcome = "ok" | "degraded" | "blocked";

export interface MacosLayer3Blocker {
	code: MacosLayer3BlockerCode;
	message: string;
	retryable: boolean;
}

export interface MacosLayer3ResponseEnvelope<T> {
	outcome: MacosLayer3ControlPlaneOutcome;
	failClosed: boolean;
	presentationAllowed: boolean;
	blockers: MacosLayer3Blocker[];
	data: T;
	nonce?: string;
}

export interface MacosLayer3CapabilityReport {
	status: "proven" | "unproven" | "unsupported";
	candidateRenderer: string;
	platform: "darwin";
	osVersion: string;
	nativePresenterAvailable: boolean;
	cgVirtualDisplayAvailable: boolean;
	metalDeviceAvailable: boolean;
	metalCommandQueueAvailable: boolean;
	screenCaptureKitAvailable: boolean;
	screenRecordingPermission: MacosLayer3PermissionState;
	candidatePhysicalDisplayMechanismProven: boolean;
	blockers: MacosLayer3Blocker[];
	reason?: string;
}

export interface MacosLayer3CreateProtectedSessionRequest {
	sessionId: string;
	presentationMode: MacosLayer3PresentationMode;
	displayPreference: "active-display" | "dedicated-display";
	reason: "user-requested" | "policy-required" | "validation-run";
}

export interface MacosLayer3CreateProtectedSessionResponse {
	sessionId: string;
	state: Extract<MacosLayer3SessionState, "creating" | "blocked" | "failed">;
}

export interface MacosLayer3SurfaceAttachment {
	sessionId: string;
	surfaceSource: "native-ui-host";
	surfaceId: string;
	width: number;
	height: number;
	hiDpi: boolean;
}

export interface MacosLayer3PresentRequest {
	sessionId: string;
	activate: boolean;
}

export interface MacosLayer3HealthReport {
	sessionId: string;
	state: MacosLayer3SessionState;
	surfaceAttached: boolean;
	presenting: boolean;
	recoveryPending: boolean;
	blockers: MacosLayer3Blocker[];
	lastTransitionAt: string;
}

export interface MacosLayer3TelemetryCounters {
	capabilityProbeCount: number;
	blockedTransitionCount: number;
	presentationStartCount: number;
}

export interface MacosLayer3TelemetryEvent {
	sessionId: string;
	type:
		| "capability-probed"
		| "session-created"
		| "surface-attached"
		| "presentation-started"
		| "presentation-stopped"
		| "session-blocked"
		| "validation-run";
	at: string;
	detail: string;
}

export interface MacosLayer3ValidationReport {
	sessionId: string;
	status: "failed" | "inconclusive";
	reason: string;
	windowEnumerated: boolean;
	matchedWindowNumber: boolean;
	matchedWindowTitle: boolean;
	screenCaptureKitEnumerated: boolean;
	matchedShareableContentWindow: boolean;
}

export type MacosLayer3ControlPlaneMethod =
	| "probeCapabilities"
	| "createProtectedSession"
	| "attachSurface"
	| "present"
	| "heartbeat"
	| "teardownSession"
	| "getHealth"
	| "getTelemetry"
	| "validateSession";

export interface MacosLayer3MethodSemantics {
	method: MacosLayer3ControlPlaneMethod;
	failClosed: boolean;
	degradedAllowed: boolean;
	note: string;
}

export const MACOS_LAYER3_METHOD_SEMANTICS: MacosLayer3MethodSemantics[] = [
	{
		method: "probeCapabilities",
		failClosed: false,
		degradedAllowed: true,
		note: "May return degraded when prerequisites or permissions are incomplete, but must return blocked when guarded presentation cannot begin safely.",
	},
	{
		method: "createProtectedSession",
		failClosed: true,
		degradedAllowed: false,
		note: "Any non-ok result blocks guarded presentation for the requested session.",
	},
	{
		method: "attachSurface",
		failClosed: true,
		degradedAllowed: false,
		note: "Surface attachment must fail closed; surfaceAttached=false means guarded presentation is not allowed.",
	},
	{
		method: "present",
		failClosed: true,
		degradedAllowed: false,
		note: "Presentation may start only on ok; degraded or blocked states must keep presentation disabled.",
	},
	{
		method: "heartbeat",
		failClosed: true,
		degradedAllowed: false,
		note: "Heartbeat is fail-closed; missed deadlines must block presentation until the session is explicitly recovered or re-armed.",
	},
	{
		method: "teardownSession",
		failClosed: false,
		degradedAllowed: true,
		note: "Best-effort cleanup is acceptable, but the caller must treat non-ok teardown as requiring recovery before reuse.",
	},
	{
		method: "getHealth",
		failClosed: false,
		degradedAllowed: true,
		note: "Health is observational; blocked must indicate presentation is not currently safe.",
	},
	{
		method: "getTelemetry",
		failClosed: false,
		degradedAllowed: true,
		note: "Telemetry retrieval is observational and must not enable presentation when the session is otherwise blocked.",
	},
	{
		method: "validateSession",
		failClosed: false,
		degradedAllowed: true,
		note: "Validation may return a failed or inconclusive report, but the request itself should only block when the session cannot be inspected.",
	},
];

export interface MacosLayer3ControlPlaneContract {
	probeCapabilities: {
		request: Record<string, never>;
		response: MacosLayer3ResponseEnvelope<MacosLayer3CapabilityReport>;
	};
	createProtectedSession: {
		request: MacosLayer3CreateProtectedSessionRequest;
		response: MacosLayer3ResponseEnvelope<MacosLayer3CreateProtectedSessionResponse>;
	};
	attachSurface: {
		request: MacosLayer3SurfaceAttachment;
		response: MacosLayer3ResponseEnvelope<MacosLayer3HealthReport>;
	};
	present: {
		request: MacosLayer3PresentRequest;
		response: MacosLayer3ResponseEnvelope<MacosLayer3HealthReport>;
	};
	teardownSession: {
		request: { sessionId: string };
		response: MacosLayer3ResponseEnvelope<{ released: boolean }>;
	};
	getHealth: {
		request: { sessionId: string };
		response: MacosLayer3ResponseEnvelope<MacosLayer3HealthReport>;
	};
	getTelemetry: {
		request: { sessionId: string };
		response: MacosLayer3ResponseEnvelope<{
			events: MacosLayer3TelemetryEvent[];
			counters: MacosLayer3TelemetryCounters;
		}>;
	};
	validateSession: {
		request: { sessionId: string };
		response: MacosLayer3ResponseEnvelope<MacosLayer3ValidationReport>;
	};
}
