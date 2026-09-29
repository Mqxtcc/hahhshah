// src/rolemenu/reactions.ts
// ---------------------------------------------------------------------------
// 😀 Emoji rol menüleri (reaction roles): kullanıcı menü mesajına tepki
// ekleyince rol verilir, geri alınca alınır. Menü tanımı DB'de olduğu için
// restart'tan etkilenmez; açılış uzlaşması bot tepkilerini tamamlar.
// ---------------------------------------------------------------------------

import {
  Events,
  type Client,
  type GuildMember,
  type MessageReaction,
  type PartialMessageReaction,
  type PartialUser,
  type User,
} from "discord.js";
import { getMenuByMessage, parseMenuConfig, emojiForReact } from "./store.js";

function reactionId(reaction: MessageReaction | PartialMessageReaction): string | null {
  const e = reaction.emoji;
  if (e.id) return `${e.name}:${e.id}`;
  return e.name ?? null;
}

async function handleReaction(
  reaction: MessageReaction | PartialMessageReaction,
  user: User | PartialUser,
  added: boolean,
): Promise<void> {
  if (user.bot) return;
  try {
    if (reaction.partial) await reaction.fetch().catch(() => null);
    const message = reaction.message;
    if (!message.guild) return;
    const menu = await getMenuByMessage(message.id).catch(() => null);
    if (!menu || menu.type !== "reaction" || menu.guildId !== message.guild.id) return;

    const rid = reactionId(reaction);
    if (!rid) return;
    const item = parseMenuConfig(menu).items.find((i) => i.emoji === rid);
    if (!item) return;

    const guild = message.guild;
    const member = (await guild.members.fetch(user.id).catch(() => null)) as GuildMember | null;
    const role = guild.roles.cache.get(item.roleId) ?? (await guild.roles.fetch(item.roleId).catch(() => null));
    const me = guild.members.me;
    if (!member || !role || !me || me.roles.highest.position <= role.position) return;

    if (added) {
      if (!member.roles.cache.has(item.roleId)) {
        await member.roles.add(item.roleId, `Emoji rol menüsü: ${menu.title}`).catch(() => null);
      }
    } else {
      if (member.roles.cache.has(item.roleId)) {
        await member.roles.remove(item.roleId, `Emoji rol menüsü: ${menu.title}`).catch(() => null);
      }
    }
  } catch (err) {
    console.error("emoji rol tepkisi patladı:", err instanceof Error ? err.message : err);
  }
}

/** botClient.registerDiscordEvents içinden çağrılır. Partials.Reaction gerekli. */
export function registerRoleMenuReactionEvents(client: Client): void {
  client.on(Events.MessageReactionAdd, (reaction, user) => {
    void handleReaction(reaction, user, true);
  });
  client.on(Events.MessageReactionRemove, (reaction, user) => {
    void handleReaction(reaction, user, false);
  });
}

// emojiForReact yeniden ihracı (komut dosyaları için tek giriş).
export { emojiForReact };
