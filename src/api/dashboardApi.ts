import { v2Payload } from "../utils/messages.js";
import { V2CardBuilder } from "../utils/componentsV2.js";
// src/api/dashboardApi.ts
// ---------------------------------------------------------------------------
// Dashboard HTTP API — Bearer-token korumalı yönetim uçları.
// SIFIR BAĞIMLILIK: sadece Node'un dahili `http` modülü kullanılır
// (`npm install` gerekmez).
//
// Botun ana sürecinde (aynı process) çalışır, bu yüzden botun kendi store
// fonksiyonlarını doğrudan kullanır. Ayrı bir process'te ÇALIŞTIRMAYIN:
// bot veriyi bellekte tutup aralıklı diske yazar, ayrı process stale veri
// görür ve yazıları ezebilir.
//
// Entegrasyon (src/index.ts): veritabanı hazır olduktan SONRA, örneğin
// "✅ Veritabanı ve kalıcı bot durumu hazır." logundan sonra:
//
//   import { startDashboardApi } from "./api/dashboardApi.js";
//   ...
//   await startDashboardApi();
//
// Gerekli .env değişkenleri:
//   DASHBOARD_API_TOKEN  (zorunlu — yoksa API dinlemez; üret: openssl rand -base64 48)
//   DASHBOARD_API_PORT   (opsiyonel, varsayılan 3001)
// ---------------------------------------------------------------------------
import crypto from "node:crypto";
import http from "node:http";
import { type Client, type TextChannel } from "discord.js";

import { db, warningsTable, premiumUsersTable, customCommandsTable, userPermissionsTable } from "../db/index.js";
import { and, asc, count, desc, eq, lt } from "../db/jsonOrm.js";
import { getGuildPrefix, setGuildPrefix } from "../events/messageCreate.js";
import { getGuildConfig, updateGuildConfig } from "../automod/store.js";
import type { GuildAutomodConfig } from "../automod/store.js";
import { getGuildWelcomeConfig, updateGuildWelcomeConfig } from "../welcome/store.js";
import type { GuildWelcomeConfig } from "../welcome/store.js";
import {
  createCustomEvent,
  deleteCustomEvent,
  getCustomEvent,
  listCustomEvents,
  updateCustomEventSettings,
} from "../customEvents/store.js";
import { validateCustomEventCode } from "../customEvents/engine.js";
import {
  getAllPremiumUsers,
  grantPremium,
  revokePremium,
} from "../premium/store.js";
import { getGuardConfig, updateGuardConfig } from "../utils/guard.js";
import type { GuardConfig } from "../utils/guard.js";
import { getAllLogChannels, setLogChannel, LOG_CATEGORIES } from "../utils/logger.js";
import type { LogCategory } from "../utils/logger.js";
import {
  getAllChannelSettings,
  setChannelSetting,
  CHANNEL_SETTINGS,
} from "../utils/channelSettings.js";
import type { ChannelSettingId } from "../utils/channelSettings.js";
import {
  getWelcomeBackSettings,
  setWelcomeBackDuration,
  setWelcomeBackEnabled,
} from "../welcomeback/store.js";
import { invalidatePermissionCache } from "../utils/permissions.js";
import { commandList } from "../commands/registry.js";
import {
  getStatus as getWordChainStatus,
  setWordChainChannel,
  removeWordChainChannel,
  getGuildWordScores,
} from "../utils/wordchain.js";
import { getQuizLeaderboard } from "../utils/quizStore.js";
import {
  ensureMentionAiLoaded,
  isMentionAiEnabled,
  getMentionAiChannel,
  setMentionAiEnabled,
  setMentionAiChannel,
} from "../utils/mentionai.js";

// ---------------------------------------------------------------------------
// Doğrulama sabitleri
// ---------------------------------------------------------------------------
const SNOWFLAKE_RE = /^\d{15,25}$/;
const EVENT_NAME_RE = /^[a-z][a-z0-9_-]{1,19}$/;
const CUSTOM_EVENT_TYPE = "safe-template-v2";

// !izin komutundaki yetki listesiyle birebir aynı olmalı.
const IZIN_PERMISSIONS = [
  "ban",
  "kick",
  "mute",
  "unmute",
  "unban",
  "warn",
  "uyarilar",
  "say",
  "duyuru",
] as const;

const MAX_MESSAGE_LENGTH = 2000;
const MAX_URL_LENGTH = 500;
const MAX_LIST_ITEMS = 500;
const MAX_LIST_ITEM_LENGTH = 128;
const MIN_TIMEOUT_MINUTES = 0;
const MAX_TIMEOUT_MINUTES = 10_080;
const MIN_STRIKES = 1;
const MAX_STRIKES = 20;
const MAX_BODY_BYTES = 256 * 1024;

// ---------------------------------------------------------------------------
// Hata + yardımcılar
// ---------------------------------------------------------------------------
class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function sendJson(res: http.ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toIso(value: Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > MAX_BODY_BYTES) throw new ApiError(413, "Gövde çok büyük (en fazla 256KB).");
    chunks.push(buf);
  }
  if (chunks.length === 0) return undefined;
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError(400, "Geçersiz JSON gövdesi.");
  }
}

// --- Auth (Bearer token, timing-safe karşılaştırma) --------------------------
function checkAuth(req: http.IncomingMessage, expectedToken: string): void {
  const header = req.headers["authorization"];
  if (typeof header !== "string" || !header.startsWith("Bearer ")) {
    throw new ApiError(401, "Yetkisiz: Authorization: Bearer <token> başlığı gerekli.");
  }
  const provided = Buffer.from(header.slice("Bearer ".length).trim(), "utf8");
  const expected = Buffer.from(expectedToken, "utf8");
  const ok =
    provided.length === expected.length && crypto.timingSafeEqual(provided, expected);
  if (!ok) throw new ApiError(401, "Yetkisiz: geçersiz token.");
}

