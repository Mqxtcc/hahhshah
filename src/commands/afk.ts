import { V2CardBuilder } from "../utils/componentsV2.js";
import { MessageFlags,
  SlashCommandBuilder,
  type Message,
  type ChatInputCommandInteraction,
} from "discord.js";
import type { Command } from "../types.js";
import { EMOJIS } from "../utils/emojis.js";
import { setAfk } from "../afk/store.js";

function afkSetEmbed(
  username: string,
  avatarUrl: string,
  reason: string,
): V2CardBuilder {
  return new V2CardBuilder()
    .setColor(0x57f287)
    .setAuthor({
      name: `${username}, artık AFK!`,
      iconURL: avatarUrl,
    })
    .setDescription(`${EMOJIS.afkSet}`)
    .addFields({ name: "» Sebep", value: `• ${reason}` });
}

const command: Command = {
  name: "afk",
  aliases: ["uzakta"],
  description:
    "AFK (uzakta) durumuna geçer — seni etiketleyenlere otomatik bilgi verilir",
  usage: "!afk [sebep]",
  category: "genel",

  slashData: new SlashCommandBuilder()
    .setName("afk")
    .setDescription("AFK (uzakta) durumuna geçer")
    .addStringOption((opt) =>
      opt.setName("sebep").setDescription("AFK sebebi").setRequired(false),
    ),

  async execute(message: Message, args: string[]) {
    const reason = args.join(" ").trim() || "belirtilmedi";
    await setAfk(message.author.id, reason, message.createdTimestamp);
    const embed = afkSetEmbed(
      message.author.username,
      message.author.displayAvatarURL(),
      reason,
    );
    return message.reply({
      flags: MessageFlags.IsComponentsV2,
      components: [embed],
      allowedMentions: { repliedUser: false },
    });
  },

  async slashExecute(interaction: ChatInputCommandInteraction) {
    const reason =
      interaction.options.getString("sebep")?.trim() || "belirtilmedi";
    await setAfk(interaction.user.id, reason, interaction.createdTimestamp);
    const embed = afkSetEmbed(
      interaction.user.username,
      interaction.user.displayAvatarURL(),
      reason,
    );
    await interaction.reply({
      flags: MessageFlags.IsComponentsV2,
      components: [embed],
      allowedMentions: { repliedUser: false },
    });
  },
};

export default command;
