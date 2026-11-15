import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGroqExtractor, ExtractionError, MAX_IMAGES } from '../src/extractor.js';

const IMG = 'data:image/jpeg;base64,AAAA';

function fakeFetch(responseBody, { status = 200 } = {}) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => responseBody,
      text: async () => JSON.stringify(responseBody),
    };
  };
  fn.calls = calls;
  return fn;
}

function completion(content) {
  return { choices: [{ message: { content } }] };
}

test('sends images to the Groq chat completions API with the key and model', async () => {
  const fetch = fakeFetch(completion(JSON.stringify({ data: { document_type: 'cmr' }, confidence: {}, illegible: [] })));
  const extractor = createGroqExtractor({ apiKey: 'gsk_test', model: 'vision-model', fetch });
  await extractor.extract([IMG, IMG]);

  assert.equal(fetch.calls.length, 1);
  const { url, init, body } = fetch.calls[0];
  assert.equal(url, 'https://api.groq.com/openai/v1/chat/completions');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers.Authorization, 'Bearer gsk_test');
  assert.equal(body.model, 'vision-model');
  assert.equal(body.temperature, 0);
  assert.deepEqual(body.response_format, { type: 'json_object' });
  const content = body.messages.at(-1).content;
  assert.equal(content.filter((c) => c.type === 'image_url').length, 2);
  assert.equal(content.find((c) => c.type === 'image_url').image_url.url, IMG);
});

test('returns normalized data, confidence and illegible fields', async () => {
  const payload = {
    data: { document_type: 'Factura', total_amount: '1.210,00', unknown_field: 'x', lines: [{ description: 'A', amount: '10' }] },
    confidence: { total_amount: 0.5, bogus: 'high' },
    illegible: ['issuer_tax_id', 42],
  };
  const extractor = createGroqExtractor({ apiKey: 'k', model: 'm', fetch: fakeFetch(completion(JSON.stringify(payload))) });
  const result = await extractor.extract([IMG]);

  assert.equal(result.data.document_type, 'factura');
  assert.equal(result.data.total_amount, 1210);
  assert.equal('unknown_field' in result.data, false);
  assert.equal(result.data.lines[0].amount, 10);
  assert.deepEqual(result.confidence, { total_amount: 0.5 });
  assert.deepEqual(result.illegible, ['issuer_tax_id']);
});

test('accepts JSON wrapped in a markdown code fence', async () => {
  const content = '```json\n{"data":{"document_number":"A1"},"confidence":{},"illegible":[]}\n```';
  const extractor = createGroqExtractor({ apiKey: 'k', model: 'm', fetch: fakeFetch(completion(content)) });
  const result = await extractor.extract([IMG]);
  assert.equal(result.data.document_number, 'A1');
});

test('only the first MAX_IMAGES pages are sent', async () => {
  const fetch = fakeFetch(completion('{"data":{}}'));
  const extractor = createGroqExtractor({ apiKey: 'k', model: 'm', fetch });
  await extractor.extract(Array(MAX_IMAGES + 3).fill(IMG));
  const content = fetch.calls[0].body.messages.at(-1).content;
  assert.equal(content.filter((c) => c.type === 'image_url').length, MAX_IMAGES);
});

test('fails with ExtractionError when the API key is missing, without calling the API', async () => {
  const fetch = fakeFetch(completion('{}'));
  const extractor = createGroqExtractor({ apiKey: '', model: 'm', fetch });
  await assert.rejects(extractor.extract([IMG]), (err) => err instanceof ExtractionError && err.message === 'Falta GROQ_API_KEY en la configuración del servidor');
  assert.equal(fetch.calls.length, 0);
});

test('fails with ExtractionError on HTTP errors, including the API message', async () => {
  const fetch = fakeFetch({ error: { message: 'Rate limit reached' } }, { status: 429 });
  const extractor = createGroqExtractor({ apiKey: 'k', model: 'm', fetch });
  await assert.rejects(extractor.extract([IMG]), (err) => err instanceof ExtractionError && err.message === 'Error de Groq (429): Rate limit reached');
});

test('fails with ExtractionError when the model output is not JSON', async () => {
  const extractor = createGroqExtractor({ apiKey: 'k', model: 'm', fetch: fakeFetch(completion('no puedo leerlo')) });
  await assert.rejects(extractor.extract([IMG]), (err) => err instanceof ExtractionError && err.message === 'La IA no devolvió un JSON válido');
});

test('fails with ExtractionError when no image is given', async () => {
  const extractor = createGroqExtractor({ apiKey: 'k', model: 'm', fetch: fakeFetch(completion('{}')) });
  await assert.rejects(extractor.extract([]), (err) => err instanceof ExtractionError && err.message === 'No se ha recibido ninguna imagen');
});