// --- Validasyon yardımcıları (hatada ApiError fırlatır) -----------------------
function needSnowflake(value: string, label: string): string {
  if (!SNOWFLAKE_RE.test(value)) {
    throw new ApiError(400, `${label} geçersiz (15-25 haneli Discord ID olmalı).`);
  }
  return value;
}

function needBodyObject(body: unknown): Record<string, unknown> {
  if (!isRecord(body)) throw new ApiError(400, "Gövde JSON nesnesi olmalı.");
  return body;
}

function optBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new ApiError(400, `"${field}" alanı boolean olmalı.`);
  return value;
}

function reqBoolean(value: unknown, field: string): boolean {
  const v = optBoolean(value, field);
  if (v === undefined) throw new ApiError(400, `"${field}" alanı zorunlu ve boolean olmalı.`);
  return v;
}

function optBoundedInt(
  value: unknown,
  field: string,
  min: number,
  max: number,
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new ApiError(400, `"${field}" alanı ${min}-${max} aralığında tam sayı olmalı.`);
  }
  return value;
}

function optNullableString(
  value: unknown,
  field: string,
  maxLength: number,
  pattern?: RegExp,
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") throw new ApiError(400, `"${field}" alanı metin olmalı.`);
  if (value.length > maxLength) {
    throw new ApiError(400, `"${field}" alanı en fazla ${maxLength} karakter olabilir.`);
  }
  if (pattern && !pattern.test(value)) {
    throw new ApiError(400, `"${field}" alanı geçersiz formatta.`);
  }
  return value;
}

/**
 * Otomodun dizi alanları (wordList vb.): dizi VEYA JSON-string olarak
 * gelebilir. JSON-string gelirse parse edilip dizi hâline getirilir;
 * içerik aynen korunur, botun store'u normalizasyonu yapar.
 */
function optStringList(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  let arr: unknown = value;
  if (typeof value === "string") {
    try {
      arr = JSON.parse(value);
    } catch {
      throw new ApiError(400, `"${field}" alanı geçerli bir JSON dizisi olmalı.`);
    }
  }
  if (!Array.isArray(arr)) throw new ApiError(400, `"${field}" alanı dizi olmalı.`);
  const cleaned: string[] = [];
  for (const item of arr) {
    if (typeof item !== "string") {
      throw new ApiError(400, `"${field}" alanındaki tüm öğeler metin olmalı.`);
    }
    const trimmed = item.trim().slice(0, MAX_LIST_ITEM_LENGTH);
    if (trimmed) cleaned.push(trimmed);
    if (cleaned.length >= MAX_LIST_ITEMS) break;
  }
  return cleaned;
}

/**
 * Custom event kısıt listeleri: Discord ID dizisi (boş dizi = kısıt yok).
 */
function optSnowflakeList(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new ApiError(400, `"${field}" alanı dizi olmalı.`);
  const cleaned: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !SNOWFLAKE_RE.test(item)) {
      throw new ApiError(400, `"${field}" alanındaki tüm ID'ler geçerli Discord ID olmalı.`);
    }
    if (!cleaned.includes(item)) cleaned.push(item);
    if (cleaned.length >= 50) break;
  }
  return cleaned;
}

const EVENT_PERMISSIONS = new Set([
  "ManageMessages",
  "ManageRoles",
  "ModerateMembers",
  "Administrator",
]);

// ---------------------------------------------------------------------------
// Route işleyiciler
// ---------------------------------------------------------------------------
type Ctx = {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  seg: string[];
  body: unknown;
};

function toPublicEvent(e: {
  name: string;
  enabled: boolean;
  createdBy: string;
  createdAt: Date;
  code: string;
  restrictions: {
    allowedRoleIds: string[];
    deniedRoleIds: string[];
    allowedChannelIds: string[];
    deniedChannelIds: string[];
    requiredPermission: string | null;
  };
}) {
  return {
    name: e.name,
    enabled: e.enabled,
    createdBy: e.createdBy,
    createdAt: toIso(e.createdAt),
    code: e.code,
    restrictions: {
      allowedRoleIds: e.restrictions.allowedRoleIds,
      deniedRoleIds: e.restrictions.deniedRoleIds,
      allowedChannelIds: e.restrictions.allowedChannelIds,
      deniedChannelIds: e.restrictions.deniedChannelIds,
      requiredPermission: e.restrictions.requiredPermission,
    },
  };
}

async function handleSettings(ctx: Ctx): Promise<void> {
  const guildId = needSnowflake(ctx.seg[2] ?? "", "guildId");
  if (ctx.req.method === "GET") {
    sendJson(ctx.res, 200, { prefix: await getGuildPrefix(guildId) });
    return;
  }
  const b = needBodyObject(ctx.body);
  const prefix = b.prefix;
  if (typeof prefix !== "string" || prefix.length < 1 || prefix.length > 5 || /\s/.test(prefix)) {
    throw new ApiError(400, "prefix 1-5 karakter olmalı ve boşluk içeremez.");
  }
  try {
    await setGuildPrefix(guildId, prefix);
  } catch (err) {
    throw new ApiError(500, err instanceof Error && err.message ? err.message : "Prefix kaydedilemedi.");
  }
  sendJson(ctx.res, 200, { prefix });
}

