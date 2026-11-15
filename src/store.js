// SQLite persistence (built-in node:sqlite) plus page images on disk under <dataDir>/uploads/<id>/.

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const JSON_COLUMNS = ['pages', 'data', 'confidence', 'illegible', 'confirmed', 'warnings'];

export function createStore(dataDir) {
  const uploadsDir = path.join(dataDir, 'uploads');
  fs.mkdirSync(uploadsDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'docs.sqlite'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      status TEXT NOT NULL,
      source_name TEXT,
      driver TEXT,
      pages TEXT NOT NULL DEFAULT '[]',
      data TEXT NOT NULL,
      confidence TEXT NOT NULL DEFAULT '{}',
      illegible TEXT NOT NULL DEFAULT '[]',
      confirmed TEXT NOT NULL DEFAULT '[]',
      warnings TEXT NOT NULL DEFAULT '[]',
      reviewed_by TEXT,
      reviewed_at TEXT,
      model TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_documents_status ON documents(status);
  `);

  const decode = (row) => {
    if (!row) return null;
    const doc = { ...row };
    for (const col of JSON_COLUMNS) doc[col] = JSON.parse(row[col]);
    return doc;
  };

  const docDir = (id) => path.join(uploadsDir, String(id));

  return {
    /**
     * Inserts a document and writes its page images. Rolls back the row if writing fails.
     * @param {object} doc row values (JSON columns as objects)
     * @param {{buffer: Buffer, ext: string}[]} images
     */
    create(doc, images) {
      const { lastInsertRowid } = db.prepare(`
        INSERT INTO documents (created_at, updated_at, status, source_name, driver, data, confidence, illegible, confirmed, warnings, model)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?)
      `).run(doc.created_at, doc.created_at, doc.status, doc.source_name ?? null, doc.driver ?? null,
        JSON.stringify(doc.data), JSON.stringify(doc.confidence ?? {}), JSON.stringify(doc.illegible ?? []),
        JSON.stringify(doc.warnings ?? []), doc.model ?? null);
      const id = Number(lastInsertRowid);
      try {
        fs.mkdirSync(docDir(id), { recursive: true });
        const pages = images.map((img, i) => {
          const name = `page-${i + 1}.${img.ext}`;
          fs.writeFileSync(path.join(docDir(id), name), img.buffer);
          return name;
        });
        db.prepare('UPDATE documents SET pages = ? WHERE id = ?').run(JSON.stringify(pages), id);
      } catch (err) {
        db.prepare('DELETE FROM documents WHERE id = ?').run(id);
        fs.rmSync(docDir(id), { recursive: true, force: true });
        throw err;
      }
      return this.get(id);
    },

    get(id) {
      return decode(db.prepare('SELECT * FROM documents WHERE id = ?').get(Number(id)));
    },

    /** Full documents, newest first, optionally filtered by status. */
    list({ status } = {}) {
      const rows = status
        ? db.prepare('SELECT * FROM documents WHERE status = ? ORDER BY id DESC').all(status)
        : db.prepare('SELECT * FROM documents ORDER BY id DESC').all();
      return rows.map(decode);
    },

    update(id, changes) {
      const allowed = ['updated_at', 'status', 'data', 'confirmed', 'warnings', 'reviewed_by', 'reviewed_at'];
      const keys = Object.keys(changes).filter((k) => allowed.includes(k));
      if (keys.length === 0) return this.get(id);
      const values = keys.map((k) => (JSON_COLUMNS.includes(k) ? JSON.stringify(changes[k]) : changes[k] ?? null));
      db.prepare(`UPDATE documents SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...values, Number(id));
      return this.get(id);
    },

    remove(id) {
      const { changes } = db.prepare('DELETE FROM documents WHERE id = ?').run(Number(id));
      fs.rmSync(docDir(Number(id)), { recursive: true, force: true });
      return changes > 0;
    },

    pagePath(id, n) {
      const doc = this.get(id);
      const name = doc?.pages?.[Number(n) - 1];
      return name ? path.join(docDir(doc.id), name) : null;
    },

    close() {
      db.close();
    },
  };
}
