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

// !ceviri <hedef dil> <metin>
// (bir mesaja yanıt vererek) !ceviri <hedef dil>  -> yanıtlanan mesajı çevirir

const MAX_INPUT_CHARS = 8_000;

function buildSystemPrompt(targetLang: string): string {
  return `Sen profesyonel bir çevirmensin. Sana verilen metni "${targetLang}" diline çevireceksin.

KURALLAR:
- SADECE çeviriyi yaz. Açıklama, giriş cümlesi, tırnak işareti ekleme.
- Anlamı ve tonu koru; birebir kelime kelime değil, doğal bir çeviri yap.
- Metnin dilini otomatik algıla, kullanıcı belirtmese de kaynak dili sen anla.
- Metindeki biçimlendirmeyi (satır sonları, madde işaretleri vb.) mümkün olduğunca koru.`;
}

const command: Command = {
  name: "ceviri",
  aliases: ["çeviri", "translate", "cevir"],
  description: "AI ile metni istenen dile çevirir",
  usage: `${DEFAULT_PREFIX}ceviri <hedef dil> <metin> (veya bir mesaja yanıt vererek)`,
  category: "fun",

  async execute(message: Message, args: string[]) {
    if (!(await requirePremiumOrTrial(message, "ceviri"))) return;

    const prefix = getGuildPrefix(message.guild?.id);
    const targetLang = args[0]?.trim();
    let text = args.slice(1).join(" ").trim();

    if (!text && message.reference?.messageId) {
      try {
        const replied = await message.fetchReference();
        text = replied.content?.trim() ?? "";
      } catch {
        // yanıtlanan mesaj alınamadı, aşağıdaki kontrol yakalayacak
      }
    }

    if (!targetLang || !text) {
      return message.reply({ flags: MessageFlags.IsComponentsV2,
      components: [usageEmbed(
        `${EMOJIS.usage} Kullanım: \`${prefix}ceviri <hedef dil> <metin>\`\n` +
        `Örnek: \`${prefix}ceviri ingilizce merhaba nasılsın\`\n` +
        `Ya da bir mesaja yanıt vererek: \`${prefix}ceviri ingilizce\``,
      )] });
    }

    if (text.length > MAX_INPUT_CHARS) {
      return message.reply({ flags: MessageFlags.IsComponentsV2, components: [errorCard({ description: `${EMOJIS.error} Metin çok uzun (maks ${MAX_INPUT_CHARS} karakter).` })] });
    }

    const loadingMsg = await message.reply({ flags: MessageFlags.IsComponentsV2, components: textCard(`${EMOJIS.loading} ${targetLang} diline çevriliyor...`) });

    try {
      const translated = await generateWithGemini(buildSystemPrompt(targetLang), text);
      const trimmed = translated.trim().slice(0, 4000);

      if (!trimmed) {
        return loadingMsg.edit({ flags: MessageFlags.IsComponentsV2, components: [errorCard({ description: `${EMOJIS.error} Gemini bir çeviri üretemedi, tekrar dene.` })] });
      }

      // ✅ AI başarılı sonuç üretti → deneme hakkını şimdi harca.
      await consumeTrialUse(message, "ceviri");

      const embed = new V2CardBuilder()
        .setColor(COLORS.success)
        .setTitle(`${EMOJIS.success} Çeviri (${targetLang})`)
        .setDescription(trimmed)
        .setFooter({ text: `İsteyen: ${message.author.tag}` })
        .setTimestamp();

      return loadingMsg.edit({ flags: MessageFlags.IsComponentsV2,
      components: [embed] });
    } catch (err: unknown) {
      console.error("çeviri patladı la:", err);
      return loadingMsg.edit({ flags: MessageFlags.IsComponentsV2, components: [errorCard({ description: `${EMOJIS.error} Hata oluştu: ${err instanceof Error ? err.message : String(err)}` })] });
    }
  },
};


addSlash(command, [
  { name: "dil", description: "Hedef dil", type: "string", required: true },
  { name: "metin", description: "Çevrilecek metin", type: "string", required: true },
]);

export default command;
