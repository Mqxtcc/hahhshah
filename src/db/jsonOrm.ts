// src/db/jsonOrm.ts
// ---------------------------------------------------------------------------
// Neon/PostgreSQL yerine data/db/*.json dosyalarını kullanan, drizzle-orm'un
// projede kullanılan alt kümesiyle birebir uyumlu küçük bir "veritabanı".
//
//   - Her tablo = data/db/<tablo_adı>.json  (satır dizisi, kolon adları SQL
//     adlarıyla — yani Neon'dan alınan ham dökümle aynı biçim)
//   - Tüm veri bellekte tutulur; okuma sorguları senkron/anlıktır.
//   - Yazma: bellek anında güncellenir, dosyaya ~150ms içinde (birleştirilmiş,
//     atomik: tmp dosya + rename) yazılır. Kapanışta / süreç çıkışında senkron
//     flush yapılır.
//   - db.select/insert/update/delete + eq/and/desc/asc/count/sql API'si
//     drizzle'ınkiyle aynıdır; böylece komut dosyalarının çoğu değişmeden
//     çalışır. Sorgular `await` edilebilir (thenable) ve `.run()` ile
//     SENKRON çalıştırılabilir (atomik oku-değiştir-yaz akışları için).
// ---------------------------------------------------------------------------

import fs from "node:fs";
import path from "node:path";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Rec = Record<string, any>;

// ---------------------------------------------------------------------------
// Kolon / tablo tanımları
// ---------------------------------------------------------------------------

export type ColKind = "text" | "integer" | "boolean" | "timestamp" | "serial" | "jsonb";

interface ColSpec {
  notNull?: boolean;
  hasDefault?: boolean;
  defaultValue?: unknown;
  defaultNow?: boolean;
  primaryKey?: boolean;
  unique?: boolean;
}

export class ColumnBuilder<TData, TNotNull extends boolean = false, THasDefault extends boolean = false> {
  declare readonly _data: TData;
  declare readonly _notNull: TNotNull;
  declare readonly _hasDefault: THasDefault;

  constructor(
    readonly kind: ColKind,
    readonly sqlName: string,
    readonly spec: ColSpec = {},
  ) {}

  private next(patch: ColSpec): ColumnBuilder<TData, boolean, boolean> {
    return new ColumnBuilder<TData, boolean, boolean>(this.kind, this.sqlName, { ...this.spec, ...patch });
  }

  notNull(): ColumnBuilder<TData, true, THasDefault> {
    return this.next({ notNull: true }) as ColumnBuilder<TData, true, THasDefault>;
  }
  default(value: TData): ColumnBuilder<TData, TNotNull, true> {
    return this.next({ hasDefault: true, defaultValue: value }) as ColumnBuilder<TData, TNotNull, true>;
  }
  defaultNow(): ColumnBuilder<TData, TNotNull, true> {
    return this.next({ hasDefault: true, defaultNow: true }) as ColumnBuilder<TData, TNotNull, true>;
  }
  primaryKey(): ColumnBuilder<TData, true, THasDefault> {
    return this.next({ primaryKey: true, notNull: true }) as ColumnBuilder<TData, true, THasDefault>;
  }
  unique(): ColumnBuilder<TData, TNotNull, THasDefault> {
    return this.next({ unique: true }) as ColumnBuilder<TData, TNotNull, THasDefault>;
  }
  $type<T>(): ColumnBuilder<T, TNotNull, THasDefault> {
    return this as unknown as ColumnBuilder<T, TNotNull, THasDefault>;
  }
}

export const text = (name: string) => new ColumnBuilder<string>("text", name);
export const integer = (name: string) => new ColumnBuilder<number>("integer", name);
export const boolean = (name: string) => new ColumnBuilder<boolean>("boolean", name);
export const timestamp = (name: string) => new ColumnBuilder<Date>("timestamp", name);
export const jsonb = (name: string) => new ColumnBuilder<unknown>("jsonb", name);
export const serial = (name: string) =>
  new ColumnBuilder<number, true, true>("serial", name, { notNull: true, hasDefault: true });

export class Column<TData = unknown, TNotNull extends boolean = boolean, THasDefault extends boolean = boolean> {
  declare readonly _data: TData;
  declare readonly _notNull: TNotNull;
  declare readonly _hasDefault: THasDefault;

  constructor(
    readonly table: string,
    readonly key: string,
    readonly sqlName: string,
    readonly kind: ColKind,
    readonly spec: ColSpec,
  ) {}
}

type ColOf<B> = B extends ColumnBuilder<infer D, infer N, infer H> ? Column<D, N, H> : never;
type ColData<B> = B extends ColumnBuilder<infer D, infer N, infer _H> ? (N extends true ? D : D | null) : never;

export type TableColumns = Record<string, ColumnBuilder<any, any, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any

