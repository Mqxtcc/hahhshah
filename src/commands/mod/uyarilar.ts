import { COMPONENTS_V2_FLAG, errorCard, V2CardBuilder } from "../../utils/componentsV2.js";
import { PermissionFlagsBits, type Message } from "discord.js";
import { eq, and, desc, count } from "../../db/jsonOrm.js";
import type { Command } from "../../types.js";
import { parseMention } from "../../utils/parse.js";
import { db, warningsTable } from "../../db/index.js";
import { COLORS } from "../../utils/embeds.js";
import { EMOJIS } from "../../utils/emojis.js";
import { NO_PING, msg, requireModPerm } from "./_shared.js";
import { addSlash } from "../../utils/slashBridge.js";

/** Uzun sebepleri liste görünümünde kısaltır. */
function shortReason(reason: string): string {
  const r = reason.trim();
  return r.length > 120 ? `${r.slice(0, 117)}...` : r;
}

const command: Command = {
  name: "uyarilar",
  aliases: ["warnings", "warns", "uyarılar"],
  description: "Kullanıcının uyarı geçmişini listeler",
  usage: "!uyarilar <@kullanıcı|id>",
  category: "mod",

  async execute(message: Message, args: string[]) {
    if (!message.guild || !message.member) return;

    if (!(await requireModPerm(message, "uyarilar", PermissionFlagsBits.ModerateMembers))) return;

    const targetId = parseMention(args[0] ?? "") || message.author.id;
    const target = await message.client.users.fetch(targetId).catch(() => null);

    if (!target) {
      await message.reply({ flags: COMPONENTS_V2_FLAG, components: [errorCard({ description: msg.err("Kullanıcı bulunamadı.") })], ...NO_PING  });
      return;
    }

    const where = and(eq(warningsTable.userId, target.id), eq(warningsTable.guildId, message.guild.id));

    const [{ value: total }] = await db.select({ value: count() }).from(warningsTable).where(where);

    const warnings = await db
      .select()
      .from(warningsTable)
      .where(where)
      .orderBy(desc(warningsTable.createdAt))
      .limit(15);

    const embed = new V2CardBuilder()
      .setColor(total === 0 ? COLORS.success : COLORS.warning)
      .setAuthor({ name: target.tag, iconURL: target.displayAvatarURL() })
      .setTitle(`${EMOJIS.warn} Uyarı Geçmişi — Toplam: ${total}`)
      .setTimestamp();

    if (total === 0) {
      embed.setDescription("Bu kullanıcının hiç uyarısı yok.");
    } else {
      embed.setDescription(
        warnings
          .map(
            (w, i) =>
              `\`${i + 1}.\` **${shortReason(w.reason)}**\n└ <@${w.moderatorId}> • <t:${Math.floor(
                new Date(w.createdAt).getTime() / 1000,
              )}:R>`,
          )
          .join("\n\n"),
      );
      if (total > 15) {
        embed.setFooter({ text: `Son 15 uyarı gösteriliyor (toplam ${total})` });
      }
    }

    await message.reply({ flags: COMPONENTS_V2_FLAG, components: [embed], ...NO_PING });
  },
};


addSlash(command, [
  { name: "kullanici", description: "Uyarıları görülecek kullanıcı", type: "user", required: true },
]);

export default command;