async function handleAutomod(ctx: Ctx): Promise<void> {
  const guildId = needSnowflake(ctx.seg[2] ?? "", "guildId");
  if (ctx.req.method === "GET") {
    sendJson(ctx.res, 200, await getGuildConfig(guildId));
    return;
  }
  const b = needBodyObject(ctx.body);
  const patch: Partial<GuildAutomodConfig> = {};

  for (const key of ["enabled", "bannedWords", "inviteLinks", "spamFlood", "capsLock"] as const) {
    const v = optBoolean(b[key], key);
    if (v !== undefined) patch[key] = v;
  }

  const strikes = optBoundedInt(b.strikesBeforeTimeout, "strikesBeforeTimeout", MIN_STRIKES, MAX_STRIKES);
  if (strikes !== undefined) patch.strikesBeforeTimeout = strikes;

  for (const key of ["baseTimeoutMinutes", "maxTimeoutMinutes", "strikeResetMinutes"] as const) {
    const v = optBoundedInt(b[key], key, MIN_TIMEOUT_MINUTES, MAX_TIMEOUT_MINUTES);
    if (v !== undefined) patch[key] = v;
  }

  for (const key of ["wordList", "removedDefaults", "inviteAllowedChannelIds", "exemptRoleIds"] as const) {
    const v = optStringList(b[key], key);
    if (v !== undefined) patch[key] = v;
  }

  if (b.logChannelId !== undefined) {
    patch.logChannelId = optNullableString(b.logChannelId, "logChannelId", 32, SNOWFLAKE_RE) ?? null;
  }

  sendJson(ctx.res, 200, await updateGuildConfig(guildId, patch));
}

async function handleWelcome(ctx: Ctx): Promise<void> {
  const guildId = needSnowflake(ctx.seg[2] ?? "", "guildId");
  if (ctx.req.method === "GET") {
    sendJson(ctx.res, 200, await getGuildWelcomeConfig(guildId));
    return;
  }
  const b = needBodyObject(ctx.body);
  const patch: Partial<GuildWelcomeConfig> = {};

  const enabled = optBoolean(b.enabled, "enabled");
  if (enabled !== undefined) patch.enabled = enabled;

  if (b.channelId !== undefined) {
    patch.channelId = optNullableString(b.channelId, "channelId", 32, SNOWFLAKE_RE) ?? null;
  }
  for (const key of ["message", "leaveMessage"] as const) {
    if (b[key] !== undefined) {
      patch[key] = optNullableString(b[key], key, MAX_MESSAGE_LENGTH) ?? null;
    }
  }
  for (const key of ["welcomeImage", "leaveImage"] as const) {
    if (b[key] !== undefined) {
      patch[key] = optNullableString(b[key], key, MAX_URL_LENGTH) ?? null;
    }
  }

  sendJson(ctx.res, 200, await updateGuildWelcomeConfig(guildId, patch));
}

async function handleWarnings(ctx: Ctx): Promise<void> {
  const guildId = needSnowflake(ctx.seg[2] ?? "", "guildId");
  if (ctx.req.method === "GET") {
    const rows = await db
      .select()
      .from(warningsTable)
      .where(eq(warningsTable.guildId, guildId))
      .orderBy(asc(warningsTable.id));
    sendJson(
      ctx.res,
      200,
      rows.map((r) => ({
        id: r.id,
        userId: r.userId,
        reason: r.reason,
        moderatorId: r.moderatorId,
        createdAt: toIso(r.createdAt),
      })),
    );
    return;
  }
  // DELETE /warnings/:id
  const id = Number(ctx.seg[4]);
  if (!Number.isInteger(id) || id <= 0) {
    throw new ApiError(400, "Uyarı id'si pozitif tam sayı olmalı.");
  }
  const removed = await db
    .delete(warningsTable)
    .where(and(eq(warningsTable.guildId, guildId), eq(warningsTable.id, id)));
  if (removed.length === 0) throw new ApiError(404, "Uyarı bulunamadı.");
  sendJson(ctx.res, 200, { ok: true });
}