type InferSelect<C extends TableColumns> = { [K in keyof C]: ColData<C[K]> };
type RequiredKeys<C extends TableColumns> = {
  [K in keyof C]: C[K] extends ColumnBuilder<any, true, false> ? K : never; // eslint-disable-line @typescript-eslint/no-explicit-any
}[keyof C];
type InferInsert<C extends TableColumns> = { [K in RequiredKeys<C>]: ColData<C[K]> } & {
  [K in Exclude<keyof C, RequiredKeys<C>>]?: ColData<C[K]>;
};
type SetValues<C extends TableColumns> = { [K in keyof C]?: ColData<C[K]> | SqlExpr };

export interface TableMeta {
  readonly name: string;
  readonly columns: Column[];
  readonly byKey: Map<string, Column>;
  readonly bySqlName: Map<string, Column>;
  /** Birincil anahtar + tekil (unique) kısıtlar — her biri bir kolon kümesi. */
  readonly uniques: Column[][];
  readonly serialColumn: Column | null;
  /** jsonTable options.primaryKey ile verilen bileşik PK (JS key adları) — DDL üretimi için. */
  readonly compositePk: string[];
}

export interface TableBrand<C extends TableColumns> {
  readonly $meta: TableMeta;
  readonly $inferSelect: InferSelect<C>;
  readonly $inferInsert: InferInsert<C>;
  readonly $set: SetValues<C>;
}

export type Table<C extends TableColumns> = { readonly [K in keyof C]: ColOf<C[K]> } & TableBrand<C>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyTable = TableBrand<any>;

const registry = new Map<string, TableMeta>();

export function jsonTable<C extends TableColumns>(
  name: string,
  columns: C,
  options: { primaryKey?: (keyof C & string)[]; unique?: (keyof C & string)[][] } = {},
): Table<C> {
  const cols: Column[] = [];
  const byKey = new Map<string, Column>();
  const bySqlName = new Map<string, Column>();
  const compositePk = new Set<string>(options.primaryKey ?? []);
  for (const [key, builder] of Object.entries(columns)) {
    const spec: ColSpec = { ...builder.spec };
    if (compositePk.has(key)) spec.notNull = true;
    const col = new Column(name, key, builder.sqlName, builder.kind, spec);
    cols.push(col);
    byKey.set(key, col);
    bySqlName.set(builder.sqlName, col);
  }

  const uniques: Column[][] = [];
  const pkCols = cols.filter((c) => c.spec.primaryKey);
  if (pkCols.length > 0) uniques.push(pkCols);
  if (options.primaryKey && options.primaryKey.length > 0) {
    uniques.push(options.primaryKey.map((k) => byKey.get(k)!));
  }
  for (const c of cols) {
    if (c.spec.unique && !c.spec.primaryKey) uniques.push([c]);
  }
  for (const set of options.unique ?? []) uniques.push(set.map((k) => byKey.get(k)!));
  const serialColumn = cols.find((c) => c.kind === "serial") ?? null;
  // serial kolon zaten benzersizdir (Postgres'te de seri sütunlar PK/unique idi).
  if (serialColumn && !uniques.some((u) => u.length === 1 && u[0] === serialColumn)) {
    uniques.push([serialColumn]);
  }

  const meta: TableMeta = {
    name,
    columns: cols,
    byKey,
    bySqlName,
    uniques,
    serialColumn,
    compositePk: [...(options.primaryKey ?? [])],
  };
  registry.set(name, meta);
  const table: Record<string, unknown> = { $meta: meta };
  for (const c of cols) table[c.key] = c;
  return table as unknown as Table<C>;
}

export function getRegisteredTables(): TableMeta[] {
  return [...registry.values()];
}

// ---------------------------------------------------------------------------
// Değer normalizasyonu (kolon tipine göre)
// ---------------------------------------------------------------------------

/** sqliteOrm.ts de kullanır (SQLite constraint hatalarını aynı kodla fırlatmak için). */
export function dbError(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

function parseTimestamp(value: unknown, where: string): Date {
  let date: Date;
  if (value instanceof Date) {
    date = new Date(value.getTime());
  } else if (typeof value === "number") {
    date = new Date(value);
  } else if (typeof value === "string") {
    let s = value.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
      s += "T00:00:00Z";
    } else {
      s = s.replace(" ", "T");
      if (/[+-]\d{2}\d{2}$/.test(s)) s = s.replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
      else if (/[+-]\d{2}$/.test(s)) s += ":00";
      else if (!/(Z|z)$/.test(s)) s += "Z";
    }
    date = new Date(s);
  } else {
    throw dbError(`${where}: geçersiz tarih değeri (${typeof value})`, "22007");
  }
  if (Number.isNaN(date.getTime())) throw dbError(`${where}: geçersiz tarih değeri "${String(value)}"`, "22007");
  return date;
}

