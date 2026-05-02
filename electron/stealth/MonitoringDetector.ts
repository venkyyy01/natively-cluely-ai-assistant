import { KNOWN_ENTERPRISE_TOOLS } from "./enterpriseToolRegistry";
import { createNativeProcessesProvider } from "./nativeStealthModule";

export type ThreatCategory =
	| "monitoring"
	| "proctoring"
	| "remote-desktop"
	| "screen-capture";
export type ThreatSeverity = "critical" | "warning";

export interface DetectedThreat {
	name: string;
	pid: string;
	category: ThreatCategory;
	severity: ThreatSeverity;
}

const CRITICAL_CATEGORIES: Set<ThreatCategory> = new Set([
	"monitoring",
	"proctoring",
]);

export interface MonitoringDetectorOptions {
	platform?: string;
	logger?: Pick<Console, "log" | "warn" | "error">;
	getProcessList?: () => Array<{ pid: number; ppid: number; name: string }>;
	timeoutMs?: number;
}

export class MonitoringDetector {
	private readonly platform: string;
	private readonly logger: Pick<Console, "log" | "warn" | "error">;
	private readonly getProcessList: () => Array<{
		pid: number;
		ppid: number;
		name: string;
	}>;
	private readonly timeoutMs: number;
	private running = false;

	constructor(options: MonitoringDetectorOptions = {}) {
		this.platform = options.platform ?? process.platform;
		this.logger = options.logger ?? console;
		this.getProcessList =
			options.getProcessList ??
			createNativeProcessesProvider({
				logger: this.logger,
				label: "MonitoringDetector",
			});
		this.timeoutMs = options.timeoutMs ?? 5000;
	}

	async detect(): Promise<DetectedThreat[]> {
		if (this.running) {
			return [];
		}

		this.running = true;
		try {
			return await this.detectThreats();
		} catch (error) {
			this.logger.warn("[MonitoringDetector] Detection failed:", error);
			return [];
		} finally {
			this.running = false;
		}
	}

	private async detectThreats(): Promise<DetectedThreat[]> {
		const threats: DetectedThreat[] = [];
		const procs = this.getProcessList();

		for (const tool of KNOWN_ENTERPRISE_TOOLS) {
			try {
				const match = procs.find(
					(p) => p.name.includes(tool.bundleId) || p.name.includes(tool.name),
				);
				if (match) {
					const severity = CRITICAL_CATEGORIES.has(tool.category)
						? "critical"
						: "warning";
					threats.push({
						name: tool.name,
						pid: String(match.pid),
						category: tool.category,
						severity,
					});
				}
			} catch {
				// Process not found - continue to next
			}
		}

		return threats;
	}

	isToolCritical(name: string): boolean {
		const tool = KNOWN_ENTERPRISE_TOOLS.find((t) => t.name === name);
		return tool ? CRITICAL_CATEGORIES.has(tool.category) : false;
	}

	getToolCategory(name: string): ThreatCategory | null {
		const tool = KNOWN_ENTERPRISE_TOOLS.find((t) => t.name === name);
		return tool?.category ?? null;
	}

	static getKnownTools() {
		return KNOWN_ENTERPRISE_TOOLS;
	}
}
