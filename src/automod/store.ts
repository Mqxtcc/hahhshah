import { eq } from "../db/jsonOrm.js";
import { db, automodConfigTable, automodStrikesTable } from "../db/index.js";
import { ALL_DEFAULT_BANNED_WORDS } from "./wordlist.js";

export interface GuildAutomodConfig {
  enabled: boolean;
  bannedWords: boolean;
  inviteLinks: boolean;
  spamFlood: boolean;
  capsLock: boolean; // büyük harf (caps) koruması
  wordList: string[]; // varsayılan listeye ek olarak sunucuya özel kelimeler
  removedDefaults: string[]; // varsayılan listeden çıkarılmış kelimeler
  inviteAllowedChannelIds: string[]; // bu kanallarda davet linki kontrolü uygulanmaz (ör. #partner)
  exemptRoleIds: string[]; // bu rollerden birine sahip üyeler otomodun tamamından muaf (admin/owner gibi)
  logChannelId: string | null;
  strikesBeforeTimeout: number;
  baseTimeoutMinutes: number;
  maxTimeoutMinutes: number;
  strikeResetMinutes: number;
}

const MAX_CUSTOM_WORDS = 500;
const MAX_WORD_LENGTH = 64;

/** Ekleme/silme işlemlerinde kullanıcı yazım farklarını yok sayan anahtar. */
export function normalizeCustomWord(value: string): string {
  return value
    .trim()
    .replace(/\s+/g, " ")
    .toLocaleLowerCase("tr-TR");
}

const DEFAULTS: GuildAutomodConfig = {
  enabled: false,
  bannedWords: false,
  inviteLinks: false,
  spamFlood: false,
  capsLock: false,
  wordList: [],
  removedDefaults: [],
  inviteAllowedChannelIds: [],
  exemptRoleIds: [],
  logChannelId: null,
  strikesBeforeTimeout: 3,
  baseTimeoutMinutes: 1,
  maxTimeoutMinutes: 60,
  strikeResetMinutes: 30,
};

function safeParseArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? [...new Set(parsed
          .filter((x): x is string => typeof x === "string")
          .map((x) => x.trim().slice(0, MAX_WORD_LENGTH))
          .filter(Boolean))].slice(0, MAX_CUSTOM_WORDS)
      : [];
  } catch {
    return [];
  }
}

