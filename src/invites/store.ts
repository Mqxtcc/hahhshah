import { AuditLogEvent, MessageFlags, type Client, type Guild } from "discord.js";
import { eq } from "../db/jsonOrm.js";
import { db, inviteRewardsTable } from "../db/index.js";
import { BOT_NAME } from "../config.js";
import { grantPremium } from "../premium/store.js";
import { withUserLock } from "../utils/mutex.js";
import { textCard } from "../utils/componentsV2.js";
import { getGuildPrefix } from "../events/messageCreate.js";

// ---------------------------------------------------------------------------
// 🎁 Davet Ödül Sistemi — çekirdek mantık.
//
// Akış:
//   1) Bot yeni bir sunucuya eklenir (guildCreate) → davet eden bulunur
//      (önce denetim kaydı "bot eklendi", bulamazsa sunucu sahibi) ve
//      davet "beklemeye" alınır.
//   2) Bekleyen davet 7 gün sonra hak kazanır — ANCAK bot hâlâ sunucudaysa
//      ve sunucuda en az MIN_HUMANS insan üye varsa. Böylece boş/çiftlik
//      sunucularla kasmak işe yaramaz.
//   3) Hak kazanma anında kademe ödülleri otomatik verilir (rozet / premium).
//
// Komutlar: !davet (istatistik + link), !davet-top (sıralama).
// ---------------------------------------------------------------------------

/** Davet sayılmadan önce botun sunucuda kalması gereken süre (gün). */
export const VEST_DAYS = 7;
/** Sayılan sunucuda olması gereken en az insan (bot olmayan) üye sayısı. */
export const MIN_HUMANS = 10;

export interface PendingInvite {
  guildId: string;
  guildName: string;
  joinedAt: number; // epoch ms
  source: "audit" | "owner"; // davet eden nasıl bulundu
}

export interface InviteStats {
  userId: string;
  invites: number; // hak kazanılmış
  pending: PendingInvite[]; // bekleyenler
  badges: string[]; // kazanılmış rozet anahtarları
}

export interface InviteTier {
  count: number;
  key: string; // badges[] içinde saklanan anahtar
  badge: string; // gösterim adı
  reward: string; // açıklama
  grantsPremium: boolean;
}

export const INVITE_TIERS: InviteTier[] = [
  { count: 1, key: "elci", badge: "🏅 Elçi", reward: "🏅 Elçi rozeti — !bilgi'de özel rozet", grantsPremium: false },
  { count: 3, key: "elit", badge: "💎 Elit Elçi", reward: "AI komutlarında bekleme süresi yok", grantsPremium: false },
  { count: 5, key: "premium", badge: "⭐ Premium", reward: "Kalıcı premium — tüm AI komutları sınırsız", grantsPremium: true },
  { count: 10, key: "efsane", badge: "👑 Efsane Elçi", reward: "Her 30 günde 1 arkadaşına 1 aylık premium hediye et (!hediye)", grantsPremium: false },
];

function asPendingList(v: unknown): PendingInvite[] {
  if (!Array.isArray(v)) return [];
  return v.filter(
    (x): x is PendingInvite =>
      !!x && typeof x === "object" && typeof (x as PendingInvite).guildId === "string",
  );
}

function asStringList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string");
}

async function readStats(userId: string): Promise<InviteStats> {
  const rows = await db
    .select()
    .from(inviteRewardsTable)
    .where(eq(inviteRewardsTable.userId, userId));
  const row = rows[0];
  // NOT: { ...EMPTY, userId } spread'i pending/badges dizilerini kopyalamaz,
  // referansı paylaşırdı — DB satırı olmayan kullanıcıda recordGuildJoin
  // paylaşılan diziye push yapıp yanlış kişiye kredi/rozet/premium verirdi.
  // Bu yüzden her zaman taze dizilerle dön.
  if (!row) return { userId, invites: 0, pending: [], badges: [] };
  return {
    userId,
    invites: Number(row.invites ?? 0),
    pending: asPendingList(row.pendingInvites),
    badges: asStringList(row.badges),
  };
}

async function readCountedGuilds(userId: string): Promise<string[]> {
  const rows = await db
    .select()
    .from(inviteRewardsTable)
    .where(eq(inviteRewardsTable.userId, userId));
  return asStringList(rows[0]?.countedGuilds);
}

