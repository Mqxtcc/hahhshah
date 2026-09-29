import { resolveEmojis, errorCard, V2CardBuilder } from "../utils/componentsV2.js";
import { MessageFlags,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  StringSelectMenuInteraction,
  ComponentType,
  SlashCommandBuilder,
  type Message,
  type ChatInputCommandInteraction,
  type MessageComponentInteraction,
  type Client,
} from "discord.js";
import type { Command } from "../types.js";
import { COLORS, brandBanner } from "../utils/embeds.js";
import { EMOJIS } from "../utils/emojis.js";
import { getGuildPrefix } from "../events/messageCreate.js";
import { OWNER_ID, BOT_NAME, DASHBOARD_URL } from "../config.js";
import { ensureHalfOwnersLoaded, isHalfOwner } from "../premium/halfOwners.js";
import { getLoadedCommands } from "./loader.js";

// ---------------------------------------------------------------------------
// EL YAZISI YARDIM MENÜSÜ (2026-09-28)
// Komut listesi dinamik çekilmiyor — menüler elle yazılıyor. Yeni komut
// eklenince HELP_MENUS'a da eklenmeli (unutulursa help'te görünmez ama
// komut çalışmaya devam eder).
// ---------------------------------------------------------------------------

type HelpItem = {
  /** Komut adı (prefix hariç) */
  cmd: string;
  /** Örnek kullanım (prefix hariç, örn. "sor <soru>") */
  usage: string;
  /** Kısa, düzgün açıklama */
  desc: string;
};

type HelpMenu = {
  id: string;
  label: string;
  emoji: string;
  description: string;
  ownerOnly?: boolean;
  /** Menüdeki komutların üstünde gösterilen bilgi satırı (opsiyonel) */
  note?: string;
  items: HelpItem[];
};

