// Docs a datos — frontend (no build step).
// Flow: capture/upload -> pages converted to JPEG in the browser (PDF via pdf.js) -> POST /api/documents
// -> review form with doubtful fields highlighted -> save (driver) or validate (office) -> Excel export.

const DEFAULT_MAX_PAGES = 3; // replaced by /api/schema maxPages
const MAX_SIDE = 2000;
const MAX_DATA_URL_LENGTH = 3_800_000; // Groq rejects base64 images above ~4 MB
const MODEL_DOUBT_CODES = new Set(['low_confidence', 'illegible']);

const $ = (sel) => document.querySelector(sel);
const state = { schema: null, pages: [], sourceName: null, doc: null, confirmed: new Set() };

// ---------- helpers ----------

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `Error ${res.status}`);
  return json;
}

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (key in node && key !== 'list') node[key] = value;
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child !== null && child !== undefined && child !== false) node.append(child);
  }
  return node;
}

function setStatus(node, message, isError = false) {
  node.textContent = message;
  node.classList.toggle('error', isError);
}

const formatDate = (iso) => new Date(iso).toLocaleString('es-ES', { dateStyle: 'short', timeStyle: 'short' });
const formatMoney = (n) => (typeof n === 'number' ? n.toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '');

// ---------- navigation ----------

function showView(name) {
  for (const view of ['capture', 'review', 'list']) $(`#view-${view}`).hidden = view !== name;
  for (const tab of document.querySelectorAll('.tabs button')) {
    tab.setAttribute('aria-selected', String(tab.dataset.view === name));
  }
  if (name !== 'review' && location.hash) history.replaceState(null, '', location.pathname);
  if (name === 'list') loadList();
  window.scrollTo(0, 0);
}

// ---------- image preparation ----------

function canvasToJpeg(canvas) {
  let quality = 0.85;
  let url = canvas.toDataURL('image/jpeg', quality);
  while (url.length > MAX_DATA_URL_LENGTH && quality > 0.4) {
    quality -= 0.15;
    url = canvas.toDataURL('image/jpeg', quality);
  }
  return url;
}

function drawScaled(source, width, height) {
  const scale = Math.min(1, MAX_SIDE / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas;
}

async function imageFileToJpeg(file) {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const canvas = drawScaled(bitmap, bitmap.width, bitmap.height);
  bitmap.close();
  return canvasToJpeg(canvas);
}

let pdfjsPromise;
function loadPdfJs() {
  pdfjsPromise ??= import('/vendor/pdfjs/pdf.min.mjs').then((lib) => {
    lib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';
    return lib;
  });
  return pdfjsPromise;
}

async function pdfFileToJpegs(file, maxPages) {
  const pdfjs = await loadPdfJs();
  const pdf = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
  const pages = [];
  for (let n = 1; n <= Math.min(pdf.numPages, maxPages); n++) {
    const page = await pdf.getPage(n);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: Math.min(3, MAX_SIDE / Math.max(base.width, base.height)) });
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, canvas, viewport }).promise;
    pages.push(canvasToJpeg(canvas));
  }
  if (pdf.numPages > maxPages) {
    setStatus($('#capture-status'), `El PDF tiene ${pdf.numPages} páginas; solo se usan las ${maxPages} primeras.`);
  }
  return pages;
}

async function addFiles(fileList) {
  const status = $('#capture-status');
  const files = [...fileList];
  if (!files.length) return;
  setStatus(status, 'Preparando páginas…');
  try {
    for (const file of files) {
      const maxPages = state.schema?.maxPages ?? DEFAULT_MAX_PAGES;
      const free = maxPages - state.pages.length;
      if (free <= 0) {
        setStatus(status, `Máximo ${maxPages} páginas por documento.`, true);
        break;
      }
      const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
      const urls = isPdf ? await pdfFileToJpegs(file, free) : [await imageFileToJpeg(file)];
      state.sourceName ??= file.name;
      state.pages.push(...urls);
    }
    if (!status.classList.contains('error') && !status.textContent.startsWith('El PDF')) setStatus(status, '');
  } catch (err) {
    console.error(err);
    setStatus(status, `No se pudo leer el archivo: ${err.message}`, true);
  }
  renderPages();
}

