import { COMPONENTS_V2_FLAG, errorCard, textCard, V2CardBuilder } from "../../utils/componentsV2.js";
import { PermissionFlagsBits, type Message } from "discord.js";
import { eq, and, count } from "../../db/jsonOrm.js";
import type { Command } from "../../types.js";
import { generateCaseId, warnBar, notifCard } from "../../utils/modUtils.js";
import { parseMention } from "../../utils/parse.js";
import { db, warningsTable } from "../../db/index.js";
import { EMOJIS } from "../../utils/emojis.js";
import { COLORS, moderationEmbed } from "../../utils/embeds.js";
import {
  NO_PING,
  auditReason,
  checkHierarchy,
  isProtectedTarget,
  modSuccess,
  msg,
  requireModPerm,
  sendModLog,
} from "./_shared.js";
import { addSlash } from "../../utils/slashBridge.js";

/** 3. uyarıdan itibaren her uyarıda artan otomatik timeout (saat cinsinden). */
function getMuteDurationMs(totalWarns: number): number | null {
  if (totalWarns < 3) return null;
  return (totalWarns - 2) * 60 * 60 * 1000;
}

function formatHours(ms: number): string {
  const h = ms / 3_600_000;
  return h === 1 ? "1 saat" : `${h} saat`;
}

const command: Command = {
  name: "warn",
  aliases: ["uyar"],
  description: "Kullanıcıyı uyarır; 3. uyarıdan itibaren otomatik timeout uygular",
  usage: "!warn <@kullanıcı|id> <sebep>",
  category: "mod",

  async execute(message: Message, args: string[]) {
    if (!message.guild || !message.member) return;

    if (!(await requireModPerm(message, "warn", PermissionFlagsBits.ModerateMembers))) return;

    const targetId = parseMention(args[0] ?? "");
    const reason = args.slice(1).join(" ").trim();

    if (!targetId || !reason) {
      await message.reply({
        flags: COMPONENTS_V2_FLAG,
        components: [msg.usageEmbed("Kullanım: `!warn <@kullanıcı|id> <sebep>`\nSebep zorunludur.")],
        ...NO_PING,
      });
      return;
    }

    if (
      await isProtectedTarget(message, targetId, {
        self: "Kendini uyaramazsın.",
        bot: "Beni uyaramazsın.",
        owner: "Bot sahibini uyaramam.",
      })
    )
      return;

    const target = await message.client.users.fetch(targetId).catch(() => null);
    if (!target) {
      await message.reply({ flags: COMPONENTS_V2_FLAG, components: [errorCard({ description: msg.err("Geçerli bir kullanıcı bulunamadı.") })], ...NO_PING  });
      return;
    }
    if (target.bot) {
      await message.reply({ flags: COMPONENTS_V2_FLAG, components: [errorCard({ description: msg.err("Botları uyaramazsın.") })], ...NO_PING  });
      return;
    }

    const targetMember = await message.guild.members.fetch(targetId).catch(() => null);
    if (targetMember && !(await checkHierarchy(message, targetMember))) return;

    // Uyarıyı kaydet (asıl "işlem" budur — hızlı, yerel DB).
    await db.insert(warningsTable).values({
      userId: target.id,
      guildId: message.guild.id,
      reason,
      moderatorId: message.author.id,
    });

    const [{ value: totalWarns }] = await db
      .select({ value: count() })
      .from(warningsTable)
      .where(and(eq(warningsTable.userId, target.id), eq(warningsTable.guildId, message.guild.id)));

    const caseId = generateCaseId();

    // Otomatik susturma eşiği (3. uyarıdan itibaren).
    const muteDurationMs = getMuteDurationMs(totalWarns);
    const muteLabel =
      muteDurationMs !== null ? `Otomatik susturma: ${formatHours(muteDurationMs)}` : undefined;

    // Önce kısa başarı mesajı kanala gider, SONRA otomatik ceza uygulanır.
    const extraLines: string[] = [`\`toplam:\` ${totalWarns} uyarı`];
    if (muteDurationMs !== null) extraLines.push(`\`süre:\` ${formatHours(muteDurationMs)} (otomatik)`);
    const successText = modSuccess({
      emoji: EMOJIS.warn,
      tag: target.tag,
      verb: "uyarıldı.",
      reason,
      extraLines,
    });
    await message.reply({ flags: COMPONENTS_V2_FLAG, components: textCard(successText), ...NO_PING  });

    if (muteDurationMs !== null && targetMember?.moderatable) {
      try {
        await targetMember.timeout(muteDurationMs, auditReason(caseId, "Otomatik", `${totalWarns}. uyarı`));
      } catch (err) {
        console.error("otomatik susturma işlemedi:", err);
      }
    }

    // DM bildirimi — en iyi çabayla, sessizce.
    const card = notifCard(`${totalWarns}. uyarını aldın`, target, reason, message.author.tag, muteLabel);
    await target.send({ flags: COMPONENTS_V2_FLAG, components: [card] }).catch(() => undefined);

    await sendModLog(
      message.guild,
      moderationEmbed({
        action: `${totalWarns}. Uyarı`,
        emoji: EMOJIS.warn,
        color: COLORS.warning,
        targetTag: `${target}`,
        targetId: target.id,
        targetAvatar: target.displayAvatarURL({ size: 256 }),
        moderatorTag: `${message.author}`,
        reason,
        caseId,
        extraFields: [
          { name: "📊 Toplam", value: warnBar(totalWarns), inline: true },
          ...(muteLabel ? [{ name: `${EMOJIS.timeout} Otomatik İşlem`, value: muteLabel, inline: true }] : []),
        ],
      }),
    );
  },
};


addSlash(command, [
  { name: "kullanici", description: "Uyarılacak kullanıcı", type: "user", required: true },
  { name: "sebep", description: "Uyarı sebebi", type: "string", required: true },
]);

export default command;