async function handleCustomEvents(ctx: Ctx): Promise<void> {
  const guildId = needSnowflake(ctx.seg[2] ?? "", "guildId");
  if (ctx.req.method === "GET" && ctx.seg.length === 4) {
    sendJson(ctx.res, 200, (await listCustomEvents(guildId)).map(toPublicEvent));
    return;
  }
  const name = (ctx.seg[4] ?? "").trim().toLowerCase();
  if (!EVENT_NAME_RE.test(name)) {
    throw new ApiError(400, "Event ismi geçersiz (küçük harfle başlamalı, 2-20 karakter: a-z, 0-9, -, _).");
  }
  if (ctx.req.method === "PATCH") {
    const b = needBodyObject(ctx.body);
    const patch: {
      enabled?: boolean;
      allowedRoleIds?: string[];
      deniedRoleIds?: string[];
      allowedChannelIds?: string[];
      deniedChannelIds?: string[];
      requiredPermission?: string | null;
    } = {};
    const enabled = optBoolean(b.enabled, "enabled");
    if (enabled !== undefined) patch.enabled = enabled;
    for (const field of [
      "allowedRoleIds",
      "deniedRoleIds",
      "allowedChannelIds",
      "deniedChannelIds",
    ] as const) {
      const list = optSnowflakeList(b[field], field);
      if (list !== undefined) patch[field] = list;
    }
    if (b.requiredPermission !== undefined) {
      const perm = b.requiredPermission;
      if (perm !== null) {
        if (typeof perm !== "string" || !EVENT_PERMISSIONS.has(perm)) {
          throw new ApiError(
            400,
            `"requiredPermission" şunlardan biri olmalı: ${[...EVENT_PERMISSIONS].join(", ")} (veya null).`,
          );
        }
        patch.requiredPermission = perm;
      } else {
        patch.requiredPermission = null;
      }
    }
    // Kod düzenleme: Discord'da aynı isimle yeniden oluşturmak kodu günceller;
    // panelde doğrudan kod alanını değiştiriyoruz.
    const rawCode = b.code;
    let newCode: string | undefined;
    if (rawCode !== undefined) {
      if (typeof rawCode !== "string" || !rawCode.trim()) {
        throw new ApiError(400, `"code" alanı boş olamaz.`);
      }
      const codeError = validateCustomEventCode(rawCode);
      if (codeError) throw new ApiError(400, codeError);
      newCode = rawCode;
    }
    const current = await getCustomEvent(guildId, name);
    if (!current) throw new ApiError(404, "Custom event bulunamadı.");
    if (newCode !== undefined && newCode !== current.code) {
      // updateCustomEventSettings kodu koruduğu için kodu ayrıca yazıyoruz.
      const merged = {
        code: newCode,
        enabled: patch.enabled ?? current.enabled,
        restrictions: {
          allowedRoleIds: patch.allowedRoleIds ?? current.restrictions.allowedRoleIds,
          deniedRoleIds: patch.deniedRoleIds ?? current.restrictions.deniedRoleIds,
          allowedChannelIds: patch.allowedChannelIds ?? current.restrictions.allowedChannelIds,
          deniedChannelIds: patch.deniedChannelIds ?? current.restrictions.deniedChannelIds,
          requiredPermission: patch.requiredPermission ?? current.restrictions.requiredPermission,
        },
      };
      await db
        .update(customCommandsTable)
        .set({ config: merged, updatedAt: new Date() })
        .where(
          and(
            eq(customCommandsTable.guildId, guildId),
            eq(customCommandsTable.name, name),
            eq(customCommandsTable.type, "safe-template-v2"),
          ),
        )
        .run();
    }
    const updated = await updateCustomEventSettings(guildId, name, patch);
    if (!updated) throw new ApiError(404, "Custom event bulunamadı.");
    const fresh = newCode !== undefined ? await getCustomEvent(guildId, name) : updated;
    if (!fresh) throw new ApiError(404, "Custom event bulunamadı.");
    sendJson(ctx.res, 200, toPublicEvent(fresh));
    return;
  }
  // DELETE
  const deleted = await deleteCustomEvent(guildId, name);
  if (!deleted) throw new ApiError(404, "Custom event bulunamadı.");
  sendJson(ctx.res, 200, { ok: true });
}

async function handleCustomEventCreate(ctx: Ctx): Promise<void> {
  const guildId = needSnowflake(ctx.seg[2] ?? "", "guildId");
  const b = needBodyObject(ctx.body);
  const name = typeof b.name === "string" ? b.name.toLowerCase().trim() : "";
  if (!EVENT_NAME_RE.test(name)) {
    throw new ApiError(
      400,
      "Event ismi geçersiz (küçük harfle başlamalı, 2-20 karakter: a-z, 0-9, -, _).",
    );
  }
  const code = typeof b.code === "string" ? b.code : "";
  if (!code.trim()) throw new ApiError(400, "Kod boş olamaz.");
  if (code.length > 5000) throw new ApiError(400, "Kod en fazla 5000 karakter olabilir.");

  const result = await createCustomEvent(guildId, name, code, "dashboard");
  if (!result.ok) throw new ApiError(400, result.error);
  sendJson(ctx.res, 201, toPublicEvent(result.event));
}

const GUARD_PUNISHMENTS = new Set(["none", "warn", "kick", "ban", "timeout"]);

async function handleGuard(ctx: Ctx): Promise<void> {
  const guildId = needSnowflake(ctx.seg[2] ?? "", "guildId");
  if (ctx.req.method === "GET") {
    sendJson(ctx.res, 200, await getGuardConfig(guildId));
    return;
  }
  const b = needBodyObject(ctx.body);
  const patch: Partial<GuardConfig> = {};
  for (const field of [
    "enabled",
    "antiRoleDelete",
    "antiChannelDelete",
    "antiBotAdd",
    "antiRaid",
    "antiMassBan",
    "antiMassKick",
    "antiPermissionEscalation",
    "raidAutoKick",
    "restoreDeletedChannels",
  ] as const) {
    const v = optBoolean(b[field], field);
    if (v !== undefined) patch[field] = v;
  }
  const thresholds: [string, number, number][] = [
    ["roleDeleteThreshold", 1, 25],
    ["channelDeleteThreshold", 1, 25],
    ["botAddThreshold", 1, 10],
    ["actionWindowSeconds", 1, 60],
    ["raidJoinThreshold", 2, 100],
    ["raidWindowSeconds", 5, 60],
    ["massBanThreshold", 1, 25],
    ["massKickThreshold", 1, 25],
  ];
  for (const [field, min, max] of thresholds) {
    const v = optBoundedInt(b[field], field, min, max);
    if (v !== undefined) (patch as Record<string, unknown>)[field] = v;
  }
  for (const field of ["exemptUserIds", "exemptRoleIds", "exemptChannelIds"] as const) {
    const v = optSnowflakeList(b[field], field);
    if (v !== undefined) patch[field] = v;
  }
  if (b.logChannelId !== undefined) {
    patch.logChannelId = optNullableString(b.logChannelId, "logChannelId", 32, SNOWFLAKE_RE) ?? null;
  }
  if (b.actionPunishment !== undefined) {
    const p = b.actionPunishment;
    if (typeof p !== "string" || !GUARD_PUNISHMENTS.has(p)) {
      throw new ApiError(400, `"actionPunishment" şunlardan biri olmalı: none, warn, kick, ban, timeout.`);
    }
    patch.actionPunishment = p as GuardConfig["actionPunishment"];
  }
  sendJson(ctx.res, 200, await updateGuardConfig(guildId, patch));
}

