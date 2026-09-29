import { V2CardBuilder, errorCard, textCard } from "../../utils/componentsV2.js";
import { MessageFlags, ChannelType, PermissionFlagsBits, type Message } from "discord.js";
import type { Command } from "../../types.js";
import { DEFAULT_PREFIX, OWNER_ID } from "../../config.js";
import { getGuildPrefix } from "../../events/messageCreate.js";
import { COLORS } from "../../utils/embeds.js";
import { EMOJIS } from "../../utils/emojis.js";
import {
  getConfiguredChannelId,
  getGuildWordScores,
  getStatus,
  getTopStreaks,
  isOwnerBypassEnabled,
  removeWordChainChannel,
  setOwnerBypass,
  setWordChainChannel,
} from "../../utils/wordchain.js";
import { addSlash } from "../../utils/slashBridge.js";
import { usageEmbed } from "../../utils/messages.js";

function isAdmin(message: Message): boolean {
  return message.author.id === OWNER_ID || (message.member?.permissions.has("Administrator") ?? false);
}

function rulesEmbed(prefix: string, channelId: string): V2CardBuilder {
  return new V2CardBuilder()
    .setColor(COLORS.success)
    .setTitle("🔤 Kelime Zinciri")
    .setDescription(
      `Bu kanal artık <#${channelId}> için **kalıcı** Kelime Zinciri kanalı. Sunucu kapansa, bot yeniden başlasa bile zincir kaldığı yerden devam eder.\n\n` +
        "**Kurallar**\n" +
        "• Bir önceki kelimenin **son harfiyle** başla.\n" +
        "• Aynı kelime, kullanıldıktan 4 saat sonra yeniden kullanılabilir.\n" +
        "• Aynı kişi art arda iki kez oynayamaz.\n" +
        "• Bu kanala sadece kelime yazılabilir, kurala uymayan mesajlar otomatik silinir.\n\n" +
        `📊 Durumu görmek için: \`${prefix}kelime durum\` • Rekoru görmek için: \`${prefix}kelime skor\``,
    )
    .setFooter({ text: "Kelime Zinciri • Kalıcı Sistem" })
    .setTimestamp();
}

