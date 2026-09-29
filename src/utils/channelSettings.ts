import { eq } from "../db/jsonOrm.js";
import { db } from "../db/index.js";
import { botSettingsTable } from "../db/schema.js";

// ---------------------------------------------------------------------------
// AYAR SİSTEMİ — TEK KANALLI, LOG KATEGORİSİ OLMAYAN AYARLAR
// ---------------------------------------------------------------------------
// utils/logger.ts'teki LOG_CATEGORIES listesi panel.ts'te "Log Kanalları"
// görünümünde her kategori için bir seçim menüsü (action row) açıyor.
// Discord bir mesajda en fazla 5 action row'a izin veriyor ve o görünüm
// zaten (1 geri butonu + 4 kategori menüsü =) 5 satırla dolu — yeni bir
// log kategorisi oraya eklenemez.
//
// Bu yüzden "log" sayılmayan ama yine de sunucuya özel TEK bir kanala
// ihtiyaç duyan ayarlar (ör. ceza duyuruları) burada,
// ayrı bir küçük panel alt-görünümünde ("Diğer Kanallar") yönetiliyor.
// Aynı botSettingsTable'ı kullanıyor, sadece farklı bir key prefix'iyle —
// yeni tabloya gerek yok. İleride benzer "tek kanal" ihtiyaçları çıkarsa
// CHANNEL_SETTINGS listesine eklemek yeterli.
// ---------------------------------------------------------------------------

export type ChannelSettingId = "ceza";

export const CHANNEL_SETTINGS: { id: ChannelSettingId; label: string; emoji: string; ornek: string }[] = [
  { id: "ceza", label: "Ceza Logları", emoji: "🚨", ornek: "ban/kick/warn/unban/nick bildirimleri" },
];

const KEY_PREFIX = "channel_setting:";

// setLogChannel/getLogChannelId'deki aynı önbellek deseni.
const settingCache = new Map<string, string | null>(); // `${guildId}:${id}` -> channelId | null

function cacheKey(guildId: string, id: ChannelSettingId): string {
  return `${guildId}:${id}`;
}

function settingKey(guildId: string, id: ChannelSettingId): string {
  return `${KEY_PREFIX}${guildId}:${id}`;
}

/** Bir sunucunun bir kanal ayarını değiştirir. `channelId: null` verilirse ayar kaldırılır. */
export async function setChannelSetting(guildId: string, id: ChannelSettingId, channelId: string | null): Promise<void> {
  const key = settingKey(guildId, id);
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
    settingCache.set(cacheKey(guildId, id), channelId);
  } catch (err) {
    console.error(`kanal ayarı kaydolmadı (${id}):`, err);
    throw err;
  }
}

/** Bir sunucunun bir kanal ayarını döner (ayarlı değilse null). */
export async function getChannelSetting(guildId: string, id: ChannelSettingId): Promise<string | null> {
  const ck = cacheKey(guildId, id);
  if (settingCache.has(ck)) return settingCache.get(ck)!;

  try {
    const rows = await db.select().from(botSettingsTable).where(eq(botSettingsTable.key, settingKey(guildId, id))).limit(1);
    const channelId = rows[0]?.value ?? null;
    settingCache.set(ck, channelId);
    return channelId;
  } catch (err) {
    console.error(`kanal ayarı okunamadı (${id}):`, err);
    return null;
  }
}

/** Bir sunucudaki tüm ayarların ayarlı kanallarını tek seferde döner (panel görünümü için). */
export async function getAllChannelSettings(guildId: string): Promise<Record<ChannelSettingId, string | null>> {
  const entries = await Promise.all(CHANNEL_SETTINGS.map(async (c) => [c.id, await getChannelSetting(guildId, c.id)] as const));
  return Object.fromEntries(entries) as Record<ChannelSettingId, string | null>;
}
