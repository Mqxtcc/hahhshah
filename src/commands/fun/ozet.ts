import { V2CardBuilder, errorCard, textCard } from "../../utils/componentsV2.js";
import { MessageFlags, PermissionFlagsBits, type Message, type TextChannel } from "discord.js";
import type { Command } from "../../types.js";
import { DEFAULT_PREFIX } from "../../config.js";
import { getGuildPrefix } from "../../events/messageCreate.js";
import { COLORS } from "../../utils/embeds.js";
import { generateWithGroq } from "../../utils/groq.js";
import { requirePremiumOrTrial, consumeTrialUse } from "../../premium/gate.js";
import { EMOJIS } from "../../utils/emojis.js";
import { addSlash } from "../../utils/slashBridge.js";

// !özet            -> bu kanaldaki son 50 mesajı Groq ile özetler
// !özet 30         -> son 30 mesajı özetler (1-50 arası)
//
// customevent/otomod sistemleriyle hiçbir ilgisi yok; sıradan bir komut
// olarak kaydedildiği için (bkz. src/index.ts) diğer komutlarla aynı şekilde
// reserved-name korumasından otomatik faydalanır.

const DEFAULT_MESSAGE_COUNT = 50;
const MAX_MESSAGE_COUNT = 50;
const MAX_INPUT_CHARS = 6_000;

const SYSTEM_PROMPT = `Sen bir Discord sohbet özetleme asistanısın. Sana "Kullanıcı: mesaj" formatında \
art arda mesajlar verilecek. Görevin bu sohbeti Türkçe olarak özetlemek.

KURALLAR:
- Cevabını Türkçe yaz.
- Sohbette konuşulan ana konuları, alınan kararları ve önemli noktaları kısa madde \
işaretleriyle ver.
- Kimin ne söylediğini gerektiğinde belirt ama tek tek her mesajı tekrar etme.
- Anlamsız/spam mesajları ve selamlaşmaları özete dahil etme.
- Uydurma bilgi ekleme, sadece verilen mesajlara dayan.
- Toplam cevap 1500 karakteri geçmesin.`;

function parseCount(args: string[]): number {
  const raw = parseInt(args[0] ?? "", 10);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_MESSAGE_COUNT;
  return Math.min(raw, MAX_MESSAGE_COUNT);
}

const command: Command = {
  name: "özet",
  aliases: ["ozet", "chatozet", "sohbetozet"],
  description: "Bu kanaldaki son mesajları Groq ile özetler",
  usage: `${DEFAULT_PREFIX}özet [1-50]`,
  category: "fun",

  async execute(message: Message, args: string[]) {
    // Diğer tüm AI komutları (ozetle, sor, fikir, ceviri...) gibi premium/
    // deneme kontrolünden geçmesi gerekirken bu komut eksikti — herkes
    // sınırsız ve ücretsiz olarak Groq kotasını tüketebiliyordu.
    if (!(await requirePremiumOrTrial(message, "özet"))) return;

    const prefix = getGuildPrefix(message.guild?.id);
    const channel = message.channel as TextChannel;

    const me = message.guild?.members.me;
    if (me && !channel.permissionsFor(me)?.has(PermissionFlagsBits.ReadMessageHistory)) {
      return message.reply({ flags: MessageFlags.IsComponentsV2, components: [errorCard({ description: `${EMOJIS.error} Bu kanalda mesaj geçmişini okuma iznim yok.` })] });
    }

    const count = parseCount(args);
    const loadingMsg = await message.reply({ flags: MessageFlags.IsComponentsV2, components: textCard(`${EMOJIS.loading} Son mesajlar toplanıyor ve özetleniyor...`) });

    try {
      // message dahil son `count` mesajı çek, en eskiden en yeniye sırala.
      const fetched = await channel.messages.fetch({ limit: count });
      const ordered = [...fetched.values()]
        .filter((m) => !m.author.bot && m.content?.trim())
        .reverse();

      if (ordered.length === 0) {
        return loadingMsg.edit({ flags: MessageFlags.IsComponentsV2, components: [errorCard({ description: `${EMOJIS.error} Özetlenecek yeterli metin içeren mesaj bulunamadı.` })] });
      }

      let transcript = ordered
        .map((m) => `${m.member?.displayName ?? m.author.username}: ${m.content}`)
        .join("\n");

      const truncated = transcript.length > MAX_INPUT_CHARS;
      if (truncated) transcript = transcript.slice(-MAX_INPUT_CHARS);

      const summary = await generateWithGroq(SYSTEM_PROMPT, transcript, {
        maxTokens: 1_024,
        temperature: 0.35,
      });
      const trimmed = summary.trim().slice(0, 4000);

      if (!trimmed) {
        return loadingMsg.edit({ flags: MessageFlags.IsComponentsV2, components: [errorCard({ description: `${EMOJIS.error} Bir özet üretilemedi, tekrar dene.` })] });
      }

      // ✅ AI başarılı sonuç üretti → deneme hakkını şimdi harca.
      await consumeTrialUse(message, "özet");

      const embed = new V2CardBuilder()
        .setColor(COLORS.info)
        .setTitle(`${EMOJIS.success} Sohbet Özeti`)
        .setDescription(trimmed)
        .setFooter({
          text: `${ordered.length} mesaj tarandı • İsteyen: ${message.author.tag}${truncated ? " • içerik kısaltıldı" : ""}`,
        })
        .setTimestamp();

      return loadingMsg.edit({ flags: MessageFlags.IsComponentsV2,
      components: [embed] });
    } catch (err: unknown) {
      console.error("özet patladı la:", err);
      return loadingMsg.edit({ flags: MessageFlags.IsComponentsV2, components: [errorCard({ description: `${EMOJIS.error} Hata oluştu: ${err instanceof Error ? err.message : String(err)}\n\nKullanım: \`${prefix}özet [1-50]\`` })] });
    }
  },
};


addSlash(command, [
  { name: "adet", description: "Özetlenecek mesaj sayısı (1-50)", type: "integer", minValue: 1, maxValue: 50 },
]);

export default command;
