import assert from "node:assert/strict";
import test from "node:test";

import {
	createMultichannelSession,
	DeepgramMultichannelSession,
	SonioxMultichannelSession,
	supportsMultichannelDiarization,
} from "../audio/MultichannelSTTSession";

test("NAT-062: supportsMultichannelDiarization returns true for deepgram and soniox", () => {
	assert.equal(supportsMultichannelDiarization("deepgram"), true);
	assert.equal(supportsMultichannelDiarization("soniox"), true);
	assert.equal(supportsMultichannelDiarization("google"), false);
	assert.equal(supportsMultichannelDiarization("elevenlabs"), false);
});

test("NAT-062: createMultichannelSession returns correct subclass", () => {
	const deepgram = createMultichannelSession("deepgram", {
		sampleRate: 16000,
		channels: 2,
		channelLabels: ["interviewer", "user"],
	});
	assert.ok(deepgram instanceof DeepgramMultichannelSession);

	const soniox = createMultichannelSession("soniox", {
		sampleRate: 16000,
		channels: 2,
		channelLabels: ["interviewer", "user"],
	});
	assert.ok(soniox instanceof SonioxMultichannelSession);
});

test("NAT-062: createMultichannelSession throws for unsupported provider", () => {
	assert.throws(() => {
		createMultichannelSession("google", {
			sampleRate: 16000,
			channels: 2,
			channelLabels: ["interviewer", "user"],
		});
	}, /does not support multichannel/);
});

test("NAT-062: session connects and disconnects", async () => {
	const session = createMultichannelSession("deepgram", {
		sampleRate: 16000,
		channels: 2,
		channelLabels: ["interviewer", "user"],
	});

	const connectedEvents: string[] = [];
	session.on("connected", () => connectedEvents.push("connected"));
	session.on("disconnected", () => connectedEvents.push("disconnected"));

	assert.equal(session.isConnected(), false);
	await session.start();
	assert.equal(session.isConnected(), true);
	await session.stop();
	assert.equal(session.isConnected(), false);
	assert.deepEqual(connectedEvents, ["connected", "disconnected"]);
});

test("NAT-062: interleaved frame write is a no-op when disconnected", () => {
	const session = createMultichannelSession("deepgram", {
		sampleRate: 16000,
		channels: 2,
		channelLabels: ["interviewer", "user"],
	});

	// Should not throw when disconnected
	session.writeInterleavedFrame(Buffer.alloc(640));
	assert.equal(session.isConnected(), false);
});

test("NAT-062: options are preserved on session", () => {
	const session = createMultichannelSession("soniox", {
		sampleRate: 48000,
		channels: 2,
		channelLabels: ["mic", "system"],
	});

	assert.equal((session as any).options.sampleRate, 48000);
	assert.equal((session as any).options.channels, 2);
	assert.deepEqual((session as any).options.channelLabels, ["mic", "system"]);
});
