import { errorCard, V2CardBuilder } from "../utils/componentsV2.js";
import { MessageFlags, type Message } from "discord.js";
import type { Command } from "../types.js";
import { COLORS } from "../utils/embeds.js";
import { EMOJIS } from "../utils/emojis.js";
import { getGuildPrefix, requireOwnerOrGuildOwner } from "../events/messageCreate.js";
import {
  getCustomEvent,
  updateCustomEventSettings,
  type CustomEventRestrictions,
} from "../customEvents/store.js";
import { parseChannelMention, parseMention } from "../utils/parse.js";
import { addSlash } from "../utils/slashBridge.js";

const PERMISSIONS = new Set(["ManageMessages", "ManageRoles", "ModerateMembers", "Administrator"]);

function targetId(raw: string | undefined, parser: (value: string) => string | null): string | null {
  return raw ? parser(raw) : null;
}

const command: Command = {
  name: "customevent-ayar",
  aliases: ["customevent-ayarla", "ce-ayar", "custom-ayar"],
  description: "Custom event'i açar/kapatır ve güvenli rol/kanal kısıtlarını düzenler",
  usage: "!customevent-ayar <isim> <işlem> [rol/kanal/izin]",
  category: "genel",

  async execute(message: Message, args: string[]) {
    if (!message.guild) {
      return message.reply({ flags: MessageFlags.IsComponentsV2, components: [errorCard({ description: `${EMOJIS.error} Bu komut sadece bir sunucu içinde kullanılabilir.` })] });
    }
    if (!(await requireOwnerOrGuildOwner(message))) return;

    const prefix = getGuildPrefix(message.guild.id);
    const name = args[0]?.toLowerCase().trim();
    const operation = args[1]?.toLocaleLowerCase("tr-TR");
    const event = name ? await getCustomEvent(message.guild.id, name) : null;

    if (!name || !operation || !event) {
      return message.reply({
      flags: MessageFlags.IsComponentsV2,
        components: [
          new V2CardBuilder()
            .setColor(COLORS.warning)
            .setTitle(`${EMOJIS.info} Custom event ayarı`)
            .setDescription(
              [
                `\`${prefix}customevent-ayar <isim> <işlem> [hedef]\``,
                "",
                "**İşlemler:**",
                "`aç` / `kapat` — event'i etkinleştirir veya durdurur",
                "`rol-ekle` / `rol-sil` — sadece bu rollerde çalıştırır",
                "`rol-yasakla` / `rol-yasak-kaldir` — bu rolleri engeller (deny önceliklidir)",
                "`kanal-ekle` / `kanal-sil` — sadece bu kanallarda çalıştırır",
                "`kanal-yasakla` / `kanal-yasak-kaldir` — kanalları engeller",
                "`izin <ManageMessages|ManageRoles|ModerateMembers|Administrator>` — kullanıcı izni ister",
                "`izin kaldır` — izin şartını kaldırır",
                "`durum` — mevcut kısıtları gösterir",
              ].join("\n"),
            ),
        ],
      });
    }

    const current = event.restrictions;
    const patch: Partial<CustomEventRestrictions> & { enabled?: boolean } = {};
    const id = args[2];

    switch (operation) {
      case "aç":
      case "ac":
        patch.enabled = true;
        break;
      case "kapat":
        patch.enabled = false;
        break;
      case "rol-ekle":
      case "rol-sil":
      case "rol-yasakla":
      case "rol-yasak-kaldir": {
        const roleId = targetId(id, parseMention);
        if (!roleId || !message.guild.roles.cache.has(roleId)) {
          return message.reply({ flags: MessageFlags.IsComponentsV2, components: [errorCard({ description: `${EMOJIS.error} Geçerli bir rol mention'ı veya rol ID'si vermelisin.` })] });
        }
        const isAllow = operation === "rol-ekle" || operation === "rol-sil";
        const field = isAllow ? "allowedRoleIds" : "deniedRoleIds";
        const values = new Set(current[field]);
        if (operation.endsWith("sil") || operation.endsWith("kaldir")) values.delete(roleId);
        else values.add(roleId);
        patch[field] = [...values];
        break;
      }
      case "kanal-ekle":
      case "kanal-sil":
      case "kanal-yasakla":
      case "kanal-yasak-kaldir": {
        const channelId = targetId(id, parseChannelMention);
        if (!channelId || !message.guild.channels.cache.has(channelId)) {
          return message.reply({ flags: MessageFlags.IsComponentsV2, components: [errorCard({ description: `${EMOJIS.error} Geçerli bir kanal mention'ı veya kanal ID'si vermelisin.` })] });
        }
        const isAllow = operation === "kanal-ekle" || operation === "kanal-sil";
        const field = isAllow ? "allowedChannelIds" : "deniedChannelIds";
        const values = new Set(current[field]);
        if (operation.endsWith("sil") || operation.endsWith("kaldir")) values.delete(channelId);
        else values.add(channelId);
        patch[field] = [...values];
        break;
      }
      case "izin": {
        const permission = id === "kaldır" || id === "kaldir" ? null : id;
        if (permission !== null && (!permission || !PERMISSIONS.has(permission))) {
          return message.reply({ flags: MessageFlags.IsComponentsV2, components: [errorCard({ description: `${EMOJIS.error} İzin şunlardan biri olmalı: ${[...PERMISSIONS].join(", ")}.` })] });
        }
        patch.requiredPermission = permission;
        break;
      }
      case "durum":
        return message.reply({
      flags: MessageFlags.IsComponentsV2,
          components: [
            new V2CardBuilder()
              .setColor(COLORS.info)
              .setTitle(`Custom event: ${event.name}`)
              .setDescription(
                [
                  `Durum: ${event.enabled ? "açık" : "kapalı"}`,
                  `Gerekli izin: ${current.requiredPermission ?? "yok"}`,
                  `İzin verilen roller: ${current.allowedRoleIds.length ? current.allowedRoleIds.map((value) => `<@&${value}>`).join(", ") : "hepsi"}`,
                  `Yasaklı roller: ${current.deniedRoleIds.length ? current.deniedRoleIds.map((value) => `<@&${value}>`).join(", ") : "yok"}`,
                  `İzin verilen kanallar: ${current.allowedChannelIds.length ? current.allowedChannelIds.map((value) => `<#${value}>`).join(", ") : "hepsi"}`,
                  `Yasaklı kanallar: ${current.deniedChannelIds.length ? current.deniedChannelIds.map((value) => `<#${value}>`).join(", ") : "yok"}`,
                ].join("\n"),
              ),
          ],
        });
      default:
        return message.reply({ flags: MessageFlags.IsComponentsV2, components: [errorCard({ description: `${EMOJIS.error} Bilinmeyen işlem. Yardım için \`${prefix}customevent-ayar\` yaz.` })] });
    }

    const updated = await updateCustomEventSettings(message.guild.id, event.name, patch);
    if (!updated) return message.reply({ flags: MessageFlags.IsComponentsV2, components: [errorCard({ description: `${EMOJIS.error} Custom event artık bulunamadı.` })] });
    return message.reply({
      flags: MessageFlags.IsComponentsV2,
      components: [
        new V2CardBuilder()
          .setColor(COLORS.success)
          .setTitle(`${EMOJIS.success} Ayar güncellendi`)
          .setDescription(`\`${event.name}\` custom event ayarı başarıyla güncellendi.`),
      ],
    });
  },
};


addSlash(command, [
  { name: "isim", description: "Olay ismi", type: "string", required: true },
  { name: "islem", description: "Yapılacak işlem", type: "string", required: true },
  { name: "deger", description: "Rol/kanal/izin değeri", type: "string" },
]);

export default command;