async function handleLogChannels(ctx: Ctx): Promise<void> {
  const guildId = needSnowflake(ctx.seg[2] ?? "", "guildId");
  if (ctx.req.method === "GET") {
    const all = await getAllLogChannels(guildId);
    const others = await getAllChannelSettings(guildId);
    sendJson(
      ctx.res,
      200,
      [
        ...LOG_CATEGORIES.map((c) => ({
          id: c.id,
          label: c.label,
          ornek: c.ornek,
          channelId: all[c.id] ?? null,
          group: "log",
        })),
        ...CHANNEL_SETTINGS.map((c) => ({
          id: c.id,
          label: c.label,
          ornek: c.ornek,
          channelId: others[c.id] ?? null,
          group: "diger",
        })),
      ],
    );
    return;
  }
  const b = needBodyObject(ctx.body);
  const category = b.category;
  const logIds: Set<string> = new Set(LOG_CATEGORIES.map((c) => c.id));
  const otherIds: Set<string> = new Set(CHANNEL_SETTINGS.map((c) => c.id));
  if (typeof category !== "string" || (!logIds.has(category) && !otherIds.has(category))) {
    throw new ApiError(400, `"category" şunlardan biri olmalı: ${[...logIds, ...otherIds].join(", ")}.`);
  }
  const channelId = optNullableString(b.channelId, "channelId", 32, SNOWFLAKE_RE) ?? null;
  if (otherIds.has(category)) {
    await setChannelSetting(guildId, category as ChannelSettingId, channelId);
  } else {
    await setLogChannel(guildId, category as LogCategory, channelId);
  }
  sendJson(ctx.res, 200, { ok: true, category, channelId });
}

async function handleWelcomeBack(ctx: Ctx): Promise<void> {
  const guildId = needSnowflake(ctx.seg[2] ?? "", "guildId");
  if (ctx.req.method === "GET") {
    sendJson(ctx.res, 200, getWelcomeBackSettings(guildId));
    return;
  }
  const b = needBodyObject(ctx.body);
  const enabled = optBoolean(b.enabled, "enabled");
  const duration = optBoundedInt(b.durationMinutes, "durationMinutes", 5, 10080);
  let settings = getWelcomeBackSettings(guildId);
  if (enabled !== undefined) settings = await setWelcomeBackEnabled(guildId, enabled);
  if (duration !== undefined) settings = await setWelcomeBackDuration(guildId, duration);
  sendJson(ctx.res, 200, settings);
}

function toPublicPermission(r: {
  id: number;
  targetId: string;
  targetType: string;
  permission: string;
  grantedBy: string;
  grantedAt: Date;
}) {
  return {
    id: r.id,
    targetId: r.targetId,
    targetType: r.targetType,
    permission: r.permission,
    grantedBy: r.grantedBy,
    grantedAt: toIso(r.grantedAt),
  };
}

async function handlePermissions(ctx: Ctx): Promise<void> {
  const guildId = needSnowflake(ctx.seg[2] ?? "", "guildId");
  const method = (ctx.req.method ?? "GET").toUpperCase();

  if (method === "GET") {
    const rows = await db
      .select()
      .from(userPermissionsTable)
      .where(eq(userPermissionsTable.guildId, guildId))
      .orderBy(asc(userPermissionsTable.id));
    sendJson(ctx.res, 200, rows.map(toPublicPermission));
    return;
  }

  if (method === "POST") {
    const b = needBodyObject(ctx.body);
    const permission = typeof b.permission === "string" ? b.permission.toLowerCase().trim() : "";
    if (!(IZIN_PERMISSIONS as readonly string[]).includes(permission)) {
      throw new ApiError(
        400,
        `Geçersiz yetki. Geçerli yetkiler: ${IZIN_PERMISSIONS.join(", ")}.`,
      );
    }
    const targetId = needSnowflake(String(b.targetId ?? ""), "targetId");
    const targetType = b.targetType === "role" ? "role" : b.targetType === "user" ? "user" : null;
    if (!targetType) throw new ApiError(400, `targetType "user" veya "role" olmalı.`);

    const [inserted] = await db
      .insert(userPermissionsTable)
      .values({ guildId, targetId, targetType, permission, grantedBy: "dashboard" })
      .onConflictDoNothing()
      .returning({ targetId: userPermissionsTable.targetId });
    invalidatePermissionCache(guildId, permission);
    if (inserted) {
      sendJson(ctx.res, 201, { ok: true });
    } else {
      sendJson(ctx.res, 200, { ok: true, alreadyGranted: true });
    }
    return;
  }

  // DELETE — tek kayıt silme (query) veya tümünü silme (?resetAll=1)
  const url = new URL(ctx.req.url ?? "/", "http://localhost");
  if (url.searchParams.get("resetAll") === "1") {
    await db.delete(userPermissionsTable).where(eq(userPermissionsTable.guildId, guildId));
    invalidatePermissionCache(guildId);
    sendJson(ctx.res, 200, { ok: true });
    return;
  }
  const permission = (url.searchParams.get("permission") ?? "").toLowerCase().trim();
  const targetId = url.searchParams.get("targetId") ?? "";
  const targetType = url.searchParams.get("targetType") ?? "";
  if (!(IZIN_PERMISSIONS as readonly string[]).includes(permission)) {
    throw new ApiError(400, "Geçersiz yetki.");
  }
  needSnowflake(targetId, "targetId");
  if (targetType !== "user" && targetType !== "role") {
    throw new ApiError(400, `targetType "user" veya "role" olmalı.`);
  }
  await db
    .delete(userPermissionsTable)
    .where(
      and(
        eq(userPermissionsTable.guildId, guildId),
        eq(userPermissionsTable.targetId, targetId),
        eq(userPermissionsTable.targetType, targetType),
        eq(userPermissionsTable.permission, permission),
      ),
    );
  invalidatePermissionCache(guildId, permission);
  sendJson(ctx.res, 200, { ok: true });
}

