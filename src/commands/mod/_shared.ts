import { COMPONENTS_V2_FLAG, errorCard, textCard } from "../../utils/componentsV2.js";
import {
  ContainerBuilder,
  type Guild,
  type GuildMember,
  type Message,
  type PermissionResolvable,
  type TextChannel,
} from "discord.js";
import { EMOJIS } from "../../utils/emojis.js";
import { usageEmbed } from "../../utils/messages.js";
import { hasPermission } from "../../utils/permissions.js";
import {
  canModerate,
  getBotModerationBlockReason,
  botModerationBlockMessage,
} from "../../utils/hierarchy.js";
import { getChannelSetting } from "../../utils/channelSettings.js";
import { OWNER_ID } from "../../config.js";
import { markPermissionDenied } from "../../utils/notifyOwner.js";

// ---------------------------------------------------------------------------
// Moderasyon komutları için ortak yardımcılar.
//
// KURAL: Kanala giden kullanıcı mesajları her zaman kısa ve düz metindir
// (embed YOK). Başarı mesajı ÖNCE gönderilir, ceza SONRA uygulanır —
// böylece bot "yavaşmış" gibi görünmez. Ping kapalıdır (allowedMentions).
// Detaylı denetim kaydı ise "ceza" log kanalına embed olarak gider.
// ---------------------------------------------------------------------------

/** Kısa düz-metin yanıt şablonları. */
export const msg = {
  ok: (text: string) => `${EMOJIS.success} ${text}`,
  err: (text: string) => `${EMOJIS.error} ${text}`,
  usage: (text: string) => `${EMOJIS.usage} ${text}`,
  /** Kullanım rehberi için küçük embed (düz metin yerine). */
  usageEmbed,
  warn: (text: string) => `${EMOJIS.warn} ${text}`,
  info: (text: string) => `${EMOJIS.general} ${text}`,
};

/**
 * Ceza başarı mesajı formatı:
 * `<emoji> **kullanıcı** <fiil>.`
 * `sebep: <sebep>`
 * `süre: <süre>` (opsiyonel)
 */
export function modSuccess(opts: {
  emoji: string;
  tag: string;
  verb: string;
  reason: string;
  duration?: string;
  extraLines?: string[];
}): string {
  const reason = opts.reason.trim();
  const shortReason = reason.length > 200 ? `${reason.slice(0, 197)}...` : reason;
  const lines = [
    `${opts.emoji} **${opts.tag}** ${opts.verb}`,
    `\`sebep:\` ${shortReason}`,
    ...(opts.duration ? [`\`süre:\` ${opts.duration}`] : []),
    ...(opts.extraLines ?? []),
  ];
  return lines.join("\n");
}

/** Yanıtlarda ping'i kapatır (reply varsayılan olarak komutu yazanı etiketler). */
export const NO_PING: {
  allowedMentions: { repliedUser: boolean; parse: ("users" | "roles" | "everyone")[] };
} = {
  allowedMentions: { repliedUser: false, parse: [] },
};

/**
 * Moderatör yetki kontrolü: `!izin` anahtarı veya Discord native yetkisi.
 * Yetki yoksa kısa hata mesajı gönderir ve false döner.
 */
export async function requireModPerm(
  message: Message,
  permKey: string,
  nativePerm: PermissionResolvable,
): Promise<boolean> {
  if (!message.guild || !message.member) return false;
  const granted = await hasPermission(message, permKey);
  if (!granted && !message.member.permissions.has(nativePerm)) {
    markPermissionDenied(message, `${permKey} yetkisi yok`);
    await message.reply({
      flags: COMPONENTS_V2_FLAG,
      components: [errorCard({ description: msg.err(`Bu komut için yetkin yok. Admin: \`!izin ${permKey} @sen\``) })],
      ...NO_PING,
    });
    return false;
  }
  return true;
}

/**
 * Kendine / bota / bot sahibine işlem engeli.
 * Engel varsa kısa hata mesajı gönderir ve true döner (komut durmalı).
 */
export async function isProtectedTarget(
  message: Message,
  targetId: string,
  verbs: { self: string; bot: string; owner: string },
): Promise<boolean> {
  if (targetId === message.author.id) {
    await message.reply({ flags: COMPONENTS_V2_FLAG, components: [errorCard({ description: msg.err(verbs.self) })], ...NO_PING  });
    return true;
  }
  if (targetId === message.client.user?.id) {
    await message.reply({ flags: COMPONENTS_V2_FLAG, components: [errorCard({ description: msg.err(verbs.bot) })], ...NO_PING  });
    return true;
  }
  if (targetId === OWNER_ID) {
    await message.reply({ flags: COMPONENTS_V2_FLAG, components: [errorCard({ description: msg.err(verbs.owner) })], ...NO_PING  });
    return true;
  }
  return false;
}

