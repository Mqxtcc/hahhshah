import { eq } from "../db/jsonOrm.js";
import { OWNER_ID } from "../config.js";
import { db, dailyTrialsTable, premiumUsersTable, premiumGiftsTable } from "../db/index.js";

// ---------------------------------------------------------------------------
// Premium kullanıcı listesi.
//
// KALICI: süresi/expiry'si yok, sadece revokePremium() (bkz. !premium-kaldir)
// ile geri alınır. AFK/VIP sistemleriyle aynı desen: açılışta DB'den belleğe
// yüklenir, her değişiklikte hem bellek hem DB güncellenir.
//
// HEDİYE (süreli): !hediye komutuyla verilir, premiumGiftsTable'da tutulur,
// süresi dolunca isPremium() içinde tembelca temizlenir.
// ---------------------------------------------------------------------------

const premiumUsers = new Set<string>();
/** userId -> bitiş zamanı (ms). Süreli hediye premiumlar. */
const giftExpiry = new Map<string, number>();

let loaded = false;
let loadingPromise: Promise<void> | null = null;

async function loadPremium(): Promise<void> {
  const rows = await db.select().from(premiumUsersTable);
  premiumUsers.clear();
  for (const row of rows) premiumUsers.add(row.userId);
  console.log(`[premium] ${rows.length} premium yüklendi`);
  // Süreli hediyeler: süresi dolmuşları temizle, kalanları belleğe al.
  const now = Date.now();
  const gifts = await db.select().from(premiumGiftsTable);
  giftExpiry.clear();
  let alive = 0;
  for (const g of gifts) {
    const exp = new Date(g.expiresAt).getTime();
    if (exp > now) {
      giftExpiry.set(g.userId, exp);
      alive++;
    } else {
      // `void` ile atılan thenable hiç çalışmazdı — await ile gerçekten sil.
      await db.delete(premiumGiftsTable).where(eq(premiumGiftsTable.userId, g.userId));
    }
  }
  if (alive > 0) console.log(`[premium] ${alive} hediye premium aktif`);
  loaded = true;
}

export async function ensurePremiumLoaded(): Promise<void> {
  if (loaded) return;
  if (!loadingPromise) {
    loadingPromise = loadPremium().finally(() => {
      loadingPromise = null;
    });
  }
  await loadingPromise;
}

export function isPremium(userId: string): boolean {
  // Bot sahibi her zaman premium sayılır — kendine !premium vermek zorunda kalmasın.
  if (userId === OWNER_ID) return true;
  if (premiumUsers.has(userId)) return true;
  // Süreli hediye premium: süresi dolmuşsa tembelca temizle.
  const exp = giftExpiry.get(userId);
  if (exp === undefined) return false;
  if (exp > Date.now()) return true;
  giftExpiry.delete(userId);
  // Senkron kalmak zorunda — .catch thenable'ı tetikler, silme arka planda çalışır.
  db.delete(premiumGiftsTable).where(eq(premiumGiftsTable.userId, userId)).catch(() => null);
  return false;
}

/** Premium verir. Kişi zaten premium ise false döner (no-op). */
export async function grantPremium(userId: string, grantedBy: string): Promise<boolean> {
  await ensurePremiumLoaded();
  const inserted = await db
    .insert(premiumUsersTable)
    .values({ userId, grantedBy })
    .onConflictDoNothing()
    .returning({ userId: premiumUsersTable.userId });
  if (inserted.length === 0) {
    premiumUsers.add(userId);
    return false;
  }
  premiumUsers.add(userId);
  return true;
}

/** Hediye premium'un bitiş tarihi (yoksa null). */
export function getGiftExpiry(userId: string): Date | null {
  const exp = giftExpiry.get(userId);
  if (exp === undefined || exp <= Date.now()) return null;
  return new Date(exp);
}

/**
 * Süreli HEDİYE premium verir (!hediye komutu kullanır).
 * Kişi zaten premium ise (kalıcı veya aktif hediye) false döner (no-op).
 */
export async function grantGiftPremium(
  userId: string,
  days: number,
  grantedBy: string,
): Promise<Date | null> {
  await ensurePremiumLoaded();
  if (isPremium(userId)) return null;
  const expiresAt = new Date(Date.now() + days * 24 * 60 * 60_000);
  await db
    .insert(premiumGiftsTable)
    .values({ userId, expiresAt, grantedBy })
    .onConflictDoUpdate({
      target: premiumGiftsTable.userId,
      set: { expiresAt, grantedBy, grantedAt: new Date() },
    });
  giftExpiry.set(userId, expiresAt.getTime());
  return expiresAt;
}

