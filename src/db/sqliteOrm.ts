// src/db/sqliteOrm.ts
// ---------------------------------------------------------------------------
// SQLite backend — jsonOrm.ts'teki drizzle-uyumlu API'nin birebir aynısını
// `better-sqlite3` paketiyle gerçekleştirir (stabil, senkron; deneysel
// `node:sqlite` yerine).
//
//   - Tablo/kolon tanımları jsonOrm'daki kayıtlı şemadan (getRegisteredTables)
//     otomatik üretilir; DDL elle yazılmaz.
//   - Değer yazımı jsonOrm.normalizeValue ile yapılır: NOT NULL / default /
//     tip kontrolleri JSON modundakiyle BİREBİR aynıdır.
//   - Tipler: text→TEXT, integer/serial→INTEGER (serial: AUTOINCREMENT),
//     boolean→INTEGER(0/1), timestamp→INTEGER(epoch ms), jsonb→TEXT(JSON).
//   - better-sqlite3 SENKRONdur; `.run()` ve thenable davranışı jsonOrm ile aynı.
//   - better-sqlite3 yüklenemezse tryCreateSqliteDb() null döner ve
//     db/index.ts sessizce JSON moduna geri döner — bot asla çökmez.
// ---------------------------------------------------------------------------

import fs from "node:fs";
import path from "node:path";
import {
  AggCount,
  Column,
  SqlExpr,
  asc,
  cloneValue,
  db as jsonDb,
  dbError,
  getRegisteredTables,
  normalizeValue,
  toSqliteParam,
  type AnyTable,
  type Cond,
  type ConflictTarget,
  type InferFields,
  type Order,
  type Rec,
  type SelectFields,
  type TableMeta,
} from "./jsonOrm.js";

export interface SqliteHandle {
  exec(sql: string): void;
  prepare(sql: string): {
    all(...params: unknown[]): Record<string, unknown>[];
    get(...params: unknown[]): Record<string, unknown> | undefined;
    run(...params: unknown[]): unknown;
  };
  close(): void;
};

// ---------------------------------------------------------------------------
// Thenable taban (jsonOrm.Query ile aynı davranış)
// ---------------------------------------------------------------------------

