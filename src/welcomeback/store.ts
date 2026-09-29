// src/welcomeback/store.ts
// "Tekrar hoşgeldin" sistemi: bir kullanıcı bir sunucuda belirlenen süre
// boyunca hiç mesaj/komut yazmazsa, tekrar yazdığında bot onu karşılar.
//
// Veriler SQLite'ta tutulur (db/schema.ts: discord_welcomeback_settings,
// discord_welcomeback_activity). Eskiden data/welcome-back-*.json
// dosyalarındaydı; ilk açılışta tek seferlik taşıma yapılır, eski JSON'lar
// yedek olarak yerinde durur. SQLite açılmazsa bot JSON moduna düşer ve
// aynı kod yolu data/db/*.json dosyalarıyla çalışmaya devam eder.
//
// Her mesajda DB'ye gidilmemesi için ayarlar + aktiflik bellekte tutulur;
// aktiflik yazmaları 30 sn'de bir toplu flush'lanır.

import fs from "node:fs";
import path from "node:path";
import { db } from "../db/index.js";
import { jsonStore, lt } from "../db/jsonOrm.js";
import {
  welcomebackActivityTable,
  welcomebackSettingsTable,
} from "../db/schema.js";

// ---------------------------------------------------------------------------
// Sunucu ayarları
// ---------------------------------------------------------------------------

export interface WelcomeBackGuildSettings {
  enabled: boolean;
  /** Dakika cinsinden — bu süre boyunca sessiz kalan kullanıcı "döndüğünde" karşılanır. */
  durationMinutes: number;
}

export const DEFAULT_DURATION_MINUTES = 120;
const DEFAULT_SETTINGS: WelcomeBackGuildSettings = {
  enabled: false,
  durationMinutes: DEFAULT_DURATION_MINUTES,
};

// Bellek içi önbellek: her mesajda DB sorgusu yapılmaz.
const settingsCache = new Map<string, WelcomeBackGuildSettings>();

/** Bir sunucunun tekrar hoşgeldin ayarlarını döner (hiç ayarlanmadıysa varsayılan: kapalı, 120dk). */
export function getWelcomeBackSettings(guildId: string): WelcomeBackGuildSettings {
  return settingsCache.get(guildId) ?? { ...DEFAULT_SETTINGS };
}

async function persistSettings(guildId: string, settings: WelcomeBackGuildSettings): Promise<void> {
  await db
    .insert(welcomebackSettingsTable)
    .values({
      guildId,
      enabled: settings.enabled,
      durationMinutes: settings.durationMinutes,
    })
    .onConflictDoUpdate({
      target: welcomebackSettingsTable.guildId,
      set: { enabled: settings.enabled, durationMinutes: settings.durationMinutes },
    });
}

/** Sistemi açar/kapatır. */
export async function setWelcomeBackEnabled(
  guildId: string,
  enabled: boolean,
): Promise<WelcomeBackGuildSettings> {
  const updated: WelcomeBackGuildSettings = { ...getWelcomeBackSettings(guildId), enabled };
  settingsCache.set(guildId, updated);
  await persistSettings(guildId, updated);
  return updated;
}

/** Süreyi (dakika) değiştirir. */
export async function setWelcomeBackDuration(
  guildId: string,
  durationMinutes: number,
): Promise<WelcomeBackGuildSettings> {
  const updated: WelcomeBackGuildSettings = { ...getWelcomeBackSettings(guildId), durationMinutes };
  settingsCache.set(guildId, updated);
  await persistSettings(guildId, updated);
  return updated;
}

// ---------------------------------------------------------------------------
// Kullanıcı son aktiflik zamanı
// ---------------------------------------------------------------------------

const ACTIVITY_FLUSH_INTERVAL_MS = 30_000;

// Eski JSON dosyaları — yalnızca TEK SEFERLİK taşımanın kaynağı.
const LEGACY_SETTINGS_FILE = path.resolve(process.cwd(), "data/welcome-back-settings.json");
const LEGACY_ACTIVITY_FILE = path.resolve(process.cwd(), "data/welcome-back-activity.json");

