import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type {
	MacosLayer3CapabilityReport,
	MacosLayer3CreateProtectedSessionRequest,
	MacosLayer3CreateProtectedSessionResponse,
	MacosLayer3HealthReport,
	MacosLayer3PresentRequest,
	MacosLayer3ResponseEnvelope,
	MacosLayer3SurfaceAttachment,
	MacosLayer3TelemetryCounters,
	MacosLayer3TelemetryEvent,
	MacosLayer3ValidationReport,
} from "./separateProjectContracts";

function pickEnv(
	allowList: string[],
	source: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
	const picked: NodeJS.ProcessEnv = {};
	for (const key of allowList) {
		if (source[key] !== undefined) {
			picked[key] = source[key];
		}
	}
	return picked;
}

export interface MacosVirtualDisplayStatus {
	ready: boolean;
	component: string;
	notes?: string;
	reason?: string;
}

export interface MacosVirtualDisplaySessionRequest {
	sessionId: string;
	windowId: string;
	width: number;
	height: number;
}

export interface MacosVirtualDisplaySessionResponse {
	ready: boolean;
	sessionId: string;
	mode?: "virtual-display";
	surfaceToken?: string;
	reason?: string;
}

export interface MacosVirtualDisplayHelperFaultEvent {
	type: "helper-fault";
	sessionId: string;
	reason: string;
	failClosed: boolean;
}

export type MacosVirtualDisplayHelperEvent =
	MacosVirtualDisplayHelperFaultEvent;

interface HelperRunRequest {
	command:
		| "hello"
		| "status"
		| "create-session"
		| "release-session"
		| "probe-capabilities"
		| "create-protected-session"
		| "attach-surface"
		| "present"
		| "heartbeat"
		| "teardown-session"
		| "get-health"
		| "get-telemetry"
		| "validate-session";
	stdin?: string;
}

interface HelperRunResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

interface MacosVirtualDisplayClientOptions {
	helperPath: string;
	runHelper?: (request: HelperRunRequest) => Promise<HelperRunResult>;
	requestTimeoutMs?: number;
	helperEnv?: NodeJS.ProcessEnv;
	eventHandler?: (event: MacosVirtualDisplayHelperEvent) => void;
	skipSignatureVerification?: boolean;
	strictProtocolAuth?: boolean;
}

type HelperProtocolState = "unknown" | "authenticated" | "legacy";

export class MacosVirtualDisplayClient extends EventEmitter {
	private readonly helperPath: string;
	private readonly runHelper: (
		request: HelperRunRequest,
	) => Promise<HelperRunResult>;
	private readonly requestTimeoutMs: number;
	private readonly helperEnv: NodeJS.ProcessEnv;
	private readonly skipSignatureVerification: boolean;
	private eventHandler?: (event: MacosVirtualDisplayHelperEvent) => void;
	private serverProcess: ChildProcessWithoutNullStreams | null = null;
	private requestSequence = 0;
	private pending = new Map<
		string,
		{
			resolve: (result: HelperRunResult) => void;
			reject: (error: Error) => void;
			timeout: NodeJS.Timeout;
		}
	>();
	private expiredRequestIds = new Set<string>();
	private stdoutBuffer = "";
	private respawnTimestamps: number[] = [];
	private readonly MAX_RESPAWNS_PER_MINUTE = 3;
	private readonly nonce: string;
	private readonly capability: string;
	private readonly strictProtocolAuth: boolean;
	private helperProtocolState: HelperProtocolState = "unknown";
	private handshakePromise: Promise<void> | null = null;

	constructor(options: MacosVirtualDisplayClientOptions) {
		super();
		this.helperPath = options.helperPath;
		this.runHelper =
			options.runHelper ?? ((request) => this.runHelperProcess(request));
		this.requestTimeoutMs = options.requestTimeoutMs ?? 10000;
		this.helperEnv = pickEnv(
			[
				"PATH",
				"HOME",
				"TMPDIR",
				"FULL_STEALTH_HEARTBEAT_TIMEOUT_MS",
				"STEALTH_VIRTUAL_DISPLAY_STATE_PATH",
			],
			options.helperEnv ?? process.env,
		);
		this.eventHandler = options.eventHandler;
		this.skipSignatureVerification = options.skipSignatureVerification ?? false;
		this.nonce = randomUUID();
		this.capability = randomUUID();
		this.strictProtocolAuth =
			options.strictProtocolAuth ??
			process.env.NATIVELY_STRICT_PROTECTION === "1";
	}

