// src/db/neonImport.ts
// ---------------------------------------------------------------------------
// Tek seferlik Neon → JSON aktarımı.
//
// Akış (bot açılışında, yalnızca aktarım daha önce tamamlanmadıysa):
//   1. DATABASE_URL ile Neon'a bağlan (salt-okunur, tutarlı anlık görüntü).
//   2. public şemadaki TÜM tabloları oku (şemada tanımlı olmayanlar dahil).
//   3. Ham hâlini data/neon-dump/<tablo>.json'a yaz (+ _manifest.json).
//   4. Şemada tanımlı tabloları data/db/<tablo>.json deposuna aktar.
//   5. data/db/_meta.json'a "tamamlandı" işareti koy → bir daha Neon'a gidilmez.
//
// Neon'a ulaşılamazsa ve daha önce alınmış TAM bir döküm (data/neon-dump)
// varsa onunla devam edilir. Hiçbiri yoksa bot BAŞLAMAZ (sessizce boş veriyle
// başlayıp üyelerin verisini kaybetmemek için). Bilerek boş başlamak için:
// SKIP_NEON_IMPORT=true.
// ---------------------------------------------------------------------------

import fs from "node:fs";
import path from "node:path";
import { db, eq, getRegisteredTables, jsonStore, type Rec } from "./jsonOrm.js";
import { wordChainChannelsTable, wordChainUsedWordsTable } from "./schema.js";

const DUMP_DIR = path.resolve(process.cwd(), "data/neon-dump");
const MANIFEST_FILE = path.join(DUMP_DIR, "_manifest.json");

// timestamp / timestamptz / date değerlerini pg'nin yerel saate çevirmesini
// engelle: ham metin olarak alınır, jsonOrm UTC olarak yorumlar (drizzle de
// aynı şekilde UTC okuyordu).
const RAW_TEXT_OIDS = new Set([1114, 1184, 1082]);

type Dump = Map<string, Rec[]>;

function atomicWrite(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content, "utf8");
  fs.renameSync(tmp, file);
}

