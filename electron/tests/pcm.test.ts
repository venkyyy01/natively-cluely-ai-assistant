import assert from "node:assert/strict";
import test from "node:test";
import { resampleToMonoPcm16 } from "../audio/pcm";

function intsToBuffer(values: number[]): Buffer {
	const buffer = Buffer.alloc(values.length * 2);
	values.forEach((value, index) => buffer.writeInt16LE(value, index * 2));
	return buffer;
}

function bufferToInts(buffer: Buffer): number[] {
	const values: number[] = [];
	for (let i = 0; i < buffer.length; i += 2) {
		values.push(buffer.readInt16LE(i));
	}
	return values;
}

test("resampleToMonoPcm16 returns empty buffer for empty input", () => {
	assert.equal(resampleToMonoPcm16(Buffer.alloc(0), 48000, 1, 16000).length, 0);
});

test("resampleToMonoPcm16 averages multi-channel input when sample rate is unchanged", () => {
	const stereo = intsToBuffer([1000, 3000, -2000, 2000]);
	const output = resampleToMonoPcm16(stereo, 16000, 2, 16000);

	assert.deepEqual(bufferToInts(output), [2000, 0]);
});

test("resampleToMonoPcm16 downsamples mono input using nearest source samples", () => {
	const mono = intsToBuffer([100, 200, 300, 400]);
	const output = resampleToMonoPcm16(mono, 48000, 1, 24000);

	assert.deepEqual(bufferToInts(output), [100, 300]);
});

test("resampleToMonoPcm16 keeps at least one output sample when factor is large", () => {
	const mono = intsToBuffer([1234]);
	const output = resampleToMonoPcm16(mono, 48000, 1, 8000);

	assert.deepEqual(bufferToInts(output), [1234]);
});