	setEventHandler(
		handler?: (event: MacosVirtualDisplayHelperEvent) => void,
	): void {
		this.eventHandler = handler;
	}

	async getStatus(): Promise<MacosVirtualDisplayStatus> {
		return this.executeJsonCommand<MacosVirtualDisplayStatus>({
			command: "status",
		});
	}

	async createSession(
		request: MacosVirtualDisplaySessionRequest,
	): Promise<MacosVirtualDisplaySessionResponse> {
		return this.executeJsonCommand<MacosVirtualDisplaySessionResponse>({
			command: "create-session",
			stdin: JSON.stringify(request),
		});
	}

	async releaseSession(sessionId: string): Promise<{ released: boolean }> {
		return this.executeJsonCommand<{ released: boolean }>({
			command: "release-session",
			stdin: JSON.stringify({ sessionId }),
		});
	}

	async probeCapabilities(): Promise<
		MacosLayer3ResponseEnvelope<MacosLayer3CapabilityReport>
	> {
		return this.executeJsonCommand<
			MacosLayer3ResponseEnvelope<MacosLayer3CapabilityReport>
		>({ command: "probe-capabilities" });
	}

	async createProtectedSession(
		request: MacosLayer3CreateProtectedSessionRequest,
	): Promise<
		MacosLayer3ResponseEnvelope<MacosLayer3CreateProtectedSessionResponse>
	> {
		return this.executeJsonCommand<
			MacosLayer3ResponseEnvelope<MacosLayer3CreateProtectedSessionResponse>
		>({
			command: "create-protected-session",
			stdin: JSON.stringify(request),
		});
	}

	async attachSurface(
		request: MacosLayer3SurfaceAttachment,
	): Promise<MacosLayer3ResponseEnvelope<MacosLayer3HealthReport>> {
		return this.executeJsonCommand<
			MacosLayer3ResponseEnvelope<MacosLayer3HealthReport>
		>({
			command: "attach-surface",
			stdin: JSON.stringify(request),
		});
	}

	async present(
		request: MacosLayer3PresentRequest,
	): Promise<MacosLayer3ResponseEnvelope<MacosLayer3HealthReport>> {
		return this.executeJsonCommand<
			MacosLayer3ResponseEnvelope<MacosLayer3HealthReport>
		>({
			command: "present",
			stdin: JSON.stringify(request),
		});
	}

	async heartbeat(
		sessionId: string,
	): Promise<MacosLayer3ResponseEnvelope<MacosLayer3HealthReport>> {
		return this.executeJsonCommand<
			MacosLayer3ResponseEnvelope<MacosLayer3HealthReport>
		>({
			command: "heartbeat",
			stdin: JSON.stringify({ sessionId }),
		});
	}

	async teardownSession(
		sessionId: string,
	): Promise<MacosLayer3ResponseEnvelope<{ released: boolean }>> {
		return this.executeJsonCommand<
			MacosLayer3ResponseEnvelope<{ released: boolean }>
		>({
			command: "teardown-session",
			stdin: JSON.stringify({ sessionId }),
		});
	}

	async getHealth(
		sessionId: string,
	): Promise<MacosLayer3ResponseEnvelope<MacosLayer3HealthReport>> {
		return this.executeJsonCommand<
			MacosLayer3ResponseEnvelope<MacosLayer3HealthReport>
		>({
			command: "get-health",
			stdin: JSON.stringify({ sessionId }),
		});
	}

	async getTelemetry(sessionId: string): Promise<
		MacosLayer3ResponseEnvelope<{
			events: MacosLayer3TelemetryEvent[];
			counters: MacosLayer3TelemetryCounters;
		}>
	> {
		return this.executeJsonCommand<
			MacosLayer3ResponseEnvelope<{
				events: MacosLayer3TelemetryEvent[];
				counters: MacosLayer3TelemetryCounters;
			}>
		>({
			command: "get-telemetry",
			stdin: JSON.stringify({ sessionId }),
		});
	}

	async validateSession(
		sessionId: string,
	): Promise<MacosLayer3ResponseEnvelope<MacosLayer3ValidationReport>> {
		return this.executeJsonCommand<
			MacosLayer3ResponseEnvelope<MacosLayer3ValidationReport>
		>({
			command: "validate-session",
			stdin: JSON.stringify({ sessionId }),
		});
	}

