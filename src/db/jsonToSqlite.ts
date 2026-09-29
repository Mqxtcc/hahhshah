// src/db/jsonToSqlite.ts
// ---------------------------------------------------------------------------
// Tek seferlik JSON → SQLite aktarımı (neonImport.ts deseninin aynısı).
//
// Bot SQLite modunda ilk kez açıldığında data/db/<tablo>.json dosyalarındaki
// tüm satırlar data/db/bot.sqlite içine taşınır. Aktarım bitince
// data/db/_meta.json'a `sqliteMigrated: true` yazılır ve bir daha çalışmaz.
//
// Kurallar:
//   - Satırlar jsonOrm.rawToRec ile normalize edilir (JSON modundakiyle aynı
//     doğrulama); geçersiz satırlar TEK TEK atlanır ve loglanır — bozuk bir
//     satır yüzünden bot açılmazlık yapmaz.
//   - ID'ler (serial dahil) aynen korunur; SQLite AUTOINCREMENT sayacı en
//     büyük ID'den devam eder.
//   - Eski JSON dosyaları SİLİNMEZ — yedek olarak yerinde durur.
// ---------------------------------------------------------------------------

import fs from "node:fs";
import path from "node:path";
import {
  getRegisteredTables,
  jsonStore,
  rawToRec,
  type Rec,
} from "./jsonOrm.js";
import { bulkInsertRecs, type SqliteHandle } from "./sqliteOrm.js";

export async function importJsonToSqliteIfNeeded(handle: SqliteHandle): Promise<void> {
  const meta = jsonStore.getMeta();
  if (meta["sqliteMigrated"]) return;

  let total = 0;
  for (const tableMeta of getRegisteredTables()) {
    const file = path.join(jsonStore.dbDir, `${tableMeta.name}.json`);
    if (!fs.existsSync(file)) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (err) {
      console.error(
        `[sqlite-import] ${file} okunamadı, atlandı (${err instanceof Error ? err.message : String(err)}).`,
      );
      continue;
    }
    if (!Array.isArray(parsed)) {
      console.error(`[sqlite-import] ${file} dizi değil, atlandı`);
      continue;
    }

    const recs: Rec[] = [];
    let invalid = 0;
    for (const raw of parsed) {
      try {
        recs.push(rawToRec(tableMeta, raw as Rec));
      } catch (err) {
        invalid++;
        console.error(
          `[sqlite-import] ${tableMeta.name}: bozuk satır atlandı (${err instanceof Error ? err.message : String(err)}).`,
        );
      }
    }
    const { skipped } = bulkInsertRecs(handle, tableMeta, recs);
    total += recs.length;
    console.log(
      `[sqlite-import] ${tableMeta.name}: ${recs.length} satır aktarıldı` +
        `${invalid > 0 ? ` (${invalid} bozuk atlandı)` : ""}` +
        `${skipped > 0 ? ` (${skipped} çakışan atlandı)` : ""}.`,
    );
  }

  jsonStore.setMeta({ sqliteMigrated: true });
  jsonStore.flush();
  console.log(`sqlite aktarımı bitti (${total} satır), eski json'lar yedekte`);
}
