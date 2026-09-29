import { MessageFlags } from "discord.js";
import type { Message } from "discord.js";
import type { Command } from "../../types.js";
import { infoEmbed, errorEmbed } from "../../utils/embeds.js";
import { parseDuration, formatDurationShort } from "../../utils/duration.js";
import { ensurePremiumLoaded, isPremium } from "../../premium/store.js";
import { addSlash } from "../../utils/slashBridge.js";

// Reaksiyon tabanlı anket. Seçenek verilmezse klasik 👍/👎 anketi,
// "seçenek1 | seçenek2 | ..." formatıyla en fazla 9 seçenekli çoktan
// seçmeli anket oluşturur.
// ⭐ Premium: --sure ile süreli anket — süre bitiminde otomatik sonuç özeti.
const NUMBER_EMOJIS = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣"];
const MAX_OPTIONS = 9;
const MAX_QUESTION_LENGTH = 250;
const MAX_OPTION_LENGTH = 100;
const MIN_POLL_MS = 60_000; // en az 1 dakika
const MAX_POLL_MS = 7 * 24 * 60 * 60_000; // en fazla 7 gün

const command: Command = {
  name: "anket",
  aliases: ["poll"],
  description: "Reaksiyonlu anket oluşturur",
  usage: "!anket <soru> [| seçenek1 | seçenek2 | ...] [--sure 1saat]  örn: !anket Pizza mı burger mi? | Pizza | Burger --sure 30dk",
  category: "fun",

  async execute(message: Message, args: string[]) {
    let raw = args.join(" ").trim();
    if (!raw) {
      return message.reply({ flags: MessageFlags.IsComponentsV2,
      components: [errorEmbed("Eksik Kullanım", `Kullanım: \`${command.usage}\``)] });
    }

    // ⭐ Premium: --sure <süre> bayrağını sondan ayıkla.
    let pollMs: number | null = null;
    const sureMatch = raw.match(/--sure\s+(\S+)\s*$/i);
    if (sureMatch) {
      raw = raw.slice(0, sureMatch.index).trim();
      await ensurePremiumLoaded().catch(() => null);
      if (!isPremium(message.author.id)) {
        return message.reply({
          flags: MessageFlags.IsComponentsV2,
          components: [errorEmbed("⭐ Premium Gerekli", "Süreli anket (`--sure`) premium üyelere özel.\nNasıl alınır? `!premiumbilgi` yaz.")],
        });
      }
      const parsed = parseDuration(sureMatch[1]);
      if (parsed === null || parsed < MIN_POLL_MS || parsed > MAX_POLL_MS) {
        return message.reply({
          flags: MessageFlags.IsComponentsV2,
          components: [errorEmbed("Geçersiz Süre", "Süre 1 dakika ile 7 gün arasında olmalı. Örnek: `--sure 30dk`, `--sure 2saat`")],
        });
      }
      pollMs = parsed;
    }

    const parts = raw.split("|").map((p) => p.trim()).filter(Boolean);
    const question = parts[0];
    const options = parts.slice(1);

    if (!question || question.length > MAX_QUESTION_LENGTH) {
      return message.reply({ flags: MessageFlags.IsComponentsV2,
      components: [errorEmbed("Hatalı Soru", `Soru boş olamaz ve en fazla ${MAX_QUESTION_LENGTH} karakter olabilir.`)] });
    }
    if (options.length === 1) {
      return message.reply({ flags: MessageFlags.IsComponentsV2,
      components: [errorEmbed("Eksik Seçenek", "En az 2 seçenek gerekli (ya da hiç seçenek verme, otomatik evet/hayır anketi olur).")] });
    }
    if (options.length > MAX_OPTIONS) {
      return message.reply({ flags: MessageFlags.IsComponentsV2,
      components: [errorEmbed("Çok Fazla Seçenek", `En fazla ${MAX_OPTIONS} seçenek olabilir.`)] });
    }
    if (options.some((o) => o.length > MAX_OPTION_LENGTH)) {
      return message.reply({ flags: MessageFlags.IsComponentsV2,
      components: [errorEmbed("Çok Uzun Seçenek", `Her seçenek en fazla ${MAX_OPTION_LENGTH} karakter olabilir.`)] });
    }

    const isYesNo = options.length === 0;
    const description = isYesNo
      ? question
      : `${question}\n\n${options.map((o, i) => `${NUMBER_EMOJIS[i]} ${o}`).join("\n")}`;

    const footer = pollMs
      ? `Anketi başlatan: ${message.author.tag} · ⏱️ ${formatDurationShort(pollMs)} sonra sonuçlanır`
      : `Anketi başlatan: ${message.author.tag}`;

    const sent = await message.reply({
      flags: MessageFlags.IsComponentsV2,
      components: [infoEmbed("📊 Anket", description, { footer })],
    });

    const reactions = isYesNo ? ["👍", "👎"] : NUMBER_EMOJIS.slice(0, options.length);
    for (const emoji of reactions) {
      await sent.react(emoji).catch(() => null);
    }

    // Süreli anket: bitiminde oyları sayıp sonuç özeti gönder.
    if (pollMs) {
      const labels = isYesNo ? ["Evet 👍", "Hayır 👎"] : options;
      const timer = setTimeout(() => {
        void (async () => {
          try {
            const msg = await message.channel.messages.fetch(sent.id).catch(() => null);
            if (!msg) return;
            const counts = reactions.map((emoji, i) => {
              const r = msg.reactions.cache.get(emoji) ?? msg.reactions.cache.find((x) => x.emoji.name === emoji);
              return { label: labels[i], votes: Math.max(0, (r?.count ?? 0) - 1) };
            });
            const total = counts.reduce((s, c) => s + c.votes, 0);
            const lines = counts
              .sort((a, b) => b.votes - a.votes)
              .map((c) => {
                const pct = total > 0 ? Math.round((c.votes / total) * 100) : 0;
                return `**${c.label}** — ${c.votes} oy (%${pct})`;
              });
            const winner = counts[0] && counts[0].votes > 0 ? `\n\n🏆 Kazanan: **${counts[0].label}**` : "";
            const resultChannel = message.channel;
            if ("send" in resultChannel) {
              await resultChannel
                .send({
                  flags: MessageFlags.IsComponentsV2,
                  components: [infoEmbed("📊 Anket Sonucu", `${question}\n\n${lines.join("\n")}${winner}\n\nToplam: ${total} oy`)],
                })
                .catch(() => null);
            }
          } catch {
            /* sonuç gönderilemezse sessiz geç */
          }
        })();
      }, pollMs);
      timer.unref?.();
    }
  },
};


addSlash(command, [
  { name: "soru", description: "Anket sorusu", type: "string", required: true },
  { name: "secenekler", description: "Seçenekler (| ile ayırın, en fazla 10)", type: "string" },
  { name: "sure", description: "Süre: 30dk, 2saat (premium)", type: "string" },
],
  (v) => {
    const soru = v.str("soru") ?? "";
    const sec = v.str("secenekler");
    const sure = v.str("sure");
    return [`${soru}${sec ? ` | ${sec}` : ""}${sure ? ` --sure ${sure}` : ""}`];
  }
);
export default command;
