import { COMPONENTS_V2_FLAG, V2CardBuilder } from "../../utils/componentsV2.js";
import type { Message } from "discord.js";
import type { Command } from "../../types.js";
import { OWNER_ID } from "../../config.js";
import { buildGuardPanel, getGuardConfig, updateGuardConfig } from "../../utils/guard.js";
import { errorEmbed, successEmbed, infoEmbed } from "../../utils/embeds.js";
import { EMOJIS } from "../../utils/emojis.js";
import { markPermissionDenied } from "../../utils/notifyOwner.js";
import { registerPanelOwner } from "../../events/panelOwners.js";
import { addSlash } from "../../utils/slashBridge.js";

function canManageGuard(message: Message): boolean {
  return message.author.id === OWNER_ID || message.author.id === message.guild?.ownerId;
}

const command: Command = {
  name: "guard",
  aliases: ["koruma"],
  description: "Event tabanlı sunucu koruma (guard) sistemini yönetir",
  usage: "!guard [panel|aç|kapat|durum]",
  category: "mod",

  async execute(message: Message, args: string[]) {
    if (!message.guild) return;

    if (!canManageGuard(message)) {
      markPermissionDenied(message, "Sunucu sahibi/bot sahibi değil (guard)");
      return message.reply({
        flags: COMPONENTS_V2_FLAG,
        components: [
          errorEmbed(
            "Yetkin Yok",
            "Guard panelini yalnızca **sunucu sahibi** kullanabilir.",
          ),
        ],
      });
    }

    const sub = args[0]?.toLocaleLowerCase("tr-TR");

    if (!sub || sub === "panel") {
      const panel = await buildGuardPanel(message.guild.id);
      const sent = await message.reply({ ...panel, flags: COMPONENTS_V2_FLAG, components: [...((panel as any).embeds ?? []), ...((panel as any).components ?? [])] } as any);
      if (sent) registerPanelOwner(sent, message.author.id);
      return sent;
    }

    if (sub === "aç" || sub === "ac" || sub === "on" || sub === "enable") {
      await updateGuardConfig(message.guild.id, { enabled: true });
      return message.reply({
        flags: COMPONENTS_V2_FLAG,
        components: [
          successEmbed(
            "Guard Açıldı",
            "Koruma sistemi aktif. Modülleri `!guard panel` üzerinden yönetebilirsin.",
          ),
        ],
      });
    }

    if (sub === "kapat" || sub === "off" || sub === "disable") {
      await updateGuardConfig(message.guild.id, { enabled: false });
      return message.reply({
        flags: COMPONENTS_V2_FLAG,
        components: [successEmbed("Guard Kapatıldı", "Sunucu artık guard tarafından izlenmiyor.")],
      });
    }

    if (sub === "durum" || sub === "status") {
      const config = await getGuardConfig(message.guild.id);
      const flag = (v: boolean) => (v ? `${EMOJIS.success} Açık` : `${EMOJIS.error} Kapalı`);

      return message.reply({
        flags: COMPONENTS_V2_FLAG,
        components: [
          infoEmbed("Guard Durumu", undefined, {
            fields: [
              { name: `${EMOJIS.admin} Genel`, value: flag(config.enabled), inline: true },
              { name: `${EMOJIS.role} Rol Koruması`, value: flag(config.antiRoleDelete), inline: true },
              { name: `${EMOJIS.roly} Kanal Koruması`, value: flag(config.antiChannelDelete), inline: true },
              { name: `${EMOJIS.baba} Bot Koruması`, value: flag(config.antiBotAdd), inline: true },
              { name: `${EMOJIS.alert} Raid Koruması`, value: flag(config.antiRaid), inline: true },
              { name: `${EMOJIS.ban} Toplu Ban`, value: flag(config.antiMassBan), inline: true },
              { name: `${EMOJIS.kick} Toplu Kick`, value: flag(config.antiMassKick), inline: true },
              { name: `${EMOJIS.general} Yetki Koruması`, value: flag(config.antiPermissionEscalation), inline: true },
            ],
          }),
        ],
      });
    }

    return message.reply({
      flags: COMPONENTS_V2_FLAG,
      components: [
        errorEmbed(
          "Kullanım",
          "`!guard panel` — interaktif panel\n`!guard aç` / `!guard kapat`\n`!guard durum`",
        ),
      ],
    });
  },
};


addSlash(command, [
  { name: "islem", description: "Yapılacak işlem", type: "string", required: true, choices: [{ name: "Paneli aç", value: "panel" }, { name: "Guard'ı aç", value: "ac" }, { name: "Guard'ı kapat", value: "kapat" }, { name: "Durumu göster", value: "durum" }] },
]);

export default command;
