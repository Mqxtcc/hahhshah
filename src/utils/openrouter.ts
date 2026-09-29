// src/utils/openrouter.ts
// OpenRouter üzerinden MiniMax M3 (ücretsiz) entegrasyonu.
// https://openrouter.ai/

import { getActiveModel } from "./modelSettings.js";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
// Varsayılan model utils/modelSettings.ts'te (MODEL_GROUPS.openrouter.defaultModel)
// tanımlı; !modeller ile owner değiştirirse callOnce'a o model geçirilir.

// Eskiden 8_000'di — animasyonlu/çok dosyalı bir website gibi büyük
// istekler bu limiti aşınca cevap yarıda kesiliyordu (bkz. commit notu
// aşağıda). Kullanıcı OpenRouter'da aynı anahtarla tek istekte 200k
// token'ın sorunsuz döndüğünü doğruladığı için tavanı büyük tuttuk.
const MAX_TOKENS_PER_CALL = 100_000;
const REQUEST_TIMEOUT_MS = 120_000;

// Cevap yine de token limiti yüzünden yarıda kesilirse (finish_reason:
// "length" — MAX_TOKENS_PER_CALL yükseltildikten sonra pratikte neredeyse
// hiç olmaması gerekir ama sağlayıcı tarafında olası bir düşüş/limit
// değişikliğine karşı yine de tutuyoruz), modele "kaldığın yerden devam
// et" diyerek otomatik olarak tekrar sorup parçaları birleştiriyoruz. Bu
// olmadan, örneğin "hareketli/animasyonlu bir website" gibi büyük bir
// HTML+CSS+JS isteği limiti aşınca dosya yarıda kesiliyor ve script tam
// kapanmadığı için sitede butonlar çalışmıyor / scroll'da JS hatası alınıp
// sayfa bozuluyordu — gerçekte yaşanmış bir hataydı.
const MAX_CONTINUATIONS = 4;

class RateLimitError extends Error {
  status = 429;
  constructor(message = "Rate limit / kota (429)") {
    super(message);
  }
}

class KeyDeniedError extends Error {
  status = 401;
  constructor(message = "Key reddedildi (401/403)") {
    super(message);
  }
}

type JsonRecord = Record<string, unknown>;
function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null;
}

// .env'de sırayla denenecek OpenRouter anahtarları: OP_KOD_1..OP_KOD_6.
// Boş/tanımsız olanlar otomatik atlanır.
const OPENROUTER_KEY_ENV_NAMES = ["OP_KOD_1", "OP_KOD_2", "OP_KOD_3", "OP_KOD_4", "OP_KOD_5", "OP_KOD_6"] as const;

let keyRotationIndex = 0;

function getConfiguredKeys(): { key: string; label: string }[] {
  // BUG NOTU: boşluk/CR kontrolü `.trim()` ile yapılıyordu ama filtreden
  // geçen değer trim EDİLMEMİŞ orijinal `process.env[name]` idi. .env
  // dosyasında satır sonunda görünmeyen bir boşluk ya da (özellikle
  // Windows'ta CRLF ile kaydedilmiş .env dosyalarında oluşan) bir "\r"
  // karakteri varsa, key'in kendisi doğru olsa bile Authorization
  // header'ına o fazladan karakterle gidiyor ve OpenRouter bunu geçersiz
  // sayıp "401 user not found" ile reddediyordu. Artık gerçekten
  // kullanılan değer de trim ediliyor.
  return OPENROUTER_KEY_ENV_NAMES.flatMap((name) => {
    const key = process.env[name]?.trim();
    return key ? [{ key, label: name }] : [];
  });
}

type ChatMessage = { role: "system" | "user" | "assistant"; content: string };
type CallResult = { content: string; finishReason: string | null };

