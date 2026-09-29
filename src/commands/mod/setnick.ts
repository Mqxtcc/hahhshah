import { COMPONENTS_V2_FLAG, errorCard, textCard, V2CardBuilder } from "../../utils/componentsV2.js";
import { PermissionFlagsBits, type Message } from "discord.js";
import type { Command } from "../../types.js";
import { parseMention } from "../../utils/parse.js";
import { generateCaseId } from "../../utils/modUtils.js";
import { EMOJIS } from "../../utils/emojis.js";
import { COLORS, moderationEmbed } from "../../utils/embeds.js";
import { OWNER_ID } from "../../config.js";
import { canModerate } from "../../utils/hierarchy.js";
import {
  NO_PING,
  checkBotPerm,
  isProtectedTarget,
  msg,
  requireModPerm,
  sendModLog,
} from "./_shared.js";
import { addSlash } from "../../utils/slashBridge.js";

const RESET_WORDS = ["sıfırla", "sifirla", "reset", "kaldır", "kaldir", "clear"];

const command: Command = {
  name: "setnick",
  aliases: ["nick", "nickname", "isim"],
  description: "Kullanıcının sunucu takma adını değiştirir",
  usage: "!setnick <@kullanıcı|id> <yeni isim|sıfırla>",
  category: "mod",

  async execute(message: Message, args: string[]) {
    if (!message.guild || !message.member) return;

    if (!(await requireModPerm(message, "setnick", PermissionFlagsBits.ManageNicknames))) return;

    const targetId = parseMention(args[0] ?? "");
    if (!targetId || args.length < 2) {
      await message.reply({
        flags: COMPONENTS_V2_FLAG,
        components: [msg.usageEmbed(
          "Kullanım: `!setnick <@kullanıcı|id> <yeni isim>`\n" + "Takma adı sıfırlamak için: `!setnick @kullanıcı sıfırla`",
        )],
        ...NO_PING,
      });
      return;
    }

    const rawNick = args.slice(1).join(" ").trim();
    const reset = RESET_WORDS.includes(rawNick.toLocaleLowerCase("tr-TR"));
    const newNick = reset ? null : rawNick;

    if (newNick !== null && (newNick.length < 1 || newNick.length > 32)) {
      await message.reply({
        flags: COMPONENTS_V2_FLAG,
        components: [errorCard({ description: msg.err("Takma ad 1–32 karakter arasında olmalı.") })],
        ...NO_PING,
      });
      return;
    }

    if (
      await isProtectedTarget(message, targetId, {
        self: "Kendi takma adını bu komutla değiştiremezsin.",
        bot: "Benim takma adımı değiştiremezsin.",
        owner: "Bot sahibinin takma adını değiştiremezsin.",
      })
    )
      return;

    if (!(await checkBotPerm(message, PermissionFlagsBits.ManageNicknames, "Takma Adları Yönet"))) return;

    const member = await message.guild.members.fetch(targetId).catch(() => null);
    if (!member) {
      await message.reply({ flags: COMPONENTS_V2_FLAG, components: [errorCard({ description: msg.err("Kullanıcı sunucuda değil.") })], ...NO_PING  });
      return;
    }

    if (member.id === message.guild.ownerId) {
      await message.reply({
        flags: COMPONENTS_V2_FLAG,
        components: [errorCard({ description: msg.err("Sunucu sahibinin takma adını değiştiremem.") })],
        ...NO_PING,
      });
      return;
    }

    const me = await message.guild.members.fetchMe().catch(() => message.guild!.members.me);
    if (member.roles.highest.position >= (me?.roles.highest.position ?? -1) && member.id !== me?.id) {
      await message.reply({
        flags: COMPONENTS_V2_FLAG,
        components: [errorCard({ description: msg.err("Bu kullanıcının rolü benim rolümden yüksek veya eşit; takma adını değiştiremem.") })],
        ...NO_PING,
      });
      return;
    }

    const isOwner = message.author.id === OWNER_ID;
    if (!isOwner && !canModerate(message.member, member) && member.id !== message.author.id) {
      await message.reply({
        flags: COMPONENTS_V2_FLAG,
        components: [errorCard({ description: msg.err("Bu kullanıcının rolü seninkiyle aynı veya daha yüksek.") })],
        ...NO_PING,
      });
      return;
    }

    const oldName = member.displayName;

    try {
      await member.setNickname(newNick, `${message.author.tag} tarafından değiştirildi`);
    } catch (err) {
      const code = (err as { code?: number })?.code;
      if (code === 50013) {
        await message.reply({
          flags: COMPONENTS_V2_FLAG,
          components: [errorCard({ description: msg.err("Takma ad değiştirmek için yeterli yetkim yok. Rol hiyerarşisini kontrol et.") })],
          ...NO_PING,
        });
        return;
      }
      console.error("setnick patladı la:", err);
      await message.reply({ flags: COMPONENTS_V2_FLAG, components: [errorCard({ description: msg.err("Takma ad değiştirilirken bir hata oluştu.") })], ...NO_PING  });
      return;
    }

    const displayNew = newNick ?? "(sıfırlandı)";
    const caseId = generateCaseId();
    await message.reply({
      flags: COMPONENTS_V2_FLAG,
      components: textCard(msg.ok(`**${member.user.tag}** takma adı değiştirildi: \`${oldName}\` → \`${displayNew}\``)),
      ...NO_PING,
    });

    await sendModLog(
      message.guild,
      moderationEmbed({
        action: "Takma Ad Değiştirildi",
        emoji: EMOJIS.success,
        color: COLORS.success,
        targetTag: `${member.user}`,
        targetId: member.id,
        targetAvatar: member.user.displayAvatarURL({ size: 256 }),
        moderatorTag: `${message.author}`,
        reason: `${oldName} → ${displayNew}`,
        caseId,
      }),
    );
  },
};


addSlash(command, [
  { name: "kullanici", description: "İsmi değiştirilecek kullanıcı", type: "user", required: true },
  { name: "isim", description: "Yeni isim (sıfırlamak için: sıfırla)", type: "string", required: true },
]);

export default command;