/**
 * Botun genel yetkisini denetler (örn. Üyeleri Yasakla).
 * Eksikse kısa hata mesajı gönderir ve false döner.
 */
export async function checkBotPerm(
  message: Message,
  perm: PermissionResolvable,
  permLabel: string,
): Promise<boolean> {
  const me = await message.guild!.members.fetchMe().catch(() => message.guild!.members.me);
  if (!me?.permissions.has(perm)) {
    await message.reply({
      flags: COMPONENTS_V2_FLAG,
      components: [errorCard({ description: msg.err(`Botun **${permLabel}** yetkisi yok. Rolümü ve izinlerimi kontrol et.`) })],
      ...NO_PING,
    });
    return false;
  }
  return true;
}

/**
 * Botun belirli bir üyeye işlem yapabilmesini denetler
 * (rol hiyerarşisi + izin + sunucu sahibi kontrolü).
 * Engelliyse kısa hata mesajı gönderir ve false döner.
 */
export async function checkBotAble(
  message: Message,
  target: GuildMember,
  perm: PermissionResolvable,
  actionVerb: "yasaklayamam" | "atamam" | "susturamam" | "susturmasını kaldıramam",
  permLabel: string,
): Promise<boolean> {
  const me = await message.guild!.members.fetchMe().catch(() => message.guild!.members.me);
  const reason = getBotModerationBlockReason(me, target, perm, message.author.id);
  if (reason) {
    await message.reply({
      flags: COMPONENTS_V2_FLAG,
      components: [errorCard({ description: msg.err(botModerationBlockMessage(reason, actionVerb, permLabel)) })],
      ...NO_PING,
    });
    return false;
  }
  return true;
}

/**
 * Moderatörün hedefe işlem yapabilmesini denetler (rol hiyerarşisi).
 * Engelliyse kısa hata mesajı gönderir ve false döner.
 */
export async function checkHierarchy(message: Message, target: GuildMember): Promise<boolean> {
  if (!canModerate(message.member!, target)) {
    await message.reply({
      flags: COMPONENTS_V2_FLAG,
      components: [errorCard({ description: msg.err("Bu kullanıcının rolü seninkiyle aynı veya daha yüksek.") })],
      ...NO_PING,
    });
    return false;
  }
  return true;
}

/**
 * Audit log sebebi — Discord'un 512 karakter sınırına takılmaması için
 * güvenli şekilde kısaltılır.
 */
export function auditReason(caseId: string, modTag: string, reason: string): string {
  return `[${caseId}] ${modTag}: ${reason}`.slice(0, 480);
}

/**
 * "ceza" log kanalına detaylı embed gönderir (modlar için denetim kaydı).
 * Kanal ayarlı değilse veya gönderilemezse sessizce geçilir.
 */
export async function sendModLog(guild: Guild, embed: ContainerBuilder): Promise<void> {
  try {
    const logChannelId = await getChannelSetting(guild.id, "ceza");
    if (!logChannelId) return;
    const channel = await guild.channels.fetch(logChannelId).catch(() => null);
    if (channel?.isTextBased()) {
      await (channel as TextChannel).send({
        flags: COMPONENTS_V2_FLAG,
        components: [embed],
        allowedMentions: { parse: [] },
      });
    }
  } catch (err) {
    console.error("ceza log gitmedi:", err);
  }
}

/**
 * Başarı mesajını ÖNCE gönderir, cezayı SONRA uygular.
 *
 * Akış: tüm doğrulamalar bitti -> `sendFirst()` ile kısa mesaj kanala gider ->
 * `action()` çalışır. Action başarısız olursa gönderilen mesaj hata mesajıyla
 * düzenlenir (kullanıcıya yalan söylenmez).
 */
export async function announceThenAct(
  message: Message,
  successText: string,
  action: () => Promise<void>,
  failText: string,
): Promise<boolean> {
  const sent = await message.reply({ flags: COMPONENTS_V2_FLAG, components: textCard(successText), ...NO_PING  });
  try {
    await action();
    return true;
  } catch (err) {
    console.error("moderasyon patladı:", err);
    await sent.edit({ flags: COMPONENTS_V2_FLAG, components: [errorCard({ description: msg.err(failText) })] }).catch(() => undefined);
    return false;
  }
}
