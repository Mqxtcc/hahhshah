import type { Client, Message } from "discord.js";

// ---------------------------------------------------------------------------
// 👻 Snipe deposu — silinen son mesajlar kanal başına bellekte tutulur.
// Restart'ta sıfırlanır (kasıtlı: snipe anlık bir özelliktir).
// ---------------------------------------------------------------------------

export interface SnipedMessage {
  authorTag: string;
  authorId: string;
  authorAvatar: string | null;
  content: string;
  attachments: number;
  deletedAt: number;
}

const PER_CHANNEL = 3;
const snipes = new Map<string, SnipedMessage[]>();

export function recordDeleted(message: Message): void {
  // Bot mesajlarını ve boş içerikleri kaydetme
  if (message.author?.bot) return;
  if (!message.content && message.attachments.size === 0) return;
  if (message.channel.isDMBased()) return;

  const entry: SnipedMessage = {
    authorTag: message.author.tag,
    authorId: message.author.id,
    authorAvatar: message.author.displayAvatarURL(),
    content: message.content.slice(0, 2000),
    attachments: message.attachments.size,
    deletedAt: Date.now(),
  };

  const list = snipes.get(message.channel.id) ?? [];
  list.unshift(entry);
  snipes.set(message.channel.id, list.slice(0, PER_CHANNEL));
}

export function getSnipes(channelId: string): SnipedMessage[] {
  return snipes.get(channelId) ?? [];
}

/** messageDelete dinleyicisini client'a bağlar. */
export function registerSnipeEvents(client: Client): void {
  client.on("messageDelete", (message) => {
    try {
      // partial mesajlarda içerik olmayabilir; elimizdekini kaydet
      recordDeleted(message as Message);
    } catch (err) {
      console.error("[snipe] kayıt patladı:", err);
    }
  });
  console.log("[snipe] dinleyici bağlandı");
}
