// Deterministic checks that flag doubtful extracted data for human review.
// The model's own confidence is combined with rules the model cannot be trusted with
// (tax id control characters, arithmetic, date sanity, required fields).

import { FIELDS, LINE_FIELDS, DOCUMENT_TYPES } from './fields.js';

const TOLERANCE = 0.02;
const COMMON_REQUIRED = ['document_type', 'document_number', 'document_date', 'issuer_name'];
const REQUIRED_BY_TYPE = {
  factura: ['issuer_tax_id', 'total_amount'],
  albaran: ['recipient_name'],
  cmr: ['carrier_name', 'loading_place', 'delivery_place'],
  otro: [],
};

const FIELD_BY_KEY = Object.fromEntries(FIELDS.map((f) => [f.key, f]));
const LINE_FIELD_BY_KEY = Object.fromEntries(LINE_FIELDS.map((f) => [f.key, f]));

/** Human-readable label for a field path such as "issuer_name" or "lines[2].amount". */
export function fieldLabel(path) {
  const m = /^lines\[(\d+)\]\.(\w+)$/.exec(path);
  if (m) return `Línea ${Number(m[1]) + 1} – ${LINE_FIELD_BY_KEY[m[2]]?.label ?? m[2]}`;
  return FIELD_BY_KEY[path]?.label ?? path;
}

const NIF_LETTERS = 'TRWAGMYFPDXBNJZSQVHLCKE';

/** Validates a Spanish NIF, NIE or CIF (optionally prefixed with "ES"). */
export function isValidSpanishTaxId(value) {
  let id = String(value ?? '').toUpperCase().replace(/[\s.\-]/g, '');
  if (id.startsWith('ES')) id = id.slice(2);

  if (/^\d{8}[A-Z]$/.test(id)) {
    return NIF_LETTERS[Number(id.slice(0, 8)) % 23] === id[8];
  }
  if (/^[XYZ]\d{7}[A-Z]$/.test(id)) {
    const num = 'XYZ'.indexOf(id[0]) + id.slice(1, 8);
    return NIF_LETTERS[Number(num) % 23] === id[8];
  }
  if (/^[ABCDEFGHJNPQRSUVW]\d{7}[0-9A-J]$/.test(id)) {
    const digits = id.slice(1, 8);
    let sum = 0;
    for (let i = 0; i < 7; i++) {
      let d = Number(digits[i]);
      if (i % 2 === 0) {
        d *= 2;
        d = Math.floor(d / 10) + (d % 10);
      }
      sum += d;
    }
    const control = (10 - (sum % 10)) % 10;
    const check = id[8];
    return check === String(control) || check === 'JABCDEFGHI'[control];
  }
  return false;
}

/** True when the id carries a non-Spanish two-letter VAT country prefix (not checked). */
function isForeignVatId(id) {
  return /^[A-Z]{2}/.test(id) && !id.startsWith('ES');
}

function parseIsoDate(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value));
  if (!m) return null;
  const date = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (date.getUTCMonth() !== Number(m[2]) - 1 || date.getUTCDate() !== Number(m[3])) return null;
  return date;
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const differs = (a, b) => Math.abs(a - b) > TOLERANCE + 1e-9;
const fmt = (n) => (Math.round(n * 100) / 100).toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * Returns the list of warnings for a normalized document.
 * @param {object} data normalized document data (see normalizeDocumentData)
 * @param {{confidence?: Record<string, number>, illegible?: string[], threshold?: number, now?: Date}} [options]
 * @returns {{field: string, code: string, message: string}[]}
 */
