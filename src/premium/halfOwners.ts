import { eq } from "../db/jsonOrm.js";
import { db, halfOwnersTable } from "../db/index.js";
import { OWNER_ID } from "../config.js";

// ---------------------------------------------------------------------------
// Yarı-yetkili (half-owner) listesi.
//
// Bot sahibinin (OWNER_ID) devrettiği, SADECE premium VERME yetkisine sahip
// kullanıcılar. Kalıcıdır (süresi yok), sadece !halfowner sil ile geri
// alınır. Premium/AFK/VIP sistemleriyle aynı desen: açılışta DB'den belleğe
// yüklenir, her değişiklikte hem bellek hem DB güncellenir.
//
// ⚠️ GÜVENLİK: Bu liste SADECE bilinçli olarak half-owner'a açılan komutlar
// için geçerlidir (ör. !premium, !özelüye). eval / restart / modeller /
// hata-log gibi tehlikeli komutlar doğrudan OWNER_ID kontrolü yapar ve bu
// listeye HİÇ bakmaz — half-owner olmak owner olmak anlamına gelmez.
// ---------------------------------------------------------------------------

const halfOwners = new Set<string>();

let loaded = false;
let loadingPromise: Promise<void> | null = null;

async function loadHalfOwners(): Promise<void> {
  const rows = await db.select().from(halfOwnersTable);
  halfOwners.clear();
  for (const row of rows) halfOwners.add(row.userId);
  loaded = true;
  console.log(`[halfowner] ${rows.length} kişi yüklendi`);
}

export async function ensureHalfOwnersLoaded(): Promise<void> {
  if (loaded) return;
  if (!loadingPromise) {
    loadingPromise = loadHalfOwners().finally(() => {
      loadingPromise = null;
    });
  }
  await loadingPromise;
}

export function isHalfOwner(userId: string): boolean {
  return halfOwners.has(userId);
}

/** Şu an yüklü tüm half-owner ID'lerini döner (eklenme sırasına özel bir garanti yok). */
export function listHalfOwnerIds(): string[] {
  return [...halfOwners];
}

/**
 * Half-owner ekler. Zaten half-owner ise false döner (no-op).
 * Bot sahibi (OWNER_ID) hiçbir zaman bu listeye eklenmez/eklenemez — zaten
 * tüm yetkilere sahip ve half-owner kısıtlamalarına tabi değil.
 */
export async function addHalfOwner(userId: string, addedBy: string): Promise<boolean> {
  if (userId === OWNER_ID) return false;
  await ensureHalfOwnersLoaded();
  const inserted = await db
    .insert(halfOwnersTable)
    .values({ userId, addedBy })
    .onConflictDoNothing()
    .returning({ userId: halfOwnersTable.userId });
  if (inserted.length === 0) {
    halfOwners.add(userId);
    return false;
  }
  halfOwners.add(userId);
  return true;
}

/** Half-owner yetkisini geri alır. Kişi zaten half-owner değilse false döner (no-op). */
export async function removeHalfOwner(userId: string): Promise<boolean> {
  await ensureHalfOwnersLoaded();
  const deleted = await db
    .delete(halfOwnersTable)
    .where(eq(halfOwnersTable.userId, userId))
    .returning({ userId: halfOwnersTable.userId });
  halfOwners.delete(userId);
  return deleted.length > 0;
}
