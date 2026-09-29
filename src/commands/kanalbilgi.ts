import { MessageFlags } from "discord.js";
import { ChannelType, type Message, type GuildChannel } from "discord.js";
import type { Command } from "../types.js";
import { infoEmbed, errorEmbed } from "../utils/embeds.js";
import { addSlash } from "../utils/slashBridge.js";

const TYPE_NAMES: Record<number, string> = {
  [ChannelType.GuildText]: "💬 Yazı kanalı",
  [ChannelType.GuildVoice]: "🔊 Ses kanalı",
  [ChannelType.GuildCategory]: "📁 Kategori",
  [ChannelType.GuildAnnouncement]: "📣 Duyuru kanalı",
  [ChannelType.AnnouncementThread]: "🧵 Duyuru dizisi",
  [ChannelType.PublicThread]: "🧵 Herkese açık dizi",
  [ChannelType.PrivateThread]: "🧵 Özel dizi",
  [ChannelType.GuildStageVoice]: "🎤 Sahne kanalı",
  [ChannelType.GuildForum]: "💭 Forum",
  [ChannelType.GuildMedia]: "🖼️ Medya kanalı",
};

function formatSlowmode(seconds: number): string {
  if (seconds <= 0) return "Kapalı";
  if (seconds < 60) return `${seconds} sn`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} dk`;
  return `${Math.floor(seconds / 3600)} sa`;
}

const command: Command = {
  name: "kanalbilgi",
  aliases: ["kanal-info", "channelinfo"],
  description: "Kanal hakkında detaylı bilgi gösterir",
  usage: "!kanalbilgi [#kanal]",
  category: "genel",

  async execute(message: Message) {
    const channel = (message.mentions.channels.first() ?? message.channel) as GuildChannel | null;
    if (!channel || !("name" in channel)) {
      return message.reply({
      flags: MessageFlags.IsComponentsV2, components: [errorEmbed("Hata", "Bu komut sunucu kanallarında çalışır.")] });
    }

    const lines = [
      `🆔 ID: \`${channel.id}\``,
      `📌 Tür: ${TYPE_NAMES[channel.type] ?? "Bilinmiyor"}`,
      `📅 Oluşturulma: ${new Date(channel.createdTimestamp).toLocaleString("tr-TR")}`,
    ];

    if ("topic" in channel) {
      const topic = channel.topic;
      if (typeof topic === "string" && topic) lines.push(`📝 Konu: ${topic.slice(0, 200)}`);
    }
    if ("parent" in channel && channel.parent) lines.push(`📁 Kategori: ${channel.parent.name}`);
    if ("rateLimitPerUser" in channel) {
      const rateLimitPerUser = channel.rateLimitPerUser;
      lines.push(`🐢 Yavaş mod: ${formatSlowmode(typeof rateLimitPerUser === "number" ? rateLimitPerUser : 0)}`);
    }
    if ("nsfw" in channel) lines.push(`🔞 NSFW: ${channel.nsfw ? "Açık" : "Kapalı"}`);
    if ("position" in channel) lines.push(`🔢 Sıra: ${channel.position}`);

    return message.reply({
      flags: MessageFlags.IsComponentsV2,
      components: [infoEmbed(`#${channel.name}`, lines.join("\n"))],
    });
  },
};

addSlash(
  command,
  [{ name: "kanal", description: "Bilgisi görülecek kanal (boşsa bu kanal)", type: "channel", required: false }],
  (v) => (v.channelMention("kanal") ? [v.channelMention("kanal") as string] : []),
);

export default command;
