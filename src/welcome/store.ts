import { eq } from "../db/jsonOrm.js";
import { db, welcomeConfigTable } from "../db/index.js";

export interface GuildWelcomeConfig {
  enabled: boolean;
  channelId: string | null;
  message: string | null;
  // Üye sunucudan ayrıldığında aynı kanala atılacak mesaj. Opsiyoneldir;
  // null ise ayrılış mesajı gönderilmez (sadece hoşgeldin gönderilir).
  leaveMessage: string | null;
  // Giriş/çıkış mesajının altına eklenen resim URL'si (opsiyonel). Bkz.
  // welcome/panel.ts — "Giriş Görseli"/"Çıkış Görseli" butonları.
  welcomeImage: string | null;
  leaveImage: string | null;
}

export const DEFAULT_WELCOME_MESSAGE =
  "Hoşgeldin {kullanici}, seninle beraber **{n}** kişi olduk!";

const DEFAULTS: GuildWelcomeConfig = {
  enabled: false,
  channelId: null,
  message: null,
  leaveMessage: null,
  welcomeImage: null,
  leaveImage: null,
};

function rowToConfig(row: typeof welcomeConfigTable.$inferSelect): GuildWelcomeConfig {
  return {
    enabled: row.enabled,
    channelId: row.channelId,
    message: row.message,
    leaveMessage: row.leaveMessage,
    welcomeImage: row.welcomeImage,
    leaveImage: row.leaveImage,
  };
}

// automod/store.ts'deki ile aynı desen: her mesajda DB'ye gitmemek için kısa
// ömürlü bellek-içi cache. updateGuildConfig çağrıldığında cache hemen
// güncellenir; başka bir process'ten değişirse en geç CACHE_TTL_MS sonra
// fark edilir.
const cache = new Map<string, { cfg: GuildWelcomeConfig; ts: number }>();
const CACHE_TTL_MS = 30_000;
const configUpdateQueues = new Map<string, Promise<GuildWelcomeConfig>>();

export async function getGuildWelcomeConfig(guildId: string): Promise<GuildWelcomeConfig> {
  const cached = cache.get(guildId);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.cfg;

  const rows = await db
    .select()
    .from(welcomeConfigTable)
    .where(eq(welcomeConfigTable.guildId, guildId));

  let cfg: GuildWelcomeConfig;
  if (rows[0]) {
    cfg = rowToConfig(rows[0]);
  } else {
    await db.insert(welcomeConfigTable).values({ guildId }).onConflictDoNothing();
    cfg = { ...DEFAULTS };
  }

  cache.set(guildId, { cfg, ts: Date.now() });
  return cfg;
}

export function updateGuildWelcomeConfig(
  guildId: string,
  patch: Partial<GuildWelcomeConfig>,
): Promise<GuildWelcomeConfig> {
  const previous = configUpdateQueues.get(guildId);
  const base = previous ? previous.catch(() => getGuildWelcomeConfig(guildId)) : getGuildWelcomeConfig(guildId);
  let update!: Promise<GuildWelcomeConfig>;
  update = base.then(async (current) => {
    const merged: GuildWelcomeConfig = { ...current, ...patch };
    const values = {
      guildId,
      enabled: merged.enabled,
      channelId: merged.channelId,
      message: merged.message,
      leaveMessage: merged.leaveMessage,
      welcomeImage: merged.welcomeImage,
      leaveImage: merged.leaveImage,
      updatedAt: new Date(),
    };

    await db
      .insert(welcomeConfigTable)
      .values(values)
      .onConflictDoUpdate({ target: welcomeConfigTable.guildId, set: values });

    cache.set(guildId, { cfg: merged, ts: Date.now() });
    return merged;
  });
  configUpdateQueues.set(guildId, update);
  void update.then(
    () => { if (configUpdateQueues.get(guildId) === update) configUpdateQueues.delete(guildId); },
    () => { if (configUpdateQueues.get(guildId) === update) configUpdateQueues.delete(guildId); },
  );
  return update;
}
