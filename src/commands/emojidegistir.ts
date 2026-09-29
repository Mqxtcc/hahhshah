
import { MessageFlags, type Message } from "discord.js";
import type { Command } from "../types.js";
import { db, emojiOverridesTable } from "../db/index.js";
import { eq } from "../db/jsonOrm.js";
import { getGuildPrefix, requireOwner } from "../events/messageCreate.js";
import {
  errorCard,
  loadEmojiOverrides,
  panelCard,
  removeEmojiOverride,
  setEmojiOverride,
} from "../utils/componentsV2.js";

const CUSTOM_EMOJI = /^<a?:[A-Za-z0-9_]+:\d{15,25}>$/;
const UNICODE_EMOJI = /\p{Extended_Pictographic}/u;

const emojiOverridesCommand: Command = {
  name: "emojidegistir",
  aliases: ["emoji-degistir"],
  description: "Components V2 mesajlarında unicode emojileri özel emojilerle değiştirir (owner-only). Özel emojiler yalnızca botun üyesi olduğu sunuculardaki emojilerse düzgün görünür.",
  usage: "emojidegistir <unicode-emoji> <custom-emoji> | liste | sil <unicode-emoji>",
  category: "owner",
  async execute(message: Message, args: string[]) {
    if (!(await requireOwner(message))) return;
    const prefix = getGuildPrefix(message.guild?.id);

    try {
      if (args[0]?.toLowerCase() === "liste") {
        const rows = await db.select().from(emojiOverridesTable);
        const lines = rows.length
          ? rows.map((row) => `» \`${row.unicode}\` → ${row.custom}`).join("\n")
          : "Kayıtlı emoji eşleşmesi yok.";
        await message.reply({
          flags: MessageFlags.IsComponentsV2,
          components: [panelCard({
            title: "Emoji Eşleşmeleri",
            description: lines,
            stats: `Toplam ${rows.length} eşleşme`,
          })],
        }).catch(() => null);
        return;
      }

      if (args[0]?.toLowerCase() === "sil") {
        const unicode = args[1];
        if (!unicode || !UNICODE_EMOJI.test(unicode)) {
          await message.reply({
            flags: MessageFlags.IsComponentsV2,
            components: [errorCard({
              title: "Eksik veya geçersiz emoji",
              usage: true,
              description: `Kullanım: \`${prefix}emojidegistir sil <unicode-emoji>\``,
            })],
          }).catch(() => null);
          return;
        }
        const existing = await db.select().from(emojiOverridesTable).where(eq(emojiOverridesTable.unicode, unicode));
        if (!existing.length) {
          await message.reply({
            flags: MessageFlags.IsComponentsV2,
            components: [errorCard({ title: "Eşleşme bulunamadı", description: `\`${unicode}\` için kayıt yok.` })],
          }).catch(() => null);
          return;
        }
        await db.delete(emojiOverridesTable).where(eq(emojiOverridesTable.unicode, unicode));
        removeEmojiOverride(unicode);
        await message.reply({
          flags: MessageFlags.IsComponentsV2,
          components: [panelCard({ title: "Eşleşme silindi", description: `\`${unicode}\` emoji eşleşmesi kaldırıldı.` })],
        }).catch(() => null);
        return;
      }

      const unicode = args[0];
      const custom = args[1];
      if (!unicode || !custom || !UNICODE_EMOJI.test(unicode) || !CUSTOM_EMOJI.test(custom)) {
        await message.reply({
          flags: MessageFlags.IsComponentsV2,
          components: [errorCard({
            title: "Geçersiz kullanım",
            usage: true,
            description: [
              `\`${prefix}emojidegistir <unicode-emoji> <custom-emoji>\``,
              `\`${prefix}emojidegistir liste\``,
              `\`${prefix}emojidegistir sil <unicode-emoji>\``,
              "Özel emoji biçimi: `<:ad:id>` veya `<a:ad:id>`.",
            ].join("\n"),
            stats: "Özel emojiler yalnızca botun üyesi olduğu sunuculardaki emojilerse düzgün görünür.",
          })],
        }).catch(() => null);
        return;
      }

      const existing = await db.select().from(emojiOverridesTable).where(eq(emojiOverridesTable.unicode, unicode));
      if (existing.length) {
        await db.update(emojiOverridesTable).set({ custom }).where(eq(emojiOverridesTable.unicode, unicode));
      } else {
        await db.insert(emojiOverridesTable).values({ unicode, custom });
      }
      setEmojiOverride(unicode, custom);
      await message.reply({
        flags: MessageFlags.IsComponentsV2,
        components: [panelCard({
          title: "Emoji eşleşmesi kaydedildi",
          description: `\`${unicode}\` → ${custom}`,
          stats: "Özel emojiler yalnızca botun üyesi olduğu sunuculardaki emojilerse düzgün görünür.",
        })],
      }).catch(() => null);
    } catch (error) {
      console.error("emoji eşleşmeleri işlenemedi:", error);
      await loadEmojiOverrides().catch(() => undefined);
      await message.reply({
        flags: MessageFlags.IsComponentsV2,
        components: [errorCard({ title: "Emoji kaydı güncellenemedi", description: "Veritabanı işlemi başarısız oldu." })],
      }).catch(() => null);
    }
  },
};

export default emojiOverridesCommand;
