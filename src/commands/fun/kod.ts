import { V2CardBuilder } from "../../utils/componentsV2.js";
import { MessageFlags, type Message } from "discord.js";
import type { Command } from "../../types.js";
import { DEFAULT_PREFIX } from "../../config.js";
import { getGuildPrefix } from "../../events/messageCreate.js";
import { COLORS } from "../../utils/embeds.js";
import { EMOJIS } from "../../utils/emojis.js";
import { addSlash } from "../../utils/slashBridge.js";

// !kod — kod komutları için yardım menüsü.
// Alt komut verilmeden çağrılırsa (!kod) mevcut kod araçlarını listeler.

const command: Command = {
  name: "kod",
  aliases: ["kodyardim", "kod-yardim", "codehelp"],
  description: "Kod & komut araçları için yardım menüsünü gösterir",
  usage: `${DEFAULT_PREFIX}kod`,
  category: "fun",

  async execute(message: Message) {
    const p = getGuildPrefix(message.guild?.id);

    const embed = new V2CardBuilder()
      .setColor(COLORS.info)
      .setTitle(`${EMOJIS.success} Kod & Komut Araçları`)
      .setDescription(
        [
          "💎 AI komutları premium'a özeldir — premium olmayanlar her komutu 3 kez ücretsiz deneyebilir.",
          "",
          "**Kod araçları**",
          `\`${p}kod-yaz <py/js/ts/cpp/.../bds> <özellikler>\` — Kod dosyası üretir *(\`${p}kodyaz\`)*`,
          `\`${p}kod-analiz <kod veya ekli dosya>\` — Kod analizi *(\`${p}kod-incele\`)*`,
          `\`${p}kod-duzelt <kod veya ekli dosya>\` — Hataları düzeltir *(\`${p}kodfix\`)*`,
          `\`${p}kod-test <kod veya ekli dosya>\` — Unit test üretir *(\`${p}testyaz\`)*`,
          "",
          "Kod bloğunu mesaja yapıştırabilir veya dosya ekleyebilirsin.",
          "",
          "**Yapay zeka**",
          `\`${p}sor <soru>\` — Genel soru (Groq)`,
          `\`${p}ozetle <metin>\` — Metin / yanıt özeti`,
          `\`${p}özet [1-50]\` — Bu kanaldaki son mesajları özetle`,
          `\`${p}ceviri <hedef dil> <metin>\` — Çeviri`,
          `\`${p}yaz <ne yazılacağı>\` — E-posta / mesaj / makale yaz`,
          `\`${p}fikir <konu>\` — Fikir / beyin fırtınası`,
        ].join("\n"),
      )
      .setFooter({ text: `İsteyen: ${message.author.tag}` })
      .setTimestamp();

    return message.reply({ flags: MessageFlags.IsComponentsV2,
    components: [embed] });
  },
};


addSlash(command, []);

export default command;
