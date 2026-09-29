import { V2CardBuilder } from "./componentsV2.js";
import { v2Payload } from "./messages.js";
import { AttachmentBuilder, AuditLogEvent, type Guild, type GuildTextBasedChannel } from "discord.js";
import { eq } from "../db/jsonOrm.js";
import { db } from "../db/index.js";
import { botSettingsTable } from "../db/schema.js";
import { BOT_NAME } from "../config.js";

// ---------------------------------------------------------------------------
// LOG SİSTEMİ — ÇEKİRDEK
// ---------------------------------------------------------------------------
// Her sunucu, her log kategorisi için ayrı bir kanal seçebilir (esnek/panel
// tipi yapı). Kategori başına kanal, mevcut generic key-value tablosu olan
// botSettingsTable'da tutuluyor (yeni tabloya gerek yok):
//   key   = "log_channel:<guildId>:<kategori>"
//   value = kanal ID'si
//
// Bu sayede hem !logkanal komutuyla hem de ileride panel.ts'e eklenecek
// buton/select menü akışıyla AYNI fonksiyonlar (setLogChannel/getLogChannelId)
// kullanılabilir — tek doğru kaynak burası.
// ---------------------------------------------------------------------------

export type LogCategory = "mesaj" | "uyari" | "giris-cikis" | "ses" | "rol" | "kanal";

export const LOG_CATEGORIES: { id: LogCategory; label: string; emoji: string; ornek: string }[] = [
  { id: "mesaj", label: "Mesaj Logları", emoji: "🗑️", ornek: "silinen/düzenlenen mesajlar" },
  { id: "uyari", label: "Uyarı Logları", emoji: "🚨", ornek: "ban/kick/warn/unban/timeout bildirimleri" },
  { id: "giris-cikis", label: "Giriş-Çıkış Logları", emoji: "🚪", ornek: "sunucuya katılan/ayrılanlar" },
  { id: "ses", label: "Ses Kanalı Logları", emoji: "🔊", ornek: "ses kanalına giriş/çıkış/taşınma" },
  { id: "rol", label: "Rol Logları", emoji: "🎭", ornek: "rol oluşturma/silme/güncelleme" },
  { id: "kanal", label: "Kanal Logları", emoji: "📁", ornek: "kanal oluşturma/silme/güncelleme" },
];

const LOG_CHANNEL_KEY_PREFIX = "log_channel:";

// Her mesajda/DB'ye gitmemek için kanal ID'leri bellekte önbelleğe alınıyor.
// setLogChannel çağrıldığında ilgili giriş güncellenir, böylece stale cache olmaz.
const logChannelCache = new Map<string, string | null>(); // `${guildId}:${category}` -> channelId | null

function cacheKey(guildId: string, category: LogCategory): string {
  return `${guildId}:${category}`;
}

function settingKey(guildId: string, category: LogCategory): string {
  return `${LOG_CHANNEL_KEY_PREFIX}${guildId}:${category}`;
}

/** Bir sunucunun bir log kategorisi için kanalını ayarlar. `channelId: null` verilirse o kategori kapatılır. */
export async function setLogChannel(guildId: string, category: LogCategory, channelId: string | null): Promise<void> {
  const key = settingKey(guildId, category);
  try {
    if (channelId === null) {
      await db.delete(botSettingsTable).where(eq(botSettingsTable.key, key));
    } else {
      await db
        .insert(botSettingsTable)
        .values({ key, value: channelId })
        .onConflictDoUpdate({
          target: botSettingsTable.key,
          set: { value: channelId, updatedAt: new Date() },
        });
    }
    logChannelCache.set(cacheKey(guildId, category), channelId);
  } catch (err) {
    console.error(`log kanalı ayarlanamadı (${category}):`, err);
    throw err;
  }
}

/** Bir sunucunun bir log kategorisi için ayarlı kanal ID'sini döner (yoksa null). */
export async function getLogChannelId(guildId: string, category: LogCategory): Promise<string | null> {
  const ck = cacheKey(guildId, category);
  if (logChannelCache.has(ck)) return logChannelCache.get(ck)!;

  try {
    const rows = await db.select().from(botSettingsTable).where(eq(botSettingsTable.key, settingKey(guildId, category))).limit(1);
    const channelId = rows[0]?.value ?? null;
    logChannelCache.set(ck, channelId);
    return channelId;
  } catch (err) {
    console.error(`log kanalı okunamadı (${category}):`, err);
    return null;
  }
}

