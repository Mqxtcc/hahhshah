import { errorCard, textCard } from "../utils/componentsV2.js";
import { MessageFlags } from "discord.js";
import type { Message } from "discord.js";
import type { Command } from "../types.js";
import { EMOJIS } from "../utils/emojis.js";
import { getGuildPrefix, requireOwnerOrGuildOwnerOrAdmin } from "../events/messageCreate.js";
import {
  DEFAULT_DURATION_MINUTES,
  getWelcomeBackSettings,
  setWelcomeBackDuration,
  setWelcomeBackEnabled,
} from "../welcomeback/store.js";
import { formatDuration } from "../utils/parse.js";
import { addSlash } from "../utils/slashBridge.js";
import { usageEmbed } from "../utils/messages.js";

const command: Command = {
  name: "tekrarhoşgeldin",
  aliases: ["tekrarhosgeldin"],
  description: "Uzun süre sessiz kalan kullanıcılar tekrar yazınca karşılama mesajı gönderir",
  usage: "!tekrarhoşgeldin <aç|kapat|süre> [dakika]",
  category: "genel",

  async execute(message: Message, args: string[]) {
    if (!message.guild) {
      return message.reply({ flags: MessageFlags.IsComponentsV2, components: [errorCard({ description: `${EMOJIS.error} Bu komut sadece bir sunucu içinde kullanılabilir.` })] });
    }
    if (!(await requireOwnerOrGuildOwnerOrAdmin(message))) return;

    const guildId = message.guild.id;
    const prefix = getGuildPrefix(guildId);
    const sub = args[0]?.toLocaleLowerCase("tr-TR");

    if (!sub) {
      const current = getWelcomeBackSettings(guildId);
      return message.reply({ flags: MessageFlags.IsComponentsV2, components: [errorCard({ description: [
          `${EMOJIS.info} **Tekrar hoşgeldin sistemi** — durum: ${current.enabled ? `açık ${EMOJIS.success}` : `kapalı ${EMOJIS.error}`}, süre: **${formatDuration(current.durationMinutes)}**`,
          "",
          `\`${prefix}tekrarhoşgeldin aç\` — sistemi açar`,
          `\`${prefix}tekrarhoşgeldin kapat\` — sistemi kapatır`,
          `\`${prefix}tekrarhoşgeldin süre <dakika>\` — sessizlik süresini ayarlar (varsayılan: ${DEFAULT_DURATION_MINUTES} dakika)`,
        ].join("\n") })] });
    }

    if (sub === "aç" || sub === "ac") {
      const updated = await setWelcomeBackEnabled(guildId, true);
      return message.reply({ flags: MessageFlags.IsComponentsV2, components: textCard(`${EMOJIS.success} Tekrar hoşgeldin sistemi açıldı. Şu an ayarlı süre: **${formatDuration(updated.durationMinutes)}**.`,) });
    }

    if (sub === "kapat") {
      await setWelcomeBackEnabled(guildId, false);
      return message.reply({ flags: MessageFlags.IsComponentsV2, components: textCard(`${EMOJIS.success} Tekrar hoşgeldin sistemi kapatıldı.`) });
    }

    if (sub === "süre" || sub === "sure") {
      const raw = args[1];
      const minutes = raw ? Number.parseInt(raw, 10) : NaN;
      if (!raw || !Number.isInteger(minutes) || minutes <= 0 || minutes > 43_200) {
        return message.reply({
      flags: MessageFlags.IsComponentsV2, components: [usageEmbed(
          `${EMOJIS.usage} Kullanım: \`${prefix}tekrarhoşgeldin süre <dakika>\` (ör. \`${prefix}tekrarhoşgeldin süre 120\`, en fazla 43200 dakika/30 gün).`,
        )] });
      }
      const updated = await setWelcomeBackDuration(guildId, minutes);
      return message.reply({ flags: MessageFlags.IsComponentsV2, components: textCard(`${EMOJIS.success} Tekrar hoşgeldin süresi **${formatDuration(updated.durationMinutes)}** olarak ayarlandı.`,) });
    }

    return message.reply({
      flags: MessageFlags.IsComponentsV2,
      components: [
        usageEmbed(
          `${EMOJIS.error} Bilinmeyen işlem. Kullanım: \`${prefix}tekrarhoşgeldin <aç|kapat|süre> [dakika]\``,
        ),
      ],
    });
  },
};


addSlash(command, [
  { name: "islem", description: "Yapılacak işlem", type: "string", required: true, choices: [{ name: "Aç", value: "ac" }, { name: "Kapat", value: "kapat" }, { name: "Süre ayarla", value: "sure" }] },
  { name: "dakika", description: "Tekrar hoşgeldin süresi (dakika)", type: "integer", minValue: 1 },
],
  (v) => {
    const islem = v.str("islem") ?? "ac";
    if (islem === "sure") { const d = v.int("dakika"); return d ? ["süre", String(d)] : ["süre"]; }
    return [islem === "kapat" ? "kapat" : "aç"];
  }
);
export default command;
