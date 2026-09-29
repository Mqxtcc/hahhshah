import { MessageFlags } from "discord.js";
import type { Message, User } from "discord.js";
import type { Command } from "../../types.js";
import { infoEmbed } from "../../utils/embeds.js";
import { addSlash } from "../../utils/slashBridge.js";

/** Kullanıcıya özel sabit "ölçüm" — hep aynı sonuç çıkar. */
export function ppLength(userId: string): number {
  let h = 2166136261;
  for (const ch of userId) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h) % 31; // 0–30
}

function verdict(cm: number): string {
  if (cm >= 25) return "Efsanevi! Müzeye kaldırılmalık 🏆";
  if (cm >= 18) return "Gayet iddialı, helal 😎";
  if (cm >= 12) return "Ortalamanın üstü, fena değil 😉";
  if (cm >= 7) return "İdare eder, üzülme 😅";
  if (cm >= 3) return "Büyüklük önemli değil derler... derler 🤏";
  return "Mikroskopla bakmak lazım 🔬";
}

const command: Command = {
  name: "ppboyu",
  aliases: ["ölçüm", "olcum"],
  description: "Efsanevi ölçümü yapar",
  usage: "!ppboyu [@kullanıcı]",
  category: "fun",

  async execute(message: Message) {
    const target: User = message.mentions.users.first() ?? message.author;
    const cm = ppLength(target.id);
    const bar = "▰".repeat(Math.max(1, Math.round(cm / 2))) + "▱".repeat(15 - Math.max(1, Math.round(cm / 2)));
    return message.reply({
      flags: MessageFlags.IsComponentsV2,
      components: [
        infoEmbed(
          "📏 Efsanevi Ölçüm",
          `${target} için sonuç:\n\n\`${bar}\` **${cm} cm**\n\n${verdict(cm)}`,
        ),
      ],
    });
  },
};

addSlash(
  command,
  [{ name: "kullanici", description: "Ölçülecek kişi (boş bırakırsan kendin)", type: "user", required: false }],
  (v) => (v.userMention("kullanici") ? [v.userMention("kullanici") as string] : []),
);

export default command;
