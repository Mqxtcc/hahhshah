import { MessageFlags,
  SlashCommandBuilder,
  type Message,
  type ChatInputCommandInteraction,
} from "discord.js";
import type { Command } from "../../types.js";
import { infoEmbed } from "../../utils/embeds.js";

const command: Command = {
  name: "yazitura",
  aliases: ["coinflip", "flip"],
  description: "Yazı mı tura mı?",
  usage: "!yazitura",
  category: "fun",

  slashData: new SlashCommandBuilder()
    .setName("yazitura")
    .setDescription("Yazı mı tura mı?"),

  async execute(message: Message) {
    const sonuc = Math.random() < 0.5 ? "🪙 YAZI" : "🔵 TURA";
    return message.reply({
      flags: MessageFlags.IsComponentsV2,
      components: [
        infoEmbed(
          "Yazı Tura",
          `${message.author} para attı ve çıkan: **${sonuc}**`,
        ),
      ],
    });
  },

  async slashExecute(interaction: ChatInputCommandInteraction) {
    const sonuc = Math.random() < 0.5 ? "🪙 YAZI" : "🔵 TURA";
    await interaction.reply({
      flags: MessageFlags.IsComponentsV2,
      components: [
        infoEmbed(
          "Yazı Tura",
          `${interaction.user} para attı ve çıkan: **${sonuc}**`,
        ),
      ],
    });
  },
};

export default command;
