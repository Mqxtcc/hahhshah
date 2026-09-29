import { V2CardBuilder, buttonRow } from "../../utils/componentsV2.js";
import { MessageFlags,
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type Message,
  type ChatInputCommandInteraction,
} from "discord.js";
import type { Command } from "../../types.js";
import { COLORS } from "../../utils/embeds.js";

function buildAvatarPayload(target: any, requester: any): {
  flags: typeof MessageFlags.IsComponentsV2;
  components: (V2CardBuilder | ActionRowBuilder<ButtonBuilder>)[];
} {
  const pngUrl = target.displayAvatarURL({ size: 1024, extension: "png" });
  const jpgUrl = target.displayAvatarURL({ size: 1024, extension: "jpg" });
  const webpUrl = target.displayAvatarURL({ size: 1024, extension: "webp" });

  const embed = new V2CardBuilder()
    .setColor(COLORS.dark)
    .setTitle(`Avatar — ${target.tag}`)
    .setImage(pngUrl)
    .setFooter({ text: requester.tag, iconURL: requester.displayAvatarURL() })
    .setTimestamp();

  const buttons = buttonRow([
    new ButtonBuilder().setLabel("PNG").setStyle(ButtonStyle.Link).setURL(pngUrl),
    new ButtonBuilder().setLabel("JPG").setStyle(ButtonStyle.Link).setURL(jpgUrl),
    new ButtonBuilder().setLabel("WEBP").setStyle(ButtonStyle.Link).setURL(webpUrl),
  ]);

  return { flags: MessageFlags.IsComponentsV2, components: [embed, buttons] };
}

const command: Command = {
  name: "avatar",
  aliases: ["av", "pp", "profilfoto"],
  description: "Kendinin ya da bir kullanıcının profil fotoğrafını gösterir",
  usage: "!avatar [@kullanıcı]",
  category: "fun",

  slashData: new SlashCommandBuilder()
    .setName("avatar")
    .setDescription(
      "Kendinin ya da bir kullanıcının profil fotoğrafını gösterir",
    )
    .addUserOption((opt) =>
      opt
        .setName("kullanici")
        .setDescription("Profil fotoğrafı gösterilecek kullanıcı")
        .setRequired(false),
    ),

  async execute(message: Message) {
    const target = message.mentions.users.first() ?? message.author;
    return message.reply(buildAvatarPayload(target, message.author));
  },

  async slashExecute(interaction: ChatInputCommandInteraction) {
    const target =
      interaction.options.getUser("kullanici") ?? interaction.user;
    await interaction.reply(buildAvatarPayload(target, interaction.user));
  },
};

export default command;
