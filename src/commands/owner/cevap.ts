import { COMPONENTS_V2_FLAG, errorCard, textCard, V2CardBuilder } from "../../utils/componentsV2.js";
import { PermissionFlagsBits, type Message } from "discord.js";
import type { Command } from "../../types.js";
import { OWNER_ID } from "../../config.js";
import { EMOJIS } from "../../utils/emojis.js";
import { autoResponses, autoResponseMapKey, saveAutoResponsesForGuild, getGuildPrefix } from "../../events/messageCreate.js";
import { usageEmbed } from "../../utils/messages.js";

const MAX_AUTO_RESPONSES_PER_GUILD = 100;
const MAX_TRIGGER_LENGTH = 64;
const MAX_RESPONSE_LENGTH = 1_900;

// Bot sahibi, sunucu sahibi (taç sahibi) veya Yönetici izni olanlar kullanabilir.
async function requireAdminOrOwner(message: Message): Promise<boolean> {
  if (!message.guild || !message.member) return false;

  const isBotOwner = message.author.id === OWNER_ID;
  const isServerOwner = message.guild.ownerId === message.author.id;
  const isAdmin = message.member.permissions.has(PermissionFlagsBits.Administrator);

  if (isBotOwner || isServerOwner || isAdmin) return true;

  await message
    .reply({ flags: COMPONENTS_V2_FLAG, components: [errorCard({ description: `${EMOJIS.alert} Bu komutu sadece yöneticiler veya sunucu sahibi kullanabilir.` })] })
    .catch(() => null);
  return false;
}

export const cevapOlustur: Command = {
  name: "cevap-oluştur",
  aliases: ["cevap-olustur", "cevapoluştur", "cevapolustur"],
  description: "Belirli bir mesaja otomatik cevap tanımlar (yönetici)",
  usage: "!cevap-oluştur <tetikleyici> <cevap>",
  category: "mod",

  async execute(message: Message, args: string[]) {
    if (!(await requireAdminOrOwner(message))) return;
    if (!message.guildId) return;
    const triggerRaw = args[0];
    const responseText = args.slice(1).join(" ").trim();
    if (!triggerRaw || !responseText) {
      await message
        .reply({ flags: COMPONENTS_V2_FLAG, components: [usageEmbed(`${EMOJIS.alert} Kullanım: \`${getGuildPrefix(message.guildId)}cevap-oluştur <tetikleyici> <cevap>\` (ör. \`${getGuildPrefix(message.guildId)}cevap-oluştur sa Aleykümselam\`)`)] })
        .catch(() => null);
      return;
    }
    const trigger = triggerRaw.trim().toLocaleLowerCase("tr-TR");
    if (trigger.length > MAX_TRIGGER_LENGTH || responseText.length > MAX_RESPONSE_LENGTH) {
      await message.reply({ flags: COMPONENTS_V2_FLAG, components: [errorCard({ description: `${EMOJIS.alert} Tetikleyici en fazla ${MAX_TRIGGER_LENGTH}, cevap en fazla ${MAX_RESPONSE_LENGTH} karakter olabilir.` })] }).catch(() => null);
      return;
    }
    const mapKey = autoResponseMapKey(message.guildId, trigger);
    const isNew = !autoResponses.has(mapKey);
    if (isNew && [...autoResponses.keys()].filter((key) => key.startsWith(`${message.guildId}::`)).length >= MAX_AUTO_RESPONSES_PER_GUILD) {
      await message.reply({ flags: COMPONENTS_V2_FLAG, components: [errorCard({ description: `${EMOJIS.alert} Bu sunucuda en fazla ${MAX_AUTO_RESPONSES_PER_GUILD} otomatik cevap olabilir.` })] }).catch(() => null);
      return;
    }
    autoResponses.set(mapKey, responseText);
    await saveAutoResponsesForGuild(message.guildId);
    await message
      .reply({ flags: COMPONENTS_V2_FLAG, components: textCard(`${EMOJIS.success} Otomatik cevap ${isNew ? "eklendi" : "güncellendi"}: \`${trigger}\` → ${responseText}`), allowedMentions: { parse: [] }  })
      .catch(() => null);
  },
};

export const cevapSil: Command = {
  name: "cevap-sil",
  aliases: ["cevapsil"],
  description: "Bir otomatik cevabı siler (yönetici)",
  usage: "!cevap-sil <tetikleyici>",
  category: "mod",

  async execute(message: Message, args: string[]) {
    if (!(await requireAdminOrOwner(message))) return;
    if (!message.guildId) return;
    const triggerRaw = args.join(" ").trim();
    if (!triggerRaw) {
      await message.reply({ flags: COMPONENTS_V2_FLAG, components: [usageEmbed(`${EMOJIS.alert} Kullanım: \`${getGuildPrefix(message.guildId)}cevap-sil <tetikleyici>\``)] }).catch(() => null);
      return;
    }
    const trigger = triggerRaw.toLocaleLowerCase("tr-TR");
    const mapKey = autoResponseMapKey(message.guildId, trigger);
    if (!autoResponses.has(mapKey)) {
      await message.reply({ flags: COMPONENTS_V2_FLAG, components: [errorCard({ description: `${EMOJIS.alert} \`${trigger}\` için kayıtlı bir otomatik cevap yok.` })] }).catch(() => null);
      return;
    }
    autoResponses.delete(mapKey);
    await saveAutoResponsesForGuild(message.guildId);
    await message.reply({ flags: COMPONENTS_V2_FLAG, components: textCard(`🗑️ \`${trigger}\` tetikleyicisi silindi.`) }).catch(() => null);
  },
};

export const cevapListe: Command = {
  name: "cevap-liste",
  aliases: ["cevapliste"],
  description: "Sunucudaki otomatik cevapları listeler (yönetici)",
  usage: "!cevap-liste",
  category: "mod",

  async execute(message: Message) {
    if (!(await requireAdminOrOwner(message))) return;
    if (!message.guildId) return;
    const guildPrefix = `${message.guildId}::`;
    const guildEntries = [...autoResponses.entries()].filter(([mapKey]) => mapKey.startsWith(guildPrefix));
    if (guildEntries.length === 0) {
      await message.reply({ flags: COMPONENTS_V2_FLAG, components: textCard("📭 Bu sunucuda henüz kayıtlı bir otomatik cevap yok.") }).catch(() => null);
      return;
    }
    const lines = guildEntries.map(([mapKey, response]) => `\`${mapKey.slice(guildPrefix.length)}\` → ${response}`);
    const listText = lines.join("\n");
    const embed = new V2CardBuilder()
      .setColor(0x57f287)
      .setTitle("💬 Otomatik Cevaplar")
      .setDescription(listText.slice(0, 4_000) + (listText.length > 4_000 ? "\n… liste kısaltıldı" : ""))
      .setFooter({ text: `Toplam ${guildEntries.length} tetikleyici` })
      .setTimestamp();
    await message.reply({ flags: COMPONENTS_V2_FLAG, components: [embed], allowedMentions: { parse: [] } }).catch(() => null);
  },
};
