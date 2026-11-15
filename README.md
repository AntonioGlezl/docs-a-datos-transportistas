# docs-a-datos

Small web app for delivery drivers: take a photo (or upload an image/PDF) of a transport document
— albarán, factura, CMR… — and an AI vision model (Groq) extracts the useful data. Doubtful fields are
flagged for human review, and everything exports to one accumulated Excel workbook.

## How it works

1. **Capture** — the driver takes a photo with the phone camera or uploads images / a PDF (max 5 pages).
   PDFs are rendered to images in the browser with pdf.js; photos are resized and compressed to JPEG.
2. **Extract** — the server sends the pages to the Groq vision model, which returns structured JSON with
   a per-field confidence and the fields it could not read. The Groq API key never leaves the server.
3. **Flag doubtful data** — two sources of warnings:
   - model uncertainty: confidence below `CONFIDENCE_THRESHOLD` or marked illegible;
   - deterministic checks: required fields per document type, Spanish NIF/NIE/CIF control characters,
     invalid/future/out-of-order dates, base + VAT = total, base × VAT% = VAT amount,
     quantity × price = line amount, sum of lines = net amount, negative values.
4. **Human review**
   - The driver corrects fields right away. Editing a field, or ticking *"He comprobado que es correcto"*
     on a model doubt, clears the model warning; deterministic checks are re-run on every save.
   - A document that still has warnings stays **Pendiente de revisión** (office queue, badge on the
     *Documentos* tab). The office can correct it or **Validar** it with their name, even if warnings
     remain (they are kept for audit).
5. **Export** — *Exportar Excel* downloads one workbook with the documents shown in the current filter:
   - `Documentos`: one row per document, doubtful cells highlighted with the reason as a cell note;
   - `Líneas`: line items of every document;
   - `Avisos`: one row per warning.

Statuses: `ok` (no warnings), `pending` (warnings, needs review), `verified` (validated by the office).

## Setup

Requirements: Node.js 22.13+ (uses the built-in `node:sqlite`).

```bash
npm install
cp env.example .env     # then set GROQ_API_KEY
npm start               # http://localhost:3000
```

Get a free Groq API key at <https://console.groq.com/keys>.

| Variable | Default | Description |
| --- | --- | --- |
| `GROQ_API_KEY` | — | Required for extraction |
| `GROQ_MODEL` | `meta-llama/llama-4-scout-17b-16e-instruct` | Any Groq vision model |
| `PORT` | `3000` | HTTP port |
| `DATA_DIR` | `./data` | SQLite database and page images |
| `CONFIDENCE_THRESHOLD` | `0.75` | Fields below this model confidence are flagged |

To use the camera from a phone, open the app over HTTPS or on the same machine (`localhost`):
browsers only allow camera capture on secure origins. For testing on a phone in the same network you
can use a tunnel such as `npx localtunnel --port 3000` or `cloudflared`.

## API

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/schema` | Field definitions, document types and statuses |
| `POST` | `/api/documents` | `{ images: dataURL[], sourceName?, driver? }` → extract, validate and store |
| `GET` | `/api/documents?status=` | Document summaries, newest first |
| `GET` | `/api/documents/:id` | Full document with warnings and page URLs |
| `PUT` | `/api/documents/:id` | `{ data, confirmed?: string[], action?: "save" \| "verify", reviewer? }` |
| `DELETE` | `/api/documents/:id` | Delete the document and its pages |
| `GET` | `/api/documents/:id/pages/:n` | Page image |
| `GET` | `/api/export.xlsx?status=` | Accumulated Excel workbook |

The UI also supports direct links to a document: `/#doc/<id>`.

## Development

```bash
npm test      # node:test, no network: Groq is mocked
npm run dev   # restart on changes
```

Code layout: `src/fields.js` (schema, single source of truth), `src/validation.js` (doubtful checks),
`src/extractor.js` (Groq), `src/store.js` (SQLite + files), `src/excel.js`, `src/app.js` (HTTP API),
`public/` (frontend, no build step).

## Limitations

- No authentication: run it on a trusted network, or add auth before exposing it to the internet.
- Groq free tier has rate limits; a `429` is shown to the driver as an error and nothing is stored.
- Groq accepts at most 5 images per request, so only the first 5 pages are processed.
