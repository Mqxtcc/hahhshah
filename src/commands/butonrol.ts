import { errorCard, textCard } from "../utils/componentsV2.js";
import { MessageFlags, PermissionFlagsBits, type Message } from "discord.js";
import type { Command } from "../types.js";
import { errorEmbed } from "../utils/embeds.js";
import { requireModPerm, NO_PING, msg } from "./mod/_shared.js";
import { createMenu } from "../rolemenu/store.js";
import { parseButtonArgs, hierarchyProblems } from "../rolemenu/parse.js";
import { addSlash, type SlashValues } from "../utils/slashBridge.js";

const command: Command = {
  name: "butonrol",
  aliases: ["buttonrol", "buton-rol"],
  description: "Butonlu rol menüsü kurar (restart-proof)",
  usage: "!butonrol #kanal Başlık @rol Etiket @rol2",
  category: "mod",

  async execute(message: Message, args: string[]) {
    if (!message.guild || !message.member) {
      return message.reply({
      flags: MessageFlags.IsComponentsV2, components: [errorEmbed("Hata", "Bu komut sadece sunucu içinde kullanılabilir.")] });
    }
    if (!(await requireModPerm(message, "butonrol", PermissionFlagsBits.ManageRoles))) return;

    const channel = message.mentions.channels.first();
    if (!channel || !channel.isTextBased()) {
      return message.reply({
      flags: MessageFlags.IsComponentsV2, components: [errorCard({ description: msg.err("Kullanım: `!butonrol #kanal Başlık @rol Etiket @rol2`") })], ...NO_PING });
    }
    // İlk argüman kanal etiketi — parser'a başlık+roller kalır.
    const rest = args.slice(1);
    const parsed = parseButtonArgs(message.guild, rest);
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
        type: "button",
        title: parsed.title,
        items: parsed.items,
        createdBy: message.author.id,
      });
      return message.reply({
      flags: MessageFlags.IsComponentsV2,
        components: textCard(msg.ok(`Buton menüsü kuruldu (<#${channel.id}>): **${parsed.title}** — ${parsed.items.length} rol.\nMenü ID: \`${menu.id}\` (silmek için \`!rolmenu sil ${menu.id}\`)`)),
        ...NO_PING,
      });
    } catch (err) {
      console.error("butonrol patladı la:", err);
      return message.reply({
      flags: MessageFlags.IsComponentsV2, components: [errorCard({ description: msg.err("Menü kurulamadı — kanala yazma yetkimi kontrol et.") })], ...NO_PING });
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
    const r = v.roleMention(`rol${i}`);
    if (!r) continue;
    args.push(r);
    const etiket = v.str(`etiket${i}`);
    if (etiket) args.push(...etiket.split(/\s+/));
  }
  return args;
}

addSlash(
  command,
  [
    { name: "kanal", description: "Menünün kurulacağı kanal", type: "channel", required: true },
    { name: "baslik", description: "Menü başlığı", type: "string", required: true },
    { name: "rol1", description: "1. rol", type: "role", required: true },
    { name: "etiket1", description: "1. düğme etiketi", type: "string" },
    { name: "rol2", description: "2. rol", type: "role" },
    { name: "etiket2", description: "2. düğme etiketi", type: "string" },
    { name: "rol3", description: "3. rol", type: "role" },
    { name: "etiket3", description: "3. düğme etiketi", type: "string" },
    { name: "rol4", description: "4. rol", type: "role" },
    { name: "etiket4", description: "4. düğme etiketi", type: "string" },
    { name: "rol5", description: "5. rol", type: "role" },
    { name: "etiket5", description: "5. düğme etiketi", type: "string" },
  ],
  pairArgs,
);

export default command;