async function writeStats(stats: InviteStats, countedGuilds: string[], lastGiftAt?: Date | null): Promise<void> {
  const values = {
    userId: stats.userId,
    invites: stats.invites,
    pendingInvites: stats.pending,
    countedGuilds,
    badges: stats.badges,
    // undefined = dokunma, null = temizle, Date = ayarla
    ...(lastGiftAt !== undefined ? { lastGiftAt } : {}),
    updatedAt: new Date(),
  };
  await db
    .insert(inviteRewardsTable)
    .values(values)
    .onConflictDoUpdate({ target: inviteRewardsTable.userId, set: values });
}

export async function getInviteStats(userId: string): Promise<InviteStats> {
  return readStats(userId);
}

/** !hediye bekleme süresi için: kullanıcının son hediye tarihi (yoksa null). */
export async function getLastGiftAt(userId: string): Promise<Date | null> {
  const rows = await db
    .select()
    .from(inviteRewardsTable)
    .where(eq(inviteRewardsTable.userId, userId));
  const v = rows[0]?.lastGiftAt;
  return v ? new Date(v) : null;
}

/** !hediye kullanıldıktan sonra son hediye tarihini bugüne çeker. */
export async function setLastGiftNow(userId: string): Promise<void> {
  const stats = await readStats(userId);
  const counted = await readCountedGuilds(userId);
  await writeStats(stats, counted, new Date());
}

/** Hediye rezervasyonunu geri alır (hediye verilemezse bekleme boşa gitmesin). */
export async function clearLastGiftAt(userId: string): Promise<void> {
  const stats = await readStats(userId);
  const counted = await readCountedGuilds(userId);
  await writeStats(stats, counted, null);
}

// ---------------------------------------------------------------------------
// Rozet sorguları — ödül güçleri (trial limiti, cooldown muafiyeti, durum
// mesajı) buradan beslenir. AI komutlarındaki her çağrıda DB okumamak için
// 5 dakikalık bellek-içi cache.
// ---------------------------------------------------------------------------

const badgeCache = new Map<string, { at: number; badges: string[] }>();
const BADGE_CACHE_MS = 5 * 60 * 1000;

async function cachedBadges(userId: string): Promise<string[]> {
  const now = Date.now();
  const hit = badgeCache.get(userId);
  if (hit && now - hit.at < BADGE_CACHE_MS) return hit.badges;
  const badges = (await readStats(userId)).badges;
  badgeCache.set(userId, { at: now, badges });
  return badges;
}

/** Rozet kazanılınca cache'i düşür — bir sonraki okuma güncel gelsin. */
export function bustBadgeCache(userId: string): void {
  badgeCache.delete(userId);
}

/** Kullanıcı bu davet rozetine sahip mi? */
export async function hasInviteBadge(userId: string, key: string): Promise<boolean> {
  try {
    return (await cachedBadges(userId)).includes(key);
  } catch {
    return false;
  }
}

/** Bu rozete sahip kullanıcıların ID'leri (örn. durum mesajı rotasyonu için). */
export async function getUsersWithBadge(key: string): Promise<string[]> {
  const rows = await db.select().from(inviteRewardsTable);
  const out: string[] = [];
  for (const row of rows) {
    const userId = (row as { userId?: unknown }).userId;
    if (typeof userId !== "string") continue;
    if (asStringList((row as { badges?: unknown }).badges).includes(key)) {
      out.push(userId);
    }
  }
  return out;
}

/** Bir sunucunun daha önce herhangi bir kullanıcı için sayılıp sayılmadığını kontrol eder. */
async function isGuildCountedAnywhere(guildId: string): Promise<boolean> {
  const rows = await db.select().from(inviteRewardsTable);
  for (const row of rows) {
    if (asStringList(row.countedGuilds).includes(guildId)) return true;
    if (asPendingList(row.pendingInvites).some((p) => p.guildId === guildId)) return true;
  }
  return false;
}

/**
 * Davet edeni bul: önce "bot eklendi" denetim kaydı, olmazsa sunucu sahibi.
 * Kayıt için botun Denetim Kaydını Görüntüle yetkisi gerekir (davet linki
 * yönetici yetkisi istediği için genelde vardır).
 *
 * Denetim kaydı Discord'da gecikmeli yazılabildiği için en fazla 3 kez,
 * aralarda 30'ar saniye bekleyerek dener — ilk denemede bulunamadı diye
 * hemen sahibe düşmek yanlış kişiye kalıcı kredi verirdi.
 */
