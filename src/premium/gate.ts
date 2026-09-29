import type { Message } from "discord.js";
import { COMPONENTS_V2_FLAG } from "../utils/componentsV2.js";
import { premiumEmbed, warningEmbed } from "../utils/embeds.js";
import { checkAiRateLimit } from "../utils/rateLimit.js";
import { ensurePremiumLoaded, isPremium, checkDailyTrial, spendDailyTrial } from "./store.js";

/**
 * Premium olmayan kullanıcıların GÜNLÜK AI deneme hakkı (2026-09-28):
 * günde toplam 3, tüm AI komutları ortak havuzdan yer, gece yarısı
 * (Europe/Istanbul) yenilenir.
 */
export const DAILY_TRIAL_LIMIT = 3;

/**
 * Gemini / Groq / diğer ücretli-limitli kaynak tüketen komutların en başında
 * çağrılır. SADECE KONTROL EDER — hak harcamaz.
 *
 * Hak, AI BAŞARILI sonuç üretince komutun kendisi tarafından
 * consumeTrialUse() ile düşülür. Böylece başarısız denemeler (API hatası,
 * boş cevap vb.) kullanıcının hakkını yemez.
 *
 * Sıra:
 *  1) Rate limit (premium dahil, owner muaf) — spam / çift tıklama koruması
 *  2) Premium ise geç
 *  3) Günlük deneme hakkı varsa geç (harcamadan)
 *  4) Aksi halde reddet (haklar gece yarısı yenilenir)
 */
export async function requirePremiumOrTrial(
  message: Message,
  commandName: string,
): Promise<boolean> {
  if (!(await checkAiRateLimit(message, commandName))) return false;

  await ensurePremiumLoaded();
  const userId = message.author.id;

  if (isPremium(userId)) return true;

  const trial = await checkDailyTrial(userId, DAILY_TRIAL_LIMIT);

  if (trial.allowed) {
    if (trial.remaining === 1) {
      await message
        .reply({
          flags: COMPONENTS_V2_FLAG,
          components: [
            warningEmbed(
              "Son ücretsiz hakkın",
              `Bu, bugünkü SON ücretsiz AI hakkın. Başarılı olursa hakların bitecek — yarın yenilenir. Sınırsız kullanım için premium gerekir, bot sahibiyle iletişime geç.`,
            ),
          ],
        })
        .catch(() => null);
    }
    return true;
  }

  await message
    .reply({
      flags: COMPONENTS_V2_FLAG,
      components: [
        premiumEmbed(
          "Bugünkü ücretsiz hakların bitti",
          `Bugünkü ${DAILY_TRIAL_LIMIT} ücretsiz AI hakkını kullandın. Hakların yarın yenilenecek — sınırsız kullanmak için premium üyelik gerekiyor, bot sahibiyle iletişime geç.`,
        ),
      ],
    })
    .catch(() => null);
  return false;
}

/**
 * AI komutu BAŞARILI olunca çağrılır — günlük deneme hakkını ŞİMDİ harcar.
 * Premium/owner için no-op (onların hakkı sınırsız).
 * Komut, AI'dan geçerli sonuç aldıktan hemen sonra bunu çağırmalı.
 */
export async function consumeTrialUse(message: Message, commandName: string): Promise<void> {
  try {
    await ensurePremiumLoaded();
    const userId = message.author.id;
    if (isPremium(userId)) return;
    // Harcama anında limiti atomik şekilde tekrar kontrol et: komut başındaki
    // kontrol ile bu harcama arasında limit dolmuşsa hak harcanmaz.
    spendDailyTrial(userId, DAILY_TRIAL_LIMIT);
  } catch (err) {
    console.error(`[trial] hak düşmedi (${commandName}):`, err);
  }
}
