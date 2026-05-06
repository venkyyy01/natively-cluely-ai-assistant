import assert from "node:assert/strict";
import Module from "node:module";
import test from "node:test";

import { DatabaseManager } from "../db/DatabaseManager";

function installElectronMock(): () => void {
	const originalLoad = (Module as any)._load;

	(Module as any)._load = function patchedLoad(
		request: string,
		parent: unknown,
		isMain: boolean,
	): unknown {
		if (request === "electron") {
			return {
				app: {
					isPackaged: true,
					getAppPath(): string {
						return "/tmp";
					},
					getPath(): string {
						return "/tmp";
					},
					whenReady: async (): Promise<void> => undefined,
					on() {},
					commandLine: {
						appendSwitch() {},
					},
					dock: {
						show() {},
						hide() {},
					},
					quit() {},
					exit() {},
				},
				BrowserWindow: {
					getAllWindows: (): unknown[] => [],
				},
				Tray: class {},
				Menu: {},
				nativeImage: {},
				ipcMain: {},
				shell: {},
				systemPreferences: {},
				globalShortcut: {},
				session: {},
			};
		}

		return originalLoad.call(this, request, parent, isMain);
	};

	return () => {
		(Module as any)._load = originalLoad;
	};
}

test("processCompletedMeetingForRAG uses the explicit ended meeting id and does not consult recency", async () => {
	const restoreElectron = installElectronMock();
	const originalGetInstance = DatabaseManager.getInstance;
	const lookedUpIds: string[] = [];
	const processedIds: string[] = [];
	const originalNodeEnv = process.env.NODE_ENV;
	process.env.NODE_ENV = "test";

	DatabaseManager.getInstance = (() => ({
		getMeetingDetails(id: string): {
			id: string;
			title: string;
			date: string;
			duration: string;
			summary: string;
			detailedSummary: { actionItems: string[]; keyPoints: string[] };
			transcript: Array<{ speaker: string; text: string; timestamp: number }>;
		} {
			lookedUpIds.push(id);
			return {
				id,
				title: "Ended meeting",
				date: new Date().toISOString(),
				duration: "1:00",
				summary: "",
				detailedSummary: {
					actionItems: [] as string[],
					keyPoints: [] as string[],
				},
				transcript: [
					{ speaker: "interviewer", text: "hello", timestamp: 1 },
					{ speaker: "user", text: "world", timestamp: 2 },
				],
			};
		},
		getRecentMeetings() {
			throw new Error("should not query recency for RAG finalization");
		},
	})) as unknown as typeof DatabaseManager.getInstance;

	try {
		const { AppState } = await import("../main");
		const helper = (
			AppState.prototype as unknown as {
				processCompletedMeetingForRAG: (
					this: unknown,
					meetingId?: string | null,
				) => Promise<void>;
			}
		).processCompletedMeetingForRAG;

		await helper.call(
			{
				ragManager: {
					async processMeeting(meetingId: string) {
						processedIds.push(meetingId);
						return { chunkCount: 2 };
					},
				},
			},
			"meeting-ended",
		);

		assert.deepEqual(lookedUpIds, ["meeting-ended"]);
		assert.deepEqual(processedIds, ["meeting-ended"]);
	} finally {
		DatabaseManager.getInstance = originalGetInstance;
		restoreElectron();
		process.env.NODE_ENV = originalNodeEnv;
	}
});