const HELP_MENUS: HelpMenu[] = [
  {
    id: "ai",
    label: "Yapay Zeka",
    emoji: "🤖",
    description: "Sor, yaz, özetle, çevir, kod üret — AI komutları",
    note: "💡 Premium kullanıcılara sınırsız, diğerlerine günde 3 ücretsiz hak (gece yarısı yenilenir).",
    items: [
      { cmd: "sor", usage: "sor <soru>", desc: "AI'ya genel bir soru sor" },
      { cmd: "yaz", usage: "yaz <konu>", desc: "E-posta, hikaye, makale gibi metinler yazar" },
      { cmd: "özet", usage: "özet", desc: "Kanaldaki son mesajları özetler" },
      { cmd: "özetle", usage: "özetle <metin>", desc: "Verilen metni veya yanıtlanan mesajı özetler" },
      { cmd: "çeviri", usage: "çeviri <dil> <metin>", desc: "Metni istediğin dile çevirir" },
      { cmd: "kod-yaz", usage: "kod-yaz <istek>", desc: "İstediğin dilde kod üretir, gerekirse dosya olarak gönderir" },
      { cmd: "kod-analiz", usage: "kod-analiz", desc: "Kodu analiz edip hata ve iyileştirme önerisi sunar" },
      { cmd: "kod-düzelt", usage: "kod-düzelt", desc: "Koddaki hataları bulup düzeltir" },
      { cmd: "kod-test", usage: "kod-test", desc: "Kod için test senaryosu üretir" },
      { cmd: "fikir", usage: "fikir <konu>", desc: "Konu hakkında beyin fırtınası listesi üretir" },
      { cmd: "hesapla", usage: "hesapla <işlem>", desc: "Matematik işlemi çözer, karmaşık soruları AI ile açıklar" },
      { cmd: "çiz", usage: "çiz <açıklama>", desc: "Anlattığın görseli çizer" },
      { cmd: "kod", usage: "kod", desc: "Kod araçları için mini yardım menüsü" },
    ],
  },
  {
    id: "eglence",
    label: "Eğlence & Oyunlar",
    emoji: EMOJIS.fun,
    description: "Oyunlar, şakalar ve eğlenceli araçlar",
    items: [
      { cmd: "8ball", usage: "8ball <soru>", desc: "Sihirli 8-top soruna cevap verir" },
      { cmd: "bilgiyarışması", usage: "bilgiyarışması", desc: "AI destekli bilgi yarışması başlatır" },
      { cmd: "yarışmaskor", usage: "yarışmaskor", desc: "Sunucunun yarışma skor tablosunu gösterir" },
      { cmd: "kelime", usage: "kelime", desc: "Kelime zinciri oyunu için kanal kurar" },
      { cmd: "anket", usage: "anket <soru>", desc: "Reaksiyonlu anket oluşturur" },
      { cmd: "zar", usage: "zar", desc: "Zar atar" },
      { cmd: "yazıtura", usage: "yazıtura", desc: "Yazı mı tura mı?" },
      { cmd: "şaka", usage: "şaka", desc: "Rastgele bir şaka yapar" },
      { cmd: "fıkra", usage: "fıkra", desc: "Rastgele bir fıkra anlatır" },
      { cmd: "avatar", usage: "avatar [@kullanıcı]", desc: "Profil fotoğrafını büyük gösterir" },
      { cmd: "şifre", usage: "şifre", desc: "Güvenli şifre üretir (DM'den gönderir)" },
      { cmd: "aşk", usage: "aşk <@kullanıcı>", desc: "İki kişi arasındaki aşk yüzdesini ölçer" },
      { cmd: "evlen", usage: "evlen <@kullanıcı>", desc: "Birine evlenme teklif eder (butonla kabul)" },
      { cmd: "boşan", usage: "boşan", desc: "Eşinden boşanır (onay ister)" },
      { cmd: "eş", usage: "eş [@kullanıcı]", desc: "Evlilik durumunu gösterir" },
      { cmd: "burç", usage: "burç <burç>", desc: "Günlük burç yorumunu gösterir" },
      { cmd: "ppboyu", usage: "ppboyu [@kullanıcı]", desc: "Efsanevi ölçümü yapar" },
      { cmd: "seç", usage: "seç <a> <b>...", desc: "Seçenekler arasından rastgele seçer" },
      { cmd: "slot", usage: "slot", desc: "Slot makinesini çevirir" },
      { cmd: "tahmin", usage: "tahmin <1-10>", desc: "1-10 arası tuttuğum sayıyı tahmin et" },
    ],
  },
  {
    id: "moderasyon",
    label: "Moderasyon",
    emoji: EMOJIS.baba,
    description: "Ban, kick, susturma, uyarı ve sunucu güvenliği",
    items: [
      { cmd: "ban", usage: "ban <@kullanıcı> [sebep]", desc: "Kullanıcıyı sunucudan yasaklar" },
      { cmd: "unban", usage: "unban <ID>", desc: "Yasağı kaldırır" },
      { cmd: "kick", usage: "kick <@kullanıcı> [sebep]", desc: "Kullanıcıyı sunucudan atar" },
      { cmd: "timeout", usage: "timeout <@kullanıcı> <süre>", desc: "Kullanıcıyı belirtilen süre susturur" },
      { cmd: "unmute", usage: "unmute <@kullanıcı>", desc: "Susturmayı kaldırır" },
      { cmd: "warn", usage: "warn <@kullanıcı> [sebep]", desc: "Kullanıcıyı uyarır (3. uyarıda otomatik susturma)" },
      { cmd: "uyarılar", usage: "uyarılar [@kullanıcı]", desc: "Uyarı geçmişini listeler" },
      { cmd: "clear", usage: "clear <sayı> [@kullanıcı]", desc: "Kanaldaki mesajları toplu siler" },
      { cmd: "setnick", usage: "setnick <@kullanıcı> <isim>", desc: "Kullanıcının sunucu takma adını değiştirir" },
      { cmd: "kilit", usage: "kilit", desc: "Kanalı kilitler (üyeler yazamaz)" },
      { cmd: "kilitac", usage: "kilitac", desc: "Kanal kilidini açar" },
      { cmd: "izin", usage: "izin <ver/al> <@kullanıcı/rol> <yetki>", desc: "Kişiye/role özel moderasyon yetkisi verir" },
      { cmd: "otomod", usage: "otomod", desc: "Otomatik moderasyon kontrol merkezini açar" },
      { cmd: "guard", usage: "guard", desc: "Sunucu koruma (guard) sistemini yönetir" },
      { cmd: "logkanal", usage: "logkanal", desc: "Logların hangi kanala yazılacağını ayarlar" },
    ],
  },
  {
    id: "roller",
    label: "Rol Menüleri",
    emoji: EMOJIS.roly,
    description: "Butonlu, emojili ve seçim menülü rol sistemleri",
    items: [
      { cmd: "butonrol", usage: "butonrol", desc: "Butonlu rol menüsü kurar" },
      { cmd: "emojirol", usage: "emojirol", desc: "Emoji tepkili rol menüsü kurar" },
      { cmd: "kategorirol", usage: "kategorirol", desc: "Açılır seçim menülü rol menüsü kurar" },
      { cmd: "rolmenu", usage: "rolmenu <liste/sil>", desc: "Kurulu rol menülerini listeler/siler" },
      { cmd: "sürelirol", usage: "sürelirol <@kullanıcı> <rol> <süre>", desc: "Süresi dolunca otomatik alınan rol verir" },
      { cmd: "rol", usage: "rol <ekle/al>", desc: "Rol ekleme, kaldırma ve rol oluşturma" },
    ],
  },
  {
    id: "otomasyon",
    label: "Otomasyon",
    emoji: "⚙️",
    description: "Hoşgeldin mesajları, otomatik cevaplar ve custom event'ler",
    items: [
      { cmd: "hoşgeldin", usage: "hoşgeldin", desc: "Yeni üye karşılama/veda mesajı sistemini yönetir" },
      { cmd: "tekrarhoşgeldin", usage: "tekrarhoşgeldin", desc: "Uzun süre sessiz kalan dönerse karşılama gönderir" },
      { cmd: "cevap-oluştur", usage: "cevap-oluştur <tetik> <cevap>", desc: "Belirli mesaja otomatik cevap tanımlar" },
      { cmd: "cevap-sil", usage: "cevap-sil <tetik>", desc: "Otomatik cevabı siler" },
      { cmd: "cevap-liste", usage: "cevap-liste", desc: "Otomatik cevapları listeler" },
      { cmd: "customevent", usage: "customevent", desc: "Güvenli custom event oluşturur/günceller" },
      { cmd: "customevent-ayar", usage: "customevent-ayar", desc: "Custom event'i açar/kapatır, kısıtları düzenler" },
      { cmd: "customevent-liste", usage: "customevent-liste", desc: "Custom event'leri ve kullanım kurallarını listeler" },
      { cmd: "custom-sil", usage: "custom-sil <isim>", desc: "Custom event'i siler" },
    ],
  },
  {
    id: "duyuru",
    label: "Duyuru",
    emoji: "📣",
    description: "Bot ağzından mesaj ve duyuru gönderme",
    items: [
      { cmd: "duyuru", usage: "duyuru [#kanal] <mesaj>", desc: "Bot ağzından duyuru gönderir" },
      { cmd: "say", usage: "say [#kanal] <mesaj>", desc: "Bot ağzından düz mesaj gönderir" },
    ],
  },
  {
    id: "davet",
    label: "Davet & Premium",
    emoji: "👥",
    description: "Davet ödülleri, premium ve half-owner bilgisi",
    items: [
      { cmd: "davet", usage: "davet", desc: "Davet istatistiğin, kademeler ve davet linkin" },
      { cmd: "davet-top", usage: "davet-top", desc: "En çok davet edenlerin sıralaması" },
      { cmd: "hediye", usage: "hediye <@kullanıcı>", desc: "👑 Efsane Elçi özel: arkadaşına 1 aylık premium hediye et" },
      { cmd: "premiumbilgi", usage: "premiumbilgi", desc: "Premium ayrıcalıklarını ve kendi durumunu gösterir" },
      { cmd: "renk", usage: "renk <renk>", desc: "⭐ Premium: profil kartı vurgu rengini seç" },
      { cmd: "halfowner-bilgi", usage: "halfowner-bilgi", desc: "Half-owner nedir, neler yapabilir, kimler" },
    ],
  },
  {
    id: "genel",
    label: "Genel Araçlar",
    emoji: EMOJIS.suite,
    description: "AFK, hatırlatıcı, bilgi komutları ve sunucu ayarları",
    items: [
      { cmd: "afk", usage: "afk [sebep]", desc: "AFK moduna geçersin, seni etiketleyen bilgilendirilir" },
      { cmd: "hatırlat", usage: "hatırlat <süre> <not>", desc: "Belirtilen süre sonra hatırlatma gönderir" },
      { cmd: "bilgi", usage: "bilgi [@kullanıcı]", desc: "Kullanıcı hakkında bilgi gösterir" },
      { cmd: "sunucubilgi", usage: "sunucubilgi", desc: "Bulunduğun sunucu hakkında bilgi gösterir" },
      { cmd: "info", usage: "info", desc: "Botun genel çalışma ve sistem bilgisi" },
      { cmd: "istatistik", usage: "istatistik", desc: "Bot istatistiklerini gösterir" },
      { cmd: "ping", usage: "ping", desc: "Bot gecikmesini ölçer" },
      { cmd: "uptime", usage: "uptime", desc: "Botun ne kadar süredir ayakta olduğunu gösterir" },
      { cmd: "prefix", usage: "prefix <yeni>", desc: "Bu sunucuya özel komut ön ekini değiştirir" },
      { cmd: "sayaç", usage: "sayaç <hedef>", desc: "Üye sayısı sayacı kurar (kanal adı otomatik güncellenir)" },
      { cmd: "firstmsg", usage: "firstmsg [#kanal]", desc: "Kanalın ilk mesajını bulup gösterir" },
      { cmd: "kanalbilgi", usage: "kanalbilgi [#kanal]", desc: "Kanal hakkında detaylı bilgi gösterir" },
      { cmd: "not", usage: "not <metin>", desc: "Kendine özel not kaydedersin" },
      { cmd: "notlar", usage: "notlar", desc: "Notlarını listeler, butonla silebilirsin" },
      { cmd: "botkontrol", usage: "botkontrol", desc: "Botun yetkilerini denetler, eksikleri gösterir" },
      { cmd: "rep", usage: "rep <@kullanıcı>", desc: "Birine itibar puanı verirsin (24 saatte bir)" },
      { cmd: "snipe", usage: "snipe", desc: "Kanalda silinen son mesajı gösterir" },
      { cmd: "doğumgünü", usage: "doğumgünü <gün> <ay>", desc: "Doğum gününü kaydedersin" },
      { cmd: "doğumgünleri", usage: "doğumgünleri", desc: "Bu ay doğum günü olanları listeler" },
      { cmd: "botowner", usage: "botowner", desc: "Bot sahibinin profil ve kullanıcı bilgilerini gösterir" },
    ],
  },
  {
    id: "owner",
    label: "Owner Araçları",
    emoji: EMOJIS.owner,
    description: "Bot sahibi ve half-owner komutları",
    ownerOnly: true,
    items: [
      { cmd: "eval", usage: "eval <kod>", desc: "🔒 Sadece owner: JS/TS kodu çalıştırır" },
      { cmd: "restart", usage: "restart", desc: "🔒 Sadece owner: botu yeniden başlatır" },
      { cmd: "modeller", usage: "modeller", desc: "🔒 Sadece owner: AI modellerini seçer" },
      { cmd: "görsel", usage: "görsel", desc: "🔒 Sadece owner: görsel üretim modelini değiştirir" },
      { cmd: "mentionai", usage: "mentionai", desc: "🔒 Sadece owner: MentionAI ayarları" },
      { cmd: "halfowner", usage: "halfowner <ekle/sil/liste>", desc: "🔒 Sadece owner: half-owner yönetir" },
      { cmd: "ownerrole", usage: "ownerrole", desc: "🔒 Sadece owner: sahip rolünü oluşturur/günceller" },
      { cmd: "yeniembed", usage: "yeniembed <başlık> | <açıklama>", desc: "🔒 Sadece owner: embed gönderir" },
      { cmd: "agent", usage: "agent <istek>", desc: "🔒 Sadece owner: Manus AI agent" },
      { cmd: "sunucular", usage: "sunucular", desc: "Botun bulunduğu sunucuları listeler" },
      { cmd: "hata-log", usage: "hata-log", desc: "Son hataları gösterir" },
      { cmd: "console-log", usage: "console-log", desc: "Konsol çıktısını gösterir" },
      { cmd: "veribak", usage: "veribak [tablo]", desc: "Veritabanını görüntüler (DM'den de çalışır)" },
      { cmd: "premium", usage: "premium <@kullanıcı>", desc: "Kalıcı premium verir" },
      { cmd: "premium-kaldir", usage: "premium-kaldir <@kullanıcı>", desc: "Premium'u geri alır" },
      { cmd: "premium-liste", usage: "premium-liste", desc: "Premium kullanıcıları listeler" },
      { cmd: "özelüye", usage: "özelüye <@kullanıcı>", desc: "VIP rozeti verir/alır" },
      { cmd: "emojidegistir", usage: "emojidegistir <emoji> <özel-emoji>", desc: "🔒 Owner-only: unicode emojileri botun sunucularındaki özel emojilerle eşler" },
    ],
  },
];

