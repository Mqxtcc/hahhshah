import { COMPONENTS_V2_FLAG, fileComponent, textCard, V2CardBuilder, buttonRow } from "../../utils/componentsV2.js";
import { ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, ComponentType, type Message } from "discord.js";
import type { Command } from "../../types.js";
import { EMOJIS } from "../../utils/emojis.js";
import {
  requireOwnerOrHalfOwner,
  formatDurationMs,
  formatAgo,
  getGuildPrefix,
} from "../../events/messageCreate.js";
import {
  BOT_START_TIME,
  consoleLogBuffer,
  errorLog,
} from "../../utils/runtimeLogs.js";

export const hataLog: Command = {
  name: "hata-log",
  aliases: ["hatalog", "errorlog"],
  description: "Son hataları gösterir (owner / half-owner)",
  usage: "!hata-log",
  category: "owner",

  async execute(message: Message) {
    if (!(await requireOwnerOrHalfOwner(message))) return;
    if (errorLog.length === 0) {
      await message.reply({ flags: COMPONENTS_V2_FLAG, components: textCard(`${EMOJIS.success} Kayıtlı hata yok.`) }).catch(() => null);
      return;
    }
    const embed = new V2CardBuilder()
      .setColor(0xed4245)
      .setTitle("🐞 Son Hatalar")
      .setDescription(
        [...errorLog]
          .reverse()
          .slice(0, 10)
          .map((e) => `\`${formatAgo(e.timestamp)}\` — ${e.message.slice(0, 200)}`)
          .join("\n\n"),
      )
      .setFooter({ text: `Son ${Math.min(errorLog.length, 10)}/${errorLog.length} hata` })
      .setTimestamp();
    await message.reply({ flags: COMPONENTS_V2_FLAG, components: [embed] }).catch(() => null);
  },
};

export const consoleLog: Command = {
  name: "console-log",
  aliases: ["consolelog"],
  description: "Son N dakikanın konsol çıktısını gösterir (owner / half-owner)",
  usage: "!console-log [dakika]",
  category: "owner",

  async execute(message: Message, args: string[]) {
    if (!(await requireOwnerOrHalfOwner(message))) return;
    if (args.length === 0) {
      const tutorialEmbed = new V2CardBuilder()
        .setColor(0xd0a840)
        .setTitle("📜 !console-log")
        .setDescription(`\`${getGuildPrefix(message.guild?.id)}console-log 10\` — son 10 dakika\n\`${getGuildPrefix(message.guild?.id)}console-log 30\` — son 30 dakika\n\`${getGuildPrefix(message.guild?.id)}console-log 60\` — son 60 dakika`)
        .setTimestamp();
      await message.reply({ flags: COMPONENTS_V2_FLAG, components: [tutorialEmbed] }).catch(() => null);
      return;
    }
    const requestedMinutes = Number(args[0]);
    const minutes = Number.isFinite(requestedMinutes) && requestedMinutes > 0 ? Math.min(requestedMinutes, 60) : 10;
    const cutoff = Date.now() - minutes * 60_000;
    const entries = consoleLogBuffer.filter((e) => e.timestamp >= cutoff);
    if (entries.length === 0) {
      await message.reply({ flags: COMPONENTS_V2_FLAG, components: textCard(` ${EMOJIS.success} Son ${minutes} dakikada konsol çıktısı yok.`) }).catch(() => null);
      return;
    }
    const lines = entries.map((e) => {
      const time = new Date(e.timestamp).toLocaleTimeString("tr-TR", { hour12: false });
      return `[${time}] [${e.level.toUpperCase()}] ${e.message}`;
    });
    const text = lines.join("\n");
    const EMBED_SAFE_LIMIT = 3900;
    if (text.length <= EMBED_SAFE_LIMIT) {
      const embed = new V2CardBuilder()
        .setColor(0xd0a840)
        .setTitle(`📜 Son ${minutes} Dakika Konsol`)
        .setDescription("```\n" + text + "\n```")
        .setFooter({ text: `${entries.length} satır` })
        .setTimestamp();
      await message.reply({ flags: COMPONENTS_V2_FLAG, components: [embed] }).catch(() => null);
    } else {
      const buffer = Buffer.from(text, "utf-8");
      const file = new AttachmentBuilder(buffer, { name: `console-log-${minutes}dk.txt` });
      await message.reply({ flags: COMPONENTS_V2_FLAG, components: [...textCard(`📜 Konsol çıktısı (${entries.length} satır):`), fileComponent(file.name ?? "console-log.txt")], files: [file] }).catch(() => null); }
  },
};

