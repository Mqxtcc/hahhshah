// Otomod — varsayılan (default) yasaklı kelime listeleri.
//
// Bu dosya SADECE varsayılanları tutar ve tüm sunucular için ortaktır.
// Sunucuya özel ekleme/çıkarma burada DEĞİL, veritabanında tutulur:
//   - "!otomod kelime-ekle" -> guild config'in wordList alanına eklenir
//   - "!otomod kelime-sil"  -> guild config'in wordList alanından silinir,
//                              varsayılan listedeyse removedDefaults'a eklenir
// Bkz. store.ts (getEffectiveWordList) — sunucu bazlı nihai listeyi
// (defaults - removedDefaults) + wordList birleştirerek üretir.
//
// EŞLEŞME KURALLARI (bkz. automod.ts -> containsBannedWord):
// 1) BOUNDARY: Tüm kelimeler kelime sınırıyla (boşluk/noktalama) eşleşir,
//    alt string olarak ASLA eşleşmez.
//      ✓ "bi oç gördüm"   -> eşleşir
//      ✗ "koç" içindeki "oç" -> eşleşmez (boundary yok)
// 2) OBFUSCATION: Yalnızca harf harf ayrılmış yazımlarda ("s.i.k.i.m" gibi)
//    ve yalnızca 4+ karakterli kelimelerde uygulanır.
//
// Türkçe çekim (inflection) biçimleri elle listeleniyor (sikimi, götü,
// amcığı, yarrağın vb.) — böylece "sikimi kemir" gibi doğal kullanımlar
// yakalanırken "sik anlamadım" gibi masum cümleler silinmiyor.

export const DEFAULT_BANNED_WORDS: string[] = [
  // --- Kısaltmalar (yalnızca boundary ile; "sg"/"mk"/"amk"/"aq" gibi
  // belirsiz/çok anlamlı olanlar false positive riski yüzünden bilinçli
  // olarak listede yok — bkz. proje sahibinin talebi) ---
  "oc",
  "oç",

  // --- "sik" kökü ve çekimleri ---
  "sikik",
  "siktir",
  "siktir git",
  "siktiret",
  "sikeyim",
  "sikerim",
  "sikimi",
  "sikim",
  "sikimi",
  "sikisine",
  "sikisiyle",
  "sikinin",
  "sikiler",
  "sikisi",
  "skicem",
  "sktim",
  "sikiyor",
  "sikicem",
  "sikecek",
  "sikicek",
  "sikicem",
  "sikilmesini",
  "siktirilmesini",
  "sikin",
  "sikm",
  "skim",

  // --- "amcık" kökü ve çekimleri ---
  "amcık",
  "amcığı",
  "amcığın",
  "amcığım",
  "amcığız",
  "amcığını",

  // --- "amına" kökü ve çekimleri ---
  "amına",
  "amını",
  "amınız",
  "amına koyayım",
  "amının",
  "aminakoy",

  // --- "yarrak" kökü ve çekimleri ---
  "yarram",
  "yarrak",
  "yarrağımı",
  "yarrağın",
  "yarağı",
  "yarak",
  "yarağa",

  // --- "göt" kökü ve çekimleri ---
  "göt",
  "götü",
  "götün",
  "götveren",
  "göt oğlanı",
  "gote",
  "götüne",

  // --- Diğer küfür / hakaret kökleri ---
  "orospu",
  "uruzbu",
  "orospucocugu",
  "orospu çocuğu",
  "orospucocugudur",
  "orospusun",
  "orospular",
  "orospudur",
  "yavşak",
  "piç",
  "piçinin",
  "piçlik",
  "piçliği",
  "ananı sikeyim",
  "avradını",
  "avradınız",

  // --- "ebenin amı" kalıbı — genelde boşluksuz TEK kelime olarak yazılıyor
  // ("ebeninami"), bu yüzden ayrı çekimler yerine bitişik hâliyle listeye
  // ekleniyor (boundary kontrolü zaten tam kelime eşleşmesi arıyor).
  "ebeninami",
  "ebenin amı",
  "ebeninamk",
  "kaltak",
  "kaltağa",
  "kaltakça",
  "sürtük",
  "sürtüğü",

  // --- Irkçı/nefret içerikli ifadeler ---
  "nigga",
  "nigger",
  "neggar",
  "negga",

  // --- Cinsel içerik ---
  "porno",
  "porn",
  "pornografi",
  "pirno",
  "sex",
  "seks",
  "pornografik",
  "pornosu",
  "pornolar",
  "pornocu",
  "pornolar",
];

// İngilizce küfür listesi.
// Türkçe filtreyi İngilizce küfürle atlatma girişimlerine karşı eklendi.
// Aynı boundary/obfuscation mantığından geçer (containsBannedWord iki listeyi
// de aynı fonksiyonla işler), alfabe Latin kaldığı için ek normalize/regex
// değişikliği gerekmiyor.
export const ENGLISH_BANNED_WORDS: string[] = [
  "fuck",
  "fucking",
  "fucker",
  "fucked",
  "motherfucker",
  "fck",
  "fuk",
  "bullshit",
  "bitch",
  "bitches",
  "asshole",
  "ass",
  "cunt",
  "dick",
  "dickhead",
  "pussy",
  "whore",
  "slut",
  "faggot",
  "fag",
  "retard",
  "retarded",
  "bastard",
  "douchebag",
  "cock",
  "twat",
  "wanker",
  "prick",
];

// Rusça küfür listesi (mat) — Latin transliterasyon.
// Kiril harfi kullanılmıyor (alfabe Latin kalıyor); burada Türk/Rus
// gençlerinin klavye alışkanlığıyla yazdığı yaygın translit varyantlar var
// (örn. "blyat", "suka"). Aynı boundary kontrolünden geçer.
// NOT: "hui" ve "ebat" listeden ÇIKARILDI — ikisi de masum Türkçe
// kelimelerle/ifadelerle karışıyordu: "hui" günlük yazışmada "he"/"hı" gibi
// ünlemlerle karıştırılabiliyor, "ebat" ise "boyut/ölçü" anlamına gelen
// gerçek ve yaygın kullanılan bir Türkçe kelime (örn. "ebatları nedir?").
// Bilinçli ödünleşim: bu iki kelimeyi kaldırmak Rusça küfür filtresini biraz
// zayıflatıyor ama günlük Türkçe konuşmayı bozan false-positive riskini ortadan kaldırıyor.
export const RUSSIAN_BANNED_WORDS: string[] = [
  "blyat",
  "blyatt",
  "blyaat",
  "blyad",
  "blya",
  "suka",
  "suki",
  "huyna",
  "pizdec",
  "pizda",
  "ebanyi",
  "ebanutiy",
  "zaebal",
  "mudak",
  "mudilo",
  "dolboeb",
  "uyobok",
  "pidor",
  "pidoras",
  "gandon",
  "shlyuha",
  "der'mo",
  "dermo",
];

// Üç dilin birleşimi — store.ts'de tek tek spread etmek yerine burada
// birleştirip export ediyoruz. Sıra ve içerik önemli değil; store.ts
// zaten sonucu Set ile dedupe ediyor.
export const ALL_DEFAULT_BANNED_WORDS: string[] = [
  ...DEFAULT_BANNED_WORDS,
  ...ENGLISH_BANNED_WORDS,
  ...RUSSIAN_BANNED_WORDS,
];