const HOME_ID = "home";

/** "Beni ekle" butonunun yönlendirdiği davet linki */
const INVITE_URL =
  "https://discord.com/oauth2/authorize?client_id=1528358579898155019&permissions=8&integration_type=0&scope=bot";

function visibleMenus(isOwner: boolean): HelpMenu[] {
  return HELP_MENUS.filter((m) => !m.ownerOnly || isOwner);
}

/** Ana + alt komutlar (help'te gösterilen toplam) */
function countAllFeatures(): number {
  return getLoadedCommands().length;
}

function botAvatarUrl(client?: Client | null): string | undefined {
  return client?.user?.displayAvatarURL({ size: 256 }) ?? undefined;
}

function buildHomeEmbed(prefix: string, isOwner: boolean, avatarUrl?: string, serverCount = 0) {
  const menus = visibleMenus(isOwner);
  const totalAll = countAllFeatures();

  // Kategori satırları: başlık normal, açıklama -# ile silik/gri
  const categoryBlock = menus
    .map((m) => `» ${m.emoji} **${m.label}**\n-# ${m.description}`)
    .join("\n\n");

  const embed = brandBanner(
    new V2CardBuilder()
      .setColor(COLORS.brand)
      .setTitle(`${EMOJIS.help} ${BOT_NAME} Yardım Menüsü`)
      .setDescription(
        [
          `Selam, ben **${BOT_NAME}**! ${EMOJIS.hello}`,
          `Toplam **${totalAll}** komutum var; hepsi \`${prefix}komut\` şeklinde çalışır.`,
          `İstersen \`/\` yazarak slash komut olarak da kullanabilirsin.`,
          "",
          "Aşağıdaki menüden bir kategori seç.",
          "",
          `${EMOJIS.info} **Kategoriler**`,
          "",
          categoryBlock,
        ].join("\n"),
      )
      .setFooter({
        text: `${totalAll} komut • ${menus.length} kategori • ${serverCount} sunucu • Prefix: ${prefix} • ${BOT_NAME}`,
      })
      .setTimestamp(),
  );

  if (avatarUrl) embed.setThumbnail(avatarUrl);
  return embed;
}