	dispose(): void {
		if (!this.serverProcess) {
			return;
		}

		for (const pending of this.pending.values()) {
			clearTimeout(pending.timeout);
			pending.reject(new Error("macOS virtual display helper client disposed"));
		}
		this.pending.clear();
		this.expiredRequestIds.clear();
		this.serverProcess.kill();
		this.serverProcess = null;
		this.helperProtocolState = "unknown";
		this.handshakePromise = null;
		this.stdoutBuffer = "";
	}

	public isExhausted(): boolean {
		const now = Date.now();
		const oneMinuteAgo = now - 60000;
		this.respawnTimestamps = this.respawnTimestamps.filter(
			(t) => t > oneMinuteAgo,
		);
		const exhausted =
			this.respawnTimestamps.length >= this.MAX_RESPAWNS_PER_MINUTE;
		if (exhausted) {
			this.emit("stealth:helper_dead");
		}
		return exhausted;
	}

	private async executeJsonCommand<T>(request: HelperRunRequest): Promise<T> {
		const result = await this.runHelper(request);
		if (result.exitCode !== 0) {
			throw new Error(
				result.stderr || `Helper exited with code ${result.exitCode}`,
			);
		}

		try {
			return JSON.parse(result.stdout) as T;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(
				`macOS virtual display helper returned invalid JSON for ${request.command}: ${message}`,
			);
		}
	}

	private runHelperProcess(
		request: HelperRunRequest,
	): Promise<HelperRunResult> {
		return new Promise((resolve, reject) => {
			let payload: Record<string, unknown> = {};
			if (request.stdin) {
				try {
					payload = JSON.parse(request.stdin) as Record<string, unknown>;
				} catch (error) {
					const message =
						error instanceof Error ? error.message : String(error);
					reject(
						new Error(
							`macOS virtual display helper request payload for ${request.command} was not valid JSON: ${message}`,
						),
					);
					return;
				}
			}

			this.ensureServerProcess()
				.then(async (child) => {
					await this.ensureProtocolHandshake(child);
					const id = `req-${++this.requestSequence}`;
					const timeout = setTimeout(() => {
						this.pending.delete(id);
						this.expiredRequestIds.add(id);
						reject(
							new Error(
								`macOS virtual display helper request timed out: ${request.command}`,
							),
						);
					}, this.requestTimeoutMs);
					this.pending.set(id, { resolve, reject, timeout });

					child.stdin.write(`${JSON.stringify({ id, command: request.command, nonce: this.nonce, capability: this.capability, ...payload })}
`);
				})
				.catch(reject);
		});
	}

	private async ensureProtocolHandshake(
		child: ChildProcessWithoutNullStreams,
	): Promise<void> {
		if (
			this.helperProtocolState === "authenticated" ||
			this.helperProtocolState === "legacy"
		) {
			return;
		}

		if (!this.handshakePromise) {
			this.handshakePromise = this.performProtocolHandshake(child).finally(
				() => {
					this.handshakePromise = null;
				},
			);
		}

		await this.handshakePromise;
	}

	private performProtocolHandshake(
		child: ChildProcessWithoutNullStreams,
	): Promise<void> {
		return new Promise((resolve, reject) => {
			const id = `hello-${++this.requestSequence}`;
			const timeout = setTimeout(() => {
				this.pending.delete(id);
				const error = new Error(
					"macOS virtual display helper capability handshake timed out",
				);
				if (this.strictProtocolAuth) {
					reject(error);
					return;
				}

				console.warn(
					`[MacosVirtualDisplayClient] ${error.message}; continuing with legacy helper protocol`,
				);
				this.helperProtocolState = "legacy";
				resolve();
			}, this.requestTimeoutMs);

			this.pending.set(id, {
				resolve: (result) => {
					clearTimeout(timeout);
					if (result.exitCode !== 0) {
						const error = new Error(
							result.stderr ||
								"macOS virtual display helper capability handshake failed",
						);
						if (this.strictProtocolAuth) {
							reject(error);
							return;
						}

						console.warn(
							`[MacosVirtualDisplayClient] ${error.message}; continuing with legacy helper protocol`,
						);
						this.helperProtocolState = "legacy";
						resolve();
						return;
					}

					try {
						const payload = JSON.parse(result.stdout || "{}") as {
							authenticated?: boolean;
							capability?: string;
						};
						if (
							payload.authenticated === true &&
							payload.capability === this.capability
						) {
							this.helperProtocolState = "authenticated";
							resolve();
							return;
						}

						throw new Error("helper did not echo the expected capability");
					} catch (error) {
						const parsedError =
							error instanceof Error ? error : new Error(String(error));
						if (this.strictProtocolAuth) {
							reject(parsedError);
							return;
						}

						console.warn(
							`[MacosVirtualDisplayClient] ${parsedError.message}; continuing with legacy helper protocol`,
						);
						this.helperProtocolState = "legacy";
						resolve();
					}
				},
				reject: (error) => {
					clearTimeout(timeout);
					if (this.strictProtocolAuth) {
						reject(error);
						return;
					}

					console.warn(
						`[MacosVirtualDisplayClient] ${error.message}; continuing with legacy helper protocol`,
					);
					this.helperProtocolState = "legacy";
					resolve();
				},
				timeout,
			});

			child.stdin.write(`${JSON.stringify({ id, command: "hello", nonce: this.nonce, capability: this.capability })}
`);
		});
	}

