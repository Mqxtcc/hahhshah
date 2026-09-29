import type { GuildMember } from "discord.js";

// Desteklenen placeholder'lar:
//   {n}         -> sunucunun güncel üye sayısı
//   {kullanici} -> üyeyi etiketler (@Kullanıcı)
//   {isim}      -> üyenin kullanıcı adı (etiketlemeden)
//   {sunucu}    -> sunucu adı
// Mesaj metni olduğu gibi (markdown/kod bloğu dahil) Discord'a gönderilir,
// burada sadece placeholder değişimi yapılır — biçimlendirmeye dokunulmaz.
// Hem katılma (hoşgeldin) hem ayrılma (görüşürüz) mesajları için ortak kullanılır.
export function renderWelcomeMessage(template: string, member: GuildMember): string {
  return template
    .split("{n}").join(String(member.guild.memberCount))
    .split("{kullanici}").join(`${member}`)
    .split("{isim}").join(member.user.username)
    .split("{sunucu}").join(member.guild.name);
}

// Discord mesaj içeriği limiti 2000 karakterdir. Bunu ayar anında kontrol
// etmezsek, `!hosgeldin ayarla`/`mesaj` başarıyla kaydedilir ama gerçek üye
// katıldığında/ayrıldığında gönderim discord.js tarafında sessizce hata verip
// hiçbir mesaj gitmezdi (bkz. events/welcome.ts try/catch). Placeholder'lar
// gerçek değerlerle genelde şablon metninden uzun olduğu için pay bırakıyoruz.
export const MAX_TEMPLATE_LENGTH = 1800;

export function isTemplateTooLong(template: string): boolean {
  return template.length > MAX_TEMPLATE_LENGTH;
}
