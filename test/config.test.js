import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';

test('defaults to a Groq vision model that accepts 3 images per request', () => {
  const config = loadConfig({});
  assert.equal(config.groqModel, 'qwen/qwen3.8-27b');
  assert.equal(config.maxPages, 3);
});

test('model and page limit can be overridden', () => {
  const config = loadConfig({ GROQ_MODEL: 'meta-models/muse-spark-open', GROQ_MAX_IMAGES: '5' });
  assert.equal(config.groqModel, 'meta-models/muse-spark-open');
  assert.equal(config.maxPages, 5);
});