async function handlePremium(ctx: Ctx): Promise<void> {
  if (ctx.req.method === "GET" && ctx.seg.length === 3) {
    const users = await getAllPremiumUsers();
    sendJson(
      ctx.res,
      200,
      users.map((u) => ({
        userId: u.userId,
        grantedBy: u.grantedBy,
        grantedAt: toIso(u.grantedAt),
      })),
    );
    return;
  }
  if (ctx.req.method === "POST") {
    const b = needBodyObject(ctx.body);
    const userId = needSnowflake(String(b.userId ?? ""), "userId");
    await grantPremium(userId, "dashboard");
    sendJson(ctx.res, 200, { ok: true });
    return;
  }
  // DELETE /owner/premium/:userId
  const userId = needSnowflake(ctx.seg[3] ?? "", "userId");
  const revoked = await revokePremium(userId);
  if (!revoked) throw new ApiError(404, "Premium kaydı bulunamadı.");
  sendJson(ctx.res, 200, { ok: true });
}

async function handleStats(ctx: Ctx): Promise<void> {  const [{ value: warnings }] = await db.select({ value: count() }).from(warningsTable);
  const [{ value: premium }] = await db.select({ value: count() }).from(premiumUsersTable);
  const [{ value: customEvents }] = await db
    .select({ value: count() })
    .from(customCommandsTable)
    .where(eq(customCommandsTable.type, CUSTOM_EVENT_TYPE));
  sendJson(ctx.res, 200, {
    warnings: Number(warnings ?? 0),
    premium: Number(premium ?? 0),
    customEvents: Number(customEvents ?? 0),
  });
}

// ---------------------------------------------------------------------------
// Kelime Zinciri (oyun)
// ---------------------------------------------------------------------------
async function handleWordChain(ctx: Ctx): Promise<void> {
  const guildId = needSnowflake(ctx.seg[2] ?? "", "guildId");
  if (ctx.req.method === "GET") {
    const status = getWordChainStatus(guildId);
    const top = await getGuildWordScores(guildId, 10);
    sendJson(ctx.res, 200, {
      configured: status !== null,
      channelId: status?.channelId ?? null,
      lastWord: status?.lastWord ?? null,
      requiredLetter: status?.requiredLetter ?? null,
      streak: status?.streak ?? 0,
      bestStreak: status?.bestStreak ?? 0,
      bestHolderId: status?.bestHolderId ?? null,
      usedWordsCount: status?.usedWordsCount ?? 0,
      top,
    });
    return;
  }
  const b = needBodyObject(ctx.body);
  const channelId = optNullableString(b.channelId, "channelId", 32, SNOWFLAKE_RE) ?? null;
  if (channelId === null) {
    const removed = await removeWordChainChannel(guildId);
    sendJson(ctx.res, 200, { ok: true, removed: removed !== null, channelId: null });
    return;
  }
  const result = await setWordChainChannel(guildId, channelId, "dashboard");
  if (!result.ok) {
    throw new ApiError(409, "Bu kanal zaten Kelime Zinciri kanalı olarak ayarlı.");
  }
  sendJson(ctx.res, 200, { ok: true, channelId });
}

// ---------------------------------------------------------------------------
// Bilgi Yarışması skor tablosu (salt okunur)
// ---------------------------------------------------------------------------
async function handleQuizLeaderboard(ctx: Ctx): Promise<void> {
  const guildId = needSnowflake(ctx.seg[2] ?? "", "guildId");
  const top = await getQuizLeaderboard(guildId, 10);
  sendJson(ctx.res, 200, top);
}

// ---------------------------------------------------------------------------
// MentionAI (yapay zeka)
// ---------------------------------------------------------------------------
async function handleMentionAi(ctx: Ctx): Promise<void> {
  const guildId = needSnowflake(ctx.seg[2] ?? "", "guildId");
  await ensureMentionAiLoaded();
  if (ctx.req.method === "GET") {
    sendJson(ctx.res, 200, {
      enabled: isMentionAiEnabled(guildId),
      channelId: getMentionAiChannel(guildId),
    });
    return;
  }
  const b = needBodyObject(ctx.body);
  const enabled = optBoolean(b.enabled, "enabled");
  const channelId = optNullableString(b.channelId, "channelId", 32, SNOWFLAKE_RE) ?? null;
  if (enabled !== undefined) await setMentionAiEnabled(guildId, enabled);
  // Kanal kısıtı: boş/null verilirse kaldırılır.
  const current = getMentionAiChannel(guildId);
  if (channelId !== current) {
    if (channelId === null && current !== null) {
      await setMentionAiChannel(guildId, current); // toggle ile kaldır
    } else if (channelId !== null) {
      await setMentionAiChannel(guildId, channelId);
    }
  }
  sendJson(ctx.res, 200, {
    enabled: isMentionAiEnabled(guildId),
    channelId: getMentionAiChannel(guildId),
  });
}

