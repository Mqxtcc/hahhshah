import { V2CardBuilder, errorCard, textCard } from "../../utils/componentsV2.js";
import { MessageFlags, type Message } from "discord.js";
import type { Command } from "../../types.js";
import { DEFAULT_PREFIX } from "../../config.js";
import { getGuildPrefix } from "../../events/messageCreate.js";
import { COLORS } from "../../utils/embeds.js";
import { generateWithGemini } from "../../utils/gemini.js";
import { requirePremiumOrTrial, consumeTrialUse } from "../../premium/gate.js";
import { EMOJIS } from "../../utils/emojis.js";
import { addSlash } from "../../utils/slashBridge.js";
import { usageEmbed } from "../../utils/messages.js";

// !ozetle <metin>            -> verilen metni özetler
// (bir mesaja yanıt vererek) !ozetle  -> yanıtlanan mesajı özetler

const MAX_INPUT_CHARS = 12_000;

const SYSTEM_PROMPT = `Sen bir metin özetleme uzmanısın. Sana verilen metni Türkçe olarak özetleyeceksin.

KURALLAR:
- Cevabını Türkçe yaz.
- Metnin ana fikrini ve önemli noktalarını kısa madde işaretleriyle ver.
- Gereksiz detayları atla, uydurma bilgi ekleme.
- Metin zaten çok kısaysa "Özetlenecek kadar uzun değil" de ve metni tek cümlede özetle.
- Toplam cevap 1500 karakteri geçmesin.`;

const command: Command = {
  name: "ozetle",
  aliases: ["özetle", "summarize"],
  description: "AI ile verilen metni veya yanıtlanan mesajı özetler",
  usage: `${DEFAULT_PREFIX}ozetle <metin> (veya bir mesaja yanıt vererek çağır)`,
  category: "fun",

  async execute(message: Message, args: string[]) {
    if (!(await requirePremiumOrTrial(message, "ozetle"))) return;

    const prefix = getGuildPrefix(message.guild?.id);

    let text = args.join(" ").trim();

    if (!text && message.reference?.messageId) {
      try {
        const replied = await message.fetchReference();
        text = replied.content?.trim() ?? "";
      } catch {
        // yanıtlanan mesaj alınamadı, aşağıdaki kontrol yakalayacak
      }
    }

    if (!text) {
      return message.reply({ flags: MessageFlags.IsComponentsV2,
      components: [usageEmbed(
        `${EMOJIS.usage} Kullanım: \`${prefix}ozetle <metin>\` ya da özetlemek istediğin mesaja yanıt vererek \`${prefix}ozetle\` yaz.`,
      )] });
    }

    const truncated = text.length > MAX_INPUT_CHARS;
    if (truncated) text = text.slice(0, MAX_INPUT_CHARS);

    const loadingMsg = await message.reply({ flags: MessageFlags.IsComponentsV2, components: textCard(`${EMOJIS.loading} Metin özetleniyor...`) });

    try {
      const summary = await generateWithGemini(SYSTEM_PROMPT, text);
      const trimmed = summary.trim().slice(0, 4000);

      if (!trimmed) {
        return loadingMsg.edit({ flags: MessageFlags.IsComponentsV2, components: [errorCard({ description: `${EMOJIS.error} Gemini bir özet üretemedi, tekrar dene.` })] });
      }

      // ✅ AI başarılı sonuç üretti → deneme hakkını şimdi harca.
      await consumeTrialUse(message, "ozetle");

      const embed = new V2CardBuilder()
        .setColor(COLORS.info)
        .setTitle(`${EMOJIS.success} Özet`)
        .setDescription(trimmed)
        .setFooter({ text: `İsteyen: ${message.author.tag}${truncated ? " • metin kısaltıldı" : ""}` })
        .setTimestamp();

      return loadingMsg.edit({ flags: MessageFlags.IsComponentsV2,
      components: [embed] });
    } catch (err: unknown) {
      console.error("özetle patladı la:", err);
      return loadingMsg.edit({ flags: MessageFlags.IsComponentsV2, components: [errorCard({ description: `${EMOJIS.error} Hata oluştu: ${err instanceof Error ? err.message : String(err)}` })] });
    }
  },
};


addSlash(command, [
  { name: "metin", description: "Özetlenecek metin", type: "string", required: true },
]);

export default command;
