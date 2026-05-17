import test from 'node:test';
import assert from 'node:assert/strict';

import { RestSTT } from '../audio/RestSTT';

function stereoPcm16(frames: number): Buffer {
  const buffer = Buffer.alloc(frames * 2 * 2);
  for (let frame = 0; frame < frames; frame += 1) {
    buffer.writeInt16LE(1200, frame * 4);
    buffer.writeInt16LE(800, frame * 4 + 2);
  }
  return buffer;
}

test('RestSTT writes a mono WAV header after downmixing multi-channel input', async () => {
  const stt = new RestSTT('groq', 'test-key') as any;
  let capturedWav: Buffer | null = null;

  stt.uploadAudio = async (wav: Buffer): Promise<string> => {
    capturedWav = wav;
    return 'ok';
  };

  stt.setSampleRate(16000);
  stt.setAudioChannelCount(2);
  stt.start();
  stt.write(stereoPcm16(2000));
  await stt.flushAndUpload();
  stt.stop();

  assert.ok(capturedWav);
  assert.equal(capturedWav!.toString('ascii', 0, 4), 'RIFF');
  assert.equal(capturedWav!.readUInt16LE(22), 1);
  assert.equal(capturedWav!.readUInt32LE(24), 16000);
  assert.equal(capturedWav!.readUInt32LE(28), 32000);
  assert.equal(capturedWav!.readUInt16LE(32), 2);
  assert.equal(capturedWav!.readUInt32LE(40), 4000);
});
