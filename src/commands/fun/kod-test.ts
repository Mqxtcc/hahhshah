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

// !kod-test <kod veya ekli dosya> [test framework]
//
// src/utils/gemini.ts üzerinden (Gemini) verilen kod için unit test
// dosyası üretir ve dosya olarak gönderir.

const MAX_INPUT_CHARS = 12_000;
const MAX_ATTACHMENT_BYTES = 200_000;

const SYSTEM_PROMPT = `Sen deneyimli bir yazılım test mühendisisin. Sana verilen kod için unit testler yazacaksın.

ÇIKTI FORMATI:
1) SADECE tek bir \`\`\` kod bloğu içinde test kodunu ver (kodun dili neyse aynı dilde, eksiksiz, doğrudan çalıştırılabilir).
2) Kod bloğundan SONRA "TEST SENARYOLARI:" başlığıyla hangi durumları test ettiğini kısaca (Türkçe) madde madde özetle.

KURALLAR:
- Kullanıcı bir test framework'ü belirttiyse onu kullan (örn. jest, pytest, vitest, mocha, junit). Belirtmediyse dilin en yaygın/standart framework'ünü seç.
- Normal durumları, sınır (edge case) durumlarını ve hata/istisna durumlarını test et.
- "// TODO" gibi yer tutucular kullanma, testler eksiksiz ve çalışır olmalı.
- Kodun içeriğini değiştirme, sadece ona test yaz.
- ÇOK ÖNEMLİ: Test kodunu KESİNLİKLE test edilen kodla AYNI dilde yaz. Orijinal dili başka bir dile ASLA çevirme (ör. orijinal Python ise JavaScript testi döndürme).`;

const FENCED_RE = /```[a-zA-Z0-9_+#-]*\n?([\s\S]*?)```/i;

// args'taki kod bloğunu ayıklar; blok yoksa tüm metni olduğu gibi döner
// (ek + framework birlikte gönderildiğinde framework'ün içinde kod tekrar etmesin).
function extractFrameworkText(args: string[]): string {
  const raw = args.join(" ");
  const fenced = raw.match(FENCED_RE);
  return (fenced ? raw.replace(fenced[0], "") : raw).trim();
}

function extractCodeAndFramework(args: string[]): { code: string; framework: string } {
  const raw = args.join(" ");
  const fenced = raw.match(FENCED_RE);
  if (fenced) {
    return { code: fenced[1].trim(), framework: extractFrameworkText(args) };
  }
  return { code: raw.trim(), framework: "" };
}

function extractTestCode(raw: string): { code: string; scenarios: string; truncated: boolean } {
  const { code, rest, truncated } = extractCodeBlockWithRest(raw);
  return { code, scenarios: rest || "Belirtilmedi.", truncated };
}

