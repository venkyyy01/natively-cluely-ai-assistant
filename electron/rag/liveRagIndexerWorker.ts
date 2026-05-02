/**
 * NAT-053: worker_threads entry for inserting live RAG chunks without blocking the
 * main thread's synchronous SQLite transaction. Embeddings are applied on the main
 * thread via EmbeddingPipeline after chunk IDs are returned.
 */

import Database from "better-sqlite3";
import { parentPort } from "worker_threads";

export interface LiveRagChunkInsertRow {
	meetingId: string;
	chunkIndex: number;
	speaker: string;
	startMs: number;
	endMs: number;
	text: string;
	tokenCount: number;
}

export type LiveRagWorkerInboundMessage = {
	type: "saveChunks";
	dbPath: string;
	chunks: LiveRagChunkInsertRow[];
};

parentPort?.on("message", (msg: LiveRagWorkerInboundMessage) => {
	if (msg.type !== "saveChunks") {
		return;
	}
	let db: Database.Database | null = null;
	try {
		db = new Database(msg.dbPath);
		db.pragma("journal_mode = WAL");
		db.pragma("busy_timeout = 5000");
		const insert = db.prepare(`
            INSERT INTO chunks (meeting_id, chunk_index, speaker, start_timestamp_ms, end_timestamp_ms, cleaned_text, token_count)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `);
		const ids: number[] = [];
		const run = db.transaction(() => {
			for (const c of msg.chunks) {
				const result = insert.run(
					c.meetingId,
					c.chunkIndex,
					c.speaker,
					c.startMs,
					c.endMs,
					c.text,
					c.tokenCount,
				);
				ids.push(Number(result.lastInsertRowid));
			}
		});
		run();
		parentPort?.postMessage({ ok: true as const, chunkIds: ids });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		parentPort?.postMessage({ ok: false as const, error: message });
	} finally {
		try {
			db?.close();
		} catch {
			// ignore
		}
	}
});
