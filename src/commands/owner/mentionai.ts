import { COMPONENTS_V2_FLAG, errorCard, textCard, V2CardBuilder } from "../../utils/componentsV2.js";
import type { Message } from "discord.js";
import { PermissionFlagsBits } from "discord.js";
import type { Command } from "../../types.js";
import {
  requireOwner,
  getGuildPrefix,
  OWNER_ID,
} from "../../events/messageCreate.js";
import {
  getMentionAiModel,
  setMentionAiModel,
  getMentionAiRules,
  addMentionAiRule,
  removeMentionAiRule,
  isMentionAiEnabled,
  setMentionAiEnabled,
  getMentionAiChannel,
  setMentionAiChannel,
  ensureMentionAiLoaded,
} from "../../utils/mentionai.js";
import { EMOJIS } from "../../utils/emojis.js";
import { usageEmbed } from "../../utils/messages.js";

/** Owner, half-owner veya sunucu Administrator. */
async function requireMentionAiAdmin(message: Message): Promise<boolean> {
  if (message.author.id === OWNER_ID) return true;
  const { ensureHalfOwnersLoaded, isHalfOwner } = await import(
    "../../premium/halfOwners.js"
  );
  await ensureHalfOwnersLoaded();
  if (isHalfOwner(message.author.id)) return true;
  if (message.member?.permissions.has(PermissionFlagsBits.Administrator))
    return true;
  await message
    .reply(
      { flags: COMPONENTS_V2_FLAG, components: [errorCard({ description: `${EMOJIS.error} Bu komutu yalnızca bot sahibi, half-owner veya **Yönetici (Administrator)** yetkisine sahip üyeler kullanabilir.` })] })
    .catch(() => null);
  return false;
}

/**
 * Türkçe karakterleri ASCII'ye indirger: aç→ac, ğ→g.
 * Unicode farklarından kaynaklı eşleşme hatalarını önler.
 */
function normalizeAction(raw: string | undefined): string {
  if (!raw) return "";
  return raw
    .toLocaleLowerCase("tr-TR")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/ı/g, "i")
    .replace(/ç/g, "c")
    .replace(/ş/g, "s")
    .replace(/ğ/g, "g")
    .replace(/ü/g, "u")
    .replace(/ö/g, "o")
    .trim();
}

