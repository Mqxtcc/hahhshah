import type { GuildMember, PermissionResolvable } from "discord.js";

import { OWNER_ID } from "../config.js";

/**
 * Discord'un kendi davranışına benzer şekilde rol hiyerarşisi kontrolü yapar.
 * Sunucu sahibi her zaman geçer. Diğer herkes için, işlemi yapan kişinin
 * en yüksek rolü, hedefin en yüksek rolünden KESİNLİKLE daha yüksek olmalı
 * (eşitlik de yasak, Discord'daki gibi).
 */
export function canModerate(executor: GuildMember, target: GuildMember): boolean {
  if (executor.id === OWNER_ID || executor.id === executor.guild.ownerId) return true;
  if (target.id === executor.guild.ownerId) return false;
  return executor.roles.highest.position > target.roles.highest.position;
}

/**
 * Botun bir üyeyi susturamama / atamama / yasaklayamama sebebini AYIRT eder.
 *
 * discord.js'in `.moderatable` / `.kickable` / `.bannable` getter'ları tek bir
 * boolean döner ve false olma sebebi aslında birden fazla olabilir:
 *  - Botun ilgili izni (Moderate Members / Kick / Ban) yok
 *  - Hedef sunucu sahibi
 *  - Botun en yüksek rolü hedefin en yüksek rolünden yüksek/eşit değil
 *
 * Eskiden bu üç durumun hepsi tek bir "Rolü benden yüksek" mesajına
 * indirgeniyordu, bu da yanıltıcıydı (örn. bot rolü gerçekten en üstteyken
 * bile izin eksikse aynı mesaj çıkıyordu). Bu fonksiyon gerçek sebebi döner.
 */
export type BotModerationBlockReason =
  | "missing-permission"
  | "target-is-owner"
  | "role-too-low-or-equal"
  | null;

export function getBotModerationBlockReason(
  me: GuildMember | null,
  target: GuildMember,
  permission: PermissionResolvable,
  requesterId?: string,
): BotModerationBlockReason {
  if (requesterId === OWNER_ID) return null;
  if (target.id === target.guild.ownerId) return "target-is-owner";
  if (!me) return "missing-permission";
  if (!me.permissions.has(permission)) return "missing-permission";
  if (me.roles.highest.position <= target.roles.highest.position) return "role-too-low-or-equal";
  return null;
}

/**
 * Sebebe göre kullanıcıya gösterilecek Türkçe mesajı üretir. Tüm mod
 * komutlarında (ban/kick/timeout/unmute) aynı "Yetkim Yok" kartında
 * (bkz. embeds.ts -> permissionErrorEmbed) gösterilecek şekilde, gerekli
 * izni de adıyla belirtir ki moderatör ne yapması gerektiğini tek bakışta
 * anlasın.
 */
export function botModerationBlockMessage(
  reason: BotModerationBlockReason,
  action: "susturamam" | "atamam" | "yasaklayamam" | "susturmasını kaldıramam" | "uyaramam",
  requiredPermissionLabel = "ilgili moderasyon izni",
): string {
  const intro = `Maalesef bu kullanıcıyı ${action} çünkü sunucuda yeterli yetkim yok :(`;
  switch (reason) {
    case "missing-permission":
      return `${intro}\nRolümü kontrol edip gerekli izinleri (ör. **${requiredPermissionLabel}**) verdiğinden emin olabilir misin?`;
    case "target-is-owner":
      return `${intro}\nHedef, sunucu sahibi olduğu için hiçbir rol/izin bunu değiştiremez.`;
    case "role-too-low-or-equal":
      return `${intro}\nRolümün, hedef kullanıcı/rolden daha üstte olduğundan emin olabilir misin?`;
    default:
      return `Bu kullanıcıyı ${action}.`;
  }
}
