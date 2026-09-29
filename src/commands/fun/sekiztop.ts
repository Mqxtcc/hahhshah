import { MessageFlags,
  SlashCommandBuilder,
  type Message,
  type ChatInputCommandInteraction,
} from "discord.js";
import type { Command } from "../../types.js";
import { infoEmbed, errorEmbed } from "../../utils/embeds.js";
import { EMOJIS } from "../../utils/emojis.js";

const YANITLAR = [
  "Kesinlikle evet! 🟢",
  `Her işaret öyle diyor. ${EMOJIS.success}`,
  "Evet, şüphesiz. 👍",
  "Buna güvenebilirsin. 💪",
  "Görünüşe göre öyle. 😊",
  "Cevap net bir şekilde evet. ✨",
  "Şu an cevap bulanık, tekrar sor. 🌫️",
  "Daha sonra tekrar sor. 🕐",
  "Tahmin etmek şu an zor. 🤔",
  "Şimdi sor. ⏳",
  `Pek ihtimal dışı görünüyor. ${EMOJIS.error}`,
  "Hayır. 🔴",
  "Buna inanmıyorum. 😬",
  "Öyle görünmüyor. 👎",
  "Çok şüpheliyim. 😒",
  "Cevabım hayır. 🚫",
];

const command: Command = {
  name: "8ball",
  aliases: ["sekiztop", "8top"],
  description: "Sihirli 8-Top'a bir soru sor",
  usage: "!8ball <soru>",
  category: "fun",

  // Discord slash isimleri rakamla başlayamaz; "sekiztop" kullanıyoruz.
  slashData: new SlashCommandBuilder()
    .setName("sekiztop")
    .setDescription("Sihirli 8-Top'a bir soru sor")
    .addStringOption((opt) =>
      opt.setName("soru").setDescription("Sormak istediğin soru").setRequired(true),
    ),

  async execute(message: Message, args: string[]) {
    const soru = args.join(" ");
    if (!soru) {
      return message.reply({
        flags: MessageFlags.IsComponentsV2,
        components: [errorEmbed("Hatalı Kullanım", `Kullanım: \`${command.usage}\``)],
      });
    }
    const yanit = YANITLAR[Math.floor(Math.random() * YANITLAR.length)];
    return message.reply({
      flags: MessageFlags.IsComponentsV2,
      components: [
        infoEmbed("🎱 Sihirli 8-Top", `**Soru:** ${soru}\n\n**Cevap:** ${yanit}`),
      ],
    });
  },

  async slashExecute(interaction: ChatInputCommandInteraction) {
    const soru = interaction.options.getString("soru", true);
    const yanit = YANITLAR[Math.floor(Math.random() * YANITLAR.length)];
    await interaction.reply({
      flags: MessageFlags.IsComponentsV2,
      components: [
        infoEmbed("🎱 Sihirli 8-Top", `**Soru:** ${soru}\n\n**Cevap:** ${yanit}`),
      ],
    });
  },
};

export default command;
