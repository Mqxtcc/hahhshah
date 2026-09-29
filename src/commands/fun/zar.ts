import { MessageFlags,
  SlashCommandBuilder,
  type Message,
  type ChatInputCommandInteraction,
} from "discord.js";
import type { Command } from "../../types.js";
import { infoEmbed, errorEmbed } from "../../utils/embeds.js";

function rollDice(sides: number, count: number): { rolls: number[]; total: number } {
  const rolls = Array.from(
    { length: count },
    () => Math.floor(Math.random() * sides) + 1,
  );
  const total = rolls.reduce((a, b) => a + b, 0);
  return { rolls, total };
}

const command: Command = {
  name: "zar",
  aliases: ["roll", "dice"],
  description: "Zar atar",
  usage: "!zar [yüzler] [adet]  →  örn: !zar 20 2",
  category: "fun",

  slashData: new SlashCommandBuilder()
    .setName("zar")
    .setDescription("Zar atar")
    .addIntegerOption((opt) =>
      opt
        .setName("yuzler")
        .setDescription("Zar yüzü sayısı (varsayılan 6)")
        .setMinValue(2)
        .setMaxValue(1000)
        .setRequired(false),
    )
    .addIntegerOption((opt) =>
      opt
        .setName("adet")
        .setDescription("Kaç zar atılacak (varsayılan 1)")
        .setMinValue(1)
        .setMaxValue(10)
        .setRequired(false),
    ),

  async execute(message: Message, args: string[]) {
    const sides = parseInt(args[0] ?? "6", 10);
    const count = parseInt(args[1] ?? "1", 10);

    if (
      isNaN(sides) ||
      sides < 2 ||
      sides > 1000 ||
      isNaN(count) ||
      count < 1 ||
      count > 10
    ) {
      return message.reply({
        flags: MessageFlags.IsComponentsV2,
        components: [
          errorEmbed(
            "Hatalı Kullanım",
            `Kullanım: \`${command.usage}\`\nYüzler: 2–1000, Adet: 1–10`,
          ),
        ],
      });
    }

    const { rolls, total } = rollDice(sides, count);
    const rollsText =
      count > 1
        ? `\n🎲 Sonuçlar: ${rolls.join(", ")}\n📊 Toplam: **${total}**`
        : `\n🎲 Sonuç: **${rolls[0]}**`;

    return message.reply({
      flags: MessageFlags.IsComponentsV2,
      components: [
        infoEmbed(
          `🎲 ${count}d${sides} Zar Atışı`,
          `${message.author} zar attı!${rollsText}`,
        ),
      ],
    });
  },

  async slashExecute(interaction: ChatInputCommandInteraction) {
    const sides = interaction.options.getInteger("yuzler") ?? 6;
    const count = interaction.options.getInteger("adet") ?? 1;
    const { rolls, total } = rollDice(sides, count);
    const rollsText =
      count > 1
        ? `\n🎲 Sonuçlar: ${rolls.join(", ")}\n📊 Toplam: **${total}**`
        : `\n🎲 Sonuç: **${rolls[0]}**`;

    await interaction.reply({
      flags: MessageFlags.IsComponentsV2,
      components: [
        infoEmbed(
          `🎲 ${count}d${sides} Zar Atışı`,
          `${interaction.user} zar attı!${rollsText}`,
        ),
      ],
    });
  },
};

export default command;
