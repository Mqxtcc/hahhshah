import { MessageFlags } from "discord.js";
import type { Message } from "discord.js";
import type { Command } from "../types.js";
import { infoEmbed, errorEmbed } from "../utils/embeds.js";
import {
  setBirthday,
  birthdaysInMonth,
  isValidDate,
  MONTH_NAMES_TR,
} from "../birthday/store.js";
import { addSlash } from "../utils/slashBridge.js";

export const dogumgunu: Command = {
  name: "doğumgünü",
  aliases: ["dogumgunu", "birthday", "bd"],
  description: "Doğum gününü kaydedersin (gün ay)",
  usage: "!doğumgünü <gün> <ay>  →  örn: !doğumgünü 15 6",
  category: "genel",

  async execute(message: Message, args: string[]) {
    const day = parseInt(args[0] ?? "", 10);
    const month = parseInt(args[1] ?? "", 10);
    if (!isValidDate(day, month)) {
      return message.reply({
      flags: MessageFlags.IsComponentsV2,
        components: [
          errorEmbed(
            "Hatalı Kullanım",
            `Geçerli bir gün ve ay yaz. Kullanım: \`${dogumgunu.usage}\`\nÖrn: \`!doğumgünü 15 6\` (15 Haziran)`,
          ),
        ],
      });
    }
    await setBirthday(message.author.id, day, month).catch(() => null);
    return message.reply({
      flags: MessageFlags.IsComponentsV2,
      components: [
        infoEmbed(
          "🎂 Kaydedildi",
          `${message.author}, doğum günün **${day} ${MONTH_NAMES_TR[month]}** olarak kaydedildi! 🎉`,
        ),
      ],
    });
  },
};

export const dogumgunleri: Command = {
  name: "doğumgünleri",
  aliases: ["dogumgunleri", "birthdays"],
  description: "Bu ay doğum günü olanları listeler",
  usage: "!doğumgünleri",
  category: "genel",

  async execute(message: Message) {
    if (!message.guild) {
      return message.reply({
      flags: MessageFlags.IsComponentsV2, components: [errorEmbed("Hata", "Bu komut sadece sunucuda çalışır.")] });
    }
    const now = new Date();
    const month = now.getMonth() + 1;
    const today = now.getDate();

    const list = await birthdaysInMonth(month).catch(() => []);
    if (list.length === 0) {
      return message.reply({
      flags: MessageFlags.IsComponentsV2,
        components: [
          infoEmbed(
            `🎂 ${MONTH_NAMES_TR[month]} Doğum Günleri`,
            `Bu ay kimse doğum gününü kaydetmemiş. \`!doğumgünü <gün> <ay>\` ile sen ekle!`,
          ),
        ],
      });
    }

    // Sunucuda olmayanları ele, güne göre sırala
    const lines: string[] = [];
    for (const b of list) {
      let tag: string;
      try {
        const member = await message.guild.members.fetch(b.userId).catch(() => null);
        tag = member ? member.user.tag : `<@${b.userId}>`;
      } catch {
        tag = `<@${b.userId}>`;
      }
      const rel = b.day === today ? "🎉 **BUGÜN!**" : b.day > today ? `${b.day - today} gün kaldı` : `${today - b.day} gün önceydi`;
      lines.push(`**${b.day} ${MONTH_NAMES_TR[month]}** — ${tag} (${rel})`);
    }

    return message.reply({
      flags: MessageFlags.IsComponentsV2,
      components: [infoEmbed(`🎂 ${MONTH_NAMES_TR[month]} Doğum Günleri`, lines.join("\n"))],
    });
  },
};

addSlash(
  dogumgunu,
  [
    { name: "gun", description: "Gün (1-31)", type: "integer", required: true, minValue: 1, maxValue: 31 },
    { name: "ay", description: "Ay (1-12)", type: "integer", required: true, minValue: 1, maxValue: 12 },
  ],
  (v) => [String(v.int("gun") ?? ""), String(v.int("ay") ?? "")],
);
addSlash(dogumgunleri, []);
