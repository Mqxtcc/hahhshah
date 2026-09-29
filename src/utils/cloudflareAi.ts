import { loadEnv } from "./env.js";
import { generateWithGroq } from "./groq.js";

loadEnv();

// !modeller > "Groq ve Diğerleri" grubunda o an seçili olan model, kullanıcının
// Türkçe çizim isteğini FLUX.2 [klein] 9B için detaylı, İngilizce bir görsel
// prompt'una çeviriyor. generateWithGroq() modeli kendisi seçiyor
// (getActiveModel("groq")), yani owner !modeller ile modeli değiştirirse bu
// çeviri/zenginleştirme adımı da otomatik olarak o modeli kullanır.
const PROMPT_ENRICH_SYSTEM = `Sen bir text-to-image üretim modeli (FLUX.2) için prompt yazan bir uzmansın.
Görevin: kullanıcının Türkçe (veya karışık) çizim isteğini, İngilizce, zengin ve görsel açıdan somut bir prompt'a dönüştürmek.

KURALLAR:
- Yalnızca üretilecek prompt metnini döndür. Açıklama, giriş cümlesi, tırnak işareti, markdown ya da "Prompt:" gibi etiket EKLEME.
- Kullanıcının isteğindeki tüm niyeti ve varsa özel isim/detayları koru, uydurma yeni bir konu ekleme.
- Sahneyi somutlaştır: konu, kompozisyon/kadraj, ışık, renk paleti, atmosfer, sanat stili/ortam (ör. dijital illüstrasyon, fotogerçekçi, yağlı boya vb.) ve önemli detaylar hakkında kısa ama zengin betimlemeler ekle.
- Kullanıcı zaten bir stil belirtmişse ona sadık kal; belirtmemişse sahneye uygun mantıklı bir stil seç.
- Reklam/marka isimleri, gerçek/ünlü kişiler veya telif hakkıyla korunan karakterler istenmişse, en yakın jenerik/özgün betimlemeyle değiştir.
- Prompt İngilizce ve tek paragraf olsun, 60-120 kelime aralığında tut.`;