function buildMenuEmbed(menu: HelpMenu, prefix: string, avatarUrl?: string) {
  const lines = menu.items.map(
    (item) => `» \`${prefix}${item.usage}\` — ${item.desc}`,
  );
  const embed = new V2CardBuilder()
    .setColor(COLORS.brand)
    .setTitle(`${menu.emoji} ${menu.label}`)
    .setDescription(
      [
        `-# ${menu.description}`,
        ...(menu.note ? ["", menu.note] : []),
        "",
        ...lines,
      ].join("\n"),
    )
    .setFooter({
      text: `Prefix: ${prefix}  •  Ana sayfaya dönmek için menüyü kullan`,
    })
    .setTimestamp();

  if (avatarUrl) embed.setThumbnail(avatarUrl);
  return embed;
}

function buildSelectRow(isOwner: boolean, selected: string, disabled = false) {
  const menu = new StringSelectMenuBuilder()
    .setCustomId("help-select")
    .setPlaceholder(resolveEmojis("📁 Bir kategori seç..."))
    .setDisabled(disabled)
    .addOptions(
      {
        label: resolveEmojis("Ana Sayfa"),
        value: HOME_ID,
        emoji: EMOJIS.suite,
        description: resolveEmojis("Yardım menüsünün ana sayfası"),
        default: selected === HOME_ID,
      },
      ...visibleMenus(isOwner).map((m) => ({
        label: resolveEmojis(m.label),
        value: m.id,
        emoji: m.emoji,
        description: resolveEmojis(m.description.slice(0, 100)),
        default: selected === m.id,
      })),
    );

  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
}