function ident(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

// ---------------------------------------------------------------------------
// DDL üretimi
// ---------------------------------------------------------------------------

function columnDDL(col: Column): string {
  if (col.kind === "serial") return `${ident(col.sqlName)} INTEGER PRIMARY KEY AUTOINCREMENT`;
  const type = col.kind === "text" || col.kind === "jsonb" ? "TEXT" : "INTEGER";
  let ddl = `${ident(col.sqlName)} ${type}`;
  if (col.spec.primaryKey) {
    ddl += " PRIMARY KEY";
  } else {
    if (col.spec.notNull) ddl += " NOT NULL";
    if (col.spec.unique) ddl += " UNIQUE";
  }
  return ddl;
}

function tableDDL(meta: TableMeta): string {
  const parts = meta.columns.map(columnDDL);
  if (meta.compositePk.length > 0) {
    const keys = meta.compositePk.map((k) => ident(meta.byKey.get(k)!.sqlName)).join(", ");
    parts.push(`PRIMARY KEY (${keys})`);
  }
  for (const set of meta.uniques) {
    if (set.length <= 1) continue; // tekil kolon kısıtları columnDDL'de
    const isCompositePk =
      meta.compositePk.length === set.length && set.every((c) => meta.compositePk.includes(c.key));
    if (isCompositePk) continue;
    parts.push(`UNIQUE (${set.map((c) => ident(c.sqlName)).join(", ")})`);
  }
  return `CREATE TABLE IF NOT EXISTS ${ident(meta.name)} (\n  ${parts.join(",\n  ")}\n);`;
}

// ---------------------------------------------------------------------------
// Değer dönüşümleri
// ---------------------------------------------------------------------------

/** INSERT/UPDATE için: normalize edilmiş JS değeri → SQLite parametresi. */
function toSqlParam(col: Column, value: unknown): unknown {
  if (value === null || value === undefined) return null;
  switch (col.kind) {
    case "timestamp":
      return value instanceof Date ? value.getTime() : new Date(value as string).getTime();
    case "boolean":
      return value ? 1 : 0;
    case "jsonb":
      return JSON.stringify(value);
    default:
      return value;
  }
}

/** Okuma için: SQLite değeri → JS değeri (jsonOrm'un bellek içi biçimiyle aynı). */
function fromSqlValue(col: Column, value: unknown): unknown {
  if (value === null || value === undefined) return null;
  switch (col.kind) {
    case "timestamp":
      return new Date(Number(value));
    case "boolean":
      return Number(value) !== 0;
    case "jsonb":
      if (typeof value !== "string") return value;
      try {
        return JSON.parse(value);
      } catch {
        return value;
      }
    case "integer":
    case "serial":
      return Number(value);
    default:
      return value;
  }
}

function mapConstraintError(err: unknown, meta: TableMeta): Error {
  // better-sqlite3 hata mesajları SQLite'ın standart metnini taşır
  // ("UNIQUE constraint failed: t.col" gibi); kısıt türü mesajdan anlaşılır.
  const msg = err instanceof Error ? err.message : String(err);
  if (/UNIQUE constraint failed/i.test(msg)) {
    return dbError(`sqlite constraint failed on ${meta.name}: ${msg}`, "23505");
  }
  if (/NOT NULL constraint failed/i.test(msg)) {
    return dbError(`sqlite constraint failed on ${meta.name}: ${msg}`, "23502");
  }
  return err instanceof Error ? err : new Error(String(err));
}

function notNullError(col: Column): Error {
  return dbError(
    `null value in column "${col.sqlName}" of relation "${col.table}" violates not-null constraint`,
    "23502",
  );
}

// ---------------------------------------------------------------------------
// Thenable taban (jsonOrm.Query ile aynı davranış)
// ---------------------------------------------------------------------------

abstract class SQuery<T> implements PromiseLike<T> {
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
  catch<TResult = never>(
    onrejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null,
  ): Promise<T | TResult> {
    return this.then(undefined, onrejected);
  }
  finally(onfinally?: (() => void) | null): Promise<T> {
    return this.then().finally(onfinally);
  }
}

// ---------------------------------------------------------------------------
// SELECT
// ---------------------------------------------------------------------------

class SSelectQuery<R> extends SQuery<R[]> {
  private cond: Cond | undefined;
  private orders: Order[] = [];
  private max: number | undefined;

  constructor(
    private readonly dbh: SqliteHandle,
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

  private buildSQL(): { text: string; params: unknown[] } {
    const params: unknown[] = [];
    let select: string;
    if (!this.fields) {
      select = "*";
    } else {
      const parts: string[] = [];
      for (const [name, field] of Object.entries(this.fields)) {
        if (field instanceof AggCount) {
          parts.push(
            field.column
              ? `COUNT(${ident(field.column.sqlName)}) AS ${ident(name)}`
              : `COUNT(*) AS ${ident(name)}`,
          );
        } else if (field instanceof Column) {
          parts.push(`${ident(field.sqlName)} AS ${ident(name)}`);
        }
      }
      select = parts.join(", ");
    }
    let text = `SELECT ${select} FROM ${ident(this.meta.name)}`;
    if (this.cond) {
      if (!this.cond._sqlite) throw new Error("SQLite: desteklenmeyen koşul türü.");
      text += ` WHERE ${this.cond._sqlite.text}`;
      params.push(...this.cond._sqlite.params);
    }
    if (this.orders.length > 0) {
      text +=
        " ORDER BY " +
        this.orders.map((o) => `${ident(o.column.sqlName)} ${o.dir === "desc" ? "DESC" : "ASC"}`).join(", ");
    }
    if (this.max !== undefined) {
      text += " LIMIT ?";
      params.push(Math.max(0, this.max));
    }
    return { text, params };
  }

  private mapRow(sqlRow: Record<string, unknown>): Rec {
    const out: Rec = {};
    if (!this.fields) {
      for (const col of this.meta.columns) out[col.key] = fromSqlValue(col, sqlRow[col.sqlName]);
    } else {
      for (const [name, field] of Object.entries(this.fields)) {
        if (field instanceof AggCount) out[name] = Number(sqlRow[name] ?? 0);
        else if (field instanceof Column) out[name] = fromSqlValue(field, sqlRow[name]);
      }
    }
    return out;
  }

  run(): R[] {
    const { text, params } = this.buildSQL();
    const rows = this.dbh.prepare(text).all(...params);
    return rows.map((r) => this.mapRow(r) as R);
  }
}

class SSelectBuilder<F extends SelectFields | undefined> {
  constructor(
    private readonly fields: F,
    private readonly dbh: SqliteHandle,
  ) {}
  from<T extends AnyTable>(table: T): SSelectQuery<F extends SelectFields ? InferFields<F> : T["$inferSelect"]> {
    return new SSelectQuery<F extends SelectFields ? InferFields<F> : T["$inferSelect"]>(
      this.dbh,
      table.$meta,
      this.fields as SelectFields | undefined,
    );
  }
}

function sSelect(dbh: SqliteHandle): SSelectBuilder<undefined>;
function sSelect<F extends SelectFields>(dbh: SqliteHandle, fields: F): SSelectBuilder<F>;
function sSelect(dbh: SqliteHandle, fields?: SelectFields): SSelectBuilder<SelectFields | undefined> {
  return new SSelectBuilder(fields, dbh);
}

// ---------------------------------------------------------------------------
// INSERT
// ---------------------------------------------------------------------------

/** values → normalize edilmiş satır (jsonOrm.InsertQuery.run ile aynı kurallar). */
function buildInsertRec(meta: TableMeta, values: Rec): Rec {
  const rec: Rec = {};
  for (const col of meta.columns) {
    const v: unknown = values[col.key];
    if (v === undefined) {
      if (col.kind === "serial") continue; // SQLite AUTOINCREMENT atar
      if (col.spec.defaultNow) rec[col.key] = new Date();
      else if (col.spec.hasDefault && col.spec.defaultValue !== undefined)
        rec[col.key] = cloneValue(col.spec.defaultValue);
      else rec[col.key] = null;
      continue;
    }
    const value = normalizeValue(col, v);
    if (value === null && col.spec.notNull) throw notNullError(col);
    rec[col.key] = value;
  }
  return rec;
}

function buildReturning(meta: TableMeta, fields: SelectFields | undefined): string {
  if (!fields) return "RETURNING *";
  const parts: string[] = [];
  for (const [name, field] of Object.entries(fields)) {
    if (field instanceof Column) parts.push(`${ident(field.sqlName)} AS ${ident(name)}`);
  }
  return parts.length > 0 ? `RETURNING ${parts.join(", ")}` : "RETURNING *";
}

function mapReturningRow(meta: TableMeta, fields: SelectFields | undefined, sqlRow: Record<string, unknown>): Rec {
  const out: Rec = {};
  if (!fields) {
    for (const col of meta.columns) out[col.key] = fromSqlValue(col, sqlRow[col.sqlName]);
  } else {
    for (const [name, field] of Object.entries(fields)) {
      if (field instanceof Column) out[name] = fromSqlValue(field, sqlRow[name]);
      else out[name] = sqlRow[name] ?? null;
    }
  }
  return out;
}

class SInsertQuery<T extends AnyTable, R> extends SQuery<R[]> {
  private mode: "none" | "nothing" | "update" = "none";
  private target: Column[] | undefined;
  private setValues: Rec | undefined;
  private returningFields: SelectFields | undefined;

  constructor(
    private readonly dbh: SqliteHandle,
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

  returning(): SInsertQuery<T, T["$inferSelect"]>;
  returning<F extends SelectFields>(fields: F): SInsertQuery<T, InferFields<F>>;
  returning(fields?: SelectFields): SInsertQuery<T, never> {
    this.returningFields = fields;
    return this as unknown as SInsertQuery<T, never>;
  }

  private compileSet(): { text: string; params: unknown[] } {
    const parts: string[] = [];
    const params: unknown[] = [];
    for (const [key, raw] of Object.entries(this.setValues ?? {})) {
      const col = this.meta.byKey.get(key);
      if (!col || raw === undefined) continue;
      if (raw instanceof SqlExpr) {
        const s = raw.toSQLite();
        parts.push(`${ident(col.sqlName)} = ${s.text}`);
        params.push(...s.params);
      } else {
        const normalized = normalizeValue(col, raw);
        if (normalized === null && col.spec.notNull) throw notNullError(col);
        parts.push(`${ident(col.sqlName)} = ?`);
        params.push(toSqlParam(col, normalized));
      }
    }
    return { text: parts.join(", "), params };
  }

  run(): R[] {
    const meta = this.meta;
    const out: Rec[] = [];
    const returning = buildReturning(meta, this.returningFields);
    for (const values of this.valuesList) {
      const rec = buildInsertRec(meta, values);
      const cols = meta.columns.filter((c) => rec[c.key] !== undefined);
      const params: unknown[] = cols.map((c) => toSqlParam(c, rec[c.key]));
      let text =
        `INSERT INTO ${ident(meta.name)} (${cols.map((c) => ident(c.sqlName)).join(", ")}) ` +
        `VALUES (${cols.map(() => "?").join(", ")})`;
      if (this.mode === "nothing") {
        text += this.target
          ? ` ON CONFLICT (${this.target.map((c) => ident(c.sqlName)).join(", ")}) DO NOTHING`
          : " ON CONFLICT DO NOTHING";
      } else if (this.mode === "update") {
        const set = this.compileSet();
        text += ` ON CONFLICT (${this.target!.map((c) => ident(c.sqlName)).join(", ")}) DO UPDATE SET ${set.text}`;
        params.push(...set.params);
      }
      text += ` ${returning}`;
      try {
        const row = this.dbh.prepare(text).get(...params);
        // DO NOTHING çakışması → satır yok (undefined); jsonOrm da out'a eklemez.
        if (row) out.push(mapReturningRow(meta, this.returningFields, row));
      } catch (err) {
        throw mapConstraintError(err, meta);
      }
    }
    return out as R[];
  }
}

class SInsertBuilder<T extends AnyTable> {
  constructor(
    private readonly table: T,
    private readonly dbh: SqliteHandle,
  ) {}
  values(values: T["$inferInsert"] | T["$inferInsert"][]): SInsertQuery<T, T["$inferSelect"]> {
    const list = (Array.isArray(values) ? values : [values]) as Rec[];
    return new SInsertQuery<T, T["$inferSelect"]>(this.dbh, this.table.$meta, list);
  }
}

// ---------------------------------------------------------------------------
// UPDATE
// ---------------------------------------------------------------------------

class SUpdateQuery<T extends AnyTable, R> extends SQuery<R[]> {
  private cond: Cond | undefined;
  private returningFields: SelectFields | undefined;

  constructor(
    private readonly dbh: SqliteHandle,
    private readonly meta: TableMeta,
    private readonly setValues: Rec,
  ) {
    super();
  }

  where(cond: Cond | undefined): this {
    this.cond = cond;
    return this;
  }

  returning(): SUpdateQuery<T, T["$inferSelect"]>;
  returning<F extends SelectFields>(fields: F): SUpdateQuery<T, InferFields<F>>;
  returning(fields?: SelectFields): SUpdateQuery<T, never> {
    this.returningFields = fields;
    return this as unknown as SUpdateQuery<T, never>;
  }

  run(): R[] {
    const meta = this.meta;
    const parts: string[] = [];
    const params: unknown[] = [];
    for (const [key, raw] of Object.entries(this.setValues)) {
      const col = meta.byKey.get(key);
      if (!col || raw === undefined) continue;
      if (raw instanceof SqlExpr) {
        const s = raw.toSQLite();
        parts.push(`${ident(col.sqlName)} = ${s.text}`);
        params.push(...s.params);
      } else {
        const normalized = normalizeValue(col, raw);
        if (normalized === null && col.spec.notNull) throw notNullError(col);
        parts.push(`${ident(col.sqlName)} = ?`);
        params.push(toSqlParam(col, normalized));
      }
    }
    // Boş set: jsonOrm eşleşen satırları aynen döner — burada SELECT ile aynı.
    if (parts.length === 0) {
      const q = new SSelectQuery<Rec>(this.dbh, meta, undefined);
      if (this.cond) q.where(this.cond);
      return q.run() as R[];
    }
    let text = `UPDATE ${ident(meta.name)} SET ${parts.join(", ")}`;
    if (this.cond) {
      if (!this.cond._sqlite) throw new Error("SQLite: desteklenmeyen koşul türü.");
      text += ` WHERE ${this.cond._sqlite.text}`;
      params.push(...this.cond._sqlite.params);
    }
    text += ` ${buildReturning(meta, this.returningFields)}`;
    try {
      const rows = this.dbh.prepare(text).all(...params);
      return rows.map((r) => mapReturningRow(meta, this.returningFields, r) as R);
    } catch (err) {
      throw mapConstraintError(err, meta);
    }
  }
}

class SUpdateBuilder<T extends AnyTable> {
  constructor(
    private readonly table: T,
    private readonly dbh: SqliteHandle,
  ) {}
  set(values: T["$set"]): SUpdateQuery<T, T["$inferSelect"]> {
    return new SUpdateQuery<T, T["$inferSelect"]>(this.dbh, this.table.$meta, values as Rec);
  }
}

// ---------------------------------------------------------------------------
// DELETE
// ---------------------------------------------------------------------------

class SDeleteQuery<T extends AnyTable, R> extends SQuery<R[]> {
  private cond: Cond | undefined;
  private returningFields: SelectFields | undefined;

  constructor(
    private readonly dbh: SqliteHandle,
    private readonly meta: TableMeta,
  ) {
    super();
  }

  where(cond: Cond | undefined): this {
    this.cond = cond;
    return this;
  }

  returning(): SDeleteQuery<T, T["$inferSelect"]>;
  returning<F extends SelectFields>(fields: F): SDeleteQuery<T, InferFields<F>>;
  returning(fields?: SelectFields): SDeleteQuery<T, never> {
    this.returningFields = fields;
    return this as unknown as SDeleteQuery<T, never>;
  }

  run(): R[] {
    const meta = this.meta;
    const params: unknown[] = [];
    let text = `DELETE FROM ${ident(meta.name)}`;
    if (this.cond) {
      if (!this.cond._sqlite) throw new Error("SQLite: desteklenmeyen koşul türü.");
      text += ` WHERE ${this.cond._sqlite.text}`;
      params.push(...this.cond._sqlite.params);
    }
    text += ` ${buildReturning(meta, this.returningFields)}`;
    const rows = this.dbh.prepare(text).all(...params);
    return rows.map((r) => mapReturningRow(meta, this.returningFields, r) as R);
  }
}

class SDeleteRoot<T extends AnyTable> extends SDeleteQuery<T, T["$inferSelect"]> {
  constructor(
    table: T,
    dbh: SqliteHandle,
  ) {
    super(dbh, table.$meta);
  }
}

// ---------------------------------------------------------------------------
// Kurulum
// ---------------------------------------------------------------------------

export interface SqliteBackend {
  db: typeof jsonDb;
  handle: SqliteHandle;
  close(): void;
}

/**
 * SQLite backend'ini kurmayı dener. better-sqlite3 yoksa veya dosya
 * açılamazsa null döner — çağıran (db/index.ts) JSON moduna geri döner.
 */
export async function tryCreateSqliteDb(): Promise<SqliteBackend | null> {
  let Database: new (path?: string) => SqliteHandle;
  try {
    // Statik import yok: paket kurulu değilse yükleme anında çökmesin diye.
    const mod = (await import("better-sqlite3")) as unknown as {
      default?: new (path?: string) => SqliteHandle;
    };
    Database =
      mod.default ??
      (mod as unknown as new (path?: string) => SqliteHandle);
  } catch {
    return null;
  }
  try {
    const dir = path.resolve(process.cwd(), "data/db");
    fs.mkdirSync(dir, { recursive: true });
    const handle = new Database(path.join(dir, "bot.sqlite"));
    for (const meta of getRegisteredTables()) {
      handle.exec(tableDDL(meta));
    }
    const dbh: SqliteHandle = handle;
    function select(): SSelectBuilder<undefined>;
    function select<F extends SelectFields>(fields: F): SSelectBuilder<F>;
    function select(fields?: SelectFields): SSelectBuilder<SelectFields | undefined> {
      return (fields ? sSelect(dbh, fields) : sSelect(dbh)) as SSelectBuilder<SelectFields | undefined>;
    }
    const db = {
      select,
      insert<T extends AnyTable>(table: T): SInsertBuilder<T> {
        return new SInsertBuilder(table, dbh);
      },
      update<T extends AnyTable>(table: T): SUpdateBuilder<T> {
        return new SUpdateBuilder(table, dbh);
      },
      delete<T extends AnyTable>(table: T): SDeleteRoot<T> {
        return new SDeleteRoot(table, dbh);
      },
    } as unknown as typeof jsonDb;
    return { db, handle, close: () => handle.close() };
  } catch (err) {
    console.error("sqlite açılmadı, json'a dönüyorum:", err);
    return null;
  }
}

/**
 * Tek seferlik toplu aktarım (jsonToSqlite.ts kullanır). Satırlar zaten
 * normalize edilmiş Rec'lerdir; serial dahil tüm kolonlar aynen yazılır.
 *
 * Çakışan satırlar (aynı PK/unique) atlanır ve SAYILIR — tek bir bozuk satır
 * yüzünden botun açılmaması engellenir. jsonOrm ile yazılmış dosyalarda
 * çakışma zaten olamaz (bellekte zorunlu); atlama yalnızca elle düzenlenmiş
 * dosyalarda devreye girer.
 */
export function bulkInsertRecs(
  handle: SqliteHandle,
  meta: TableMeta,
  recs: Rec[],
): { inserted: number; skipped: number } {
  if (recs.length === 0) return { inserted: 0, skipped: 0 };
  const cols = meta.columns;
  const text =
    `INSERT INTO ${ident(meta.name)} (${cols.map((c) => ident(c.sqlName)).join(", ")}) ` +
    `VALUES (${cols.map(() => "?").join(", ")}) ON CONFLICT DO NOTHING`;
  const stmt = handle.prepare(text);
  let inserted = 0;
  let skipped = 0;
  handle.exec("BEGIN");
  try {
    for (const rec of recs) {
      const res = stmt.run(...cols.map((c) => toSqlParam(c, rec[c.key]))) as {
        changes?: number | bigint;
      };
      if (Number(res?.changes ?? 0) > 0) inserted++;
      else skipped++;
    }
    handle.exec("COMMIT");
  } catch (err) {
    try {
      handle.exec("ROLLBACK");
    } catch {
      // yoksay
    }
    throw mapConstraintError(err, meta);
  }
  return { inserted, skipped };
}