/** sqliteOrm.ts de kullanır (INSERT varsayılanlarını klonlamak için). */
export function cloneValue(v: unknown): unknown {
  if (v instanceof Date) return new Date(v.getTime());
  if (v !== null && typeof v === "object") return structuredClone(v);
  return v;
}

/** sqliteOrm.ts de kullanır (INSERT satırlarını JSON'dakiyle birebir aynı kurallarla normalize etmek için). */
export function normalizeValue(col: Column, value: unknown): unknown {
  const where = `${col.table}.${col.sqlName}`;
  if (value === null || value === undefined) return null;
  switch (col.kind) {
    case "text":
      if (typeof value === "string") return value;
      if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
      throw dbError(`${where}: metin bekleniyordu`, "22P02");
    case "integer":
    case "serial": {
      const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
      if (!Number.isFinite(n)) throw dbError(`${where}: tamsayı bekleniyordu (${String(value)})`, "22P02");
      return Math.round(n);
    }
    case "boolean":
      if (typeof value === "boolean") return value;
      if (value === "t" || value === "true" || value === 1) return true;
      if (value === "f" || value === "false" || value === 0) return false;
      throw dbError(`${where}: boolean bekleniyordu`, "22P02");
    case "timestamp":
      return parseTimestamp(value, where);
    case "jsonb":
      return cloneValue(value);
  }
}

// ---------------------------------------------------------------------------
// SQL ifadeleri / koşullar / sıralama
// ---------------------------------------------------------------------------

export class SqlExpr<T = unknown> {
  declare readonly _type: T;
  constructor(
    readonly strings: readonly string[],
    readonly values: readonly unknown[],
  ) {}

  /** Yalnızca projede kullanılan `${kolon} + N` / `${kolon} - N` kalıbını destekler. */
  evaluate(rec: Rec): unknown {
    const [col] = this.values;
    if (this.values.length === 1 && col instanceof Column && this.strings[0].trim() === "") {
      const m = /^\s*([+-])\s*(\d+)\s*$/.exec(this.strings[1] ?? "");
      if (m) {
        const base = Number(rec[col.key] ?? 0);
        return m[1] === "+" ? base + Number(m[2]) : base - Number(m[2]);
      }
    }
    throw new Error(`Desteklenmeyen sql ifadesi: ${this.strings.join("?")}`);
  }

  /**
   * sqliteOrm.ts kullanır: `${kolon} ± N` kalıbını SQL SET ifadesine çevirir
   * (ör. `"wins" = "wins" + 1`). evaluate() ile aynı kalıbı destekler.
   */
  toSQLite(): { text: string; params: unknown[] } {
    const [col] = this.values;
    if (this.values.length === 1 && col instanceof Column && this.strings[0].trim() === "") {
      const m = /^\s*([+-])\s*(\d+)\s*$/.exec(this.strings[1] ?? "");
      if (m) return { text: `"${col.sqlName.replace(/"/g, '""')}" ${m[1]} ${m[2]}`, params: [] };
    }
    throw new Error(`Desteklenmeyen sql ifadesi: ${this.strings.join("?")}`);
  }
}

export function sql<T = unknown>(strings: TemplateStringsArray, ...values: unknown[]): SqlExpr<T> {
  return new SqlExpr<T>([...strings], values);
}

export class AggCount {
  declare readonly _count: number;
  constructor(readonly column?: Column) {}
}

export function count(column?: Column): AggCount {
  return new AggCount(column);
}

export interface Cond {
  test(rec: Rec): boolean;
  /**
   * SQLite WHERE parçası — yalnızca sqliteOrm.ts kullanır. eq/lt/and ile
   * üretilen her koşulda otomatik dolar; test() davranışı değişmez.
   */
  readonly _sqlite?: { text: string; params: unknown[] };
}

/**
 * sqliteOrm.ts kullanır: koşul değerini SQLite parametresine çevirir
 * (Date→ms, boolean→0/1, jsonb→JSON metni).
 */
export function toSqliteParam(col: Column, value: unknown): unknown {
  if (value === null || value === undefined) return null;
  switch (col.kind) {
    case "timestamp":
      return value instanceof Date ? value.getTime() : parseTimestamp(value, "sqlite").getTime();
    case "boolean":
      return value ? 1 : 0;
    case "jsonb":
      return JSON.stringify(value ?? null);
    default:
      return value;
  }
}

function sqliteEq(column: Column, value: unknown, op: "=" | "<"): { text: string; params: unknown[] } {
  return {
    text: `"${column.sqlName.replace(/"/g, '""')}" ${op} ?`,
    params: [toSqliteParam(column, value)],
  };
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === null || a === undefined || b === null || b === undefined) return false;
  if (a instanceof Date || b instanceof Date) {
    const ta = a instanceof Date ? a.getTime() : new Date(a as string).getTime();
    const tb = b instanceof Date ? b.getTime() : new Date(b as string).getTime();
    return ta === tb;
  }
  return a === b;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function eq(column: Column<any, any, any>, value: unknown): Cond {
  return { test: (rec) => sameValue(rec[column.key], value), _sqlite: sqliteEq(column, value, "=") };
}

