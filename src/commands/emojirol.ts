import { errorCard, textCard } from "../utils/componentsV2.js";
import { MessageFlags, PermissionFlagsBits, type Message } from "discord.js";
import type { Command } from "../types.js";
import { errorEmbed } from "../utils/embeds.js";
import { requireModPerm, NO_PING, msg } from "./mod/_shared.js";
import { createMenu } from "../rolemenu/store.js";
import { parseEmojiArgs, hierarchyProblems } from "../rolemenu/parse.js";
import { addSlash, type SlashValues } from "../utils/slashBridge.js";

const command: Command = {
  name: "emojirol",
  aliases: ["emoji-rol", "reactionrol", "tepkisel"],
  description: "Emoji tepkili rol menüsü kurar (restart-proof)",
  usage: "!emojirol #kanal Başlık 👍 @rol 🎉 @rol2",
  category: "mod",

  async execute(message: Message, args: string[]) {
    if (!message.guild || !message.member) {
      return message.reply({
      flags: MessageFlags.IsComponentsV2, components: [errorEmbed("Hata", "Bu komut sadece sunucu içinde kullanılabilir.")] });
    }
    if (!(await requireModPerm(message, "emojirol", PermissionFlagsBits.ManageRoles))) return;

    const channel = message.mentions.channels.first();
    if (!channel || !channel.isTextBased()) {
      return message.reply({
      flags: MessageFlags.IsComponentsV2, components: [errorCard({ description: msg.err("Kullanım: `!emojirol #kanal Başlık 👍 @rol 🎉 @rol2`") })], ...NO_PING });
    }
    const rest = args.slice(1);
    const parsed = parseEmojiArgs(message.guild, rest);
    if (parsed.error) return message.reply({
      flags: MessageFlags.IsComponentsV2, components: [errorCard({ description: msg.err(parsed.error) })], ...NO_PING });

    const problems = hierarchyProblems(message.guild, parsed.items);
    if (problems.length > 0) {
      return message.reply({
      flags: MessageFlags.IsComponentsV2, components: [errorCard({ description: msg.err("Bu roller verilemez:\n• " + problems.join("\n• ")) })], ...NO_PING });
    }

    try {
      const menu = await createMenu({
        guild: message.guild,
        channelId: channel.id,
        type: "reaction",
        title: parsed.title,
        items: parsed.items,
        createdBy: message.author.id,
      });
      return message.reply({
      flags: MessageFlags.IsComponentsV2,
        components: textCard(msg.ok(`Emoji menüsü kuruldu (<#${channel.id}>): **${parsed.title}** — ${parsed.items.length} rol.\nMenü ID: \`${menu.id}\` (silmek için \`!rolmenu sil ${menu.id}\`)`)),
        ...NO_PING,
      });
    } catch (err) {
      console.error("emojirol patladı la:", err);
      return message.reply({
      flags: MessageFlags.IsComponentsV2, components: [errorCard({ description: msg.err("Menü kurulamadı — kanala yazma ve tepki ekleme yetkimi kontrol et.") })], ...NO_PING });
    }
  },
};

function pairArgs(v: SlashValues): string[] {
  const args: string[] = [];
  const ch = v.channelMention("kanal");
  const baslik = v.str("baslik");
  if (ch) args.push(ch);
  if (baslik) args.push(...baslik.split(/\s+/));
  for (let i = 1; i <= 5; i++) {
    const e = v.str(`emoji${i}`);
    const r = v.roleMention(`rol${i}`);
    if (!e || !r) continue;
    args.push(e, r);
  }
  return args;
}

addSlash(
  command,
  [
    { name: "kanal", description: "Menünün kurulacağı kanal", type: "channel", required: true },
    { name: "baslik", description: "Menü başlığı", type: "string", required: true },
    { name: "emoji1", description: "1. emoji", type: "string", required: true },
    { name: "rol1", description: "1. rol", type: "role", required: true },
    { name: "emoji2", description: "2. emoji", type: "string" },
    { name: "rol2", description: "2. rol", type: "role" },
    { name: "emoji3", description: "3. emoji", type: "string" },
    { name: "rol3", description: "3. rol", type: "role" },
    { name: "emoji4", description: "4. emoji", type: "string" },
    { name: "rol4", description: "4. rol", type: "role" },
    { name: "emoji5", description: "5. emoji", type: "string" },
    { name: "rol5", description: "5. rol", type: "role" },
  ],
  pairArgs,
);

export default command;
