import { errorCard, V2CardBuilder } from "../utils/componentsV2.js";
import { MessageFlags, type Message } from "discord.js";
import type { Command } from "../types.js";
import { COLORS } from "../utils/embeds.js";
import { EMOJIS } from "../utils/emojis.js";
import { getGuildPrefix } from "../events/messageCreate.js";
import { listCustomEvents, MAX_CUSTOM_EVENTS_PER_GUILD } from "../customEvents/store.js";
import { addSlash } from "../utils/slashBridge.js";

const TAG_HELP = [
  "**Kullanıcı:** `{kullanıcı}`, `{kullanıcı.ad}`, `{kullanıcı.id}`, `{kullanıcı.avatar}`, `{kullanıcı.takma-ad}`, `{kullanıcı.oluşturulma}`, `{kullanıcı.katılma}`, `{kullanıcı.hesap-yaşı}` (gün), `{kullanıcı.üyelik-süresi}` (gün), `{kullanıcı.rol}`, `{kullanıcı.rol-sayısı}`, `{kullanıcı.renk}`, `{kullanıcı.boost}`, `{kullanıcı.bot-mu}`",
  "**YAGPDB kullanıcı alanları:** `{{.User.ID}}`, `{{.User.Username}}`, `{{.User.Mention}}`, `{{.Member.Nick}}`, `{{.MentionedUser.ID}}`, `{{.MentionedUser.Mention}}`",
  "**YAGPDB sunucu alanları:** `{{.Server.ID}}`, `{{.Server.Name}}`, `{{.Server.MemberCount}}`, `{{.Channel.ID}}`, `{{.Channel.Name}}`, `{{.Message.ID}}`, `{{.Message.Content}}`",
  "**YAGPDB argümanları:** `{{.Args}}`, `{{index .Args 0}}`, `{{len .Args}}`, `{{.StrippedMsg}}`",
  "**Eski etiketleme:** `{etiketlenen}`, `{etiketlenen.ad}`, `{etiketlenen.id}`, `{etiketlenen.takma-ad}` (mesajda @'lenen ilk kişi) — `{yanıtlanan}`, `{yanıtlanan.ad}`, `{yanıtlanan.id}` (reply atılan kişi)",
  "**Sunucu:** `{sunucu}`, `{sunucu.id}`, `{sunucu.üye}`, `{sunucu.sahibi}`, `{sunucu.icon}`, `{sunucu.oluşturulma}`, `{sunucu.boost-seviyesi}`, `{sunucu.boost-sayısı}`, `{sunucu.kanal-sayısı}`, `{sunucu.rol-sayısı}`, `{sunucu.emoji-sayısı}`",
  "**Kanal/Mesaj:** `{kanal}`, `{kanal.ad}`, `{kanal.id}`, `{kanal.konu}`, `{kanal.tür}`, `{mesaj.id}`",
  "**Argümanlar:** `{args}`, `{arg1}`..`{arg9}`, `{argsayı}`, `{argkalan:N}` — N. argümandan itibaren kalanı verir, `{argvar:N}` — Evet/Hayır",
  "**Koşullar/değişken:** `{{if eq .User.ID \"ID\"}}...{{else}}...{{end}}`, `{{$isim := .User.Username}}`, `eq/ne/gt/lt/and/or/not`",
  "**Fonksiyonlar:** `len`, `index`, `contains`, `joinStr`, `toInt`, `toFloat`, `toString`, `lower`, `upper`, `hasRoleID`, `hasPermission`",
  "**Güvenli aksiyonlar:** `{{sendMessage \"...\"}}`, `{{sendDM \"...\"}}`, `{{deleteTrigger 0}}`, `{{giveRoleID .User.ID \"ROL_ID\"}}`, `{{takeRoleID .User.ID \"ROL_ID\"}}`",
  "**Eski rastgelelik:** `{rastgele:a|b|c}`, `{sayı:1-100}`, `{yazitura}`, `{evethayır}`",
  "**Metin:** `{büyük:metin}` / `{küçük:metin}`, `{ters:metin}` — ters çevir, `{uzunluk:metin}` — karakter sayısı, `{tekrar:metin|N}` — N kez tekrarla (en fazla 20), `{boşluk}`",
  "**Zaman:** `{tarih}`, `{saat}`, `{gün}`, `{ay}`, `{yıl}`, `{tarihsaat}`",
  "**Embed (eski syntax):** `{embed}başlık: ...\\naçıklama: ...\\nrenk: #57F287\\nalan: Ad | Değer\\n{/embed}`",
].join("\n");

// Bu komut herkese açık — custom event'ler tüm üyeler tarafından
// kullanılabildiği için ne olduklarını da herkesin görebilmesi gerekiyor.
const command: Command = {
  name: "customevent-liste",
  aliases: ["customlar", "customevents", "ce-liste", "customevent-help", "customevent-yardım"],
  description: "Bu sunucudaki güvenli custom event'leri, YAGPDB syntax'ını ve kısıtları listeler (herkese açık)",
  usage: "!customevent-liste",
  category: "genel",

  async execute(message: Message) {
    if (!message.guild) {
      return message.reply({ flags: MessageFlags.IsComponentsV2, components: [errorCard({ description: `${EMOJIS.error} Bu komut sadece bir sunucu içinde kullanılabilir.` })] });
    }

    const prefix = getGuildPrefix(message.guild.id);
    const events = await listCustomEvents(message.guild.id);

    const listSection =
      events.length === 0
        ? "_Bu sunucuda henüz custom event yok._"
        : events
            .map((e) => `\`${prefix}${e.name}\` — <@${e.createdBy}> tarafından oluşturuldu`)
            .join("\n");

    const embed = new V2CardBuilder()
      .setColor(COLORS.info)
      .setTitle(`${EMOJIS.info} Custom Event'ler`)
      .setDescription(
        [
          `Bu sunucuya özel, sunucu sahibinin (taç sahibi) oluşturduğu güvenli şablon komutları (en fazla ${MAX_CUSTOM_EVENTS_PER_GUILD} adet):`,
          "",
          listSection,
          "",
          "**Yeni oluşturmak/silmek isteyen sunucu sahipleri için:**",
          `\`${prefix}customevent <isim> <kod>\` — oluştur`,
          `\`${prefix}custom-sil <isim>\` — sil`,
          `\`${prefix}customevent-ayar <isim> durum\` — rol/kanal/izin kısıtlarını gör`,
          "",
          "**Güvenlik:** JavaScript/eval, döngü, dosya/ağ erişimi ve keyfi Discord API çağrıları yoktur. Aksiyonlar whitelist'lidir; yanıtlar mention yapmaz.",
          "",
          "**Kod içinde kullanılabilecek etiketler:**",
          TAG_HELP,
        ].join("\n"),
      )
      .setFooter({ text: `Toplam ${events.length}/${MAX_CUSTOM_EVENTS_PER_GUILD} custom event` });

    return message.reply({
      flags: MessageFlags.IsComponentsV2, components: [embed] });
  },
};


addSlash(command, []);

export default command;
