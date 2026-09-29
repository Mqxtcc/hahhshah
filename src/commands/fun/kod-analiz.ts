import { V2CardBuilder, errorCard, textCard } from "../../utils/componentsV2.js";
import { MessageFlags, type Message } from "discord.js";
import type { Command } from "../../types.js";
import { DEFAULT_PREFIX } from "../../config.js";
import { getGuildPrefix } from "../../events/messageCreate.js";
import { COLORS } from "../../utils/embeds.js";
import { generateForCode } from "../../utils/codeModel.js";
import { fetchAttachmentText } from "../../utils/codeFiles.js";
import { requirePremiumOrTrial, consumeTrialUse } from "../../premium/gate.js";
import { EMOJIS } from "../../utils/emojis.js";
import { addSlash } from "../../utils/slashBridge.js";
import { usageEmbed } from "../../utils/messages.js";

// !kod-analiz <kod veya ekli dosya>
//
// src/utils/gemini.ts üzerinden (Gemini) verilen kodu inceler; ne işe
// yaradığını, olası hataları/güvenlik sorunlarını ve iyileştirme
// önerilerini Türkçe olarak özetler.

const MAX_INPUT_CHARS = 12_000;
const MAX_ATTACHMENT_BYTES = 200_000; // ~200KB, metin dosyası için yeterli

const SYSTEM_PROMPT = `Sen deneyimli bir kod inceleme (code review) uzmanısın. Sana verilen kodu analiz edeceksin.

KURALLAR:
- Cevabını Türkçe yaz.
- Aşağıdaki başlıkları kullan (varsa emojiyle): "Ne işe yarıyor", "Olası hatalar / riskler", "İyileştirme önerileri".
- Kısa ve öz ol; madde işaretleri kullan, gereksiz uzatma.
- Kod bloklarını sadece kısa alıntı yaparken kullan, tüm kodu tekrar yazma.
- Kodun zararlı/kötü amaçlı (virüs, exploit, hesap çalma vb.) olduğunu düşünüyorsan bunu açıkça belirt ve öneri verme.
- Toplam cevap 1500 karakteri geçmesin.`;

function extractCodeFromMessage(args: string[]): string {
  const raw = args.join(" ");
  const fenced = raw.match(/```[a-zA-Z0-9_+#-]*\n?([\s\S]*?)```/i);
  if (fenced) return fenced[1].trim();
  return raw.trim();
}

const command: Command = {
  name: "kod-analiz",
  aliases: ["kodanaliz", "code-review", "kod-incele"],
  description: "AI ile verilen veya ekli kodu analiz eder, hata ve iyileştirme önerisi sunar",
  usage: `${DEFAULT_PREFIX}kod-analiz <kod bloğu> (veya bir kod dosyası ekle)`,
  category: "fun",

  async execute(message: Message, args: string[]) {
    if (!(await requirePremiumOrTrial(message, "kod-analiz"))) return;

    const prefix = getGuildPrefix(message.guild?.id);

    let code = extractCodeFromMessage(args);
    let sourceLabel = "mesajdaki kod";

    const attachment = message.attachments.first();
    if (attachment) {
      if (attachment.size > MAX_ATTACHMENT_BYTES) {
        return message.reply({ flags: MessageFlags.IsComponentsV2, components: [errorCard({ description: `${EMOJIS.error} Dosya çok büyük (maks ~${Math.floor(MAX_ATTACHMENT_BYTES / 1000)}KB).` })] });
      }
      try {
        const text = await fetchAttachmentText(attachment.url);
        code = text;
        sourceLabel = attachment.name ?? "ekli dosya";
      } catch (err) {
        return message.reply({ flags: MessageFlags.IsComponentsV2, components: [errorCard({ description: `${EMOJIS.error} Ekli dosya okunamadı: ${err instanceof Error ? err.message : "tekrar dene."}` })] });
      }
    }

    if (!code || code.length < 5) {
      return message.reply({ flags: MessageFlags.IsComponentsV2,
      components: [usageEmbed(
        `${EMOJIS.usage} Kullanım: \`${prefix}kod-analiz <kod>\` (mesaja kod bloğu yaz ya da bir dosya ekle)\n` +
        "Örnek: bir kod bloğu içine kodunu yapıştır ya da komuta bir dosya ekleyerek gönder.",
      )] });
    }

    const truncated = code.length > MAX_INPUT_CHARS;
    if (truncated) code = code.slice(0, MAX_INPUT_CHARS);

    const loadingMsg = await message.reply({ flags: MessageFlags.IsComponentsV2, components: textCard(`${EMOJIS.loading} Kod analiz ediliyor...`) });

    try {
      const { text: analysis, model } = await generateForCode(
        SYSTEM_PROMPT,
        `Dosya/kaynak: ${sourceLabel}\n\nKod:\n\`\`\`\n${code}\n\`\`\``,
      );

      const trimmedAnalysis = analysis.trim().slice(0, 4000);

      if (!trimmedAnalysis) {
        return loadingMsg.edit({ flags: MessageFlags.IsComponentsV2, components: [errorCard({ description: `${EMOJIS.error} Bir analiz üretilemedi, tekrar dene.` })] });
      }

      // ✅ AI başarılı sonuç üretti → deneme hakkını şimdi harca.
      await consumeTrialUse(message, "kod-analiz");

      const embed = new V2CardBuilder()
        .setColor(COLORS.info)
        .setTitle(`${EMOJIS.info} Kod Analizi`)
        .setDescription(trimmedAnalysis)
        .setFooter({
          text: `Kaynak: ${sourceLabel}${truncated ? " (kısaltıldı)" : ""} • Model: ${model} • İsteyen: ${message.author.tag}`,
        })
        .setTimestamp();

      return loadingMsg.edit({ flags: MessageFlags.IsComponentsV2,
      components: [embed] });
    } catch (err: unknown) {
      console.error("kod-analiz patladı la:", err);
      return loadingMsg.edit({ flags: MessageFlags.IsComponentsV2, components: [errorCard({ description: `${EMOJIS.error} Hata oluştu: ${err instanceof Error ? err.message : String(err)}` })] });
    }
  },
};


addSlash(command, [
  { name: "kod", description: "Analiz edilecek kod", type: "string" },
  { name: "dosya", description: "Kod dosyası ekle", type: "attachment" },
]);

export default command;