function boundedInteger(value: number, fallback: number, min: number, max: number): number {
  return Number.isInteger(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

function rowToConfig(row: typeof automodConfigTable.$inferSelect): GuildAutomodConfig {
  const baseTimeoutMinutes = boundedInteger(row.baseTimeoutMinutes, DEFAULTS.baseTimeoutMinutes, 1, 40_320);
  const maxTimeoutMinutes = boundedInteger(row.maxTimeoutMinutes, DEFAULTS.maxTimeoutMinutes, baseTimeoutMinutes, 40_320);
  return {
    enabled: row.enabled,
    bannedWords: row.bannedWords,
    inviteLinks: row.inviteLinks,
    spamFlood: row.spamFlood,
    capsLock: row.capsLock,
    wordList: safeParseArray(row.wordList),
    removedDefaults: safeParseArray(row.removedDefaults),
    inviteAllowedChannelIds: safeParseArray(row.inviteAllowedChannelIds),
    exemptRoleIds: safeParseArray(row.exemptRoleIds),
    logChannelId: row.logChannelId,
    strikesBeforeTimeout: boundedInteger(row.strikesBeforeTimeout, DEFAULTS.strikesBeforeTimeout, 1, 100),
    baseTimeoutMinutes,
    maxTimeoutMinutes,
    strikeResetMinutes: boundedInteger(row.strikeResetMinutes, DEFAULTS.strikeResetMinutes, 1, 10_080),
  };
}

// Küçük bir bellek-içi cache: her mesajda DB'ye gitmemek için. updateGuildConfig
// çağrıldığında cache güncellenir; başka bir process'ten değişirse en geç
// CACHE_TTL_MS sonra fark edilir.
const cache = new Map<string, { cfg: GuildAutomodConfig; ts: number }>();
const CACHE_TTL_MS = 30_000;
const effectiveWordCache = new Map<string, { cfg: GuildAutomodConfig; words: string[]; customWords: Set<string> }>();
const configLoads = new Map<string, Promise<GuildAutomodConfig>>();
const configUpdateQueues = new Map<string, Promise<GuildAutomodConfig>>();

/** Bot açılışında çağrılır; ilk mesaj/komut DB sorgusunu beklemez. */
export async function warmAutomodConfigCache(): Promise<void> {
  const rows = await db.select().from(automodConfigTable);
  const timestamp = Date.now();
  for (const row of rows) cache.set(row.guildId, { cfg: rowToConfig(row), ts: timestamp });
}

async function loadGuildConfig(guildId: string): Promise<GuildAutomodConfig> {
  const rows = await db
    .select()
    .from(automodConfigTable)
    .where(eq(automodConfigTable.guildId, guildId));

  let cfg: GuildAutomodConfig;
  if (rows[0]) {
    cfg = rowToConfig(rows[0]);
  } else {
    await db.insert(automodConfigTable).values({ guildId }).onConflictDoNothing();
    cfg = { ...DEFAULTS };
  }
  cache.set(guildId, { cfg, ts: Date.now() });
  effectiveWordCache.delete(guildId);
  return cfg;
}

export async function getGuildConfig(guildId: string): Promise<GuildAutomodConfig> {
  const cached = cache.get(guildId);
  if (cached) {
    // Mesaj/komut yolunu DB gecikmesine bağlama. Süresi dolmuş ayar güvenle
    // kullanılmaya devam eder; yenileme arka planda yapılır.
    if (Date.now() - cached.ts >= CACHE_TTL_MS && !configLoads.has(guildId)) {
      const refresh = loadGuildConfig(guildId).catch((error: unknown) => {
        console.error(`[otomod] ayar yenilenemedi (${guildId}):`, error);
        return cached.cfg;
      }).finally(() => {
        if (configLoads.get(guildId) === refresh) configLoads.delete(guildId);
      });
      configLoads.set(guildId, refresh);
    }
    return cached.cfg;
  }

  const inFlight = configLoads.get(guildId);
  if (inFlight) return inFlight;
  const load = loadGuildConfig(guildId).finally(() => {
    if (configLoads.get(guildId) === load) configLoads.delete(guildId);
  });
  configLoads.set(guildId, load);
  return load;
}

export function updateGuildConfig(
  guildId: string,
  patch: Partial<GuildAutomodConfig>,
): Promise<GuildAutomodConfig> {
  const previous = configUpdateQueues.get(guildId);
  const base = previous ? previous.catch(() => getGuildConfig(guildId)) : getGuildConfig(guildId);
  let update!: Promise<GuildAutomodConfig>;
  update = base.then(async (current) => {
    const merged: GuildAutomodConfig = { ...current, ...patch };
    merged.maxTimeoutMinutes = Math.max(merged.baseTimeoutMinutes, merged.maxTimeoutMinutes);
    if (patch.wordList !== undefined) {
      // Listeden çıkarılan kelimelerin derlenmiş regex'leri önbellekte
      // kalmasın (bellek sızıntısı). Döngüsel import'tan kaçınmak için dinamik.
      const next = new Set(merged.wordList);
      const removed = current.wordList.filter((word) => !next.has(word));
      if (removed.length > 0) {
        const { invalidateWordPatterns } = await import("./automod.js");
        invalidateWordPatterns(removed);
      }
    }
    const values = {
      guildId,
      enabled: merged.enabled,
      bannedWords: merged.bannedWords,
      inviteLinks: merged.inviteLinks,
      spamFlood: merged.spamFlood,
      capsLock: merged.capsLock,
      wordList: JSON.stringify(merged.wordList),
      removedDefaults: JSON.stringify(merged.removedDefaults),
      inviteAllowedChannelIds: JSON.stringify(merged.inviteAllowedChannelIds),
      exemptRoleIds: JSON.stringify(merged.exemptRoleIds),
      logChannelId: merged.logChannelId,
      strikesBeforeTimeout: merged.strikesBeforeTimeout,
      baseTimeoutMinutes: merged.baseTimeoutMinutes,
      maxTimeoutMinutes: merged.maxTimeoutMinutes,
      strikeResetMinutes: merged.strikeResetMinutes,
      updatedAt: new Date(),
    };

    await db
      .insert(automodConfigTable)
      .values(values)
      .onConflictDoUpdate({ target: automodConfigTable.guildId, set: values });

    cache.set(guildId, { cfg: merged, ts: Date.now() });
    effectiveWordCache.delete(guildId);
    return merged;
  });
  configUpdateQueues.set(guildId, update);
  void update.then(
    () => { if (configUpdateQueues.get(guildId) === update) configUpdateQueues.delete(guildId); },
    () => { if (configUpdateQueues.get(guildId) === update) configUpdateQueues.delete(guildId); },
  );
  return update;
}

export interface EffectiveWordList {
  words: string[];
  // Sunucuya özel `!otomod kelime-ekle` ile eklenmiş kelimeler. Varsayılan
  // listeden farklı olarak bunlar için TÜM Türkçe çekim biçimleri elle
  // girilmemiştir (admin sadece tek bir kök/kelime yazar) — bu yüzden
  // automod.ts bu kelimeler için ekstra bir "önek eşleşmesi" uygular
  // (bkz. containsBannedWord). Bkz. addStrike/handleAutoModMessage.
  customWords: Set<string>;
}

export async function getEffectiveWordList(guildId: string): Promise<EffectiveWordList> {
  const cfg = await getGuildConfig(guildId);
  const cached = effectiveWordCache.get(guildId);
  if (cached?.cfg === cfg) return { words: cached.words, customWords: cached.customWords };

  // Türkçe + İngilizce + Rusça (latin translit) varsayılan listeler wordlist.ts'de
  // birleştirilip export ediliyor. removedDefaults, bu birleşik listenin
  // herhangi bir kelimesini o sunucu için etkisiz kılmak için kullanılabilir.
  const base = ALL_DEFAULT_BANNED_WORDS.filter((w) => !cfg.removedDefaults.includes(w));
  const words = [...new Set([...base, ...cfg.wordList])];
  const customWords = new Set(cfg.wordList);
  effectiveWordCache.set(guildId, { cfg, words, customWords });
  return { words, customWords };
}

// --- Strike (ihlal sayacı) yönetimi ---

export interface StrikeData {
  count: number;
  lastViolation: number; // epoch ms
}

export async function getStrike(guildId: string, userId: string): Promise<StrikeData> {
  const key = `${guildId}:${userId}`;
  const cfg = await getGuildConfig(guildId);
  const rows = await db
    .select()
    .from(automodStrikesTable)
    .where(eq(automodStrikesTable.key, key));

  const row = rows[0];
  if (!row) return { count: 0, lastViolation: 0 };

  const lastViolationMs = row.lastViolation.getTime();
  const expired = Date.now() - lastViolationMs > cfg.strikeResetMinutes * 60_000;
  if (expired) {
    await db.delete(automodStrikesTable).where(eq(automodStrikesTable.key, key));
    return { count: 0, lastViolation: 0 };
  }
  return { count: row.count, lastViolation: lastViolationMs };
}

export async function addStrike(guildId: string, userId: string): Promise<StrikeData> {
  const key = `${guildId}:${userId}`;
  const cfg = await getGuildConfig(guildId);

  // JSON deposu bellekte ve senkron çalışır: aşağıdaki oku → hesapla → yaz
  // adımları (await olmadan, .run() ile) arasına başka bir mesaj giremez, yani
  // aynı anda gelen iki mesaj bir ihlali kaybettirmez. Süresi dolmuş sayaç aynı
  // adımda sıfırdan (1) başlar.
  const now = new Date();
  const resetMs = Math.max(1, cfg.strikeResetMinutes) * 60_000;
  const existing = db.select().from(automodStrikesTable).where(eq(automodStrikesTable.key, key)).run()[0];
  let countNow: number;
  if (!existing) {
    db.insert(automodStrikesTable).values({ key, guildId, userId, count: 1, lastViolation: now }).run();
    countNow = 1;
  } else {
    const expired = existing.lastViolation.getTime() < now.getTime() - resetMs;
    countNow = expired ? 1 : existing.count + 1;
    db.update(automodStrikesTable)
      .set({ count: countNow, lastViolation: now })
      .where(eq(automodStrikesTable.key, key))
      .run();
  }
  return {
    count: countNow,
    lastViolation: now.getTime(),
  };
}

export async function resetStrikes(guildId: string, userId: string): Promise<void> {
  await db.delete(automodStrikesTable).where(eq(automodStrikesTable.key, `${guildId}:${userId}`));
}
