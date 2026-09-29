import { errorCard, V2CardBuilder } from "../utils/componentsV2.js";
import { MessageFlags, type Message } from "discord.js";
import type { Command } from "../types.js";
import { COLORS } from "../utils/embeds.js";
import { EMOJIS } from "../utils/emojis.js";
import { getGuildPrefix, requireOwnerOrGuildOwner } from "../events/messageCreate.js";
import { createCustomEvent, MAX_CUSTOM_EVENTS_PER_GUILD } from "../customEvents/store.js";
import { extractRawRest } from "../utils/parse.js";
import { addSlash } from "../utils/slashBridge.js";

const command: Command = {
  name: "customevent",
  aliases: ["customevent-oluştur", "customevent-olustur", "ce-oluştur", "ce-olustur"],
  description:
    "YAGPDB tarzı güvenli bir custom event oluşturur/günceller (en fazla 25 adet, sadece sunucu sahibi/taç sahibi)",
  usage: "!customevent <isim> <kod>",
  category: "genel",

  async execute(message: Message, args: string[]) {
    if (!message.guild) {
      return message.reply({ flags: MessageFlags.IsComponentsV2, components: [errorCard({ description: `${EMOJIS.error} Bu komut sadece bir sunucu içinde kullanılabilir.` })] });
    }
    if (!(await requireOwnerOrGuildOwner(message))) return;

    const prefix = getGuildPrefix(message.guild.id);
    const name = (args[0] ?? "").toLowerCase().trim();
    // DİKKAT: `args.slice(1).join(" ")` KULLANMIYORUZ — args, mesajı
    // `\s+` (boşluk/satır sonu farketmeksizin) ile parçalayıp tek boşlukla
    // geri birleştirdiği için çok satırlı kod tek satıra sıkışıyordu
    // (bildirilen hata buydu). Bunun yerine ham mesaj içeriğinden, komut adı +
    // isim (2 token) atlanıp geri kalan kısım satır sonları/boşluklar AYNEN
    // korunarak alınıyor.
    const code = (name ? extractRawRest(message.content, 2, prefix) : null)?.trim() ?? "";

    if (!name || !code) {
      return message.reply({
      flags: MessageFlags.IsComponentsV2,
        components: [
          new V2CardBuilder()
            .setColor(COLORS.warning)
            .setTitle(`${EMOJIS.usage} Kullanım`)
            .setDescription(
              [
                `\`${prefix}customevent <isim> <kod>\``,
                "",
                "**YAGPDB tarzı örnek (koşul + argüman):**",
                `\`${prefix}customevent selamla {{if eq .User.ID "123"}}Merhaba {{.User.Mention}} — {{index .Args 0}}{{else}}Bu komut sana kapalı.{{end}}\``,
                "",
                "**Eski düz metin syntax'ı da çalışır:**",
                `\`${prefix}customevent selamla Selam {kullanıcı}, hoşgeldin!\``,
                "",
                "**Güvenli aksiyon örneği:**",
                `\`${prefix}customevent temizle {{deleteTrigger 0}}{{sendMessage "Mesaj temizlendi."}}\``,
                "",
                "**Eski embed syntax'ı:**",
                `\`${prefix}customevent kural {embed}\\nbaşlık: Kurallar\\naçıklama: {sunucu} kurallarına uy!\\nrenk: #57F287\\n{/embed}\``,
                "",
                `Syntax, kısıtlar ve mevcut event'ler: \`${prefix}customevent-liste\``,
                `Rol/kanal kısıtları: \`${prefix}customevent-ayar <isim> durum\``,
                `Bu sunucuda en fazla ${MAX_CUSTOM_EVENTS_PER_GUILD} custom event olabilir. Silmek için: \`${prefix}custom-sil <isim>\``,
              ].join("\n"),
            ),
        ],
      });
    }

    const result = await createCustomEvent(message.guild.id, name, code, message.author.id);

    if (result.ok === false) {
      return message.reply({
      flags: MessageFlags.IsComponentsV2,
        components: [new V2CardBuilder().setColor(COLORS.error).setTitle(`${EMOJIS.error} Oluşturulamadı`).setDescription(result.error)],
      });
    }

    return message.reply({
      flags: MessageFlags.IsComponentsV2,
      components: [
        new V2CardBuilder()
          .setColor(COLORS.success)
          .setTitle(`${EMOJIS.success} Custom event oluşturuldu`)
          .setDescription(
            [
              `\`${result.event.name}\` artık \`${prefix}${result.event.name}\` ile çalıştırılabilir.`,
              `Silmek için: \`${prefix}custom-sil ${result.event.name}\``,
              `Tüm custom event'leri görmek için: \`${prefix}customevent-liste\``,
            ].join("\n"),
          ),
      ],
    });
  },
};


addSlash(command, [
  { name: "isim", description: "Olay ismi", type: "string", required: true },
  { name: "kod", description: "Çalıştırılacak kod (çok satırlı olabilir)", type: "string", required: true },
]);

export default command;
