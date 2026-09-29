import { V2CardBuilder } from "../utils/componentsV2.js";
import { MessageFlags, type Message } from "discord.js";
import type { Command } from "../types.js";
import { COLORS } from "../utils/embeds.js";
import { getUserColor } from "../utils/userColor.js";
import { PREMIUM_PERKS, PREMIUM_HOWTO } from "../premium/perks.js";
import { ensurePremiumLoaded, isPremium, getGiftExpiry } from "../premium/store.js";
import { addSlash } from "../utils/slashBridge.js";

function formatDate(date: Date): string {
  return date.toLocaleDateString("tr-TR", { day: "numeric", month: "long", year: "numeric" });
}

const command: Command = {
  name: "premiumbilgi",
  aliases: ["premium-bilgi", "premiums", "vipbilgi"],
  description: "Premium ayrıcalıklarını ve kendi durumunu gösterir",
  usage: "!premiumbilgi",
  category: "genel",

  async execute(message: Message) {
    await ensurePremiumLoaded().catch(() => null);
    const premium = isPremium(message.author.id);
    const giftExp = getGiftExpiry(message.author.id);
    const color = (await getUserColor(message.author.id).catch(() => null)) ?? COLORS.brand;

    const status = premium
      ? giftExp
        ? `⭐ **Premium aktif** — hediye, bitiş: **${formatDate(giftExp)}**`
        : "⭐ **Premium aktif** — kalıcı"
      : "▫️ Premium'un yok";

    const perksText = PREMIUM_PERKS.map((p) => `${p.icon} **${p.title}**\n${p.description}`).join("\n\n");

    const embed = new V2CardBuilder()
      .setColor(color)
      .setTitle("⭐ Premium Ayrıcalıkları")
      .setDescription(`${status}\n\n${perksText}`)
      .addFields({ name: "💎 Premium nasıl alınır?", value: PREMIUM_HOWTO })
      .setFooter({ text: `İsteyen: ${message.author.tag}` })
      .setTimestamp();

    return message.reply({
      flags: MessageFlags.IsComponentsV2, components: [embed] });
  },
};


addSlash(command, []);

export default command;
