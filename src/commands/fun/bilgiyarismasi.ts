import { resolveEmojis, V2CardBuilder, errorCard, textCard } from "../../utils/componentsV2.js";
import { MessageFlags,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  type Message,
} from "discord.js";
import type { Command } from "../../types.js";
import { DEFAULT_PREFIX } from "../../config.js";
import { COLORS } from "../../utils/embeds.js";
import { generateWithGemini } from "../../utils/gemini.js";
import { requirePremiumOrTrial, consumeTrialUse } from "../../premium/gate.js";
import { isPremium } from "../../premium/store.js";
import { addQuizWin } from "../../utils/quizStore.js";
import { EMOJIS } from "../../utils/emojis.js";
import { addSlash } from "../../utils/slashBridge.js";

// !bilgiyarismasi [kategori] — Gemini'ye çoktan seçmeli bir bilgi yarışması
// sorusu ürettirip 4 butonla (A/B/C/D) sunucuda "kim önce doğru bilecek"
// yarışması başlatır. İlk doğru cevaplayan sunucu skoruna 1 galibiyet
// yazdırır (bkz. utils/quizStore.ts).

const QUESTION_TIME_MS = 30_000;
const LETTERS = ["A", "B", "C", "D"] as const;

// Aynı kanalda aynı anda birden fazla yarışma başlamasını önler — hem
// karışıklığı hem de gereksiz Gemini isteklerini engeller.
const activeChannels = new Set<string>();

const SYSTEM_PROMPT = `Sen bir Discord bilgi yarışması sorusu üreten bir asistansın.
Kullanıcının verdiği konu/kategoriye uygun, TEK bir çoktan seçmeli soru üret.

KURALLAR:
- Soru Türkçe olmalı, orta zorlukta, doğrulanabilir/genel kültür niteliğinde bir bilgi içermeli.
- Tam olarak 4 şık üret. Şıklar birbirinden açıkça farklı ve makul uzunlukta olmalı.
- Şıklardan SADECE BİRİ doğru olmalı, diğerleri gerçekten yanlış olmalı (belirsiz/tartışmalı sorulardan kaçın).
- Cevabını SADECE aşağıdaki JSON formatında ver, başka HİÇBİR metin ekleme (açıklama, markdown kod bloğu, giriş cümlesi YOK):
{"soru": "...", "secenekler": ["...", "...", "...", "..."], "dogruIndex": 0}
- "dogruIndex" 0-3 arası bir tam sayı olmalı ve "secenekler" dizisindeki doğru şıkkın index'ini göstermeli.`;

function isQuizRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

interface QuizQuestion {
  soru: string;
  secenekler: [string, string, string, string];
  dogruIndex: 0 | 1 | 2 | 3;
}

function parseQuizJson(raw: string): QuizQuestion | null {
  // Gemini bazen ```json ... ``` kod bloğuna sarabiliyor — buna karşı toleranslı ol.
  const stripped = raw.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    return null;
  }
  if (
    !isQuizRecord(parsed) ||
    typeof parsed.soru !== "string" ||
    !Array.isArray(parsed.secenekler) ||
    parsed.secenekler.length !== 4 ||
    !parsed.secenekler.every((s: unknown) => typeof s === "string" && s.trim().length > 0) ||
    typeof parsed.dogruIndex !== "number" ||
    !Number.isInteger(parsed.dogruIndex) ||
    parsed.dogruIndex < 0 ||
    parsed.dogruIndex > 3
  ) {
    return null;
  }
  return {
    soru: parsed.soru.trim(),
    secenekler: parsed.secenekler.map((s: string) => s.trim()) as [string, string, string, string],
    dogruIndex: parsed.dogruIndex as 0 | 1 | 2 | 3,
  };
}

function questionEmbed(q: QuizQuestion, secondsLeft: number, revealed: false | number, winner?: string) {
  const embed = new V2CardBuilder()
    .setColor(revealed === false ? COLORS.info : COLORS.success)
    .setTitle("🧠 Bilgi Yarışması")
    .setDescription(q.soru)
    .addFields(
      q.secenekler.map((opt, i) => ({
        name: `${LETTERS[i]}${revealed !== false && i === q.dogruIndex ? ` ${EMOJIS.success}` : ""}`,
        value: opt,
        inline: false,
      })),
    )
    .setFooter({ text: revealed === false ? `${secondsLeft} saniyen var — doğru cevabı ilk tıklayan kazanır!` : "Bilgi Yarışması" })
    .setTimestamp();
  if (winner) {
    embed.addFields({ name: "🏆 Kazanan", value: winner, inline: false });
  } else if (revealed !== false) {
    embed.addFields({ name: "😶 Sonuç", value: "Süre doldu, kimse doğru bilemedi.", inline: false });
  }
  return embed;
}

function buildButtons(disabled: boolean): ActionRowBuilder<ButtonBuilder>[] {
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    LETTERS.map((letter, i) =>
      new ButtonBuilder()
        .setCustomId(`quiz_answer_${i}`)
        .setLabel(resolveEmojis(letter))
        .setStyle(ButtonStyle.Primary)
        .setDisabled(disabled),
    ),
  );
  return [row];
}

