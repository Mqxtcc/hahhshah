import { COMPONENTS_V2_FLAG, errorCard, V2CardBuilder } from "../../utils/componentsV2.js";
import type { Message } from "discord.js";
import { PermissionFlagsBits } from "discord.js";
import type { Command } from "../../types.js";
import { db } from "../../db/index.js";
import { userPermissionsTable } from "../../db/schema.js";
import { eq, and } from "../../db/jsonOrm.js";
import { EMOJIS } from "../../utils/emojis.js";
import { invalidatePermissionCache } from "../../utils/permissions.js";
import { OWNER_ID } from "../../config.js";
import { markPermissionDenied } from "../../utils/notifyOwner.js";
import { COLORS, errorEmbed, successEmbed } from "../../utils/embeds.js";
import { addSlash } from "../../utils/slashBridge.js";

const PERMISSIONS = [
  "ban",
  "kick",
  "mute",
  "unmute",
  "unban",
  "warn",
  "uyarilar",
  "say",
  "duyuru",
] as const;

type PermName = (typeof PERMISSIONS)[number];

function isValidPerm(p: string): p is PermName {
  return (PERMISSIONS as readonly string[]).includes(p);
}

const command: Command = {
  name: "izin",
  aliases: ["permit", "yetki"],
  description: "Kullanıcı veya role özel moderasyon yetkisi verir / yönetir",
  usage: "!izin <yetki> <@kullanıcı|@rol>  |  !izin list  |  !izin remove <yetki> <@hedef>",
  category: "mod",

  async execute(message: Message, args: string[]) {
    if (!message.guild || !message.member) return;

    if (
      message.author.id !== OWNER_ID &&
      !message.member.permissions.has(PermissionFlagsBits.Administrator)
    ) {
      markPermissionDenied(message, "Yönetici (Administrator) yetkisi yok (izin)");
      return message.reply({
        flags: COMPONENTS_V2_FLAG,
        components: [errorEmbed("Yetkin Yok", "Bu komutu yalnızca **Yönetici** kullanabilir.")],
      });
    }

    const sub = args[0]?.toLocaleLowerCase("tr-TR");

    // ─── list ───────────────────────────────────────────────
    if (sub === "list" || sub === "liste") {
      const perms = await db
        .select()
        .from(userPermissionsTable)
        .where(eq(userPermissionsTable.guildId, message.guild.id));

      if (perms.length === 0) {
        return message.reply({ flags: COMPONENTS_V2_FLAG, components: [errorEmbed("Boş", "Bu sunucuda özel yetki kaydı yok.")] });
      }

      const grouped: Record<string, string[]> = {};
      for (const p of perms) {
        if (!grouped[p.permission]) grouped[p.permission] = [];
        const label = p.targetType === "user" ? `<@${p.targetId}>` : `<@&${p.targetId}>`;
        grouped[p.permission].push(label);
      }

      const desc = Object.entries(grouped)
        .map(([perm, targets]) => `**${perm}:** ${targets.join(", ")}`)
        .join("\n");

      const embed = new V2CardBuilder()
        .setColor(COLORS.info)
        .setTitle(`${EMOJIS.info} Yetki Listesi`)
        .setDescription(desc)
        .setTimestamp();

      return message.reply({ flags: COMPONENTS_V2_FLAG, components: [embed] });
    }

    // ─── remove ─────────────────────────────────────────────
    if (sub === "remove" || sub === "kaldir" || sub === "kaldır") {
      const permission = args[1]?.toLowerCase();
      const targetRaw = args[2];
      if (!permission || !targetRaw || !isValidPerm(permission)) {
        return message.reply({
          flags: COMPONENTS_V2_FLAG,
          components: [
            errorEmbed(
              "Kullanım",
              "`!izin remove <yetki> <@kullanıcı|@rol>`\nYetkiler: " + PERMISSIONS.map((p) => `\`${p}\``).join(", "),
            ),
          ],
        });
      }

      const targetId = targetRaw.replace(/[<@!&>]/g, "");
      const targetType = targetRaw.includes("&") ? "role" : "user";

      await db
        .delete(userPermissionsTable)
        .where(
          and(
            eq(userPermissionsTable.guildId, message.guild.id),
            eq(userPermissionsTable.targetId, targetId),
            eq(userPermissionsTable.targetType, targetType),
            eq(userPermissionsTable.permission, permission),
          ),
        );

      invalidatePermissionCache(message.guild.id, permission);
      return message.reply({
        flags: COMPONENTS_V2_FLAG,
        components: [successEmbed("Yetki Kaldırıldı", `**${permission}** yetkisi ${targetRaw} hedefini kaldırıldı.`)],
      });
    }

    // ─── resetall ───────────────────────────────────────────
    if (sub === "resetall") {
      if (args[1]?.toLowerCase() !== "onayla") {
        return message.reply(
          { flags: COMPONENTS_V2_FLAG, components: [errorCard({ description: `${EMOJIS.alert} Bu sunucudaki **tüm** özel izinleri kalıcı siler.\nOnaylamak için: \`!izin resetall onayla\`` })] });
      }

      const deleted = await db
        .delete(userPermissionsTable)
        .where(eq(userPermissionsTable.guildId, message.guild.id))
        .returning();

      invalidatePermissionCache(message.guild.id);
      return message.reply({
        flags: COMPONENTS_V2_FLAG,
        components: [successEmbed("Temizlendi", `${deleted.length} izin kaydı silindi.`)],
      });
    }

    // ─── grant ──────────────────────────────────────────────
    if (!sub || !isValidPerm(sub)) {
      const embed = new V2CardBuilder()
        .setColor(COLORS.error)
        .setTitle(`${EMOJIS.error} Kullanım`)
        .setDescription(
          [
            "`!izin <yetki> <@kullanıcı|@rol>` — yetki ver",
            "`!izin list` — mevcut yetkileri listele",
            "`!izin remove <yetki> <@hedef>` — yetkiyi geri al",
            "`!izin resetall onayla` — tüm izinleri sil",
            "",
            "**Yetkiler:**",
            PERMISSIONS.map((p) => `• \`${p}\``).join("\n"),
          ].join("\n"),
        )
        .addFields({
          name: "Örnek",
          value: "`!izin ban @Moderatör`\n`!izin mute @&Mod`",
        })
        .setTimestamp();
      return message.reply({ flags: COMPONENTS_V2_FLAG, components: [embed] });
    }

    const permission = sub;
    const targetRaw = args[1];
    if (!targetRaw) {
      return message.reply({
        flags: COMPONENTS_V2_FLAG,
        components: [errorEmbed("Eksik Hedef", `Kullanım: \`!izin ${permission} <@kullanıcı|@rol>\``)],
      });
    }

    const targetId = targetRaw.replace(/[<@!&>]/g, "");
    const targetType = targetRaw.includes("&") ? "role" : "user";

    if (!/^\d{15,20}$/.test(targetId)) {
      return message.reply({ flags: COMPONENTS_V2_FLAG, components: [errorEmbed("Geçersiz Hedef", "Geçerli bir kullanıcı veya rol etiketle.")] });
    }

    await db
      .insert(userPermissionsTable)
      .values({
        guildId: message.guild.id,
        targetId,
        targetType,
        permission,
        grantedBy: message.author.id,
      })
      .onConflictDoNothing();

    invalidatePermissionCache(message.guild.id, permission);
    return message.reply({
      flags: COMPONENTS_V2_FLAG,
      components: [successEmbed("Yetki Verildi", `${targetRaw} hedefine **${permission}** yetkisi verildi.`)],
    });
  },
};


addSlash(command, [
  { name: "islem", description: "Yapılacak işlem", type: "string", required: true, choices: [{ name: "Yetki ver", value: "ver" }, { name: "Yetkileri listele", value: "liste" }, { name: "Yetki kaldır", value: "kaldir" }] },
  { name: "yetki", description: "Yetki adı: ban, kick, timeout, warn, clear, duyuru, say", type: "string" },
  { name: "hedef", description: "Kullanıcı veya rol", type: "mentionable" },
],
  (v) => {
    const islem = v.str("islem") ?? "liste";
    if (islem === "liste") return ["list"];
    const hedef = v.mentionableMention("hedef") ?? "";
    const yetki = v.str("yetki") ?? "";
    if (islem === "kaldir") return ["remove", yetki, hedef].filter(Boolean);
    return [yetki, hedef].filter(Boolean);
  }
);
export default command;
