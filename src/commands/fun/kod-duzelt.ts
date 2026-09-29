import { fileComponent, V2CardBuilder, errorCard, textCard } from "../../utils/componentsV2.js";
import { MessageFlags, AttachmentBuilder, type Message } from "discord.js";
import type { Command } from "../../types.js";
import { DEFAULT_PREFIX } from "../../config.js";
import { getGuildPrefix } from "../../events/messageCreate.js";
import { COLORS } from "../../utils/embeds.js";
import { generateCodeText } from "../../utils/codeModel.js";
import { extractCodeBlockWithRest, fetchAttachmentText } from "../../utils/codeFiles.js";
import { keyFromExtension, labelForKey } from "../../utils/langs.js";
import { requirePremiumOrTrial, consumeTrialUse } from "../../premium/gate.js";
import { EMOJIS } from "../../utils/emojis.js";
import { addSlash } from "../../utils/slashBridge.js";
import { usageEmbed } from "../../utils/messages.js";

// !kod-duzelt <kod veya ekli dosya> [sorun açıklaması]
//
// src/utils/gemini.ts üzerinden (Gemini) verilen koddaki hataları bulup
// düzeltir, düzeltilmiş dosyayı geri gönderir ve neyin değiştiğini
// kısaca özetler.

const MAX_INPUT_CHARS = 12_000;
const MAX_ATTACHMENT_BYTES = 200_000;

const SYSTEM_PROMPT = `Sen deneyimli bir yazılım geliştiricisisin. Sana verilen koddaki hataları bulup düzelteceksin.

ÇIKTI FORMATI (SIRAYLA):
1) Önce tek bir \`\`\` kod bloğu içinde DÜZELTİLMİŞ TAM kodu ver (orijinal dille aynı dilde, eksiksiz, çalışır durumda).
2) Kod bloğundan SONRA "DEĞİŞİKLİKLER:" başlığıyla madde madde neyi neden değiştirdiğini kısaca (Türkçe) özetle.

KURALLAR:
- Kod bloğunun içine açıklama yazma, sadece kod.
- Kullanıcı bir sorun belirttiyse öncelikle onu çöz; belirtmediyse gördüğün gerçek hataları/bugları düzelt.
- Kodun mantığını ve amacını gereksiz yere değiştirme, sadece hatayı düzelt / iyileştir.
- Eğer kodda gerçek bir hata bulamazsan, kodu olduğu gibi geri ver ve "DEĞİŞİKLİKLER:" kısmında hata bulunamadığını belirt.
- "// devamı buraya" gibi yer tutucular kullanma, kod eksiksiz olmalı.
- ÇOK ÖNEMLİ: Düzeltilmiş kodu KESİNLİKLE orijinal kodla AYNI dilde ver. Orijinal dili başka bir dile ASLA çevirme (ör. orijinal TypeScript ise düz JavaScript döndürme, gerçek TypeScript söz dizimini koru).`;

const FENCED_RE = /```[a-zA-Z0-9_+#-]*\n?([\s\S]*?)```/i;

// args'taki kod bloğunu ayıklar; blok yoksa tüm metni olduğu gibi döner
// (ek + açıklama birlikte gönderildiğinde notun içinde kod tekrar etmesin).
function extractNoteText(args: string[]): string {
  const raw = args.join(" ");
  const fenced = raw.match(FENCED_RE);
  return (fenced ? raw.replace(fenced[0], "") : raw).trim();
}

function extractCodeAndNote(args: string[]): { code: string; note: string } {
  const raw = args.join(" ");
  const fenced = raw.match(FENCED_RE);
  if (fenced) {
    return { code: fenced[1].trim(), note: extractNoteText(args) };
  }
  return { code: raw.trim(), note: "" };
}

function extractFixedCode(raw: string): { code: string; explanation: string; truncated: boolean } {
  const { code, rest, truncated } = extractCodeBlockWithRest(raw);
  return { code, explanation: rest || "Belirtilmedi.", truncated };
}

