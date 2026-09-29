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

// !yaz <ne yazılacağı>
//
// Gemini ile e-posta, mesaj, makale, hikaye, şiir taslağı gibi metinler
// üretir (kod değil, düzyazı içerik).

const MAX_INPUT_CHARS = 2_000;

const SYSTEM_PROMPT = `Sen yetenekli bir metin yazarısın. Kullanıcının istediği türde (e-posta, mesaj, makale, hikaye, şiir, sunum metni vb.) bir metin yazacaksın.

KURALLAR:
- Cevabını Türkçe yaz (kullanıcı başka bir dilde istekte bulunursa o dilde yazabilirsin).
- SADECE istenen metni yaz; "işte metniniz" gibi giriş cümleleri veya kapanış notları ekleme.
- İstenen tona (resmi, samimi, esprili vb.) uygun yaz; belirtilmemişse duruma uygun makul bir ton seç.
- Telif hakkı olan gerçek şarkı sözü, şiir veya kitap pasajını birebir alıntılama; sadece özgün içerik üret.
- Gerçek, tanınabilir kişiler hakkında kötüleyici/itibar zedeleyici içerik üretme.
- Toplam cevap 1800 karakteri geçmesin.`;

const command: Command = {
  name: "yaz",
  aliases: ["metin-yaz", "metinyaz", "write"],
  description: "AI ile e-posta, mesaj, makale, hikaye gibi metinler yazar",
  usage: `${DEFAULT_PREFIX}yaz <ne yazılacağı>`,
  category: "fun",

  async execute(message: Message, args: string[]) {
    if (!(await requirePremiumOrTrial(message, "yaz"))) return;

    const prefix = getGuildPrefix(message.guild?.id);
    const request = args.join(" ").trim();

    if (!request) {
      return message.reply({ flags: MessageFlags.IsComponentsV2,
      components: [usageEmbed(
        `${EMOJIS.usage} Kullanım: \`${prefix}yaz <ne yazılacağı>\`\n` +
        `Örnek: \`${prefix}yaz izin dilekçesi, resmi ton, 3 gün mazeret izni\``,
      )] });
    }

    if (request.length > MAX_INPUT_CHARS) {
      return message.reply({ flags: MessageFlags.IsComponentsV2, components: [errorCard({ description: `${EMOJIS.error} İstek çok uzun (maks ${MAX_INPUT_CHARS} karakter).` })] });
    }

    const loadingMsg = await message.reply({ flags: MessageFlags.IsComponentsV2, components: textCard(`${EMOJIS.loading} Gemini yazıyor...`) });

    try {
      const text = await generateWithGemini(SYSTEM_PROMPT, request);
      const trimmed = text.trim().slice(0, 4000);

      if (!trimmed) {
        return loadingMsg.edit({ flags: MessageFlags.IsComponentsV2, components: [errorCard({ description: `${EMOJIS.error} Gemini bir metin üretemedi, tekrar dene.` })] });
      }

      // ✅ AI başarılı sonuç üretti → deneme hakkını şimdi harca.
      await consumeTrialUse(message, "yaz");

      const embed = new V2CardBuilder()
        .setColor(COLORS.info)
        .setTitle(`${EMOJIS.success} Yazı`)
        .setDescription(trimmed)
        .setFooter({ text: `İsteyen: ${message.author.tag}` })
        .setTimestamp();

      return loadingMsg.edit({ flags: MessageFlags.IsComponentsV2,
      components: [embed] });
    } catch (err: unknown) {
      console.error("yaz patladı la:", err);
      return loadingMsg.edit({ flags: MessageFlags.IsComponentsV2, components: [errorCard({ description: `${EMOJIS.error} Hata oluştu: ${err instanceof Error ? err.message : String(err)}` })] });
    }
  },
};


addSlash(command, [
  { name: "metin", description: "Yazılacak metin", type: "string", required: true },
]);

export default command;