/** Basit tarih/sayı karşılaştırması; süre dolmuş geçici kayıtları temizlemek için kullanılır. */
export function lt(column: Column<any, any, any>, value: unknown): Cond {
  return {
    test: (rec) => {
      const actual = rec[column.key];
      if (actual === null || actual === undefined || value === null || value === undefined) return false;
      const left = actual instanceof Date ? actual.getTime() : Number(actual);
      const right = value instanceof Date ? value.getTime() : Number(value);
      return Number.isFinite(left) && Number.isFinite(right) && left < right;
    },
    _sqlite: sqliteEq(column, value, "<"),
  };
}

export function and(...conds: (Cond | undefined)[]): Cond {
  const list = conds.filter((c): c is Cond => c !== undefined);
  for (const c of list) {
    if (!c._sqlite) throw new Error("SQLite: bu koşul türü desteklenmiyor (yalnızca eq/lt/and).");
  }
  return {
    test: (rec) => list.every((c) => c.test(rec)),
    _sqlite:
      list.length === 0
        ? { text: "1 = 1", params: [] }
        : {
            text: list.map((c) => `(${c._sqlite!.text})`).join(" AND "),
            params: list.flatMap((c) => c._sqlite!.params),
          },
  };
}

export interface Order {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  column: Column<any, any, any>;
  dir: "asc" | "desc";
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const asc = (column: Column<any, any, any>): Order => ({ column, dir: "asc" });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const desc = (column: Column<any, any, any>): Order => ({ column, dir: "desc" });

function compareValues(a: unknown, b: unknown, dir: "asc" | "desc"): number {
  const aNull = a === null || a === undefined;
  const bNull = b === null || b === undefined;
  // PostgreSQL: ASC => NULLS LAST, DESC => NULLS FIRST
  if (aNull || bNull) {
    if (aNull && bNull) return 0;
    const nullFirst = dir === "desc";
    return aNull ? (nullFirst ? -1 : 1) : nullFirst ? 1 : -1;
  }
  let result: number;
  if (a instanceof Date && b instanceof Date) result = a.getTime() - b.getTime();
  else if (typeof a === "number" && typeof b === "number") result = a - b;
  else if (typeof a === "boolean" && typeof b === "boolean") result = Number(a) - Number(b);
  else result = String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
  return dir === "desc" ? -result : result;
}

// ---------------------------------------------------------------------------
// Depo (bellek + dosya)
// ---------------------------------------------------------------------------

const DB_DIR = path.resolve(process.cwd(), "data/db");
const META_FILE = path.join(DB_DIR, "_meta.json");
const FLUSH_DELAY_MS = 150;

class TableStore {
  rows: Rec[] = [];
  dirty = false;
  nextSerial = 1;
  constructor(
    readonly meta: TableMeta,
    readonly file: string,
  ) {}
}

const stores = new Map<string, TableStore>();
let flushTimer: NodeJS.Timeout | null = null;
let exitHookInstalled = false;
let metaCache: Rec | null = null;
let metaDirty = false;

function atomicWriteSync(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content, "utf8");
  fs.renameSync(tmp, file);
}

function recToFileObject(meta: TableMeta, rec: Rec): Rec {
  const out: Rec = {};
  for (const col of meta.columns) {
    const v = rec[col.key];
    out[col.sqlName] = v instanceof Date ? v.toISOString() : (v ?? null);
  }
  return out;
}

export function serializeRows(meta: TableMeta, rows: Rec[]): string {
  if (rows.length === 0) return "[]\n";
  return `[\n${rows.map((r) => `  ${JSON.stringify(recToFileObject(meta, r))}`).join(",\n")}\n]\n`;
}

/** Dosya/ham döküm nesnesinden (SQL kolon adlarıyla) iç kayda dönüştürür. */
export function rawToRec(meta: TableMeta, raw: Rec): Rec {
  const rec: Rec = {};
  for (const col of meta.columns) {
    let v: unknown = raw[col.sqlName];
    if (v === undefined) v = raw[col.key]; // camelCase ile elle düzenlenmiş dosyalara tolerans
    if (v === undefined || v === null) {
      if (col.spec.defaultNow) v = new Date();
      else if (col.spec.hasDefault && col.spec.defaultValue !== undefined) v = cloneValue(col.spec.defaultValue);
      else v = null;
    }
    const value = normalizeValue(col, v);
    if (value === null && col.spec.notNull && col.kind !== "serial") {
      throw dbError(`${col.table}.${col.sqlName}: NOT NULL kolon boş`, "23502");
    }
    rec[col.key] = value;
  }
  return rec;
}

