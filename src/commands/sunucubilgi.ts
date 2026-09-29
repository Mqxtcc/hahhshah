import { V2CardBuilder } from "../utils/componentsV2.js";
import { MessageFlags, ChannelType, type Message } from "discord.js";
import type { Command } from "../types.js";
import { COLORS } from "../utils/embeds.js";
import { errorEmbed } from "../utils/embeds.js";
import { addSlash } from "../utils/slashBridge.js";

function formatDate(date: Date): string {
  return date.toLocaleDateString("tr-TR", { day: "2-digit", month: "long", year: "numeric" });
}

const command: Command = {
  name: "sunucubilgi",
  aliases: ["serverinfo", "si", "sunucu"],
  description: "Bulunduğun sunucu hakkında bilgi gösterir",
  usage: "!sunucubilgi",
  category: "genel",

  async execute(message: Message) {
    const guild = message.guild;
    if (!guild) {
      return message.reply({
      flags: MessageFlags.IsComponentsV2, components: [errorEmbed("Hata", "Bu komut sadece sunucu içinde kullanılabilir.")] });
    }

    const owner = await guild.fetchOwner().catch(() => null);
    const textChannels = guild.channels.cache.filter((c) => c.type === ChannelType.GuildText).size;
    const voiceChannels = guild.channels.cache.filter((c) => c.type === ChannelType.GuildVoice).size;

    const guildIcon = guild.iconURL({ size: 512 });
    const embed = new V2CardBuilder()
      .setColor(COLORS.info)
      .setTitle(`🌐 ${guild.name}`)
      .addFields(
        { name: "Sahip", value: owner ? `${owner.user.tag}` : "bilinmiyor", inline: true },
        { name: "Üye sayısı", value: `${guild.memberCount}`, inline: true },
        { name: "Oluşturulma tarihi", value: formatDate(guild.createdAt), inline: true },
        { name: "Boost seviyesi", value: `${guild.premiumTier} (${guild.premiumSubscriptionCount ?? 0} boost)`, inline: true },
        { name: "Metin kanalı", value: `${textChannels}`, inline: true },
        { name: "Ses kanalı", value: `${voiceChannels}`, inline: true },
        { name: "Rol sayısı", value: `${guild.roles.cache.size}`, inline: true },
      )
      .setFooter({ text: `Sunucu ID: ${guild.id}` })
      .setTimestamp();
    if (guildIcon) embed.setThumbnail(guildIcon);

    return message.reply({
      flags: MessageFlags.IsComponentsV2, components: [embed] });
  },
};


addSlash(command, []);

export default command;