const command: Command = {
  name: "kod-test",
  aliases: ["kodtest", "test-yaz", "testyaz"],
  description: "AI ile verilen veya ekli kod için unit test üretir",
  usage: `${DEFAULT_PREFIX}kod-test <kod bloğu> [framework] (veya bir kod dosyası ekle)`,
  category: "fun",

  async execute(message: Message, args: string[]) {
    if (!(await requirePremiumOrTrial(message, "kod-test"))) return;

    const prefix = getGuildPrefix(message.guild?.id);

    let { code, framework } = extractCodeAndFramework(args);
    let sourceLabel = "mesajdaki kod";
    let attachExt = "txt";

    const attachment = message.attachments.first();
    if (attachment) {
      if (attachment.size > MAX_ATTACHMENT_BYTES) {
        return await message.reply({ flags: MessageFlags.IsComponentsV2, components: [errorCard({ description: `${EMOJIS.error} Dosya çok büyük (maks ~${Math.floor(MAX_ATTACHMENT_BYTES / 1000)}KB).` })] });
      }
      try {
        code = await fetchAttachmentText(attachment.url);
        sourceLabel = attachment.name ?? "ekli dosya";
        // args'ta kod bloğu da yazılmış olabilir — varsa ayıkla, yoksa tüm metin framework bilgisidir
        framework = extractFrameworkText(args);
        const extMatch = /\.([a-z0-9]+)$/i.exec(attachment.name ?? "");
        if (extMatch) attachExt = extMatch[1].toLowerCase();
      } catch (err) {
        return await message.reply({ flags: MessageFlags.IsComponentsV2, components: [errorCard({ description: `${EMOJIS.error} Ekli dosya okunamadı: ${err instanceof Error ? err.message : "tekrar dene."}` })] });
      }
    }

    if (!code || code.length < 5) {
      return await message.reply({ flags: MessageFlags.IsComponentsV2,
      components: [usageEmbed(
        `${EMOJIS.usage} Kullanım: \`${prefix}kod-test <kod> [framework]\` (mesaja kod bloğu yaz ya da bir dosya ekle)\n` +
        "Örnek: bir kod bloğu içine kodunu yapıştır, isteğe bağlı framework belirt (örn: jest, pytest).",
      )] });
    }

    const truncated = code.length > MAX_INPUT_CHARS;
    if (truncated) code = code.slice(0, MAX_INPUT_CHARS);

    const loadingMsg = await message.reply({ flags: MessageFlags.IsComponentsV2, components: textCard(`${EMOJIS.loading} Testler üretiliyor...`) });

    try {
      const userPrompt =
        `Dosya/kaynak: ${sourceLabel}\n` +
        (framework ? `İstenen test framework: ${framework}\n` : "") +
        `\nKod:\n\`\`\`\n${code}\n\`\`\``;

      const expectedLangKey = keyFromExtension(attachExt);
      const { text: rawText, retried, model } = await generateCodeText(SYSTEM_PROMPT, userPrompt, {
        expectedLangKey,
        expectedLabel: expectedLangKey ? labelForKey(expectedLangKey) : undefined,
      });
      const { code: testCode, scenarios, truncated: outputTruncated } = extractTestCode(rawText);

      if (!testCode || testCode.length < 5) {
        return await loadingMsg.edit({ flags: MessageFlags.IsComponentsV2, components: [errorCard({ description: `${EMOJIS.error} Geçerli bir test üretilemedi, tekrar dene.` })] });
      }

      // ✅ AI başarılı sonuç üretti → deneme hakkını şimdi harca.
      await consumeTrialUse(message, "kod-test");

      const filename = `test.${attachExt === "ts" ? "txt" : attachExt}`;
      const fileAttachment = new AttachmentBuilder(Buffer.from(testCode, "utf-8"), {
        name: filename,
      });

      const embed = new V2CardBuilder()
        .setColor(outputTruncated ? COLORS.error : COLORS.success)
        .setTitle(
          outputTruncated
            ? `${EMOJIS.alert} Testler Üretildi (EKSİK KALDI)`
            : `${EMOJIS.success} Testler Üretildi`,
        )
        .setDescription(
          [
            `**Kaynak:** ${sourceLabel}${truncated ? " (kısaltıldı)" : ""}`,
            `**Model:** ${model}`,
            `**Test Senaryoları:**\n${scenarios.slice(0, 1500)}`,
            retried ? "_Not: İlk üretim beklenen dille tam eşleşmedi, otomatik olarak yeniden üretildi._" : "",
            outputTruncated
              ? `\n${EMOJIS.alert} **Uyarı:** Test kodu çok uzun olduğu için tam bitirilemeden kesildi, ekteki dosya eksik/bozuk olabilir. Kodu daha küçük parçalar hâlinde göndermen önerilir.`
              : "",
          ].filter(Boolean).join("\n"),
        )
        .setFooter({ text: `İsteyen: ${message.author.tag}` })
        .setTimestamp();

      return await loadingMsg.edit({ flags: MessageFlags.IsComponentsV2,
      components: [embed, fileComponent(fileAttachment.name ?? filename)], files: [fileAttachment] });
    } catch (err: unknown) {
      console.error("kod-test patladı la:", err);
      return await loadingMsg.edit({ flags: MessageFlags.IsComponentsV2, components: [errorCard({ description: `${EMOJIS.error} Hata oluştu: ${err instanceof Error ? err.message : String(err)}` })] });
    }
  },
};


addSlash(command, [
  { name: "kod", description: "Test yazılacak kod", type: "string" },
  { name: "framework", description: "Test framework'ü", type: "string" },
  { name: "dosya", description: "Kod dosyası ekle", type: "attachment" },
]);

export default command;
