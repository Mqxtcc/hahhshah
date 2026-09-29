import { COMPONENTS_V2_FLAG, errorCard, textCard, V2CardBuilder } from "../../utils/componentsV2.js";
import { PermissionFlagsBits, type Message } from "discord.js";
import type { Command } from "../../types.js";
import { EMOJIS } from "../../utils/emojis.js";
import { requireOwner, getGuildPrefix } from "../../events/messageCreate.js";
import { extractRawRest } from "../../utils/parse.js";
import { hasPermission } from "../../utils/permissions.js";
import { addSlash, type SlashValues } from "../../utils/slashBridge.js";
import { usageEmbed } from "../../utils/messages.js";

// !duyuru ve !say: "Sunucuyu Yönet" (Manage Guild) yetkisi olan HERKES
// kullanabilir, AMA bunun dışında sunucu sahibi/adminler `!izin say @kişi`
// veya `!izin duyuru @kişi` ile bu iznin olmadığı kullanıcılara da özel
// olarak izin verebilsin diye ban/kick/mute'la aynı `hasPermission` (izin
// sistemi) kontrolüne de bakıyoruz — ikisinden biri yeterli. (bkz. !izin)
async function canUseAnnounceCommands(message: Message, permName: "say" | "duyuru"): Promise<boolean> {
  if (message.member?.permissions.has(PermissionFlagsBits.ManageGuild)) return true;
  return hasPermission(message, permName);
}

// `!duyuru [#kanal] <metin>` / `!say [#kanal] <metin>` ortak ayrıştırması.
// İlk argüman bir #kanal mention'ıysa onu hedef alır, değilse mevcut kanalı
// kullanır. Metin, `args.join(" ")` ile DEĞİL ham mesaj içeriğinden
// (extractRawRest) alınır — aksi halde çok satırlı duyuru/mesaj metinleri
// tek satıra sıkışıyordu (bkz. customevent'teki aynı hata).
function parseChannelAndText(message: Message, args: string[], prefix: string) {
  const isChannelMention = /^<#\d+>$/.test(args[0] ?? "");
  const mentionedChannel = isChannelMention ? message.mentions.channels.first() ?? null : null;
  const targetChannel = mentionedChannel ?? message.channel;
  const tokenCount = mentionedChannel ? 2 : 1; // komut adı (+ varsa #kanal)
  const text = (extractRawRest(message.content, tokenCount, prefix) ?? "").trim();
  return { targetChannel, text };
}

export const duyuru: Command = {
  name: "duyuru",
  aliases: ["announce"],
  description: "Bot ağzından duyuru gönderir (Sunucuyu Yönet yetkisi veya !izin ile verilen özel izin gerekir)",
  usage: "!duyuru [#kanal] <metin>",
  category: "mod",

  async execute(message: Message, args: string[]) {
    if (!message.guild || !message.member) return;
    if (!(await canUseAnnounceCommands(message, "duyuru"))) {
      return message.reply({ flags: COMPONENTS_V2_FLAG, components: [errorCard({ description: `${EMOJIS.error} Bu komutu kullanmak için **Sunucuyu Yönet** yetkisine veya \`!izin duyuru\` ile verilmiş özel izne ihtiyacın var.` })] });
    }

    const prefix = getGuildPrefix(message.guild.id);
    const { targetChannel, text } = parseChannelAndText(message, args, prefix);

    if (!text) {
      return message.reply({ flags: COMPONENTS_V2_FLAG, components: [usageEmbed(`${EMOJIS.alert} Kullanım: \`${prefix}duyuru [#kanal] mesaj\``)] }).catch(() => null);
    }
    if (text.length > 1_900) {
      return message.reply({ flags: COMPONENTS_V2_FLAG, components: [errorCard({ description: `${EMOJIS.alert} Duyuru metni en fazla 1.900 karakter olabilir.` })] }).catch(() => null);
    }
    if (!("send" in targetChannel)) {
      return message.reply({ flags: COMPONENTS_V2_FLAG, components: [errorCard({ description: `${EMOJIS.alert} O kanal metin kanalı değil.` })] }).catch(() => null);
    }
    if (!message.guild.members.me?.permissionsIn(targetChannel.id).has(PermissionFlagsBits.SendMessages)) {
      return message.reply({ flags: COMPONENTS_V2_FLAG, components: [errorCard({ description: `${EMOJIS.alert} O kanalda mesaj gönderme iznim yok.` })] }).catch(() => null);
    }

    try {
      await targetChannel.send({ flags: COMPONENTS_V2_FLAG, components: textCard(`📢 **Duyuru**\n${text}`), allowedMentions: { parse: [] }  });
      await message.reply({ flags: COMPONENTS_V2_FLAG, components: textCard(`${EMOJIS.success} Duyuru gönderildi.`) }).catch(() => null);
    } catch (err) {
      console.error("duyuru patladı la:", err);
      await message.reply({ flags: COMPONENTS_V2_FLAG, components: [errorCard({ description: `${EMOJIS.error} Duyuru gönderilemedi.` })] }).catch(() => null);
    }
  },
};

