import { getActiveModel } from "./modelSettings.js";
import { generateWithPixRouter } from "./pixrouter.js";
import { generateWithGemini } from "./gemini.js";

const GROQ_BASE_URL = "https://api.groq.com/openai/v1";
// Varsayılan model artık utils/modelSettings.ts'te (MODEL_GROUPS.groq.defaultModel)
// tek kaynaktan tanımlı; !modeller ile owner değiştirirse getActiveModel("groq")
// bunun yerine geçer.
const MAX_TOKENS_PER_CALL = 16_384;
const REQUEST_TIMEOUT_MS = 60_000;
const GROQ_KEY_ENV_NAMES = ["GROQ_API_KEY_1", "GROQ_API_KEY_2", "GROQ_API_KEY_3"] as const;
const PIXROUTER_PREFIX = "pixrouter:";
const GEMINI_PREFIX = "gemini:";

// ---------------------------------------------------------------------------
// "groq" kategorisi artık tek sağlayıcıya bağlı değil. !modeller menüsünde
// bu kategori altında Groq'un kendi modellerinin YANI SIRA, aynı OpenAI-
// uyumlu /v1/chat/completions şemasını kullanan başka ÜCRETSİZ sağlayıcıların
// modelleri de seçilebiliyor: Cerebras ve NVIDIA NIM (bkz.
// utils/modelSettings.ts MODEL_GROUPS.groq.options).
//
// NOT: Mistral ve SambaNova buradan çıkarıldı — ikisi de artık gerçekten
// ücretsiz bir kullanım sunmuyor (kredi kartı / ücretli plan gerektiriyor).
// GitHub Models de 30 Temmuz 2026'da tamamen kapatıldığı için kaldırılıp
// yerine NVIDIA NIM (integrate.api.nvidia.com) bağlandı.
//
// Bunu ayırt etmek için modelSettings.ts'teki değerler "sağlayıcı:model"
// önekiyle saklanıyor (ör. "cerebras:llama-3.3-70b"). Önek yoksa (Groq'un
// kendi modelleri "openai/gpt-oss-120b" gibi zaten "/" kullanıyor, ":"
// kullanmıyor) doğrudan Groq'a gidiliyor — eski davranış hiç değişmedi.
// ---------------------------------------------------------------------------
const PROVIDER_CONFIGS: Record<string, { baseUrl: string; keyEnvNames: readonly string[]; missingKeyMessage: string }> = {
  cerebras: {
    baseUrl: "https://api.cerebras.ai/v1",
    keyEnvNames: ["CEREBRAS_API_KEY_1", "CEREBRAS_API_KEY_2", "CEREBRAS_API_KEY_3"],
    missingKeyMessage: "CEREBRAS_API_KEY_1 (veya _2/_3) tanımlı değil. Ücretsiz key: https://cloud.cerebras.ai",
  },
  nvidia: {
    baseUrl: "https://integrate.api.nvidia.com/v1",
    keyEnvNames: ["NVIDIA_API_KEY_1", "NVIDIA_API_KEY_2", "NVIDIA_API_KEY_3"],
    missingKeyMessage:
      "NVIDIA_API_KEY_1 (veya _2/_3) tanımlı değil. Ücretsiz: build.nvidia.com'da ücretsiz bir geliştirici hesabıyla giriş yap, bir model kartını aç ve 'Get API Key' ile 'nvapi-' ile başlayan anahtarı al.",
  },
  // OpenRouter — utils/openrouter.ts ile aynı anahtarlar (OP_KOD_1..6).
  // Model adındaki ":free" son eki korunur: resolveProvider() sadece İLK ":"
  // karakterinden böler ("openrouter:z-ai/glm-5.2:free" -> "z-ai/glm-5.2:free").
  openrouter: {
    baseUrl: "https://openrouter.ai/api/v1",
    keyEnvNames: ["OP_KOD_1", "OP_KOD_2", "OP_KOD_3", "OP_KOD_4", "OP_KOD_5", "OP_KOD_6"],
    missingKeyMessage: "OP_KOD_1 (veya OP_KOD_2..6) tanımlı değil. Key: https://openrouter.ai/keys",
  },
};

interface ResolvedProvider {
  baseUrl: string;
  keyEnvNames: readonly string[];
  missingKeyMessage: string;
  model: string;
  label: string;
}

function resolveProvider(rawModel: string): ResolvedProvider {
  const sep = rawModel.indexOf(":");
  if (sep > 0) {
    const prefix = rawModel.slice(0, sep);
    const config = PROVIDER_CONFIGS[prefix];
    if (config) {
      return { ...config, model: rawModel.slice(sep + 1), label: prefix };
    }
  }
  return {
    baseUrl: GROQ_BASE_URL,
    keyEnvNames: GROQ_KEY_ENV_NAMES,
    missingKeyMessage: "GROQ_API_KEY_1, GROQ_API_KEY_2 veya GROQ_API_KEY_3 tanımlı değil.",
    model: rawModel,
    label: "groq",
  };
}

type ChatMessage = { role: "system" | "user" | "assistant"; content: string };
type CallResult = { content: string; finishReason: string | null };
type JsonRecord = Record<string, unknown>;

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "GroqHttpError";
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null;
}

