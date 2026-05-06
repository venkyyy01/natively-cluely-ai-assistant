import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import Module from "node:module";
import test from "node:test";

class FakeWebSocket extends EventEmitter {
	static CONNECTING = 0;
	static OPEN = 1;
	static CLOSED = 3;
	static instances: FakeWebSocket[] = [];

	public readyState = FakeWebSocket.CONNECTING;
	public sent: unknown[] = [];
	public closeCalls = 0;

	constructor(
		public url: string,
		public options?: unknown,
	) {
		super();
		FakeWebSocket.instances.push(this);
	}

	send(data: unknown): void {
		this.sent.push(data);
	}

	ping(): void {
		this.sent.push("__PING__");
	}

	close(): void {
		this.closeCalls += 1;
		this.readyState = FakeWebSocket.CLOSED;
	}

	open(): void {
		this.readyState = FakeWebSocket.OPEN;
		this.emit("open");
	}

	closeWith(code: number, reason = ""): void {
		this.readyState = FakeWebSocket.CLOSED;
		this.emit("close", code, Buffer.from(reason));
	}
}

function installWebSocketMock(): () => void {
	const originalLoad = (Module as any)._load;
	FakeWebSocket.instances = [];

	(Module as any)._load = function patchedLoad(
		request: string,
		parent: unknown,
		isMain: boolean,
	) {
		if (request === "ws") {
			return FakeWebSocket;
		}

		return originalLoad.call(this, request, parent, isMain);
	};

	return () => {
		(Module as any)._load = originalLoad;
	};
}

test("Soniox buffers audio before open and lazily reconnects after a clean close", async () => {
	const restoreWs = installWebSocketMock();
	const originalSetInterval = global.setInterval;
	const originalClearInterval = global.clearInterval;

	(global as any).setInterval = () => 1;
	(global as any).clearInterval = () => {};

	const modulePath = require.resolve("../audio/SonioxStreamingSTT");
	delete require.cache[modulePath];

	try {
		const { SonioxStreamingSTT } = await import("../audio/SonioxStreamingSTT");
		const stt = new SonioxStreamingSTT("test-key");
		stt.setSampleRate(16000);

		stt.start();
		stt.write(Buffer.from([1, 0, 2, 0]));

		assert.equal(FakeWebSocket.instances.length, 1);
		assert.equal((stt as any).buffer.length, 1);

		const firstSocket = FakeWebSocket.instances[0]!;
		firstSocket.open();

		assert.equal((stt as any).buffer.length, 0);
		assert.equal(typeof firstSocket.sent[0], "string");
		assert.deepEqual(firstSocket.sent[1], Buffer.from([1, 0, 2, 0]));

		firstSocket.closeWith(1000, "idle-timeout");

		stt.write(Buffer.from([3, 0, 4, 0]));

		assert.equal(FakeWebSocket.instances.length, 2);
		assert.equal((stt as any).buffer.length, 1);

		stt.stop();
	} finally {
		restoreWs();
		(global as any).setInterval = originalSetInterval;
		(global as any).clearInterval = originalClearInterval;
	}
});

test("ElevenLabs buffers during connect and lazily reconnects after a clean close", async () => {
	const restoreWs = installWebSocketMock();
	const originalSetTimeout = global.setTimeout;
	const originalClearTimeout = global.clearTimeout;

	(global as any).setTimeout = (fn: () => void) => {
		return { fn };
	};
	(global as any).clearTimeout = () => {};

	const modulePath = require.resolve("../audio/ElevenLabsStreamingSTT");
	delete require.cache[modulePath];

	try {
		const { ElevenLabsStreamingSTT } = await import(
			"../audio/ElevenLabsStreamingSTT"
		);
		const stt = new ElevenLabsStreamingSTT("test-key");
		stt.setSampleRate(16000);

		const audioChunk = Buffer.alloc(8000, 1);

		stt.start();
		stt.write(audioChunk);

		assert.equal(FakeWebSocket.instances.length, 1);
		assert.equal((stt as any).buffer.length, 1);

		const firstSocket = FakeWebSocket.instances[0]!;
		firstSocket.open();
		firstSocket.emit(
			"message",
			Buffer.from(JSON.stringify({ type: "session_started", config: {} })),
		);

		assert.equal((stt as any).buffer.length, 0);
		assert.equal(firstSocket.sent.length, 1);
		const firstPayload = JSON.parse(String(firstSocket.sent[0]));
		assert.equal(firstPayload.message_type, "input_audio_chunk");

		firstSocket.closeWith(1000, "idle-timeout");

		stt.write(audioChunk);

		assert.equal(FakeWebSocket.instances.length, 2);
		assert.equal((stt as any).buffer.length, 1);

		stt.stop();
	} finally {
		restoreWs();
		(global as any).setTimeout = originalSetTimeout;
		(global as any).clearTimeout = originalClearTimeout;
	}
});