const command: Command = {
  name: "mentionai",
  aliases: [],
  description:
    "MentionAI aç/kapat, kanal kısıtı, model ve kurallar (admin / owner)",
  usage:
    "!mentionai aç|kapat | kanal #kanal | model pix:model\n| gemini:model | openrouter:model | kural-ekle <kural> | kural-sil <kural>",
  category: "owner",

  async execute(message: Message, args: string[]) {
    if (!message.guild)
      return message.reply(
        { flags: COMPONENTS_V2_FLAG, components: [errorCard({ description: `${EMOJIS.error} Bu komut yalnızca sunucularda kullanılabilir.` })] });

    await ensureMentionAiLoaded();
    const action = normalizeAction(args[0]);
    const prefix = getGuildPrefix(message.guild.id);

    if (action === "kural-ekle" || action === "kuralekle") {
      if (!(await requireOwner(message))) return;
      const rule = args.slice(1).join(" ").trim();
      if (!rule)
        return message.reply({ flags: COMPONENTS_V2_FLAG, components: [usageEmbed(
          `Kullanım: \`${prefix}mentionai kural-ekle <kural>\``,
        )] });
      const rules = await addMentionAiRule(rule);
      return message.reply(
        { flags: COMPONENTS_V2_FLAG, components: textCard(`${EMOJIS.success} MentionAI sistem promptuna kural eklendi. Aktif özel kural sayısı: **${rules.length}**`,) });
    }
    if (action === "kural-sil" || action === "kuralsil") {
      if (!(await requireOwner(message))) return;
      const rule = args.slice(1).join(" ").trim();
      if (!rule)
        return message.reply({ flags: COMPONENTS_V2_FLAG, components: [usageEmbed(
          `Kullanım: \`${prefix}mentionai kural-sil <kural>\``,
        )] });
      const result = await removeMentionAiRule(rule);
      return message.reply(
        { flags: COMPONENTS_V2_FLAG, components: [errorCard({ description: result.removed
          ? `${EMOJIS.success} MentionAI sistem promptundaki kural silindi. Kalan özel kural sayısı: **${result.rules.length}**`
          : `${EMOJIS.error} Bu kural sistem promptunda bulunamadı. Silme işlemi için kuralı metin olarak aynı yazmalısın.` })] });
    }
    if (action === "model") {
      if (!(await requireOwner(message))) return;
      const selectedModel = args.slice(1).join(" ").trim();
      if (selectedModel) {
        try {
          await setMentionAiModel(selectedModel);
        } catch (error) {
          return message.reply(
            { flags: COMPONENTS_V2_FLAG, components: [errorCard({ description: `${EMOJIS.error} ${error instanceof Error ? error.message : String(error)}` })] });
        }
        return message.reply(
          { flags: COMPONENTS_V2_FLAG, components: textCard(`${EMOJIS.success} MentionAI modeli **${getMentionAiModel()}** olarak ayarlandı.`,) });
      }
      return message.reply(
        { flags: COMPONENTS_V2_FLAG, components: textCard([
          "MentionAI'nin kendine özel sohbet modeli:",
          "Aktif model: **" + getMentionAiModel() + "**",
          "Değiştirmek için:",
          `\`${prefix}mentionai model pix:model\``,
          `\`${prefix}mentionai model gemini:model\``,
          `\`${prefix}mentionai model openrouter:model\``,
        ].join("\n"),) });
    }

    // aç / kapat / kanal → yönetici (Administrator) + owner/half-owner
    // normalizeAction: aç→ac, kapat→kapat, kanal→kanal
    if (
      action === "ac" ||
      action === "kapat" ||
      action === "kapa" ||
      action === "kanal" ||
      action === "channel"
    ) {
      if (!(await requireMentionAiAdmin(message))) return;

      if (action === "kanal" || action === "channel") {
        const mentioned =
          message.mentions.channels.first() ??
          (args[1] &&
            message.guild.channels.cache.get(
              args[1].replace(/[<#>]/g, ""),
            ));
        const channelId =
          mentioned && "id" in mentioned
            ? mentioned.id
            : args[1]?.replace(/[<#>]/g, "") &&
                /^\d{15,25}$/.test(args[1].replace(/[<#>]/g, ""))
              ? args[1].replace(/[<#>]/g, "")
              : null;

        if (!channelId && !args[1]) {
          const current = getMentionAiChannel(message.guild.id);
          return message.reply(
            { flags: COMPONENTS_V2_FLAG, components: textCard(current
              ? `MentionAI şu an yalnızca <#${current}> kanalında çalışıyor.\nKapatmak için: \`${prefix}mentionai kanal <#${current}>\` (aynı kanalı tekrar ver = toggle)\nTüm kanallara açmak için de aynı komutu kullanabilirsin.`
              : `MentionAI kanal kısıtı **yok** (tüm kanallar).\nBelirli bir kanala kilitlemek: \`${prefix}mentionai kanal #kanal\``,) });
        }

        if (!channelId) {
          return message.reply({ flags: COMPONENTS_V2_FLAG, components: [usageEmbed(
            `Kullanım: \`${prefix}mentionai kanal #kanal\` — toggle (aynı kanalı tekrar verirsen kısıt kalkar)`,
          )] });
        }

        const channel = message.guild.channels.cache.get(channelId);
        if (!channel || !channel.isTextBased()) {
          return message.reply(
            { flags: COMPONENTS_V2_FLAG, components: [errorCard({ description: `${EMOJIS.error} Geçerli bir metin kanalı belirtmelisin.` })] });
        }

        const result = await setMentionAiChannel(message.guild.id, channelId);
        if (result.toggledOff || !result.channelId) {
          return message.reply(
            { flags: COMPONENTS_V2_FLAG, components: textCard(`${EMOJIS.success} MentionAI kanal kısıtı kaldırıldı. Artık sunucuda MentionAI açıksa **tüm kanallarda** yanıt verebilir.`,) });
        }
        return message.reply(
          { flags: COMPONENTS_V2_FLAG, components: textCard(`${EMOJIS.success} MentionAI artık yalnızca <#${result.channelId}> kanalında çalışacak. Diğer kanallarda mention/reply istekleri **gönderilmeyecek**.`,) });
      }

      const enabled = action === "ac";
      await setMentionAiEnabled(message.guild.id, enabled);
      const channelNote = (() => {
        const ch = getMentionAiChannel(message.guild!.id);
        return ch ? ` (yalnızca <#${ch}>)` : "";
      })();
      return message.reply(
        { flags: COMPONENTS_V2_FLAG, components: textCard(enabled
          ? `${EMOJIS.success} MentionAI bu sunucuda açıldı${channelNote}. Kullanıcılar beni etiketleyerek veya bot mesajına reply vererek konuşabilir.`
          : `${EMOJIS.success} MentionAI bu sunucuda kapatıldı.`,) });
    }

    // Durum / yardım
    if (!(await requireMentionAiAdmin(message))) return;
    const status = isMentionAiEnabled(message.guild.id) ? "açık" : "kapalı";
    const channel = getMentionAiChannel(message.guild.id);
    return message.reply({ flags: COMPONENTS_V2_FLAG, components: [usageEmbed(
      [
        `Kullanım:`,
        `\`${prefix}mentionai aç|kapat\` — aç/kapat *(yönetici / owner / half-owner)*`,
        `\`${prefix}mentionai kanal #kanal\` — yalnızca o kanalda çalışsın (toggle)`,
        `\`${prefix}mentionai model pix:model|gemini:model|openrouter:model\` — MentionAI sohbet modeli *(sadece owner)*`,
        `\`${prefix}mentionai kural-ekle|kural-sil <kural>\` — sistem kuralı *(sadece owner)*`,
        ``,
        `Şu anki durum: **${status}**`,
        `Sohbet modeli: **${getMentionAiModel()}**`,
        `Kanal kısıtı: **${channel ? `<#${channel}>` : "yok (tüm kanallar)"}**`,
        `Özel kural sayısı: **${(await getMentionAiRules()).length}**`,
      ].join("\n"),
    )] });
  },
};

export default command;
