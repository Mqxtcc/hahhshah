import { COMPONENTS_V2_FLAG, errorCard, textCard, V2CardBuilder } from "../../utils/componentsV2.js";
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
  checkBotAble,
  checkBotPerm,
  checkHierarchy,
  modSuccess,
  msg,
  requireModPerm,
  sendModLog,
} from "./_shared.js";
import { addSlash } from "../../utils/slashBridge.js";

const command: Command = {
  name: "unmute",
  aliases: ["unsus", "susturma-kaldir", "susturmakaldir"],
  description: "Kullanıcının timeout (susturma) durumunu kaldırır",
  usage: "!unmute <@kullanıcı|id> [sebep]",
  category: "mod",

  async execute(message: Message, args: string[]) {
    if (!message.guild || !message.member) return;

    if (!(await requireModPerm(message, "unmute", PermissionFlagsBits.ModerateMembers))) return;

    const targetId = parseMention(args[0] ?? "");
    if (!targetId) {
      await message.reply({
        flags: COMPONENTS_V2_FLAG,
        components: [msg.usageEmbed("Kullanım: `!unmute <@kullanıcı|id> [sebep]`")],
        ...NO_PING,
      });
      return;
    }

    const reason = args.slice(1).join(" ").trim() || "Susturma kaldırıldı";

    if (!(await checkBotPerm(message, PermissionFlagsBits.ModerateMembers, "Üyeleri Yönet (Timeout)")))
      return;

    const member = await message.guild.members.fetch(targetId).catch(() => null);
    if (!member) {
      await message.reply({ flags: COMPONENTS_V2_FLAG, components: [errorCard({ description: msg.err("Kullanıcı sunucuda değil.") })], ...NO_PING  });
      return;
    }

    if (
      !(await checkBotAble(
        message,
        member,
        PermissionFlagsBits.ModerateMembers,
        "susturmasını kaldıramam",
        "Üyeleri Yönet (Timeout)",
      ))
    )
      return;
    if (!(await checkHierarchy(message, member))) return;

    // Zaten susturulmamışsa boşuna "başarılı" mesajı atmayalım.
    if (!member.isCommunicationDisabled()) {
      await message.reply({
        flags: COMPONENTS_V2_FLAG,
        components: textCard(msg.info(`${member.user.tag} şu an susturulmamış.`)),
        ...NO_PING,
      });
      return;
    }

    const caseId = generateCaseId();

    // Önce kısa başarı mesajı kanala gider, SONRA susturma kaldırılır.
    const done = await announceThenAct(
      message,
      modSuccess({ emoji: EMOJIS.success, tag: member.user.tag, verb: "susturması kaldırıldı.", reason }),
      async () => {
        await member.timeout(null, auditReason(caseId, message.author.tag, reason));
      },
      "Susturma kaldırılamadı. Botun yetkilerini ve rol sırasını kontrol et.",
    );
    if (!done) return;

    await sendModLog(
      message.guild,
      moderationEmbed({
        action: "Susturma Kaldırıldı",
        emoji: EMOJIS.success,
        color: COLORS.success,
        targetTag: `${member.user}`,
        targetId: member.id,
        targetAvatar: member.user.displayAvatarURL({ size: 256 }),
        moderatorTag: `${message.author}`,
        reason,
        caseId,
      }),
    );
  },
};


addSlash(command, [
  { name: "kullanici", description: "Susturması kaldırılacak kullanıcı", type: "user", required: true },
  { name: "sebep", description: "Sebep", type: "string" },
]);

export default command;
