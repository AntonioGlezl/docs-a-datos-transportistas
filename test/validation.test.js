import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateDocument, isValidSpanishTaxId } from '../src/validation.js';
import { normalizeDocumentData } from '../src/fields.js';

const NOW = new Date('2025-06-15T12:00:00Z');

function cleanInvoice(overrides = {}) {
  return normalizeDocumentData({
    document_type: 'factura',
    document_number: 'F-2025-001',
    document_date: '2025-06-10',
    delivery_date: '2025-06-11',
    issuer_name: 'Transportes Ejemplo SL',
    issuer_tax_id: 'B12345674',
    recipient_name: 'Cliente SA',
    recipient_tax_id: '12345678Z',
    net_amount: 100,
    vat_rate: 21,
    vat_amount: 21,
    total_amount: 121,
    lines: [
      { description: 'Palet', quantity: 2, unit_price: 30, amount: 60 },
      { description: 'Caja', quantity: 4, unit_price: 10, amount: 40 },
    ],
    ...overrides,
  });
}

function codes(warnings) {
  return warnings.map((w) => `${w.field}:${w.code}`).sort();
}

test('a consistent invoice produces no warnings', () => {
  assert.deepEqual(validateDocument(cleanInvoice(), { now: NOW }), []);
});

test('every warning has field, code and a Spanish message', () => {
  const warnings = validateDocument(cleanInvoice({ document_number: null }), { now: NOW });
  assert.equal(warnings.length, 1);
  assert.deepEqual(Object.keys(warnings[0]).sort(), ['code', 'field', 'message']);
  assert.equal(warnings[0].message, 'Campo obligatorio vacío: Nº documento');
});

test('required fields depend on the document type', () => {
  const invoice = cleanInvoice({ issuer_tax_id: null, total_amount: null, net_amount: null, vat_amount: null, lines: [] });
  assert.deepEqual(codes(validateDocument(invoice, { now: NOW })), [
    'issuer_tax_id:required',
    'total_amount:required',
  ]);

  const cmr = normalizeDocumentData({
    document_type: 'cmr', document_number: '123', document_date: '2025-06-10', issuer_name: 'A',
  });
  assert.deepEqual(codes(validateDocument(cmr, { now: NOW })), [
    'carrier_name:required',
    'delivery_place:required',
    'loading_place:required',
  ]);

  const albaran = normalizeDocumentData({
    document_type: 'albaran', document_number: '123', document_date: '2025-06-10', issuer_name: 'A',
  });
  assert.deepEqual(codes(validateDocument(albaran, { now: NOW })), ['recipient_name:required']);
});

test('unknown document type is flagged', () => {
  const doc = normalizeDocumentData({ document_type: 'ticket', document_number: '1', document_date: '2025-06-10', issuer_name: 'A' });
  assert.deepEqual(codes(validateDocument(doc, { now: NOW })), ['document_type:unknown_type']);
});

test('Spanish tax ids are checked; NIF, NIE and CIF control characters', () => {
  assert.equal(isValidSpanishTaxId('12345678Z'), true);
  assert.equal(isValidSpanishTaxId('X1234567L'), true);
  assert.equal(isValidSpanishTaxId('B12345674'), true);
  assert.equal(isValidSpanishTaxId('ESB12345674'), true);
  assert.equal(isValidSpanishTaxId('12345678A'), false);
  assert.equal(isValidSpanishTaxId('B12345675'), false);
  assert.equal(isValidSpanishTaxId('ABC'), false);
});

test('invalid Spanish tax id is flagged, foreign VAT ids are not', () => {
  const bad = cleanInvoice({ issuer_tax_id: '12345678A' });
  assert.deepEqual(codes(validateDocument(bad, { now: NOW })), ['issuer_tax_id:invalid_tax_id']);
  const foreign = cleanInvoice({ recipient_tax_id: 'FR40303265045' });
  assert.deepEqual(validateDocument(foreign, { now: NOW }), []);
});

test('invalid, future and out-of-order dates are flagged', () => {
  assert.deepEqual(codes(validateDocument(cleanInvoice({ document_date: '2025-13-40' }), { now: NOW })), ['document_date:invalid_date']);
  assert.deepEqual(codes(validateDocument(cleanInvoice({ document_date: '2025-07-01', delivery_date: null }), { now: NOW })), ['document_date:future_date']);
  assert.deepEqual(codes(validateDocument(cleanInvoice({ delivery_date: '2025-06-01' }), { now: NOW })), ['delivery_date:date_order']);
});

test('amount inconsistencies are flagged with a tolerance of 0.02', () => {
  assert.deepEqual(validateDocument(cleanInvoice({ total_amount: 121.01 }), { now: NOW }), []);
  assert.deepEqual(codes(validateDocument(cleanInvoice({ total_amount: 125 }), { now: NOW })), ['total_amount:total_mismatch']);
  assert.deepEqual(codes(validateDocument(cleanInvoice({ vat_amount: 20, total_amount: 120 }), { now: NOW })), ['vat_amount:vat_mismatch']);
});

test('line items are checked against their own price and the net amount', () => {
  const lines = [
    { description: 'Palet', quantity: 2, unit_price: 30, amount: 70 },
    { description: 'Caja', quantity: 4, unit_price: 10, amount: 40 },
  ];
  assert.deepEqual(codes(validateDocument(cleanInvoice({ lines }), { now: NOW })), [
    'lines[0].amount:line_mismatch',
    'net_amount:lines_mismatch',
  ]);
});

test('negative quantities are flagged', () => {
  assert.deepEqual(codes(validateDocument(cleanInvoice({ packages: -3 }), { now: NOW })), ['packages:negative']);
});

test('low model confidence and illegible fields are flagged', () => {
  const warnings = validateDocument(cleanInvoice(), {
    now: NOW,
    confidence: { document_number: 0.4, issuer_name: 0.9 },
    illegible: ['recipient_name'],
    threshold: 0.75,
  });
  assert.deepEqual(codes(warnings), ['document_number:low_confidence', 'recipient_name:illegible']);
  assert.equal(warnings.find((w) => w.code === 'low_confidence').message, 'Confianza baja (40%) en: Nº documento');
});

test('a field gets at most one warning per code', () => {
  const warnings = validateDocument(cleanInvoice({ document_number: null }), {
    now: NOW, illegible: ['document_number', 'document_number'],
  });
  assert.deepEqual(codes(warnings), ['document_number:illegible', 'document_number:required']);
});

test('normalizeDocumentData parses Spanish and English number formats', () => {
  const d = normalizeDocumentData({ total_amount: '1.234,56 €', net_amount: '1,020.30', vat_rate: '21%', document_type: 'Albarán' });
  assert.equal(d.total_amount, 1234.56);
  assert.equal(d.net_amount, 1020.3);
  assert.equal(d.vat_rate, 21);
  assert.equal(d.document_type, 'albaran');
});
