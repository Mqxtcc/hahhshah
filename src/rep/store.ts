import { eq } from "../db/jsonOrm.js";
import { db, repTable, repCooldownTable } from "../db/index.js";

// ---------------------------------------------------------------------------
// ⭐ İtibar deposu — skor + veren başına 24 saat bekleme.
// ---------------------------------------------------------------------------

export const REP_COOLDOWN_MS = 24 * 60 * 60 * 1000;

export async function getRep(userId: string): Promise<number> {
  const rows = await db.select().from(repTable).where(eq(repTable.userId, userId));
  return rows[0]?.score ?? 0;
}

export async function giveRep(giverId: string, targetId: string): Promise<{ ok: boolean; waitMs?: number; score?: number }> {
  const cd = await db.select().from(repCooldownTable).where(eq(repCooldownTable.giverId, giverId));
  const last = cd[0]?.lastGivenAt.getTime() ?? 0;
  const waitMs = REP_COOLDOWN_MS - (Date.now() - last);
  if (waitMs > 0) return { ok: false, waitMs };

  const current = await getRep(targetId);
  await db
    .insert(repTable)
    .values({ userId: targetId, score: current + 1 })
    .onConflictDoUpdate({ target: repTable.userId, set: { score: current + 1 } });
  await db
    .insert(repCooldownTable)
    .values({ giverId, lastGivenAt: new Date() })
    .onConflictDoUpdate({ target: repCooldownTable.giverId, set: { lastGivenAt: new Date() } });
  return { ok: true, score: current + 1 };
}
