import { ChannelType, type Client, type Guild } from "discord.js";
import { eq } from "../db/jsonOrm.js";
import { db, counterTable } from "../db/index.js";

// ---------------------------------------------------------------------------
// 📊 Sayaç deposu + kanal adı güncelleyici.
// Üye giriş/çıkışında ve açılışta kanal adı tazelenir.
// ---------------------------------------------------------------------------

export async function getCounter(guildId: string): Promise<{ channelId: string; target: number } | null> {
  const rows = await db.select().from(counterTable).where(eq(counterTable.guildId, guildId));
  const r = rows[0];
  return r ? { channelId: r.channelId, target: r.target } : null;
}

export async function setCounter(guildId: string, channelId: string, target: number): Promise<void> {
  await db
    .insert(counterTable)
    .values({ guildId, channelId, target })
    .onConflictDoUpdate({ target: counterTable.guildId, set: { channelId, target } });
}

export async function clearCounter(guildId: string): Promise<void> {
  await db.delete(counterTable).where(eq(counterTable.guildId, guildId)).catch(() => null);
}

export function counterChannelName(memberCount: number, target: number): string {
  return `👥 Üye: ${memberCount}/${target}`;
}

async function refreshGuildCounter(client: Client, guild: Guild): Promise<void> {
  const cfg = await getCounter(guild.id).catch(() => null);
  if (!cfg) return;
  const channel = guild.channels.cache.get(cfg.channelId);
  if (!channel || channel.type !== ChannelType.GuildVoice) {
    // Kanal silinmişse kaydı temizle, ölü veri bırakma.
    await clearCounter(guild.id);
    console.log(`[sayaç] ${guild.id}: kanal yok, kayıt silindi`);
    return;
  }
  const want = counterChannelName(guild.memberCount, cfg.target);
  if (channel.name !== want) {
    await channel.setName(want, "Sayaç güncellendi").catch((err) => {
      console.error("[sayaç] kanal adı tutmadı:", err);
    });
  }
}

/** Üye giriş/çıkışında çağrılır. */
export async function refreshCounterFor(client: Client, guildId: string): Promise<void> {
  const guild = client.guilds.cache.get(guildId);
  if (!guild) return;
  await refreshGuildCounter(client, guild).catch((err) => {
    console.error("[sayaç] tazeleme patladı:", err);
  });
}

/** Açılışta tüm sayaçları tazele (restart sonrası isimler güncel kalsın). */
export async function reconcileAllCounters(client: Client): Promise<void> {
  const rows = await db.select().from(counterTable).catch(() => []);
  let done = 0;
  for (const row of rows) {
    const guild = client.guilds.cache.get(row.guildId);
    if (!guild) continue;
    await refreshGuildCounter(client, guild).catch(() => null);
    done++;
  }
  if (done > 0) console.log(`[sayaç] açılışta ${done} sayaç tazelendi`);
}
