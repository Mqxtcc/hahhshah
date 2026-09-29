import { V2CardBuilder } from "../utils/componentsV2.js";
import { v2Payload } from "../utils/messages.js";
import {
  GuildMember,
  Message,
  TextChannel,
} from "discord.js";
import { getGuildConfig, getEffectiveWordList, addStrike } from "./store.js";
import { OWNER_ID } from "../config.js";
import { EMOJIS } from "../utils/emojis.js";

export type AutoModSource = "create" | "edit";
export type AutoModRule = "bannedWords" | "inviteLinks" | "capsLock" | "mentionSpam" | "flood" | "duplicate";

export interface AutoModDetection {
  rule: AutoModRule;
  reason: string;
  detail: string;
  matched?: string;
}

const INVITE_REGEX = /(?:discord\.gg\/|discord(?:app)?\.com\/invite\/)[a-z0-9-]+/i;
const EXPLICIT_MENTION_REGEX = /<@!?\d+>/g;
const LEET_MAP: Record<string, string> = { "4": "a", "@": "a", "3": "e", "1": "i", "!": "i", "0": "o", "5": "s", "$": "s", "7": "t" };
const LETTER_RE = /[a-zçğıöşü]/i;
const VOWELS_RE = /[aeıioöuü]/g;

const recentMessages = new Map<string, Array<{ ts: number; content: string }>>();
const recentMentions = new Map<string, number[]>();
const moderatedContent = new Map<string, { fingerprint: string; ts: number }>();
const FLOOD_WINDOW_MS = 7_000;
const DUPLICATE_WINDOW_MS = 10_000;
const MENTION_WINDOW_MS = 10_000;
const FLOOD_LIMIT = 6;
const DUPLICATE_LIMIT = 4;
const MENTION_LIMIT = 4;

setInterval(() => {
  const now = Date.now();
  for (const [key, items] of recentMessages) {
    const fresh = items.filter((item) => now - item.ts <= DUPLICATE_WINDOW_MS);
    if (fresh.length) recentMessages.set(key, fresh); else recentMessages.delete(key);
  }
  for (const [key, items] of recentMentions) {
    const fresh = items.filter((ts) => now - ts <= MENTION_WINDOW_MS);
    if (fresh.length) recentMentions.set(key, fresh); else recentMentions.delete(key);
  }
  for (const [key, item] of moderatedContent) {
    if (now - item.ts > 5 * 60_000) moderatedContent.delete(key);
  }
}, 60_000).unref?.();

function normalize(text: string): string {
  const deLeet = text.replace(/\S+/g, (token) => {
    if (!LETTER_RE.test(token)) return token;
    return token.replace(/[43107!@$]/g, (char) => LEET_MAP[char] ?? char);
  });
  return deLeet
    .toLocaleLowerCase("tr-TR")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zçğıöşü0-9\s]/gi, " ")
    .replace(/(.)\1{2,}/g, "$1$1")
    .replace(/\s+/g, " ")
    .trim();
}

function skeleton(value: string): string {
  return value.replace(VOWELS_RE, "");
}

// Kelime başına derlenmiş regex + normalize sonucu: her mesajda ~150+ kelime
// için tekrar derleme yapmamak için modül düzeyinde önbellek.
const wordPatternCache = new Map<string, { word: string; flat: string; regex: RegExp }>();

function getWordPattern(original: string): { word: string; flat: string; regex: RegExp } | null {
  const cached = wordPatternCache.get(original);
  if (cached) return cached;
  const word = normalize(original);
  if (!word) return null;
  const flat = word.replace(/\s+/g, "");
  const escaped = flat.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = { word, flat, regex: new RegExp(`(^|[^a-zçğıöşü0-9])${escaped}([^a-zçğıöşü0-9]|$)`, "i") };
  wordPatternCache.set(original, pattern);
  return pattern;
}

/**
 * Listeden çıkarılan kelimelerin derlenmiş kalıplarını önbellekten at —
 * yoksa kaldırılan her kelimenin regex'i sonsuza dek bellekte kalır
 * (bellek sızıntısı).
 */
export function invalidateWordPatterns(words: Iterable<string>): void {
  for (const word of words) wordPatternCache.delete(word);
}

