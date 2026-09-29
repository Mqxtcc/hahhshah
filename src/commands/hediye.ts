import { textCard } from "../utils/componentsV2.js";
import { MessageFlags } from "discord.js";
import type { Message } from "discord.js";
import type { Command } from "../types.js";
import { premiumEmbed, errorEmbed } from "../utils/embeds.js";
import { resolveTargetUserId } from "../events/messageCreate.js";
import { hasInviteBadge, getLastGiftAt, setLastGiftNow, clearLastGiftAt } from "../invites/store.js";
import { isPremium, ensurePremiumLoaded, grantGiftPremium } from "../premium/store.js";
import { withUserLock } from "../utils/mutex.js";

const GIFT_DAYS = 30; // hediye edilen premium süresi
const GIFT_COOLDOWN_DAYS = 30; // efsane başına hediye bekleme süresi
const MS_DAY = 24 * 60 * 60_000;

// 👑 Efsane Elçi (10 davet) özel komutu: 30 günde bir, bir arkadaşına
// 1 aylık premium hediye eder. Hediye alanın premium'u süreli — bitince düşer.
const command: Command = {
  name: "hediye",
  aliases: ["premium-hediye", "hediye-premium"],
  description: "👑 Efsane Elçi özel: bir arkadaşına 1 aylık premium hediye et (30 günde bir)",
  usage: "!hediye @kullanıcı",
  category: "fun",

  async execute(message: Message, args: string[]) {
    // Aynı anda iki !hediye çalışıp 30 günlük beklemeyi atlatamasın.
    return withUserLock(message.author.id, async () => {
      if (!(await hasInviteBadge(message.author.id, "efsane").catch(() => false))) {
        return message.reply({
      flags: MessageFlags.IsComponentsV2,
          components: [
            errorEmbed(
              "Efsane Elçi Özel",
              "Bu komut sadece 👑 **Efsane Elçi**'lere özel (10 davet). İlerlemeni görmek için `!davet` yaz.",
            ),
          ],
        });
      }

      const targetId = resolveTargetUserId(message, args);
      if (!targetId) {
        return message.reply({
      flags: MessageFlags.IsComponentsV2,
          components: [errorEmbed("Eksik Kullanıcı", "Kullanım: `!hediye @kullanıcı`")],
        });
      }
      if (targetId === message.author.id) {
        return message.reply({
      flags: MessageFlags.IsComponentsV2,
          components: [errorEmbed("Kendine Hediye Yok", "Kendine hediye veremezsin, bir arkadaşını seç. 🎁")],
        });
      }

      // Botlara hediye gitmesin — 30 günlük hak boşa giderdi.
      const targetUser = await message.client.users.fetch(targetId).catch(() => null);
      if (targetUser?.bot) {
        return message.reply({
      flags: MessageFlags.IsComponentsV2,
          components: [errorEmbed("Botlara Hediye Yok", "Botlara premium hediye edilemez. 🤖")],
        });
      }
      // Kullanıcı bulunamadıysa (fetch null) ilerleme — setLastGiftNow
      // verenin 30 günlük hakkını boşa yakardı.
      if (!targetUser) {
        return message.reply({
      flags: MessageFlags.IsComponentsV2,
          components: [errorEmbed("Kullanıcı Bulunamadı", "Bu kullanıcı bulunamadı, tekrar dene. 🤷")],
        });
      }

      // İki Efsane aynı hedefe aynı anda hediye verirse birinin hakkı boşa
      // gitmesin diye hedef kilidi de alınır (veren kilidi dışta kalır).
      return withUserLock(`gift:${targetId}`, async () => {
        await ensurePremiumLoaded();
        if (isPremium(targetId)) {
          return message.reply({
      flags: MessageFlags.IsComponentsV2,
            components: [errorEmbed("Zaten Premium", "Bu kullanıcı zaten premium — hediye boşa giderdi.")],
          });
        }

        // Fail-closed: bekleme durumu okunamazsa hediye verme, "sonra dene" de.
        let lastGift: Date | null;
        try {
          lastGift = await getLastGiftAt(message.author.id);
        } catch {
          return message.reply({
      flags: MessageFlags.IsComponentsV2,
            components: [errorEmbed("Olmadı", "Bekleme durumu okunamadı, birazdan tekrar dene.")],
          });
        }
        if (lastGift) {
          const msLeft = lastGift.getTime() + GIFT_COOLDOWN_DAYS * MS_DAY - Date.now();
          if (msLeft > 0) {
            const daysLeft = Math.ceil(msLeft / MS_DAY);
            return message.reply({
      flags: MessageFlags.IsComponentsV2,
              components: [
                errorEmbed(
                  "Bekleme Süresi",
                  `Bir sonraki hediyeni **${daysLeft} gün** sonra verebilirsin.`,
                ),
              ],
            });
          }
        }

        // Önce bekleme süresini rezerve et (hata yutulmuyor), sonra hediyeyi ver.
        // Hediye verilemezse rezervasyon geri alınır.
        try {
          await setLastGiftNow(message.author.id);
        } catch {
          return message.reply({
      flags: MessageFlags.IsComponentsV2,
            components: [errorEmbed("Olmadı", "Kayıt yapılamadı, birazdan tekrar dene.")],
          });
        }

        let expiresAt: Date | null;
        try {
          expiresAt = await grantGiftPremium(targetId, GIFT_DAYS, message.author.id);
        } catch {
          await clearLastGiftAt(message.author.id).catch(() => null);
          return message.reply({
      flags: MessageFlags.IsComponentsV2,
            components: [errorEmbed("Olmadı", "Hediye kaydedilemedi, birazdan tekrar dene.")],
          });
        }
        if (!expiresAt) {
          await clearLastGiftAt(message.author.id).catch(() => null);
          return message.reply({
      flags: MessageFlags.IsComponentsV2,
            components: [errorEmbed("Olmadı", "Hediye verilemedi — kullanıcı bu arada premium olmuş olabilir.")],
          });
        }

        const targetName = targetUser ? targetUser.username : `<@${targetId}>`;
        const dateStr = expiresAt.toLocaleDateString("tr-TR", { day: "numeric", month: "long" });

        // Hediye alana DM ile haber ver.
        await targetUser
          ?.send({ flags: MessageFlags.IsComponentsV2, components: textCard(`🎁 **Sana 1 aylık premium hediye edildi!**\n` +
              `<@${message.author.id}> 👑 Efsane Elçi ödülünü seninle paylaştı.\n` +
              `Tüm AI komutları **${dateStr}** tarihine kadar sınırsız. İyi eğlenceler!`,) })
          .catch(() => null);

        return message.reply({
      flags: MessageFlags.IsComponentsV2,
          components: [
            premiumEmbed(
              "🎁 Hediye Gönderildi!",
              `**${targetName}** adlı kullanıcıya **1 aylık premium** hediye ettin.\nBitiş: **${dateStr}**\n\nBir sonraki hediyeni 30 gün sonra verebilirsin.`,
            ),
          ],
        });
      });
    });
  },
};

export default command;
