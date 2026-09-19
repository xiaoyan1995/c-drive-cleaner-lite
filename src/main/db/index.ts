import { createRequire } from "node:module";
import { join } from "node:path";
import type { Database as SqliteDatabase } from "better-sqlite3";
import { CREATE_TABLES_SQL, DEFAULT_SETTINGS } from "./schema";

const require = createRequire(import.meta.url);

interface SettingsRow {
  key: string;
  value: string;
}

interface Migration {
  version: number;
  name: string;
  up: (db: SqliteDatabase) => void;
}

const MIGRATIONS: Migration[] = [
  {
    version: 2,
    name: "close_to_tray_default",
    up(db) {
      db.prepare("UPDATE settings SET value = ? WHERE key = ? AND value = ?")
        .run(JSON.stringify(true), "tray.closeToTray", JSON.stringify(false));
    }
  }
];

function applyMigrations(db: SqliteDatabase): void {
  db.prepare("INSERT OR IGNORE INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)")
    .run(1, "initial_schema", new Date().toISOString());

  const current = db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as { version: number | null };
  const currentVersion = current.version ?? 0;
  for (const migration of MIGRATIONS) {
    if (migration.version <= currentVersion) {
      continue;
    }
    const transaction = db.transaction(() => {
      migration.up(db);
      db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)")
        .run(migration.version, migration.name, new Date().toISOString());
    });
    transaction();
  }
}

export interface DatabaseState {
  available: boolean;
  path: string;
  error?: string;
  getDatabaseVersion: () => number;
  getAllSettings: () => Record<string, unknown>;
  getSetting: <T = unknown>(key: string) => T | undefined;
  setSetting: (key: string, value: unknown) => void;
  queryAll: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => T[];
  queryGet: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => T | undefined;
  execute: (sql: string, params?: unknown[]) => void;
  addActivity: (action: string, summary: string, details?: unknown) => void;
  getActivity: (limit?: number) => Array<{ id: number; timestamp: string; action: string; summary: string }>;
}

export function initializeDatabase(userDataPath: string): DatabaseState {
  const dbPath = join(userDataPath, "c-drive-cleaner.db");
  let db: SqliteDatabase | null = null;
  let loadError: string | undefined;

  try {
    const BetterSqlite3 = require("better-sqlite3") as typeof import("better-sqlite3");
    db = new BetterSqlite3(dbPath);
    CREATE_TABLES_SQL.forEach((sql) => db?.prepare(sql).run());

    const insert = db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)");
    Object.entries(DEFAULT_SETTINGS).forEach(([key, value]) => {
      insert.run(key, JSON.stringify(value));
    });
    applyMigrations(db);
  } catch (error) {
    loadError = error instanceof Error ? error.message : "Unknown better-sqlite3 initialization error";
    console.warn("[db] SQLite unavailable, falling back to in-memory settings:", loadError);
  }

  const memorySettings = new Map<string, unknown>(Object.entries(DEFAULT_SETTINGS));
  const memoryActivity: Array<{ id: number; timestamp: string; action: string; summary: string }> = [];

  return {
    available: db !== null,
    path: dbPath,
    error: loadError,
    getDatabaseVersion() {
      if (!db) {
        return 1;
      }

      const row = db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as { version: number | null };
      return row.version ?? 0;
    },
    getAllSettings() {
      if (!db) {
        return Object.fromEntries(memorySettings);
      }

      const rows = db.prepare("SELECT key, value FROM settings").all() as SettingsRow[];
      return Object.fromEntries(rows.map((row) => [row.key, JSON.parse(row.value) as unknown]));
    },
    getSetting<T = unknown>(key: string) {
      if (!db) {
        return memorySettings.get(key) as T | undefined;
      }

      const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
      return row ? (JSON.parse(row.value) as T) : undefined;
    },
    setSetting(key: string, value: unknown) {
      if (!db) {
        memorySettings.set(key, value);
        return;
      }

      db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .run(key, JSON.stringify(value));
    },
    queryAll<T = Record<string, unknown>>(sql: string, params: unknown[] = []) {
      if (!db) {
        return [];
      }

      return db.prepare(sql).all(...params) as T[];
    },
    queryGet<T = Record<string, unknown>>(sql: string, params: unknown[] = []) {
      if (!db) {
        return undefined;
      }

      return db.prepare(sql).get(...params) as T | undefined;
    },
    execute(sql: string, params: unknown[] = []) {
      if (!db) {
        return;
      }

      db.prepare(sql).run(...params);
    },
    addActivity(action: string, summary: string, details?: unknown) {
      const timestamp = new Date().toISOString();
      if (!db) {
        memoryActivity.unshift({ id: memoryActivity.length + 1, timestamp, action, summary });
        return;
      }

      db.prepare("INSERT INTO activity_logs (timestamp, action, summary, details) VALUES (?, ?, ?, ?)")
        .run(timestamp, action, summary, details === undefined ? null : JSON.stringify(details));
    },
    getActivity(limit = 5) {
      if (!db) {
        return memoryActivity.slice(0, limit);
      }

      return db
        .prepare("SELECT id, timestamp, action, summary FROM activity_logs ORDER BY timestamp DESC LIMIT ?")
        .all(limit) as Array<{ id: number; timestamp: string; action: string; summary: string }>;
    }
  };
}