function renderPages() {
  const list = $('#page-list');
  list.replaceChildren(...state.pages.map((url, i) => el('li', {},
    el('img', { src: url, alt: `Página ${i + 1}` }),
    el('button', {
      type: 'button', class: 'remove', title: 'Quitar página', 'aria-label': `Quitar página ${i + 1}`,
      onclick: () => { state.pages.splice(i, 1); if (!state.pages.length) state.sourceName = null; renderPages(); },
    }, '×'),
  )));
  $('#extract').disabled = state.pages.length === 0;
  $('#clear-pages').disabled = state.pages.length === 0;
}

async function extract() {
  const status = $('#capture-status');
  const button = $('#extract');
  button.disabled = true;
  setStatus(status, 'Analizando el documento con IA… puede tardar unos segundos.');
  try {
    const doc = await api('POST', '/api/documents', {
      images: state.pages,
      sourceName: state.sourceName,
      driver: $('#driver').value.trim() || null,
    });
    state.pages = [];
    state.sourceName = null;
    renderPages();
    setStatus(status, '');
    openReview(doc);
  } catch (err) {
    setStatus(status, err.message, true);
    button.disabled = false;
  }
}

// ---------- review ----------

function warningsByField(doc) {
  const map = new Map();
  for (const w of doc.warnings) map.set(w.field, [...(map.get(w.field) ?? []), w]);
  return map;
}

function fieldInput(field, value) {
  const common = { id: `f-${field.key}`, name: field.key, dataset: { key: field.key } };
  if (field.type === 'enum') {
    return el('select', common,
      el('option', { value: '' }, '—'),
      state.schema.documentTypes.map((t) => el('option', { value: t.value, selected: t.value === value }, t.label)));
  }
  if (field.type === 'boolean') {
    return el('select', common,
      el('option', { value: '', selected: value === null }, '—'),
      el('option', { value: 'true', selected: value === true }, 'Sí'),
      el('option', { value: 'false', selected: value === false }, 'No'));
  }
  if (field.type === 'date') return el('input', { ...common, type: 'date', value: value ?? '' });
  if (field.type === 'number') return el('input', { ...common, type: 'text', inputMode: 'decimal', value: value ?? '' });
  return el('input', { ...common, type: 'text', value: value ?? '' });
}

function confirmToggle(path) {
  return el('label', { class: 'confirm' },
    el('input', {
      type: 'checkbox',
      checked: state.confirmed.has(path),
      onchange: (e) => (e.target.checked ? state.confirmed.add(path) : state.confirmed.delete(path)),
    }),
    'He comprobado que es correcto');
}

function renderFields(doc) {
  const warns = warningsByField(doc);
  const groups = new Map();
  for (const field of state.schema.fields) groups.set(field.group, [...(groups.get(field.group) ?? []), field]);

  $('#field-groups').replaceChildren(...[...groups].map(([group, fields]) => el('fieldset', { class: 'group' },
    el('legend', {}, group),
    el('div', { class: 'group-grid' }, fields.map((field) => {
      const fieldWarnings = warns.get(field.key) ?? [];
      const modelDoubt = fieldWarnings.some((w) => MODEL_DOUBT_CODES.has(w.code));
      return el('label', { class: `field${fieldWarnings.length ? ' doubtful' : ''}`, for: `f-${field.key}` },
        el('span', {}, field.label),
        fieldInput(field, doc.data[field.key]),
        fieldWarnings.map((w) => el('span', { class: 'warn-msg' }, `⚠ ${w.message}`)),
        modelDoubt ? confirmToggle(field.key) : null);
    })),
  )));
}

