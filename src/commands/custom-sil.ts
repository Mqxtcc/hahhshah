import { errorCard, V2CardBuilder } from "../utils/componentsV2.js";
import { MessageFlags, type Message } from "discord.js";
import type { Command } from "../types.js";
import { COLORS } from "../utils/embeds.js";
import { EMOJIS } from "../utils/emojis.js";
import { getGuildPrefix, requireOwnerOrGuildOwner } from "../events/messageCreate.js";
import { deleteCustomEvent } from "../customEvents/store.js";
import { addSlash } from "../utils/slashBridge.js";
import { usageEmbed } from "../utils/messages.js";

const command: Command = {
  name: "custom-sil",
  aliases: ["customsil", "customevent-sil", "ce-sil"],
  description: "Bu sunucudaki bir custom event'i siler (sadece sunucu sahibi/taç sahibi)",
  usage: "!custom-sil <isim>",
  category: "genel",

  async execute(message: Message, args: string[]) {
    if (!message.guild) {
      return message.reply({ flags: MessageFlags.IsComponentsV2, components: [errorCard({ description: `${EMOJIS.error} Bu komut sadece bir sunucu içinde kullanılabilir.` })] });
    }
    if (!(await requireOwnerOrGuildOwner(message))) return;

    const prefix = getGuildPrefix(message.guild.id);
    const name = (args[0] ?? "").toLowerCase().trim();

    if (!name) {
      return message.reply({
      flags: MessageFlags.IsComponentsV2, components: [usageEmbed(`${EMOJIS.usage} Kullanım: \`${prefix}custom-sil <isim>\` (ör. \`${prefix}custom-sil selamla\`)`)] });
    }

    const deleted = await deleteCustomEvent(message.guild.id, name);

    if (!deleted) {
      return message.reply({
      flags: MessageFlags.IsComponentsV2,
        components: [
          new V2CardBuilder()
            .setColor(COLORS.error)
            .setTitle(`${EMOJIS.error} Bulunamadı`)
            .setDescription(`\`${name}\` adında bir custom event yok. \`${prefix}customevent-liste\` ile mevcut olanları görebilirsin.`),
        ],
      });
    }

    return message.reply({
      flags: MessageFlags.IsComponentsV2,
      components: [
        new V2CardBuilder()
          .setColor(COLORS.success)
          .setTitle("🗑️ Custom event silindi")
          .setDescription(`\`${name}\` başarıyla silindi.`),
      ],
    });
  },
};


addSlash(command, [
  { name: "isim", description: "Silinecek özel komutun ismi", type: "string", required: true },
]);

export default command;