	private async ensureServerProcess(): Promise<ChildProcessWithoutNullStreams> {
		if (this.serverProcess) {
			return this.serverProcess;
		}

		if (this.isExhausted()) {
			throw new Error("macOS virtual display helper client exhausted respawns");
		}

		if (process.platform === "darwin" && !this.skipSignatureVerification) {
			const signatureValid = await this.verifyHelperSignature(this.helperPath);
			if (!signatureValid) {
				this.emit("stealth:helper_signature_failed");
				throw new Error(
					"macOS virtual display helper signature verification failed",
				);
			}
		}

		this.respawnTimestamps.push(Date.now());

		const child = spawn(this.helperPath, ["serve"], {
			stdio: "pipe",
			env: this.helperEnv,
		});
		child.stdout.on("data", (chunk) => {
			this.stdoutBuffer += chunk.toString();
			this.flushServerResponses();
		});
		child.stderr.on("data", () => {
			// The helper may log runtime warnings; command-level failures still return structured JSON.
		});
		child.on("error", (error) => {
			for (const pending of this.pending.values()) {
				clearTimeout(pending.timeout);
				pending.reject(
					error instanceof Error ? error : new Error(String(error)),
				);
			}
			this.pending.clear();
			this.expiredRequestIds.clear();
			this.serverProcess = null;
			this.helperProtocolState = "unknown";
			this.handshakePromise = null;
		});
		child.on("close", () => {
			if (this.pending.size > 0) {
				for (const pending of this.pending.values()) {
					clearTimeout(pending.timeout);
					pending.reject(
						new Error(
							"macOS virtual display helper server exited unexpectedly",
						),
					);
				}
				this.pending.clear();
				this.expiredRequestIds.clear();
			}
			this.serverProcess = null;
			this.helperProtocolState = "unknown";
			this.handshakePromise = null;
		});
		this.serverProcess = child;
		return child;
	}

	private async verifyHelperSignature(path: string): Promise<boolean> {
		return new Promise((resolve) => {
			execFile(
				"codesign",
				["--verify", "--deep", "--strict", path],
				(error) => {
					resolve(error === null);
				},
			);
		});
	}

