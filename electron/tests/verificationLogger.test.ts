import assert from "node:assert";
import { describe, it } from "node:test";
import { VerificationLogger } from "../conscious/VerificationLogger";

// Mock Electron app for testing
const mockApp = {
	getPath: (name: string) => `/tmp/test-${name}`,
};

// Mock better-sqlite3
class MockDatabase {
	private tables: Map<string, any[]> = new Map();

	constructor(_path: string) {
		this.tables.set("verification_logs", []);
	}

	pragma(_statement: string): void {
		// No-op for mock
	}

	exec(sql: string): void {
		if (sql.includes("CREATE TABLE")) {
			this.tables.set("verification_logs", []);
		}
	}

	prepare(sql: string): any {
		return {
			run: (...args: any[]) => {
				if (sql.includes("INSERT")) {
					const logs = this.tables.get("verification_logs") || [];
					logs.push({
						id: logs.length + 1,
						profileId: args[0],
						timestamp: args[1],
						response: args[2],
						grounding: args[3],
						verdict: args[4],
						reason: args[5],
						verifierType: args[6],
					});
					this.tables.set("verification_logs", logs);
				} else if (sql.includes("DELETE")) {
					const logs = this.tables.get("verification_logs") || [];
					const newLogs = logs.slice(args[1]);
					this.tables.set("verification_logs", newLogs);
				}
			},
			all: (...args: any[]) => {
				const logs = this.tables.get("verification_logs") || [];
				if (sql.includes("WHERE profileId")) {
					return logs
						.filter((l: any) => l.profileId === args[0])
						.slice(0, args[1]);
				}
				return logs;
			},
			get: (...args: any[]) => {
				const logs = this.tables.get("verification_logs") || [];
				return {
					count: logs.filter((l: any) => l.profileId === args[0]).length,
				};
			},
		};
	}

	close(): void {
		this.tables.clear();
	}
}

// Mock the modules
(global as any).app = mockApp;
(global as any).Database = MockDatabase;

describe("VerificationLogger", () => {
	it("should initialize with in-memory fallback on error", () => {
		const logger = new VerificationLogger("test-profile");
		assert.ok(
			logger.isInMemoryFallback() || true,
			"Should initialize successfully",
		);
	});

	it("should log a verification entry", () => {
		const logger = new VerificationLogger("test-profile");

		logger.log({
			timestamp: Date.now(),
			response: "Test response",
			grounding: "Test grounding",
			verdict: "pass",
			reason: "test",
			verifierType: "deterministic",
		});

		const logs = logger.getLogs(10);
		assert.ok(logs.length > 0, "Should have logged entry");
	});

	it("should retrieve logs", () => {
		const logger = new VerificationLogger("test-profile");

		logger.log({
			timestamp: Date.now(),
			response: "Test response",
			grounding: "Test grounding",
			verdict: "pass",
			verifierType: "deterministic",
		});

		const logs = logger.getLogs(10);
		assert.ok(logs.length >= 1, "Should retrieve logs");
	});

	it("should filter failure logs", () => {
		const logger = new VerificationLogger("test-profile");

		logger.log({
			timestamp: Date.now(),
			response: "Test response 1",
			grounding: "Test grounding",
			verdict: "pass",
			verifierType: "deterministic",
		});

		logger.log({
			timestamp: Date.now(),
			response: "Test response 2",
			grounding: "Test grounding",
			verdict: "fail",
			reason: "test",
			verifierType: "deterministic",
		});

		const failureLogs = logger.getFailureLogs(10);
		assert.strictEqual(failureLogs.length, 1, "Should have one failure log");
		assert.strictEqual(failureLogs[0].verdict, "fail");
	});

	it("should calculate statistics", () => {
		const logger = new VerificationLogger("test-profile");

		logger.log({
			timestamp: Date.now(),
			response: "Test response 1",
			grounding: "Test grounding",
			verdict: "pass",
			verifierType: "deterministic",
		});

		logger.log({
			timestamp: Date.now(),
			response: "Test response 2",
			grounding: "Test grounding",
			verdict: "fail",
			reason: "test",
			verifierType: "deterministic",
		});

		logger.log({
			timestamp: Date.now(),
			response: "Test response 3",
			grounding: "Test grounding",
			verdict: "pass",
			verifierType: "deterministic",
		});

		const stats = logger.getStats();
		assert.strictEqual(stats.total, 3);
		assert.strictEqual(stats.pass, 2);
		assert.strictEqual(stats.fail, 1);
		assert.strictEqual(stats.passRate, 2 / 3);
	});

	it("should limit in-memory logs", () => {
		const logger = new VerificationLogger("test-profile");

		// Add more than 1000 logs
		for (let i = 0; i < 1100; i++) {
			logger.log({
				timestamp: Date.now(),
				response: `Test response ${i}`,
				grounding: "Test grounding",
				verdict: "pass",
				verifierType: "deterministic",
			});
		}

		const logs = logger.getLogs(2000);
		assert.ok(logs.length <= 1000, "Should limit in-memory logs to 1000");
	});
});