export interface PremiumUserInfo {
  userId: string;
  grantedBy: string;
  grantedAt: Date;
}

/** Tüm premium kullanıcıları döner (verilme tarihine göre, en eski önce) — bkz. !premium-liste. */
export async function getAllPremiumUsers(): Promise<PremiumUserInfo[]> {
  await ensurePremiumLoaded();
  const rows = await db.select().from(premiumUsersTable).orderBy(premiumUsersTable.grantedAt);
  return rows.map((r) => ({ userId: r.userId, grantedBy: r.grantedBy, grantedAt: r.grantedAt }));
}

/** Premium'u geri alır. Kişi zaten premium değilse false döner (no-op). */
export async function revokePremium(userId: string): Promise<boolean> {
  // Bot sahibi her zaman premium; listeden silinse bile isPremium true döner.
  // Half-owner'ın owner'ı "premium değil" sanmasını engellemek için no-op.
  if (userId === OWNER_ID) return false;
  await ensurePremiumLoaded();
  const deleted = await db
    .delete(premiumUsersTable)
    .where(eq(premiumUsersTable.userId, userId))
    .returning({ userId: premiumUsersTable.userId });
  premiumUsers.delete(userId);
  return deleted.length > 0;
}

// ---------------------------------------------------------------------------
// 🎟️ Günlük AI deneme hakkı (2026-09-28): premium olmayan kullanıcılar AI
// komutlarını günde toplam DAILY_TRIAL_LIMIT kez kullanabilir (tüm AI
// komutları ortak havuzdan yer). Gün Europe/Istanbul'a göre değişir.
// Kalıcıdır (DB'de tutulur) — bot yeniden başlasa bile sayaç sıfırlanmaz.
// ---------------------------------------------------------------------------

/** Bugünün tarihi, YYYY-MM-DD (Europe/Istanbul). */
export function todayTR(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Istanbul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

export interface DailyTrialResult {
  allowed: boolean;
  usedToday: number; // bugünkü kullanım sayısı
  remaining: number; // kalan hak
}

/**
 * Sadece KONTROL eder, hak harcamaz. gate.ts bunu komut başında çağırır;
 * hak, AI BAŞARILI olunca spendDailyTrial() ile ayrıca düşülür.
 */
export async function checkDailyTrial(
  userId: string,
  limit: number,
): Promise<DailyTrialResult> {
  const safeLimit = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 0;
  if (safeLimit === 0) return { allowed: false, usedToday: 0, remaining: 0 };

  const key = `${userId}:${todayTR()}`;
  const existing = db.select().from(dailyTrialsTable).where(eq(dailyTrialsTable.key, key)).run()[0];
  const used = existing ? Math.max(0, Number(existing.uses)) : 0;
  return {
    allowed: used < safeLimit,
    usedToday: used,
    remaining: Math.max(0, safeLimit - used),
  };
}

/**
 * Günlük deneme hakkını ATOMİK şekilde harcar: oku → `uses < limit`
 * kontrolü → yaz adımlarının tamamı senkron (.run()) olduğu için araya başka
 * bir istek giremez. Sadece AI komutu başarılı sonuç üretince çağrılmalı
 * (bkz. gate.ts consumeTrialUse). Başarısız denemeler hak yemez.
 */
export function spendDailyTrial(userId: string, limit: number): boolean {
  const safeLimit = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 0;
  if (safeLimit === 0) return false;
  const day = todayTR();
  const key = `${userId}:${day}`;
  // JSON deposu bellekte ve senkron çalıştığı için oku → karar ver → yaz
  // adımları (.run() ile) arasına başka bir istek giremez.
  const existing = db.select().from(dailyTrialsTable).where(eq(dailyTrialsTable.key, key)).run()[0];
  const used = existing ? Number(existing.uses) : 0;
  if (used >= safeLimit) return false; // arada limit dolmuş — harcama
  if (!existing) {
    db.insert(dailyTrialsTable).values({ key, userId, day, uses: 1 }).run();
    return true;
  }
  db.update(dailyTrialsTable)
    .set({ uses: used + 1 })
    .where(eq(dailyTrialsTable.key, key))
    .run();
  return true;
}
