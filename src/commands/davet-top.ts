import { V2CardBuilder } from "../utils/componentsV2.js";
import { MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type Message,
} from "discord.js";
import type { Command } from "../types.js";
import { BOT_NAME } from "../config.js";
import { COLORS } from "../utils/embeds.js";
import { getTopInviters } from "../invites/store.js";

const MEDALS = ["🥇", "🥈", "🥉"];

async function buildEmbed(): Promise<V2CardBuilder> {
  const top = await getTopInviters(10);
  const embed = new V2CardBuilder()
    .setColor(COLORS.brand)
    .setTitle(`🏆 ${BOT_NAME} Davet Sıralaması`);
  if (top.length === 0) {
    embed.setDescription(
      "Henüz hak kazanılmış davet yok. İlk elçi sen ol — `!davet` yaz, linki kap!",
    );
  } else {
    embed.setDescription(
      top
        .map(
          (t, i) =>
            `${MEDALS[i] ?? `**${i + 1}.**`} <@${t.userId}> — \`${t.invites}\` davet`,
        )
        .join("\n"),
    );
  }
  embed.setFooter({ text: "Ödüller için !davet yaz" });
  return embed;
}

const command: Command = {
  name: "davet-top",
  aliases: ["davetsiralama", "invite-top"],
  description: "En çok davet edenlerin sıralaması",
  usage: "!davet-top",
  category: "genel",

  slashData: new SlashCommandBuilder()
    .setName("davet-top")
    .setDescription("En çok davet edenlerin sıralaması"),

  async execute(message: Message, _args: string[]) {
    return message.reply({
      flags: MessageFlags.IsComponentsV2,
      components: [await buildEmbed()],
      allowedMentions: { repliedUser: false },
    });
  },

  async slashExecute(interaction: ChatInputCommandInteraction) {
    await interaction.reply({
      flags: MessageFlags.IsComponentsV2, components: [await buildEmbed()] });
  },
};

export default command;
