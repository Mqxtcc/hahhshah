import {
  ChannelType,
  Collection,
  Guild,
  Message,
  PermissionFlagsBits,
  TextChannel,
} from "discord.js";
import { getErrorMessage } from "./errors.js";

const BULK_DELETE_LIMIT_MS = 14 * 24 * 60 * 60 * 1000; // Discord'un toplu silme sınırı: 14 gün
const INDIVIDUAL_DELETE_DELAY_MS = 350; // Rate limit'e takılmamak için eski mesajlar arası bekleme

/**
 * Bir sunucudaki, botun erişebildiği tüm metin kanallarını tarar ve
 * belirtilen kullanıcıya ait mesajları siler.
 *
 * 14 günden yeni mesajlar toplu (bulkDelete) silinir, daha eski mesajlar
 * Discord API kısıtı nedeniyle tek tek silinir (bu yüzden çok eski/çok
 * mesajlı kullanıcılarda işlem biraz sürebilir).
 *
 * @returns silinen toplam mesaj sayısı
 */
export async function purgeUserMessages(guild: Guild, userId: string): Promise<number> {
  const me = guild.members.me;
  if (!me) return 0;

  const channels = guild.channels.cache.filter((ch): ch is TextChannel => {
    if (ch.type !== ChannelType.GuildText && ch.type !== ChannelType.GuildAnnouncement) {
      return false;
    }
    const perms = ch.permissionsFor(me);
    return (
      perms?.has([
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.ManageMessages,
      ]) ?? false
    );
  }) as Collection<string, TextChannel>;

  let totalDeleted = 0;

  for (const channel of channels.values()) {
    try {
      totalDeleted += await purgeChannel(channel, userId);
    } catch (err) {
      // Ham obje yerine kısa mesaj: çok kanallı sunucularda her kanal için
      // ayrı bir hata olabileceğinden ham dump konsolu hızla şişiriyordu.
      console.error(`[temizle] #${channel.name} patladı: ${getErrorMessage(err)}`);
    }
  }

  return totalDeleted;
}

async function purgeChannel(channel: TextChannel, userId: string): Promise<number> {
  let deleted = 0;
  let beforeId: string | undefined;

  // Kanalın tüm geçmişini baştan sona (yeni -> eski) tarar
  while (true) {
    const batch = await channel.messages
      .fetch({ limit: 100, before: beforeId })
      .catch(() => new Collection<string, Message>());

    if (batch.size === 0) break;
    beforeId = batch.last()!.id;

    const targetMessages = batch.filter((m) => m.author.id === userId && m.deletable);

    if (targetMessages.size > 0) {
      const now = Date.now();
      const recent = targetMessages.filter((m) => now - m.createdTimestamp < BULK_DELETE_LIMIT_MS);
      const old = targetMessages.filter((m) => now - m.createdTimestamp >= BULK_DELETE_LIMIT_MS);

      if (recent.size === 1) {
        await recent.first()!.delete().catch(() => null);
        deleted += 1;
      } else if (recent.size > 1) {
        const res = await channel.bulkDelete(recent, true).catch(() => null);
        deleted += res?.size ?? 0;
      }

      for (const msg of old.values()) {
        await msg.delete().catch(() => null);
        deleted += 1;
        await sleep(INDIVIDUAL_DELETE_DELAY_MS);
      }
    }

    if (batch.size < 100) break; // kanalın başına gelindi
  }

  return deleted;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
