import { COMPONENTS_V2_FLAG, errorCard, V2CardBuilder } from "../../utils/componentsV2.js";
import { PermissionFlagsBits, type Message } from "discord.js";
import type { Command } from "../../types.js";
import { generateCaseId, notifCard } from "../../utils/modUtils.js";
import { parseMention, formatDuration } from "../../utils/parse.js";
import { EMOJIS } from "../../utils/emojis.js";
import { COLORS, moderationEmbed } from "../../utils/embeds.js";
import {
  NO_PING,
  announceThenAct,
  auditReason,
  checkBotAble,
  checkBotPerm,
  checkHierarchy,
  isProtectedTarget,
  modSuccess,
  msg,
  requireModPerm,
  sendModLog,
} from "./_shared.js";
import { addSlash } from "../../utils/slashBridge.js";

const MAX_TIMEOUT_MS = 28 * 24 * 60 * 60 * 1000; // Discord limiti: 28 gün

const UNIT_MS: Record<string, number> = {
  // İngilizce: 15d = 15 gün, 1h = 1 saat, 30m = 30 dakika, 45s = 45 saniye, 1w = 1 hafta
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
  // Türkçe: 10dk, 1saat, 2g, 45sn, 1hf
  sn: 1_000,
  saniye: 1_000,
  dk: 60_000,
  dakika: 60_000,
  sa: 3_600_000,
  saat: 3_600_000,
  g: 86_400_000,
  gun: 86_400_000,
  gün: 86_400_000,
  hf: 604_800_000,
  hafta: 604_800_000,
};

/** "10dk"/"10m", "1saat"/"1h", "15d" (15 gün), "1w", "1g12saat", "30" (dakika varsayılan) gibi süreleri parse eder. */
function parseTimeoutDuration(input: string): number | null {
  const trimmed = input.trim().toLocaleLowerCase("tr-TR");
  if (!trimmed) return null;

  // Sadece sayı → dakika
  if (/^\d+$/.test(trimmed)) {
    const minutes = Number.parseInt(trimmed, 10);
    if (minutes < 1) return null;
    return minutes * 60_000;
  }

  // Uzun birimler önce denenir: "15dk" → dk (dakika), "15d" → d (gün).
  // Birimden sonra bitişik sayı gelebilir ("1g12saat"), bu yüzden \b yerine lookahead.
  const re = /(\d+)\s*(saniye|sn|dakika|dk|saat|sa|hafta|hf|gun|gün|w|g|d|h|m|s)(?=$|\s|\d)/giu;
  let total = 0;
  let matched = false;
  let match: RegExpExecArray | null;
  while ((match = re.exec(trimmed))) {
    matched = true;
    const amount = Number.parseInt(match[1], 10);
    const unit = UNIT_MS[match[2].toLowerCase()];
    if (!unit) return null;
    total += amount * unit;
  }
  return matched && total > 0 ? total : null;
}

function humanDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (typeof formatDuration === "function") {
    try {
      return formatDuration(minutes);
    } catch {
      /* fallback */
    }
  }
  if (minutes < 60) return `${minutes} dakika`;
  if (minutes < 1440) return `${Math.round(minutes / 60)} saat`;
  return `${Math.round(minutes / 1440)} gün`;
}

const command: Command = {
  name: "timeout",
  aliases: ["mute", "sus", "sustur"],
  description: "Kullanıcıyı belirtilen süre boyunca susturur (timeout)",
  usage: "!timeout <@kullanıcı|id> <süre> [sebep]  ·  süre: 10dk | 1saat | 2g | 30",
  category: "mod",

  async execute(message: Message, args: string[]) {
    if (!message.guild || !message.member) return;

    if (!(await requireModPerm(message, "mute", PermissionFlagsBits.ModerateMembers))) return;

    const targetId = parseMention(args[0] ?? "");
    const durationMs = parseTimeoutDuration(args[1] ?? "");

    if (!targetId || durationMs === null) {
      await message.reply({
        flags: COMPONENTS_V2_FLAG,
        components: [msg.usageEmbed(
          "Kullanım: `!timeout <@kullanıcı|id> <süre> [sebep]`\n" +
            "Süre örnekleri: `10dk`/`10m`, `1saat`/`1h`, `15d` (15 gün), `1w` (1 hafta), `30` (dakika)\n" +
            "Maksimum: **28 gün**",
        )],
        ...NO_PING,
      });
      return;
    }

    if (durationMs > MAX_TIMEOUT_MS) {
      await message.reply({
        flags: COMPONENTS_V2_FLAG,
        components: [errorCard({ description: msg.err("Süre en fazla **28 gün** olabilir.") })],
        ...NO_PING,
      });
      return;
    }

    if (
      await isProtectedTarget(message, targetId, {
        self: "Kendini susturamazsın.",
        bot: "Beni susturamazsın.",
        owner: "Bot sahibini susturamam.",
      })
    )
      return;

    const reason = args.slice(2).join(" ").trim() || "Sebep belirtilmedi";

    if (!(await checkBotPerm(message, PermissionFlagsBits.ModerateMembers, "Üyeleri Yönet (Timeout)")))
      return;

    const member = await message.guild.members.fetch(targetId).catch(() => null);
    if (!member) {
      await message.reply({ flags: COMPONENTS_V2_FLAG, components: [errorCard({ description: msg.err("Kullanıcı sunucuda değil.") })], ...NO_PING  });
      return;
    }

    // Discord botları susturmaya izin vermez — API 400 döner, en baştan engelle.
    if (member.user.bot) {
      await message.reply({ flags: COMPONENTS_V2_FLAG, components: [errorCard({ description: msg.err("Botlar susturulamaz.") })], ...NO_PING  });
      return;
    }

    if (
      !(await checkBotAble(
        message,
        member,
        PermissionFlagsBits.ModerateMembers,
        "susturamam",
        "Üyeleri Yönet (Timeout)",
      ))
    )
      return;
    if (!(await checkHierarchy(message, member))) return;

    const caseId = generateCaseId();
    const durationLabel = humanDuration(durationMs);

    // Önce kısa başarı mesajı kanala gider, SONRA susturma uygulanır.
    const done = await announceThenAct(
      message,
      modSuccess({
        emoji: EMOJIS.success,
        tag: member.user.tag,
        verb: "susturuldu.",
        reason,
        duration: durationLabel,
      }),
      async () => {
        await member.timeout(durationMs, auditReason(caseId, message.author.tag, reason));
      },
      "Susturma başarısız oldu. Botun yetkilerini ve rol sırasını kontrol et.",
    );
    if (!done) return;

    // DM bildirimi — en iyi çabayla, sessizce.
    const card = notifCard("Susturuldun", member.user, reason, message.author.tag, durationLabel);
    await member.user.send({ flags: COMPONENTS_V2_FLAG, components: [card] }).catch(() => undefined);

    await sendModLog(
      message.guild,
      moderationEmbed({
        action: "Kullanıcı Susturuldu",
        emoji: EMOJIS.timeout,
        color: COLORS.error,
        targetTag: `${member.user}`,
        targetId: member.id,
        targetAvatar: member.user.displayAvatarURL({ size: 256 }),
        moderatorTag: `${message.author}`,
        reason,
        caseId,
        duration: durationLabel,
      }),
    );
  },
};


addSlash(command, [
  { name: "kullanici", description: "Susturulacak kullanıcı", type: "user", required: true },
  { name: "sure", description: "Süre: 10dk, 1saat, 2g", type: "string", required: true },
  { name: "sebep", description: "Sebep", type: "string" },
]);

export default command;
