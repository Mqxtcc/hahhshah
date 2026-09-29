import { COMPONENTS_V2_FLAG, V2CardBuilder } from "../../utils/componentsV2.js";
import type { Message } from "discord.js";
import type { Command } from "../../types.js";
import { requireOwnerOrHalfOwner, resolveTargetUserId, getGuildPrefix } from "../../events/messageCreate.js";
import { revokePremium } from "../../premium/store.js";
import { warningEmbed, infoEmbed } from "../../utils/embeds.js";

// Owner VEYA half-owner kullanabilir (bkz. !halfowner) — vermenin simetriği,
// kalıcı bir hasara yol açmaz (owner istediği zaman tekrar !premium ile verir).
const command: Command = {
  name: "premium-kaldir",
  aliases: ["premiumkaldir", "premium-al", "unpremium"],
  description: "Kullanıcının premium üyeliğini geri alır (owner ve half-owner kullanabilir)",
  usage: "!premium-kaldir <@kullanıcı>",
  category: "owner",

  async execute(message: Message, args: string[]) {
    if (!(await requireOwnerOrHalfOwner(message))) return;

    const targetId = resolveTargetUserId(message, args);
    if (!targetId) {
      const prefix = getGuildPrefix(message.guild?.id);
      await message
        .reply({ flags: COMPONENTS_V2_FLAG, components: [warningEmbed("Eksik kullanım", `Kullanım: \`${prefix}premium-kaldir @kullanıcı\``)] })
        .catch(() => null);
      return;
    }

    const revoked = await revokePremium(targetId);
    if (!revoked) {
      await message
        .reply({ flags: COMPONENTS_V2_FLAG, components: [warningEmbed("Zaten premium değil", `<@${targetId}> zaten premium üye değil.`)] })
        .catch(() => null);
      return;
    }

    await message
      .reply({ flags: COMPONENTS_V2_FLAG, components: [infoEmbed("Premium Üyelik Kaldırıldı", `<@${targetId}> kişisinin premium üyeliği geri alındı.`)] })
      .catch(() => null);
  },
};

export default command;
