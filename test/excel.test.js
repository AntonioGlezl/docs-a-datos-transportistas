import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { buildWorkbook, DOUBTFUL_FILL } from '../src/excel.js';
import { createApp } from '../src/app.js';
import { createStore } from '../src/store.js';
import { normalizeDocumentData } from '../src/fields.js';

function makeDoc(id, overrides = {}) {
  return {
    id,
    created_at: '2025-06-15T12:00:00.000Z',
    status: 'pending',
    driver: 'Juan',
    source_name: 'foto.jpg',
    reviewed_by: null,
    reviewed_at: null,
    data: normalizeDocumentData({
      document_type: 'factura', document_number: `F-${id}`, document_date: '2025-06-10',
      issuer_name: 'Proveedor SL', total_amount: 121, receiver_signed: true,
      lines: [{ description: 'Palet', quantity: 2, unit_price: 30, amount: 70 }],
    }),
    warnings: [
      { field: 'total_amount', code: 'low_confidence', message: 'Confianza baja (40%) en: Total' },
      { field: 'lines[0].amount', code: 'line_mismatch', message: 'Línea 1: no coincide' },
    ],
    ...overrides,
  };
}

async function load(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  return wb;
}

function headerIndex(sheet, label) {
  const values = sheet.getRow(1).values;
  const idx = values.indexOf(label);
  assert.notEqual(idx, -1, `missing column ${label}`);
  return idx;
}

test('workbook has Documentos, Líneas and Avisos sheets', async () => {
  const wb = await load(await buildWorkbook([makeDoc(1)]));
  assert.deepEqual(wb.worksheets.map((s) => s.name), ['Documentos', 'Líneas', 'Avisos']);
});

test('Documentos has one row per document with typed values and a warnings column', async () => {
  const wb = await load(await buildWorkbook([makeDoc(1), makeDoc(2, { status: 'verified', reviewed_by: 'Ana', warnings: [] })]));
  const sheet = wb.getWorksheet('Documentos');
  assert.equal(sheet.rowCount, 3);

  const row = sheet.getRow(2);
  assert.equal(row.getCell(headerIndex(sheet, 'ID')).value, 1);
  assert.equal(row.getCell(headerIndex(sheet, 'Estado')).value, 'Pendiente de revisión');
  assert.equal(row.getCell(headerIndex(sheet, 'Tipo de documento')).value, 'Factura');
  assert.equal(row.getCell(headerIndex(sheet, 'Total')).value, 121);
  assert.equal(row.getCell(headerIndex(sheet, 'Firmado por receptor')).value, 'Sí');
  const date = row.getCell(headerIndex(sheet, 'Fecha documento')).value;
  assert.ok(date instanceof Date);
  assert.equal(date.toISOString().slice(0, 10), '2025-06-10');
  assert.equal(row.getCell(headerIndex(sheet, 'Nº avisos')).value, 2);
  assert.equal(row.getCell(headerIndex(sheet, 'Avisos')).value, 'Confianza baja (40%) en: Total; Línea 1: no coincide');

  const verified = sheet.getRow(3);
  assert.equal(verified.getCell(headerIndex(sheet, 'Estado')).value, 'Validado');
  assert.equal(verified.getCell(headerIndex(sheet, 'Validado por')).value, 'Ana');
  assert.equal(verified.getCell(headerIndex(sheet, 'Nº avisos')).value, 0);
});

test('doubtful cells are highlighted in Documentos and Líneas', async () => {
  const wb = await load(await buildWorkbook([makeDoc(1)]));
  const docs = wb.getWorksheet('Documentos');
  assert.equal(docs.getRow(2).getCell(headerIndex(docs, 'Total')).fill?.fgColor?.argb, DOUBTFUL_FILL);
  assert.equal(docs.getRow(2).getCell(headerIndex(docs, 'Emisor')).fill?.fgColor?.argb, undefined);

  const lines = wb.getWorksheet('Líneas');
  assert.equal(lines.rowCount, 2);
  const row = lines.getRow(2);
  assert.equal(row.getCell(headerIndex(lines, 'ID documento')).value, 1);
  assert.equal(row.getCell(headerIndex(lines, 'Nº documento')).value, 'F-1');
  assert.equal(row.getCell(headerIndex(lines, 'Línea')).value, 1);
  assert.equal(row.getCell(headerIndex(lines, 'Importe')).value, 70);
  assert.equal(row.getCell(headerIndex(lines, 'Importe')).fill?.fgColor?.argb, DOUBTFUL_FILL);
});

test('Avisos lists one row per warning', async () => {
  const wb = await load(await buildWorkbook([makeDoc(1)]));
  const sheet = wb.getWorksheet('Avisos');
  assert.equal(sheet.rowCount, 3);
  assert.deepEqual(sheet.getRow(2).values.slice(1), [1, 'F-1', 'Total', 'low_confidence', 'Confianza baja (40%) en: Total']);
  assert.deepEqual(sheet.getRow(3).values.slice(1), [1, 'F-1', 'Línea 1 – Importe', 'line_mismatch', 'Línea 1: no coincide']);
});

test('an empty export still has the header rows', async () => {
  const wb = await load(await buildWorkbook([]));
  assert.equal(wb.getWorksheet('Documentos').rowCount, 1);
  assert.equal(wb.getWorksheet('Líneas').rowCount, 1);
  assert.equal(wb.getWorksheet('Avisos').rowCount, 1);
});

test('GET /api/export.xlsx downloads the accumulated workbook, filterable by status', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-a-datos-xlsx-'));
  const store = createStore(dir);
  const png = { buffer: Buffer.from('x'), ext: 'png' };
  const base = { confidence: {}, illegible: [], warnings: [], created_at: '2025-06-15T12:00:00.000Z' };
  store.create({ ...base, status: 'ok', data: normalizeDocumentData({ document_number: 'A' }) }, [png]);
  store.create({ ...base, status: 'pending', data: normalizeDocumentData({ document_number: 'B' }) }, [png]);
  const app = createApp({
    store, extractor: {}, config: { confidenceThreshold: 0.75 }, exportWorkbook: buildWorkbook,
    now: () => new Date('2025-06-15T12:00:00Z'),
  });
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  try {
    const url = `http://127.0.0.1:${server.address().port}/api/export.xlsx`;
    const res = await fetch(url);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    assert.equal(res.headers.get('content-disposition'), 'attachment; filename="documentos-2025-06-15.xlsx"');
    const sheet = (await load(Buffer.from(await res.arrayBuffer()))).getWorksheet('Documentos');
    const col = headerIndex(sheet, 'Nº documento');
    assert.deepEqual([sheet.getRow(2).getCell(col).value, sheet.getRow(3).getCell(col).value], ['A', 'B']);

    const filtered = (await load(Buffer.from(await (await fetch(`${url}?status=pending`)).arrayBuffer()))).getWorksheet('Documentos');
    assert.equal(filtered.rowCount, 2);
    assert.equal(filtered.getRow(2).getCell(col).value, 'B');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