const command: Command = {
  name: "kod-duzelt",
  aliases: ["koddüzelt", "kod-düzelt", "fix-code", "kodfix"],
  description: "AI ile verilen veya ekli koddaki hataları bulup düzeltir",
  usage: `${DEFAULT_PREFIX}kod-duzelt <kod bloğu> [sorun açıklaması] (veya bir kod dosyası ekle)`,
  category: "fun",

  async execute(message: Message, args: string[]) {
    if (!(await requirePremiumOrTrial(message, "kod-duzelt"))) return;

    const prefix = getGuildPrefix(message.guild?.id);

    let { code, note } = extractCodeAndNote(args);
    let sourceLabel = "mesajdaki kod";
    let attachExt = "txt";

    const attachment = message.attachments.first();
    if (attachment) {
      if (attachment.size > MAX_ATTACHMENT_BYTES) {
        return message.reply({ flags: MessageFlags.IsComponentsV2, components: [errorCard({ description: `${EMOJIS.error} Dosya çok büyük (maks ~${Math.floor(MAX_ATTACHMENT_BYTES / 1000)}KB).` })] });
      }
      try {
        code = await fetchAttachmentText(attachment.url);
        sourceLabel = attachment.name ?? "ekli dosya";
        // args'ta kod bloğu da yazılmış olabilir — varsa ayıkla, yoksa tüm metin nottur
        note = extractNoteText(args);
        const extMatch = /\.([a-z0-9]+)$/i.exec(attachment.name ?? "");
        if (extMatch) attachExt = extMatch[1].toLowerCase();
      } catch (err) {
        return message.reply({ flags: MessageFlags.IsComponentsV2, components: [errorCard({ description: `${EMOJIS.error} Ekli dosya okunamadı: ${err instanceof Error ? err.message : "tekrar dene."}` })] });
      }
    }

    if (!code || code.length < 5) {
      return message.reply({ flags: MessageFlags.IsComponentsV2,
      components: [usageEmbed(
        `${EMOJIS.usage} Kullanım: \`${prefix}kod-duzelt <kod> [sorun açıklaması]\` (mesaja kod bloğu yaz ya da bir dosya ekle)\n` +
        "Örnek: bir kod bloğu içine kodunu yapıştır, isteğe bağlı olarak sorunu yaz (örn: \"çöktü, düzelt\").",
      )] });
    }

    const truncated = code.length > MAX_INPUT_CHARS;
    if (truncated) code = code.slice(0, MAX_INPUT_CHARS);

    const loadingMsg = await message.reply({ flags: MessageFlags.IsComponentsV2, components: textCard(`${EMOJIS.loading} Kod düzeltiliyor...`) });

    try {
      const userPrompt =
        `Dosya/kaynak: ${sourceLabel}\n` +
        (note ? `Kullanıcının belirttiği sorun: ${note}\n` : "") +
        `\nKod:\n\`\`\`\n${code}\n\`\`\``;

      const expectedLangKey = keyFromExtension(attachExt);
      const { text: rawText, retried, model } = await generateCodeText(SYSTEM_PROMPT, userPrompt, {
        expectedLangKey,
        expectedLabel: expectedLangKey ? labelForKey(expectedLangKey) : undefined,
      });
      const { code: fixedCode, explanation, truncated: outputTruncated } = extractFixedCode(rawText);

      if (!fixedCode || fixedCode.length < 5) {
        return loadingMsg.edit({ flags: MessageFlags.IsComponentsV2, components: [errorCard({ description: `${EMOJIS.error} Geçerli bir düzeltme üretilemedi, tekrar dene.` })] });
      }

      // ✅ AI başarılı sonuç üretti → deneme hakkını şimdi harca.
      await consumeTrialUse(message, "kod-duzelt");

      const filename = `duzeltilmis.${attachExt === "ts" ? "txt" : attachExt}`;
      const fileAttachment = new AttachmentBuilder(Buffer.from(fixedCode, "utf-8"), {
        name: filename,
      });

      const embed = new V2CardBuilder()
        .setColor(outputTruncated ? COLORS.error : COLORS.success)
        .setTitle(
          outputTruncated
            ? `${EMOJIS.alert} Kod Düzeltildi (EKSİK KALDI)`
            : `${EMOJIS.success} Kod Düzeltildi`,
        )
        .setDescription(
          [
            `**Kaynak:** ${sourceLabel}${truncated ? " (kısaltıldı)" : ""}`,
            `**Model:** ${model}`,
            `**Değişiklikler:**\n${explanation.slice(0, 1500)}`,
            retried ? "_Not: İlk üretim beklenen dille tam eşleşmedi, otomatik olarak yeniden üretildi._" : "",
            outputTruncated
              ? `\n${EMOJIS.alert} **Uyarı:** Kod çok uzun olduğu için tam bitirilemeden kesildi, ekteki dosya eksik/bozuk olabilir. Kodu daha küçük parçalar hâlinde göndermen önerilir.`
              : "",
          ].filter(Boolean).join("\n"),
        )
        .setFooter({ text: `İsteyen: ${message.author.tag}` })
        .setTimestamp();

      return loadingMsg.edit({ flags: MessageFlags.IsComponentsV2,
      components: [embed, fileComponent(fileAttachment.name ?? filename)], files: [fileAttachment] });
    } catch (err: unknown) {
      console.error("kod-düzelt patladı la:", err);
      return loadingMsg.edit({ flags: MessageFlags.IsComponentsV2, components: [errorCard({ description: `${EMOJIS.error} Hata oluştu: ${err instanceof Error ? err.message : String(err)}` })] });
    }
  },
};


addSlash(command, [
  { name: "kod", description: "Düzeltilecek kod", type: "string" },
  { name: "sorun", description: "Sorunun açıklaması", type: "string" },
  { name: "dosya", description: "Kod dosyası ekle", type: "attachment" },
]);

export default command;