async function callOnce(apiKey: string, messages: ChatMessage[], model: string): Promise<CallResult> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        max_tokens: MAX_TOKENS_PER_CALL,
        messages,
      }),
    });

    clearTimeout(timeoutId);

    if (res.status === 429) throw new RateLimitError();
    if (res.status === 401 || res.status === 403) {
      const body = await res.text().catch(() => "");
      throw new KeyDeniedError(`Key reddedildi (${res.status}): ${body.slice(0, 200)}`);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`OpenRouter API hatası (${res.status}): ${body.slice(0, 300)}`);
    }

    const data: unknown = await res.json();

    // BUG NOTU: OpenRouter, özellikle ücretsiz modellerde (moderasyon,
    // sağlayıcı tarafı geçici hata, model o an kullanılamıyor vb.
    // durumlarda) bazen HTTP 200 döner ama gövdede "choices" yerine
    // üst seviye bir "error" objesi gönderir. Eskiden bu hiç kontrol
    // edilmiyordu; "choices[0]" bulunamayınca kod sessizce "boş yanıt"
    // hatası fırlatıyor ve gerçek sebep (rate limit, moderasyon,
    // sağlayıcı çökmesi vb.) tamamen gizleniyordu. Artık varsa önce bu
    // hatayı ayıklayıp asıl mesajla fırlatıyoruz.
    if (isRecord(data) && isRecord(data.error)) {
      const rawCode = data.error.code;
      const code = typeof rawCode === "number" || typeof rawCode === "string" ? rawCode : "?";
      // rawCode "429" (string) ya da 429 (number) olarak gelebilir — ikisini
      // de yakalamak için sayısal karşılaştırma yapıyoruz (eskiden `=== 429`
      // gibi katı karşılaştırmalar string "429"u kaçırıp genel/yanlış
      // sınıflandırılmış bir hataya düşüyordu, bu da key rotasyonunun
      // 429'da bir sonraki anahtara geçmesini engelliyordu).
      const numericCode = typeof code === "number" ? code : Number(code);
      const msg = typeof data.error.message === "string" ? data.error.message : JSON.stringify(data.error).slice(0, 300);
      if (numericCode === 429) throw new RateLimitError(`OpenRouter (${code}): ${msg}`);
      if (numericCode === 401 || numericCode === 403) throw new KeyDeniedError(`OpenRouter (${code}): ${msg}`);
      throw new Error(`OpenRouter hata döndürdü (${code}): ${msg}`);
    }

    const choice = isRecord(data) && Array.isArray(data.choices) && isRecord(data.choices[0])
      ? data.choices[0]
      : undefined;
    const message = choice && isRecord(choice.message) ? choice.message : undefined;

    // Bazı sağlayıcılar content'i düz string yerine parça dizisi olarak
    // dönebiliyor (ör. [{type:"text", text:"..."}, ...]). Eskiden sadece
    // typeof === "string" kabul edildiği için bu durumda da yanlışlıkla
    // "boş yanıt" hatası veriliyordu.
    let text = "";
    if (message && typeof message.content === "string") {
      text = message.content;
    } else if (message && Array.isArray(message.content)) {
      text = message.content
        .map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : ""))
        .join("");
    }

    const finishReason: string | null = choice && typeof choice.finish_reason === "string"
      ? choice.finish_reason
      : null;

    if (!text.trim()) {
      // finish_reason burada teşhis için değerli — "content_filter" ise
      // moderasyon, "error" ise sağlayıcı tarafı bir hata anlamına gelir.
      throw new Error(
        `OpenRouter boş bir yanıt döndürdü${finishReason ? ` (finish_reason: ${finishReason})` : ""}.`,
      );
    }

    return { content: text, finishReason };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`Timeout (${REQUEST_TIMEOUT_MS / 1000}sn) — model çok uzun sürdü.`);
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

// Cevap "length" (token limiti) yüzünden kesildiyse, konuşmaya modelin
// yarım kalan cevabını ekleyip "kaldığın yerden devam et" diyerek tekrar
// soruyor ve parçaları birleştiriyor. Aynı Gemini fallback'indeki
// (utils/gemini.ts) mantığın OpenRouter karşılığı.
async function callWithContinuation(
  apiKey: string,
  systemPrompt: string,
  userPrompt: string,
  model: string,
): Promise<string> {
  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];

  let fullText = "";

  for (let i = 0; i <= MAX_CONTINUATIONS; i++) {
    const { content, finishReason } = await callOnce(apiKey, messages, model);
    fullText += content;

    if (finishReason !== "length") {
      // Model normal şekilde bitirdi ("stop") ya da farklı bir sebeple durdu.
      return fullText;
    }

    if (i === MAX_CONTINUATIONS) {
      console.warn("openrouter: devam hakkı bitti, cevap yarım kalmış olabilir");
      break;
    }

    messages.push({ role: "assistant", content });
    messages.push({
      role: "user",
      content:
        "Cevabın token limiti yüzünden yarıda kesildi. Kaldığın YERDEN devam et. " +
        "Baştan tekrar başlama, önceki kısmı tekrar yazma, hiçbir açıklama ekleme " +
        "— sadece kesildiğin noktadan itibaren kodun/dosyanın geri kalanını yaz. " +
        "Hâlâ aynı dosyanın içindeysen dosya başlığını (===FILE: ...===) veya kod " +
        "bloğu (```) işaretini tekrarlama, doğrudan koddan devam et.",
    });
  }

  return fullText;
}

/**
 * OpenRouter'da MiniMax M3 (free) modeline istek atar. Tanımlı anahtarlar
 * arasında round-robin yapar; bir anahtar 429/401/403 alırsa sıradaki
 * anahtarla dener. Cevap token limiti yüzünden yarıda kesilirse otomatik
 * olarak devam ettirir (bkz. callWithContinuation). Hiçbir anahtar/istek
 * başarılı olmazsa hata fırlatır — çağıran taraf (bkz. utils/codeModel.ts)
 * bunu yakalayıp Gemini'ye düşer.
 */
export async function generateWithOpenRouter(systemPrompt: string, userPrompt: string, modelOverride?: string): Promise<string> {
  const keys = getConfiguredKeys();
  if (keys.length === 0) {
    throw new Error(
      "OP_KOD_1..OP_KOD_6 arasında hiçbiri tanımlı değil — OpenRouter atlanıyor.",
    );
  }

  const startIndex = keyRotationIndex % keys.length;
  keyRotationIndex = (keyRotationIndex + 1) % Number.MAX_SAFE_INTEGER;
  const model = modelOverride ?? getActiveModel("openrouter");

  let lastErr: unknown;
  for (let offset = 0; offset < keys.length; offset++) {
    const { key, label } = keys[(startIndex + offset) % keys.length];
    try {
      return await callWithContinuation(key, systemPrompt, userPrompt, model);
    } catch (err) {
      lastErr = err;
      if (err instanceof RateLimitError || err instanceof KeyDeniedError) {
        console.warn(`openrouter (${label}) patladı, sonrakine geçiyorum:`, err.message);
        continue;
      }
      console.warn(`openrouter (${label}) patladı:`, err);
      continue;
    }
  }

  throw lastErr instanceof Error ? lastErr : new Error("OpenRouter isteği başarısız.");
}
