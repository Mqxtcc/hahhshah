import { eq } from "../db/jsonOrm.js";
import { db, marriageTable } from "../db/index.js";

// ---------------------------------------------------------------------------
// 💍 Evlilik deposu — her iki taraf da kendi satırında eşini gösterir.
// ---------------------------------------------------------------------------

export interface Marriage {
  partnerId: string;
  marriedAt: number;
}

export async function getMarriage(userId: string): Promise<Marriage | null> {
  const rows = await db.select().from(marriageTable).where(eq(marriageTable.userId, userId));
  const row = rows[0];
  if (!row) return null;
  return { partnerId: row.partnerId, marriedAt: row.marriedAt.getTime() };
}

export async function setMarriage(a: string, b: string): Promise<void> {
  const now = new Date();
  for (const [userId, partnerId] of [[a, b], [b, a]] as const) {
    await db
      .insert(marriageTable)
      .values({ userId, partnerId, marriedAt: now })
      .onConflictDoUpdate({
        target: marriageTable.userId,
        set: { partnerId, marriedAt: now },
      });
  }
}

export async function clearMarriage(a: string, b: string): Promise<void> {
  for (const userId of [a, b]) {
    await db.delete(marriageTable).where(eq(marriageTable.userId, userId)).catch(() => null);
  }
}