function loadTable(meta: TableMeta): TableStore {
  const existing = stores.get(meta.name);
  if (existing) return existing;
  const file = path.join(DB_DIR, `${meta.name}.json`);
  const store = new TableStore(meta, file);
  if (fs.existsSync(file)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (err) {
      throw new Error(
        `❌ ${file} okunamadı/bozuk (${err instanceof Error ? err.message : String(err)}). ` +
          `Veri kaybını önlemek için bot başlatılmıyor — dosyayı onarın ya da data/neon-dump'taki ham yedekten geri yükleyin.`,
      );
    }
    if (!Array.isArray(parsed)) throw new Error(`❌ ${file} bir dizi (array) değil.`);
    parsed.forEach((raw, i) => {
      try {
        store.rows.push(rawToRec(meta, raw as Rec));
      } catch (err) {
        throw new Error(`❌ ${file} satır ${i + 1} geçersiz: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
  }
  if (meta.serialColumn) {
    let max = 0;
    for (const r of store.rows) max = Math.max(max, Number(r[meta.serialColumn.key] ?? 0));
    store.nextSerial = max + 1;
  }
  stores.set(meta.name, store);
  return store;
}

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on("exit", () => {
    try {
      flushAllSync();
    } catch (err) {
      console.error("çıkışta json yazılamadı:", err);
    }
  });
}

function scheduleFlush(delay = FLUSH_DELAY_MS): void {
  installExitHook();
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    try {
      flushAllSync();
    } catch {
      // flushAllSync hatayı zaten logladı ve dirty işaretlerini korudu.
      scheduleFlush(5_000);
    }
  }, delay);
  flushTimer.unref?.();
}

/** Bekleyen tüm değişiklikleri diske yazar (senkron). İlk hatada durmaz; sonunda hata fırlatır. */
export function flushAllSync(): void {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  let firstError: unknown = null;
  for (const store of stores.values()) {
    if (!store.dirty) continue;
    try {
      atomicWriteSync(store.file, serializeRows(store.meta, store.rows));
      store.dirty = false;
    } catch (err) {
      console.error(`${store.file} yazılamadı, bellekte duruyor:`, err);
      firstError ??= err;
    }
  }
  if (metaDirty && metaCache) {
    try {
      atomicWriteSync(META_FILE, `${JSON.stringify(metaCache, null, 2)}\n`);
      metaDirty = false;
    } catch (err) {
      console.error(`${META_FILE} yazılamadı:`, err);
      firstError ??= err;
    }
  }
  if (firstError) throw firstError;
}

function markDirty(store: TableStore): void {
  store.dirty = true;
  scheduleFlush();
}

function getStore(meta: TableMeta): TableStore {
  return stores.get(meta.name) ?? loadTable(meta);
}

// ---------------------------------------------------------------------------
// Dışa açılan depo yönetimi (başlangıç / import / kapanış)
// ---------------------------------------------------------------------------

export const jsonStore = {
  dbDir: DB_DIR,

  /** Kayıtlı tüm tabloları diskten belleğe yükler (idempotent, senkron). */
  loadAll(): void {
    fs.mkdirSync(DB_DIR, { recursive: true });
    for (const meta of registry.values()) loadTable(meta);
    installExitHook();
  },

  getMeta(): Rec {
    if (metaCache) return metaCache;
    try {
      metaCache = fs.existsSync(META_FILE) ? (JSON.parse(fs.readFileSync(META_FILE, "utf8")) as Rec) : {};
    } catch (err) {
      throw new Error(`❌ ${META_FILE} bozuk: ${err instanceof Error ? err.message : String(err)}`);
    }
    return metaCache;
  },

  setMeta(patch: Rec): void {
    metaCache = { ...this.getMeta(), ...patch };
    metaDirty = true;
    scheduleFlush();
  },

  /** Tüm tablo dosyalarını (boş olanlar dahil) oluşturur/günceller ve senkron yazar. */
  writeAllFiles(): void {
    for (const store of stores.values()) store.dirty = true;
    flushAllSync();
  },

  flush(): void {
    flushAllSync();
  },

  /**
   * Neon dökümünden gelen ham satırları (SQL kolon adlarıyla) tabloya ekler.
   * Zaten aynı birincil/tekil anahtara sahip satır varsa atlanır.
   */
  mergeRawRows(tableName: string, rawRows: Rec[]): { inserted: number; skipped: number; invalid: number } {
    const meta = registry.get(tableName);
    if (!meta) throw new Error(`Bilinmeyen tablo: ${tableName}`);
    const store = getStore(meta);
    let inserted = 0;
    let skipped = 0;
    let invalid = 0;
    for (const raw of rawRows) {
      let rec: Rec;
      try {
        rec = rawToRec(meta, raw);
        if (meta.serialColumn && (raw[meta.serialColumn.sqlName] === undefined || raw[meta.serialColumn.sqlName] === null)) {
          rec[meta.serialColumn.key] = store.nextSerial++;
        }
      } catch (err) {
        invalid++;
        console.error(`[import] ${tableName}: bozuk satır atlandı:`, err instanceof Error ? err.message : err, raw);
        continue;
      }
      if (findConflict(meta, store.rows, rec)) {
        skipped++;
        continue;
      }
      store.rows.push(rec);
      if (meta.serialColumn) {
        store.nextSerial = Math.max(store.nextSerial, Number(rec[meta.serialColumn.key]) + 1);
      }
      inserted++;
    }
    if (inserted > 0) markDirty(store);
    return { inserted, skipped, invalid };
  },

  close(): void {
    flushAllSync();
  },
};

// ---------------------------------------------------------------------------
// Sorgu yardımcıları
// ---------------------------------------------------------------------------

function findConflict(
  meta: TableMeta,
  rows: Rec[],
  rec: Rec,
  only?: Column[],
): { index: number; set: Column[] } | null {
  const sets = only ? [only] : meta.uniques;
  for (const set of sets) {
    if (set.some((c) => rec[c.key] === null || rec[c.key] === undefined)) continue;
    const index = rows.findIndex((r) => set.every((c) => sameValue(r[c.key], rec[c.key])));
    if (index >= 0) return { index, set };
  }
  return null;
}

function uniqueViolation(meta: TableMeta, set: Column[]): Error {
  return dbError(
    `duplicate key value violates unique constraint on ${meta.name} (${set.map((c) => c.sqlName).join(", ")})`,
    "23505",
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type SelectField = Column<any, any, any> | AggCount;
export type SelectFields = Record<string, SelectField>;
export type FieldValue<F> = F extends Column<infer D, infer N, infer _H>
  ? N extends true
    ? D
    : D | null
  : F extends AggCount
    ? number
    : never;
export type InferFields<F extends SelectFields> = { [K in keyof F]: FieldValue<F[K]> };

function cloneRec(rec: Rec): Rec {
  const out: Rec = {};
  for (const [k, v] of Object.entries(rec)) out[k] = cloneValue(v);
  return out;
}

function project(rec: Rec, fields: SelectFields | undefined): Rec {
  if (!fields) return cloneRec(rec);
  const out: Rec = {};
  for (const [name, field] of Object.entries(fields)) {
    if (field instanceof Column) out[name] = cloneValue(rec[field.key] ?? null);
  }
  return out;
}

abstract class Query<T> implements PromiseLike<T> {
  /** Sorguyu SENKRON çalıştırır (bellek üzerinde, `await` gerektirmez). */
  abstract run(): T;

  then<TResult1 = T, TResult2 = never>(
    onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return new Promise<T>((resolve, reject) => {
      try {
        resolve(this.run());
      } catch (err) {
        reject(err);
      }
    }).then(onfulfilled, onrejected);
  }
  catch<TResult = never>(onrejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null): Promise<T | TResult> {
    return this.then(undefined, onrejected);
  }
  finally(onfinally?: (() => void) | null): Promise<T> {
    return this.then().finally(onfinally);
  }
}

// ---------------------------------------------------------------------------
// SELECT
// ---------------------------------------------------------------------------

class SelectQuery<R> extends Query<R[]> {
  private cond: Cond | undefined;
  private orders: Order[] = [];
  private max: number | undefined;

  constructor(
    private readonly meta: TableMeta,
    private readonly fields: SelectFields | undefined,
  ) {
    super();
  }

  where(cond: Cond | undefined): this {
    this.cond = cond;
    return this;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  orderBy(...items: (Column<any, any, any> | Order)[]): this {
    this.orders = items.map((i) => (i instanceof Column ? asc(i) : i));
    return this;
  }
  limit(n: number): this {
    this.max = n;
    return this;
  }

  run(): R[] {
    const store = getStore(this.meta);
    let rows = store.rows.filter((r) => (this.cond ? this.cond.test(r) : true));

    if (this.fields && Object.values(this.fields).some((f) => f instanceof AggCount)) {
      const out: Rec = {};
      for (const [name, field] of Object.entries(this.fields)) {
        if (field instanceof AggCount) {
          out[name] = field.column ? rows.filter((r) => r[field.column!.key] != null).length : rows.length;
        } else {
          out[name] = null;
        }
      }
      return [out as R];
    }

    if (this.orders.length > 0) {
      rows = rows
        .map((r, i) => ({ r, i }))
        .sort((a, b) => {
          for (const o of this.orders) {
            const c = compareValues(a.r[o.column.key], b.r[o.column.key], o.dir);
            if (c !== 0) return c;
          }
          return a.i - b.i;
        })
        .map((x) => x.r);
    }
    if (this.max !== undefined) rows = rows.slice(0, Math.max(0, this.max));
    return rows.map((r) => project(r, this.fields) as R);
  }
}

class SelectBuilder<F extends SelectFields | undefined> {
  constructor(private readonly fields: F) {}
  from<T extends AnyTable>(table: T): SelectQuery<F extends SelectFields ? InferFields<F> : T["$inferSelect"]> {
    return new SelectQuery(table.$meta, this.fields);
  }
}

// ---------------------------------------------------------------------------
// INSERT
// ---------------------------------------------------------------------------

export type ConflictTarget = Column | Column[]; // eslint-disable-line @typescript-eslint/no-explicit-any

class InsertQuery<T extends AnyTable, R> extends Query<R[]> {
  private mode: "none" | "nothing" | "update" = "none";
  private target: Column[] | undefined;
  private setValues: Rec | undefined;
  private returningFields: SelectFields | undefined;

  constructor(
    private readonly meta: TableMeta,
    private readonly valuesList: Rec[],
  ) {
    super();
  }

  onConflictDoNothing(config?: { target?: ConflictTarget }): this {
    this.mode = "nothing";
    this.target = config?.target ? (Array.isArray(config.target) ? config.target : [config.target]) : undefined;
    return this;
  }

  onConflictDoUpdate(config: { target: ConflictTarget; set: T["$set"] }): this {
    this.mode = "update";
    this.target = Array.isArray(config.target) ? config.target : [config.target];
    this.setValues = config.set as Rec;
    return this;
  }

  returning(): InsertQuery<T, T["$inferSelect"]>;
  returning<F extends SelectFields>(fields: F): InsertQuery<T, InferFields<F>>;
  returning(fields?: SelectFields): InsertQuery<T, never> {
    this.returningFields = fields;
    return this as unknown as InsertQuery<T, never>;
  }

  private applySet(existing: Rec): Rec {
    const next: Rec = { ...existing };
    for (const [key, raw] of Object.entries(this.setValues ?? {})) {
      const col = this.meta.byKey.get(key);
      if (!col || raw === undefined) continue;
      const value = raw instanceof SqlExpr ? raw.evaluate(existing) : raw;
      const normalized = normalizeValue(col, value);
      if (normalized === null && col.spec.notNull) {
        throw dbError(`${col.table}.${col.sqlName}: NOT NULL kolona null yazılamaz`, "23502");
      }
      next[key] = normalized;
    }
    return next;
  }

  run(): R[] {
    const meta = this.meta;
    const store = getStore(meta);
    const working = store.rows.slice();
    let nextSerial = store.nextSerial;
    const out: Rec[] = [];
    let changed = false;

    for (const values of this.valuesList) {
      const rec: Rec = {};
      for (const col of meta.columns) {
        let v: unknown = values[col.key];
        if (v === undefined) {
          if (col.kind === "serial") v = nextSerial++;
          else if (col.spec.defaultNow) v = new Date();
          else if (col.spec.hasDefault && col.spec.defaultValue !== undefined) v = cloneValue(col.spec.defaultValue);
          else v = null;
        }
        const value = normalizeValue(col, v);
        if (value === null && col.spec.notNull) {
          throw dbError(`null value in column "${col.sqlName}" of relation "${meta.name}" violates not-null constraint`, "23502");
        }
        rec[col.key] = value;
        if (col.kind === "serial" && typeof value === "number") nextSerial = Math.max(nextSerial, value + 1);
      }

      if (this.mode === "none") {
        const conflict = findConflict(meta, working, rec);
        if (conflict) throw uniqueViolation(meta, conflict.set);
        working.push(rec);
        out.push(rec);
        changed = true;
        continue;
      }

      if (this.mode === "nothing") {
        const conflict = findConflict(meta, working, rec, this.target);
        if (conflict) continue;
        // hedef verilmişse diğer tekil kısıtların ihlali yine hata verir (Postgres davranışı)
        if (this.target) {
          const other = findConflict(meta, working, rec);
          if (other) throw uniqueViolation(meta, other.set);
        }
        working.push(rec);
        out.push(rec);
        changed = true;
        continue;
      }

      // update
      const conflict = findConflict(meta, working, rec, this.target);
      if (conflict) {
        const updated = this.applySet(working[conflict.index]);
        working[conflict.index] = updated;
        out.push(updated);
        changed = true;
      } else {
        const other = findConflict(meta, working, rec);
        if (other) throw uniqueViolation(meta, other.set);
        working.push(rec);
        out.push(rec);
        changed = true;
      }
    }

    if (changed) {
      store.rows = working;
      store.nextSerial = nextSerial;
      markDirty(store);
    }
    return out.map((r) => project(r, this.returningFields) as R);
  }
}

class InsertBuilder<T extends AnyTable> {
  constructor(private readonly table: T) {}
  values(values: T["$inferInsert"] | T["$inferInsert"][]): InsertQuery<T, T["$inferSelect"]> {
    const list = (Array.isArray(values) ? values : [values]) as Rec[];
    return new InsertQuery<T, T["$inferSelect"]>(this.table.$meta, list);
  }
}

// ---------------------------------------------------------------------------
// UPDATE
// ---------------------------------------------------------------------------

class UpdateQuery<T extends AnyTable, R> extends Query<R[]> {
  private cond: Cond | undefined;
  private returningFields: SelectFields | undefined;

  constructor(
    private readonly meta: TableMeta,
    private readonly setValues: Rec,
  ) {
    super();
  }

  where(cond: Cond | undefined): this {
    this.cond = cond;
    return this;
  }

  returning(): UpdateQuery<T, T["$inferSelect"]>;
  returning<F extends SelectFields>(fields: F): UpdateQuery<T, InferFields<F>>;
  returning(fields?: SelectFields): UpdateQuery<T, never> {
    this.returningFields = fields;
    return this as unknown as UpdateQuery<T, never>;
  }

  run(): R[] {
    const meta = this.meta;
    const store = getStore(meta);
    const updatedRows: Rec[] = [];
    const next = store.rows.map((rec) => {
      if (this.cond && !this.cond.test(rec)) return rec;
      const updated: Rec = { ...rec };
      for (const [key, raw] of Object.entries(this.setValues)) {
        const col = meta.byKey.get(key);
        if (!col || raw === undefined) continue;
        const value = raw instanceof SqlExpr ? raw.evaluate(rec) : raw;
        const normalized = normalizeValue(col, value);
        if (normalized === null && col.spec.notNull) {
          throw dbError(`null value in column "${col.sqlName}" of relation "${meta.name}" violates not-null constraint`, "23502");
        }
        updated[key] = normalized;
      }
      updatedRows.push(updated);
      return updated;
    });
    // tekil kısıt kontrolü (ör. birincil anahtar değiştirilirse)
    for (const set of meta.uniques) {
      const seen = new Set<string>();
      for (const rec of next) {
        if (set.some((c) => rec[c.key] === null || rec[c.key] === undefined)) continue;
        const id = JSON.stringify(set.map((c) => (rec[c.key] instanceof Date ? rec[c.key].getTime() : rec[c.key])));
        if (seen.has(id)) throw uniqueViolation(meta, set);
        seen.add(id);
      }
    }
    if (updatedRows.length > 0) {
      store.rows = next;
      markDirty(store);
    }
    return updatedRows.map((r) => project(r, this.returningFields) as R);
  }
}

class UpdateBuilder<T extends AnyTable> {
  constructor(private readonly table: T) {}
  set(values: T["$set"]): UpdateQuery<T, T["$inferSelect"]> {
    return new UpdateQuery<T, T["$inferSelect"]>(this.table.$meta, values as Rec);
  }
}

// ---------------------------------------------------------------------------
// DELETE
// ---------------------------------------------------------------------------

class DeleteQuery<T extends AnyTable, R> extends Query<R[]> {
  private cond: Cond | undefined;
  private returningFields: SelectFields | undefined;

  constructor(private readonly meta: TableMeta) {
    super();
  }

  where(cond: Cond | undefined): this {
    this.cond = cond;
    return this;
  }

  returning(): DeleteQuery<T, T["$inferSelect"]>;
  returning<F extends SelectFields>(fields: F): DeleteQuery<T, InferFields<F>>;
  returning(fields?: SelectFields): DeleteQuery<T, never> {
    this.returningFields = fields;
    return this as unknown as DeleteQuery<T, never>;
  }

  run(): R[] {
    const store = getStore(this.meta);
    const removed: Rec[] = [];
    const kept: Rec[] = [];
    for (const rec of store.rows) {
      if (!this.cond || this.cond.test(rec)) removed.push(rec);
      else kept.push(rec);
    }
    if (removed.length > 0) {
      store.rows = kept;
      markDirty(store);
    }
    return removed.map((r) => project(r, this.returningFields) as R);
  }
}

// `db.delete(t)` doğrudan await edilirse (where'siz) tüm satırlar silinir — drizzle ile aynı.
class DeleteRoot<T extends AnyTable> extends DeleteQuery<T, T["$inferSelect"]> {
  constructor(table: T) {
    super(table.$meta);
  }
}

function dbSelect(): SelectBuilder<undefined>;
function dbSelect<F extends SelectFields>(fields: F): SelectBuilder<F>;
function dbSelect(fields?: SelectFields): SelectBuilder<SelectFields | undefined> {
  return new SelectBuilder(fields);
}

export const db = {
  select: dbSelect,
  insert<T extends AnyTable>(table: T): InsertBuilder<T> {
    return new InsertBuilder(table);
  },
  update<T extends AnyTable>(table: T): UpdateBuilder<T> {
    return new UpdateBuilder(table);
  },
  delete<T extends AnyTable>(table: T): DeleteRoot<T> {
    return new DeleteRoot(table);
  },
};