export async function enrichDrawPrompt(rawRequest: string): Promise<string> {
  try {
    const enriched = await generateWithGroq(PROMPT_ENRICH_SYSTEM, rawRequest, {
      maxTokens: 600,
      temperature: 0.45,
    });
    const cleaned = enriched
      .trim()
      .replace(/^["'`]+|["'`]+$/g, "")
      .replace(/^prompt\s*:\s*/i, "")
      .trim();
    if (isPromptRefusal(cleaned)) {
      // Groq bazen masum isteklerde bile güvenlik filtresiyle reddediyor
      // ("sorry but i can't help with that" vb.). Bu red metni görsel
      // modeline prompt olarak giderse çöp sonuç çıkıyor — hata yolundaki
      // gibi sessizce ham isteğe düş, kullanıcı yine de görsel alabilsin.
      console.warn(
        "çiz: groq prompt'u reddetti, ham haliyle devam:",
        cleaned.slice(0, 200),
      );
      return rawRequest;
    }
    return cleaned || rawRequest;
  } catch (err) {
    // Zenginleştirme başarısız olursa (örn. Groq/sağlayıcı hatası) sessizce
    // ham isteğe düş — kullanıcı yine de bir görsel alabilsin.
    console.warn("çiz: prompt zenginleştirme tutmadı, ham haliyle devam:", err);
    return rawRequest;
  }
}

/**
 * Groq'un prompt zenginleştirmeyi reddedip reddetmediğini anlar.
 * Reddederse true döner — çağıran ham isteğe düşmelidir; red metni asla
 * görsel üretim modeline prompt olarak gönderilmemelidir.
 */
export function isPromptRefusal(text: string): boolean {
  return REFUSAL_PATTERNS.some((re) => re.test(text));
}

// Groq/Llama tarzı red kalıpları (İngilizce + nadir Türkçe redler).
const REFUSAL_PATTERNS: RegExp[] = [
  /i'?m sorry,? but i can'?t help/i,
  /i can'?t (?:help|assist)(?: with| you)/i,
  /i'?m (?:unable|not able) to/i,
  /i am (?:unable|not able) to/i,
  /cannot (?:help|assist)(?: with| you)/i,
  /\bas an ai\b/i,
  /as an ai language model/i,
  /yard[ıi]mc[ıi] olamam/i,
  /[üu]zg[üu]n[üu]m.{0,60}yard[ıi]mc[ıi] olam/i,
];

// FLUX.2 [klein] 9B — flux-1-schnell'e göre çok daha kaliteli/özenli sonuçlar
// veren, Black Forest Labs'ın Workers AI üzerinde barındırdığı distilled
// model. Workers AI'da bu model SABİT 4 adımlı (num_steps ayarlanamıyor) —
// yani "daha çok düşünsün" isteğini adım sayısını artırarak karşılayamıyoruz.
// Bunun yerine iki şeyle telafi ediyoruz:
//   1) Daha büyük/daha yetenekli model (9B) -> aynı 4 adımda bile daha
//      detaylı ve tutarlı görseller üretiyor.
//   2) çiz komutu artık ham isteği doğrudan göndermiyor; önce seçili Groq
//      modeliyle (bkz. utils/groq.ts + !modeller) zenginleştirilmiş,
//      İngilizce, detaylı bir prompt'a çevriliyor (bkz. buildImagePrompt
//      aşağıda / commands/fun/ciz.ts) — modelin "özensiz" davranmasının asıl
//      sebebi çoğu zaman kısa/belirsiz prompt'tu.
//   3) guidance değeri yükseltilerek modelin prompt'a daha sıkı sadık
//      kalması sağlanıyor.
export const DEFAULT_CLOUDFLARE_IMAGE_MODEL =
  "@cf/black-forest-labs/flux-2-klein-9b";

export const CLOUDFLARE_MAX_PROMPT_CHARS = 2_048;

// FLUX.2 [klein] 9B için Workers AI varsayılanı: guidance yükseltilerek
// modelin prompt'taki detaylara daha sadık kalması, dolayısıyla daha "özenli"
// görünen sonuçlar üretmesi hedefleniyor (bkz. yukarıdaki not).
const DEFAULT_GUIDANCE = 4.5;
const DEFAULT_WIDTH = 1024;
const DEFAULT_HEIGHT = 1024;

const REQUEST_TIMEOUT_MS = 90_000;

export type CloudflareAiErrorKind =
  | "config"
  | "http"
  | "timeout"
  | "empty"
  | "nsfw";

export class CloudflareAiError extends Error {
  constructor(
    message: string,
    public readonly kind: CloudflareAiErrorKind,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "CloudflareAiError";
  }
}

export type CloudflareImageResult = {
  buffer: Buffer;
  extension: string;
  model: string;
};

export function getCloudflareImageModel(): string {
  return (
    process.env.CLOUDFLARE_IMAGE_MODEL?.trim() ||
    DEFAULT_CLOUDFLARE_IMAGE_MODEL
  );
}

function detectExtension(buffer: Buffer, contentType?: string): string {
  if (buffer.length >= 4 && buffer.readUInt32BE(0) === 0x89504e47) return "png";
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    return "jpg";
  }
  if (
    buffer.length >= 12 &&
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "webp";
  }
  if (contentType?.includes("png")) return "png";
  if (contentType?.includes("webp")) return "webp";
  return "jpg";
}

type CloudflareEnvelope = {
  success?: boolean;
  result?: { image?: unknown } | null;
  errors?: { code?: number; message?: string }[];
};

function parseEnvelope(raw: string): CloudflareEnvelope | null {
  try {
    const data: unknown = raw ? JSON.parse(raw) : null;
    return data && typeof data === "object" ? (data as CloudflareEnvelope) : null;
  } catch {
    return null;
  }
}

function toFriendlyError(
  status: number,
  envelope: CloudflareEnvelope | null,
  raw: string,
): CloudflareAiError {
  const first = envelope?.errors?.[0];
  const detail = (first?.message ?? raw.slice(0, 300)).trim();

  if (first?.code === 3030 || /nsfw/i.test(detail)) {
    return new CloudflareAiError(
      "İstek içerik filtresine takıldı. İsteği daha açıklayıcı ve farklı bir şekilde yazıp tekrar dene.",
      "nsfw",
      status,
    );
  }
  if (status === 401 || status === 403) {
    return new CloudflareAiError(
      "Cloudflare API token'ı geçersiz veya Workers AI yetkisi yok.",
      "http",
      status,
    );
  }
  if (status === 429 || /daily free allocation|neurons/i.test(detail)) {
    return new CloudflareAiError(
      "Cloudflare AI kullanım limiti doldu. Biraz sonra tekrar dene.",
      "http",
      status,
    );
  }
  return new CloudflareAiError(
    `Cloudflare AI hatası (${status}): ${detail || "bilinmeyen hata"}`,
    "http",
    status,
  );
}

export interface CloudflareImageOptions {
  /** Modelin prompt'a ne kadar sıkı sadık kalacağı (yüksek = daha sadık). */
  guidance?: number;
  width?: number;
  height?: number;
  seed?: number;
}

export async function generateCloudflareImage(
  prompt: string,
  options: CloudflareImageOptions = {},
): Promise<CloudflareImageResult> {
  const token = process.env.CLOUDFLARE_API_TOKEN_1?.trim();
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
  if (!token || !accountId) {
    throw new CloudflareAiError(
      "CLOUDFLARE_API_TOKEN_1 ve CLOUDFLARE_ACCOUNT_ID .env dosyasında tanımlı olmalı.",
      "config",
    );
  }

  const cleanPrompt = prompt.trim().slice(0, CLOUDFLARE_MAX_PROMPT_CHARS);
  if (!cleanPrompt) {
    throw new CloudflareAiError("Boş istek gönderilemez.", "empty");
  }

  const model = getCloudflareImageModel();
  const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/run/${model}`;

  // FLUX.2 [klein] 9B (ve genel olarak flux-2-* ailesi) Workers AI'da
  // multipart/form-data bekliyor — flux-1-schnell'in kullandığı düz JSON
  // gövdeden farklı. `steps` kasıtlı olarak GÖNDERİLMİYOR: Klein 9B'de sabit
  // 4 adımda kilitli, gönderilse de yok sayılır.
  const form = new FormData();
  form.append("prompt", cleanPrompt);
  form.append("width", String(options.width ?? DEFAULT_WIDTH));
  form.append("height", String(options.height ?? DEFAULT_HEIGHT));
  form.append("guidance", String(options.guidance ?? DEFAULT_GUIDANCE));
  if (options.seed !== undefined) form.append("seed", String(options.seed));

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
      },
      signal: controller.signal,
      body: form,
    });

    const contentType = response.headers.get("content-type") ?? "";

    if (response.ok && contentType.startsWith("image/")) {
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length === 0) {
        throw new CloudflareAiError("Cloudflare AI boş görsel döndürdü.", "empty");
      }
      return { buffer, extension: detectExtension(buffer, contentType), model };
    }

    const raw = await response.text();
    const envelope = parseEnvelope(raw);

    if (!response.ok || envelope?.success === false) {
      throw toFriendlyError(response.status, envelope, raw);
    }

    const image = envelope?.result?.image;
    if (typeof image !== "string" || !image.trim()) {
      throw new CloudflareAiError(
        "Cloudflare AI beklenen görsel verisini döndürmedi.",
        "empty",
      );
    }
    const buffer = Buffer.from(image, "base64");
    if (buffer.length === 0) {
      throw new CloudflareAiError("Cloudflare AI boş görsel döndürdü.", "empty");
    }
    return { buffer, extension: detectExtension(buffer), model };
  } catch (error) {
    if (error instanceof CloudflareAiError) throw error;
    const isAbort =
      error instanceof Error &&
      (error.name === "AbortError" ||
        error.message.toLowerCase().includes("abort"));
    if (isAbort) {
      throw new CloudflareAiError(
        "Görsel üretimi zaman aşımına uğradı, tekrar dene.",
        "timeout",
      );
    }
    throw new CloudflareAiError(
      error instanceof Error ? error.message : String(error),
      "http",
    );
  } finally {
    clearTimeout(timeoutId);
  }
}