const command: Command = {
  name: "kelime",
  aliases: ["kelimeoyunu", "wordchain"],
  description: "Sunucuya kalıcı bir Kelime Zinciri kanalı bağlar: bir önceki kelimenin son harfiyle devam edilir",
  usage: `${DEFAULT_PREFIX}kelime <kanal [#kanal]|kaldir|durum|skor>`,
  category: "fun",

  async execute(message: Message, args: string[]) {
    if (!message.guild) return;
    const prefix = getGuildPrefix(message.guild.id);
    const sub = args[0]?.toLocaleLowerCase("tr-TR");

    if (sub === "izin") {
      if (message.author.id !== OWNER_ID) {
        return message.reply({ flags: MessageFlags.IsComponentsV2, components: [errorCard({ description: `${EMOJIS.error} Bu komutu sadece bot sahibi kullanabilir.` })] });
      }
      const toggle = args[1]?.toLowerCase();
      if (toggle === "ac" || toggle === "aç" || toggle === "on") {
        setOwnerBypass(true);
        return message.reply({ flags: MessageFlags.IsComponentsV2, components: textCard(`${EMOJIS.success} Muafiyet açıldı — artık Kelime Zinciri kanalına normal mesaj atabilirsin, oyuna dahil olmazsın.`) });
      }
      if (toggle === "kapat" || toggle === "off") {
        setOwnerBypass(false);
        return message.reply({ flags: MessageFlags.IsComponentsV2, components: textCard(`${EMOJIS.success} Muafiyet kapatıldı — artık sen de herkes gibi oyuna dahilsin.`) });
      }
      return message.reply({ flags: MessageFlags.IsComponentsV2,
      components: [usageEmbed(
        `${EMOJIS.usage} Kullanım: \`${prefix}kelime izin aç\` veya \`${prefix}kelime izin kapat\`\n` +
          `Şu an: **${isOwnerBypassEnabled() ? "açık" : "kapalı"}**`,
      )] });
    }

    if (sub === "kanal" || sub === "kanal-ayarla" || sub === "setup" || sub === "baslat" || sub === "başlat") {
      if (!isAdmin(message)) {
        return message.reply({ flags: MessageFlags.IsComponentsV2, components: [errorCard({ description: `${EMOJIS.error} Bu komutu sadece **Yönetici** kullanabilir.` })] });
      }

      const targetChannel = message.mentions.channels.first() ?? message.channel;
      if (targetChannel.type !== ChannelType.GuildText) {
        return message.reply({ flags: MessageFlags.IsComponentsV2, components: [errorCard({ description: `${EMOJIS.error} Sadece bir metin kanalını Kelime Zinciri kanalı yapabilirsin.` })] });
      }

      const me = message.guild.members.me;
      const perms = me ? targetChannel.permissionsFor(me) : null;
      if (!perms?.has(PermissionFlagsBits.SendMessages) || !perms.has(PermissionFlagsBits.ManageMessages)) {
        return message.reply({ flags: MessageFlags.IsComponentsV2, components: [errorCard({ description: `${EMOJIS.error} <#${targetChannel.id}> kanalında **Mesaj Gönder** ve **Mesajları Yönet** iznine ihtiyacım var.` })] });
      }

      const existingChannelId = getConfiguredChannelId(message.guild.id);
      const result = await setWordChainChannel(message.guild.id, targetChannel.id, message.author.id);
      if (!result.ok) {
        return message.reply({ flags: MessageFlags.IsComponentsV2, components: textCard(`${EMOJIS.info} <#${targetChannel.id}> zaten bu sunucunun Kelime Zinciri kanalı.`) });
      }

      const embed = rulesEmbed(prefix, targetChannel.id);
      const sent = await targetChannel.send({ flags: MessageFlags.IsComponentsV2,
      components: [embed] }).catch(() => null);
      if (sent) await sent.pin().catch(() => null);

      const note = existingChannelId && existingChannelId !== targetChannel.id
        ? ` Eski kanal (<#${existingChannelId}>) artık devre dışı; sunucu rekoru korundu.`
        : "";
      return message.reply({ flags: MessageFlags.IsComponentsV2, components: textCard(`${EMOJIS.success} <#${targetChannel.id}> artık kalıcı Kelime Zinciri kanalı.${note}`) });
    }

    if (sub === "kaldir" || sub === "durdur" || sub === "kapat" || sub === "stop") {
      if (!isAdmin(message)) {
        return message.reply({ flags: MessageFlags.IsComponentsV2, components: [errorCard({ description: `${EMOJIS.error} Bu komutu sadece **Yönetici** kullanabilir.` })] });
      }
      const removedChannelId = await removeWordChainChannel(message.guild.id);
      if (!removedChannelId) {
        return message.reply({ flags: MessageFlags.IsComponentsV2, components: [errorCard({ description: `${EMOJIS.error} Bu sunucuda kurulu bir Kelime Zinciri kanalı yok.` })] });
      }
      return message.reply({ flags: MessageFlags.IsComponentsV2, components: textCard(`🏁 Kelime Zinciri kaldırıldı. <#${removedChannelId}> artık normal bir kanal.`) });
    }

    if (sub === "durum" || sub === "status") {
      const status = getStatus(message.guild.id);
      if (!status) {
        return message.reply({ flags: MessageFlags.IsComponentsV2, components: textCard(`${EMOJIS.info} Bu sunucuda henüz bir Kelime Zinciri kanalı yok — \`${prefix}kelime kanal #kanal\` ile kur.`) });
      }
      const embed = new V2CardBuilder()
        .setColor(COLORS.success)
        .setTitle("🔤 Kelime Zinciri — Durum")
        .addFields(
          { name: "Kanal", value: `<#${status.channelId}>`, inline: true },
          { name: "Mevcut seri", value: `${status.streak}`, inline: true },
          { name: "Sunucu rekoru", value: status.bestHolderId ? `${status.bestStreak} (<@${status.bestHolderId}>)` : "-", inline: true },
          { name: "Son kelime", value: status.lastWord ? `**${status.lastWord}**` : "-", inline: true },
          { name: "Gereken harf", value: status.requiredLetter ? `**${status.requiredLetter}**` : "herhangi biri", inline: true },
          { name: "Kullanılan kelime sayısı", value: `${status.usedWordsCount}`, inline: true },
        );
      return message.reply({ flags: MessageFlags.IsComponentsV2,
      components: [embed] });
    }

    if (sub === "skor" || sub === "en-iyi" || sub === "best") {
      const scores = await getGuildWordScores(message.guild.id, 10);
      if (scores.length === 0) {
        return message.reply({ flags: MessageFlags.IsComponentsV2, components: textCard(`${EMOJIS.info} Henüz kabul edilmiş bir kelime yok; ilk kelimeni oynayarak skorunu oluşturabilirsin.`) });
      }
      const medals = ["🥇", "🥈", "🥉"];
      const lines = scores.map((entry, i) => {
        const rank = medals[i] ?? `**${i + 1}.**`;
        return `${rank} <@${entry.userId}> — **${entry.words}** kelime`;
      });
      const status = getStatus(message.guild.id);
      const footer = status?.bestHolderId
        ? `Zincir rekoru: ${status.bestStreak} • Rekor sahibi: ${status.bestHolderId}`
        : "Oyuncu başına kabul edilen kelime sayısı";
      const embed = new V2CardBuilder()
        .setColor(COLORS.success)
        .setTitle("🏆 Kelime Zinciri — Oyuncu Skorları")
        .setDescription(lines.join("\n"))
        .setFooter({ text: footer })
        .setTimestamp();
      return message.reply({ flags: MessageFlags.IsComponentsV2,
      components: [embed] });
    }

    if (sub === "top" || sub === "toplist" || sub === "leaderboard") {
      const top = getTopStreaks(10);
      if (top.length === 0) {
        return message.reply({ flags: MessageFlags.IsComponentsV2, components: textCard(`${EMOJIS.info} Henüz hiçbir sunucuda bir Kelime Zinciri rekoru yok.`) });
      }

      const medals = ["🥇", "🥈", "🥉"];
      const lines = top.map((entry, i) => {
        const rank = medals[i] ?? `**${i + 1}.**`;
        const guildName = message.client.guilds.cache.get(entry.guildId)?.name ?? "Bilinmeyen sunucu";
        const holder = entry.bestHolderId ? `<@${entry.bestHolderId}>` : "bilinmeyen";
        return `${rank} **${entry.bestStreak}** kelime — ${holder} • *${guildName}*`;
      });

      const embed = new V2CardBuilder()
        .setColor(COLORS.success)
        .setTitle("🏆 Kelime Zinciri — Sunucular Arası İlk 10")
        .setDescription(lines.join("\n"))
        .setFooter({ text: "Kelime Zinciri • Tüm Sunucular" })
        .setTimestamp();

      return message.reply({ flags: MessageFlags.IsComponentsV2,
      components: [embed] });
    }

    return message.reply({ flags: MessageFlags.IsComponentsV2,
    components: [usageEmbed(
      `${EMOJIS.usage} Kullanım:\n` +
        `\`${prefix}kelime kanal [#kanal]\` — bu kanalı (veya belirtilen kanalı) kalıcı Kelime Zinciri kanalı yap\n` +
        `\`${prefix}kelime kaldir\` — Kelime Zinciri kanalını kaldır\n` +
        `\`${prefix}kelime durum\` — mevcut zincirin durumunu göster\n` +
        `\`${prefix}kelime skor\` — sunucu rekorunu göster\n` +
        `\`${prefix}kelime top\` — tüm sunucular arasında en iyi ilk 10 rekoru göster\n` +
        `\`${prefix}kelime izin aç/kapat\` — (sadece bot sahibi) kelime kanalına normal mesaj atma muafiyeti`,
    )] });
  },
};


addSlash(command, [
  { name: "islem", description: "Yapılacak işlem", type: "string", required: true, choices: [{ name: "Kanal bağla", value: "kanal" }, { name: "Kanalı kaldır", value: "kaldir" }, { name: "Durumu göster", value: "durum" }, { name: "Skorları göster", value: "skor" }] },
  { name: "kanal", description: "Kelime zinciri kanalı", type: "channel" },
],
  (v) => {
    const islem = v.str("islem") ?? "durum";
    if (islem === "kanal") { const k = v.channelMention("kanal"); return k ? ["kanal", k] : ["kanal"]; }
    return [islem];
  }
);
export default command;
