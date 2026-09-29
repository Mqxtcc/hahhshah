import { V2CardBuilder } from "../utils/componentsV2.js";
import { MessageFlags, type Message } from "discord.js";
import type { Command } from "../types.js";
import { errorEmbed } from "../utils/embeds.js";
import { setUserColor, clearUserColor } from "../utils/userColor.js";
import { ensurePremiumLoaded, isPremium } from "../premium/store.js";
import { addSlash } from "../utils/slashBridge.js";

// Hazır renk isimleri (Türkçe).
const NAMED_COLORS: Record<string, number> = {
  kırmızı: 0xed4245,
  mavi: 0x5865f2,
  yeşil: 0x3ba55c,
  yesil: 0x3ba55c,
  mor: 0x9b59b6,
  pembe: 0xe8a0bf,
  turuncu: 0xe67e22,
  altın: 0xd0a840,
  altin: 0xd0a840,
  turkuaz: 0x1abc9c,
  beyaz: 0xecf0f1,
  gri: 0x95a5a6,
};

function toHex(color: number): string {
  return `#${color.toString(16).padStart(6, "0")}`;
}

const command: Command = {
  name: "renk",
  aliases: ["color", "rengim"],
  description: "⭐ Premium: profil kartlarındaki vurgu rengini seç",
  usage: "!renk <renk adı | #hex> | !renk sıfırla  örn: !renk mor | !renk #1abc9c",
  category: "genel",

  async execute(message: Message, args: string[]) {
    await ensurePremiumLoaded().catch(() => null);
    if (!isPremium(message.author.id)) {
      return message.reply({
      flags: MessageFlags.IsComponentsV2,
        components: [
          errorEmbed(
            "⭐ Premium Gerekli",
            "Özel profil rengi premium üyelere özel.\nNasıl alınır? `!premiumbilgi` yaz.",
          ),
        ],
      });
    }

    const input = args.join(" ").trim().toLowerCase();

    if (input === "sıfırla" || input === "sifirla" || input === "reset") {
      await clearUserColor(message.author.id).catch(() => null);
      return message.reply({
      flags: MessageFlags.IsComponentsV2,
        components: [new V2CardBuilder().setColor(0x95a5a6).setTitle("🎨 Renk Sıfırlandı").setDescription("Profil kartların varsayılan renge döndü.")],
      });
    }

    let color: number | null = null;
    if (NAMED_COLORS[input] !== undefined) {
      color = NAMED_COLORS[input];
    } else {
      const hex = input.replace(/^#/, "");
      if (/^[0-9a-f]{6}$/i.test(hex)) color = Number.parseInt(hex, 16);
    }

    if (color === null) {
      const names = Object.keys(NAMED_COLORS)
        .filter((n) => /^[a-zçğıöşü]+$/.test(n) && !["yesil", "altin", "sifirla"].includes(n))
        .join(", ");
      return message.reply({
      flags: MessageFlags.IsComponentsV2,
        components: [
          errorEmbed(
            "Geçersiz Renk",
            `Kullanım: \`!renk <renk>\` veya \`!renk #hex\`\nHazır renkler: ${names}\nÖrnek: \`!renk mor\` · \`!renk #1abc9c\` · \`!renk sıfırla\``,
          ),
        ],
      });
    }

    await setUserColor(message.author.id, color).catch(() => null);
    return message.reply({
      flags: MessageFlags.IsComponentsV2,
      components: [
        new V2CardBuilder()
          .setColor(color)
          .setTitle("🎨 Rengin Kaydedildi!")
          .setDescription(
            `Profil kartların artık **${toHex(color)}** renginde görünecek.\n` +
              "(`!bilgi`, `!davet`, `!premiumbilgi` kartlarında)",
          ),
      ],
    });
  },
};


addSlash(command, [
  { name: "renk", description: "Renk adı, #hex kodu veya sıfırla", type: "string" },
]);

export default command;
