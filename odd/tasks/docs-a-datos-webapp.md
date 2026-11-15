# docs-a-datos webapp

Simple web app: a delivery driver photographs or uploads a transport document (albarán, factura, CMR...),
Groq vision AI extracts the useful data, doubtful fields are flagged for human review, results export to Excel.

## Specs

- S1 (verbatim request): "vamos a crear en una webApp sencilla, donde un repartidor hace una foto o sube un imagen/pdf de un documento (albaran, factura, cmr...) y la ia (en este caso usaria la api de groq para pruebas sin gastar dinero) extrae toda la informacion util organizada exportandola a excel, tendra tambien avisos en los dudosos (en este caso habria intervencion humana)."
- S2 Input: camera photo or upload of image or PDF (albarán, factura, CMR...). PDFs are rasterized to images in the browser.
- S3 Extraction uses the Groq API (vision model); the API key stays server-side.
- S4 Extracted data is organized (document type, parties, dates, references, line items, totals, transport data).
- S5 Doubtful fields produce warnings ("avisos en los dudosos"): low model confidence plus deterministic checks (NIF/CIF format, totals consistency, dates, required fields).
- S6 Human intervention, both: the driver can correct right after extraction; anything still doubtful goes to an office review queue.
- S7 Stack: Node + Express backend, plain HTML/JS frontend.
- S8 Excel: one accumulated workbook with several documents (sheet per documents, sheet for line items, warnings column).
- S9 Persistence: SQLite on the server.

## Tasks

- [ ] T1 Scaffold: git, package.json, Express server, config (.env) — S3, S7 — inline — commit: -
- [ ] T2 Validation rules (doubtful detection) with tests — S5 — inline — commit: -
- [ ] T3 Groq extraction service (prompt, JSON schema, normalization) — S3, S4 — inline — commit: -
- [ ] T4 SQLite store + REST API (create, list, get, review, queue) with tests — S6, S9 — inline — commit: -
- [ ] T5 Excel export (accumulated workbook) with tests — S8 — inline — commit: -
- [ ] T6 Frontend: capture/upload, PDF→images, review form, office queue, export — S2, S5, S6 — inline — commit: -
- [ ] T7 README (setup, Groq key, usage) — all — inline — commit: -

## Log

- L1: "vamos a crear en una webApp sencilla, donde un repartidor hace una foto o sube un imagen/pdf de un documento (albaran, factura, cmr...) y la ia (en este caso usaria la api de groq para pruebas sin gastar dinero) extrae toda la informacion util organizada exportandola a excel, tendra tambien avisos en los dudosos (en este caso habria intervencion humana)."
- L2: Decisions: Stack "Node: Express + frontend HTML/JS"; Excel "Acumulado: un libro con varios documentos"; Persistence "SQLite en el servidor"; Human review "Ambos".
