// src/db/index.ts
// ---------------------------------------------------------------------------
// Veri katmanı girişi.
//
// Backend seçimi (otomatik):
//   1) `better-sqlite3` açılabilirse → SQLite (data/db/bot.sqlite). İlk açılışta
//      data/db/*.json dosyaları tek seferlik SQLite'a aktarılır
//      (bkz. ./jsonToSqlite.ts); eski JSON'lar yedek olarak yerinde durur.
//   2) SQLite herhangi bir sebeple açılamazsa → eski JSON modu
//      (data/db/*.json, bkz. ./jsonOrm.ts) + gerekiyorsa Neon'dan tek seferlik
//      aktarım (bkz. ./neonImport.ts).
//
// `db` buradan delege bir nesne olarak çıkar: ensureTables() hangi backend'i
// seçerse sorgular oraya gider. Komut dosyaları hiçbir şey değiştirmez.
// ---------------------------------------------------------------------------
import { loadEnv } from "../utils/env.js";
loadEnv();

import { db as jsonDb, jsonStore } from "./jsonOrm.js";
import "./schema.js"; // tabloların kayıt olması için
import { importFromNeonIfNeeded } from "./neonImport.js";
import { tryCreateSqliteDb, type SqliteBackend, type SqliteHandle } from "./sqliteOrm.js";
import { importJsonToSqliteIfNeeded } from "./jsonToSqlite.js";

type JsonDb = typeof jsonDb;

let backend: JsonDb = jsonDb;
let sqlite: SqliteBackend | null = null;
let tablesReady = false;

type DbFunction = (...args: never[]) => unknown;
function delegate<F extends DbFunction>(pick: (b: JsonDb) => F): F {
  return ((...args: never[]) => pick(backend)(...args)) as F;
}

/**
 * Tüm komutlar/sistemler buradan okur. ensureTables() çalışmadan önce JSON
 * backend'ine, sonra seçilen backend'e yönlenir.
 */
export const db: JsonDb = {
  select: delegate((b) => b.select),
  insert: delegate((b) => b.insert),
  update: delegate((b) => b.update),
  delete: delegate((b) => b.delete),
};

/** Tabloları hazırlar + backend'i seçer (idempotent). */
export async function ensureTables(): Promise<void> {
  if (tablesReady) return;
  tablesReady = true;

  sqlite = await tryCreateSqliteDb();
  if (sqlite) {
    backend = sqlite.db;
    await importJsonToSqliteIfNeeded(sqlite.handle);
    console.log("💾 sqlite db hazır");
    return;
  }

  jsonStore.loadAll();
  await importFromNeonIfNeeded();
  console.log("sqlite açılmadı, json modunda devam");
}

/** Kapanışta backend'i düzgün kapatır. */
export async function closeDatabase(): Promise<void> {
  if (sqlite) sqlite.close();
  else jsonStore.close();
}

/** Hangi backend'in aktif olduğunu söyler (diagnostik / !veribak için). */
export function getActiveBackend(): "sqlite" | "json" {
  return sqlite ? "sqlite" : "json";
}

/** Ham SQL gereken bakım işleri için SQLite tutamacı (yoksa null). */
export function getSqliteHandle(): SqliteHandle | null {
  return sqlite?.handle ?? null;
}

export * from "./schema.js";
