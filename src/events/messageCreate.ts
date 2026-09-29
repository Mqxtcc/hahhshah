import { V2CardBuilder } from "../utils/componentsV2.js";
import { v2Payload } from "../utils/messages.js";
import { loadEnv } from "../utils/env.js";
loadEnv();

import type { Message } from "discord.js";
import { AttachmentBuilder, Collection, PermissionFlagsBits } from "discord.js";
import type { Command } from "../types.js";
import { DEFAULT_PREFIX, OWNER_ID } from "../config.js";
import { db } from "../db/index.js";
import { vipUsersTable, botSettingsTable } from "../db/schema.js";
import { eq } from "../db/jsonOrm.js";
import { EMOJIS } from "../utils/emojis.js";
import { MSG } from "../utils/messages.js";
import { ensureAfkLoaded, getAfk, clearAfk } from "../afk/store.js";
import {
  ensureWelcomeBackActivityLoaded,
  consumeWelcomeBackStartupGrace,
  getLastActivity,
  getWelcomeBackSettings,
  touchActivity,
} from "../welcomeback/store.js";
import { ensurePremiumLoaded } from "../premium/store.js";
import { ensureHalfOwnersLoaded, isHalfOwner } from "../premium/halfOwners.js";
import {
  getCustomEvent,
  migrateLegacyCustomEvents,
} from "../customEvents/store.js";
import { executeCustomEvent } from "../customEvents/engine.js";
import {
  getRequiredLetter,
  isGameActive,
  isOwnerBypassEnabled,
  loadWordChainChannels,
  looksLikeWordAttempt,
  submitWord,
} from "../utils/wordchain.js";
import { notifyOwnerCommandUsed, consumePermissionDenied } from "../utils/notifyOwner.js";
import { getErrorMessage } from "../utils/errors.js";
import { errorEmbed } from "../utils/embeds.js";
import {
  answerMentionAi,
  ensureMentionAiLoaded,
  isMentionAiEnabled,
  isMentionAiAllowedInChannel,
  mentionAiErrorMessage,
  extractMentionAiCodeFiles,
  splitMentionAiResponse,
} from "../utils/mentionai.js";

export { OWNER_ID };

