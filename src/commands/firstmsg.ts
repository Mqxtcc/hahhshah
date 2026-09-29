import { textCard } from "../utils/componentsV2.js";
import { MessageFlags } from "discord.js";
import type { Message, TextChannel } from "discord.js";
import type { Command } from "../types.js";
import { infoEmbed, errorEmbed } from "../utils/embeds.js";
import { addSlash } from "../utils/slashBridge.js";

const FETCH_LIMIT = 100;
const MAX_PAGES = 60; // en fazla ~6000 mesaj geriye git

const command: Command = {
  name: "firstmsg",
  aliases: ["ilkmesaj", "kanalilk"],
  description: "Kanalın ilk mesajını bulup gösterir",
  usage: "!firstmsg [#kanal]",
  category: "genel",

  async execute(message: Message) {
    const target = (message.mentions.channels.first() ?? message.channel) as TextChannel;
    if (!target?.isTextBased() || target.isDMBased()) {
      return message.reply({
      flags: MessageFlags.IsComponentsV2, components: [errorEmbed("Hata", "Bu komut sunucu kanallarında çalışır.")] });
    }

    const wait = await message.reply({ flags: MessageFlags.IsComponentsV2, components: textCard("🔍 Kanalın başı aranıyor...") }).catch(() => null);

    try {
      let oldest = (await target.messages.fetch({ limit: 1 })).first() ?? null;
      let cursor = oldest?.id;
      let pages = 0;

      while (cursor && pages < MAX_PAGES) {
        const batch = await target.messages.fetch({ limit: FETCH_LIMIT, before: cursor });
        if (batch.size === 0) break;
        oldest = batch.last() ?? oldest;
        cursor = batch.lastKey();
        pages++;
        if (batch.size < FETCH_LIMIT) break;
      }

      await wait?.delete().catch(() => null);

      if (!oldest) {
        return message.reply({
      flags: MessageFlags.IsComponentsV2, components: [errorEmbed("Bulunamadı", "Bu kanalda hiç mesaj yok.")] });
      }

      const date = new Date(oldest.createdTimestamp).toLocaleString("tr-TR");
      const snippet = oldest.content ? oldest.content.slice(0, 1500) : "*[mesaj içeriği yok]*";
      const attachNote = oldest.attachments.size > 0 ? `\n📎 ${oldest.attachments.size} ek` : "";
      return message.reply({
      flags: MessageFlags.IsComponentsV2,
        components: [
          infoEmbed(
            "📜 Kanalın İlk Mesajı",
            `👤 **${oldest.author.tag}**\n📅 ${date}${attachNote}\n\n${snippet}\n\n[Mesaja git](${oldest.url})`,
          ),
        ],
      });
    } catch {
      await wait?.delete().catch(() => null);
      return message.reply({
      flags: MessageFlags.IsComponentsV2,
        components: [errorEmbed("Hata", "Mesajlar okunamadı — kanal geçmişini görme yetkim olmayabilir.")],
      });
    }
  },
};

addSlash(
  command,
  [{ name: "kanal", description: "Bakılacak kanal (boşsa bu kanal)", type: "channel", required: false }],
  (v) => (v.channelMention("kanal") ? [v.channelMention("kanal") as string] : []),
);

export default command;
