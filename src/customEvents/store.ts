import fs from "node:fs";
import path from "node:path";
import { db, customCommandsTable, type CustomCommandRow } from "../db/index.js";
import { and, asc, count, eq } from "../db/jsonOrm.js";
import { validateCustomEventCode } from "./engine.js";

export const MAX_CUSTOM_EVENTS_PER_GUILD = 10;

// Discord komutlarıyla çakışmaması ve kötüye kullanılmasını zorlaştırması için
// isimler bilinçli olarak sınırlı tutulur.
export const NAME_REGEX = /^[a-z][a-z0-9_-]{1,19}$/;

export interface CustomEventRestrictions {
  allowedRoleIds: string[];
  deniedRoleIds: string[];
  allowedChannelIds: string[];
  deniedChannelIds: string[];
  requiredPermission: string | null;
}

export interface CustomEvent {
  guildId: string;
  name: string;
  code: string;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  enabled: boolean;
  restrictions: CustomEventRestrictions;
}

interface EventConfig {
  code: string;
  enabled?: boolean;
  restrictions?: Partial<CustomEventRestrictions>;
}

// Kayıtlar data/db/discord_custom_commands.json içinde tutulur (bkz. db/schema.ts).
const EVENT_TYPE = "safe-template-v2";
const typeIs = () => eq(customCommandsTable.type, EVENT_TYPE);

const DEFAULT_RESTRICTIONS: CustomEventRestrictions = {
  allowedRoleIds: [],
  deniedRoleIds: [],
  allowedChannelIds: [],
  deniedChannelIds: [],
  requiredPermission: null,
};
const SAFE_PERMISSION_NAMES = new Set(["ManageMessages", "ManageRoles", "ModerateMembers", "Administrator"]);

function normalizeRestrictions(value: EventConfig["restrictions"]): CustomEventRestrictions {
  const source = value ?? {};
  const ids = (input: unknown): string[] =>
    Array.isArray(input)
      ? [...new Set(input.filter((item): item is string => typeof item === "string" && /^\d{15,25}$/.test(item)))]
      : [];

  const requiredPermission =
    typeof source.requiredPermission === "string" && SAFE_PERMISSION_NAMES.has(source.requiredPermission)
      ? source.requiredPermission
      : null;

  return {
    allowedRoleIds: ids(source.allowedRoleIds),
    deniedRoleIds: ids(source.deniedRoleIds),
    allowedChannelIds: ids(source.allowedChannelIds),
    deniedChannelIds: ids(source.deniedChannelIds),
    requiredPermission,
  };
}

function toCustomEvent(row: CustomCommandRow): CustomEvent {
  const config: EventConfig =
    row.config && typeof row.config === "object" ? (row.config as EventConfig) : { code: "" };
  return {
    guildId: row.guildId,
    name: row.name,
    code: typeof config.code === "string" ? config.code : "",
    createdBy: row.createdBy,
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt),
    enabled: config.enabled !== false,
    restrictions: normalizeRestrictions(config.restrictions),
  };
}

function emptyConfig(code: string): EventConfig {
  return { code, enabled: true, restrictions: { ...DEFAULT_RESTRICTIONS } };
}

let legacyMigrationPromise: Promise<void> | null = null;

/**
 * Eski sürümdeki data/custom-events.json dosyasını depoya bir kez taşır. Taşıma başarısız olursa
 * botun açılışını bozmaz; sonraki açılışta tekrar denenir.
 */
export function migrateLegacyCustomEvents(): Promise<void> {
  if (!legacyMigrationPromise) legacyMigrationPromise = doLegacyMigration();
  return legacyMigrationPromise;
}

async function doLegacyMigration(): Promise<void> {
  const legacyFile = path.resolve(process.cwd(), "data/custom-events.json");
  if (!fs.existsSync(legacyFile)) return;

  try {
    const raw = JSON.parse(fs.readFileSync(legacyFile, "utf8")) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;

    for (const [guildId, events] of Object.entries(raw)) {
      if (!/^\d{15,25}$/.test(guildId) || !Array.isArray(events)) continue;
      for (const event of events.slice(0, MAX_CUSTOM_EVENTS_PER_GUILD)) {
        if (
          !event ||
          typeof event !== "object" ||
          typeof (event as { name?: unknown }).name !== "string" ||
          typeof (event as { code?: unknown }).code !== "string" ||
          typeof (event as { createdBy?: unknown }).createdBy !== "string"
        ) {
          continue;
        }
        const item = event as { name: string; code: string; createdBy: string; createdAt?: string };
        const name = item.name.toLowerCase().trim();
        if (!NAME_REGEX.test(name) || validateCustomEventCode(item.code)) continue;

        await db
          .insert(customCommandsTable)
          .values({
            guildId,
            name,
            description: "Güvenli YAGPDB uyumlu custom event",
            type: EVENT_TYPE,
            config: emptyConfig(item.code),
            createdBy: item.createdBy,
            createdAt: item.createdAt && !Number.isNaN(Date.parse(item.createdAt)) ? new Date(item.createdAt) : new Date(),
            updatedAt: new Date(),
          })
          .onConflictDoNothing();
      }
    }

    const backup = `${legacyFile}.migrated`;
    fs.renameSync(legacyFile, backup);
    console.log("[customevent] eski json'lar db'ye taşındı");
  } catch (err) {
    legacyMigrationPromise = null;
    console.error("[customevent] eski json taşınamadı:", err);
  }
}

