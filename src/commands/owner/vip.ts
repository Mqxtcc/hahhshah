import { COMPONENTS_V2_FLAG, V2CardBuilder } from "../../utils/componentsV2.js";
import type { Message } from "discord.js";
import type { Command } from "../../types.js";
import {
  resolveTargetUserId,
  toggleVipById,
  getGuildPrefix,
  OWNER_ID,
} from "../../events/messageCreate.js";
import { warningEmbed, premiumEmbed, infoEmbed } from "../../utils/embeds.js";
import { ensureHalfOwnersLoaded, isHalfOwner } from "../../premium/halfOwners.js";
import { addSlash } from "../../utils/slashBridge.js";

// Owner, half-owner VEYA sunucu sahibi kullanabilir.
// VIP rozeti tehlikeli bir yan etkisi olmayan, toggle'lanabilir bir özellik.
const command: Command = {
  name: "özelüye",
  aliases: ["ozelüye", "özelue", "ozelue"],
  description:
    "Kullanıcıya özel üye (VIP) rozeti verir/alır (bot sahibi, half-owner ve sunucu sahibi)",
  usage: "!özelüye <@kullanıcı>",
  category: "admin",

  async execute(message: Message, args: string[]) {
    await ensureHalfOwnersLoaded();

    // Owner / half-owner / guild owner
    const isBotOwner = message.author.id === OWNER_ID;
    const isGuildOwner =
      !!message.guild && message.guild.ownerId === message.author.id;
    const half = isHalfOwner(message.author.id);

    if (!isBotOwner && !isGuildOwner && !half) {
      await message
        .reply({
          flags: COMPONENTS_V2_FLAG,
          components: [
            warningEmbed(
              "Yetki yok",
              "Bu komutu sadece bot sahibi, half-owner'lar ve sunucu sahibi kullanabilir.",
            ),
          ],
        })
        .catch(() => null);
      return;
    }

    const targetId = resolveTargetUserId(message, args);
    if (!targetId) {
      const prefix = getGuildPrefix(message.guild?.id);
      await message
        .reply({
          flags: COMPONENTS_V2_FLAG,
          components: [
            warningEmbed(
              "Eksik kullanım",
              `Kullanım: \`${prefix}özelüye @kullanıcı\``,
            ),
          ],
        })
        .catch(() => null);
      return;
    }

    const isNowVip = await toggleVipById(targetId);
    if (!isNowVip) {
      await message
        .reply({
          flags: COMPONENTS_V2_FLAG,
          components: [
            infoEmbed(
              "Özel üyelik kaldırıldı",
              `<@${targetId}> kişisinin özel üyeliği geri çekildi.`,
            ),
          ],
        })
        .catch(() => null);
    } else {
      await message
        .reply({
          flags: COMPONENTS_V2_FLAG,
          components: [
            premiumEmbed(
              "Özel Üyelik Verildi",
              `<@${targetId}> artık **özel üye**! Sunucularda özel karşılama ve rozet ile öne çıkar.`,
            ),
          ],
        })
        .catch(() => null);
    }
  },
};


addSlash(command, [
  { name: "kullanici", description: "Özel üye yapılacak kullanıcı", type: "user", required: true },
]);

export default command;
