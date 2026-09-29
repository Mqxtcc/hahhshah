import { COMPONENTS_V2_FLAG, errorCard, V2CardBuilder } from "../../utils/componentsV2.js";
import { PermissionFlagsBits, type Message } from "discord.js";
import type { Command } from "../../types.js";
import { generateCaseId } from "../../utils/modUtils.js";
import { parseMention } from "../../utils/parse.js";
import { EMOJIS } from "../../utils/emojis.js";
import { COLORS, moderationEmbed } from "../../utils/embeds.js";
import {
  NO_PING,
  announceThenAct,
  auditReason,
  checkBotPerm,
  modSuccess,
  msg,
  requireModPerm,
  sendModLog,
} from "./_shared.js";
import { addSlash } from "../../utils/slashBridge.js";

/** @mention veya düz ID'den kullanıcı ID'si çıkarır (yasaklı kullanıcı sunucuda olmadığı için mention çalışmayabilir). */
function parseUserId(raw: string | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  return parseMention(trimmed) ?? (/^\d{17,20}$/.test(trimmed) ? trimmed : null);
}

const command: Command = {
  name: "unban",
  aliases: ["yasakkaldir", "yasakkaldır"],
  description: "Yasaklı bir kullanıcının yasağını kaldırır",
  usage: "!unban <kullanıcı-id> [sebep]",
  category: "mod",

  async execute(message: Message, args: string[]) {
    if (!message.guild || !message.member) return;

    if (!(await requireModPerm(message, "unban", PermissionFlagsBits.BanMembers))) return;

    const userId = parseUserId(args[0]);
    if (!userId) {
      await message.reply({
        flags: COMPONENTS_V2_FLAG,
        components: [msg.usageEmbed(
          "Kullanım: `!unban <kullanıcı-id> [sebep]`\n" + "Geçerli bir Discord kullanıcı ID'si gir. (Etiket çalışmaz, ID gerekir.)",
        )],
        ...NO_PING,
      });
      return;
    }

    const reason = args.slice(1).join(" ").trim() || "Yasak kaldırıldı";

    if (!(await checkBotPerm(message, PermissionFlagsBits.BanMembers, "Üyeleri Yasakla"))) return;

    const ban = await message.guild.bans.fetch(userId).catch(() => null);
    if (!ban) {
      await message.reply({ flags: COMPONENTS_V2_FLAG, components: [errorCard({ description: msg.err("Bu kullanıcı sunucudan yasaklı değil.") })], ...NO_PING  });
      return;
    }

    const caseId = generateCaseId();

    // Önce kısa başarı mesajı kanala gider, SONRA yasak kaldırılır.
    const done = await announceThenAct(
      message,
      modSuccess({ emoji: EMOJIS.success, tag: ban.user.tag, verb: "yasağı kaldırıldı.", reason }),
      async () => {
        await message.guild!.members.unban(userId, auditReason(caseId, message.author.tag, reason));
      },
      "Yasak kaldırılamadı. Botun **Üyeleri Yasakla** yetkisini kontrol et.",
    );
    if (!done) return;

    await sendModLog(
      message.guild,
      moderationEmbed({
        action: "Yasak Kaldırıldı",
        emoji: EMOJIS.success,
        color: COLORS.success,
        targetTag: ban.user.tag,
        targetId: ban.user.id,
        targetAvatar: ban.user.displayAvatarURL({ size: 256 }),
        moderatorTag: `${message.author}`,
        reason,
        caseId,
      }),
    );
  },
};


addSlash(command, [
  { name: "kullanici_id", description: "Yasağı kaldırılacak kullanıcının ID'si", type: "string", required: true },
  { name: "sebep", description: "Sebep", type: "string" },
]);

export default command;
