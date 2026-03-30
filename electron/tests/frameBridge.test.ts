import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { FrameBridge } from '../stealth/frameBridge';

test('FrameBridge forwards paint payloads to shell target', () => {
  const source = new EventEmitter() as EventEmitter & { setFrameRate?: (fps: number) => void };
  let frameRate = 0;
  source.setFrameRate = (fps) => {
    frameRate = fps;
  };
  const sent: unknown[] = [];
  const bridge = new FrameBridge({
    target: {
      send(_channel, payload) {
        sent.push(payload);
      },
    },
  });

  bridge.attach(source);
  source.emit('paint', {}, [{ x: 1, y: 2, width: 3, height: 4 }], {
    toPNG() {
      return Buffer.from('frame');
    },
    getSize() {
      return { width: 100, height: 80 };
    },
  });

  assert.equal(frameRate, 30);
  assert.equal(sent.length, 1);
  assert.deepEqual((sent[0] as { dirtyRects: unknown[] }).dirtyRects, [{ x: 1, y: 2, width: 3, height: 4 }]);
});

test('FrameBridge normalizes partial rects and detaches cleanly', () => {
  const source = new EventEmitter() as EventEmitter & { setFrameRate?: (fps: number) => void };
  source.setFrameRate = () => {};
  const sent: unknown[] = [];
  const bridge = new FrameBridge({
    target: { send: (_channel, payload) => sent.push(payload) },
  });

  bridge.attach(source);
  bridge.attach(source);
  source.emit('paint', {}, [{}], {
    toPNG() {
      return Buffer.from('frame');
    },
    getSize() {
      return { width: 1, height: 1 };
    },
  });
  bridge.detach();
  bridge.detach();

  assert.deepEqual((sent[0] as { dirtyRects: unknown[] }).dirtyRects, [{ x: 0, y: 0, width: 0, height: 0 }]);
});

test('FrameBridge warns when frame serialization fails', () => {
  const source = new EventEmitter() as EventEmitter & { setFrameRate?: (fps: number) => void };
  source.setFrameRate = () => {};
  const warnings: unknown[] = [];
  const bridge = new FrameBridge({
    target: { send() {} },
    logger: { warn: (...args: unknown[]) => warnings.push(args) },
  });

  bridge.attach(source);
  source.emit('paint', {}, [], {
    toPNG() {
      throw new Error('boom');
    },
    getSize() {
      return { width: 1, height: 1 };
    },
  });

  assert.equal(warnings.length, 1);
});
