import { MessageFlags } from "discord.js";
import crypto from "node:crypto";
import type { Message } from "discord.js";
import type { Command } from "../../types.js";
import { infoEmbed, errorEmbed } from "../../utils/embeds.js";
import { EMOJIS } from "../../utils/emojis.js";
import { ensurePremiumLoaded, isPremium } from "../../premium/store.js";
import { addSlash } from "../../utils/slashBridge.js";

const CHARSET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#$%^&*()-_=+";
const MIN_LENGTH = 6;
const MAX_LENGTH = 64;
const DEFAULT_LENGTH = 16;

// ⭐ Premium: kelime-tabanlı şifre için Türkçe kelime havuzu (xkcd tarzı).
// Hem güçlü hem akılda kalıcı: 5 kelime + sayı + sembol.
const WORDS = [
  "aslan", "bulut", "deniz", "elma", "fırtına", "güneş", "hazine", "ırmak", "kelebek", "lale",
  "orman", "pencere", "rüzgar", "sahil", "toprak", "uçurtma", "volkan", "yıldız", "zeytin", "armut",
  "bahar", "çiçek", "dağ", "efsane", "fil", "gemi", "horoz", "ıhlamur", "kale", "limon",
  "martı", "nar", "okyanus", "papatya", "radar", "şelale", "tren", "uydu", "vazo", "yol",
  "zürafa", "ada", "balık", "çınar", "dere", "elmas", "fener", "gölge", "harita", "incir",
  "kardan", "leopar", "mavi", "nehir", "oymak", "pilot", "robot", "saray", "tayfun", "uçak",
  "vadi", "yamaç", "zar", "ağaç", "beyaz", "çöl", "demir", "ece", "fırt", "gitar",
  "hilal", "ışık", "kaplan", "lamba", "maymun", "nilüfer", "opera", "puma", "roket", "saz",
];

function pickWord(): string {
  return WORDS[crypto.randomInt(0, WORDS.length)];
}

/** "kelebek-42-deniz-fırtına-7-elma!" tarzı akılda kalıcı güçlü şifre. */
function generateWordPassword(): string {
  const words = [pickWord(), pickWord(), pickWord(), pickWord(), pickWord()];
  const sep = ["-", "_", ".", "!"][crypto.randomInt(0, 4)];
  const num = crypto.randomInt(10, 99);
  const sym = "!@#$%"[crypto.randomInt(0, 5)];
  return words.join(sep) + sep + num + sym;
}

// crypto.randomInt kullanıyoruz (Math.random DEĞİL) çünkü bu bir şifre
// üretici — tahmin edilebilir bir PRNG ile üretilen "şifre" güvenlik
// açısından anlamsız olur.
function generatePassword(length: number): string {
  let result = "";
  for (let i = 0; i < length; i++) {
    result += CHARSET[crypto.randomInt(0, CHARSET.length)];
  }
  return result;
}

const command: Command = {
  name: "sifre",
  aliases: ["şifre", "password", "pw"],
  description: "Rastgele, güvenli bir şifre üretir (DM üzerinden gönderir)",
  usage: "!sifre [uzunluk (6-64), varsayılan 16] | !sifre kelime (⭐ premium)",
  category: "fun",

  async execute(message: Message, args: string[]) {
    // ⭐ Premium: kelime-tabanlı, akılda kalıcı güçlü şifre.
    if (args[0]?.toLocaleLowerCase("tr-TR") === "kelime") {
      await ensurePremiumLoaded().catch(() => null);
      if (!isPremium(message.author.id)) {
        return await message.reply({
          flags: MessageFlags.IsComponentsV2,
          components: [errorEmbed("⭐ Premium Gerekli", "Kelime şifre modu premium üyelere özel.\nNasıl alınır? `!premiumbilgi` yaz.")],
        });
      }
      return sendPassword(message, generateWordPassword());
    }

    let length = DEFAULT_LENGTH;
    if (args[0]) {
      const parsed = Number.parseInt(args[0], 10);
      if (!Number.isFinite(parsed) || parsed < MIN_LENGTH || parsed > MAX_LENGTH) {
        return await message.reply({
          flags: MessageFlags.IsComponentsV2,
          components: [errorEmbed("Hatalı Uzunluk", `Uzunluk ${MIN_LENGTH} ile ${MAX_LENGTH} arasında olmalı.`)]
        });
      }
      length = parsed;
    }

    const password = generatePassword(length);
    return sendPassword(message, password);
  },
};

/** Şifreyi DM'den gönderir; DM kapalıysa kanalda 15 sn sonra silinecek şekilde. */
async function sendPassword(message: Message, password: string): Promise<unknown> {
  try {
    await message.author.send({ flags: MessageFlags.IsComponentsV2,
    components: [infoEmbed("🔑 Üretilen Şifre", `\`\`\`${password}\`\`\``, {
      footer: "Bu mesajı gördükten sonra silebilirsin.",
    })] });
    return await message.reply({ flags: MessageFlags.IsComponentsV2,
    components: [infoEmbed("🔑 Şifre Üretildi", "Şifreni DM olarak gönderdim, kontrol et.")] }).catch(() => null);
  } catch {
    const sent = await message.reply({
      flags: MessageFlags.IsComponentsV2,
      components: [infoEmbed("🔑 Üretilen Şifre", `\`\`\`${password}\`\`\`\n${EMOJIS.alert} DM'in kapalı olduğu için buraya yazdım, gördükten sonra mesajı silmeni öneririm.`)],
    });
    setTimeout(() => sent.delete().catch(() => null), 15_000);
  }
}


addSlash(command, [
  { name: "tur", description: "Uzunluk (6-64) veya 'kelime' (premium)", type: "string" },
]);

export default command;
