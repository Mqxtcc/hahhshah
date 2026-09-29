import { getSqliteHandle } from "../db/index.js";

/**
 * Veri hijyeni: kaldırılan özelliklerden kalan ölü tablo/satırları temizler.
 * Açılışta bir kez çalışır; bulamazsa hiçbir şey yapmaz (VACUUM dahil).
 * Asla hata fırlatmaz — botun açılışını bloklamaz.
 */

// !mesaj (2026-09-25) ve !davet izle (2026-09-25) kaldırıldı; tabloları ölü.
// Komut-başına deneme sistemi (2026-09-28) günlük modele geçti; eski tablo ölü.
const DEAD_TABLES = [
  "discord_msg_stats",
  "discord_invite_track",
  "discord_invite_members",
  "discord_invite_uses",
  "discord_command_trials",
];

// Eski sürümün kaynak kod dökümü (~1MB) — mevcut kodda okuyan/yazan yok.
const DEAD_KEYS = ["changelog:snapshot"];

export async function runDataHygiene(): Promise<string[]> {
  const cleaned: string[] = [];
  try {
    const handle = getSqliteHandle();
    if (!handle) return cleaned; // JSON fallback — dokunma

    const inList = (xs: string[]) => xs.map(() => "?").join(",");

    // Ölü tablolar var mı?
    const existingTables = handle
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name IN (${inList(DEAD_TABLES)})`)
      .all(...DEAD_TABLES)
      .map((r) => String(r.name));

    // Ölü anahtarlar var mı?
    let deadKeys: string[] = [];
    try {
      deadKeys = handle
        .prepare(`SELECT key FROM discord_bot_settings WHERE key IN (${inList(DEAD_KEYS)})`)
        .all(...DEAD_KEYS)
        .map((r) => String(r.key));
    } catch {
      deadKeys = [];
    }

    if (existingTables.length === 0 && deadKeys.length === 0) return cleaned;

    for (const key of deadKeys) {
      handle.prepare(`DELETE FROM discord_bot_settings WHERE key = ?`).run(key);
      cleaned.push(`anahtar: ${key}`);
    }
    for (const table of existingTables) {
      handle.exec(`DROP TABLE IF EXISTS "${table.replace(/"/g, "")}";`);
      cleaned.push(`tablo: ${table}`);
    }

    // Boşalan alanı dosyaya geri ver.
    handle.exec("VACUUM;");

    console.log(`🗑️ [temizlik] ${cleaned.length} ölü girdi silindi`);
    console.log("[temizlik] vacuum bitti");
  } catch (err) {
    console.error("temizlik patladı:", err);
  }
  return cleaned;
}