function containsBannedWord(content: string, words: string[], customWords: Set<string>): string | null {
  const normalized = normalize(content);
  if (!normalized) return null;
  const tokens = normalized.split(" ").filter(Boolean);
  const joinedShortTokens = tokens.filter((token) => token.length <= 3).join("");

  for (const original of words) {
    const compiled = getWordPattern(original);
    if (!compiled) continue;
    const { word, flat, regex } = compiled;
    const isCustom = customWords.has(original);
    const customTokens = word.split(" ").filter(Boolean);
    // Kısa argo ifadeleri kelime sınırıyla kontrol et; "koç" gibi masum
    // kelimelerin içindeki tesadüfi alt dizileri engelle.
    if (regex.test(normalized)) return original;
    // Dört+ harfli kelimelerde Türkçe ekleri ve nokta/işaret aralarını yakala.
    if (flat.length >= 4 && joinedShortTokens.includes(flat)) return original;
    if (isCustom && customTokens.length > 1) {
      for (let index = 0; index <= tokens.length - customTokens.length; index += 1) {
        const matches = customTokens.every((part, offset) => {
          const token = tokens[index + offset];
          return offset === customTokens.length - 1
            ? token === part || token.startsWith(part)
            : token === part;
        });
        if (matches) return original;
      }
    }
    if (isCustom && customTokens.length === 1 && flat.length >= 4 && tokens.some((token) => token.startsWith(flat))) return original;
    // Sesli harfleri atarak yazılan yaygın kaçış biçimi: yrrk, skm vb.
    const flatSkeleton = skeleton(flat);
    if (flatSkeleton.length >= 4 && tokens.some((token) => token === flatSkeleton)) return original;
  }
  return null;
}

function isCapsSpam(content: string): boolean {
  const words = content.match(/[a-zçğıöşüA-ZÇĞİÖŞÜ]+/g) ?? [];
  if (words.some((word) => word.length >= 5 && word === word.toLocaleUpperCase("tr-TR"))) return true;
  const letters = content.match(/[a-zçğıöşüA-ZÇĞİÖŞÜ]/g) ?? [];
  if (letters.length < 10) return false;
  return letters.filter((letter) => letter === letter.toLocaleUpperCase("tr-TR")).length / letters.length >= 0.7;
}

function isExempt(member: GuildMember, roleIds: string[], guildOwnerId: string): boolean {
  return member.id === OWNER_ID || member.id === guildOwnerId || roleIds.some((id) => member.roles.cache.has(id));
}

function checkFlood(guildId: string, userId: string, content: string): AutoModDetection | null {
  const key = `${guildId}:${userId}`;
  const now = Date.now();
  const items = [...(recentMessages.get(key) ?? []), { ts: now, content: normalize(content) }]
    .filter((item) => now - item.ts <= DUPLICATE_WINDOW_MS);
  recentMessages.set(key, items);
  const floodCount = items.filter((item) => now - item.ts <= FLOOD_WINDOW_MS).length;
  if (floodCount >= FLOOD_LIMIT) return { rule: "flood", reason: "Flood", detail: "Kısa sürede çok fazla mesaj gönderildi." };
  const duplicateCount = items.filter((item) => item.content && item.content === normalize(content)).length;
  if (duplicateCount >= DUPLICATE_LIMIT) return { rule: "duplicate", reason: "Tekrarlı spam", detail: "Aynı mesaj kısa sürede tekrarlandı." };
  return null;
}

function checkMentions(guildId: string, userId: string, count: number): AutoModDetection | null {
  if (!count) return null;
  const key = `${guildId}:${userId}`;
  const now = Date.now();
  const items = [...(recentMentions.get(key) ?? []), ...Array.from({ length: count }, () => now)]
    .filter((ts) => now - ts <= MENTION_WINDOW_MS);
  recentMentions.set(key, items);
  return items.length >= MENTION_LIMIT
    ? { rule: "mentionSpam", reason: "Etiket spamı", detail: "Kısa sürede çok fazla kullanıcı etiketlendi." }
    : null;
}

export async function detectAutoMod(message: Message): Promise<AutoModDetection | null> {
  if (!message.guild || !message.member || message.author.bot || !message.content) return null;
  const cfg = await getGuildConfig(message.guild.id);
  if (!cfg.enabled || isExempt(message.member, cfg.exemptRoleIds, message.guild.ownerId)) return null;
  if (cfg.bannedWords) {
    const { words, customWords } = await getEffectiveWordList(message.guild.id);
    const hit = containsBannedWord(message.content, words, customWords);
    if (hit) return { rule: "bannedWords", reason: "Yasaklı kelime", detail: "Yasaklı ifade tespit edildi.", matched: hit };
  }
  if (cfg.inviteLinks && !cfg.inviteAllowedChannelIds.includes(message.channel.id) && INVITE_REGEX.test(message.content)) {
    return { rule: "inviteLinks", reason: "Discord davet linki", detail: "Bu sunucuda davet linki paylaşımı yasak." };
  }
  if (cfg.capsLock && isCapsSpam(message.content)) {
    return { rule: "capsLock", reason: "Caps spamı", detail: "Mesajın büyük bölümü büyük harflerle yazılmış." };
  }
  if (cfg.spamFlood) {
    const mentionResult = checkMentions(message.guild.id, message.author.id, (message.content.match(EXPLICIT_MENTION_REGEX) ?? []).length);
    if (mentionResult) return mentionResult;
    const floodResult = checkFlood(message.guild.id, message.author.id, message.content);
    if (floodResult) return floodResult;
  }
  return null;
}