function lineRow(line, index, warns) {
  return el('tr', {}, state.schema.lineFields.map((f) => {
    const path = `lines[${index}].${f.key}`;
    const fieldWarnings = warns.get(path) ?? [];
    return el('td', {}, el('input', {
      type: 'text',
      inputMode: f.type === 'number' ? 'decimal' : 'text',
      value: line[f.key] ?? '',
      dataset: { lineKey: f.key },
      class: fieldWarnings.length ? 'doubtful' : '',
      title: fieldWarnings.map((w) => w.message).join('\n'),
      'aria-label': `${f.label} línea ${index + 1}`,
    }));
  }), el('td', {}, el('button', {
    type: 'button', class: 'btn btn-small', 'aria-label': `Quitar línea ${index + 1}`,
    onclick: (e) => e.target.closest('tr').remove(),
  }, '×')));
}

function renderLines(lines, warns) {
  const head = el('thead', {}, el('tr', {}, state.schema.lineFields.map((f) => el('th', {}, f.label)), el('th', {})));
  const body = el('tbody', {}, lines.map((line, i) => lineRow(line, i, warns)));
  $('#lines-table').replaceChildren(head, body);
}

function openReview(doc) {
  state.doc = doc;
  history.replaceState(null, '', `#doc/${doc.id}`);
  state.confirmed = new Set();
  const typeLabel = state.schema.documentTypes.find((t) => t.value === doc.data.document_type)?.label ?? 'Documento';
  $('#review-title').textContent = `${typeLabel} ${doc.data.document_number ?? ''} (#${doc.id})`;
  const pill = $('#review-status');
  pill.textContent = state.schema.statuses[doc.status] ?? doc.status;
  pill.className = `pill ${doc.status}`;

  const box = $('#warnings-box');
  box.hidden = doc.warnings.length === 0;
  $('#warnings-title').textContent = `${doc.warnings.length} aviso(s): revisa los campos resaltados comparándolos con el documento.`;
  $('#warnings-list').replaceChildren(...doc.warnings.map((w) => el('li', {}, w.message)));

  $('#review-pages').replaceChildren(...doc.pages.map((src, i) => el('img', {
    src, alt: `Página ${i + 1}`, loading: 'lazy',
    onclick: () => { $('#image-dialog-img').src = src; $('#image-dialog').showModal(); },
  })));

  renderFields(doc);
  renderLines(doc.data.lines, warningsByField(doc));
  $('#reviewer').value = doc.reviewed_by ?? localStorage.getItem('reviewer') ?? '';
  setStatus($('#review-message'), doc.reviewed_by ? `Validado por ${doc.reviewed_by} el ${formatDate(doc.reviewed_at)}` : '');
  showView('review');
}

function collectData() {
  const data = {};
  for (const input of document.querySelectorAll('#field-groups [data-key]')) {
    const value = input.value.trim();
    data[input.dataset.key] = value === '' ? null : value;
  }
  data.lines = [...document.querySelectorAll('#lines-table tbody tr')].map((row) => {
    const line = {};
    for (const input of row.querySelectorAll('[data-line-key]')) {
      line[input.dataset.lineKey] = input.value.trim() === '' ? null : input.value.trim();
    }
    return line;
  }).filter((line) => Object.values(line).some((v) => v !== null));
  return data;
}

async function saveReview(action) {
  const message = $('#review-message');
  const reviewer = $('#reviewer').value.trim();
  if (action === 'verify') {
    if (!reviewer) {
      setStatus(message, 'Indica quién valida el documento', true);
      $('#reviewer').focus();
      return;
    }
    localStorage.setItem('reviewer', reviewer);
  }
  try {
    const doc = await api('PUT', `/api/documents/${state.doc.id}`, {
      data: collectData(),
      confirmed: [...state.confirmed],
      action,
      reviewer: action === 'verify' ? reviewer : undefined,
    });
    openReview(doc);
    const result = doc.status === 'ok'
      ? 'Guardado. Sin avisos pendientes.'
      : doc.status === 'pending'
        ? `Guardado con ${doc.warnings.length} aviso(s): queda en la cola de revisión de oficina.`
        : `Validado por ${doc.reviewed_by}.`;
    setStatus(message, result);
    refreshBadge();
  } catch (err) {
    setStatus(message, err.message, true);
  }
}