const command: Command = {
  name: "bilgiyarismasi",
  aliases: ["quiz", "yarisma", "bilgiyarışması"],
  description: "AI destekli çoktan seçmeli bilgi yarışması başlatır",
  usage: `${DEFAULT_PREFIX}bilgiyarismasi [konu]`,
  category: "fun",

  async execute(message: Message, args: string[]) {
    if (!message.guild || !message.channel.isSendable()) return;

    if (activeChannels.has(message.channel.id)) {
      return message.reply({ flags: MessageFlags.IsComponentsV2, components: [errorCard({ description: `${EMOJIS.error} Bu kanalda zaten devam eden bir yarışma var, önce onun bitmesini bekle.` })] });
    }

    if (!(await requirePremiumOrTrial(message, "bilgiyarismasi"))) return;

    const topic = args.join(" ").trim() || "genel kültür";

    activeChannels.add(message.channel.id);
    const loadingMsg = await message
      .reply({ flags: MessageFlags.IsComponentsV2, components: textCard(`${EMOJIS.loading} \`${topic}\` konusunda bir soru hazırlanıyor...`) })
      .catch(() => null);

    try {
      let question: QuizQuestion | null = null;
      // Gemini bazen JSON dışı bir şey döndürebilir — bir kez daha deniyoruz,
      // yine olmazsa kullanıcıya açıkça hata gösteriyoruz (sessizce yutmuyoruz).
      for (let attempt = 0; attempt < 2 && !question; attempt++) {
        const raw = await generateWithGemini(SYSTEM_PROMPT, `Konu: ${topic}`);
        question = parseQuizJson(raw);
      }

      if (!question) {
        await loadingMsg
          ?.edit({ flags: MessageFlags.IsComponentsV2, components: [errorCard({ description: `${EMOJIS.error} Soru üretilemedi (Gemini geçersiz bir cevap verdi), tekrar dene.` })] })
          .catch(() => null);
        return;
      }

      // ✅ Soru başarıyla üretildi → deneme hakkını şimdi harca.
      await consumeTrialUse(message, "bilgiyarismasi");

      const q = question;
      const secondsLeft = Math.floor(QUESTION_TIME_MS / 1000);
      const quizMsg = await (loadingMsg
        ? loadingMsg.edit({ flags: MessageFlags.IsComponentsV2,
        components: [questionEmbed(q, secondsLeft, false), ...buildButtons(false)] })
        : message.channel.send({ flags: MessageFlags.IsComponentsV2,
        components: [questionEmbed(q, secondsLeft, false), ...buildButtons(false)] }));

      const answeredUsers = new Set<string>();

      const collector = quizMsg.createMessageComponentCollector({
        componentType: ComponentType.Button,
        time: QUESTION_TIME_MS,
      });

      collector.on("collect", (interaction) => {
        void (async () => {
        if (!interaction.customId.startsWith("quiz_answer_")) return;

        // Aynı kullanıcı bir kere yanlış tıklayıp tekrar deneyemesin —
        // her kullanıcının bu soruda tek hakkı var (gerçek yarışma hissi için).
        if (answeredUsers.has(interaction.user.id)) {
          await interaction.reply({ flags: MessageFlags.IsComponentsV2,
          components: textCard("Bu soruda zaten bir hakkını kullandın."), ephemeral: true }).catch(() => null);
          return;
        }
        answeredUsers.add(interaction.user.id);

        const chosenIndex = Number(interaction.customId.replace("quiz_answer_", ""));
        const correct = chosenIndex === q.dogruIndex;

        if (!correct) {
          await interaction.reply({ flags: MessageFlags.IsComponentsV2,
          components: [errorCard({ description: `${EMOJIS.error} Yanlış cevap, başkası dener.` })], ephemeral: true }).catch(() => null);
          return;
        }

        collector.stop("answered");
        // ⭐ Premium: doğru cevap 2 galibiyet sayılır.
        const doublePoints = isPremium(interaction.user.id);
        await interaction.reply({ flags: MessageFlags.IsComponentsV2,
        components: textCard(doublePoints ? `${EMOJIS.success} Doğru bildin! ⭐ Premium 2x puan!` : `${EMOJIS.success} Doğru bildin!`), ephemeral: true }).catch(() => null);
        await addQuizWin(message.guild!.id, interaction.user.id).catch((err) =>
          console.error("yarışma skoru kaydolmadı:", err),
        );
        if (doublePoints) {
          await addQuizWin(message.guild!.id, interaction.user.id).catch((err) =>
            console.error("yarışma 2x skoru kaydolmadı:", err),
          );
        }
        await quizMsg
          .edit({ flags: MessageFlags.IsComponentsV2,
          components: [questionEmbed(q, 0, q.dogruIndex, `${interaction.user}`), ...buildButtons(true)] })
          .catch(() => null);
        })().catch((error: unknown) => console.error("yarışma etkileşimi patladı:", error));
      });

      collector.on("end", (_collected, reason) => {
        activeChannels.delete(message.channel.id);
        if (reason === "answered") return; // zaten yukarıda güncellendi
        void quizMsg
          .edit({ flags: MessageFlags.IsComponentsV2,
          components: [questionEmbed(q, 0, q.dogruIndex), ...buildButtons(true)] })
          .catch(() => null);
      });
    } catch (err) {
      activeChannels.delete(message.channel.id);
      console.error("bilgiyarışması patladı la:", err);
      await loadingMsg?.edit({ flags: MessageFlags.IsComponentsV2, components: [errorCard({ description: `${EMOJIS.error} Hata oluştu: ${err instanceof Error ? err.message : String(err)}` })] }).catch(() => null);
      return;
    }

    return;
  },
};


addSlash(command, [
  { name: "konu", description: "Yarışma konusu (boş bırakılabilir)", type: "string" },
]);

export default command;
