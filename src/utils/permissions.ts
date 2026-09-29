import { db } from "../db/index.js";
import { userPermissionsTable } from "../db/schema.js";
import { eq, and } from "../db/jsonOrm.js";
import type { Message } from "discord.js";
import { OWNER_ID } from "../config.js";

// ---------------------------------------------------------------------------
// PERFORMANS: Eskiden her hasPermission() çağrısı SIRAYLA (await -> await)
// 2 ayrı DB sorgusu atıyordu (önce kullanıcıya özel izin, sonra rol izinleri).
// Her prefix mod komutu (!ban, !kick, !timeout, !warn, ...) bu fonksiyonu
// çağırdığı için, o komutlar DB'ye gidiş-dönüş süresi kadar (Neon'da bazen
// yüzlerce ms) gecikmeyle cevap veriyordu — "! komutları geç cevap veriyor"
// şikayetinin doğrudan sebebi buydu.
//
// Çözüm: guild+permission başına TÜM izin satırlarını TEK sorguda çekip
// (kullanıcı VE rol hedefli satırlar birlikte), kısa süreli bellek-içi
// cache'e alıyoruz. Aynı sunucuda aynı izin tekrar kontrol edildiğinde
// (ör. art arda birkaç !ban kullanımı) DB'ye hiç gidilmiyor.
// ---------------------------------------------------------------------------
interface PermRow {
  targetId: string;
  targetType: string;
}
const CACHE_TTL_MS = 30_000;
const cache = new Map<string, { rows: PermRow[]; ts: number }>();
const inFlight = new Map<string, Promise<PermRow[]>>();

async function loadPermRows(guildId: string, permission: string): Promise<PermRow[]> {
  const key = `${guildId}:${permission}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.rows;

  const existingLoad = inFlight.get(key);
  if (existingLoad) return existingLoad;

  const load = db
    .select({ targetId: userPermissionsTable.targetId, targetType: userPermissionsTable.targetType })
    .from(userPermissionsTable)
    .where(and(eq(userPermissionsTable.guildId, guildId), eq(userPermissionsTable.permission, permission)))
    .then((rows) => {
      cache.set(key, { rows, ts: Date.now() });
      return rows;
    })
    .finally(() => {
      if (inFlight.get(key) === load) inFlight.delete(key);
    });
  inFlight.set(key, load);
  return load;
}

/** !izin-ver / !izin-al gibi komutlar bir sunucunun izinlerini değiştirdiğinde çağrılır. */
export function invalidatePermissionCache(guildId: string, permission?: string): void {
  if (permission) {
    cache.delete(`${guildId}:${permission}`);
    return;
  }
  for (const key of cache.keys()) {
    if (key.startsWith(`${guildId}:`)) cache.delete(key);
  }
}

export async function hasPermission(
  message: Message,
  permission: string
): Promise<boolean> {
  // Bot sahibi (OWNER_ID) her zaman, hiçbir izin/rol/Discord yetkisine
  // bakılmaksızın TÜM komutları kullanabilir — global geçersiz kılma.
  if (message.author.id === OWNER_ID) return true;
  if (message.member?.permissions.has("Administrator")) return true;

  const guildId = message.guildId!;
  const userId = message.author.id;

  const rows = await loadPermRows(guildId, permission);
  if (rows.some((r) => r.targetType === "user" && r.targetId === userId)) return true;

  const memberRoles = message.member?.roles.cache;
  if (!memberRoles || memberRoles.size === 0) return false;
  return rows.some((r) => r.targetType === "role" && memberRoles.has(r.targetId));
}