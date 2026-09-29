import { MessageFlags } from "discord.js";
import type { Message } from "discord.js";
import type { Command } from "../../types.js";
import { infoEmbed, errorEmbed } from "../../utils/embeds.js";
import { addSlash } from "../../utils/slashBridge.js";

const MIN = 1;
const MAX = 10;

const command: Command = {
  name: "tahmin",
  aliases: ["sayıtahmin", "sayitahmin", "guess"],
  description: "1-10 arası tuttuğum sayıyı tahmin et",
  usage: "!tahmin <1-10>",
  category: "fun",

  async execute(message: Message, args: string[]) {
    const guess = parseInt(args[0] ?? "", 10);
    if (isNaN(guess) || guess < MIN || guess > MAX) {
      return message.reply({
        flags: MessageFlags.IsComponentsV2,
        components: [errorEmbed("Hatalı Kullanım", `1 ile 10 arası bir sayı yaz. Kullanım: \`${command.usage}\``)],
      });
    }
    const picked = Math.floor(Math.random() * (MAX - MIN + 1)) + MIN;
    if (guess === picked) {
      return message.reply({
        flags: MessageFlags.IsComponentsV2,
        components: [
          infoEmbed(
            "🎯 Bildin!",
            `${message.author}, aklımda tuttuğum sayı **${picked}** idi ve sen bildin! İnanılmazsın! 🥳`,
          ),
        ],
      });
    }
    const diff = Math.abs(guess - picked);
    const hint = diff === 1 ? "Çok yaklaştın, 1 farkla kaçırdın! 😱" : diff <= 3 ? "Yaklaştın ama tutmadı 😅" : "Bayağı uzaktasın, bir daha dene 🎲";
    return message.reply({
      flags: MessageFlags.IsComponentsV2,
      components: [
        infoEmbed(
          "❌ Tutamadı",
          `Aklımdaki sayı **${picked}** idi, sen **${guess}** dedin.\n\n${hint}`,
        ),
      ],
    });
  },
};

addSlash(
  command,
  [{ name: "sayi", description: "Tahminin (1-10)", type: "integer", required: true, minValue: 1, maxValue: 10 }],
  (v) => [String(v.int("sayi") ?? "")],
);

export default command;