// key: `${guildId}:${userId}` -> son aktiflik (epoch ms)
const activityMap = new Map<string, number>();
// Restart sonrası DB'deki eski aktivite kaydı ilk mesajda doğrudan welcome
// tetiklemesin. Kullanıcı ilk mesajıyla yeniden aktif sayılır; sonraki sessizlik
// dönemlerinde sistem normal şekilde çalışır.
const startupGraceKeys = new Set<string>();
// flush'u bekleyen kirli anahtarlar
const dirtyActivityKeys = new Set<string>();
let activityLoaded = false;
let flushTimer: NodeJS.Timeout | null = null;
let flushInFlight: Promise<void> | null = null;

function activityKey(guildId: string, userId: string): string {
  return `${guildId}:${userId}`;
}

function splitActivityKey(key: string): { guildId: string; userId: string } | null {
  const sep = key.lastIndexOf(":");
  if (sep <= 0) return null;
  const guildId = key.slice(0, sep);
  const userId = key.slice(sep + 1);
  if (!/^\d{15,25}$/.test(guildId) || !/^\d{15,25}$/.test(userId)) return null;
  return { guildId, userId };
}

// Aktiflik kayıtları bu süreden eskiyse budanır (süresiz birikmeyi önler).
const ACTIVITY_PRUNE_AFTER_MS = 30 * 24 * 60 * 60_000;

/** Eski data/welcome-back-*.json dosyalarından SQLite'a tek seferlik taşıma. */
async function migrateLegacyIfNeeded(): Promise<void> {
  const meta = jsonStore.getMeta() as Record<string, unknown>;
  if (meta["welcomebackMigrated"]) return;

  // Ayarlar: { guildId: { enabled, durationMinutes } }
  try {
    if (fs.existsSync(LEGACY_SETTINGS_FILE)) {
      const raw = JSON.parse(fs.readFileSync(LEGACY_SETTINGS_FILE, "utf8")) as Record<string, unknown>;
      for (const [guildId, s] of Object.entries(raw ?? {})) {
        if (!/^\d{15,25}$/.test(guildId) || !s || typeof s !== "object") continue;
        const rec = s as Record<string, unknown>;
        const duration =
          typeof rec["durationMinutes"] === "number" && Number.isInteger(rec["durationMinutes"]) && (rec["durationMinutes"] as number) > 0
            ? (rec["durationMinutes"] as number)
            : DEFAULT_DURATION_MINUTES;
        await db
          .insert(welcomebackSettingsTable)
          .values({ guildId, enabled: rec["enabled"] === true, durationMinutes: duration })
          .onConflictDoNothing()
          .catch(() => null);
      }
    }
  } catch (err) {
    console.error("[tekrarhg] eski ayar taşınamadı:", err);
  }

  // Aktivite: { "guildId:userId": epochMs }
  try {
    if (fs.existsSync(LEGACY_ACTIVITY_FILE)) {
      const raw = JSON.parse(fs.readFileSync(LEGACY_ACTIVITY_FILE, "utf8")) as Record<string, unknown>;
      const cutoff = Date.now() - ACTIVITY_PRUNE_AFTER_MS;
      for (const [key, ts] of Object.entries(raw ?? {})) {
        if (typeof ts !== "number" || !Number.isFinite(ts) || ts < cutoff) continue;
        const parts = splitActivityKey(key);
        if (!parts) continue;
        await db
          .insert(welcomebackActivityTable)
          .values({ key, guildId: parts.guildId, userId: parts.userId, lastActiveAt: new Date(ts) })
          .onConflictDoNothing()
          .catch(() => null);
      }
    }
  } catch (err) {
    console.error("[tekrarhg] eski aktivite taşınamadı:", err);
  }

  jsonStore.setMeta({ welcomebackMigrated: true });
  jsonStore.flush();
  console.log("[tekrarhg] veri sqlite'a taşındı, eski json'lar yedekte");
}

