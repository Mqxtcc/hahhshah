import { COMPONENTS_V2_FLAG, errorCard, V2CardBuilder } from "../../utils/componentsV2.js";
import { PermissionFlagsBits, type Message } from "discord.js";
import type { Command } from "../../types.js";
import { generateCaseId, notifCard } from "../../utils/modUtils.js";
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
  isProtectedTarget,
  modSuccess,
  msg,
  requireModPerm,
  sendModLog,
} from "./_shared.js";
import { addSlash } from "../../utils/slashBridge.js";

const command: Command = {
  name: "kick",
  aliases: ["at"],
  description: "Kullanıcıyı sunucudan atar",
  usage: "!kick <@kullanıcı|id> [sebep]",
  category: "mod",

  async execute(message: Message, args: string[]) {
    if (!message.guild || !message.member) return;

    if (!(await requireModPerm(message, "kick", PermissionFlagsBits.KickMembers))) return;

    const targetId = parseMention(args[0] ?? "");
    if (!targetId) {
      await message.reply({
        flags: COMPONENTS_V2_FLAG,
        components: [msg.usageEmbed("Kullanım: `!kick <@kullanıcı|id> [sebep]`")],
        ...NO_PING,
      });
      return;
    }

    if (
      await isProtectedTarget(message, targetId, {
        self: "Kendini atamazsın.",
        bot: "Beni atamazsın.",
        owner: "Bot sahibini atamam.",
      })
    )
      return;

    const reason = args.slice(1).join(" ").trim() || "Sebep belirtilmedi";

    if (!(await checkBotPerm(message, PermissionFlagsBits.KickMembers, "Üyeleri At"))) return;

    const member = await message.guild.members.fetch(targetId).catch(() => null);
    if (!member) {
      await message.reply({ flags: COMPONENTS_V2_FLAG, components: [errorCard({ description: msg.err("Kullanıcı sunucuda değil.") })], ...NO_PING  });
      return;
    }

    if (!(await checkBotAble(message, member, PermissionFlagsBits.KickMembers, "atamam", "Üyeleri At")))
      return;
    if (!(await checkHierarchy(message, member))) return;

    const caseId = generateCaseId();
    const targetUser = member.user;

    // Önce kısa başarı mesajı kanala gider, SONRA atma uygulanır.
    const done = await announceThenAct(
      message,
      modSuccess({ emoji: EMOJIS.success, tag: targetUser.tag, verb: "sunucudan atıldı.", reason }),
      async () => {
        await member.kick(auditReason(caseId, message.author.tag, reason));
      },
      "Atma işlemi başarısız oldu. Botun yetkilerini ve rol sırasını kontrol et.",
    );
    if (!done) return;

    // DM bildirimi — en iyi çabayla, sessizce.
    const card = notifCard("Sunucudan atıldın", targetUser, reason, message.author.tag);
    await targetUser.send({ flags: COMPONENTS_V2_FLAG, components: [card] }).catch(() => undefined);

    await sendModLog(
      message.guild,
      moderationEmbed({
        action: "Kullanıcı Atıldı",
        emoji: EMOJIS.mod,
        color: COLORS.warning,
        targetTag: `${targetUser}`,
        targetId: targetUser.id,
        targetAvatar: targetUser.displayAvatarURL({ size: 256 }),
        moderatorTag: `${message.author}`,
        reason,
        caseId,
      }),
    );
  },
};


addSlash(command, [
  { name: "kullanici", description: "Atılacak kullanıcı", type: "user", required: true },
  { name: "sebep", description: "Atılma sebebi", type: "string" },
]);

export default command;
