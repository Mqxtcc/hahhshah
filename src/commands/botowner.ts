import { MessageFlags, type Message } from "discord.js";
import { OWNER_ID } from "../config.js";
import type { Command } from "../types.js";
import { errorCard, infoCard } from "../utils/componentsV2.js";
import { getGuildPrefix } from "../events/messageCreate.js";

const botOwner: Command = {
  name: "botowner",
  aliases: ["bot-sahibi"],
  description: "Bot sahibinin bilgilerini gösterir",
  usage: "botowner",
  category: "genel",
  async execute(message: Message) {
    const prefix = getGuildPrefix(message.guild?.id);
    const owner = await message.client.users.fetch(OWNER_ID).catch(() => null);
    if (!owner) {
      await message.reply({
        flags: MessageFlags.IsComponentsV2,
        components: [errorCard({
          title: "Bot sahibi bulunamadı",
          description: "Bot sahibinin Discord profiline şu anda ulaşılamadı.",
        })],
      }).catch(() => null);
      return;
    }

    await message.reply({
      flags: MessageFlags.IsComponentsV2,
      components: [infoCard({
        title: owner.username,
        description: `**Etiket:** ${owner.tag}\n**Kullanıcı ID:** \`${owner.id}\`\n\nKullanım: \`${prefix}botowner\``,
        thumbnail: owner.displayAvatarURL({ size: 256 }),
        thumbnailDescription: `${owner.username} avatarı`,
      })],
    }).catch(() => null);
  },
};

export default botOwner;
