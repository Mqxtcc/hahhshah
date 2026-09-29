import { v2Payload } from "./messages.js";
import type { Message, Interaction } from "discord.js";
import { OWNER_ID } from "../config.js";
import { hasInviteBadge } from "../invites/store.js";

/**
 * Bellek-içi rate limit katmanı.
 *
 * - Genel komut limiti: her prefix/slash komutu (spam / flood koruması)
 * - AI limiti: maliyetli komutlar için daha sıkı (premium dahil)
 *
 * Owner muaf. Restart'ta sıfırlanır (bilinçli tercih).
 */

// ---------- Genel komut limiti ----------
// Kullanıcı saniyede komut spam'lemesin.
const CMD_GLOBAL_COOLDOWN_MS = 1_250; // herhangi iki komut arası
const CMD_SAME_COOLDOWN_MS = 2_500; // aynı komutu peş peşe
// Kısa pencerede toplam komut üst sınırı (burst koruması)
const CMD_BURST_WINDOW_MS = 10_000;
const CMD_BURST_MAX = 8; // 10 sn içinde max 8 komut

// ---------- AI limiti (daha sıkı) ----------
const AI_GLOBAL_COOLDOWN_MS = 3_500;
const AI_PER_COMMAND_COOLDOWN_MS = 8_000;

const cmdGlobalLast = new Map<string, number>(); // userId
const cmdSameLast = new Map<string, number>(); // userId:cmd
const cmdBurstHits = new Map<string, number[]>(); // userId -> timestamps

const aiGlobalLast = new Map<string, number>();
const aiCmdLast = new Map<string, number>();

const CLEANUP_INTERVAL_MS = 5 * 60_000;
const ENTRY_MAX_AGE_MS = 15 * 60_000;

const cleanupTimer = setInterval(() => {
  const cutoff = Date.now() - ENTRY_MAX_AGE_MS;
  for (const map of [cmdGlobalLast, cmdSameLast, aiGlobalLast, aiCmdLast]) {
    for (const [key, ts] of map) {
      if (ts < cutoff) map.delete(key);
    }
  }
  for (const [key, hits] of cmdBurstHits) {
    const kept = hits.filter((t) => t >= cutoff);
    if (kept.length === 0) cmdBurstHits.delete(key);
    else cmdBurstHits.set(key, kept);
  }
}, CLEANUP_INTERVAL_MS);
cleanupTimer.unref?.();

function remainingMs(last: number | undefined, windowMs: number): number {
  if (last === undefined) return 0;
  return Math.max(0, windowMs - (Date.now() - last));
}

/** Yavaşla mesajındaki animasyonlu emoji. */
const SLOW_EMOJI = "<a:1000062821:1553049448597426287>";

async function replyWait(
  target: Message | Interaction,
  secs: number,
): Promise<void> {
  const content = `${SLOW_EMOJI} Çok hızlı gidiyorsun, biraz yavaşla. (${secs} sn)`;

  try {
    // Slash / component interaction
    if ("commandName" in target || "customId" in target || "deferred" in target) {
      const interaction = target as Interaction & {
        deferred: boolean;
        replied: boolean;
        reply: (opts: Record<string, unknown>) => Promise<unknown>;
        followUp: (opts: Record<string, unknown>) => Promise<unknown>;
      };
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp(v2Payload({ content, ephemeral: true })).catch(() => null);
      } else {
        await interaction.reply(v2Payload({ content, ephemeral: true })).catch(() => null);
      }
      return;
    }
    // Prefix message — kısa V2 TextDisplay kartı
    await (target as Message).reply(v2Payload(content)).catch(() => null);
  } catch {
    // yut — rate limit mesajı kritik değil
  }
}

/**
 * Tüm prefix / slash komutları için genel rate limit.
 * true = devam, false = reddedildi.
 */
export async function checkCommandRateLimit(
  target: Message | Interaction,
  userId: string,
  commandName: string,
): Promise<boolean> {
  if (userId === OWNER_ID) return true;

  const now = Date.now();
  const sameKey = `${userId}:${commandName}`;

  // Burst: 10 sn içinde çok fazla komut
  const hits = (cmdBurstHits.get(userId) ?? []).filter(
    (t) => now - t <= CMD_BURST_WINDOW_MS,
  );
  if (hits.length >= CMD_BURST_MAX) {
    const oldest = hits[0] ?? now;
    const wait = Math.ceil(
      (CMD_BURST_WINDOW_MS - (now - oldest)) / 1000,
    );
    await replyWait(target, Math.max(1, wait));
    return false;
  }

  const globalRem = remainingMs(cmdGlobalLast.get(userId), CMD_GLOBAL_COOLDOWN_MS);
  const sameRem = remainingMs(cmdSameLast.get(sameKey), CMD_SAME_COOLDOWN_MS);
  const wait = Math.max(globalRem, sameRem);

  if (wait > 0) {
    await replyWait(target, Math.ceil(wait / 1000));
    return false;
  }

  cmdGlobalLast.set(userId, now);
  cmdSameLast.set(sameKey, now);
  hits.push(now);
  cmdBurstHits.set(userId, hits);
  return true;
}

/**
 * AI / maliyetli komutlar için ek (daha sıkı) rate limit.
 * requirePremiumOrTrial içinden çağrılır; genel limitin üstüne biner.
 */
export async function checkAiRateLimit(
  message: Message,
  commandName: string,
): Promise<boolean> {
  const userId = message.author.id;
  if (userId === OWNER_ID) return true;

  // 💎 Elit Elçi (ve üstü — 👑 Efsane de elit rozetine sahiptir):
  // AI komutlarında bekleme süresi yok.
  try {
    if (await hasInviteBadge(userId, "elit")) return true;
  } catch {
    /* DB okunamazsa normal akışa devam */
  }

  const now = Date.now();
  const globalRem = remainingMs(aiGlobalLast.get(userId), AI_GLOBAL_COOLDOWN_MS);
  const cmdKey = `${userId}:${commandName}`;
  const cmdRem = remainingMs(aiCmdLast.get(cmdKey), AI_PER_COMMAND_COOLDOWN_MS);
  const wait = Math.max(globalRem, cmdRem);

  if (wait > 0) {
    await replyWait(message, Math.ceil(wait / 1000));
    return false;
  }

  aiGlobalLast.set(userId, now);
  aiCmdLast.set(cmdKey, now);
  return true;
}
