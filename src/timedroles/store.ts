// src/timedroles/store.ts
// ---------------------------------------------------------------------------
// ⏳ Süreli roller: satır durdukça rolün vadesi bellidir. Açılışta
// reconcileTimedRoles() vadesi gelenleri düşürür, kalanları zamanlar;
// 5 dakikalık süpürme kaçanları yakalar (restart/kilitlenme güvenliği).
// ---------------------------------------------------------------------------

import type { Client, Guild } from "discord.js";
import { db } from "../db/index.js";
import { timedRolesTable } from "../db/schema.js";
import { eq } from "../db/jsonOrm.js";

function keyOf(guildId: string, userId: string, roleId: string): string {
  return `${guildId}:${userId}:${roleId}`;
}

const timers = new Map<string, NodeJS.Timeout>();

function clearTimer(key: string): void {
  const t = timers.get(key);
  if (t) {
    clearTimeout(t);
    timers.delete(key);
  }
}

async function dropRole(client: Client, guildId: string, userId: string, roleId: string): Promise<void> {
  const key = keyOf(guildId, userId, roleId);
  clearTimer(key);
  try {
    const guild = client.guilds.cache.get(guildId) ?? (await client.guilds.fetch(guildId).catch(() => null));
    const member = guild ? await guild.members.fetch(userId).catch(() => null) : null;
    if (member && member.roles.cache.has(roleId)) {
      await member.roles.remove(roleId, "Süreli rol vadesi doldu").catch(() => null);
    }
  } finally {
    await db.delete(timedRolesTable).where(eq(timedRolesTable.key, key)).catch(() => null);
  }
}

function schedule(client: Client, guildId: string, userId: string, roleId: string, expiresAt: Date): void {
  const key = keyOf(guildId, userId, roleId);
  clearTimer(key);
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (ms <= 0) {
    void dropRole(client, guildId, userId, roleId);
    return;
  }
  // setTimeout üst sınırı (~24.8 gün) aşılmasın diye 24 saatte bir yeniden kur.
  const delay = Math.min(ms, 24 * 60 * 60 * 1000);
  const t = setTimeout(() => {
    const left = new Date(expiresAt).getTime() - Date.now();
    if (left <= 0) void dropRole(client, guildId, userId, roleId);
    else schedule(client, guildId, userId, roleId, expiresAt);
  }, delay);
  t.unref?.();
  timers.set(key, t);
}

/** Rolü ver + vadeyi kaydet + zamanla. Aynı üçlüde eski kayıt varsa yenilenir. */
export async function grantTimedRole(
  client: Client,
  guild: Guild,
  userId: string,
  roleId: string,
  durationMs: number,
  grantedBy: string,
  reason?: string,
): Promise<Date> {
  const member = await guild.members.fetch(userId);
  await member.roles.add(roleId, reason ? `Süreli rol: ${reason}` : "Süreli rol verildi");
  const expiresAt = new Date(Date.now() + durationMs);
  const key = keyOf(guild.id, userId, roleId);
  await db
    .insert(timedRolesTable)
    .values({ key, guildId: guild.id, userId, roleId, expiresAt, grantedBy })
    .onConflictDoUpdate({ target: timedRolesTable.key, set: { expiresAt, grantedBy } });
  schedule(client, guild.id, userId, roleId, expiresAt);
  return expiresAt;
}

/** Süreli rolü erken al (satırı da siler). */
export async function revokeTimedRole(
  client: Client,
  guildId: string,
  userId: string,
  roleId: string,
): Promise<boolean> {
  const key = keyOf(guildId, userId, roleId);
  const rows = await db
    .select()
    .from(timedRolesTable)
    .where(eq(timedRolesTable.key, key))
    .limit(1);
  if (!rows[0]) return false;
  await dropRole(client, guildId, userId, roleId);
  return true;
}

/** Kullanıcının aktif süreli rolleri. */
export async function listTimedRoles(guildId: string, userId: string) {
  const rows = await db
    .select()
    .from(timedRolesTable)
    .where(eq(timedRolesTable.guildId, guildId));
  return rows.filter((r) => r.userId === userId);
}

/** Açılış: vadesi gelenleri düşür, kalanları zamanla + 5 dk süpürme. */
export async function reconcileTimedRoles(client: Client): Promise<void> {
  try {
    const rows = await db.select().from(timedRolesTable);
    let dropped = 0;
    let scheduled = 0;
    for (const r of rows) {
      if (new Date(r.expiresAt).getTime() <= Date.now()) {
        await dropRole(client, r.guildId, r.userId, r.roleId);
        dropped++;
      } else {
        schedule(client, r.guildId, r.userId, r.roleId, new Date(r.expiresAt));
        scheduled++;
      }
    }
    if (dropped > 0 || scheduled > 0) {
      console.log(`[sürelirol] ${scheduled} zamanlandı, ${dropped} düşürüldü`);
    }
  } catch (err) {
    console.error("süreli rol uzlaşması patladı:", err instanceof Error ? err.message : err);
  }
  const sweep = setInterval(() => {
    void (async () => {
      try {
        const rows = await db.select().from(timedRolesTable);
        const now = Date.now();
        for (const r of rows) {
          if (new Date(r.expiresAt).getTime() <= now) {
            await dropRole(client, r.guildId, r.userId, r.roleId);
          }
        }
      } catch {
        /* sessiz */
      }
    })();
  }, 5 * 60 * 1000);
  sweep.unref?.();
}
