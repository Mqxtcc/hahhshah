// Premium ayrıcalıklarının TEK KAYNAĞI.
// !premiumbilgi komutu bu listeyi çizer — yeni ayrıcalık ekleyince
// sadece buraya satır eklemek yeterli.
export interface PremiumPerk {
  icon: string;
  title: string;
  description: string;
}

export const PREMIUM_PERKS: PremiumPerk[] = [
  {
    icon: "🤖",
    title: "Sınırsız AI",
    description: "13 AI komutunda deneme hakkı derdi yok — sor, özet, çeviri, yaz, kod, çiz, hepsi sınırsız.",
  },
  {
    icon: "⚡",
    title: "Bekleme süresi yok",
    description: "AI komutlarında 8 saniyelik bekleme premium'da işlemez, art arda kullan.",
  },
  {
    icon: "🎨",
    title: "Özel profil rengi",
    description: "!renk ile profil kartlarının (bilgi, davet) vurgu rengini kendin seç.",
  },
  {
    icon: "💾",
    title: "Kalıcı hatırlatıcılar",
    description: "!hatirlat kayıtların DB'de tutulur — bot yeniden başlasa bile kaybolmaz. Limit 10 → 30.",
  },
  {
    icon: "📊",
    title: "Süreli anket",
    description: "!anket ... --sure 1saat ile süre bitiminde otomatik sonuç özeti al.",
  },
  {
    icon: "🔑",
    title: "Kelime şifre",
    description: "!sifre kelime ile akılda kalıcı, güçlü kelime-tabanlı şifre üret.",
  },
  {
    icon: "🏆",
    title: "Bilgi yarışmasında 2x puan",
    description: "Doğru bildiğin her soru skor tablosuna 2 galibiyet olarak işlenir.",
  },
];

/** Premium nasıl alınır? (bilgi metni) */
export const PREMIUM_HOWTO =
  "• **5 davet** → kalıcı premium (`!davet` ile ilerlemeni gör)\n" +
  "• **Hediye** → bir 👑 Efsane Elçi sana `!hediye` ile 1 aylık premium verebilir";
