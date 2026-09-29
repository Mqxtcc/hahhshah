import { V2CardBuilder } from "../utils/componentsV2.js";
import { MessageFlags, version as discordJsVersion, type Client, type Message } from "discord.js";
import type { Command } from "../types.js";
import { getActiveBackend } from "../db/index.js";
import { getAllPremiumUsers } from "../premium/store.js";
import { getLoadedCommands } from "./loader.js";
import { EMOJIS } from "../utils/emojis.js";
import { formatDurationMs } from "../events/messageCreate.js";
import { addSlash } from "../utils/slashBridge.js";

function formatBytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function runtimeVersion(): string {
  return process.env.BUILD_VERSION?.trim()
    || process.env.BUILD_ID?.trim()
    || process.env.RELEASE_VERSION?.trim()
    || "development";
}

function typescriptVersion(): string {
  return process.env.TS_VERSION?.trim()
    || process.env.npm_package_devDependencies_typescript?.trim()
    || process.env.npm_package_dependencies_typescript?.trim()
    || "runtime bilgisi yok";
}

async function measureWebSocketPing(client: Client): Promise<number | null> {
  // Gateway ping'i login sonrası ilk heartbeat'te oluşabilir. Bu yüzden tek
  // okumada -1 döndürmek yerine kısa bir ölçüm penceresi kullanıyoruz.
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const ping = client.ws.ping;
    if (Number.isFinite(ping) && ping >= 0) return ping;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return null;
}

function buildInfoEmbed(message: Message, state: "loading" | "result", data?: { responseLatency: number; websocketPing: number | null; premiumCount: number }): V2CardBuilder {
  const memory = process.memoryUsage();
  const guilds = message.client.guilds.cache;
  const totalMembers = guilds.reduce((total, guild) => total + guild.memberCount, 0);
  const djsVersion = discordJsVersion || "paketten okunamadı";
  const nodeVersion = process.versions.node;
  const tsVersion = typescriptVersion();
  const result = state === "result";

  return new V2CardBuilder()
    .setColor(0x1a1a1e)
    .setTitle(result ? "Sistem Bilgisi" : "Sistem Bilgisi (Yükleniyor...)")
    .setDescription(result ? "Botun çalıştığı sunucudan alınan anlık veriler." : "Veriler toplanıyor...")
    .addFields(
      { name: "Ping", value: result ? `**${data?.responseLatency ?? 0}ms**` : "...", inline: true },
      { name: "WebSocket", value: result ? (data?.websocketPing == null ? "Zaman Aşımı" : `**${data.websocketPing}ms**`) : "...", inline: true },
      { name: "RAM (RSS)", value: result ? `**${formatBytes(memory.rss)}**` : "...", inline: true },
      { name: "Uptime", value: result ? `**${formatDurationMs(process.uptime() * 1000)}**` : "...", inline: true },
      { name: "Sunucular", value: result ? `**${guilds.size}**` : "...", inline: true },
      { name: "Kullanıcılar", value: result ? `**${totalMembers.toLocaleString("tr-TR")}**` : "...", inline: true },
      { name: "discord.js", value: result ? `**v${djsVersion}**` : "...", inline: true },
      { name: "Node.js", value: result ? `**v${nodeVersion}**` : "...", inline: true },
      { name: "Komutlar", value: result ? `**${getLoadedCommands().length}**` : "...", inline: true },
      { name: "Veritabanı", value: result ? (getActiveBackend() === "sqlite" ? "**SQLite**" : "**JSON**") : "...", inline: true },
      { name: "Premium", value: result ? `**${data?.premiumCount ?? 0}**` : "...", inline: true },
      { name: "Build", value: result ? `\`${runtimeVersion()}\`` : "...", inline: true },
    )
    .setTimestamp();
}

const command: Command = {
  name: "info",
  aliases: ["botinfo", "botbilgi"],
  description: "Botun genel çalışma ve sistem bilgilerini gösterir",
  usage: "!info",
  category: "genel",

  async execute(message: Message) {
    const sent = await message.reply({
      flags: MessageFlags.IsComponentsV2, components: [buildInfoEmbed(message, "loading")] }).catch(() => null);
    if (!sent) return;

    const [websocketPing, premiumUsers] = await Promise.all([
      measureWebSocketPing(message.client),
      getAllPremiumUsers().catch(() => []),
    ]);
    const responseLatency = Math.max(0, sent.createdTimestamp - message.createdTimestamp);
    await sent.edit({
      flags: MessageFlags.IsComponentsV2, components: [buildInfoEmbed(message, "result", { responseLatency, websocketPing, premiumCount: premiumUsers.length })] }).catch(() => null);
  },
};


addSlash(command, []);

export default command;