// ---------------------------------------------------------------------------
// Bot'un bulunduğu sunucular (panelde bot sahibinin tüm sunucuları görmesi için;
// token korumalı — /api/commands aksine herkese açık değildir)
// ---------------------------------------------------------------------------
let discordClient: Client | null = null;

async function handleGuilds(ctx: Ctx): Promise<void> {
  const guilds =
    discordClient?.guilds.cache.map((g) => ({
      id: g.id,
      name: g.name,
      icon: g.icon,
      memberCount: g.memberCount ?? null,
    })) ?? [];
  sendJson(ctx.res, 200, guilds);
}

// ---------------------------------------------------------------------------
// Sunucu kanalları (panelden duyuru/kanal seçimi için)
// ---------------------------------------------------------------------------
async function handleChannels(ctx: Ctx): Promise<void> {
  const guildId = needSnowflake(ctx.seg[2] ?? "", "guildId");
  const guild = discordClient?.guilds.cache.get(guildId);
  if (!guild) throw new ApiError(404, "Sunucu bulunamadı.");
  const channels = guild.channels.cache
    .filter((c) => c.isTextBased() && !c.isDMBased())
    .map((c) => ({ id: c.id, name: (c as { name?: string }).name ?? c.id }))
    .sort((a, b) => a.name.localeCompare(b.name, "tr"));
  sendJson(ctx.res, 200, channels);
}

// ---------------------------------------------------------------------------
// Duyuru gönderme (panelden sunucuya duyuru)
// ---------------------------------------------------------------------------
async function handleAnnounce(ctx: Ctx): Promise<void> {
  const guildId = needSnowflake(ctx.seg[2] ?? "", "guildId");
  const b = needBodyObject(ctx.body);
  const channelId = needSnowflake(String(b.channelId ?? ""), "channelId");
  const message = optNullableString(b.message, "message", 4000);
  const title = optNullableString(b.title, "title", 256);
  if (!message || !message.trim()) {
    throw new ApiError(400, '"message" alanı boş olamaz.');
  }
  const guild = discordClient?.guilds.cache.get(guildId);
  if (!guild) throw new ApiError(404, "Sunucu bulunamadı.");
  let channel = guild.channels.cache.get(channelId) ?? null;
  if (!channel) {
    // Yeni açılan kanal henüz cache'de olmayabilir — Discord'dan çekmeyi dene.
    try {
      channel = await guild.channels.fetch(channelId);
    } catch {
      channel = null;
    }
  }
  if (!channel || !("send" in channel)) {
    throw new ApiError(400, "Kanal bulunamadı veya metin kanalı değil.");
  }
  const embed = new V2CardBuilder()
    .setTitle(title?.trim() ? `📢 ${title.trim()}` : "📢 Duyuru")
    .setDescription(message.trim())
    .setColor(0xfafafa)
    .setTimestamp();
  await (channel as TextChannel).send(v2Payload({ components: [embed] }));
  sendJson(ctx.res, 200, { ok: true });
}

// Komut listesi (herkese açık — token gerektirmez; panel landing sayfası için)
// ---------------------------------------------------------------------------
async function handleCommands(ctx: Ctx): Promise<void> {
  const list = commandList
    .map((c) => ({
      name: c.name,
      description: c.description,
      usage: c.usage ?? null,
      category: c.category,
    }))
    .sort((a, b) => a.category.localeCompare(b.category, "tr") || a.name.localeCompare(b.name, "tr"));
  sendJson(ctx.res, 200, list);
}

// ---------------------------------------------------------------------------
// Yönlendirici
// ---------------------------------------------------------------------------
async function dispatch(ctx: Ctx): Promise<void> {
  const method = (ctx.req.method ?? "GET").toUpperCase();
  const s = ctx.seg;

  if (s.length === 2 && s[0] === "api" && s[1] === "health" && method === "GET") {
    sendJson(ctx.res, 200, { ok: true });
    return;
  }
  if (s.length === 2 && s[0] === "api" && s[1] === "commands" && method === "GET") {
    await handleCommands(ctx);
    return;
  }
  if (s.length === 2 && s[0] === "api" && s[1] === "guilds" && method === "GET") {
    await handleGuilds(ctx);
    return;
  }
  if (s[0] === "api" && s[1] === "guilds" && s.length >= 4) {
    const resource = s[3];
    if (resource === "settings" && s.length === 4 && (method === "GET" || method === "PUT")) {
      await handleSettings(ctx);
      return;
    }
    if (resource === "automod" && s.length === 4 && (method === "GET" || method === "PUT")) {
      await handleAutomod(ctx);
      return;
    }
    if (resource === "welcome" && s.length === 4 && (method === "GET" || method === "PUT")) {
      await handleWelcome(ctx);
      return;
    }
    if (resource === "warnings" && s.length === 4 && method === "GET") {
      await handleWarnings(ctx);
      return;
    }
    if (resource === "warnings" && s.length === 5 && method === "DELETE") {
      await handleWarnings(ctx);
      return;
    }
    if (resource === "custom-events" && s.length === 4 && method === "GET") {
      await handleCustomEvents(ctx);
      return;
    }
    if (resource === "custom-events" && s.length === 4 && method === "POST") {
      await handleCustomEventCreate(ctx);
      return;
    }
    if (resource === "custom-events" && s.length === 5 && (method === "PATCH" || method === "DELETE")) {
      await handleCustomEvents(ctx);
      return;
    }
    if (
      resource === "permissions" &&
      s.length === 4 &&
      (method === "GET" || method === "POST" || method === "DELETE")
    ) {
      await handlePermissions(ctx);
      return;
    }
    if (resource === "guard" && s.length === 4 && (method === "GET" || method === "PUT")) {
      await handleGuard(ctx);
      return;
    }
    if (resource === "log-channels" && s.length === 4 && (method === "GET" || method === "PUT")) {
      await handleLogChannels(ctx);
      return;
    }
    if (resource === "welcome-back" && s.length === 4 && (method === "GET" || method === "PUT")) {      await handleWelcomeBack(ctx);
      return;
    }
    if (resource === "wordchain" && s.length === 4 && (method === "GET" || method === "PUT")) {
      await handleWordChain(ctx);
      return;
    }
    if (resource === "quiz-leaderboard" && s.length === 4 && method === "GET") {
      await handleQuizLeaderboard(ctx);
      return;
    }
    if (resource === "mentionai" && s.length === 4 && (method === "GET" || method === "PUT")) {
      await handleMentionAi(ctx);
      return;
    }
    if (resource === "channels" && s.length === 4 && method === "GET") {
      await handleChannels(ctx);
      return;
    }
    if (resource === "announce" && s.length === 4 && method === "POST") {
      await handleAnnounce(ctx);
      return;
    }
  }
  if (s[0] === "api" && s[1] === "owner" && s[2] === "premium") {
    if (s.length === 3 && (method === "GET" || method === "POST")) {
      await handlePremium(ctx);
      return;
    }
    if (s.length === 4 && method === "DELETE") {
      await handlePremium(ctx);
      return;
    }
  }
  if (
    s.length === 3 &&
    s[0] === "api" &&
    s[1] === "owner" &&
    s[2] === "stats" &&
    method === "GET"
  ) {
    await handleStats(ctx);
    return;
  }
  throw new ApiError(404, "Bilinmeyen API ucu.");
}