async function loadFromDb(): Promise<void> {
  const cutoff = Date.now() - ACTIVITY_PRUNE_AFTER_MS;

  const settingsRows = await db.select().from(welcomebackSettingsTable);
  for (const r of settingsRows) {
    if (!/^\d{15,25}$/.test(r.guildId)) continue;
    settingsCache.set(r.guildId, {
      enabled: r.enabled === true,
      durationMinutes:
        typeof r.durationMinutes === "number" && r.durationMinutes > 0
          ? r.durationMinutes
          : DEFAULT_DURATION_MINUTES,
    });
  }

  const activityRows = await db.select().from(welcomebackActivityTable);
  for (const r of activityRows) {
    const ts = new Date(r.lastActiveAt).getTime();
    if (!Number.isFinite(ts) || ts < cutoff) continue;
    activityMap.set(r.key, ts);
    startupGraceKeys.add(r.key);
  }

  // Eski kayıtları DB'den de temizle.
  await db
    .delete(welcomebackActivityTable)
    .where(lt(welcomebackActivityTable.lastActiveAt, new Date(cutoff)))
    .catch(() => null);
}

async function flushActivityToDb(): Promise<void> {
  if (dirtyActivityKeys.size === 0) return;
  if (flushInFlight) {
    await flushInFlight.catch(() => null);
    if (dirtyActivityKeys.size === 0) return;
  }
  const run = (async () => {
    const keys = [...dirtyActivityKeys];
    dirtyActivityKeys.clear();
    const cutoff = Date.now() - ACTIVITY_PRUNE_AFTER_MS;
    try {
      for (const key of keys) {
        const ts = activityMap.get(key);
        if (ts === undefined || ts < cutoff) continue;
        const parts = splitActivityKey(key);
        if (!parts) continue;
        const at = new Date(ts);
        await db
          .insert(welcomebackActivityTable)
          .values({ key, guildId: parts.guildId, userId: parts.userId, lastActiveAt: at })
          .onConflictDoUpdate({
            target: welcomebackActivityTable.key,
            set: { lastActiveAt: at },
          });
      }
      await db
        .delete(welcomebackActivityTable)
        .where(lt(welcomebackActivityTable.lastActiveAt, new Date(cutoff)))
        .catch(() => null);
    } catch (err) {
      console.error("[tekrarhg] aktivite yazılamadı:", err);
      // Başarısız olanları bir sonraki flush'ta tekrar dene.
      for (const key of keys) dirtyActivityKeys.add(key);
    }
  })();
  flushInFlight = run;
  try {
    await run;
  } finally {
    if (flushInFlight === run) flushInFlight = null;
  }
}

/** Kullanıcının aktiflik zamanını "şimdi" olarak günceller; DB yazması
 *  30 sn'lik periyodik flush'ta topluca yapılır. */
export function touchActivity(guildId: string, userId: string, now: number = Date.now()): void {
  const key = activityKey(guildId, userId);
  activityMap.set(key, now);
  dirtyActivityKeys.add(key);
}

/** Uygulama başlangıcında bir kere çağrılır; DB'deki veriyi belleğe yükler. */
export async function ensureWelcomeBackActivityLoaded(): Promise<void> {
  if (activityLoaded) return;
  activityLoaded = true;
  try {
    await migrateLegacyIfNeeded();
    await loadFromDb();
  } catch (err) {
    console.error("[tekrarhg] db yüklenmedi, boş başlıyorum:", err);
  }
  if (!flushTimer) {
    flushTimer = setInterval(() => {
      void flushActivityToDb();
    }, ACTIVITY_FLUSH_INTERVAL_MS);
    flushTimer.unref?.();
  }
}

/** Kullanıcının bu sunucudaki son aktiflik zamanını döner (hiç kaydı yoksa null). */
export function getLastActivity(guildId: string, userId: string): number | null {
  return activityMap.get(activityKey(guildId, userId)) ?? null;
}

/** Restart sonrası yüklenen kaydın ilk mesajda yanlış welcome üretmesini engeller. */
export function consumeWelcomeBackStartupGrace(guildId: string, userId: string): boolean {
  const key = activityKey(guildId, userId);
  const hadGrace = startupGraceKeys.has(key);
  startupGraceKeys.delete(key);
  return hadGrace;
}

/** Process kapanırken (ör. !restart) bekleyen aktiflik verisini hemen DB'ye yazar. */
export async function flushWelcomeBackActivityNow(): Promise<void> {
  await flushActivityToDb();
}