function safeStringify(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

async function dumpFromNeon(url: string): Promise<Dump> {
  // pg yalnızca aktarım için gerekir; aktarım bittikten sonra hiç yüklenmez.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mod: any = await import("pg");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pg: any = mod.default ?? mod;

  const client = new pg.Client({
    connectionString: url,
    connectionTimeoutMillis: 30_000,
    statement_timeout: 120_000,
    query_timeout: 180_000,
    keepAlive: true,
    ...(process.env.DB_SSL === "true" ? { ssl: { rejectUnauthorized: false } } : {}),
    types: {
      getTypeParser: (oid: number, format?: string) =>
        RAW_TEXT_OIDS.has(oid) ? (v: string) => v : pg.types.getTypeParser(oid, format),
    },
  });
  client.on("error", (err: Error) => console.error("[import] neon bağlantısı patladı:", err.message));

  const dump: Dump = new Map();
  await client.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const tables = await client.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
       ORDER BY table_name`,
    );
    for (const row of tables.rows as { table_name: string }[]) {
      const result = await client.query(`SELECT * FROM public.${quoteIdent(row.table_name)}`);
      dump.set(row.table_name, result.rows as Rec[]);
    }
    await client.query("COMMIT");
  } finally {
    await client.end().catch(() => undefined);
  }
  return dump;
}

function writeDumpFiles(dump: Dump): void {
  const counts: Record<string, number> = {};
  for (const [name, rows] of dump) {
    atomicWrite(path.join(DUMP_DIR, `${name}.json`), rows.length === 0 ? "[]\n" : `[\n${rows.map((r) => safeStringify(r)).join(",\n")}\n]\n`);
    counts[name] = rows.length;
  }
  // Manifest EN SON yazılır: varsa döküm eksiksizdir.
  atomicWrite(
    MANIFEST_FILE,
    `${JSON.stringify({ complete: true, dumpedAt: new Date().toISOString(), source: "neon", schema: "public", tables: counts }, null, 2)}\n`,
  );
}

function readDumpFiles(): Dump | null {
  try {
    if (!fs.existsSync(MANIFEST_FILE)) return null;
    const manifest = JSON.parse(fs.readFileSync(MANIFEST_FILE, "utf8")) as { complete?: boolean; tables?: Record<string, number> };
    if (!manifest.complete || !manifest.tables) return null;
    const dump: Dump = new Map();
    for (const name of Object.keys(manifest.tables)) {
      const rows = JSON.parse(fs.readFileSync(path.join(DUMP_DIR, `${name}.json`), "utf8")) as unknown;
      if (!Array.isArray(rows)) return null;
      dump.set(name, rows as Rec[]);
    }
    return dump;
  } catch (err) {
    console.error("[import] neon-dump okunamadı:", err instanceof Error ? err.message : err);
    return null;
  }
}

/** Eski sürümlerde kelime listesi tek satırlık JSON kolonundaydı; hâlâ doluysa ayrı tabloya taşı. */
function migrateLegacyWordChainWords(): void {
  const channels = db.select().from(wordChainChannelsTable).run();
  for (const row of channels) {
    if (!row.usedWords || row.usedWords === "[]") continue;
    let words: string[];
    try {
      const parsed: unknown = JSON.parse(row.usedWords);
      if (!Array.isArray(parsed)) continue;
      words = parsed.filter((w): w is string => typeof w === "string");
    } catch {
      console.warn(`[import] kelime zinciri eski json okunamadı (${row.channelId}), ellemiyorum`);
      continue;
    }
    if (words.length > 0) {
      db.insert(wordChainUsedWordsTable)
        .values(words.map((word) => ({ channelId: row.channelId, word })))
        .onConflictDoNothing()
        .run();
    }
    db.update(wordChainChannelsTable).set({ usedWords: "[]" }).where(eq(wordChainChannelsTable.channelId, row.channelId)).run();
  }
}

function applyDump(dump: Dump, source: string): void {
  const known = new Map(getRegisteredTables().map((t) => [t.name, t]));
  const summary: Record<string, { inserted: number; skipped: number; invalid: number }> = {};
  const unknownTables: string[] = [];
  for (const [name, rows] of dump) {
    if (!known.has(name)) {
      unknownTables.push(name);
      continue;
    }
    summary[name] = jsonStore.mergeRawRows(name, rows);
  }
  migrateLegacyWordChainWords();
  jsonStore.setMeta({
    neonImport: { completedAt: new Date().toISOString(), source, tables: summary, unknownTables },
  });
  jsonStore.writeAllFiles();

  const total = Object.values(summary).reduce((n, s) => n + s.inserted, 0);
  console.log(`[import] neon'dan ${total} satır aktarıldı (${source})`);
  for (const [name, s] of Object.entries(summary)) {
    console.log(`   • ${name}: ${s.inserted} aktarıldı${s.skipped ? `, ${s.skipped} vardı zaten` : ""}${s.invalid ? `, ${s.invalid} bozuk (atlandı)` : ""}`);
  }
  if (unknownTables.length > 0) {
    console.warn(`[import] şemada olmayan tablolar ham dökümde duruyor: ${unknownTables.join(", ")}`);
  }
}

export async function importFromNeonIfNeeded(): Promise<void> {
  const done = (jsonStore.getMeta() as { neonImport?: { completedAt?: string } }).neonImport?.completedAt;
  if (done) return;

  if (process.env.SKIP_NEON_IMPORT?.trim().toLowerCase() === "true") {
    console.warn("SKIP_NEON_IMPORT=true, neon atlandı — boş db ile devam");
    return;
  }

  const url = process.env.DATABASE_URL?.trim();
  let dump: Dump | null = null;
  let source = "";
  let liveError: unknown = null;

  if (url) {
    console.log("[import] neon'a bağlanıyorum, veriler çekiliyor...");
    try {
      dump = await dumpFromNeon(url);
      writeDumpFiles(dump);
      source = "neon";
    } catch (err) {
      liveError = err;
      dump = null;
      console.error("[import] neon'dan veri gelmedi:", err instanceof Error ? err.message : err);
    }
  }

  if (!dump) {
    const local = readDumpFiles();
    if (local) {
      dump = local;
      source = "data/neon-dump";
      console.warn("[import] eski neon dökümü kullanılıyor");
    }
  }

  if (!dump) {
    if (!url) {
      console.log("[import] DATABASE_URL yok, döküm de yok — boş başlıyorum");
      return;
    }
    throw new Error(
      `Neon verisi aktarılamadı, bot boş veriyle başlatılmadı (üyelerin verisi kaybolmasın diye). ` +
        `Neon'a erişimi düzeltin (kullanım limiti/askıya alma) ve botu yeniden başlatın. ` +
        `Bilerek BOŞ başlamak için SKIP_NEON_IMPORT=true ekleyin. ` +
        `Son hata: ${liveError instanceof Error ? liveError.message : String(liveError)}`,
    );
  }

  applyDump(dump, source);
}