// ---------------------------------------------------------------------------
// IP tabanlı rate limit + ban (brute-force koruması; bellek-içi)
// ---------------------------------------------------------------------------
const RATE_LIMIT_PER_MINUTE = 60;
const CONSECUTIVE_401_BEFORE_BAN = 10;
const IP_BAN_DURATION_MS = 10 * 60 * 1000;

const ipRateWindows = new Map<string, { count: number; resetAt: number }>();
const ipFailCounts = new Map<string, number>();
const ipBans = new Map<string, number>();

function getClientIp(req: http.IncomingMessage): string {
  return req.socket.remoteAddress ?? "unknown";
}

// ---------------------------------------------------------------------------
// Ana giriş noktası
// ---------------------------------------------------------------------------
export async function startDashboardApi(client?: Client): Promise<void> {
  if (client) discordClient = client;
  const token = process.env.DASHBOARD_API_TOKEN?.trim();
  if (!token) {
    console.error(
      "[panel] DASHBOARD_API_TOKEN yok, api açılmıyor. " +
        "token üret: openssl rand -base64 48",
    );
    return;
  }

  const port = Number(process.env.DASHBOARD_API_PORT) || 3001;

  const server = http.createServer((req, res) => {
    (async () => {
      try {
        const url = new URL(req.url ?? "/", "http://localhost");
        const seg = url.pathname.split("/").filter(Boolean);
        const method = (req.method ?? "GET").toUpperCase();
        const ip = getClientIp(req);
        const now = Date.now();

        // 1) IP ban kontrolü (auth'tan önce)
        const bannedUntil = ipBans.get(ip);
        if (bannedUntil !== undefined) {
          if (bannedUntil > now) {
            sendJson(res, 429, { error: "Çok fazla başarısız deneme. Kısa bir süre sonra tekrar deneyin." });
            return;
          }
          ipBans.delete(ip);
        }

        // 2) Rate limit: dakikada 60 istek (auth'tan önce sayılır — brute-force da düşer)
        const window = ipRateWindows.get(ip);
        if (!window || window.resetAt <= now) {
          ipRateWindows.set(ip, { count: 1, resetAt: now + 60_000 });
        } else if (window.count >= RATE_LIMIT_PER_MINUTE) {
          sendJson(res, 429, { error: "Çok fazla istek. Kısa bir süre sonra tekrar deneyin." });
          return;
        } else {
          window.count++;
        }

        const isPublicCommands =
          seg.length === 2 && seg[0] === "api" && seg[1] === "commands" && method === "GET";
        if (!isPublicCommands) {
          try {
            checkAuth(req, token);
          } catch (authErr) {
            // 3) 401 sayacı (auth'tan sonra) — üst üste 10 başarısız auth → 10 dk ban
            if (authErr instanceof ApiError && authErr.status === 401) {
              const fails = (ipFailCounts.get(ip) ?? 0) + 1;
              if (fails >= CONSECUTIVE_401_BEFORE_BAN) {
                ipBans.set(ip, now + IP_BAN_DURATION_MS);
                ipFailCounts.delete(ip);
              } else {
                ipFailCounts.set(ip, fails);
              }
            }
            throw authErr;
          }
          ipFailCounts.delete(ip); // başarılı auth → sayaç sıfırlanır
        }
        const needsBody = method === "PUT" || method === "PATCH" || method === "POST";
        const body = needsBody ? await readJsonBody(req) : undefined;
        await dispatch({ req, res, seg, body });
      } catch (err) {
        if (err instanceof ApiError) {
          if (!res.headersSent) sendJson(res, err.status, { error: err.message });
        } else {
          console.error("[panel] istek patladı:", err);
          if (!res.headersSent) sendJson(res, 500, { error: "Sunucu hatası oluştu." });
        }
      }
    })();
  });

  server.listen(port, "0.0.0.0", () => {
    console.log(`[panel] :${port} dinliyor`);
  });
}
