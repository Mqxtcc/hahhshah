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

// !fikir <konu>
//
// Groq ile verilen konu hakkında beyin fırtınası yapıp fikir listesi
// üretir (proje fikri, isim önerisi, içerik fikri vb.).

const MAX_INPUT_CHARS = 1_000;

const SYSTEM_PROMPT = `Sen yaratıcı bir beyin fırtınası ortağısın. Kullanıcının verdiği konu hakkında yaratıcı, çeşitli fikirler üreteceksin.

KURALLAR:
- Cevabını Türkçe yaz.
- 5-8 arası numaralı fikir üret.
- Her fikri tek satırda, kısa ve net şekilde yaz; gerekiyorsa yanına 1 kısa cümlelik açıklama ekle.
- Fikirler birbirinden farklı ve gerçekten kullanılabilir olsun, birbirinin tekrarı olmasın.
- Toplam cevap 1500 karakteri geçmesin.`;

const command: Command = {
  name: "fikir",
  aliases: ["brainstorm", "fikirler", "idea"],
  description: "AI ile verilen konu hakkında fikir/beyin fırtınası listesi üretir",
  usage: `${DEFAULT_PREFIX}fikir <konu>`,
  category: "fun",

  async execute(message: Message, args: string[]) {
    if (!(await requirePremiumOrTrial(message, "fikir"))) return;

    const prefix = getGuildPrefix(message.guild?.id);
    const topic = args.join(" ").trim();

    if (!topic) {
      return message.reply({ flags: MessageFlags.IsComponentsV2,
      components: [usageEmbed(
        `${EMOJIS.usage} Kullanım: \`${prefix}fikir <konu>\`\n` +
        `Örnek: \`${prefix}fikir discord sunucusu için etkinlik fikirleri\``,
      )] });
    }

    if (topic.length > MAX_INPUT_CHARS) {
      return message.reply({ flags: MessageFlags.IsComponentsV2, components: [errorCard({ description: `${EMOJIS.error} Konu çok uzun (maks ${MAX_INPUT_CHARS} karakter).` })] });
    }

    const loadingMsg = await message.reply({ flags: MessageFlags.IsComponentsV2, components: textCard(`${EMOJIS.loading} Fikirler üretiliyor...`) });

    try {
      const ideas = await generateWithGroq(SYSTEM_PROMPT, topic, {
        maxTokens: 1_024,
        temperature: 0.8,
      });
      const trimmed = ideas.trim().slice(0, 4000);

      if (!trimmed) {
        return loadingMsg.edit({ flags: MessageFlags.IsComponentsV2, components: [errorCard({ description: `${EMOJIS.error} AI fikir üretemedi, tekrar dene.` })] });
      }

      // ✅ AI başarılı sonuç üretti → deneme hakkını şimdi harca.
      await consumeTrialUse(message, "fikir");

      const embed = new V2CardBuilder()
        .setColor(COLORS.info)
        .setTitle(`${EMOJIS.success} Fikirler: ${topic.slice(0, 100)}`)
        .setDescription(trimmed)
        .setFooter({ text: `İsteyen: ${message.author.tag}` })
        .setTimestamp();

      return loadingMsg.edit({ flags: MessageFlags.IsComponentsV2,
      components: [embed] });
    } catch (err: unknown) {
      console.error("fikir patladı la:", err);
      return loadingMsg.edit({ flags: MessageFlags.IsComponentsV2, components: [errorCard({ description: `${EMOJIS.error} Hata oluştu: ${err instanceof Error ? err.message : String(err)}` })] });
    }
  },
};


addSlash(command, [
  { name: "konu", description: "Fikir üretilecek konu", type: "string" },
]);

export default command;
