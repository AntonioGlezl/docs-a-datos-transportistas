// Single source of truth for the extracted document schema.
// Keys are used in the API, the database JSON, the Excel export and the UI.
// Labels are user-facing (Spanish).

export const DOCUMENT_TYPES = ['albaran', 'factura', 'cmr', 'otro'];

export const DOCUMENT_TYPE_LABELS = {
  albaran: 'Albarán',
  factura: 'Factura',
  cmr: 'CMR',
  otro: 'Otro',
};

/** @type {{key: string, label: string, type: 'text'|'date'|'number'|'nif'|'enum'|'boolean', group: string}[]} */
export const FIELDS = [
  { key: 'document_type', label: 'Tipo de documento', type: 'enum', group: 'Documento' },
  { key: 'document_number', label: 'Nº documento', type: 'text', group: 'Documento' },
  { key: 'document_date', label: 'Fecha documento', type: 'date', group: 'Documento' },
  { key: 'delivery_date', label: 'Fecha entrega', type: 'date', group: 'Documento' },
  { key: 'order_reference', label: 'Referencia pedido', type: 'text', group: 'Documento' },

  { key: 'issuer_name', label: 'Emisor', type: 'text', group: 'Emisor' },
  { key: 'issuer_tax_id', label: 'NIF/CIF emisor', type: 'nif', group: 'Emisor' },
  { key: 'issuer_address', label: 'Dirección emisor', type: 'text', group: 'Emisor' },

  { key: 'recipient_name', label: 'Destinatario', type: 'text', group: 'Destinatario' },
  { key: 'recipient_tax_id', label: 'NIF/CIF destinatario', type: 'nif', group: 'Destinatario' },
  { key: 'recipient_address', label: 'Dirección destinatario', type: 'text', group: 'Destinatario' },

  { key: 'carrier_name', label: 'Transportista', type: 'text', group: 'Transporte' },
  { key: 'carrier_tax_id', label: 'NIF/CIF transportista', type: 'nif', group: 'Transporte' },
  { key: 'vehicle_plate', label: 'Matrícula', type: 'text', group: 'Transporte' },
  { key: 'loading_place', label: 'Lugar de carga', type: 'text', group: 'Transporte' },
  { key: 'delivery_place', label: 'Lugar de entrega', type: 'text', group: 'Transporte' },
  { key: 'packages', label: 'Bultos', type: 'number', group: 'Transporte' },
  { key: 'gross_weight_kg', label: 'Peso bruto (kg)', type: 'number', group: 'Transporte' },

  { key: 'net_amount', label: 'Base imponible', type: 'number', group: 'Importes' },
  { key: 'vat_rate', label: 'IVA (%)', type: 'number', group: 'Importes' },
  { key: 'vat_amount', label: 'Cuota IVA', type: 'number', group: 'Importes' },
  { key: 'total_amount', label: 'Total', type: 'number', group: 'Importes' },
  { key: 'currency', label: 'Moneda', type: 'text', group: 'Importes' },

  { key: 'receiver_signed', label: 'Firmado por receptor', type: 'boolean', group: 'Otros' },
  { key: 'notes', label: 'Observaciones', type: 'text', group: 'Otros' },
];

export const LINE_FIELDS = [
  { key: 'reference', label: 'Referencia', type: 'text' },
  { key: 'description', label: 'Descripción', type: 'text' },
  { key: 'quantity', label: 'Cantidad', type: 'number' },
  { key: 'unit', label: 'Unidad', type: 'text' },
  { key: 'unit_price', label: 'Precio unitario', type: 'number' },
  { key: 'amount', label: 'Importe', type: 'number' },
];

export const FIELD_KEYS = FIELDS.map((f) => f.key);
export const LINE_FIELD_KEYS = LINE_FIELDS.map((f) => f.key);

/** Builds an empty document data object with every known field set to null. */
export function emptyDocumentData() {
  const data = Object.fromEntries(FIELD_KEYS.map((k) => [k, null]));
  data.lines = [];
  return data;
}

/** Keeps only known fields and coerces their values to the declared types. */
export function normalizeDocumentData(raw = {}) {
  const data = emptyDocumentData();
  for (const field of FIELDS) {
    data[field.key] = coerce(raw[field.key], field.type);
  }
  if (data.document_type !== null) {
    const t = String(data.document_type).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    data.document_type = DOCUMENT_TYPES.includes(t) ? t : 'otro';
  }
  const lines = Array.isArray(raw.lines) ? raw.lines : [];
  data.lines = lines
    .filter((l) => l && typeof l === 'object')
    .map((l) => Object.fromEntries(LINE_FIELDS.map((f) => [f.key, coerce(l[f.key], f.type)])));
  return data;
}

function coerce(value, type) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  switch (type) {
    case 'number':
      return parseNumber(value);
    case 'boolean':
      if (typeof value === 'boolean') return value;
      if (/^(true|s[ií]|yes|1)$/i.test(String(value).trim())) return true;
      if (/^(false|no|0)$/i.test(String(value).trim())) return false;
      return null;
    case 'nif':
      return String(value).toUpperCase().replace(/[\s.\-]/g, '');
    default:
      return String(value).trim();
  }
}

/** Parses numbers written in Spanish ("1.234,56") or English ("1,234.56") notation. */
export function parseNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  let s = String(value).trim().replace(/[€$£\s%]/g, '').replace(/eur$/i, '');
  if (s === '') return null;
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma > -1 && lastDot > -1) {
    s = lastComma > lastDot ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  } else if (lastComma > -1) {
    s = s.replace(',', '.');
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
