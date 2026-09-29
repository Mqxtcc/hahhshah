// src/utils/gemini.ts
// Google Gemini 3.6 Flash entegrasyonu (503 -> alt modele otomatik düşer)
// https://ai.google.dev/

import { getActiveModel, MODEL_GROUPS } from "./modelSettings.js";

const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

// Sırayla denenecek modeller. İlki aşırı yoğunluktan (503 UNAVAILABLE) hata
// verirse otomatik olarak bir sonrakine düşülür.
//
// Bu, KODDAKİ orijinal/varsayılan sıralamadır. !modeller ile owner farklı bir
// Gemini modeli seçerse (bkz. utils/modelSettings.ts), o model bu zincirin
// EN BAŞINA konur (aynı model zaten listedeyse yer değiştirir, listede yoksa
// eklenir) — böylece seçilen model önce denenir ama 503 durumunda yine de bu
// güvenlik ağına (fallback) düşülebilir.
// Varsayılan model (gemini-3.5-flash) zincirin BAŞINDA: owner !modeller'de
// değişiklik yapmadıysa istekler önce varsayılan modele gider, 503'te alta düşer.
const DEFAULT_MODEL_FALLBACK_CHAIN = [
  "gemini-3.5-flash",
  "gemini-3.1-pro-preview",
  "gemini-3.6-flash",
  "gemini-3.5-flash-lite",
] as const;

function resolveModelFallbackChain(): string[] {
  const selected = getActiveModel("gemini");
  if (selected === MODEL_GROUPS.gemini.defaultModel) {
    return [...DEFAULT_MODEL_FALLBACK_CHAIN];
  }
  return [selected, ...DEFAULT_MODEL_FALLBACK_CHAIN.filter((m) => m !== selected)];
}

// Gemini 3.x modelleri tek istekte 65.536 token'a kadar çıktı destekliyor.
// Kullanıcı "uzun" bir şey istediğinde burada sınır olmasın diye bu tavanı
// kullanıyoruz; pratik olarak hiçbir kod dosyası bunu doldurmaz.
const MAX_TOKENS_PER_CALL = 65_536;

// Devam mekanizması için güvenlik freni (sonsuz döngüye girmesin diye).
// 65.536 x 5 zaten aşırı büyük bir bütçe, kullanıcı için gerçek bir sınır
// gibi hissettirmez.
const MAX_CONTINUATIONS = 5;

// Tek bir HTTP isteği için zaman aşımı.
const REQUEST_TIMEOUT_MS = 120_000;

type ChatMessage = { role: "user" | "model"; content: string };

class RateLimitError extends Error {
  status = 429;
  constructor(message = "Rate limit / kota (429)") {
    super(message);
  }
}

// Model aşırı yoğun olduğunda (503 UNAVAILABLE) fırlatılır; bunu yakalayıp
// bir alt/farklı modele otomatik geçiyoruz.
class ModelUnavailableError extends Error {
  status = 503;
  constructor(message = "Model şu an aşırı yoğun (503)") {
    super(message);
  }
}

// Key'in bağlı olduğu Google Cloud projesi engellenmiş/reddedilmişse
// (403 PERMISSION_DENIED) fırlatılır; bu key artık kullanılamaz demektir,
// otomatik olarak sıradaki key'e geçiyoruz.
class KeyDeniedError extends Error {
  status = 403;
  constructor(message = "Key reddedildi (403)") {
    super(message);
  }
}

type CallResult = { content: string; finishReason: string | null };

type JsonRecord = Record<string, unknown>;
function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null;
}