async function findInviter(guild: Guild, botUserId: string): Promise<{ id: string; source: "audit" | "owner" } | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const logs = await guild.fetchAuditLogs({ type: AuditLogEvent.BotAdd, limit: 5 });
      const entry = logs.entries.find((e) => e.target?.id === botUserId && e.executor && !e.executor.bot);
      if (entry?.executor) return { id: entry.executor.id, source: "audit" };
    } catch (err) {
      // Yetki yoksa (50013) tekrar denemenin anlamı yok, sahibe düş.
      if ((err as { code?: number } | null)?.code === 50013) break;
      // Diğer hatalarda (rate limit vb.) bir sonraki denemeye bırak.
    }
    if (attempt < 2) await new Promise((r) => setTimeout(r, 30_000));
  }
  if (guild.ownerId) return { id: guild.ownerId, source: "owner" };
  return null;
}

// ---------------------------------------------------------------------------
// 1) guildCreate'tan çağrılır: daveti beklemeye alır.
// ---------------------------------------------------------------------------
export async function recordGuildJoin(guild: Guild): Promise<void> {
  const botUserId = guild.client.user?.id;
  if (!botUserId) return;

  const inviter = await findInviter(guild, botUserId);
  if (!inviter) {
    console.warn(`[davet] davet eden bulunamadı: ${guild.name}`);
    return;
  }

  // Aynı davet edenin iki sunucusu aynı anda eklenirse kayıtlar üst üste
  // binmesin diye kilit altında: kontrol + yazma atomik.
  await withUserLock(inviter.id, async () => {
    if (await isGuildCountedAnywhere(guild.id)) return; // tekrar ekleme / çift sayım yok
    const stats = await readStats(inviter.id);
    const counted = await readCountedGuilds(inviter.id);
    stats.pending.push({
      guildId: guild.id,
      guildName: guild.name,
      joinedAt: Date.now(),
      source: inviter.source,
    });
    await writeStats(stats, counted);
    console.log(`[davet] beklemeye alındı: ${inviter.id} → ${guild.name}`);
  });

  // Davet edene DM ile bilgi ver (kapalıysa sessiz geç).
  try {
    const user = await guild.client.users.fetch(inviter.id);
    const prefix = getGuildPrefix(guild.id);
    await user.send({
      flags: MessageFlags.IsComponentsV2,
      components: textCard(
        `🎁 **${BOT_NAME}** davet ödülü: **${guild.name}** sunucusuna davetin alındı!\n` +
          `Bot ${VEST_DAYS} gün bu sunucuda kalırsa ve sunucuda en az ${MIN_HUMANS} üye olursa davetin sayılacak.\n` +
          `Durumunu görmek için \`${prefix}davet\` yazman yeterli.`,
      ),
    });
  } catch {
    /* DM kapalı olabilir */
  }
}

// ---------------------------------------------------------------------------
// 2) Bot bir sunucudan atılırsa/çıkarsa: o sunucunun bekleyen davetini sil.
// ---------------------------------------------------------------------------
export async function dropPendingForGuild(guildId: string): Promise<void> {
  const rows = await db.select().from(inviteRewardsTable);
  for (const row of rows) {
    const pending = asPendingList(row.pendingInvites);
    if (!pending.some((p) => p.guildId === guildId)) continue;
    // Satır sahibinin kilidi altında sil — vest ile yarışıp kayıp güncelleme olmasın.
    await withUserLock(row.userId, async () => {
      const fresh = await readStats(row.userId);
      const before = fresh.pending.length;
      fresh.pending = fresh.pending.filter((p) => p.guildId !== guildId);
      if (fresh.pending.length === before) return; // arada zaten silinmiş
      await writeStats(fresh, await readCountedGuilds(row.userId));
      console.log(`[davet] bot çıkınca bekleyen silindi: ${guildId}`);
    }).catch((err) => console.error(`[davet] bekleyen silinemedi (${row.userId}):`, err));
  }
}

// ---------------------------------------------------------------------------
// 3) Hak kazanma (vesting): süresi dolmuş bekleyen davetleri say.
// ---------------------------------------------------------------------------
async function countHumans(guild: Guild): Promise<number> {
  try {
    const members = await guild.members.fetch();
    return members.filter((m) => !m.user.bot).size;
  } catch {
    // Üye listesi alınamazsa emin olamayız — fail-closed: beklemede tut,
    // sonraki vest turunda tekrar dene. (Gevşek fallback botlarla doldurulmuş
    // sunucuyu geçirebilirdi.)
    return 0;
  }
}

async function grantTierRewards(client: Client, userId: string, stats: InviteStats): Promise<string[]> {
  const unlocked: string[] = [];
  for (const tier of INVITE_TIERS) {
    if (stats.invites < tier.count || stats.badges.includes(tier.key)) continue;
    stats.badges.push(tier.key);
    unlocked.push(tier.badge);
    if (tier.grantsPremium) {
      const granted = await grantPremium(userId, "davet-ödülü").catch(() => false);
      console.log(`[davet] premium ${granted ? "verildi" : "vardı zaten"}: ${userId}`);
    }
  }
  return unlocked;
}

