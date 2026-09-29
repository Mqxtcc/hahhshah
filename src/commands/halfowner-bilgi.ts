import { V2CardBuilder } from "../utils/componentsV2.js";
import { MessageFlags, type Message } from "discord.js";
import type { Command } from "../types.js";
import { COLORS } from "../utils/embeds.js";
import { getGuildPrefix } from "../events/messageCreate.js";
import {
  ensureHalfOwnersLoaded,
  listHalfOwnerIds,
} from "../premium/halfOwners.js";
import { addSlash } from "../utils/slashBridge.js";

// Herkese açık half-owner bilgi komutu: yetki gerektirmez.
// Half-owner'ın ne olduğunu, neler yapabildiğini ve mevcut listeyi gösterir.
const command: Command = {
  name: "halfowner-bilgi",
  aliases: ["halfownerbilgi", "halfownerinfo"],
  description: "Half-owner nedir, neler yapabilir ve kimler — herkese açık bilgi",
  usage: "!halfowner-bilgi",
  category: "genel",

  async execute(message: Message) {
    const p = getGuildPrefix(message.guild?.id);
    await ensureHalfOwnersLoaded();
    const ids = listHalfOwnerIds();

    const embed = new V2CardBuilder()
      .setColor(COLORS.info)
      .setTitle("👑 Half-Owner Nedir?")
      .setDescription(
        "Half-owner, bot sahibinin **güvenip yetki verdiği** kişidir. " +
          "Owner değildir — tehlikeli komutlara (eval, restart vb.) **asla** erişemez.",
      )
      .addFields(
        {
          name: "🛠️ Yapabildikleri",
          value:
            `\`${p}premium\` — premium verir\n` +
            `\`${p}premium-kaldir\` — premium geri alır\n` +
            `\`${p}premium-liste\` — premium listesini görür\n` +
            `\`${p}özelüye\` — VIP rozeti verir/alır\n` +
            `\`${p}hata-log\` \`${p}console-log\` — logları görür\n` +
            `\`${p}veribak\` — veritabanını görüntüler`,
        },
        {
          name: `📋 Mevcut half-owner'lar (${ids.length})`,
          value:
            ids.length === 0
              ? "Henüz hiç half-owner yok."
              : ids.map((id, i) => `\`${i + 1}.\` <@${id}>`).join("\n"),
        },
      )
      .setFooter({ text: "Half-owner olmak için bot sahibiyle iletişime geç" })
      .setTimestamp();

    await message.reply({
      flags: MessageFlags.IsComponentsV2, components: [embed] }).catch(() => null);
  },
};

addSlash(command, []);

export default command;