export const say: Command = {
  name: "say",
  description: "Bot ağzından düz mesaj gönderir (Sunucuyu Yönet yetkisi veya !izin ile verilen özel izin gerekir)",
  usage: "!say [#kanal] <metin>",
  category: "mod",

  async execute(message: Message, args: string[]) {
    if (!message.guild || !message.member) return;
    if (!(await canUseAnnounceCommands(message, "say"))) {
      return message.reply({ flags: COMPONENTS_V2_FLAG, components: [errorCard({ description: `${EMOJIS.error} Bu komutu kullanmak için **Sunucuyu Yönet** yetkisine veya \`!izin say\` ile verilmiş özel izne ihtiyacın var.` })] });
    }

    const prefix = getGuildPrefix(message.guild.id);
    const { targetChannel, text } = parseChannelAndText(message, args, prefix);

    if (!text) {
      return message.reply({ flags: COMPONENTS_V2_FLAG, components: [usageEmbed(`${EMOJIS.alert} Kullanım: \`${prefix}say [#kanal] mesaj\``)] }).catch(() => null);
    }
    if (text.length > 2_000) {
      return message.reply({ flags: COMPONENTS_V2_FLAG, components: [errorCard({ description: `${EMOJIS.alert} Mesaj en fazla 2.000 karakter olabilir.` })] }).catch(() => null);
    }
    if (!("send" in targetChannel)) {
      return message.reply({ flags: COMPONENTS_V2_FLAG, components: [errorCard({ description: `${EMOJIS.alert} O kanal metin kanalı değil.` })] }).catch(() => null);
    }
    if (!message.guild.members.me?.permissionsIn(targetChannel.id).has(PermissionFlagsBits.SendMessages)) {
      return message.reply({ flags: COMPONENTS_V2_FLAG, components: [errorCard({ description: `${EMOJIS.alert} O kanalda mesaj gönderme iznim yok.` })] }).catch(() => null);
    }

    try {
      await targetChannel.send({ flags: COMPONENTS_V2_FLAG, components: textCard(text), allowedMentions: { parse: [] }  });
      await message.delete().catch(() => null);
    } catch (err) {
      console.error("say patladı la:", err);
      await message.reply({ flags: COMPONENTS_V2_FLAG, components: [errorCard({ description: `${EMOJIS.error} Mesaj gönderilemedi.` })] }).catch(() => null);
    }
  },
};

export const yeniEmbed: Command = {
  name: "yeniembed",
  aliases: ["newembed", "embedgonder"],
  description: "Bot ağzından embed gönderir (owner-only)",
  usage: "!yeniembed [#kanal] Başlık | Açıklama | #renk",
  category: "owner",

  async execute(message: Message, args: string[]) {
    if (!(await requireOwner(message))) return;
    const targetChannel = message.mentions.channels.first() ?? message.channel;
    const rawArgs = args.filter((a) => !/^<#\d+>$/.test(a)).join(" ");
    if (!rawArgs.includes("|")) {
      const tutorial = new V2CardBuilder()
        .setColor(0xd0a840)
        .setTitle("📘 !yeniembed Kullanımı")
        .setDescription(`\`${getGuildPrefix(message.guild?.id)}yeniembed [#kanal] Başlık | Açıklama | #renk\``)
        .setTimestamp();
      await message.reply({ flags: COMPONENTS_V2_FLAG, components: [tutorial] }).catch(() => null);
      return;
    }
    const [title, description, colorRaw] = rawArgs.split("|").map((p) => p.trim());
    if (!title || !description) {
      await message.reply({ flags: COMPONENTS_V2_FLAG, components: [errorCard({ description: ` ${EMOJIS.alert} Başlık ve açıklama zorunlu.` })] }).catch(() => null);
      return;
    }
    if (title.length > 256 || description.length > 4_096) {
      await message.reply({ flags: COMPONENTS_V2_FLAG, components: [errorCard({ description: ` ${EMOJIS.alert} Başlık en fazla 256, açıklama en fazla 4.096 karakter olabilir.` })] }).catch(() => null);
      return;
    }
    let color = 0xd0a840;
    if (colorRaw) {
      const hex = colorRaw.replace("#", "");
      if (/^[0-9a-fA-F]{6}$/.test(hex)) color = parseInt(hex, 16);
    }
    if (!("send" in targetChannel)) {
      await message.reply({ flags: COMPONENTS_V2_FLAG, components: [errorCard({ description: `${EMOJIS.alert} O kanal metin kanalı değil.` })] }).catch(() => null);
      return;
    }
    const embed = new V2CardBuilder().setColor(color).setTitle(title).setDescription(description).setTimestamp();
    try {
      await targetChannel.send({ flags: COMPONENTS_V2_FLAG, components: [embed], allowedMentions: { parse: [] } });
      await message.reply({ flags: COMPONENTS_V2_FLAG, components: textCard(` ${EMOJIS.success} Embed gönderildi.`) }).catch(() => null);
    } catch (err) {
      console.error("yeniembed patladı la:", err);
      await message.reply({ flags: COMPONENTS_V2_FLAG, components: [errorCard({ description: ` ${EMOJIS.error} Embed gönderilemedi.` })] }).catch(() => null);
    }
  },
};

// Discord kuralı: zorunlu seçenekler önce gelir. Prefix ayrıştırıcı
// `[#kanal] <metin>` beklediği için map argümanları o sıraya dizer.
function kanalMetinMap(v: SlashValues): string[] {
  const args: string[] = [];
  const kanal = v.channelMention("kanal");
  if (kanal) args.push(kanal);
  const metin = v.str("metin");
  if (metin) args.push(...metin.split(/\s+/));
  return args;
}

addSlash(duyuru, [
  { name: "metin", description: "Duyuru metni", type: "string", required: true },
  { name: "kanal", description: "Duyurunun gönderileceği kanal (boşsa bu kanal)", type: "channel" },
], kanalMetinMap);

addSlash(say, [
  { name: "metin", description: "Gönderilecek metin", type: "string", required: true },
  { name: "kanal", description: "Mesajın gönderileceği kanal (boşsa bu kanal)", type: "channel" },
], kanalMetinMap);
