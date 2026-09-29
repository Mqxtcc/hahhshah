import { COMPONENTS_V2_FLAG, V2CardBuilder } from "../../utils/componentsV2.js";
import type { Message } from "discord.js";
import type { Command } from "../../types.js";
import { requireOwnerOrHalfOwner, resolveTargetUserId, getGuildPrefix } from "../../events/messageCreate.js";
import { grantPremium } from "../../premium/store.js";
import { warningEmbed, premiumEmbed } from "../../utils/embeds.js";

// Premium bu komutla, bot sahibi VEYA yetkilendirilmiş bir half-owner
// tarafından verilebilir (bkz. !halfowner, requireOwnerOrHalfOwner).
// Kalıcıdır (süresi yok) — geri almak için ayrı, owner-only komut:
// !premium-kaldir (half-owner'lar premium GERİ ALAMAZ, sadece verebilir).
const command: Command = {
  name: "premium",
  aliases: [],
  description: "Kullanıcıya kalıcı premium üyelik verir (owner ve half-owner kullanabilir)",
  usage: "!premium <@kullanıcı>",
  category: "owner",

  async execute(message: Message, args: string[]) {
    if (!(await requireOwnerOrHalfOwner(message))) return;

    const targetId = resolveTargetUserId(message, args);
    if (!targetId) {
      const prefix = getGuildPrefix(message.guild?.id);
      await message
        .reply({ flags: COMPONENTS_V2_FLAG, components: [warningEmbed("Eksik kullanım", `Kullanım: \`${prefix}premium @kullanıcı\``)] })
        .catch(() => null);
      return;
    }

    const granted = await grantPremium(targetId, message.author.id);
    if (!granted) {
      await message
        .reply({ flags: COMPONENTS_V2_FLAG, components: [warningEmbed("Zaten premium", `<@${targetId}> zaten premium üye.`)] })
        .catch(() => null);
      return;
    }

    await message
      .reply({
        flags: COMPONENTS_V2_FLAG,
        components: [
          premiumEmbed(
            "Premium Üyelik Verildi",
            `<@${targetId}> artık **kalıcı premium üye**! Tüm premium komutları sınırsız kullanabilir.`,
            {
              fields: [
                { name: "👤 Üye", value: `<@${targetId}>`, inline: true },
                { name: "⏳ Süre", value: "Kalıcı", inline: true },
                { name: "🎁 Veren", value: `${message.author}`, inline: true },
              ],
            },
          ),
        ],
      })
      .catch(() => null);
  },
};

export default command;
