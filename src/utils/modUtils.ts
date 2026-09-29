import { errorCard, V2CardBuilder } from "./componentsV2.js";
import type { User } from "discord.js";
import { BOT_NAME } from "../config.js";
import { EMOJIS } from "./emojis.js";

// Rastgele ceza numarası (StartIT tarzı)
export function generateCaseId(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  return Array.from({ length: 10 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
}

// Uyarı progress bar — X uyarı / 3 eşiği
export function warnBar(current: number): string {
  const threshold = 3;
  const pct = Math.min(Math.round((current / threshold) * 100), 100);
  const filled = Math.min(Math.round((current / threshold) * 10), 10);
  const bar = "█".repeat(filled) + "░".repeat(10 - filled);
  return `${current}u \`${bar}\` ${threshold}u (${pct}%)`;
}

// Bildirim kartı — kullanıcıya DM olarak giden şık, marka temalı kart.
export function notifCard(
  action: string,
  user: User,
  reason: string,
  modTag: string,
  extra?: string,
): V2CardBuilder {
  const embed = new V2CardBuilder()
    .setColor(0xff6fb3)
    .setAuthor({ name: action, iconURL: user.displayAvatarURL() })
    .setThumbnail(user.displayAvatarURL({ size: 256 }))
    .setDescription(`**${user.tag}** hakkında bir işlem gerçekleştirildi.`)
    .addFields(
      { name: `${EMOJIS.info} Sebep`, value: reason || "Belirtilmedi", inline: false },
      { name: `${EMOJIS.admin} Yetkili`, value: modTag, inline: true },
    );
  if (extra) embed.addFields({ name: `${EMOJIS.info} Detay`, value: extra, inline: true });
  return embed.setFooter({ text: BOT_NAME }).setTimestamp();
}

// Kullanım hatası — marka rengiyle uyumlu, net ve okunur.
export function usageEmbed(syntax: string): ReturnType<typeof errorCard> {
  return errorCard({
    usage: true,
    description: `Bu komutu yanlış kullandınız. Şunu deneyin:\n\`\`\`\n${syntax}\n\`\`\``,
  });
}
