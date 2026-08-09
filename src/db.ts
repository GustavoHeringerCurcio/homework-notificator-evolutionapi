import Database from 'better-sqlite3';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { logger } from './logger';
import { DbHomework, Homework, InsertResult, ScrapeRun } from './types';

let db: Database.Database | null = null;

function normalizeTitle(title: string): string {
  return title
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

export function hashTitle(title: string): string {
  return crypto.createHash('sha256').update(normalizeTitle(title)).digest('hex');
}

export function initDb(dbPath: string): Database.Database {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const dbExists = fs.existsSync(dbPath);

  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  if (dbExists) {
    try {
      const result = db.pragma('integrity_check') as { integrity_check: string }[];
      if (result.length > 0 && result[0].integrity_check !== 'ok') {
        logger.error('Database integrity check failed, recreating from backup');
        const corruptPath = dbPath.replace(/\.db$/, `.corrupt.${new Date().toISOString().slice(0, 10)}.db`);
        fs.copyFileSync(dbPath, corruptPath);
        db.close();
        fs.unlinkSync(dbPath);
        db = new Database(dbPath);
        db.pragma('journal_mode = WAL');
      }
    } catch (err) {
      logger.error('Database integrity check error', { error: String(err) });
    }
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS homeworks (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      title       TEXT    NOT NULL,
      title_hash  TEXT    NOT NULL,
      due_date    TEXT    NOT NULL,
      due_time    TEXT,
      source_url  TEXT,
      created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
      notified_at TEXT,
      notify_status TEXT DEFAULT 'pending',
      notify_error TEXT,
      UNIQUE(title_hash, due_date)
    );

    CREATE INDEX IF NOT EXISTS idx_pending ON homeworks(notify_status)
      WHERE notify_status IN ('pending', 'failed');

    CREATE TABLE IF NOT EXISTS scrape_runs (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id        TEXT    NOT NULL UNIQUE,
      started_at    TEXT    NOT NULL,
      ended_at      TEXT,
      status        TEXT    NOT NULL DEFAULT 'running',
      entries_found INTEGER DEFAULT 0,
      entries_new   INTEGER DEFAULT 0,
      entries_dup   INTEGER DEFAULT 0,
      error         TEXT,
      snapshot_path TEXT
    );
  `);

  logger.info('Database initialized', { path: dbPath });
  return db;
}

export function getDb(): Database.Database {
  if (!db) {
    throw new Error('Database not initialized. Call initDb() first.');
  }
  return db;
}

export function insertHomework(hw: Homework, sourceUrl?: string): InsertResult {
  const database = getDb();
  const hash = hashTitle(hw.title);

  try {
    const stmt = database.prepare(`
      INSERT OR IGNORE INTO homeworks (title, title_hash, due_date, due_time, source_url)
      VALUES (?, ?, ?, ?, ?)
    `);
    const result = stmt.run(hw.title.trim(), hash, hw.due_date, hw.due_time || null, sourceUrl || null);

    if (result.changes > 0) {
      return { status: 'new', id: Number(result.lastInsertRowid) };
    }
    return { status: 'duplicate' };
  } catch (err) {
    logger.error('Failed to insert homework', { error: String(err), title: hw.title });
    throw err;
  }
}

export function getPendingNotifications(): DbHomework[] {
  const database = getDb();
  const stmt = database.prepare(`
    SELECT * FROM homeworks
    WHERE notify_status IN ('pending', 'failed')
    ORDER BY created_at ASC
  `);
  return stmt.all() as DbHomework[];
}

export function markNotified(
  id: number,
  success: boolean,
  error?: string
): void {
  const database = getDb();
  const status = success ? 'sent' : 'failed';
  const stmt = database.prepare(`
    UPDATE homeworks
    SET notify_status = ?, notified_at = datetime('now'), notify_error = ?
    WHERE id = ?
  `);
  stmt.run(status, error || null, id);
}

export function recordScrapeRun(run: ScrapeRun): void {
  const database = getDb();

  const existing = database.prepare('SELECT id FROM scrape_runs WHERE run_id = ?').get(run.run_id);

  if (existing) {
    const stmt = database.prepare(`
      UPDATE scrape_runs
      SET ended_at = ?, status = ?, entries_found = ?, entries_new = ?,
          entries_dup = ?, error = ?, snapshot_path = ?
      WHERE run_id = ?
    `);
    stmt.run(
      run.ended_at || null,
      run.status,
      run.entries_found,
      run.entries_new,
      run.entries_dup,
      run.error || null,
      run.snapshot_path || null,
      run.run_id,
    );
  } else {
    const stmt = database.prepare(`
      INSERT INTO scrape_runs (run_id, started_at, ended_at, status, entries_found, entries_new, entries_dup, error, snapshot_path)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      run.run_id,
      run.started_at,
      run.ended_at || null,
      run.status,
      run.entries_found,
      run.entries_new,
      run.entries_dup,
      run.error || null,
      run.snapshot_path || null,
    );
  }
}

export function getLastRun(): ScrapeRun | null {
  const database = getDb();
  const stmt = database.prepare('SELECT * FROM scrape_runs ORDER BY id DESC LIMIT 1');
  const row = stmt.get() as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    run_id: row.run_id as string,
    started_at: row.started_at as string,
    ended_at: row.ended_at as string | undefined,
    status: row.status as ScrapeRun['status'],
    entries_found: row.entries_found as number,
    entries_new: row.entries_new as number,
    entries_dup: row.entries_dup as number,
    error: row.error as string | undefined,
    snapshot_path: row.snapshot_path as string | undefined,
  };
}

export function getTotalHomeworks(): number {
  const database = getDb();
  const stmt = database.prepare('SELECT COUNT(*) as count FROM homeworks');
  const row = stmt.get() as { count: number };
  return row.count;
}

export function getPendingCount(): number {
  const database = getDb();
  const stmt = database.prepare("SELECT COUNT(*) as count FROM homeworks WHERE notify_status IN ('pending', 'failed')");
  const row = stmt.get() as { count: number };
  return row.count;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
    logger.info('Database connection closed');
  }
}