/** Bir sunucudaki tüm kategorilerin ayarlı kanallarını tek seferde döner (!logdurum için). */
export async function getAllLogChannels(guildId: string): Promise<Record<LogCategory, string | null>> {
  const entries = await Promise.all(LOG_CATEGORIES.map(async (c) => [c.id, await getLogChannelId(guildId, c.id)] as const));
  return Object.fromEntries(entries) as Record<LogCategory, string | null>;
}

async function resolveLogChannel(guild: Guild, category: LogCategory): Promise<GuildTextBasedChannel | null> {
  const channelId = await getLogChannelId(guild.id, category);
  if (!channelId) return null;
  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isTextBased()) return null;
  return channel as GuildTextBasedChannel;
}

/** İlgili kategori için kanal ayarlıysa embed'i (opsiyonel dosya ekleriyle) oraya gönderir; ayarlı değilse sessizce hiçbir şey yapmaz. */
export async function sendLog(
  guild: Guild,
  category: LogCategory,
  embed: V2CardBuilder,
  files?: AttachmentBuilder[],
): Promise<void> {
  const channel = await resolveLogChannel(guild, category);
  if (!channel) return;
  await channel.send(v2Payload({
    components: [embed],
    files: files && files.length ? files : undefined,
    // Loglarda görünen <@id> metinleri ping bildirimi göndermesin.
    allowedMentions: { parse: [] },
  })).catch(() => null);
}

// ---------------------------------------------------------------------------
// Audit log yardımcıları — "kim yaptı" bilgisini eklemek için. Bot'ta
// "Denetim Günlüğünü Görüntüle" izni yoksa ya da Discord henüz kaydı
// oluşturmadıysa sessizce null döner; log akışını asla kesmez.
// ---------------------------------------------------------------------------

/** Belirli bir hedefe (kullanıcı/kanal/rol/mesaj) ait en yeni audit log kaydının failini bulur. */
export async function findAuditExecutor(
  guild: Guild,
  type: AuditLogEvent,
  targetId: string,
  withinMs = 10_000,
): Promise<string | null> {
  try {
    const logs = await guild.fetchAuditLogs({ type, limit: 5 });
    const entry = logs.entries.find((e) => e.target && "id" in e.target && e.target.id === targetId && Date.now() - e.createdTimestamp < withinMs);
    return entry?.executor ? `<@${entry.executor.id}> (\`${entry.executor.tag}\`)` : null;
  } catch {
    return null;
  }
}

/** guildMemberRemove olayının ban/kick/kendi isteğiyle ayrılma ayrımını audit log'dan çıkarır. */
export async function classifyMemberRemoval(
  guild: Guild,
  userId: string,
): Promise<{ type: "ban" | "kick" | "ayrildi"; executor: string | null }> {
  try {
    const kickLogs = await guild.fetchAuditLogs({ type: AuditLogEvent.MemberKick, limit: 5 });
    const kickEntry = kickLogs.entries.find((e) => e.target && "id" in e.target && e.target.id === userId && Date.now() - e.createdTimestamp < 10_000);
    if (kickEntry) {
      return { type: "kick", executor: kickEntry.executor ? `<@${kickEntry.executor.id}> (\`${kickEntry.executor.tag}\`)` : null };
    }
  } catch {
    /* izin yok ya da hata — normal ayrılma sayılır */
  }
  return { type: "ayrildi", executor: null };
}

// ---------------------------------------------------------------------------
// Ortak embed iskeleti
// ---------------------------------------------------------------------------

export function baseLogEmbed(color: number, title: string): V2CardBuilder {
  return new V2CardBuilder()
    .setColor(color)
    .setTitle(title)
    .setFooter({ text: `${BOT_NAME} • Log Sistemi` })
    .setTimestamp();
}

/** Uzun metinleri (mesaj içeriği vb.) embed alan limitine göre güvenli şekilde kırpar. */
export function truncate(text: string, max = 1000): string {
  if (!text) return "*(boş)*";
  return text.length > max ? text.slice(0, max) + "… *(kırpıldı)*" : text;
}

export const LOG_COLORS = {
  mesajSil: 0xed4245,
  mesajDuzenle: 0xfee75c,
  uyeGiris: 0x57f287,
  uyeCikis: 0x99aab5,
  ban: 0x992d22,
  unban: 0x2ecc71,
  kick: 0xe67e22,
  timeout: 0xeb459e,
  rolKanal: 0xd0a840,
  ses: 0x3498db,
} as const;