// Loglarda anahtarın kendisini (kısmi bile olsa) yazmıyoruz — hangi env
// değişkeninden geldiğini gösteriyoruz. Bu, gemini.ts'deki aynı düzeltmeyle
// tutarlı: host sağlayıcı loglarına sızabilecek gereksiz bilgi ifşasını önler.
function getConfiguredKeys(keyEnvNames: readonly string[]): { key: string; label: string }[] {
  return keyEnvNames.map((name) => ({ key: process.env[name]?.trim(), label: name })).filter(
    (entry): entry is { key: string; label: string } => Boolean(entry.key),
  );
}

function errorBody(providerLabel: string, status: number, body: string): HttpError {
  return new HttpError(status, `${providerLabel} API hatası (${status}): ${body.slice(0, 300)}`);
}

async function callOnce(
  baseUrl: string,
  providerLabel: string,
  apiKey: string,
  model: string,
  messages: ChatMessage[],
  maxTokens: number,
  temperature?: number,
): Promise<CallResult> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        messages,
        max_tokens: maxTokens,
        ...(temperature === undefined ? {} : { temperature }),
      }),
    });
    if (!response.ok) throw errorBody(providerLabel, response.status, await response.text().catch(() => ""));

    const data: unknown = await response.json();
    if (!isRecord(data) || !Array.isArray(data.choices)) return { content: "", finishReason: null };
    const first = data.choices[0];
    if (!isRecord(first)) return { content: "", finishReason: null };
    const message = isRecord(first.message) ? first.message : undefined;
    return {
      content: message && typeof message.content === "string" ? message.content : "",
      finishReason: typeof first.finish_reason === "string" ? first.finish_reason : null,
    };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`${providerLabel} isteği zaman aşımına uğradı (60 sn).`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

let keyRotationIndex = 0;

export interface GroqGenerateOptions {
  model?: string;
  maxTokens?: number;
  temperature?: number;
}

export async function generateWithGroq(
  systemPrompt: string,
  userPrompt: string,
  options: GroqGenerateOptions = {},
): Promise<string> {
  const result = await generateWithGroqDetailed(systemPrompt, userPrompt, options);
  return result.content;
}

/**
 * generateWithGroq ile aynı, ancak finishReason'ı da döner — çağıran taraf
 * yanıtın "length" (max_tokens'a takılıp yarıda kesilme) sebebiyle mi
 * bittiğini anlayabilsin diye.
 *
 * NOT: Model adı "provider:model" öneki taşıyorsa (ör. "cerebras:llama-3.3-70b")
 * bu istek Groq'a değil, o sağlayıcıya (aynı OpenAI-uyumlu şema ile) gider —
 * bkz. resolveProvider() ve PROVIDER_CONFIGS yukarıda.
 */
export async function generateWithGroqDetailed(
  systemPrompt: string,
  userPrompt: string,
  options: GroqGenerateOptions = {},
): Promise<CallResult> {
  const selectedModel = options.model ?? getActiveModel("groq");
  // !modeller > Sohbet, Fikir & AFK Cevap içinde PixRouter seçildiyse aynı
  // çağrı sözleşmesini koruyarak PixRouter util’ine devret.
  if (selectedModel.startsWith(PIXROUTER_PREFIX)) {
    const result = await generateWithPixRouter(systemPrompt, userPrompt, {
      model: selectedModel.slice(PIXROUTER_PREFIX.length),
      maxTokens: options.maxTokens,
      temperature: options.temperature,
    });
    return { content: result.content.trim(), finishReason: "stop" };
  }
  if (selectedModel.startsWith(GEMINI_PREFIX)) {
    const content = await generateWithGemini(
      systemPrompt,
      userPrompt,
      selectedModel.slice(GEMINI_PREFIX.length),
    );
    return { content: content.trim(), finishReason: "stop" };
  }
  const provider = resolveProvider(selectedModel);
  const keys = getConfiguredKeys(provider.keyEnvNames);
  if (keys.length === 0) {
    throw new Error(provider.missingKeyMessage);
  }
  const startIndex = keyRotationIndex++ % keys.length;
  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];
  let lastError: unknown;
  for (let offset = 0; offset < keys.length; offset++) {
    const { key, label } = keys[(startIndex + offset) % keys.length];
    try {
      const result = await callOnce(
        provider.baseUrl,
        provider.label,
        key,
        provider.model,
        messages,
        Math.min(Math.max(options.maxTokens ?? MAX_TOKENS_PER_CALL, 1), MAX_TOKENS_PER_CALL),
        options.temperature,
      );
      return { content: result.content.trim(), finishReason: result.finishReason };
    } catch (error) {
      lastError = error;
      if (error instanceof HttpError && ![401, 403, 429, 500, 502, 503, 504].includes(error.status)) throw error;
      console.warn(`${provider.label} (${label}) patladı, sıradakine geçiyorum`);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`${provider.label} isteği başarısız oldu.`);
}

export async function summarizeWithGroq(text: string): Promise<string> {
  return generateWithGroq(
    "Türkçe metinleri anlamı korunacak şekilde kısa ve maddeli özetleyen bir asistansın. Yalnızca özeti döndür.",
    text,
    { maxTokens: 700 },
  );
}

export async function answerWithGroq(question: string): Promise<string> {
  return generateWithGroq(
    "Türkçe, kısa ve doğru cevaplar veren bir Discord asistanısın. Emin olmadığın bilgiyi uydurma.",
    question,
    { maxTokens: 700 },
  );
}