/** Senkron okuma: (sunucu, isim) için custom event satırı. */
function findRow(guildId: string, name: string): CustomCommandRow | undefined {
  return db
    .select()
    .from(customCommandsTable)
    .where(and(eq(customCommandsTable.guildId, guildId), eq(customCommandsTable.name, name), typeIs()))
    .limit(1)
    .run()[0];
}

export async function listCustomEvents(guildId: string): Promise<CustomEvent[]> {
  const rows = db
    .select()
    .from(customCommandsTable)
    .where(and(eq(customCommandsTable.guildId, guildId), typeIs()))
    .orderBy(asc(customCommandsTable.createdAt))
    .run();
  return rows.map(toCustomEvent);
}

export async function getCustomEvent(guildId: string, name: string): Promise<CustomEvent | null> {
  const row = findRow(guildId, name.toLowerCase().trim());
  return row ? toCustomEvent(row) : null;
}

// index.ts, statik komut isimleri hazır olunca doldurur.
let reservedNames = new Set<string>();
export function setReservedCommandNames(names: Iterable<string>): void {
  reservedNames = new Set(names);
}

export type CreateResult = { ok: true; event: CustomEvent } | { ok: false; error: string };

export async function createCustomEvent(
  guildId: string,
  name: string,
  code: string,
  authorId: string,
): Promise<CreateResult> {
  const normalizedName = name.toLowerCase().trim();
  if (!NAME_REGEX.test(normalizedName)) {
    return { ok: false, error: "İsim 2-20 karakter olmalı, sadece küçük harf/rakam/`-`/`_` içerebilir ve harfle başlamalı." };
  }
  if (reservedNames.has(normalizedName)) {
    return { ok: false, error: `\`${normalizedName}\` botun kendi komutlarından biri, başka bir isim seç.` };
  }

  const codeError = validateCustomEventCode(code);
  if (codeError) return { ok: false, error: codeError };

  // Depo bellekte ve senkron çalıştığı için aşağıdaki kontrol + kayıt adımları
  // (await olmadan, .run() ile) arasına başka bir istek giremez — aynı sunucuda
  // eşzamanlı iki create isteği limiti aşamaz.
  const existingRow = findRow(guildId, normalizedName);
  const existing = existingRow ? toCustomEvent(existingRow) : null;

  if (!existing) {
    const [{ value: total }] = db
      .select({ value: count() })
      .from(customCommandsTable)
      .where(and(eq(customCommandsTable.guildId, guildId), typeIs()))
      .run();
    if (Number(total ?? 0) >= MAX_CUSTOM_EVENTS_PER_GUILD) {
      return {
        ok: false,
        error: `Bu sunucuda en fazla ${MAX_CUSTOM_EVENTS_PER_GUILD} custom event olabilir. Önce \`custom-sil\` ile birini silmelisin.`,
      };
    }
  }

  const config: EventConfig = {
    code,
    enabled: existing?.enabled ?? true,
    restrictions: existing?.restrictions ?? DEFAULT_RESTRICTIONS,
  };
  const description = "Güvenli YAGPDB uyumlu custom event";
  const [saved] = db
    .insert(customCommandsTable)
    .values({
      guildId,
      name: normalizedName,
      description,
      type: EVENT_TYPE,
      config,
      createdBy: existing?.createdBy ?? authorId,
      createdAt: existing?.createdAt ?? new Date(),
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [customCommandsTable.guildId, customCommandsTable.name],
      set: { config, description, type: EVENT_TYPE, updatedAt: new Date() },
    })
    .returning()
    .run();
  return { ok: true, event: toCustomEvent(saved) };
}

export async function updateCustomEventSettings(
  guildId: string,
  name: string,
  patch: Partial<CustomEventRestrictions> & { enabled?: boolean },
): Promise<CustomEvent | null> {
  const normalizedName = name.toLowerCase().trim();
  const row = findRow(guildId, normalizedName);
  if (!row) return null;
  const event = toCustomEvent(row);

  const restrictions = normalizeRestrictions({
    ...event.restrictions,
    ...patch,
  });
  const enabled = patch.enabled ?? event.enabled;
  const [updated] = db
    .update(customCommandsTable)
    .set({ config: { code: event.code, enabled, restrictions }, updatedAt: new Date() })
    .where(and(eq(customCommandsTable.guildId, guildId), eq(customCommandsTable.name, normalizedName), typeIs()))
    .returning()
    .run();
  return updated ? toCustomEvent(updated) : null;
}

export async function deleteCustomEvent(guildId: string, name: string): Promise<boolean> {
  const removed = db
    .delete(customCommandsTable)
    .where(
      and(
        eq(customCommandsTable.guildId, guildId),
        eq(customCommandsTable.name, name.toLowerCase().trim()),
        typeIs(),
      ),
    )
    .run();
  return removed.length > 0;
}
