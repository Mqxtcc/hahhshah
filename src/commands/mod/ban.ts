import { COMPONENTS_V2_FLAG, errorCard, V2CardBuilder } from "../../utils/componentsV2.js";
import { PermissionFlagsBits, type Message } from "discord.js";
import type { Command } from "../../types.js";
import { generateCaseId, notifCard } from "../../utils/modUtils.js";
import { parseMention } from "../../utils/parse.js";
import { EMOJIS } from "../../utils/emojis.js";
import { COLORS, moderationEmbed } from "../../utils/embeds.js";
import {
  NO_PING,
  announceThenAct,
  auditReason,
  checkBotAble,
  checkBotPerm,
  checkHierarchy,
  isProtectedTarget,
  modSuccess,
  msg,
  requireModPerm,
  sendModLog,
} from "./_shared.js";
import { addSlash } from "../../utils/slashBridge.js";

/** Discord native ban deleteMessageSeconds seçenekleri (saniye). */
const DELETE_RANGES: Record<string, { seconds: number; label: string }> = {
  hicbiri: { seconds: 0, label: "Hiçbiri" },
  "1s": { seconds: 3_600, label: "Önceki 1 saat" },
  "6s": { seconds: 21_600, label: "Önceki 6 saat" },
  "12s": { seconds: 43_200, label: "Önceki 12 saat" },
  "24s": { seconds: 86_400, label: "Önceki 24 saat" },
  "3g": { seconds: 259_200, label: "Önceki 3 gün" },
  "7g": { seconds: 604_800, label: "Önceki 7 gün" },
};
const DEFAULT_DELETE_RANGE = DELETE_RANGES["7g"];

const command: Command = {
  name: "ban",
  aliases: ["yasakla"],
  description: "Kullanıcıyı sunucudan yasaklar (sunucuda olmasa da ID ile çalışır)",
  usage: "!ban <@kullanıcı|id> [1s|6s|12s|24s|3g|7g|hicbiri] [sebep]",
  category: "mod",

  async execute(message: Message, args: string[]) {
    if (!message.guild || !message.member) return;

    if (!(await requireModPerm(message, "ban", PermissionFlagsBits.BanMembers))) return;

    const targetId = parseMention(args[0] ?? "");
    if (!targetId) {
      await message.reply({
        flags: COMPONENTS_V2_FLAG,
        components: [msg.usageEmbed(
          "Kullanım: `!ban <@kullanıcı|id> [1s|6s|12s|24s|3g|7g|hicbiri] [sebep]`\n" +
            "Mesaj silme süresi belirtilmezse varsayılan **7 gün** uygulanır.",
        )],
        ...NO_PING,
      });
      return;
    }

    if (
      await isProtectedTarget(message, targetId, {
        self: "Kendini yasaklayamazsın.",
        bot: "Beni yasaklayamazsın.",
        owner: "Bot sahibini yasaklayamam.",
      })
    )
      return;

    const maybeRange = (args[1] ?? "").toLowerCase();
    const deleteRange = DELETE_RANGES[maybeRange] ?? DEFAULT_DELETE_RANGE;
    const reasonArgs = DELETE_RANGES[maybeRange] ? args.slice(2) : args.slice(1);
    const reason = reasonArgs.join(" ").trim() || "Sebep belirtilmedi";

    // Botun genel ban yetkisi yoksa en baştan söyle (boşuna mesaj atmayalım).
    if (!(await checkBotPerm(message, PermissionFlagsBits.BanMembers, "Üyeleri Yasakla"))) return;

    const member = await message.guild.members.fetch(targetId).catch(() => null);

    if (member) {
      // Hedef sunucudaysa: rol/izin engeli + moderatör hiyerarşisi.
      if (
        !(await checkBotAble(
          message,
          member,
          PermissionFlagsBits.BanMembers,
          "yasaklayamam",
          "Üyeleri Yasakla",
        ))
      )
        return;
      if (!member.user.bot && !(await checkHierarchy(message, member))) return;
    }

    const caseId = generateCaseId();
    const targetUser = member?.user ?? (await message.client.users.fetch(targetId).catch(() => null));
    if (!targetUser) {
      await message.reply({ flags: COMPONENTS_V2_FLAG, components: [errorCard({ description: msg.err("Geçerli bir kullanıcı bulunamadı.") })], ...NO_PING  });
      return;
    }

    // Önce kısa başarı mesajı kanala gider, SONRA yasaklama uygulanır.
    const done = await announceThenAct(
      message,
      modSuccess({
        emoji: EMOJIS.success,
        tag: targetUser.tag,
        verb: "başarıyla yasaklandı.",
        reason,
        duration: "Kalıcı",
      }),
      async () => {
        await message.guild!.members.ban(targetId, {
          reason: auditReason(caseId, message.author.tag, reason),
          deleteMessageSeconds: deleteRange.seconds,
        });
      },
      "Yasaklama başarısız oldu. Botun yetkilerini ve rol sırasını kontrol et.",
    );
    if (!done) return;

    // DM bildirimi (yasaklanan kullanıcıya) — en iyi çabayla, sessizce.
    if (member) {
      const card = notifCard("Yasaklandın", targetUser, reason, message.author.tag, "Kalıcı");
      await member.send({ flags: COMPONENTS_V2_FLAG, components: [card] }).catch(() => undefined);
    }

    await sendModLog(
      message.guild,
      moderationEmbed({
        action: "Kullanıcı Yasaklandı",
        emoji: EMOJIS.ban,
        color: COLORS.error,
        targetTag: `${targetUser}`,
        targetId: targetUser.id,
        targetAvatar: targetUser.displayAvatarURL({ size: 256 }),
        moderatorTag: `${message.author}`,
        reason,
        caseId,
        duration: "Kalıcı",
        extraFields: [{ name: "🗑️ Mesajlar", value: deleteRange.label, inline: true }],
      }),
    );
  },
};


addSlash(command, [
  { name: "kullanici", description: "Yasaklanacak kullanıcı", type: "user", required: true },
  { name: "silme_suresi", description: "Silinecek mesaj aralığı: 1s, 6s, 12s, 24s, 3g, 7g, hicbiri", type: "string" },
  { name: "sebep", description: "Yasaklama sebebi", type: "string" },
]);

export default command;
