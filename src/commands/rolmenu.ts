import { errorCard, textCard, V2CardBuilder } from "../utils/componentsV2.js";
import { MessageFlags, PermissionFlagsBits, type Message } from "discord.js";
import type { Command } from "../types.js";
import { errorEmbed, COLORS } from "../utils/embeds.js";
import { requireModPerm, NO_PING, msg } from "./mod/_shared.js";
import { listMenus, deleteMenu, parseMenuConfig } from "../rolemenu/store.js";
import { addSlash, type SlashValues } from "../utils/slashBridge.js";

const command: Command = {
  name: "rolmenu",
  aliases: ["rol-menu", "rolemenuler"],
  description: "Rol menülerini listeler/siler",
  usage: "!rolmenu liste | !rolmenu sil <menü-id>",
  category: "mod",

  async execute(message: Message, args: string[]) {
    if (!message.guild || !message.member) {
      return message.reply({
      flags: MessageFlags.IsComponentsV2, components: [errorEmbed("Hata", "Bu komut sadece sunucu içinde kullanılabilir.")] });
    }
    if (!(await requireModPerm(message, "rolmenu", PermissionFlagsBits.ManageRoles))) return;

    const sub = (args[0] ?? "liste").toLocaleLowerCase("tr-TR");

    if (sub === "liste" || sub === "list") {
      const menus = await listMenus(message.guild.id).catch(() => []);
      if (menus.length === 0) {
        return message.reply({
      flags: MessageFlags.IsComponentsV2, components: textCard(msg.info("Bu sunucuda rol menüsü yok. `!butonrol`, `!emojirol` veya `!kategorirol` ile kurabilirsin.")), ...NO_PING });
      }
      const typeLabel = (t: string) => (t === "button" ? "🔘 Buton" : t === "select" ? "📋 Seçim" : "😀 Emoji");
      const lines = menus.map((m) => {
        const count = parseMenuConfig(m).items.length;
        return `\`${m.id}\` — ${typeLabel(m.type)} **${m.title}** (${count} rol, <#${m.channelId}>)`;
      });
      const embed = new V2CardBuilder()
        .setColor(COLORS.brand)
        .setTitle("🎭 Rol Menüleri")
        .setDescription(lines.join("\n").slice(0, 4000))
        .setFooter({ text: "Silmek için: !rolmenu sil <menü-id>" });
      return message.reply({
      flags: MessageFlags.IsComponentsV2, components: [embed], ...NO_PING });
    }

    if (sub === "sil" || sub === "delete" || sub === "kaldır") {
      const id = args[1];
      if (!id) return message.reply({
      flags: MessageFlags.IsComponentsV2, components: [errorCard({ description: msg.err("Kullanım: `!rolmenu sil <menü-id>`") })], ...NO_PING });
      const ok = await deleteMenu(message.client, id);
      return message.reply({
      flags: MessageFlags.IsComponentsV2,
        components: [errorCard({ description: ok ? msg.ok("Rol menüsü silindi.") : msg.err("Bu ID ile menü bulunamadı.") })],
        ...NO_PING,
      });
    }

    return message.reply({
      flags: MessageFlags.IsComponentsV2, components: [errorCard({ description: msg.err("Kullanım: `!rolmenu liste` veya `!rolmenu sil <menü-id>`") })], ...NO_PING });
  },
};

addSlash(
  command,
  [
    {
      name: "islem",
      description: "liste veya sil",
      type: "string",
      required: true,
      choices: [
        { name: "liste", value: "liste" },
        { name: "sil", value: "sil" },
      ],
    },
    { name: "menu_id", description: "Silinecek menünün ID'si", type: "string" },
  ],
  (v: SlashValues) => {
    const args = [v.str("islem") ?? "liste"];
    const id = v.str("menu_id");
    if (id) args.push(id);
    return args;
  },
);

export default command;
