import { COMPONENTS_V2_FLAG, errorCard, textCard, V2CardBuilder } from "../../utils/componentsV2.js";
import { PermissionFlagsBits, type Message, ChannelType } from "discord.js";
import type { Command } from "../../types.js";
import { getAllLogChannels, LOG_CATEGORIES, setLogChannel, type LogCategory } from "../../utils/logger.js";
import { EMOJIS } from "../../utils/emojis.js";
import { usageEmbed } from "../../utils/messages.js";
import { COLORS } from "../../utils/embeds.js";
import { OWNER_ID } from "../../config.js";
import { markPermissionDenied } from "../../utils/notifyOwner.js";
import { addSlash } from "../../utils/slashBridge.js";
import { buildLogTab } from "../../events/panel.js";
import { v2Payload } from "../../utils/messages.js";

function findCategory(input: string): LogCategory | null {
  const normalized = input.toLowerCase().trim();
  const found = LOG_CATEGORIES.find((c) => c.id === normalized);
  return found ? found.id : null;
}

const command: Command = {
  name: "logkanal",
  aliases: ["logchannel", "logayarla"],
  description: "Log kategorilerinin hangi kanala yazacağını ayarlar",
  usage: "!logkanal <kategori> #kanal  |  !logkanal <kategori> kapat  |  !logkanal durum",
  category: "mod",

  async execute(message: Message, args: string[]) {
    if (!message.guild || !message.member) return;
    if (message.author.id !== OWNER_ID && !message.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
      markPermissionDenied(message, "Sunucuyu Yönet yetkisi yok (logkanal)");
      return message.reply({ flags: COMPONENTS_V2_FLAG, components: [errorCard({ description: `${EMOJIS.error} Bu komutu kullanmak için **Sunucuyu Yönet** yetkisine ihtiyacın var.` })] });
    }

    const sub = args[0]?.toLocaleLowerCase("tr-TR");

    // !logkanal durum -> tüm kategorilerin şu anki ayarını göster
    if (sub === "panel" || !sub) {
      const payload = await buildLogTab(message.guild.id);
      return message.reply(v2Payload(payload)).catch(() => null);
    }
    
    if (sub === "durum" || sub === "status") {
      const settings = await getAllLogChannels(message.guild.id);
      const embed = new V2CardBuilder()
        .setColor(COLORS.info)
        .setTitle(`${EMOJIS.info} Log Kanalı Durumu`)
        .setDescription(
          LOG_CATEGORIES.map((c) => {
            const channelId = settings[c.id];
            const value = channelId ? `<#${channelId}>` : "*ayarlanmamış*";
            return `${c.emoji} **${c.label}** (\`${c.id}\`) — ${value}`;
          }).join("\n"),
        )
        .setFooter({ text: `Ayarlamak için: !logkanal <kategori> #kanal — Kapatmak için: !logkanal <kategori> kapat` });
      return message.reply({ flags: COMPONENTS_V2_FLAG, components: [embed] }).catch(() => null);
    }

    const category = findCategory(sub);
    if (!category) {
      const list = LOG_CATEGORIES.map((c) => `\`${c.id}\` — ${c.label}`).join("\n");
      return message.reply({ flags: COMPONENTS_V2_FLAG, components: [errorCard({ description: `${EMOJIS.error} Kategori şunlardan biri olmalı:\n${list}` })] });
    }

    const secondArg = args[1]?.toLowerCase();

    // !logkanal mesaj kapat -> kategoriyi devre dışı bırak
    if (secondArg === "kapat" || secondArg === "off" || secondArg === "disable") {
      await setLogChannel(message.guild.id, category, null);
      return message.reply({ flags: COMPONENTS_V2_FLAG, components: textCard(`${EMOJIS.success} **${category}** logları kapatıldı.`) });
    }

    const channel = message.mentions.channels.first() ?? message.guild.channels.cache.get(args[1] ?? "");
    if (!channel || channel.type !== ChannelType.GuildText) {
      return message.reply({ flags: COMPONENTS_V2_FLAG, components: [usageEmbed(`${EMOJIS.error} Kanal bulunamadı.\nKullanım: \`!logkanal ${category} #kanal\` ya da \`!logkanal ${category} kapat\``)] });
    }

    await setLogChannel(message.guild.id, category, channel.id);
    const meta = LOG_CATEGORIES.find((c) => c.id === category)!;
    await message.reply({ flags: COMPONENTS_V2_FLAG, components: textCard(`${EMOJIS.success} ${meta.emoji} **${meta.label}** artık ${channel} kanalına yazılacak.`) }).catch(() => null);
  },
};


addSlash(command, [
  { name: "islem", description: "Yapılacak işlem", type: "string", required: true, choices: [{ name: "Kanal ayarla", value: "ayarla" }, { name: "Kapat", value: "kapat" }, { name: "Durumu göster", value: "durum" }] },
  { name: "kategori", description: "Log kategorisi: mesaj, uyari, giris-cikis, ses, rol, kanal", type: "string" },
  { name: "kanal", description: "Log kanalı", type: "channel" },
],
  (v) => {
    const islem = v.str("islem") ?? "durum";
    if (islem === "durum") return ["durum"];
    const kategori = v.str("kategori") ?? "";
    if (islem === "kapat") return [kategori, "kapat"].filter(Boolean);
    const kanal = v.channelMention("kanal") ?? "";
    return [kategori, kanal].filter(Boolean);
  }
);
export default command;
