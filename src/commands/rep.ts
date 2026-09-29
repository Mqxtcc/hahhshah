import { MessageFlags } from "discord.js";
import type { Message, User } from "discord.js";
import type { Command } from "../types.js";
import { infoEmbed, errorEmbed } from "../utils/embeds.js";
import { getRep, giveRep, REP_COOLDOWN_MS } from "../rep/store.js";
import { addSlash } from "../utils/slashBridge.js";

function formatWait(ms: number): string {
  const h = Math.floor(ms / 3_600_000);
  const m = Math.ceil((ms % 3_600_000) / 60_000);
  if (h > 0) return `${h} saat ${m} dakika`;
  return `${m} dakika`;
}

const command: Command = {
  name: "rep",
  aliases: ["itibar", "reputation", "+rep"],
  description: "Birine itibar puanı verirsin (24 saatte bir)",
  usage: "!rep <@kullanıcı>  →  !rep ile kendi puanını görürsün",
  category: "genel",

  async execute(message: Message) {
    const target: User | undefined = message.mentions.users.first();

    // Argümansız: kendi puanın
    if (!target) {
      const score = await getRep(message.author.id).catch(() => 0);
      return message.reply({
      flags: MessageFlags.IsComponentsV2,
        components: [infoEmbed("⭐ İtibarın", `${message.author}, itibar puanın: **${score}** ⭐`)],
      });
    }

    if (target.id === message.author.id) {
      return message.reply({
      flags: MessageFlags.IsComponentsV2, components: [errorEmbed("Olmaz", "Kendine itibar veremezsin 😏")] });
    }
    if (target.bot) {
      return message.reply({
      flags: MessageFlags.IsComponentsV2, components: [errorEmbed("Olmaz", "Botların itibara ihtiyacı yok 🤖")] });
    }

    const res = await giveRep(message.author.id, target.id).catch(() => null);
    if (!res) {
      return message.reply({
      flags: MessageFlags.IsComponentsV2, components: [errorEmbed("Hata", "Şu an veremedim, bir daha dene.")] });
    }
    if (!res.ok) {
      return message.reply({
      flags: MessageFlags.IsComponentsV2,
        components: [
          errorEmbed(
            "Bekle Biraz",
            `24 saatte bir itibar verebilirsin. Kalan süre: **${formatWait(res.waitMs ?? REP_COOLDOWN_MS)}** ⏳`,
          ),
        ],
      });
    }
    return message.reply({
      flags: MessageFlags.IsComponentsV2,
      components: [
        infoEmbed(
          "⭐ İtibar Verildi",
          `${message.author}, ${target} kullanıcısına **+1** itibar verdi!\n\n${target} artık **${res.score}** ⭐ puana sahip.`,
        ),
      ],
    });
  },
};

addSlash(
  command,
  [{ name: "kullanici", description: "İtibar verilecek kişi (boşsa kendi puanın)", type: "user", required: false }],
  (v) => (v.userMention("kullanici") ? [v.userMention("kullanici") as string] : []),
);

export default command;
