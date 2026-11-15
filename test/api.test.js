import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { createStore } from '../src/store.js';
import { normalizeDocumentData } from '../src/fields.js';
import { ExtractionError } from '../src/extractor.js';

// 1x1 transparent PNG
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const NOW = new Date('2025-06-15T12:00:00Z');

const CLEAN = {
  document_type: 'albaran', document_number: 'A-1', document_date: '2025-06-10',
  issuer_name: 'Proveedor SL', recipient_name: 'Cliente SA',
};

let dir, store, server, base, extractorResult, extractorCalls;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-a-datos-'));
  store = createStore(dir);
  extractorCalls = [];
  extractorResult = { data: normalizeDocumentData(CLEAN), confidence: {}, illegible: [], model: 'fake' };
  const extractor = {
    async extract(images) {
      extractorCalls.push(images);
      if (extractorResult instanceof Error) throw extractorResult;
      return extractorResult;
    },
  };
  const app = createApp({ store, extractor, config: { confidenceThreshold: 0.75, maxPages: 3 }, now: () => NOW });
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function api(method, url, body) {
  const res = await fetch(base + url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const type = res.headers.get('content-type') ?? '';
  return { status: res.status, body: type.includes('json') ? await res.json() : await res.arrayBuffer(), type };
}

test('POST /api/documents extracts, stores pages and returns warnings with pending status', async () => {
  extractorResult = {
    data: normalizeDocumentData({ ...CLEAN, recipient_name: null }),
    confidence: { document_number: 0.3 }, illegible: [], model: 'fake',
  };
  const res = await api('POST', '/api/documents', { images: [PNG, PNG], sourceName: 'foto.jpg', driver: 'Juan' });

  assert.equal(res.status, 201);
  assert.deepEqual(extractorCalls, [[PNG, PNG]]);
  const doc = res.body;
  assert.equal(doc.status, 'pending');
  assert.equal(doc.source_name, 'foto.jpg');
  assert.equal(doc.driver, 'Juan');
  assert.equal(doc.page_count, 2);
  assert.deepEqual(doc.warnings.map((w) => `${w.field}:${w.code}`).sort(), ['document_number:low_confidence', 'recipient_name:required']);
  assert.deepEqual(doc.pages, [`/api/documents/${doc.id}/pages/1`, `/api/documents/${doc.id}/pages/2`]);

  const page = await api('GET', doc.pages[0]);
  assert.equal(page.status, 200);
  assert.equal(page.type, 'image/png');
  assert.equal(Buffer.from(page.body).toString('base64'), PNG.split(',')[1]);
});

test('a document without warnings is stored with status ok', async () => {
  const res = await api('POST', '/api/documents', { images: [PNG] });
  assert.equal(res.status, 201);
  assert.equal(res.body.status, 'ok');
  assert.deepEqual(res.body.warnings, []);
});

test('rejects requests without images or with invalid images and stores nothing', async () => {
  const none = await api('POST', '/api/documents', { images: [] });
  assert.deepEqual(none, { status: 400, body: { error: 'No se ha recibido ninguna imagen' }, type: none.type });
  const bad = await api('POST', '/api/documents', { images: ['data:text/plain;base64,aGVsbG8='] });
  assert.deepEqual(bad, { status: 400, body: { error: 'Formato de imagen no válido (usa JPG, PNG o WEBP)' }, type: bad.type });
  assert.equal(extractorCalls.length, 0);
  assert.deepEqual((await api('GET', '/api/documents')).body, []);
});

test('extraction failures return the error and store nothing', async () => {
  extractorResult = new ExtractionError('Error de Groq (429): Rate limit reached');
  const res = await api('POST', '/api/documents', { images: [PNG] });
  assert.equal(res.status, 502);
  assert.deepEqual(res.body, { error: 'Error de Groq (429): Rate limit reached' });
  assert.deepEqual((await api('GET', '/api/documents')).body, []);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'uploads')), []);
});