async function callOnce(
  apiKey: string,
  model: string,
  systemPrompt: string,
  messages: ChatMessage[],
  maxTokens: number,
): Promise<CallResult> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(
      `${GEMINI_BASE_URL}/models/${model}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemPrompt }] },
          contents: messages.map((m) => ({
            role: m.role,
            parts: [{ text: m.content }],
          })),
          // NOT: temperature/top_p/top_k Gemini 3.x'te deprecated ve
          // yakında 400 hatasına yol açacağı belirtiliyor, o yüzden
          // bilinçli olarak göndermiyoruz.
          generationConfig: {
            maxOutputTokens: maxTokens,
          },
        }),
      },
    );

    clearTimeout(timeoutId);

    if (res.status === 429) throw new RateLimitError();
    if (res.status === 503) throw new ModelUnavailableError();
    if (res.status === 403) {
      const body = await res.text().catch(() => "");
      throw new KeyDeniedError(`Key reddedildi (403): ${body.slice(0, 200)}`);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`API hatası (${res.status}): ${body.slice(0, 300)}`);
    }

    const data: unknown = await res.json();
    const candidate = isRecord(data) && Array.isArray(data.candidates) && isRecord(data.candidates[0])
      ? data.candidates[0]
      : undefined;
    const parts = candidate && isRecord(candidate.content) && Array.isArray(candidate.content.parts)
      ? candidate.content.parts
      : [];
    const text = parts
      .filter(isRecord)
      .map((part) => typeof part.text === "string" ? part.text : "")
      .join("");
    const finishReason: string | null = candidate && typeof candidate.finishReason === "string"
      ? candidate.finishReason
      : null;

    return { content: text, finishReason };
  } catch (err) {
    clearTimeout(timeoutId);
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error("Timeout (120sn) — model çok uzun sürdü, tekrar dene.");
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

// Gemini'nin cevabı token limiti yüzünden yarıda kesilirse (MAX_TOKENS),
// kaldığı yerden devam ettirip parçaları birleştirir. Böylece kullanıcı
// "uzun" bir şey isterse dosya yarıda kalmaz.
async function callWithContinuation(
  apiKey: string,
  model: string,
  systemPrompt: string,
  userPrompt: string,
): Promise<string> {
  const messages: ChatMessage[] = [{ role: "user", content: userPrompt }];

  let fullText = "";

  for (let i = 0; i <= MAX_CONTINUATIONS; i++) {
    const { content, finishReason } = await callOnce(
      apiKey,
      model,
      systemPrompt,
      messages,
      MAX_TOKENS_PER_CALL,
    );

    fullText += content;

    if (finishReason !== "MAX_TOKENS") {
      // Model normal şekilde bitirdi (STOP) ya da başka bir sebeple durdu.
      return fullText;
    }

    if (i === MAX_CONTINUATIONS) {
      break;
    }

    messages.push({ role: "model", content });
    messages.push({
      role: "user",
      content:
        "Cevabın token limiti yüzünden yarıda kesildi. Kaldığın YERDEN " +
        "devam et. Baştan tekrar başlama, önceki kısmı tekrar yazma, " +
        "hiçbir açıklama ekleme — sadece kesildiğin noktadan itibaren " +
        "kodun geri kalanını yaz.",
    });
  }

  return fullText;
}

// .env'den okunan anahtarlar arasında otomatik round-robin: her komut
// çağrısı sırayla farklı bir anahtarla başlar (GEMINI_KOD, GEMINI_KOD_2,
// GEMINI_API_KEY_1, ..., GEMINI_API_KEY_7 — toplam 9 key'e kadar).
// Boş/tanımsız olan key'ler otomatik atlanır. Ayrıca model bazında da
// otomatik fallback var:
// - 429 (kota/rate limit)     -> aynı model, sıradaki anahtar
// - 403 (key reddedildi)      -> aynı model, sıradaki anahtar (bu key artık
//                                hiç denenmez)
// - 503 (aşırı yoğun)         -> aynı anahtar(lar), MODEL_FALLBACK_CHAIN'deki
//                                bir sonraki model
const GEMINI_KEY_ENV_NAMES = [
  "GEMINI_KOD",
  "GEMINI_KOD_2",
  "GEMINI_API_KEY_1",
  "GEMINI_API_KEY_2",
  "GEMINI_API_KEY_3",
  "GEMINI_API_KEY_4",
  "GEMINI_API_KEY_5",
  "GEMINI_API_KEY_6",
  "GEMINI_API_KEY_7",
] as const;

let keyRotationIndex = 0;

// Loglarda anahtarı ASLA kısmi olarak bile göstermiyoruz — hangi env
// değişkeninden geldiğini (ör. "GEMINI_API_KEY_3") gösteriyoruz. Anahtarın
// ilk 8 karakteri önceden loga yazılıyordu; bu, host sağlayıcı loglarına
// (Wispbyte/Pterodactyl vb.) sızabilecek gereksiz bir bilgi ifşasıydı —
// env adı hata ayıklama için zaten yeterli ve hiçbir gizli veri içermiyor.
function getConfiguredKeys(): { key: string; label: string }[] {
  return GEMINI_KEY_ENV_NAMES.flatMap((name) => {
    const key = process.env[name]?.trim();
    return key ? [{ key, label: name }] : [];
  });
}

async function generateRequest(
  systemPrompt: string,
  userPrompt: string,
  modelOverride?: string,
): Promise<string> {
  const keys = getConfiguredKeys();

  if (keys.length === 0) {
    throw new Error(
      "GEMINI_API_KEY bulunamadı!\n\n" +
      "1. https://aistudio.google.com/apikey adresine git\n" +
      "2. Bir veya daha fazla API key oluştur\n" +
      "3. .env'ye ekle (en az bir tanesi yeterli, round-robin için birden fazlası önerilir):\n\n" +
      "GEMINI_KOD=your_key_here\n" +
      "GEMINI_KOD_2=your_key_here\n" +
      "GEMINI_API_KEY_1=your_key_here\n" +
      "...\n" +
      "GEMINI_API_KEY_7=your_key_here",
    );
  }

  const startIndex = keyRotationIndex % keys.length;
  keyRotationIndex = (keyRotationIndex + 1) % Number.MAX_SAFE_INTEGER;

  let lastErr: unknown;

  // modelOverride verildiyse (ör. !kod-yaz için "kod modeli" olarak açıkça
  // bir Gemini modeli seçilmişse — bkz. utils/codeModel.ts), o modeli
  // zincirin başına koyup dener; olmazsa yine standart fallback zincirine
  // düşer. Verilmezse eskisi gibi !modeller'daki genel Gemini seçimi kullanılır.
  const chain = modelOverride
    ? [modelOverride, ...DEFAULT_MODEL_FALLBACK_CHAIN.filter((m) => m !== modelOverride)]
    : resolveModelFallbackChain();

  for (const model of chain) {
    for (let offset = 0; offset < keys.length; offset++) {
      const { key, label } = keys[(startIndex + offset) % keys.length];
      try {
        return await callWithContinuation(key, model, systemPrompt, userPrompt);
      } catch (err) {
        lastErr = err;

        if (err instanceof RateLimitError) {
          continue; // aynı modeli sıradaki anahtarla dene
        }
        if (err instanceof KeyDeniedError) {
          console.warn(`gemini key reddedildi (403): ${label}, sonrakine geçiyorum`);
          continue; // bu key kalıcı olarak reddedilmiş, sıradaki anahtarla dene
        }
        if (err instanceof ModelUnavailableError) {
          break; // bu modelde ısrar etme, fallback zincirinde sıradakine geç
        }
        // Beklenmeyen bir hata (ağ hatası, geçersiz model adı, 400/404 vs.).
        // Eskiden burada hemen `throw err` yapılıyordu; bu da elimizde hâlâ
        // denenmemiş anahtar/model kombinasyonu varken (örn. tek bir anahtarda
        // geçici bir ağ sorunu olduğunda) TÜM isteğin gereksiz yere tamamen
        // başarısız olmasına yol açıyordu — kullanıcı "her denediğimde hata
        // veriyor" şikayetinin asıl kaynağı buydu. Artık diğer anahtarlarla
        // (ve gerekirse diğer modellerle) denemeye devam ediyoruz, sadece
        // hiçbiri işe yaramazsa en sondaki hatayı fırlatıyoruz.
        console.warn(`gemini (${model}, ${label}) patladı, sonraki deneniyor:`, err);
        continue;
      }
    }
  }

  throw lastErr instanceof Error ? lastErr : new Error("İstek başarısız.");
}

export async function generateWithGemini(
  systemPrompt: string,
  userPrompt: string,
  modelOverride?: string,
): Promise<string> {
  return generateRequest(systemPrompt, userPrompt, modelOverride);
}