/** Kategori menüsünün altındaki link butonları: davet + web paneli */
function buildInviteRow() {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setLabel(resolveEmojis("Beni sunucuna ekle"))
      .setEmoji(EMOJIS.invite)
      .setStyle(ButtonStyle.Link)
      .setURL(INVITE_URL),
    new ButtonBuilder()
      .setLabel(resolveEmojis("Web Paneli"))
      .setEmoji("🌐")
      .setStyle(ButtonStyle.Link)
      .setURL(DASHBOARD_URL),
  );
}

function buildEmbed(
  id: string,
  prefix: string,
  isOwner: boolean,
  avatarUrl?: string,
  serverCount = 0,
) {
  if (id === HOME_ID) return buildHomeEmbed(prefix, isOwner, avatarUrl, serverCount);
  const menu = visibleMenus(isOwner).find((m) => m.id === id);
  if (!menu) return buildHomeEmbed(prefix, isOwner, avatarUrl, serverCount);
  return buildMenuEmbed(menu, prefix, avatarUrl);
}

async function runHelpMenu(
  userId: string,
  guildId: string | null | undefined,
  client: Client | null | undefined,
  send: (payload: {
    flags: MessageFlags.IsComponentsV2;
    components: (V2CardBuilder | ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>)[];
  }) => Promise<Message>,
): Promise<void> {
  const prefix = getGuildPrefix(guildId);
  await ensureHalfOwnersLoaded();
  const isOwner = userId === OWNER_ID || isHalfOwner(userId);
  const avatarUrl = botAvatarUrl(client);
  const serverCount = client?.guilds.cache.size ?? 0;
  let current = HOME_ID;

  const reply = await send({
    flags: MessageFlags.IsComponentsV2,
    components: [buildEmbed(current, prefix, isOwner, avatarUrl, serverCount), buildSelectRow(isOwner, current), buildInviteRow()],
  });

  const collector = reply.createMessageComponentCollector({
    componentType: ComponentType.StringSelect,
    time: 15 * 60 * 1000,
    filter: (interaction: MessageComponentInteraction) =>
      interaction.user.id === userId,
  });

  collector.on("collect", (interaction: StringSelectMenuInteraction) => {
    void (async () => {
      if (interaction.user.id !== userId) {
        await interaction.reply({
      flags: MessageFlags.IsComponentsV2,
          components: [errorCard({ description: `${EMOJIS.error} Bu menü sana ait değil, kendi \`${prefix}help\` komutunu çalıştır.` })],
          ephemeral: true,
        });
        return;
      }

      current = interaction.values[0] ?? HOME_ID;

      await interaction.update({
      flags: MessageFlags.IsComponentsV2,
        components: [buildEmbed(current, prefix, isOwner, avatarUrl, serverCount), buildSelectRow(isOwner, current), buildInviteRow()],
      });
    })().catch((error: unknown) =>
      console.error("help menüsü patladı:", error),
    );
  });

  collector.on("end", () => {
    void reply
      .edit({
      flags: MessageFlags.IsComponentsV2, components: [buildSelectRow(isOwner, current, true), buildInviteRow()] })
      .catch(() => null);
  });
}

const command: Command = {
  name: "help",
  aliases: ["yardim", "komutlar"],
  description: "Tüm komutları listeler",
  usage: "!help",
  category: "genel",

  slashData: new SlashCommandBuilder()
    .setName("help")
    .setDescription("Tüm komutları listeler"),

  async execute(message: Message) {
    await runHelpMenu(
      message.author.id,
      message.guild?.id,
      message.client,
      (payload) => message.reply(payload),
    );
  },

  async slashExecute(interaction: ChatInputCommandInteraction) {
    await runHelpMenu(
      interaction.user.id,
      interaction.guildId,
      interaction.client,
      async (payload) => {
        await interaction.reply(payload);
        return (await interaction.fetchReply()) as Message;
      },
    );
  },
};

export default command;