export const istatistik: Command = {
  name: "istatistik",
  aliases: ["botstats"],
  description: "Bot istatistiklerini gösterir",
  usage: "!istatistik",
  category: "genel",

  async execute(message: Message) {
    const now = Date.now();
    const embed = new V2CardBuilder()
      .setColor(0x1a1a1e)
      .setTitle("📊 İstatistikler")
      .addFields(
        { name: "⏱️ Uptime", value: formatDurationMs(now - BOT_START_TIME), inline: true },
        { name: "🌐 Sunucular", value: `${message.client.guilds.cache.size}`, inline: true },
        { name: "🏓 Ping", value: `${message.client.ws.ping}ms`, inline: true },
      )
      .setTimestamp();
    await message.reply({ flags: COMPONENTS_V2_FLAG, components: [embed] }).catch(() => null);
  },
};

export const ping: Command = {
  name: "ping",
  description: "Bot gecikmesini ölçer",
  usage: "!ping",
  category: "genel",

  async execute(message: Message) {
    const sent = await message.reply({ flags: COMPONENTS_V2_FLAG, components: textCard(`${EMOJIS.loading} Ölçülüyor...`) });
    const latency = sent.createdTimestamp - message.createdTimestamp;

    const buildPingEmbed = (lat: number, ws: number): {
      flags: typeof COMPONENTS_V2_FLAG;
      components: (V2CardBuilder | ActionRowBuilder<ButtonBuilder>)[];
    } => {
      const embed = new V2CardBuilder()
        .setColor(0x1a1a1e)
        .setTitle("🏓 Gecikme")
        .setDescription(`**Mesaj:** \`${lat}ms\`\n**WebSocket:** \`${ws}ms\``)
        .setTimestamp();
      const row = buttonRow([
        new ButtonBuilder().setCustomId("refresh_ping").setLabel("Yenile").setStyle(ButtonStyle.Secondary)
      ]);
      return { flags: COMPONENTS_V2_FLAG, components: [embed, row] };
    };

    await sent.edit(buildPingEmbed(latency, message.client.ws.ping)).catch(() => null);

    const collector = sent.createMessageComponentCollector({ componentType: ComponentType.Button, time: 60000 });
    collector.on("collect", async (i) => {
      if (i.user.id !== message.author.id) {
        await i.reply({ content: "Bu butonu sadece komutu kullanan kişi kullanabilir.", ephemeral: true });
        return;
      }
      const newLat = Date.now() - i.createdTimestamp;
      await i.update(buildPingEmbed(newLat, message.client.ws.ping)).catch(() => null);
    });
    collector.on("end", () => {
      sent.edit({ components: [buildPingEmbed(latency, message.client.ws.ping).components[0]] }).catch(() => null);
    });
  },
};

export const uptime: Command = {
  name: "uptime",
  description: "Botun ne kadar süredir ayakta olduğunu gösterir",
  usage: "!uptime",
  category: "genel",

  async execute(message: Message) {
    await message.reply({ flags: COMPONENTS_V2_FLAG, components: textCard(`⏱️ Bot ${formatDurationMs(Date.now() - BOT_START_TIME)} dir ayakta.`) }).catch(() => null);
  },
};

export const sunucular: Command = {
  name: "sunucular",
  aliases: ["guilds", "serverlist"],
  description: "Botun bulunduğu sunucuları listeler (owner / half-owner)",
  usage: "!sunucular",
  category: "owner",

  async execute(message: Message) {
    if (!(await requireOwnerOrHalfOwner(message))) return;
    const guilds = [...message.client.guilds.cache.values()].sort((a, b) => (b.joinedTimestamp ?? 0) - (a.joinedTimestamp ?? 0));
    const lines = guilds.map((g) => `**${g.name}**\n└ ID: \`${g.id}\` • Owner: \`${g.ownerId}\` • Üye: ${g.memberCount}`);
    const text = lines.join("\n\n");
    const EMBED_SAFE_LIMIT = 3900;
    if (text.length <= EMBED_SAFE_LIMIT) {
      const embed = new V2CardBuilder()
        .setColor(0xed4245)
        .setTitle(`🌐 Sunucular (${guilds.length})`)
        .setDescription(text || "Hiç sunucu yok.")
        .setTimestamp();
      await message.reply({ flags: COMPONENTS_V2_FLAG, components: [embed] }).catch(() => null);
    } else {
      const buffer = Buffer.from(text, "utf-8");
      const file = new AttachmentBuilder(buffer, { name: "sunucular.txt" });
      await message.reply({ flags: COMPONENTS_V2_FLAG, components: [...textCard(`🌐 ${guilds.length} sunucu:`), fileComponent(file.name ?? "sunucular.txt")], files: [file] }).catch(() => null); }
  },
};
