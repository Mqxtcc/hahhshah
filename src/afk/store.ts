import { eq } from "../db/jsonOrm.js";
import { db, afkTable } from "../db/index.js";

// ---------------------------------------------------------------------------
// AFK sistemi — diğer kalıcı runtime state'lerle aynı
// desen: açılışta DB'den belleğe yükleniyor, her değişiklikte hem bellek hem
// DB güncelleniyor. Böylece bot yeniden başlasa da AFK durumları kaybolmuyor.
// ---------------------------------------------------------------------------

interface AfkEntry {
  reason: string;
  since: number;
}

const afkMap = new Map<string, AfkEntry>(); // key: userId

let loaded = false;
let loadingPromise: Promise<void> | null = null;

async function loadAfk(): Promise<void> {
  const rows = await db.select().from(afkTable);
  afkMap.clear();
  for (const row of rows) afkMap.set(row.userId, { reason: row.reason, since: row.since.getTime() });
  loaded = true;
  console.log(`[afk] ${rows.length} afk kaydı yüklendi`);
}

export async function ensureAfkLoaded(): Promise<void> {
  if (loaded) return;
  if (!loadingPromise) {
    loadingPromise = loadAfk().finally(() => {
      loadingPromise = null;
    });
  }
  await loadingPromise;
}

export async function setAfk(
  userId: string,
  reason: string,
  since: number = Date.now(),
): Promise<void> {
  try {
    await db
      .insert(afkTable)
      .values({ userId, reason, since: new Date(since) })
      .onConflictDoUpdate({
        target: afkTable.userId,
        set: { reason, since: new Date(since) },
      });
    afkMap.set(userId, { reason, since });
  } catch (err) {
    console.error(`[afk] kaydolmadı (${userId}):`, err);
    throw err;
  }
}

export function getAfk(userId: string): AfkEntry | null {
  return afkMap.get(userId) ?? null;
}

/** AFK durumunu kaldırır (bellek + DB) ve varsa önceki kaydı döner. */
export async function clearAfk(userId: string): Promise<AfkEntry | null> {
  const entry = afkMap.get(userId) ?? null;
  if (!entry) return null;
  try {
    const deleted = await db
      .delete(afkTable)
      .where(eq(afkTable.userId, userId))
      .returning({ userId: afkTable.userId });
    if (deleted.length === 0) return null;
    afkMap.delete(userId);
    return entry;
  } catch (err) {
    // DB silinmediyse bellekte de silme; ancak bu mesajı AFK dönüşü olarak
    // işaretlemeyerek her mesajda sahte "hoşgeldin" yanıtı üretme.
    console.error(`[afk] silinemedi (${userId}):`, err);
    return null;
  }
}