export async function handleAutoModMessage(message: Message, source: AutoModSource = "create"): Promise<boolean> {
  if (!message.guild || !message.member || message.author.bot || !message.content) return false;
  const fingerprint = normalize(message.content);
  const messageKey = `${message.guild.id}:${message.id}`;
  const previous = moderatedContent.get(messageKey);
  // Discord bazen aynı edit olayını birden fazla iletir; aynı içeriğe ikinci
  // kez strike vermek yerine yalnızca ilk tespiti uygula.
  if (source === "edit" && previous?.fingerprint === fingerprint) return true;
  const detection = await detectAutoMod(message);
  if (!detection) return false;
  moderatedContent.set(messageKey, { fingerprint, ts: Date.now() });

  const deleted = await message.delete().catch(() => null);
  if (!deleted) {
    // Mesaj silinemedi (bot yetkisi/hiyerarşi sorunu): strike ekleme,
    // timeout atma — aksi halde mesaj dururken ceza uygulanıp log
    // yanıltıcı olur.
    const cfg = await getGuildConfig(message.guild.id);
    if (cfg.logChannelId) {
      try {
        const channel = await message.guild.channels.fetch(cfg.logChannelId);
        if (channel?.isTextBased()) {
          await (channel as TextChannel).send(v2Payload({ components: [new V2CardBuilder()
            .setColor(0xed4245)
            .setTitle("Otomod uyarısı")
            .setDescription("Mesaj silinemedi — bot yetkisini/hiyerarşiyi kontrol et.")
            .addFields(
              { name: "Kullanıcı", value: `${message.author} (${message.author.id})`, inline: true },
              { name: "Kural", value: detection.reason, inline: true },
              { name: "Kanal", value: `${message.channel}`, inline: true },
            ).setTimestamp()] }));
        }
      } catch (error) { console.error("otomod log gitmedi:", error); }
    }
    return false;
  }
  const cfg = await getGuildConfig(message.guild.id);
  const strike = await addStrike(message.guild.id, message.author.id);
  const shouldTimeout = strike.count >= cfg.strikesBeforeTimeout;
  let timeoutLabel: string | null = null;
  let timeoutFailed = false;
  if (shouldTimeout && message.member.moderatable) {
    const minutes = Math.min(cfg.baseTimeoutMinutes * 2 ** (strike.count - cfg.strikesBeforeTimeout), cfg.maxTimeoutMinutes);
    try {
      await message.member.timeout(minutes * 60_000, `Otomod: ${detection.reason}`);
      timeoutLabel = `${minutes} dakika timeout`;
    } catch (error) {
      timeoutFailed = true;
      console.error("otomod timeout işlemedi:", error);
    }
  } else if (shouldTimeout) timeoutFailed = true;

  const sourceLabel = source === "edit" ? "düzenlenmiş mesaj" : "mesaj";
  const notice = timeoutLabel
    ? `${EMOJIS.timeout} **${message.author}** • ${detection.reason} (${sourceLabel}) | ${timeoutLabel}`
    : `${EMOJIS.alert} **${message.author}** • ${detection.reason} (${sourceLabel}) | ${strike.count}/${cfg.strikesBeforeTimeout} ihlal${timeoutFailed ? " — timeout uygulanamadı" : ""}`;
  if (message.channel.isSendable()) {
    const sent = await message.channel.send(v2Payload(notice)).catch(() => null);
    if (sent) setTimeout(() => void sent.delete().catch(() => null), 6_000);
  }
  if (cfg.logChannelId) {
    try {
      const channel = await message.guild.channels.fetch(cfg.logChannelId);
      if (channel?.isTextBased()) {
        await (channel as TextChannel).send(v2Payload({ components: [new V2CardBuilder()
          .setColor(timeoutLabel ? 0xed4245 : 0xd0a840)
          .setTitle("Otomod işlemi")
          .addFields(
            { name: "Kaynak", value: sourceLabel, inline: true },
            { name: "Kullanıcı", value: `${message.author} (${message.author.id})`, inline: true },
            { name: "Kural", value: detection.reason, inline: true },
            { name: "İhlal", value: `${strike.count}`, inline: true },
            { name: "İçerik", value: message.content.slice(0, 1000) || "-", inline: false },
          ).setTimestamp()] }));
      }
    } catch (error) { console.error("otomod log gitmedi:", error); }
  }
  return true;
}

export { containsBannedWord, isCapsSpam };