async function deleteDoc() {
  if (!confirm('¿Eliminar este documento? No se puede deshacer.')) return;
  try {
    await api('DELETE', `/api/documents/${state.doc.id}`);
    showView('list');
  } catch (err) {
    setStatus($('#review-message'), err.message, true);
  }
}

// ---------- list ----------

async function loadList() {
  const status = $('#status-filter').value;
  const query = status ? `?status=${encodeURIComponent(status)}` : '';
  $('#export-link').href = `/api/export.xlsx${query}`;
  const docs = await api('GET', `/api/documents${query}`).catch(() => []);
  $('#list-empty').hidden = docs.length > 0;
  $('#doc-list').replaceChildren(...docs.map((d) => {
    const type = state.schema.documentTypes.find((t) => t.value === d.document_type)?.label ?? 'Documento';
    return el('li', {}, el('button', { type: 'button', onclick: () => openDoc(d.id) },
      el('span', { class: 'title' }, `${type} ${d.document_number ?? '(sin número)'}`),
      el('span', { class: `pill ${d.status}` }, state.schema.statuses[d.status] ?? d.status),
      el('span', { class: 'meta' }, [d.issuer_name, d.driver && `Repartidor: ${d.driver}`, formatDate(d.created_at)].filter(Boolean).join(' · ')),
      el('span', { class: 'meta' }, [d.total_amount !== null ? `${formatMoney(d.total_amount)} €` : '', d.warning_count ? `⚠ ${d.warning_count}` : ''].filter(Boolean).join('  ')),
    ));
  }));
  refreshBadge();
}

async function openDoc(id) {
  try {
    openReview(await api('GET', `/api/documents/${id}`));
  } catch (err) {
    alert(err.message);
  }
}

async function refreshBadge() {
  const pending = await api('GET', '/api/documents?status=pending').catch(() => []);
  const badge = $('#pending-badge');
  badge.hidden = pending.length === 0;
  badge.textContent = String(pending.length);
}

// ---------- init ----------

async function init() {
  state.schema = await api('GET', '/api/schema');
  $('#max-pages').textContent = String(state.schema.maxPages);

  const driver = $('#driver');
  driver.value = localStorage.getItem('driver') ?? '';
  driver.addEventListener('change', () => localStorage.setItem('driver', driver.value.trim()));

  for (const id of ['#camera-input', '#file-input']) {
    $(id).addEventListener('change', async (e) => {
      await addFiles(e.target.files);
      e.target.value = '';
    });
  }
  $('#clear-pages').addEventListener('click', () => { state.pages = []; state.sourceName = null; renderPages(); });
  $('#extract').addEventListener('click', extract);

  for (const tab of document.querySelectorAll('.tabs button')) tab.addEventListener('click', () => showView(tab.dataset.view));
  $('#back').addEventListener('click', () => showView('list'));
  $('#review-form').addEventListener('submit', (e) => { e.preventDefault(); saveReview('save'); });
  $('#verify-doc').addEventListener('click', () => saveReview('verify'));
  $('#delete-doc').addEventListener('click', deleteDoc);
  $('#add-line').addEventListener('click', () => {
    const body = $('#lines-table tbody');
    body.append(lineRow({}, body.children.length, new Map()));
  });
  $('#status-filter').addEventListener('change', loadList);

  refreshBadge();

  // Direct link to a document, e.g. /#doc/12 (handy for sharing with the office)
  const link = /^#doc\/(\d+)$/.exec(location.hash);
  if (link) openDoc(Number(link[1]));
}

init().catch((err) => setStatus($('#capture-status'), `No se pudo iniciar la aplicación: ${err.message}`, true));
