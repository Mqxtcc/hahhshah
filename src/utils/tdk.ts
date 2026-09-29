// src/utils/tdk.ts
// ---------------------------------------------------------------------------
// Kelime Zinciri için TDK (Türk Dil Kurumu) sözlük doğrulaması.
//
// BİLİNÇLİ TASARIM: hiçbir kelime listesi pakete gömülmüyor, hiçbir şey
// veritabanına yazılmıyor. Her kelime, TDK'nin herkese açık sözlük API'sine
// (sozluk.gov.tr) sorulup gerçekten var olan bir kelime mi diye kontrol
// edilir. Tekrar sorguları azaltmak için sadece BELLEK İÇİNDE, sabit
// boyutlu (yer kaplamayan, süreç kapanınca sıfırlanan) bir LRU cache
// tutulur — kalıcı depolama yok, DB'ye hiçbir etkisi yok.
// ---------------------------------------------------------------------------

const TDK_ENDPOINT = "https://sozluk.gov.tr/gts";
const REQUEST_TIMEOUT_MS = 4_000;

// Bellekte tutulacak maksimum kelime sayısı (yaklaşık birkaç yüz KB RAM,
// disk/DB'ye hiç dokunmaz). Limit aşılınca en eski girişler atılır.
const CACHE_MAX_ENTRIES = 5_000;

const cache = new Map<string, boolean>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function trLower(value: string): string {
  return value.replace(/[Iİ]/g, (character) => (character === "I" ? "ı" : "i")).toLowerCase();
}

function cacheGet(word: string): boolean | undefined {
  const hit = cache.get(word);
  if (hit !== undefined) {
    // LRU: erişileni sona taşı
    cache.delete(word);
    cache.set(word, hit);
  }
  return hit;
}

function cacheSet(word: string, valid: boolean): void {
  if (cache.size >= CACHE_MAX_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey !== undefined) cache.delete(oldestKey);
  }
  cache.set(word, valid);
}

/**
 * TDK sözlüğünde kelimenin gerçekten var olup olmadığını kontrol eder.
 * API'ye ulaşılamazsa (zaman aşımı, ağ hatası, TDK'nin kendisi çöktüyse)
 * `null` döner — bu durumda çağıran taraf oyunu TIKAMAMAK için kelimeyi
 * (harf/tekrar kurallarına uyduğu sürece) kabul etmeli; sözlük kontrolü
 * bir "iyileştirme"dir, tek hata noktası olmamalı.
 */
export async function isRealTurkishWord(rawWord: string): Promise<boolean | null> {
  const word = rawWord.trim().toLocaleLowerCase("tr-TR");
  if (!word) return false;

  const cached = cacheGet(word);
  if (cached !== undefined) return cached;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(`${TDK_ENDPOINT}?ara=${encodeURIComponent(word)}`, {
      signal: controller.signal,
      headers: {
        // TDK, User-Agent göndermeyen istekleri genelde reddediyor/kesiyor.
        // Bu header olmadan res.ok her zaman false dönebilir ve fonksiyon
        // sürekli null'a (yani "kelimeyi kabul et") düşer — asıl bug buydu.
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        Accept: "application/json",
      },
    });

    if (!res.ok) {
      // TDK tarafı 4xx/5xx dönerse önbelleğe yazmadan null (bilinmiyor) dön.
      console.warn(`[tdk] ${res.status} döndü, "${word}" kontrol edilemedi — oyun tıkanmasın diye kabul edildi`);
      return null;
    }

    const data = (await res.json()) as unknown;
    // TDK araması yaklaşık eşleşmeler döndürebilir: `ımza` sorgusu bazen
    // `imza` maddesini de getirir. Sadece sonuç dizisinin dolu olmasına bakmak
    // bu nedenle yazım hatasını yanlışlıkla kabul eder. Madde başlığı, aranan
    // kelimeyle Türkçe karakter duyarlı olarak birebir eşleşmeli.
    const valid = Array.isArray(data) && data.some(
      (entry) => isRecord(entry) && typeof entry.madde === "string" && trLower(entry.madde) === word,
    );

    cacheSet(word, valid);
    return valid;
  } catch (err) {
    // Zaman aşımı / ağ hatası — bilinmiyor, oyunu tıkamamak için null.
    console.warn(`[tdk] istek patladı, "${word}" kontrol edilemedi:`, err instanceof Error ? err.message : err);
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}
