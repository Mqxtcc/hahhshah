import { V2CardBuilder, errorCard, textCard } from "../../utils/componentsV2.js";
import { MessageFlags, type Message } from "discord.js";
import type { Command } from "../../types.js";
import { DEFAULT_PREFIX } from "../../config.js";
import { getGuildPrefix } from "../../events/messageCreate.js";
import { COLORS } from "../../utils/embeds.js";
import { generateWithGroq } from "../../utils/groq.js";
import { requirePremiumOrTrial, consumeTrialUse } from "../../premium/gate.js";
import { EMOJIS } from "../../utils/emojis.js";
import { addSlash } from "../../utils/slashBridge.js";
import { usageEmbed } from "../../utils/messages.js";

// !sor <soru>
//
// Groq'a serbest, genel amaçlı bir soru sorar (kod dışı konular dahil).

const MAX_INPUT_CHARS = 4_000;
const MAX_FILE_CHARS = 6_000;
const MAX_FILE_BYTES = 512 * 1024; // 512 KB

// İçeriği metin olarak okunabilecek uzantılar/MIME tipleri
const TEXT_EXT_RE = /\.(txt|md|markdown|json|csv|log|ts|js|tsx|jsx|py|java|c|cpp|h|hpp|cs|go|rb|php|html|css|xml|yaml|yml|sql|sh|env)$/i;

function isReadableTextFile(name: string, contentType: string | null): boolean {
  if (contentType?.startsWith("text/")) return true;
  if (contentType === "application/json") return true;
  return TEXT_EXT_RE.test(name);
}

async function readAttachmentText(attachment: {
  name: string;
  url: string;
  size: number;
  contentType: string | null;
}): Promise<string | null> {
  if (!isReadableTextFile(attachment.name, attachment.contentType)) return null;
  if (attachment.size > MAX_FILE_BYTES) return null;

  const res = await fetch(attachment.url);
  if (!res.ok) return null;

  const text = await res.text();
  return text.length > MAX_FILE_CHARS ? text.slice(0, MAX_FILE_CHARS) : text;
}

const SYSTEM_PROMPT = `Sen bir Discord sunucusunda yardımcı bir asistansın. Kullanıcının sorusuna Türkçe, net ve doğru şekilde cevap ver.

KURALLAR:
- Cevabını Türkçe yaz (kullanıcı başka dilde sorarsa o dilde cevap verebilirsin).
- Kısa ve öz ol; gereksiz uzun girizgah yapma, direkt cevaba gir.
- Emin olmadığın konularda bunu belirt, uydurma bilgi verme.
- Zararlı, tehlikeli veya kötüye kullanılabilecek bir istek gelirse kibarca reddet.
- Toplam cevap 1800 karakteri geçmesin.`;

const command: Command = {
  name: "sor",
  aliases: ["ai", "soru", "ask"],
  description: "ai'ye genel bir soru sorar",
  usage: `${DEFAULT_PREFIX}sor <soru>`,
  category: "fun",

  async execute(message: Message, args: string[]) {
    if (!(await requirePremiumOrTrial(message, "sor"))) return;

    const prefix = getGuildPrefix(message.guild?.id);
    const question = args.join(" ").trim();

    const attachment = message.attachments.first();

    if (!question && !attachment) {
      return message.reply({ flags: MessageFlags.IsComponentsV2,
      components: [usageEmbed(
        `${EMOJIS.usage} Kullanım: \`${prefix}sor <soru>\`\n` +
        `Örnek: \`${prefix}sor Türkiye'nin başkenti neresidir?\`\n` +
        `Ayrıca bir metin dosyası ekleyip onun içeriği hakkında da soru sorabilirsin.`,
      )] });
    }

    if (question.length > MAX_INPUT_CHARS) {
      return message.reply({ flags: MessageFlags.IsComponentsV2, components: [errorCard({ description: `${EMOJIS.error} Soru çok uzun (maks ${MAX_INPUT_CHARS} karakter).` })] });
    }

    const loadingMsg = await message.reply({ flags: MessageFlags.IsComponentsV2, components: textCard(`${EMOJIS.loading} AI düşünüyor...`) });

    try {
      let fileContent: string | null = null;

      if (attachment) {
        try {
          fileContent = await readAttachmentText({
            name: attachment.name,
            url: attachment.url,
            size: attachment.size,
            contentType: attachment.contentType,
          });
        } catch (fileErr) {
          console.error("sor: dosya okunamadı:", fileErr);
        }

        if (!fileContent) {
          return loadingMsg.edit({ flags: MessageFlags.IsComponentsV2, components: [errorCard({ description: `${EMOJIS.error} Dosya okunamadı. Desteklenen metin tabanlı bir dosya (maks ${Math.round(
              MAX_FILE_BYTES / 1024,
            )} KB) eklediğinden emin ol.` })] });
        }
      }

      const effectiveQuestion = fileContent
        ? `${question || "Bu dosyayı özetle ve içeriği hakkında bilgi ver."}\n\n[Eklenen dosya: ${attachment!.name}]\n---\n${fileContent}\n---`
        : question;

      const answer = await generateWithGroq(SYSTEM_PROMPT, effectiveQuestion, {
        maxTokens: 8_024,
        temperature: 0.45,
      });
      const trimmed = answer.trim().slice(0, 4000);

      if (!trimmed) {
        return loadingMsg.edit({ flags: MessageFlags.IsComponentsV2, components: [errorCard({ description: `${EMOJIS.error} AI bir cevap üretemedi, tekrar dene.` })] });
      }

      // ✅ AI başarılı sonuç üretti → deneme hakkını şimdi harca.
      await consumeTrialUse(message, "sor");

      const embed = new V2CardBuilder()
        .setColor(COLORS.info)
        .setTitle(`${EMOJIS.success} Cevap`)
        .setDescription(trimmed)
        .setFooter({ text: `Soran: ${message.author.tag}` })
        .setTimestamp();

      return loadingMsg.edit({ flags: MessageFlags.IsComponentsV2,
      components: [embed] });
    } catch (err: unknown) {
      console.error("sor patladı la:", err);
      return loadingMsg.edit({ flags: MessageFlags.IsComponentsV2, components: [errorCard({ description: `${EMOJIS.error} Hata oluştu: ${err instanceof Error ? err.message : String(err)}` })] });
    }
  },
};


addSlash(command, [
  { name: "soru", description: "Sorunuz", type: "string", required: true },
  { name: "dosya", description: "Dosya ekle", type: "attachment" },
]);

export default command;
