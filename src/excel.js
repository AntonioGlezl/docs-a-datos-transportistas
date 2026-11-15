// Accumulated Excel workbook: one row per document, one row per line item and one row per warning.
// Doubtful cells are highlighted so the office can spot them at a glance.

import ExcelJS from 'exceljs';
import { FIELDS, LINE_FIELDS, DOCUMENT_TYPE_LABELS, STATUSES } from './fields.js';
import { fieldLabel } from './validation.js';

export const DOUBTFUL_FILL = 'FFFFE08A';
const HEADER_FILL = 'FF1F3A5F';

function toCellValue(field, value) {
  if (value === null || value === undefined) return null;
  if (field.type === 'boolean') return value ? 'Sí' : 'No';
  if (field.type === 'enum' && field.key === 'document_type') return DOCUMENT_TYPE_LABELS[value] ?? value;
  if (field.type === 'date') {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    const date = m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) : null;
    return date && !Number.isNaN(date.getTime()) ? date : value;
  }
  return value;
}

function styleHeader(sheet) {
  const header = sheet.getRow(1);
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_FILL } };
  });
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: sheet.columnCount } };
}

function markDoubtful(cell, comment) {
  cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: DOUBTFUL_FILL } };
  if (comment) cell.note = comment;
}

/**
 * @param {object[]} docs stored documents (see store.get), in the order they should appear
 * @returns {Promise<Buffer>}
 */
export async function buildWorkbook(docs) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'docs-a-datos';
  wb.created = new Date();

  const docsSheet = wb.addWorksheet('Documentos');
  docsSheet.columns = [
    { header: 'ID', key: 'id', width: 6 },
    { header: 'Fecha registro', key: 'created_at', width: 18, style: { numFmt: 'dd/mm/yyyy hh:mm' } },
    { header: 'Estado', key: 'status', width: 20 },
    { header: 'Repartidor', key: 'driver', width: 16 },
    { header: 'Archivo', key: 'source_name', width: 20 },
    ...FIELDS.map((f) => ({
      header: f.label,
      key: f.key,
      width: f.type === 'text' ? 24 : 14,
      style: f.type === 'date' ? { numFmt: 'dd/mm/yyyy' } : f.type === 'number' ? { numFmt: '#,##0.00' } : {},
    })),
    { header: 'Nº avisos', key: 'warning_count', width: 10 },
    { header: 'Avisos', key: 'warnings', width: 60 },
    { header: 'Validado por', key: 'reviewed_by', width: 16 },
    { header: 'Fecha validación', key: 'reviewed_at', width: 18, style: { numFmt: 'dd/mm/yyyy hh:mm' } },
  ];

  const linesSheet = wb.addWorksheet('Líneas');
  linesSheet.columns = [
    { header: 'ID documento', key: 'doc_id', width: 12 },
    { header: 'Nº documento', key: 'document_number', width: 18 },
    { header: 'Línea', key: 'line', width: 8 },
    ...LINE_FIELDS.map((f) => ({
      header: f.label, key: f.key, width: f.key === 'description' ? 40 : 14,
      style: f.type === 'number' ? { numFmt: '#,##0.00' } : {},
    })),
  ];

  const warningsSheet = wb.addWorksheet('Avisos');
  warningsSheet.columns = [
    { header: 'ID documento', key: 'doc_id', width: 12 },
    { header: 'Nº documento', key: 'document_number', width: 18 },
    { header: 'Campo', key: 'field', width: 26 },
    { header: 'Código', key: 'code', width: 18 },
    { header: 'Mensaje', key: 'message', width: 70 },
  ];

  for (const doc of docs) {
    const warnings = doc.warnings ?? [];
    const byField = new Map();
    for (const w of warnings) byField.set(w.field, [...(byField.get(w.field) ?? []), w.message]);

    const row = docsSheet.addRow({
      id: doc.id,
      created_at: doc.created_at ? new Date(doc.created_at) : null,
      status: STATUSES[doc.status] ?? doc.status,
      driver: doc.driver ?? null,
      source_name: doc.source_name ?? null,
      ...Object.fromEntries(FIELDS.map((f) => [f.key, toCellValue(f, doc.data[f.key])])),
      warning_count: warnings.length,
      warnings: warnings.map((w) => w.message).join('; ') || null,
      reviewed_by: doc.reviewed_by ?? null,
      reviewed_at: doc.reviewed_at ? new Date(doc.reviewed_at) : null,
    });
    for (const f of FIELDS) {
      if (byField.has(f.key)) markDoubtful(row.getCell(f.key), byField.get(f.key).join('\n'));
    }
    if (warnings.length) markDoubtful(row.getCell('warning_count'));

    (doc.data.lines ?? []).forEach((line, i) => {
      const lineRow = linesSheet.addRow({
        doc_id: doc.id,
        document_number: doc.data.document_number,
        line: i + 1,
        ...Object.fromEntries(LINE_FIELDS.map((f) => [f.key, line[f.key] ?? null])),
      });
      for (const f of LINE_FIELDS) {
        const messages = byField.get(`lines[${i}].${f.key}`);
        if (messages) markDoubtful(lineRow.getCell(f.key), messages.join('\n'));
      }
    });

    for (const w of warnings) {
      warningsSheet.addRow({
        doc_id: doc.id, document_number: doc.data.document_number, field: fieldLabel(w.field), code: w.code, message: w.message,
      });
    }
  }

  for (const sheet of [docsSheet, linesSheet, warningsSheet]) styleHeader(sheet);
  return Buffer.from(await wb.xlsx.writeBuffer());
}