// ---------- Yardımcı fonksiyonlar ----------
// NOT: utils/parse.ts'teki formatDuration DAKİKA alır; bu ise MİLİSANİYE.
// İsim çakışması yüzünden yanlış birimle çağrılma riskine karşı adı açık.
export function formatDurationMs(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const days = Math.floor(totalSec / 86400);
  const hours = Math.floor((totalSec % 86400) / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;
  const parts: string[] = [];
  if (days) parts.push(`${days}g`);
  if (hours) parts.push(`${hours}s`);
  if (minutes) parts.push(`${minutes}dk`);
  if (seconds || parts.length === 0) parts.push(`${seconds}sn`);
  return parts.join(" ");
}

/** AFK mesajları için uzun hali: "4 saniye", "5 dakika", "2 saat", "3 gün". */
export function formatDurationLong(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const days = Math.floor(totalSec / 86400);
  const hours = Math.floor((totalSec % 86400) / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;
  const parts: string[] = [];
  if (days) parts.push(`${days} gün`);
  if (hours) parts.push(`${hours} saat`);
  if (minutes) parts.push(`${minutes} dakika`);
  if (seconds || parts.length === 0) parts.push(`${seconds} saniye`);
  return parts.join(" ");
}

export function formatAgo(ts: number): string {
  if (!ts) return "hiç kullanılmadı";
  return `${formatDurationMs(Date.now() - ts)} önce`;
}

export async function requireOwner(message: Message): Promise<boolean> {
  if (message.author.id === OWNER_ID) return true;
  await message
    .reply(v2Payload(
      MSG.error(`Bu komutu kullanamazsın, sadece bot sahibi kullanabilir.`),
    ))
    .catch(() => null);
  return false;
}

/**
 * Bot sahibi VEYA half-owner (bkz. premium/halfOwners.ts) kullanabilir.
 * Şu an kullanan komutlar: !premium, !premium-kaldir, !premium-liste,
 * !özelüye (vip).
 *
 * ⚠️ SADECE düşük riskli, tamamen geri alınabilir, sunucu/bot güvenliğini
 * etkilemeyen işlemler için kullanılmalı. Tehlikeli owner komutları
 * (restart, eval, ownerrole, ytdlp-güncelle, !halfowner'ın
 * kendisi vb.) bunu KULLANMAMALI; onlar `requireOwner` ile veya doğrudan
 * `OWNER_ID` karşılaştırmasıyla owner-only kalmaya devam etmeli.
 */
export async function requireOwnerOrHalfOwner(
  message: Message,
): Promise<boolean> {
  if (message.author.id === OWNER_ID) return true;
  await ensureHalfOwnersLoaded();
  if (isHalfOwner(message.author.id)) return true;
  await message
    .reply(v2Payload(
      MSG.error(
        `Bu komutu kullanamazsın, sadece bot sahibi ve yetkilendirilmiş half-owner'lar kullanabilir.`,
      ),
    ))
    .catch(() => null);
  return false;
}

export function resolveTargetUserId(
  message: Message,
  args: string[],
): string | null {
  const mentioned = message.mentions.users.first();
  if (mentioned) return mentioned.id;
  const raw = args[0]?.replace(/[<@!>]/g, "");
  return raw && /^\d{15,25}$/.test(raw) ? raw : null;
}

// Komutu sadece bot sahibi veya sunucu sahibi kullanabilir.
export async function requireOwnerOrGuildOwner(
  message: Message,
): Promise<boolean> {
  if (message.author.id === OWNER_ID) return true;
  if (message.guild && message.guild.ownerId === message.author.id) return true;
  await message
    .reply(v2Payload(
      MSG.error("Bu komutu sadece sunucu sahibi kullanabilir."),
    ))
    .catch(() => null);
  return false;
}

// Komutu bot sahibi, sunucu sahibi veya yönetici (Administrator) kullanabilir.
export async function requireOwnerOrGuildOwnerOrAdmin(
  message: Message,
): Promise<boolean> {
  if (message.author.id === OWNER_ID) return true;
  if (message.guild && message.guild.ownerId === message.author.id) return true;
  if (message.member?.permissions.has(PermissionFlagsBits.Administrator)) return true;
  await message
    .reply(v2Payload(
      MSG.error("Bu komutu sadece yöneticiler kullanabilir."),
    ))
    .catch(() => null);
  return false;
}

// ---------- Özel üyeler (VIP) ----------
export const vipUsers = new Set<string>();

/** Startup'ta çağrılır; ilk mesajın veritabanı yüklemesini beklemesini önler. */
export async function initializePersistentState(): Promise<void> {
  await ensurePersistedStateLoaded();
  await ensureAfkLoaded();
  await ensurePremiumLoaded();
  await ensureHalfOwnersLoaded();
  await migrateLegacyCustomEvents();
  await loadWordChainChannels();
  await ensureWelcomeBackActivityLoaded();
}

// ---------- Sunucu bazlı prefix (!prefix) ----------
const GUILD_PREFIX_KEY_PREFIX = "guild_prefix:";
const guildPrefixMap = new Map<string, string>();

export function getGuildPrefix(guildId: string | null | undefined): string {
  if (!guildId) return DEFAULT_PREFIX;
  return guildPrefixMap.get(guildId) ?? DEFAULT_PREFIX;
}

export async function setGuildPrefix(
  guildId: string,
  newPrefix: string,
): Promise<void> {
  guildPrefixMap.set(guildId, newPrefix);
  try {
    await db
      .insert(botSettingsTable)
      .values({ key: `${GUILD_PREFIX_KEY_PREFIX}${guildId}`, value: newPrefix })
      .onConflictDoUpdate({
        target: botSettingsTable.key,
        set: { value: newPrefix, updatedAt: new Date() },
      });
  } catch (err) {
    console.error(`prefix kaydolmadı (${guildId}):`, err);
    // Hatayı yutma: bellek güncellendi ama DB yazılamadıysa çağıran (dashboard
    // API) bunu bilmeli, yoksa site "kaydedildi" sanır.
    throw err;
  }
}

export async function resetGuildPrefix(guildId: string): Promise<void> {
  guildPrefixMap.delete(guildId);
  try {
    await db
      .delete(botSettingsTable)
      .where(eq(botSettingsTable.key, `${GUILD_PREFIX_KEY_PREFIX}${guildId}`));
  } catch (err) {
    console.error(`prefix sıfırlanmadı (${guildId}):`, err);
  }
}

// ---------- Otomatik cevap sistemi ----------
export const autoResponses = new Map<string, string>();
const AUTO_RESPONSE_KEY_PREFIX = "auto_responses:";

export function autoResponseMapKey(guildId: string, trigger: string): string {
  return `${guildId}::${trigger}`;
}

export async function saveAutoResponsesForGuild(
  guildId: string,
): Promise<void> {
  try {
    const prefix = `${guildId}::`;
    const obj: Record<string, string> = {};
    for (const [mapKey, response] of autoResponses) {
      if (mapKey.startsWith(prefix))
        obj[mapKey.slice(prefix.length)] = response;
    }
    const value = JSON.stringify(obj);
    await db
      .insert(botSettingsTable)
      .values({ key: `${AUTO_RESPONSE_KEY_PREFIX}${guildId}`, value })
      .onConflictDoUpdate({
        target: botSettingsTable.key,
        set: { value, updatedAt: new Date() },
      });
  } catch (err) {
    console.error("otomatik cevaplar kaydolmadı:", err);
  }
}

// ---------- VIP ----------
export async function toggleVipById(targetId: string): Promise<boolean> {
  // DB-önce: DB yazımı patlarsa bellek dokunulmadan kalır (restart'a kadar
  // ayrışık durum olmaz). Bkz. afk/store.ts deseni.
  if (vipUsers.has(targetId)) {
    await db.delete(vipUsersTable).where(eq(vipUsersTable.userId, targetId));
    vipUsers.delete(targetId);
    return false;
  }
  await db
    .insert(vipUsersTable)
    .values({ userId: targetId })
    .onConflictDoNothing();
  vipUsers.add(targetId);
  return true;
}

// ---------- Kalıcı veri yükleme ----------
let persistedStateLoaded = false;
let persistedStateLoadingPromise: Promise<void> | null = null;

async function loadPersistedState(): Promise<void> {
  try {
    const [vip, settings] = await Promise.all([
      db.select().from(vipUsersTable),
      db.select().from(botSettingsTable),
    ]);
    for (const row of vip) vipUsers.add(row.userId);

    let restoredGuildPrefixes = 0;
    for (const row of settings) {
      if (row.key.startsWith(GUILD_PREFIX_KEY_PREFIX) && row.value) {
        guildPrefixMap.set(
          row.key.slice(GUILD_PREFIX_KEY_PREFIX.length),
          row.value,
        );
        restoredGuildPrefixes++;
      }
    }

    let restoredAutoResponses = 0;
    for (const row of settings) {
      if (row.key.startsWith(AUTO_RESPONSE_KEY_PREFIX) && row.value) {
        const guildId = row.key.slice(AUTO_RESPONSE_KEY_PREFIX.length);
        try {
          const parsed = JSON.parse(row.value);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            for (const [trigger, response] of Object.entries(parsed)) {
              if (typeof response === "string") {
                autoResponses.set(
                  autoResponseMapKey(guildId, trigger),
                  response,
                );
                restoredAutoResponses++;
              }
            }
          }
        } catch (err) {
          console.error(
            `otomatik cevap verisi okunamadı (${row.key}):`,
            err,
          );
        }
      }
    }

    console.log(
      `[state] ${vip.length} vip, ${restoredGuildPrefixes} prefix, ${restoredAutoResponses} oto-cevap`,
    );
  } catch (err) {
    console.error("kalıcı veri yüklenemedi:", err);
  } finally {
    persistedStateLoaded = true;
  }
}

async function ensurePersistedStateLoaded(): Promise<void> {
  if (persistedStateLoaded) return;
  if (!persistedStateLoadingPromise)
    persistedStateLoadingPromise = loadPersistedState();
  await persistedStateLoadingPromise;
}

export async function messageCreateEvent(
  message: Message,
  commands: Collection<string, Command>,
): Promise<void> {
  if (message.author.bot || message.webhookId) return;
  if (!message.guild) {
    // 👑 Sahip DM istisnası: !veribak DM'den de çalışır (salt okunur, sunucu
    // gerektirmez). Diğer tüm DM mesajları eskisi gibi sessizce yoksayılır.
    if (message.author.id === OWNER_ID) {
      const dmParts = message.content.trim().split(/\s+/);
      const dmFirst = dmParts[0]?.toLocaleLowerCase("tr-TR");
      if (dmFirst === `${DEFAULT_PREFIX}veribak`) {
        const dmCommand = commands.get("veribak");
        if (dmCommand) {
          try {
            await dmCommand.execute(message, dmParts.slice(1));
          } catch (err) {
            console.error(`veribak patladı (dm): ${getErrorMessage(err)}`);
            if (err instanceof Error && err.stack) console.error(err.stack);
          }
          return;
        }
      }
    }
    return;
  }

  const guildId = message.guild.id;

  await ensurePersistedStateLoaded();
  await ensureMentionAiLoaded();

  const guildPrefix = getGuildPrefix(guildId);

  // ---------- Tekrar hoşgeldin sistemi ----------
  // Sistem açıksa: kullanıcı ayarlanan süre boyunca bu sunucuda hiç
  // mesaj/komut yazmadıysa (son aktiflik kaydı yoksa veya süre dolmuşsa)
  // karşılama mesajı gönderilir. AFK kontrolünden ÖNCE çalışır ki komut
  // filtresine takılmadan HER mesaj (komut olsun olmasın) aktiflik sayılsın.
  {
    const wbSettings = getWelcomeBackSettings(guildId);
    if (wbSettings.enabled) {
      const lastActivity = getLastActivity(guildId, message.author.id);
      const startupGrace = consumeWelcomeBackStartupGrace(guildId, message.author.id);
      const now = Date.now();
      const thresholdMs = wbSettings.durationMinutes * 60_000;
      const shouldWelcome =
        !startupGrace && lastActivity !== null && now - lastActivity >= thresholdMs;

      // Kaydı reply await'inden ÖNCE güncelle. Aynı kullanıcının iki mesajı
      // eşzamanlı işlenirse ikisi de eski zamanı görüp iki hoşgeldin mesajı
      // göndermesin.
      touchActivity(guildId, message.author.id, now);
      if (shouldWelcome) {
        const welcomeBackNotice = await message
          .reply(v2Payload({
            content: `<a:1000060632:1548019144304099349> Tekrar hoşgeldin, ${message.author}!`,
            allowedMentions: { users: [message.author.id] },
          }))
          .catch(() => null);
        if (welcomeBackNotice) {
          setTimeout(() => {
            void welcomeBackNotice.delete().catch(() => null);
          }, 3_500);
        }
      }
    }
  }

  // ---------- AFK sistemi ----------
  await ensureAfkLoaded();
  const contentLower = message.content.trim().toLocaleLowerCase("tr-TR");
  const AFK_COMMAND_NAMES = ["afk", "uzakta"];
  const guildPrefixLower = guildPrefix.toLocaleLowerCase("tr-TR");
  const afkFirstWord = contentLower.startsWith(guildPrefixLower)
    ? contentLower.slice(guildPrefixLower.length).split(/\s+/)[0]
    : "";
  const isAfkCommand = AFK_COMMAND_NAMES.includes(afkFirstWord);
  if (!isAfkCommand) {
    const previousAfk = await clearAfk(message.author.id);
    if (previousAfk) {
      const away = formatDurationLong(
        message.createdTimestamp - previousAfk.since,
      );
      const embed = new V2CardBuilder()
        .setColor(0xed4245)
        .setAuthor({
          name: `${message.author.username}, artık AFK değil!`,
          iconURL: message.author.displayAvatarURL(),
        })
        .setDescription(`${EMOJIS.afkReturn}`)
        .addFields(
          { name: "» AFK Olma Sebebi", value: `• ${previousAfk.reason}` },
          { name: "» AFK Olma Süresi", value: `• ${away}` },
        );
      const notice = await message
        .reply(v2Payload({ components: [embed] }))
        .catch(() => null);
      if (notice) setTimeout(() => notice.delete().catch(() => null), 8_000);
    }
  }

  const repliedUser = message.mentions.repliedUser;
  const mentionedUsers = [...message.mentions.users.values()];
  if (repliedUser && !mentionedUsers.some((u) => u.id === repliedUser.id)) {
    mentionedUsers.push(repliedUser);
  }
  if (mentionedUsers.length > 0) {
    const afkMentions = mentionedUsers
      .filter((u) => u.id !== message.author.id)
      .map((u) => ({ user: u, afk: getAfk(u.id) }))
      .filter(
        (m): m is { user: typeof m.user; afk: NonNullable<typeof m.afk> } =>
          m.afk !== null,
      );
    if (afkMentions.length > 0) {
      const lines = afkMentions.map(({ user, afk }) => {
        const timeAgo = formatDurationLong(message.createdTimestamp - afk.since);
        return `${EMOJIS.afkActive} ${user.username} şu an **AFK** (${timeAgo} önce ayrıldı)`;
      });

      await message.reply(v2Payload(lines.join("\n"))).catch(() => null);
    }
  }

  // ---------- MentionAI ----------
  // Yalnızca sunucuda etkinleştirildiğinde, (varsa) kısıtlı kanalda ve
  // doğrudan bota mention/reply geldiğinde çalışır; diğer kanallarda istek
  // bile PixRouter'a gitmez.
  // ÖNEMLİ: mesaj komut prefix'iyle başlıyorsa (ör. "!ban @BotAdı") bu HER
  // ZAMAN bir komuttur, bota mention içerse bile — MentionAI'ye gitmemeli.
  // Eskiden bu kontrol yoktu: biri "!ban @BotAdı" yazdığında bot kendisi
  // mention'landığı için mesaj komut olarak hiç işlenmiyor, doğrudan
  // MentionAI'ye gidiyordu — yetkisiz kullanıcıya "Yetkin Yok" gibi hiçbir
  // komut cevabı hiç gelmiyordu (sanki komut yokmuş gibi görünüyordu).
  const messageIsCommand = message.content.startsWith(guildPrefix);
  const botId = message.client.user?.id;
  const isBotMentioned = Boolean(botId && message.mentions.users.has(botId));
  const isReplyToBot =
    message.reference?.messageId !== undefined && repliedUser?.id === botId;
  if (!messageIsCommand && isMentionAiEnabled(guildId) && (isBotMentioned || isReplyToBot)) {
    if (!message.channel.isTextBased()) return;
    const textChannel = message.channel as unknown as {
      sendTyping(): Promise<unknown>;
      send(payload: unknown): Promise<unknown>;
    };
    // Kanal kısıtı: izin yoksa sessizce çık (API çağrısı yok).
    if (!isMentionAiAllowedInChannel(guildId, message.channel.id)) return;

    // Mention-AI de maliyetli; komut rate-limit'i ile aynı korumayı uygula.
    const { checkAiRateLimit } = await import("../utils/rateLimit.js");
    if (!(await checkAiRateLimit(message, "mention-ai"))) return;

    const prompt = botId
      ? message.content.replace(new RegExp(`<@!?${botId}>`, "g"), " ").trim()
      : message.content.trim();
    let repliedMessageContent: string | undefined;
    let repliedImageUrls: string[] = [];
    if (isReplyToBot && message.reference?.messageId) {
      try {
        const referenced = await message.fetchReference();
        repliedMessageContent = referenced.content;
        repliedImageUrls = [...referenced.attachments.values()]
          .filter(
            (attachment) =>
              attachment.contentType?.startsWith("image/") ||
              /\.(png|jpe?g|gif|webp|bmp|avif)$/i.test(attachment.name ?? ""),
          )
          .map((attachment) => attachment.url);
      } catch {
        // Mesaj cache/API erişimi yoksa mevcut prompt ile devam edilir.
      }
    }
    const imageUrls = [...message.attachments.values()]
      .filter(
        (attachment) =>
          attachment.contentType?.startsWith("image/") ||
          /\.(png|jpe?g|gif|webp|bmp|avif)$/i.test(attachment.name ?? ""),
      )
      .map((attachment) => attachment.url)
      .concat(repliedImageUrls)
      .slice(0, 4);
    await textChannel.sendTyping().catch(() => null);
    const typingRefresh = setInterval(() => {
      void textChannel.sendTyping().catch(() => null);
    }, 8_000);
    try {
      const response = await answerMentionAi({
        guildId,
        userId: message.author.id,
        username: message.author.username,
        prompt,
        repliedMessage: repliedMessageContent,
        imageUrls,
      });
      const extracted = extractMentionAiCodeFiles(response);
      const chunks = extracted.text
        ? splitMentionAiResponse(extracted.text)
        : [];
      const files = extracted.files.map(
        (file) =>
          new AttachmentBuilder(Buffer.from(file.content, "utf8"), {
            name: file.name,
          }),
      );
      const typeScriptNotice = extracted.files.some((file) => file.isTypeScript)
        ? "Not: TypeScript dosyaları Discord'un .ts dosya kısıtı nedeniyle .txt olarak gönderildi."
        : "";
      if (files.length > 0) {
        const firstChunk = chunks.shift();
        let firstContent = [firstChunk, typeScriptNotice].filter(Boolean).join("\n\n");
        if (firstContent.length > 2_000 && typeScriptNotice) {
          firstContent = firstChunk ?? "";
          chunks.unshift(typeScriptNotice);
        }
        const firstPayload = {
          ...(firstContent ? { content: firstContent } : {}),
          files,
          allowedMentions: { repliedUser: false, parse: [] },
        };
        await message.reply(firstPayload).catch(() => null);
      }
      if (chunks.length === 0 && files.length === 0)
        chunks.push("AI bir cevap üretemedi, tekrar dene.");
      for (let index = 0; index < chunks.length; index++) {
        const payload = {
          content: chunks[index],
          allowedMentions: { repliedUser: false, parse: [] },
        };
        if (index === 0) await message.reply(payload).catch(() => null);
        else await textChannel.send(payload).catch(() => null);
      }
    } catch (error) {
      console.error("mentionai patladı la:", error);
      await message
        .reply(v2Payload({
          components: [errorEmbed("MentionAI yanıt veremedi", mentionAiErrorMessage(error))],
          allowedMentions: { repliedUser: false, parse: [] },
        }))
        .catch(() => null);
    } finally {
      clearInterval(typingRefresh);
    }
    return;
  }

  const isCommand = messageIsCommand;
  if (!isCommand) {
    // ---------- Kelime Zinciri oyunu ----------
    // Bu kanalda aktif bir oyun varsa, kanal SADECE oyun için kullanılır:
    // tek kelimelik geçerli denemeler değerlendirilir, uymayan HER mesaj
    // (birden fazla kelime, komut olmayan cümleler vb.) silinir — Nraphy'deki
    // gibi kanal kelime oyununa tahsis edilmiş sayılır.
    if (isGameActive(message.channel.id)) {
      // Bot sahibi, "!kelime izin aç" ile açtığında kelime zinciri kanalına
      // da normal mesaj (duyuru vb.) atabilir — mesajı silinmez, kelime
      // denemesi olarak da sayılmaz. Kapalıyken (varsayılan) bot sahibi de
      // herkes gibi oyuna dahildir.
      const isExempt = message.author.id === OWNER_ID && isOwnerBypassEnabled();
      if (!isExempt) {
        if (!looksLikeWordAttempt(message.content)) {
          await message.delete().catch(() => null);
          return;
        }

        const result = await submitWord(
          message.channel.id,
          message.author.id,
          message.content,
        );
        if (result) {
          if (result.ok) {
            await message.react(EMOJIS.prm3).catch(() => null);
          } else {
            const requiredLetter = getRequiredLetter(message.channel.id);
            const reasonText: Record<typeof result.reason, string> = {
              consecutive:
                "2 kere üst üste sen oynayamazsın, sırayı başkasına bırak.",
              used: "Bu kelime son 4 saat içinde kullanıldı; cooldown bitince yeniden oynanabilir.",
              "wrong-letter": `Kelime \"${requiredLetter ?? ""}\" harfiyle başlamalı.`,
              "invalid-format": "Geçersiz kelime.",
              "not-a-word": "Bu kelime TDK sözlüğünde bulunamadı.",
              "too-short":
                "1, 2 ve 3 harfli kelimeler sayılmaz; en az 4 harfli bir kelime yazmalısın.",
            };
            const notice = await message
              .reply(v2Payload(`${EMOJIS.alert} ${reasonText[result.reason]}`))
              .catch(() => null);
            setTimeout(() => {
              void message.delete().catch(() => null);
              void notice?.delete().catch(() => null);
            }, 1500);
          }
          return;
        }
      }
    }

    const normalizedContent = message.content.trim().toLocaleLowerCase("tr-TR");
    const autoResponse = autoResponses.get(
      autoResponseMapKey(guildId, normalizedContent),
    );
    if (autoResponse) {
      await message
        .reply(v2Payload({
          content: autoResponse.slice(0, 2_000),
          allowedMentions: { parse: [] },
        }))
        .catch(() => null);
    }
    return;
  }

  const args = message.content.slice(guildPrefix.length).trim().split(/\s+/);
  // Registry anahtarları tr-TR locale ile normalize ediliyor (bkz. registry.ts);
  // burada da aynısı kullanılmalı, yoksa içinde "I" geçen bir komut/alias
  // ("I"→"ı" vs "I"→"i") hiçbir zaman eşleşemez.
  const rawCommandName = args.shift();
  const commandName = rawCommandName?.toLocaleLowerCase("tr-TR");
  if (!commandName || !rawCommandName) return;

  // "!!!!", "!?!?", "!!" gibi mesajlar prefix'in kendisinin tekrarından/
  // sembollerden oluşur, gerçek bir komut adı değildir. Bunları sessizce
  // yok sayıyoruz ki kullanıcı sadece ünlem/işaret spam'i yaptığında bot
  // "öyle bir komut yok!" diye anlamsız bir cevap vermesin.
  const looksLikeRealCommandName = /[a-zA-Z0-9çğıöşüÇĞİÖŞÜ]/.test(commandName);
  if (!looksLikeRealCommandName) return;

  // tr-TR normalizasyonu büyük "I"yı "ı" yapar ("!PING"→"pıng"); registry
  // anahtarları değişmeden, bulunamazsa varsayılan locale ile tekrar dene.
  // Son çare: Türkçe karakterleri ASCII'ye indir ("!yardım"→"yardim") ki
  // kullanıcı doğal Türkçe yazımıyla da komuta ulaşabilsin.
  const foldTurkish = (s: string): string =>
    s.replace(/ı/g, "i").replace(/ş/g, "s").replace(/ğ/g, "g")
      .replace(/ü/g, "u").replace(/ö/g, "o").replace(/ç/g, "c");
  const command =
    commands.get(commandName) ??
    commands.get(commandName.toLowerCase()) ??
    commands.get(foldTurkish(commandName));
  if (command) {
    // Genel komut rate-limit (spam / flood koruması). Owner muaf.
    const { checkCommandRateLimit } = await import("../utils/rateLimit.js");
    if (
      !(await checkCommandRateLimit(
        message,
        message.author.id,
        commandName,
      ))
    ) {
      return;
    }

    let success = true;
    try {
      await command.execute(message, args);
    } catch (err) {
      success = false;
      // Ham hata objesini (rawError/requestBody/stack dahil) basmak yerine
      // kısa, okunabilir bir özet + stack basıyoruz — aksi halde Discord API
      // hataları console'u sayfalarca gereksiz JSON ile dolduruyor ve gerçek
      // sebep (örn. "Missing Permissions") kaybolup gidiyor.
      console.error(`${commandName} patladı: ${getErrorMessage(err)}`);
      if (err instanceof Error && err.stack) console.error(err.stack);
      await message
        .reply(v2Payload({
          components: [errorEmbed("Bir Hata Oluştu", getErrorMessage(err))],
        }))
        .catch(() => null);
    }
    void notifyOwnerCommandUsed(message.client, {
      commandName,
      user: message.author,
      guild: message.guild,
      success,
      source: "prefix",
      detail: args.join(" "),
      deniedReason: consumePermissionDenied(message),
    });
    return;
  }

  // ---------- Sunucuya özel custom event'ler ----------
  // Kayıtlar varsayılan toLowerCase() ile tutuluyor (customEvents/store.ts);
  // arama da ham argümandan aynı şekilde yapılmalı — tr-TR ("I"→"ı") eski
  // kayıtları bulamaz hale getirir.
  const customEvent = await getCustomEvent(
    guildId,
    rawCommandName.toLowerCase(),
  ).catch(() => null);
  if (customEvent) {
    {
      const { checkCommandRateLimit } = await import("../utils/rateLimit.js");
      if (
        !(await checkCommandRateLimit(
          message,
          message.author.id,
          `custom:${commandName}`,
        ))
      ) {
        return;
      }
    }

    try {
      const result = await executeCustomEvent(customEvent.code, customEvent, {
        message,
        args,
      });
      if (!result) return;
      if (result.kind === "embed") {
        await message.reply(v2Payload({
          components: [result.embed],
          allowedMentions: { parse: [] },
        }));
      } else if (result.content !== "\u200b") {
        await message.reply(v2Payload({
          content: result.content,
          allowedMentions: { parse: [] },
        }));
      }
    } catch (err) {
      console.error(`custom event patladı (${commandName}):`, err);
      await message
        .reply(v2Payload(`${EMOJIS.error} Bu custom event çalıştırılırken bir hata oluştu.`))
        .catch(() => null);
    }
    return;
  }

  // ---------- Bilinmeyen komut ----------
  // Prefix ile başlayan ama ne kayıtlı komut ne de custom event olan mesajlar
  // için nazik bilgilendirme. Prefix sunucuya özel olduğu için mesajda
  // her zaman o anki prefix gösterilir.
  await message
    .reply(v2Payload({
      content:
        `${EMOJIS.prm1} \`${guildPrefix}${commandName}\` diye bir komut yok!\n` +
        `Komutları görmek için \`${guildPrefix}help\` yazabilirsin.`,
      allowedMentions: { repliedUser: false },
    }))
    .catch(() => null);
}
