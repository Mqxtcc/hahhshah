// Discord custom emoji mappings
export const EMOJIS = {
  // Ortak mesaj dili — kullanıcı tarafından belirlenen animasyonlu emojiler
  success: "<a:1000021814:1540389540513194066>", // Yeşil tik (başarılı işlem)
  error: "<a:1000021813:1540389526873317518>", // Kırmızı çarpı (hata durumu)
  general: "<a:1000061555:1550928064761045002>", // Beyaz şimşek (genel bilgi)
  alert: "<a:1000061547:1550922590049280080>", // Kırmızı yıldız/patlama (dikkat / uyarı — eski uyari yerine)
  loading: "<a:1000061552:1550924812241870929>", // Dişli/Çark (işleniyor / bekleme)
  active: "<a:1000060634:1548019908430929941>", // Yeşil daire (aktif / açık durum göstergesi)

  // Moderasyon & Cezalar
  ban: "<a:moderasyon:1540386004903395449>", // Mavi çekiç (ban/kick işlemleri)
  mod: "<a:moderasyon:1540386004903395449>", // Mavi çekiç (genel moderasyon aksiyonu)
  timeout: "<a:1000061549:1550923357958967327>", // Mavi kurdele/şerit (timeout/mute cezası)
  kick: "<:1000021811:1540388051585605783>", // Sol ok (sunucudan çıkarma / kick)
  warn: "<a:1000061547:1550922590049280080>", // Kırmızı yıldız/patlama (uyarı verme)
  usage: "<:1000061635:1551197476218736720>", // Mavi tikli not defteri (kullanım / yanlış komut)

  // Başarı & İşlemler
  yildirim: "<a:1000061555:1550928064761045002>", // Sarı yıldırım/şimşek (yeni yıldırım)
  check: "<a:1000021820:1540400058233659492>", // Kırmızı "1" rozetli anime kızı (biip / ping ölçümü)

  // Roller & Yönetim
  role: "<:1000021807:1540386942699577424>", // Etiket (rol yönetimi)
  admin: "<a:1000061549:1550923357958967327>", // Mavi kurdele/şerit (yönetim)
  owner: "<a:1000061547:1550922590049280080>", // Kırmızı yıldız/patlama (owner araçları)
  info: "<a:1000061555:1550928064761045002>", // Sarı yıldırım/şimşek (bilgilendirme)

  // Eğlence & Çeşitli
  fun: "<:1000061551:1550924192319545565>", // Pembe saçlı anime kızı (eğlence komutları)
  suite: "<a:1000061552:1550924812241870929>", // Dişli/Çark (genel & sunucu)
  baba: "<:1000061633:1551196536010965022>", // Taçlı turuncu tilki (baba)
  roly: "<:1000061632:1551194926312595456>", // Etiket (roly)

  // Yardım menüsü (help.ts)
  help: "<:1000061635:1551197476218736720>", // Mavi tikli not defteri (yardım menüsü başlığı)
  hello: "<:1000061634:1551197173771669664>", // Pembe saçlı anime kızı (selamlama)
  invite: "<a:1000061645:1551214313778323546>", // Botu sunucuya ekle butonu (help menüsü)

  // Navigation
  back: "<:1000021811:1540388051585605783>", // Sol ok (geri butonu)
  next: "<:1000021812:1540388040646590564>", // Sağ ok (ileri butonu)

  // Ekstra
  user: "<:1000028314:1541430105379962940>", // Sarışın kadın yüzü (kullanıcı alanları)
  welcomeBack: "<:1000028314:1541430105379962940>", // Sarışın kadın yüzü (tekrar hoşgeldin)
  vipWelcome: "<a:1000028315:1541430103517438022>", // Pembe saçlı kadın yüzü (vip karşılama)

  // AFK sistemi
  afkSet: "<a:1000061645:1551214313778323546>", // AFK set bildirimi
  afkActive: "<a:1000062821:1553049448597426287>", // AFK mention bildirimi
  afkReturn: "<a:1000062823:1553059511227523213>", // AFK dönüş bildirimi

  // Premium
  prm1: "<a:1000060632:1548019144304099349>", // Pembe yıldız/parıltı (premium başlık)
  prm2: "<a:1000060633:1548019629862031451>", // Para çuvalı (premium buton)
  prm3: "<a:1000060634:1548019908430929941>", // Yeşil daire (premium durum)
} as const;

export type EmojiKey = keyof typeof EMOJIS;
