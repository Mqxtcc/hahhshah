import { MessageFlags } from "discord.js";
import type { Message } from "discord.js";
import type { Command } from "../types.js";
import { infoEmbed, errorEmbed } from "../utils/embeds.js";
import { parseDuration } from "../utils/duration.js";
import { createReminder, countActiveReminders, listReminders, deleteReminder } from "../utils/reminders.js";
import { ensurePremiumLoaded, isPremium } from "../premium/store.js";
import { addSlash } from "../utils/slashBridge.js";

const MIN_MS = 10_000; // 10 saniyeden kısa hatırlatıcıya izin verme (spam riski)
const MAX_MS = 7 * 24 * 60 * 60_000; // 7 gün
const MAX_ACTIVE_PER_USER = 10;
/** ⭐ Premium: daha fazla bekleyen hatırlatıcı. */
const PREMIUM_MAX_ACTIVE = 30;

const command: Command = {
  name: "hatirlat",
  aliases: ["remind", "hatırlat"],
  description: "Belirtilen süre sonra sana (veya kanala) hatırlatma gönderir",
  usage: "!hatirlat <süre> <mesaj>  örn: !hatirlat 10dk su iç | !hatirlat 1g2saat toplantı | !hatirlat liste | !hatirlat sil <id>",
  category: "genel",

  async execute(message: Message, args: string[]) {
    const sub = args[0]?.toLocaleLowerCase("tr-TR");

    // --- Alt komut: !hatirlat liste ---
    if (sub === "liste" || sub === "list") {
      const rows = await listReminders(message.author.id).catch(() => []);
      if (rows.length === 0) {
        return message.reply({
      flags: MessageFlags.IsComponentsV2, components: [infoEmbed("⏰ Bekleyen Hatırlatıcı Yok", "Kurulu bir hatırlatıcın yok.")] });
      }
      const lines = rows.slice(0, 20).map((r) => {
        const note = r.note.length > 60 ? `${r.note.slice(0, 60)}…` : r.note;
        return `\`#${r.id}\` <t:${Math.floor(new Date(r.dueAt).getTime() / 1000)}:R> — ${note}`;
      });
      return message.reply({
      flags: MessageFlags.IsComponentsV2,
        components: [
          infoEmbed(
            "⏰ Bekleyen Hatırlatıcılar",
            `${lines.join("\n")}${rows.length > 20 ? `\n…ve ${rows.length - 20} tane daha` : ""}\n\nİptal etmek için: \`!hatirlat sil <id>\``,
          ),
        ],
      });
    }

    // --- Alt komut: !hatirlat sil <id> ---
    if (sub === "sil" || sub === "delete" || sub === "kaldır") {
      const id = Number.parseInt(args[1] ?? "", 10);
      if (!Number.isFinite(id) || id <= 0) {
        return message.reply({
      flags: MessageFlags.IsComponentsV2, components: [errorEmbed("Geçersiz ID", "Kullanım: `!hatirlat sil <id>`\nID'leri `!hatirlat liste` ile görebilirsin.")] });
      }
      const ok = await deleteReminder(message.author.id, id).catch(() => false);
      if (!ok) {
        return message.reply({
      flags: MessageFlags.IsComponentsV2, components: [errorEmbed("Bulunamadı", "Bu ID'ye sahip bekleyen bir hatırlatıcın yok.")] });
      }
      return message.reply({
      flags: MessageFlags.IsComponentsV2, components: [infoEmbed("🗑️ Hatırlatıcı Silindi", `\`#${id}\` numaralı hatırlatıcın iptal edildi.`)] });
    }

    if (args.length < 2) {
      return message.reply({
      flags: MessageFlags.IsComponentsV2, components: [errorEmbed("Eksik Kullanım", `Kullanım: \`${command.usage}\`\nBirimler: sn, dk, saat, g (gün)`)] });
    }

    const durationMs = parseDuration(args[0]);
    const note = args.slice(1).join(" ").trim();

    if (durationMs === null || durationMs <= 0) {
      return message.reply({
      flags: MessageFlags.IsComponentsV2, components: [errorEmbed("Geçersiz Süre", "Süre formatı hatalı. Örnek: `10dk`, `2saat`, `1g`, `1g2saat30dk`")] });
    }
    if (durationMs < MIN_MS) {
      return message.reply({
      flags: MessageFlags.IsComponentsV2, components: [errorEmbed("Çok Kısa", "En az 10 saniyelik bir süre gir.")] });
    }
    if (durationMs > MAX_MS) {
      return message.reply({
      flags: MessageFlags.IsComponentsV2, components: [errorEmbed("Çok Uzun", "En fazla 7 gün sonrasına hatırlatıcı kurabilirsin.")] });
    }
    if (!note) {
      return message.reply({
      flags: MessageFlags.IsComponentsV2, components: [errorEmbed("Eksik Mesaj", "Ne hatırlatmamı istediğini de yazmalısın.")] });
    }

    await ensurePremiumLoaded().catch(() => null);
    const maxActive = isPremium(message.author.id) ? PREMIUM_MAX_ACTIVE : MAX_ACTIVE_PER_USER;
    const activeCount = await countActiveReminders(message.author.id).catch(() => 0);
    if (activeCount >= maxActive) {
      return message.reply({
      flags: MessageFlags.IsComponentsV2,
        components: [
          errorEmbed(
            "Limit Doldu",
            `Aynı anda en fazla ${maxActive} bekleyen hatırlatıcın olabilir.` +
              (maxActive === MAX_ACTIVE_PER_USER ? "\n⭐ Premium ile bu limit 30'a çıkar." : ""),
          ),
        ],
      });
    }

    const dueAt = new Date(Date.now() + durationMs);
    try {
      await createReminder(message.client, {
        userId: message.author.id,
        guildId: message.guild?.id ?? null,
        channelId: message.channel.id,
        note,
        dueAt,
      });
    } catch {
      return message.reply({
      flags: MessageFlags.IsComponentsV2, components: [errorEmbed("Olmadı", "Hatırlatıcı kurulamadı, birazdan tekrar dene.")] });
    }

    return message.reply({
      flags: MessageFlags.IsComponentsV2,
      components: [
        infoEmbed(
          "✅ Hatırlatıcı Kuruldu",
          `<t:${Math.floor(dueAt.getTime() / 1000)}:R> hatırlatacağım:\n> ${note}\n\n💾 Kalıcı kayıt — bot yeniden başlasa bile kaybolmaz.`,
        ),
      ],
    });
  },
};


addSlash(command, [
  { name: "islem", description: "Yapılacak işlem", type: "string", required: true, choices: [{ name: "Hatırlatma kur", value: "kur" }, { name: "Listele", value: "liste" }, { name: "Sil", value: "sil" }] },
  { name: "sure", description: "Süre: 10dk, 2saat, 1g2saat", type: "string" },
  { name: "not", description: "Hatırlatma notu", type: "string" },
  { name: "kayit", description: "Silinecek hatırlatmanın ID'si", type: "string" },
],
  (v) => {
    const islem = v.str("islem") ?? "kur";
    if (islem === "liste") return ["liste"];
    if (islem === "sil") return ["sil", v.str("kayit") ?? ""].filter(Boolean);
    return [v.str("sure") ?? "", v.str("not") ?? ""].filter(Boolean);
  }
);
export default command;
