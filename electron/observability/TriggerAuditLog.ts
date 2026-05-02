import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type TriggerDecisionReasonCode =
	| "fired"
	| "declined_cooldown"
	| "declined_speaker"
	| "declined_too_short"
	| "declined_no_punctuation"
	| "stale_stopped"
	| "completed";

export type TriggerDecisionOutcome =
	| "accepted"
	| "declined"
	| "stale"
	| "completed";
export type TriggerDecisionCohort = "legacy_fragment" | "utterance_level";

export interface TriggerDecisionAuditEntry {
	timestamp: number;
	utteranceId?: string;
	speaker: string;
	textSnippet: string;
	reasonCode: TriggerDecisionReasonCode;
	outcome: TriggerDecisionOutcome;
	cohort?: TriggerDecisionCohort;
	requestOutcome?: string;
}

export interface TriggerAuditLogOptions {
	maxEntries?: number;
	persistEnabled?: boolean;
	persistLine?: (line: string) => void | Promise<void>;
	filePath?: string;
}

const DEFAULT_MAX_ENTRIES = 1_000;

function isDebugPersistenceEnabled(): boolean {
	const raw = process.env.NATIVELY_DEBUG_LOG;
	if (!raw) return false;
	return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

function defaultAuditPath(): string {
	const date = new Date().toISOString().slice(0, 10);
	return path.join(
		os.tmpdir(),
		"natively-trigger-audit",
		`trigger-audit-${date}.jsonl`,
	);
}

export class TriggerAuditLog {
	private readonly maxEntries: number;
	private readonly persistEnabled: boolean;
	private readonly persistLine: (line: string) => void | Promise<void>;
	private readonly entries: TriggerDecisionAuditEntry[] = [];

	constructor(options: TriggerAuditLogOptions = {}) {
		this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
		this.persistEnabled = options.persistEnabled ?? isDebugPersistenceEnabled();
		const filePath = options.filePath ?? defaultAuditPath();
		this.persistLine =
			options.persistLine ??
			(async (line: string) => {
				await fs.mkdir(path.dirname(filePath), { recursive: true });
				await fs.appendFile(filePath, `${line}\n`);
			});
	}

	record(entry: TriggerDecisionAuditEntry): void {
		this.entries.push(entry);
		if (this.entries.length > this.maxEntries) {
			this.entries.splice(0, this.entries.length - this.maxEntries);
		}

		if (this.persistEnabled) {
			const line = JSON.stringify(entry);
			void Promise.resolve(this.persistLine(line)).catch((error) => {
				console.warn(
					"[TriggerAuditLog] Failed to persist trigger audit entry:",
					error,
				);
			});
		}
	}

	getEntries(limit: number = this.maxEntries): TriggerDecisionAuditEntry[] {
		return this.entries.slice(-limit);
	}

	clear(): void {
		this.entries.splice(0, this.entries.length);
	}
}

const defaultTriggerAuditLog = new TriggerAuditLog();

export function getDefaultTriggerAuditLog(): TriggerAuditLog {
	return defaultTriggerAuditLog;
}
