import { MessageFlags } from "discord.js";
import type { Message } from "discord.js";
import type { Command } from "../../types.js";
import { infoEmbed, errorEmbed } from "../../utils/embeds.js";
import { addSlash } from "../../utils/slashBridge.js";

interface Sign {
  name: string;
  aliases: string[];
  dates: string;
  emoji: string;
}

const SIGNS: Sign[] = [
  { name: "koç", aliases: ["koc"], dates: "21 Mart – 20 Nisan", emoji: "♈" },
  { name: "boğa", aliases: ["boga"], dates: "21 Nisan – 21 Mayıs", emoji: "♉" },
  { name: "ikizler", aliases: [], dates: "22 Mayıs – 22 Haziran", emoji: "♊" },
  { name: "yengeç", aliases: ["yengec"], dates: "23 Haziran – 22 Temmuz", emoji: "♋" },
  { name: "aslan", aliases: [], dates: "23 Temmuz – 22 Ağustos", emoji: "♌" },
  { name: "başak", aliases: ["basak"], dates: "23 Ağustos – 22 Eylül", emoji: "♍" },
  { name: "terazi", aliases: [], dates: "23 Eylül – 22 Ekim", emoji: "♎" },
  { name: "akrep", aliases: [], dates: "23 Ekim – 21 Kasım", emoji: "♏" },
  { name: "yay", aliases: [], dates: "22 Kasım – 21 Aralık", emoji: "♐" },
  { name: "oğlak", aliases: ["oglak"], dates: "22 Aralık – 21 Ocak", emoji: "♑" },
  { name: "kova", aliases: [], dates: "22 Ocak – 19 Şubat", emoji: "♒" },
  { name: "balık", aliases: ["balik"], dates: "20 Şubat – 20 Mart", emoji: "♓" },
];

const COMMENTS = [
  "Bugün enerjin yüksek; yarım kalan işleri toparlamak için ideal bir gün.",
  "Sabrın sınanabilir — derin bir nefes al, tepkini ertele.",
  "Beklenmedik bir haber kapını çalabilir; açık fikirli ol.",
  "Maddi konularda dikkatli ol, ani harcamalardan kaçın.",
  "Sevdiklerinle vakit geçirmek ruhuna iyi gelecek.",
  "İş yerinde fark ediliyorsun; emeğinin karşılığını alacaksın.",
  "Bugün risk almak için uygun değil, planlarına sadık kal.",
  "Yaratıcılığın tavan yapıyor; aklındaki fikri not al.",
  "Eski bir dosttan haber alabilirsin, şaşırma.",
  "Sağlığına özen göster; küçük bir yürüyüş bile iyi gelir.",
  "Karar verirken kalbinle mantığını dengele.",
  "Şans senden yana; küçük bir adım büyük kapı açabilir.",
  "İletişimde yanlış anlaşılmalara dikkat, net konuş.",
  "Bugün dinlenmek de bir ilerlemedir; kendine izin ver.",
  "Finansal bir fırsat çıkabilir, detayları iyi oku.",
  "Aşk hayatında tatlı bir sürpriz seni bekliyor olabilir.",
  "Sorumlulukların artıyor ama altından kalkacaksın.",
  "Bugün öğrendiğin bir bilgi ileride çok işine yarayacak.",
  "Çevrendekilere karşı daha anlayışlı ol, karşılığını alırsın.",
  "Hedeflerine bir adım daha yaklaşıyorsun, devam et.",
];

const LUCKY = ["aşk", "para", "kariyer", "sağlık", "aile"];

function hashStr(s: string): number {
  let h = 2166136261;
  for (const ch of s) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

/** Günün yorumu — aynı burç aynı gün hep aynı yorumu alır. */
export function dailyHoroscope(signName: string, dateStr: string): { comment: string; lucky: string; score: number } {
  const h = hashStr(`${signName}:${dateStr}`);
  return {
    comment: COMMENTS[h % COMMENTS.length],
    lucky: LUCKY[Math.floor(h / COMMENTS.length) % LUCKY.length],
    score: (h % 5) + 1,
  };
}

function findSign(input: string): Sign | null {
  const norm = input.toLocaleLowerCase("tr-TR").trim();
  return SIGNS.find((s) => s.name === norm || s.aliases.includes(norm)) ?? null;
}

const command: Command = {
  name: "burç",
  aliases: ["burc", "horoscope"],
  description: "Günlük burç yorumunu gösterir",
  usage: "!burç <koç|boğa|ikizler|yengeç|aslan|başak|terazi|akrep|yay|oğlak|kova|balık>",
  category: "fun",

  async execute(message: Message, args: string[]) {
    const sign = args[0] ? findSign(args[0]) : null;
    if (!sign) {
      return message.reply({
        flags: MessageFlags.IsComponentsV2,
        components: [
          errorEmbed(
            "Hatalı Kullanım",
            `Burcunu yazmalısın. Kullanım: \`${command.usage}\`\nÖrn: \`!burç aslan\``,
          ),
        ],
      });
    }
    const today = new Date().toLocaleDateString("tr-TR");
    const dateKey = new Date().toISOString().slice(0, 10);
    const { comment, lucky, score } = dailyHoroscope(sign.name, dateKey);
    return message.reply({
      flags: MessageFlags.IsComponentsV2,
      components: [
        infoEmbed(
          `${sign.emoji} ${sign.name[0].toLocaleUpperCase("tr-TR") + sign.name.slice(1)} — ${today}`,
          `${comment}\n\n🍀 Şanslı alanın: **${lucky}**\n⭐ Günün puanı: **${"★".repeat(score)}${"☆".repeat(5 - score)}**\n\n_${sign.dates}_`,
        ),
      ],
    });
  },
};

addSlash(
  command,
  [
    {
      name: "burc",
      description: "Burcun",
      type: "string",
      required: true,
      choices: [
        { name: "♈ koç", value: "koç" },
        { name: "♉ boğa", value: "boğa" },
        { name: "♊ ikizler", value: "ikizler" },
        { name: "♋ yengeç", value: "yengeç" },
        { name: "♌ aslan", value: "aslan" },
        { name: "♍ başak", value: "başak" },
        { name: "♎ terazi", value: "terazi" },
        { name: "♏ akrep", value: "akrep" },
        { name: "♐ yay", value: "yay" },
        { name: "♑ oğlak", value: "oğlak" },
        { name: "♒ kova", value: "kova" },
        { name: "♓ balık", value: "balık" },
      ],
    },
  ],
  (v) => [v.str("burc") ?? ""],
);

export default command;