/** vestUser kilitli sarmalayıcı: !davet'teki vest ile periyodik vest çakışıp çift saymasın. */
async function vestUser(client: Client, userId: string): Promise<{ vested: number; unlocked: string[] }> {
  return withUserLock(userId, () => vestUserInner(client, userId));
}

async function vestUserInner(client: Client, userId: string): Promise<{ vested: number; unlocked: string[] }> {
  const stats = await readStats(userId);
  if (stats.pending.length === 0) return { vested: 0, unlocked: [] };
  const counted = await readCountedGuilds(userId);
  const now = Date.now();
  const vestMs = VEST_DAYS * 24 * 60 * 60 * 1000;
  let vested = 0;
  const stillPending: PendingInvite[] = [];

  for (const p of stats.pending) {
    if (now - p.joinedAt < vestMs) {
      stillPending.push(p);
      continue;
    }
    const guild = client.guilds.cache.get(p.guildId);
    if (!guild) {
      // Fail-closed: sunucu cache'de yok diye daveti düşürme — cache eksik
      // olabilir, bot gerçekten çıkmışsa guildDelete zaten
      // dropPendingForGuild ile bekleyeni temizler. Beklemede tut, sonraki
      // vest turunda tekrar dene.
      stillPending.push(p);
      continue;
    }
    const humans = await countHumans(guild);
    if (humans < MIN_HUMANS) {
      // Şart sağlanmıyor ama bot hâlâ sunucuda: beklemede tut, üye artabilir.
      stillPending.push(p);
      continue;
    }
    stats.invites += 1;
    counted.push(p.guildId);
    vested += 1;
    console.log(`[davet] hak kazanıldı: ${userId} → ${p.guildName}`);
  }

  stats.pending = stillPending;
  const unlocked = vested > 0 ? await grantTierRewards(client, userId, stats) : [];
  if (vested > 0 || unlocked.length > 0) {
    await writeStats(stats, counted);
    try {
      const user = await client.users.fetch(userId);
      const rewardText =
        unlocked.length > 0
          ? `\n🏆 Yeni ödüllerin: **${unlocked.join("**, **")}**`
          : "";
      const prefix = getGuildPrefix(stats.pending[0]?.guildId ?? client.guilds.cache.first()?.id);
      await user.send({
        flags: MessageFlags.IsComponentsV2,
        components: textCard(
          `🎉 **${BOT_NAME}** davet ödülü: ${vested} davetin hak kazandı! Toplam: **${stats.invites}**${rewardText}\n` +
            `Devamı için \`${prefix}davet\` yaz.`,
        ),
      });
    } catch {
      /* DM kapalı olabilir */
    }
  } else if (stats.pending.length !== (await readStats(userId)).pending.length) {
    await writeStats(stats, counted);
  }
  bustBadgeCache(userId);
  return { vested, unlocked };
}

/** Tek kullanıcının süresi dolmuş davetlerini hak kazandırır (örn. !davet komutunda). */
export async function vestMaturedForUser(client: Client, userId: string): Promise<void> {
  try {
    await vestUser(client, userId);
  } catch (err) {
    console.error(`[davet] vest patladı (${userId}):`, err);
  }
}

/** Tüm kullanıcılar için periyodik hak kazandırma (ready'den zamanlanır). */
export async function vestAllMatured(client: Client): Promise<void> {
  try {
    const rows = await db.select().from(inviteRewardsTable);
    let total = 0;
    for (const row of rows) {
      const { vested } = await vestUser(client, row.userId);
      total += vested;
    }
    if (total > 0) console.log(`[davet] periyodik dağıtım: ${total} hak`);
  } catch (err) {
    console.error("[davet] periyodik vest patladı:", err);
  }
}

/** Sıralama için en çok davet edenler. */
export async function getTopInviters(limit = 10): Promise<{ userId: string; invites: number }[]> {
  const rows = await db.select().from(inviteRewardsTable);
  return rows
    .map((r) => ({ userId: r.userId, invites: Number(r.invites ?? 0) }))
    .filter((r) => r.invites > 0)
    .sort((a, b) => b.invites - a.invites)
    .slice(0, Math.max(1, Math.min(25, limit)));
}

/** Bir sonraki kademeye kaç davet kaldığını döner (yoksa null). */
export function nextTier(invites: number): InviteTier | null {
  for (const tier of INVITE_TIERS) {
    if (invites < tier.count) return tier;
  }
  return null;
}
