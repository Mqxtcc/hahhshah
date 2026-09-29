import { MessageFlags } from "discord.js";
import type { Message, User } from "discord.js";
import type { Command } from "../../types.js";
import { infoEmbed, errorEmbed } from "../../utils/embeds.js";
import { addSlash } from "../../utils/slashBridge.js";

/** İki kullanıcı arasındaki "aşk yüzdesi" — aynı çiftte hep aynı sonuç. */
export function lovePercent(a: string, b: string): number {
  const [x, y] = [a, b].sort();
  let h = 2166136261;
  for (const ch of `${x}:${y}`) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h) % 101;
}

function tierText(p: number): string {
  if (p >= 90) return "Efsanevi bir aşk! Düğün ne zaman? 💍";
  if (p >= 70) return "Aranızda ciddi bir elektrik var ⚡";
  if (p >= 50) return "Bir şans verin derim, fena değil 😉";
  if (p >= 30) return "Arkadaşlık olarak güzel, aşk olarak zor 😅";
  if (p >= 10) return "Iııh... pek tutmamış 💔";
  return "Bu ikili yan yana gelmesin, kaos çıkar 🌪️";
}

function loveBar(p: number): string {
  const filled = Math.round(p / 10);
  return "❤️".repeat(filled) + "🤍".repeat(10 - filled);
}

const command: Command = {
  name: "aşk",
  aliases: ["aşkölçer"],
  description: "İki kişi arasındaki aşk yüzdesini ölçer",
  usage: "!aşk <@kullanıcı>",
  category: "fun",

  async execute(message: Message, args: string[]) {
    const target: User | undefined = message.mentions.users.first();
    if (!target) {
      return await message.reply({
        flags: MessageFlags.IsComponentsV2,
        components: [errorEmbed("Hatalı Kullanım", `Kimi ölçeceğim? Kullanım: \`${command.usage}\``)],
      });
    }
    if (target.bot) {
      return await message.reply({ flags: MessageFlags.IsComponentsV2,
      components: [errorEmbed("Olmaz", "Botlarla aşk yaşanmaz, üzgünüm 🤖💔")] });
    }
    if (target.id === message.author.id) {
      return await message.reply({
        flags: MessageFlags.IsComponentsV2,
        components: [
          infoEmbed(
            "💖 Kendine Aşk Testi",
            `Kendini sevmen güzel bir şey ${message.author}!\n\n${loveBar(100)}\n**%100** — ${tierText(100)}`,
          ),
        ],
      });
    }
    const p = lovePercent(message.author.id, target.id);
    return await message.reply({
      flags: MessageFlags.IsComponentsV2,
      components: [
        infoEmbed(
          "💖 Aşk Ölçer",
          `${message.author} ❤️ ${target}\n\n${loveBar(p)}\n**%${p}** — ${tierText(p)}`,
        ),
      ],
    });
  },
};

addSlash(
  command,
  [{ name: "kullanici", description: "Aşkı ölçülecek kişi", type: "user", required: true }],
  (v) => [v.userMention("kullanici") ?? ""],
);

export default command;