export function validateDocument(data, options = {}) {
  const { confidence = {}, illegible = [], threshold = 0.75, now = new Date() } = options;
  const warnings = [];
  const seen = new Set();
  const add = (field, code, message) => {
    const id = `${field}:${code}`;
    if (seen.has(id)) return;
    seen.add(id);
    warnings.push({ field, code, message });
  };
  const empty = (v) => v === null || v === undefined || v === '';

  // Document type and required fields
  const type = data.document_type;
  if (!empty(type) && (!DOCUMENT_TYPES.includes(type) || type === 'otro')) {
    add('document_type', 'unknown_type', 'Tipo de documento no reconocido');
  }
  const required = [...COMMON_REQUIRED, ...(REQUIRED_BY_TYPE[type] ?? [])];
  for (const key of required) {
    if (empty(data[key])) add(key, 'required', `Campo obligatorio vacío: ${fieldLabel(key)}`);
  }

  // Tax ids
  for (const field of FIELDS.filter((f) => f.type === 'nif')) {
    const id = data[field.key];
    if (empty(id) || isForeignVatId(id)) continue;
    if (!isValidSpanishTaxId(id)) add(field.key, 'invalid_tax_id', `NIF/CIF no válido: ${fieldLabel(field.key)}`);
  }

  // Dates
  const dates = {};
  for (const field of FIELDS.filter((f) => f.type === 'date')) {
    const raw = data[field.key];
    if (empty(raw)) continue;
    const date = parseIsoDate(raw);
    if (!date) {
      add(field.key, 'invalid_date', `Fecha no válida: ${fieldLabel(field.key)}`);
      continue;
    }
    dates[field.key] = date;
    if (date.getTime() > now.getTime() + 24 * 3600 * 1000) {
      add(field.key, 'future_date', `Fecha en el futuro: ${fieldLabel(field.key)}`);
    }
  }
  if (dates.document_date && dates.delivery_date && dates.delivery_date < dates.document_date) {
    add('delivery_date', 'date_order', 'La fecha de entrega es anterior a la fecha del documento');
  }

  // Negative values
  for (const field of FIELDS.filter((f) => f.type === 'number')) {
    if (isNum(data[field.key]) && data[field.key] < 0) add(field.key, 'negative', `Valor negativo en: ${fieldLabel(field.key)}`);
  }

  // Amount arithmetic
  const { net_amount: net, vat_rate: rate, vat_amount: vat, total_amount: total } = data;
  if (isNum(net) && isNum(vat) && isNum(total) && differs(net + vat, total)) {
    add('total_amount', 'total_mismatch', `Base + IVA (${fmt(net + vat)}) no coincide con el total (${fmt(total)})`);
  }
  if (isNum(net) && isNum(rate) && isNum(vat) && differs((net * rate) / 100, vat)) {
    add('vat_amount', 'vat_mismatch', `Base × IVA% (${fmt((net * rate) / 100)}) no coincide con la cuota de IVA (${fmt(vat)})`);
  }

  // Line items
  const lines = Array.isArray(data.lines) ? data.lines : [];
  lines.forEach((line, i) => {
    if (isNum(line.quantity) && isNum(line.unit_price) && isNum(line.amount) && differs(line.quantity * line.unit_price, line.amount)) {
      add(`lines[${i}].amount`, 'line_mismatch',
        `Línea ${i + 1}: cantidad × precio (${fmt(line.quantity * line.unit_price)}) no coincide con el importe (${fmt(line.amount)})`);
    }
  });
  if (lines.length > 0 && lines.every((l) => isNum(l.amount))) {
    const sum = lines.reduce((acc, l) => acc + l.amount, 0);
    const target = isNum(net) ? 'net_amount' : isNum(total) && !isNum(vat) ? 'total_amount' : null;
    if (target && differs(sum, data[target])) {
      add(target, 'lines_mismatch', `Suma de líneas (${fmt(sum)}) no coincide con ${fieldLabel(target)} (${fmt(data[target])})`);
    }
  }

  // Model-reported uncertainty
  for (const [field, value] of Object.entries(confidence ?? {})) {
    if (isNum(value) && value < threshold) {
      add(field, 'low_confidence', `Confianza baja (${Math.round(value * 100)}%) en: ${fieldLabel(field)}`);
    }
  }
  for (const field of illegible ?? []) {
    add(field, 'illegible', `Ilegible o dudoso: ${fieldLabel(field)}`);
  }

  return warnings;
}
