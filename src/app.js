import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { FIELDS, LINE_FIELDS, DOCUMENT_TYPES, DOCUMENT_TYPE_LABELS, FIELD_KEYS, LINE_FIELD_KEYS, STATUSES, normalizeDocumentData } from './fields.js';
import { validateDocument } from './validation.js';
import { ExtractionError } from './extractor.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IMAGE_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };


class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function decodeImage(dataUrl) {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=\s]+)$/.exec(String(dataUrl ?? ''));
  if (!m) throw new HttpError(400, 'Formato de imagen no válido (usa JPG, PNG o WEBP)');
  return { buffer: Buffer.from(m[2], 'base64'), ext: IMAGE_TYPES[m[1]] };
}

/** Field paths whose value differs between two normalized documents. */
function changedFields(before, after) {
  const changed = FIELD_KEYS.filter((k) => before[k] !== after[k]);
  const count = Math.max(before.lines.length, after.lines.length);
  for (let i = 0; i < count; i++) {
    for (const k of LINE_FIELD_KEYS) {
      if (before.lines[i]?.[k] !== after.lines[i]?.[k]) changed.push(`lines[${i}].${k}`);
    }
  }
  return changed;
}

function computeWarnings(doc, threshold, now) {
  const confirmed = new Set(doc.confirmed ?? []);
  const confidence = Object.fromEntries(Object.entries(doc.confidence ?? {}).filter(([k]) => !confirmed.has(k)));
  const illegible = (doc.illegible ?? []).filter((k) => !confirmed.has(k));
  return validateDocument(doc.data, { confidence, illegible, threshold, now });
}

function serialize(doc) {
  const { pages, ...rest } = doc;
  return { ...rest, page_count: pages.length, pages: pages.map((_, i) => `/api/documents/${doc.id}/pages/${i + 1}`) };
}

function summarize(doc) {
  return {
    id: doc.id,
    created_at: doc.created_at,
    status: doc.status,
    driver: doc.driver,
    document_type: doc.data.document_type,
    document_number: doc.data.document_number,
    issuer_name: doc.data.issuer_name,
    total_amount: doc.data.total_amount,
    warning_count: doc.warnings.length,
  };
}

/**
 * @param {{store: ReturnType<import('./store.js').createStore>, extractor: {extract(images: string[]): Promise<any>},
 *          config: {confidenceThreshold: number}, now?: () => Date, exportWorkbook?: Function}} deps
 */
export function createApp({ store, extractor, config, now = () => new Date(), exportWorkbook }) {
  const app = express();
  const threshold = config.confidenceThreshold;

  app.use(express.json({ limit: '40mb' }));
  app.use(express.static(path.join(ROOT, 'public')));
  app.use('/vendor/pdfjs', express.static(path.join(ROOT, 'node_modules', 'pdfjs-dist', 'build')));

  const findDoc = (id) => {
    const doc = store.get(id);
    if (!doc) throw new HttpError(404, 'Documento no encontrado');
    return doc;
  };

  app.get('/api/schema', (req, res) => {
    res.json({
      fields: FIELDS,
      lineFields: LINE_FIELDS,
      documentTypes: DOCUMENT_TYPES.map((value) => ({ value, label: DOCUMENT_TYPE_LABELS[value] })),
      statuses: STATUSES,
    });
  });

  app.post('/api/documents', async (req, res) => {
    const { images, sourceName, driver } = req.body ?? {};
    if (!Array.isArray(images) || images.length === 0) throw new HttpError(400, 'No se ha recibido ninguna imagen');
    const decoded = images.map(decodeImage);

    const result = await extractor.extract(images);
    const doc = { data: result.data, confidence: result.confidence, illegible: result.illegible, confirmed: [] };
    const warnings = computeWarnings(doc, threshold, now());
    const created = store.create({
      ...doc,
      warnings,
      status: warnings.length ? 'pending' : 'ok',
      created_at: now().toISOString(),
      source_name: sourceName ? String(sourceName).slice(0, 200) : null,
      driver: driver ? String(driver).slice(0, 100) : null,
      model: result.model ?? null,
    }, decoded);
    res.status(201).json(serialize(created));
  });

  app.get('/api/documents', (req, res) => {
    const status = typeof req.query.status === 'string' && req.query.status ? req.query.status : undefined;
    res.json(store.list({ status }).map(summarize));
  });

  if (exportWorkbook) {
    app.get('/api/export.xlsx', async (req, res) => {
      const status = typeof req.query.status === 'string' && req.query.status ? req.query.status : undefined;
      const buffer = await exportWorkbook(store.list({ status }).reverse());
      const stamp = now().toISOString().slice(0, 10);
      res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.set('Content-Disposition', `attachment; filename="documentos-${stamp}.xlsx"`);
      res.send(Buffer.from(buffer));
    });
  }

  app.get('/api/documents/:id', (req, res) => {
    res.json(serialize(findDoc(req.params.id)));
  });

  app.put('/api/documents/:id', (req, res) => {
    const doc = findDoc(req.params.id);
    const { data, confirmed = [], action = 'save', reviewer } = req.body ?? {};
    if (!data || typeof data !== 'object') throw new HttpError(400, 'Faltan los datos del documento');
    if (action === 'verify' && !String(reviewer ?? '').trim()) throw new HttpError(400, 'Indica quién valida el documento');

    const newData = normalizeDocumentData(data);
    const confirmedSet = new Set([
      ...doc.confirmed,
      ...(Array.isArray(confirmed) ? confirmed.filter((c) => typeof c === 'string') : []),
      ...changedFields(doc.data, newData),
    ]);
    const next = { ...doc, data: newData, confirmed: [...confirmedSet] };
    const warnings = computeWarnings(next, threshold, now());
    const stamp = now().toISOString();

    const updated = store.update(doc.id, {
      data: newData,
      confirmed: next.confirmed,
      warnings,
      updated_at: stamp,
      ...(action === 'verify'
        ? { status: 'verified', reviewed_by: String(reviewer).trim().slice(0, 100), reviewed_at: stamp }
        : { status: warnings.length ? 'pending' : 'ok' }),
    });
    res.json(serialize(updated));
  });

  app.delete('/api/documents/:id', (req, res) => {
    if (!store.remove(req.params.id)) throw new HttpError(404, 'Documento no encontrado');
    res.status(204).end();
  });

  app.get('/api/documents/:id/pages/:n', (req, res) => {
    const file = store.pagePath(req.params.id, req.params.n);
    if (!file) throw new HttpError(404, 'Página no encontrada');
    res.sendFile(file);
  });

  app.use('/api', (req, res) => {
    res.status(404).json({ error: 'Ruta no encontrada' });
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof HttpError || err instanceof ExtractionError) {
      return res.status(err.status).json({ error: err.message });
    }
    if (err.type === 'entity.too.large') {
      return res.status(413).json({ error: 'El archivo es demasiado grande' });
    }
    if (err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'Petición no válida' });
    }
    console.error(err);
    res.status(500).json({ error: 'Error interno del servidor' });
  });

  return app;
}
