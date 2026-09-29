import { MessageFlags } from "discord.js";
import type { Message } from "discord.js";
import type { Command } from "../../types.js";
import { infoEmbed } from "../../utils/embeds.js";
import { addSlash } from "../../utils/slashBridge.js";

const REELS = ["🍒", "🍋", "⭐", "🔔", "🍀", "💎", "7️⃣"];

export function spinReels(): [string, string, string] {
  const pick = () => REELS[Math.floor(Math.random() * REELS.length)];
  return [pick(), pick(), pick()];
}

export function spinResult(reels: [string, string, string]): { tier: "jackpot" | "pair" | "lose"; text: string } {
  const [a, b, c] = reels;
  if (a === b && b === c) {
    return {
      tier: "jackpot",
      text: a === "7️⃣" ? "🎰 JACKPOT! Üç tane 7️⃣! Efsanesin! 🏆" : `🎰 JACKPOT! Üç tane ${a}! Büyük kazandın! 🥳`,
    };
  }
  if (a === b || b === c || a === c) {
    return { tier: "pair", text: "✨ İkili tuttu! Küçük bir kazanç 😌" };
  }
  return { tier: "lose", text: "Tutmadı... bir daha çevir, şans döner 🎲" };
}

const command: Command = {
  name: "slot",
  aliases: ["kumarhane"],
  description: "Slot makinesini çevirir",
  usage: "!slot",
  category: "fun",

  async execute(message: Message) {
    const reels = spinReels();
    const { text } = spinResult(reels);
    return await message.reply({
      flags: MessageFlags.IsComponentsV2,
      components: [
        infoEmbed(
          "🎰 Slot Makinesi",
          `${message.author} çevirdi:\n\n\`[ ${reels.join(" | ")} ]\`\n\n${text}`,
        ),
      ],
    });
  },
};

addSlash(command, []);

export default command;