	private flushServerResponses(): void {
		let newlineIndex = this.stdoutBuffer.indexOf("\n");
		while (newlineIndex >= 0) {
			const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
			this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
			if (line) {
				try {
					const envelope = JSON.parse(line) as {
						id?: string;
						ok?: boolean;
						result?: unknown;
						error?: string;
						event?: string;
						sessionId?: string;
						reason?: string;
						failClosed?: boolean;
						nonce?: string;
						capability?: string;
					};

					if (envelope.nonce !== undefined && envelope.nonce !== this.nonce) {
						console.warn(
							"[MacosVirtualDisplayClient] Response nonce mismatch; dropping line",
						);
						newlineIndex = this.stdoutBuffer.indexOf("\n");
						continue;
					}

					if (
						envelope.capability !== undefined &&
						envelope.capability !== this.capability
					) {
						if (
							this.strictProtocolAuth &&
							this.helperProtocolState === "authenticated"
						) {
							this.failProtocol(
								`Helper server returned a response with the wrong capability`,
							);
							newlineIndex = this.stdoutBuffer.indexOf("\n");
							continue;
						}
						console.warn(
							"[MacosVirtualDisplayClient] Response capability mismatch; dropping line",
						);
						newlineIndex = this.stdoutBuffer.indexOf("\n");
						continue;
					}

					if (
						this.strictProtocolAuth &&
						this.helperProtocolState === "authenticated" &&
						envelope.capability !== this.capability
					) {
						this.failProtocol(
							`Helper server returned an unauthenticated ${envelope.event ? "event" : "response"}`,
						);
						newlineIndex = this.stdoutBuffer.indexOf("\n");
						continue;
					}

					if (
						envelope.event === "helper-fault" &&
						typeof envelope.sessionId === "string" &&
						typeof envelope.reason === "string"
					) {
						this.eventHandler?.({
							type: "helper-fault",
							sessionId: envelope.sessionId,
							reason: envelope.reason,
							failClosed: envelope.failClosed !== false,
						});
						newlineIndex = this.stdoutBuffer.indexOf("\n");
						continue;
					}

					const pending = envelope.id
						? this.pending.get(envelope.id)
						: undefined;
					if (envelope.id && this.expiredRequestIds.has(envelope.id)) {
						this.expiredRequestIds.delete(envelope.id);
					} else if (!envelope.id || !pending) {
						for (const current of this.pending.values()) {
							clearTimeout(current.timeout);
							current.reject(
								new Error(
									"Helper server returned a response with a missing or unknown request id",
								),
							);
						}
						this.pending.clear();
						this.expiredRequestIds.clear();
						this.serverProcess?.kill();
						this.serverProcess = null;
						this.helperProtocolState = "unknown";
						this.handshakePromise = null;
					} else {
						this.pending.delete(envelope.id);
						clearTimeout(pending.timeout);
						if (envelope.ok) {
							pending.resolve({
								exitCode: 0,
								stdout: JSON.stringify(envelope.result ?? {}),
								stderr: "",
							});
						} else {
							pending.resolve({
								exitCode: 1,
								stdout: "",
								stderr: envelope.error ?? "helper request failed",
							});
						}
					}
				} catch (error) {
					const parsedError =
						error instanceof Error ? error : new Error(String(error));
					console.warn(
						"[MacosVirtualDisplayClient] Invalid helper JSON, dropping line:",
						parsedError.message,
					);
				}
			}
			newlineIndex = this.stdoutBuffer.indexOf("\n");
		}
	}

	private failProtocol(message: string): void {
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timeout);
			pending.reject(new Error(message));
		}
		this.pending.clear();
		this.expiredRequestIds.clear();
		this.serverProcess?.kill();
		this.serverProcess = null;
		this.helperProtocolState = "unknown";
		this.handshakePromise = null;
	}
}

export interface VirtualDisplayCoordinator {
	ensureIsolationForWindow(
		request: MacosVirtualDisplaySessionRequest,
	): Promise<MacosVirtualDisplaySessionResponse>;
	releaseIsolationForWindow(request: { windowId: string }): Promise<void>;
	isExhausted?(): boolean;
	dispose?(): void;
}

export class MacosVirtualDisplayCoordinator
	implements VirtualDisplayCoordinator
{
	private readonly client: MacosVirtualDisplayClient;
	private readonly activeSessions = new Map<string, string>();

	constructor(client: MacosVirtualDisplayClient) {
		this.client = client;
	}

	async ensureIsolationForWindow(
		request: MacosVirtualDisplaySessionRequest,
	): Promise<MacosVirtualDisplaySessionResponse> {
		const existingSessionId = this.activeSessions.get(request.windowId);
		if (existingSessionId) {
			try {
				await this.client.releaseSession(existingSessionId);
			} catch {
				// Best-effort cleanup of stale session
			}
		}
		const response = await this.client.createSession(request);
		if (response.ready) {
			this.activeSessions.set(request.windowId, request.sessionId);
		}
		return response;
	}

	async releaseIsolationForWindow(request: {
		windowId: string;
	}): Promise<void> {
		const sessionId =
			this.activeSessions.get(request.windowId) ?? request.windowId;
		await this.client.releaseSession(sessionId);
		this.activeSessions.delete(request.windowId);
	}

	isExhausted(): boolean {
		return this.client.isExhausted();
	}

	dispose(): void {
		for (const sessionId of this.activeSessions.values()) {
			this.client.releaseSession(sessionId).catch(() => {
				/* best-effort */
			});
		}
		this.activeSessions.clear();
		this.client.dispose();
	}
}
