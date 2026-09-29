// src/utils/codeFiles.ts
// !kod-yaz gibi komutların, modelin döndürdüğü metinden bir ya da birden
// fazla dosya çıkarmasını sağlar.
//
// Model, birden fazla dosya üretmesi gerektiğinde her dosyadan hemen önce
// kendi satırında "===FILE: dosya-adi.uzanti===" başlığı koyacak şekilde
// yönlendirilir (bkz. kod-yaz.ts -> buildSystemPrompt). Bu başlık hiç
// bulunamazsa (tek dosyalık normal cevap), eski davranışla tek bir kod
// bloğu (veya tüm metin) tek dosya olarak kabul edilir.
//
// TRUNCATION (yarıda kesilme) GÜVENLİĞİ:
// utils/openrouter.ts ve utils/gemini.ts artık token limiti yüzünden
// yarıda kesilen (finish_reason: "length"/"MAX_TOKENS") cevapları otomatik
// olarak devam ettirip birleştiriyor. Ama sağlayıcı bu bilgiyi hiç
// döndürmezse ya da devam ettirme son denemede de tamamlanamazsa, elimizde
// kapanmamış (``` ile bitmeyen) bir kod bloğu kalabilir — tam olarak
// "yarım index.html, script kapanmadığı için butonlar çalışmıyor / scroll'da
// çöküyor" hatasının kaynağı budur. Bu yüzden her ayrıştırılan dosya için
// kod bloğunun düzgün kapanıp kapanmadığını da işaretliyoruz; çağıran taraf
// (kod-yaz.ts) bunu görüp kullanıcıyı uyarabilir.

export interface ParsedCodeFile {
  filename: string;
  code: string;
  /** true ise, bu dosyanın kod bloğu kapanmamış/yarıda kesilmiş görünüyor. */
  truncated: boolean;
}

// !kod-analiz / !kod-test / !kod-duzelt üçünün de eklenmiş dosyayı indirme
// mantığı birebir aynıydı (ve üçünde de aynı eksik vardı): fetch() için hiç
// timeout yoktu. Discord CDN yavaşlarsa/takılırsa komut sonsuza kadar
// "işleniyor..." mesajında asılı kalıyordu — hiç hata bile vermiyordu. Ayrıca
// res.ok kontrol edilmiyordu, yani CDN bir hata sayfası dönerse o metin
// sessizce "kod" olarak kabul edilip analiz ediliyordu. Tek yerden, hem
// zaman aşımlı hem hataya karşı sağlam bir indirme fonksiyonu:
const ATTACHMENT_FETCH_TIMEOUT_MS = 15_000;

export async function fetchAttachmentText(url: string): Promise<string> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), ATTACHMENT_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      throw new Error(`Dosya indirilemedi (HTTP ${res.status}).`);
    }
    return await res.text();
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`Dosya indirme zaman aşımına uğradı (${ATTACHMENT_FETCH_TIMEOUT_MS / 1000}sn) — tekrar dene.`);
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

const FILE_MARKER_RE = /===\s*FILE:\s*(.+?)\s*===/gi;

interface ExtractedBlock {
  code: string;
  /** Bloğun kapanış ``` işaretiyle düzgün bitip bitmediği. */
  closed: boolean;
}

