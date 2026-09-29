// Kullanıcının !renk ile seçtiği embed vurgu rengi (premium özelliği).
// Profil kartlarında (bilgi, davet, premiumbilgi) kullanılır.
import { eq } from "../db/jsonOrm.js";
import { db } from "../db/index.js";
import { userColorsTable } from "../db/schema.js";

const cache = new Map<string, number>();
let loaded = false;

/** Kullanıcının rengi (yoksa null). */
export async function getUserColor(userId: string): Promise<number | null> {
  if (cache.has(userId)) return cache.get(userId)!;
  if (!loaded) {
    const rows = await db.select().from(userColorsTable);
    for (const r of rows) cache.set(r.userId, r.color);
    loaded = true;
  }
  return cache.get(userId) ?? null;
}

/** Rengi kaydet/güncelle. */
export async function setUserColor(userId: string, color: number): Promise<void> {
  await db
    .insert(userColorsTable)
    .values({ userId, color })
    .onConflictDoUpdate({
      target: userColorsTable.userId,
      set: { color, updatedAt: new Date() },
    });
  cache.set(userId, color);
}

/** Rengi sıfırla. */
export async function clearUserColor(userId: string): Promise<void> {
  await db.delete(userColorsTable).where(eq(userColorsTable.userId, userId));
  cache.delete(userId);
}
