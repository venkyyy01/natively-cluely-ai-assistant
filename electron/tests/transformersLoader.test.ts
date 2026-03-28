import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

test('transformers loader does not rely on eval-based imports', () => {
  const loaderPath = path.join(__dirname, '..', 'utils', 'transformersLoader.js');
  const source = fs.readFileSync(loaderPath, 'utf8');

  assert.doesNotMatch(source, /\beval\b/);
});

test('loadTransformers resolves transformers exports and memoizes the module promise', async () => {
  const { loadTransformers } = require('../utils/transformersLoader');

  const firstPromise = loadTransformers();
  const secondPromise = loadTransformers();

  assert.equal(firstPromise, secondPromise);

  const moduleNamespace = await firstPromise;
  assert.equal(typeof moduleNamespace.pipeline, 'function');
  assert.ok(moduleNamespace.env);
});