/** İlk kod bloğunu çıkarır: önce verilen `fence` diline özel, sonra genel, sonra "açık kalmış" blok. */
function extractFirstCodeBlockDetailed(raw: string, fence?: string): ExtractedBlock | null {
  if (fence) {
    const named = raw.match(new RegExp("```(?:" + fence + ")\\n([\\s\\S]*?)```", "i"));
    if (named) return { code: named[1].trim(), closed: true };
  }
  const generic = raw.match(/```[a-zA-Z0-9_+-]*\n([\s\S]*?)```/);
  if (generic) return { code: generic[1].trim(), closed: true };
  // Kapanış ``` bulunamadı: cevap muhtemelen token limiti yüzünden yarıda
  // kesilmiş. Yine de elimizdeki kısmi kodu döndürüyoruz (hiç dosya
  // vermemekten daha iyi) ama "closed: false" ile işaretliyoruz.
  const openOnly = raw.match(/```[a-zA-Z0-9_+-]*\n([\s\S]*)$/);
  if (openOnly) return { code: openOnly[1].trim(), closed: false };
  return null;
}

/** Geriye uyumluluk için: sadece kod metnini döner (kapanış durumunu görmezden gelir). */
export function extractFirstCodeBlock(raw: string, fence?: string): string | null {
  return extractFirstCodeBlockDetailed(raw, fence)?.code ?? null;
}

export interface CodeBlockWithRest {
  /** Kod bloğunun içeriği. */
  code: string;
  /** Kod bloğundan sonra kalan metin (ör. "DEĞİŞİKLİKLER:" / "TEST SENARYOLARI:" bölümü). */
  rest: string;
  /** true ise kod bloğu kapanmamış görünüyor (muhtemelen token limiti yüzünden yarıda kesildi). */
  truncated: boolean;
}

/**
 * !kod-duzelt ve !kod-test gibi "önce kod bloğu, sonra açıklama metni"
 * formatındaki cevapları ayrıştırır. extractFirstCodeBlockDetailed'dan
 * farkı: kod bloğundan SONRAKİ metni de ("rest") ayrıca döndürür.
 */
export function extractCodeBlockWithRest(raw: string, fence?: string): CodeBlockWithRest {
  if (fence) {
    const named = raw.match(new RegExp("```(?:" + fence + ")\\n([\\s\\S]*?)```", "i"));
    if (named) {
      return {
        code: named[1].trim(),
        rest: raw.slice(named.index! + named[0].length).trim(),
        truncated: false,
      };
    }
  }
  const generic = raw.match(/```[a-zA-Z0-9_+-]*\n([\s\S]*?)```/);
  if (generic) {
    return {
      code: generic[1].trim(),
      rest: raw.slice(generic.index! + generic[0].length).trim(),
      truncated: false,
    };
  }
  // Kapanış ``` yok: cevap muhtemelen yarıda kesildi. Devam ettirme
  // mekanizması (bkz. utils/openrouter.ts / utils/gemini.ts) çoğu zaman
  // bunu zaten önler, ama son çare olarak burada da işaretliyoruz.
  const openOnly = raw.match(/```[a-zA-Z0-9_+-]*\n([\s\S]*)$/);
  if (openOnly) {
    return { code: openOnly[1].trim(), rest: "", truncated: true };
  }
  // Hiç kod bloğu yok (fence hiç kullanılmamış) — modelin format
  // hatasıdır, kesilme değil; ham metni olduğu gibi döndürüyoruz.
  return { code: raw.trim(), rest: "", truncated: false };
}

function sanitizeFilename(raw: string, fallbackExt: string): string {
  const cleaned = raw
    .replace(/[`"'*]/g, "")
    .replace(/^[./\\]+/, "")
    .replace(/[\\/]/g, "-") // olası dizin ayraçlarını düzleştir, path traversal'ı engelle
    .trim()
    .slice(0, 80);
  if (!cleaned) return `dosya.${fallbackExt}`;
  return cleaned.includes(".") ? cleaned : `${cleaned}.${fallbackExt}`;
}

/**
 * Modelin döndürdüğü ham metinden bir veya birden fazla dosya çıkarır.
 * "===FILE: ...===" başlığı yoksa tek dosyalık eski davranışa düşer.
 * Her dosyanın `truncated` alanı, kod bloğunun düzgün kapanıp kapanmadığını
 * gösterir (bkz. dosya başındaki not).
 */
export function extractCodeFiles(
  raw: string,
  fallbackFilename: string,
  fallbackFence?: string,
): ParsedCodeFile[] {
  const hits: { filename: string; matchStart: number; contentStart: number }[] = [];
  const re = new RegExp(FILE_MARKER_RE.source, FILE_MARKER_RE.flags);
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    hits.push({ filename: m[1].trim(), matchStart: m.index, contentStart: m.index + m[0].length });
  }

  const fallbackExt = fallbackFilename.includes(".") ? fallbackFilename.split(".").pop()! : "txt";

  if (hits.length === 0) {
    const block = extractFirstCodeBlockDetailed(raw, fallbackFence);
    return block ? [{ filename: fallbackFilename, code: block.code, truncated: !block.closed }] : [];
  }

  const files: ParsedCodeFile[] = [];
  for (let i = 0; i < hits.length; i++) {
    const isLast = i + 1 >= hits.length;
    const segmentEnd = isLast ? raw.length : hits[i + 1].matchStart;
    const segment = raw.slice(hits[i].contentStart, segmentEnd);
    const block = extractFirstCodeBlockDetailed(segment);
    const code = block?.code ?? segment.trim();
    if (!code) continue;
    // Bir sonraki "===FILE:" başlığıyla düzgün bir şekilde bitmiş segmentler
    // (son dosya hariç) zaten model tarafından tamamlanmış demektir; kapanış
    // ``` işareti eksik olsa bile bunu "kesilmiş" saymıyoruz. Yalnızca en
    // sonuncu dosya (metnin gerçekten bittiği yer) için kapanış kontrolü
    // truncation göstergesi olarak anlamlıdır.
    const truncated = isLast ? !(block?.closed ?? true) : false;
    files.push({ filename: sanitizeFilename(hits[i].filename, fallbackExt), code, truncated });
  }

  // Başlıklar bulundu ama hiçbirinin içinde geçerli kod yoksa yine de eski
  // davranışa (tek dosya, tüm metinden çıkarım) düş.
  if (files.length === 0) {
    const block = extractFirstCodeBlockDetailed(raw, fallbackFence);
    return block ? [{ filename: fallbackFilename, code: block.code, truncated: !block.closed }] : [];
  }

  return files;
}
