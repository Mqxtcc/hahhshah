import { MessageFlags } from "discord.js";
import { PermissionFlagsBits, type Message } from "discord.js";
import type { Command } from "../types.js";
import { infoEmbed, errorEmbed } from "../utils/embeds.js";
import { addSlash } from "../utils/slashBridge.js";

interface Check {
  label: string;
  perms: bigint[];
}

const CHECKS: Check[] = [
  { label: "Mesaj gönderme", perms: [PermissionFlagsBits.SendMessages] },
  { label: "Embed gönderme", perms: [PermissionFlagsBits.EmbedLinks] },
  { label: "Mesaj geçmişi okuma", perms: [PermissionFlagsBits.ReadMessageHistory] },
  { label: "Reaksiyon ekleme", perms: [PermissionFlagsBits.AddReactions] },
  { label: "Mesaj silme (clear)", perms: [PermissionFlagsBits.ManageMessages] },
  { label: "Üye atma (kick)", perms: [PermissionFlagsBits.KickMembers] },
  { label: "Üye yasaklama (ban)", perms: [PermissionFlagsBits.BanMembers] },
  { label: "Üye susturma (timeout)", perms: [PermissionFlagsBits.ModerateMembers] },
  { label: "Kanal kilitleme", perms: [PermissionFlagsBits.ManageChannels] },
  { label: "Rol verme", perms: [PermissionFlagsBits.ManageRoles] },
  { label: "Kullanıcı çekme/taşıma (ses)", perms: [PermissionFlagsBits.MoveMembers] },
];

const command: Command = {
  name: "botkontrol",
  aliases: ["bot-kontrol", "yetkikontrol", "permcheck"],
  description: "Botun bu sunucudaki yetkilerini denetler, eksikleri gösterir",
  usage: "!botkontrol",
  category: "genel",

  async execute(message: Message) {
    if (!message.guild) {
      return message.reply({
      flags: MessageFlags.IsComponentsV2, components: [errorEmbed("Hata", "Bu komut sadece sunucuda çalışır.")] });
    }
    const me = message.guild.members.me;
    if (!me) {
      return message.reply({
      flags: MessageFlags.IsComponentsV2, components: [errorEmbed("Hata", "Kendimi sunucuda bulamadım.")] });
    }

    const channel = message.channel;
    const lines: string[] = [];
    let missing = 0;

    for (const check of CHECKS) {
      const ok = check.perms.every((p) => {
        // Kanal-bazlı yetkiler için kanal izinlerine, genel yetkiler için üye izinlerine bak
        const inChannel = "permissionsFor" in channel && typeof channel.permissionsFor === "function"
          ? channel.permissionsFor(me)?.has(p)
          : undefined;
        return inChannel ?? me.permissions.has(p);
      });
      lines.push(`${ok ? "✅" : "❌"} ${check.label}`);
      if (!ok) missing++;
    }

    const summary = missing === 0
      ? "\n\n🎉 Tüm yetkiler tamam, her şey çalışır durumda."
      : `\n\n⚠️ **${missing}** yetki eksik — sunucu ayarlarından bota vermen lazım.`;

    return message.reply({
      flags: MessageFlags.IsComponentsV2,
      components: [infoEmbed("🔍 Bot Yetki Denetimi", lines.join("\n") + summary)],
    });
  },
};

addSlash(command, []);

export default command;
