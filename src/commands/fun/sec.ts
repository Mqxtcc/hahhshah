import { MessageFlags } from "discord.js";
import type { Message } from "discord.js";
import type { Command } from "../../types.js";
import { infoEmbed, errorEmbed } from "../../utils/embeds.js";
import { addSlash } from "../../utils/slashBridge.js";

/** Seçenekleri ayıklar: "a | b | c" ya da boşlukla ayrılmış. */
export function parseChoices(raw: string): string[] {
  const byPipe = raw.split("|").map((s) => s.trim()).filter(Boolean);
  if (byPipe.length >= 2) return byPipe;
  return raw.split(/\s+/).map((s) => s.trim()).filter(Boolean);
}

const command: Command = {
  name: "seç",
  aliases: ["sec", "choose", "pick"],
  description: "Verilen seçenekler arasından rastgele birini seçer",
  usage: "!seç <a> <b> [c...]  →  ya da: !seç elma | armut | kiraz",
  category: "fun",

  async execute(message: Message, args: string[]) {
    const choices = parseChoices(args.join(" ")).slice(0, 25);
    if (choices.length < 2) {
      return message.reply({
        flags: MessageFlags.IsComponentsV2,
        components: [errorEmbed("Hatalı Kullanım", `En az 2 seçenek ver. Kullanım: \`${command.usage}\``)],
      });
    }
    const pick = choices[Math.floor(Math.random() * choices.length)];
    const listed = choices.map((c, i) => `${i + 1}. ${c}`).join("\n");
    return message.reply({
      flags: MessageFlags.IsComponentsV2,
      components: [
        infoEmbed(
          "🎯 Seçim Yapıldı",
          `Seçenekler:\n${listed}\n\n👉 Kazanan: **${pick}**`,
        ),
      ],
    });
  },
};

addSlash(
  command,
  [{ name: "secenekler", description: "Seçenekler (| ile ayır, örn: elma | armut)", type: "string", required: true }],
  (v) => [v.str("secenekler") ?? ""],
);

export default command;
