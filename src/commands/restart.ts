import { MessageFlags } from "discord.js";
import { errorCard, textCard } from "../utils/componentsV2.js";
import { mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync } from "node:fs";
import path from "node:path";
import type { Client, Message } from "discord.js";
import type { Command } from "../types.js";
import { OWNER_ID } from "../config.js";
import { EMOJIS } from "../utils/emojis.js";
import { flushWelcomeBackActivityNow } from "../welcomeback/store.js";

const PENDING_FILE = path.resolve(process.cwd(), "data/pending-restart.json");

type PendingRestart = {
  channelId: string;
  messageId: string;
  triggeredBy: string;
  at: number;
};

function savePendingRestart(data: PendingRestart): void {
  try {
    mkdirSync(path.dirname(PENDING_FILE), { recursive: true });
    writeFileSync(PENDING_FILE, JSON.stringify(data), "utf8");
  } catch (err) {
    console.error("restart notu kaydolmadı:", err);
  }
}

function consumePendingRestart(): PendingRestart | null {
  try {
    if (!existsSync(PENDING_FILE)) return null;
    const raw = readFileSync(PENDING_FILE, "utf8");
    unlinkSync(PENDING_FILE);
    return JSON.parse(raw) as PendingRestart;
  } catch {
    try {
      if (existsSync(PENDING_FILE)) unlinkSync(PENDING_FILE);
    } catch {
      /* ignore */
    }
    return null;
  }
}

/**
 * Bot ayağa kalkınca !restart'ın attığı "başlatılıyor" mesajını
 * "başlatıldı — bot aktif" olarak düzenler.
 */
export async function reportRestartDone(client: Client): Promise<void> {
  const pending = consumePendingRestart();
  if (!pending) return;

  try {
    const channel = await client.channels.fetch(pending.channelId).catch(() => null);
    if (!channel || !channel.isTextBased() || channel.isDMBased()) return;

    const msg = await channel.messages.fetch(pending.messageId).catch(() => null);
    if (!msg) return;

    await msg
      .edit({ flags: MessageFlags.IsComponentsV2, components: textCard(`${EMOJIS.success} Yeniden başlatıldı — bot aktif.`) })
      .catch(() => null);
  } catch (err) {
    console.error("restart mesajı düzenlenemedi:", err);
  }
}

const command: Command = {
  name: "restart",
  aliases: ["yenidenbaşlat", "reboot"],
  description: "Botu yeniden başlatır. (owner-only)",
  usage: "!restart",
  category: "owner",

  async execute(message: Message) {
    if (message.author.id !== OWNER_ID) {
      await message
        .reply({ flags: MessageFlags.IsComponentsV2, components: [errorCard({ description: `${EMOJIS.error} Bu komutu sadece bot sahibi kullanabilir.` })] })
        .catch(() => {});
      return;
    }

    const statusMsg = await message
      .reply({ flags: MessageFlags.IsComponentsV2, components: textCard(`${EMOJIS.yildirim} Yeniden başlatılıyor...`) })
      .catch(() => null);

    if (statusMsg) {
      savePendingRestart({
        channelId: statusMsg.channel.id,
        messageId: statusMsg.id,
        triggeredBy: message.author.id,
        at: Date.now(),
      });
    }

    // Kapanışta saklanacak aktiflik verisi varsa önce diske yaz: process.exit
    // SIGINT/SIGTERM handler'larını çalıştırmadığı için burada elle flush et.
    try {
      await flushWelcomeBackActivityNow();
    } catch {
      /* flush başarısızsa bile restart devam etsin */
    }

    // Pterodactyl: process kapanınca panel botu tekrar ayağa kaldırır.
    setTimeout(() => process.exit(1), 500);
  },
};

export default command;
