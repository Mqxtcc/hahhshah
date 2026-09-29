import { MessageFlags } from "discord.js";
import type { Message } from "discord.js";
import type { Command } from "../types.js";
import { infoEmbed } from "../utils/embeds.js";
import { getSnipes } from "../snipe/store.js";
import { addSlash } from "../utils/slashBridge.js";

function timeAgo(ms: number): string {
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return `${s} saniye önce`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} dakika önce`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} saat önce`;
  return `${Math.floor(h / 24)} gün önce`;
}

const command: Command = {
  name: "snipe",
  aliases: ["silinenmesaj", "sonsilinen"],
  description: "Kanalda silinen son mesajı gösterir",
  usage: "!snipe",
  category: "genel",

  async execute(message: Message) {
    const sniped = getSnipes(message.channel.id)[0];
    if (!sniped) {
      return message.reply({
      flags: MessageFlags.IsComponentsV2,
        components: [infoEmbed("👻 Snipe", "Bu kanalda yakalanmış silinmiş mesaj yok.\n_(Bot açıldığından beri silinenler yakalanır)_")],
      });
    }
    const attachNote = sniped.attachments > 0 ? `\n📎 ${sniped.attachments} ek dosya vardı` : "";
    const body = sniped.content ? `\n\n${sniped.content}` : "";
    return message.reply({
      flags: MessageFlags.IsComponentsV2,
      components: [
        infoEmbed(
          "👻 Yakalandı!",
          `**${sniped.authorTag}** — ${timeAgo(sniped.deletedAt)}${attachNote}${body}`,
        ),
      ],
    });
  },
};

addSlash(command, []);

export default command;