test('GET /api/documents lists summaries, newest first, filterable by status', async () => {
  const ok = (await api('POST', '/api/documents', { images: [PNG] })).body;
  extractorResult = { ...extractorResult, data: normalizeDocumentData({ ...CLEAN, document_number: null }) };
  const pending = (await api('POST', '/api/documents', { images: [PNG] })).body;

  const all = (await api('GET', '/api/documents')).body;
  assert.deepEqual(all.map((d) => d.id), [pending.id, ok.id]);
  assert.deepEqual(Object.keys(all[0]).sort(), [
    'created_at', 'document_number', 'document_type', 'driver', 'id', 'issuer_name', 'status', 'total_amount', 'warning_count',
  ]);
  assert.equal(all[0].warning_count, 1);

  const queue = (await api('GET', '/api/documents?status=pending')).body;
  assert.deepEqual(queue.map((d) => d.id), [pending.id]);
});

test('GET unknown document returns 404', async () => {
  assert.deepEqual((await api('GET', '/api/documents/999')).body, { error: 'Documento no encontrado' });
  assert.equal((await api('GET', '/api/documents/999')).status, 404);
});

test('driver correction re-validates; confirmed or edited fields clear model doubts', async () => {
  extractorResult = {
    data: normalizeDocumentData({ ...CLEAN, recipient_name: null }),
    confidence: { document_number: 0.3, issuer_name: 0.2 }, illegible: [], model: 'fake',
  };
  const doc = (await api('POST', '/api/documents', { images: [PNG] })).body;

  // fix the required field, edit issuer_name, but leave document_number unconfirmed
  let res = await api('PUT', `/api/documents/${doc.id}`, {
    data: { ...doc.data, recipient_name: 'Cliente SA', issuer_name: 'Proveedor S.L.' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'pending');
  assert.deepEqual(res.body.warnings.map((w) => `${w.field}:${w.code}`), ['document_number:low_confidence']);

  res = await api('PUT', `/api/documents/${doc.id}`, { data: res.body.data, confirmed: ['document_number'] });
  assert.equal(res.body.status, 'ok');
  assert.deepEqual(res.body.warnings, []);
  assert.equal((await api('GET', `/api/documents/${doc.id}`)).body.status, 'ok');
});

test('office verification requires a reviewer and keeps remaining warnings for audit', async () => {
  extractorResult = { ...extractorResult, data: normalizeDocumentData({ ...CLEAN, document_number: null }) };
  const doc = (await api('POST', '/api/documents', { images: [PNG] })).body;

  const missing = await api('PUT', `/api/documents/${doc.id}`, { data: doc.data, action: 'verify' });
  assert.equal(missing.status, 400);
  assert.deepEqual(missing.body, { error: 'Indica quién valida el documento' });
  assert.equal((await api('GET', `/api/documents/${doc.id}`)).body.status, 'pending');

  const res = await api('PUT', `/api/documents/${doc.id}`, { data: doc.data, action: 'verify', reviewer: 'Ana' });
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'verified');
  assert.equal(res.body.reviewed_by, 'Ana');
  assert.equal(res.body.reviewed_at, NOW.toISOString());
  assert.deepEqual(res.body.warnings.map((w) => w.code), ['required']);
});

test('DELETE removes the document and its pages', async () => {
  const doc = (await api('POST', '/api/documents', { images: [PNG] })).body;
  assert.equal((await api('DELETE', `/api/documents/${doc.id}`)).status, 204);
  assert.equal((await api('GET', `/api/documents/${doc.id}`)).status, 404);
  assert.equal((await api('GET', doc.pages[0])).status, 404);
});

test('GET /api/schema exposes the field definitions for the UI', async () => {
  const res = await api('GET', '/api/schema');
  assert.equal(res.status, 200);
  assert.ok(res.body.fields.some((f) => f.key === 'total_amount' && f.label === 'Total'));
  assert.ok(res.body.lineFields.some((f) => f.key === 'amount'));
  assert.deepEqual(res.body.documentTypes.map((t) => t.value), ['albaran', 'factura', 'cmr', 'otro']);
  assert.equal(res.body.maxPages, 3);
});
