/**
 * NAT-063 — HelperHost
 *
 * A single supervised helper-host pattern that manages spawn, attestation,
 * environment sanitization, watchdog, and restart for long-lived helper
 * subprocesses (Foundation intent helper, macOS virtual display helper).
 */

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { EventEmitter } from "node:events";

export interface HelperHostSpec {
	command: string;
	args?: string[];
	env?: Record<string, string>;
	cwd?: string;
	/** Max ms without stdout before helper is considered dead. */
	heartbeatTimeoutMs?: number;
	/** Max restart attempts before giving up. */
	maxRestarts?: number;
	/** Called to verify helper binary signature before spawn. */
	attestation?: () => Promise<boolean>;
}

export interface HelperRequest {
	id: string;
	payload: string;
}

export interface HelperResponse {
	id: string;
	payload: string;
}

export class HelperHost extends EventEmitter {
	private process: ChildProcessWithoutNullStreams | null = null;
	private heartbeatTimer: NodeJS.Timeout | null = null;
	private restartCount = 0;
	private disposed = false;
	private pendingRequests = new Map<
		string,
		(response: HelperResponse) => void
	>();

	constructor(private readonly spec: HelperHostSpec) {
		super();
	}

	async spawn(): Promise<void> {
		if (this.disposed) throw new Error("HelperHost is disposed");
		if (this.process) return;

		if (this.spec.attestation) {
			const ok = await this.spec.attestation();
			if (!ok) throw new Error("HelperHost attestation failed");
		}

		const env = this.sanitizeEnv(this.spec.env);
		this.process = spawn(this.spec.command, this.spec.args ?? [], {
			cwd: this.spec.cwd,
			env,
		});

		this.process.stdout?.on("data", (data: Buffer) => {
			this.handleStdout(data);
			this.resetHeartbeat();
		});

		this.process.stderr?.on("data", (data: Buffer) => {
			this.emit("stderr", data.toString("utf-8"));
		});

		this.process.on("exit", (code) => {
			this.emit("exit", code);
			this.process = null;
			this.clearHeartbeat();
			this.attemptRestart();
		});

		this.resetHeartbeat();
		this.emit("spawn");
	}

	send(req: HelperRequest): Promise<HelperResponse> {
		return new Promise((resolve, reject) => {
			if (!this.process || this.process.killed) {
				reject(new Error("Helper process not running"));
				return;
			}
			this.pendingRequests.set(req.id, resolve);
			this.process.stdin?.write(`${req.payload}\n`, (err) => {
				if (err) reject(err);
			});
		});
	}

	cancel(reqId: string): boolean {
		return this.pendingRequests.delete(reqId);
	}

	dispose(): void {
		this.disposed = true;
		this.clearHeartbeat();
		if (this.process && !this.process.killed) {
			this.process.kill();
		}
		this.process = null;
		this.pendingRequests.clear();
		this.emit("dispose");
	}

	isRunning(): boolean {
		return this.process !== null && !this.process.killed;
	}

	getRestartCount(): number {
		return this.restartCount;
	}

	private handleStdout(data: Buffer): void {
		const lines = data.toString("utf-8").split("\n");
		for (const line of lines) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			try {
				const parsed = JSON.parse(trimmed) as HelperResponse;
				if (parsed.id && this.pendingRequests.has(parsed.id)) {
					const resolve = this.pendingRequests.get(parsed.id);
					if (!resolve) continue;
					this.pendingRequests.delete(parsed.id);
					resolve(parsed);
				} else {
					this.emit("response", parsed);
				}
			} catch {
				this.emit("raw", trimmed);
			}
		}
	}

	private resetHeartbeat(): void {
		this.clearHeartbeat();
		const timeout = this.spec.heartbeatTimeoutMs ?? 30000;
		this.heartbeatTimer = setTimeout(() => {
			this.emit("heartbeat-missed");
			this.process?.kill();
		}, timeout);
	}

	private clearHeartbeat(): void {
		if (this.heartbeatTimer) {
			clearTimeout(this.heartbeatTimer);
			this.heartbeatTimer = null;
		}
	}

	private attemptRestart(): void {
		const maxRestarts = this.spec.maxRestarts ?? 3;
		if (this.restartCount >= maxRestarts) {
			this.emit("max-restarts");
			return;
		}
		this.restartCount += 1;
		this.emit("restart", this.restartCount);
		setTimeout(() => {
			if (!this.disposed) {
				this.spawn().catch((err) => this.emit("error", err));
			}
		}, 1000);
	}

	private sanitizeEnv(input?: Record<string, string>): NodeJS.ProcessEnv {
		const base: NodeJS.ProcessEnv = {
			PATH: process.env.PATH ?? "",
		};
		if (!input) return base;
		const sanitized: NodeJS.ProcessEnv = { ...base };
		for (const [key, value] of Object.entries(input)) {
			if (
				key.toLowerCase().includes("secret") ||
				key.toLowerCase().includes("token")
			) {
				continue; // drop sensitive keys
			}
			sanitized[key] = value;
		}
		return sanitized;
	}
}
