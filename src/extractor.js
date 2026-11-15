// Groq vision extraction: sends the document page images and returns normalized data
// plus the model's per-field confidence and the fields it could not read.

import { FIELDS, LINE_FIELDS, DOCUMENT_TYPES, normalizeDocumentData } from './fields.js';

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
/** Default images per request (qwen/qwen3.8-27b accepts 3). */
export const DEFAULT_MAX_IMAGES = 3;

export class ExtractionError extends Error {
  constructor(message, { status = 502 } = {}) {
    super(message);
    this.name = 'ExtractionError';
    this.status = status;
  }
}

const FIELD_HINTS = {
  document_type: `uno de: ${DOCUMENT_TYPES.join(', ')}`,
  document_date: 'formato YYYY-MM-DD',
  delivery_date: 'formato YYYY-MM-DD',
  issuer_tax_id: 'NIF/CIF/VAT tal como aparece',
  recipient_tax_id: 'NIF/CIF/VAT tal como aparece',
  carrier_tax_id: 'NIF/CIF/VAT tal como aparece',
  vat_rate: 'porcentaje como número, p. ej. 21',
  currency: 'código ISO, p. ej. EUR',
  receiver_signed: 'true si hay firma o sello de recepción, false si el espacio está vacío',
};

export function buildPrompt() {
  const fieldLines = FIELDS.map((f) => `- "${f.key}" (${f.type}): ${f.label}${FIELD_HINTS[f.key] ? ` — ${FIELD_HINTS[f.key]}` : ''}`).join('\n');
  const lineKeys = LINE_FIELDS.map((f) => `"${f.key}" (${f.label})`).join(', ');
  return `Eres un sistema de extracción de datos de documentos de transporte y logística españoles y europeos (albaranes, facturas, CMR, notas de entrega).
Analiza las imágenes (pueden ser varias páginas del mismo documento) y devuelve SOLO un objeto JSON con esta forma:
{
  "data": { ...campos... , "lines": [ { ...línea... } ] },
  "confidence": { "<campo>": número entre 0 y 1 },
  "illegible": [ "<campo>" ]
}

Campos de "data":
${fieldLines}
- "lines": array de líneas de mercancía/conceptos con claves ${lineKeys}

Reglas:
- Usa null si un dato no aparece en el documento. No inventes datos.
- Números como número JSON con punto decimal (1234.56), sin símbolos de moneda.
- Fechas en formato YYYY-MM-DD.
- "confidence": incluye TODOS los campos con valor no nulo; usa valores bajos (<0.7) si el texto está borroso, manuscrito, cortado o es ambiguo.
- "illegible": campos que existen en el documento pero no se pueden leer con seguridad. Para líneas usa la forma "lines[0].amount".
- En "notes" resume anotaciones manuscritas, reservas, incidencias o daños indicados.`;
}

function parseModelJson(content) {
  if (typeof content !== 'string') return null;
  const visible = content.replace(/<think>[\s\S]*?<\/think>/gi, '');
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(visible);
  const candidate = (fenced ? fenced[1] : visible).trim();
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start === -1 || end <= start) return null;
    try {
      return JSON.parse(candidate.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

function sanitizeConfidence(raw) {
  if (!raw || typeof raw !== 'object') return {};
  return Object.fromEntries(
    Object.entries(raw).filter(([, v]) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1),
  );
}

/**
 * @param {{apiKey: string, model: string, maxImages?: number, fetch?: typeof fetch}} options
 */
export function createGroqExtractor({ apiKey, model, maxImages = DEFAULT_MAX_IMAGES, fetch = globalThis.fetch }) {
  return {
    /**
     * @param {string[]} images data URLs (image/jpeg or image/png)
     * @returns {Promise<{data: object, confidence: Record<string, number>, illegible: string[], model: string}>}
     */
    async extract(images) {
      if (!Array.isArray(images) || images.length === 0) {
        throw new ExtractionError('No se ha recibido ninguna imagen', { status: 400 });
      }
      if (!apiKey) {
        throw new ExtractionError('Falta GROQ_API_KEY en la configuración del servidor', { status: 500 });
      }

      const content = [
        { type: 'text', text: 'Extrae los datos de este documento.' },
        ...images.slice(0, maxImages).map((url) => ({ type: 'image_url', image_url: { url } })),
      ];
      const body = {
        model,
        temperature: 0,
        max_completion_tokens: 4096,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: buildPrompt() },
          { role: 'user', content },
        ],
      };

      let response;
      try {
        response = await fetch(GROQ_URL, {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      } catch (err) {
        throw new ExtractionError(`No se pudo contactar con Groq: ${err.message}`);
      }

      if (!response.ok) {
        let detail = '';
        try {
          const errBody = await response.json();
          detail = errBody?.error?.message ?? '';
        } catch {
          /* ignore unreadable error bodies */
        }
        // Text-only models reject the image content array with "... content ... must be a string"
        if (response.status === 400 && /content.*must be a string/i.test(detail)) {
          throw new ExtractionError(`El modelo "${model}" no admite imágenes en Groq. Cambia GROQ_MODEL a un modelo de visión (por ejemplo qwen/qwen3.8-27b) y reinicia el servidor.`);
        }
        throw new ExtractionError(`Error de Groq (${response.status})${detail ? `: ${detail}` : ''}`);
      }

      const json = await response.json();
      const parsed = parseModelJson(json?.choices?.[0]?.message?.content);
      if (!parsed || typeof parsed !== 'object') {
        throw new ExtractionError('La IA no devolvió un JSON válido');
      }

      return {
        // Some answers skip the "data" wrapper and put the fields at the top level.
        data: normalizeDocumentData(parsed.data && typeof parsed.data === 'object' ? parsed.data : parsed),
        confidence: sanitizeConfidence(parsed.confidence),
        illegible: Array.isArray(parsed.illegible) ? parsed.illegible.filter((f) => typeof f === 'string') : [],
        model,
      };
    },
  };
}
