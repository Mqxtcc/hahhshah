// src/utils/pixrouter.ts
// PixRouter (New API uyumlu) üzerinden OpenAI-compatible chat completions.
// Resmi site: https://pixrouter.com
// Dokümantasyon: https://docs.newapi.pro/en/docs/api
//
// ---------------------------------------------------------------------------
// ZAMANAŞIMI: TÜM PixRouter istekleri (sohbet, kod-yaz/duzelt/analiz/test,
// görsel) için sabit 10 dakika. Reasoning modelleri uzun düşünebildiği için
// bu süre hem tek HTTP denemesi hem de toplam bütçe için geçerli; env ile
// veya çağıran tarafta kısaltılamaz.
//
// ÖNEMLİ: Node'un yerleşik fetch'i (undici) varsayılan olarak 300 sn
// headersTimeout/bodyTimeout uygular. AbortController 10 dk olsa bile
// sunucu 5 dk boyunca hiç bayt göndermezse istek "fetch failed"
// (UND_ERR_HEADERS_TIMEOUT) ile düşer. Bu yüzden aşağıda özel bir undici
// Agent kullanılıyor (PIXROUTER_DISPATCHER).
// ---------------------------------------------------------------------------

import { Agent } from "undici";
import { getActiveModel } from "./modelSettings.js";

const PIXROUTER_BASE_URL = "https://pixrouter.com/v1";
// PixRouter yönlendirilen modele göre daha düşük bir sınır uygulayabilir.
// İstek reddedilirse callOnce daha düşük kademeleri otomatik dener.
const DEFAULT_MAX_TOKENS = 131_072;

// Tüm PixRouter istekleri için sabit süre: 10 dakika.
const PIXROUTER_TIMEOUT_MS = 600_000;
// undici'nin kendi (300 sn) header/body zamanaşımı 10 dk'yı kesmesin diye
// biraz fazlasına ayarlı; asıl sınırı AbortController koyuyor.
const PIXROUTER_DISPATCHER = new Agent({
  headersTimeout: PIXROUTER_TIMEOUT_MS + 60_000,
  bodyTimeout: PIXROUTER_TIMEOUT_MS + 60_000,
  connectTimeout: 30_000,
});

const PIXROUTER_KEY_ENV_NAMES = [
  "PIXROUTER_API_KEY_1",
  "PIXROUTER_API_KEY_2",
  "PIXROUTER_API_KEY_3",
] as const;

export type PixRouterContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };
type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string | PixRouterContentPart[];
};
type JsonRecord = Record<string, unknown>;

/** PixRouter'a özgü HTTP/ağ hataları — groq.ts'teki HttpError ile aynı yaklaşım. */
export class PixRouterError extends Error {
  constructor(
    message: string,
    readonly kind: "timeout" | "http" | "api" | "empty" | "config" = "http",
    readonly status?: number,
  ) {
    super(message);
    this.name = "PixRouterError";
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null;
}

function envInt(name: string, fallback: number): number {
  const raw = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

function getRequestTimeoutMs(): number {
  return PIXROUTER_TIMEOUT_MS;
}

function getTotalTimeoutMs(): number {
  return PIXROUTER_TIMEOUT_MS;
}

/** undici "fetch failed" arkasındaki gerçek sebebi (UND_ERR_*_TIMEOUT vb.) okur. */
function isUndiciTimeout(error: unknown): boolean {
  const cause = (error as { cause?: { code?: string } } | null)?.cause;
  const code = cause?.code ?? (error as { code?: string } | null)?.code ?? "";
  return /^UND_ERR_(HEADERS|BODY|CONNECT)_TIMEOUT$|^ETIMEDOUT$/.test(code);
}

function getConfiguredKeys(): { key: string; label: string }[] {
  // Tek anahtar için PIXROUTER_API_KEY de desteklenir; _1.._3 varsa rotasyona katılır.
  // Aynı değere sahip env'ler tek sefer sayılır (duplicate deneme olmasın).
  const names = ["PIXROUTER_API_KEY", ...PIXROUTER_KEY_ENV_NAMES];
  const seen = new Set<string>();
  const out: { key: string; label: string }[] = [];
  for (const name of names) {
    const key = process.env[name]?.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ key, label: name });
  }
  return out;
}

function extractError(data: unknown): string | null {
  if (!isRecord(data) || !isRecord(data.error)) return null;
  const message =
    typeof data.error.message === "string"
      ? data.error.message
      : JSON.stringify(data.error);
  return message.slice(0, 400);
}

function getMaxTokensCap(): number {
  return envInt("PIXROUTER_MAX_TOKENS", DEFAULT_MAX_TOKENS);
}

function getTokenBudgets(requested: number): number[] {
  const cap = getMaxTokensCap();
  const initial = Math.min(Math.max(Math.floor(requested), 1), cap);
  const budgets = [initial, 131_072, 65_536, 32_768, 16_384, 8_192, 4_096]
    .filter((budget) => budget <= initial)
    .filter((budget, index, all) => all.indexOf(budget) === index);
  return budgets.length > 0 ? budgets : [1];
}

function shouldRetryWithSmallerBudget(status: number, detail: string): boolean {
  if (status < 400 || status >= 500) return false;
  return /token|context|length|max_tokens|max token|too large|parameter/i.test(
    detail,
  );
}

/**
 * Bir anahtarın zamanaşımı/ağ hatası vermesi diğer anahtarların da aynı
 * sonucu vermesi muhtemel olduğu anlamına gelir (aynı upstream servis, aynı
 * ağ yolu) — bu yüzden bu tür hatalarda anahtar rotasyonuna devam etmenin
 * pratik faydası azdır. 401/403/429 gibi ANAHTARA ÖZGÜ hatalarda ise
 * sıradaki anahtarı denemek hâlâ mantıklı.
 */
function isKeySpecificError(error: unknown): boolean {
  if (!(error instanceof PixRouterError)) return true;
  if (error.kind === "timeout") return false;
  if (error.kind === "http" && typeof error.status === "number") {
    return [401, 403, 429].includes(error.status);
  }
  return true;
}

export interface PixRouterResult {
  content: string;
  /** Modelin gerçek reasoning/thinking çıktısı — sağlayıcı destekliyorsa
   * (ör. reasoning_content / reasoning alanı) doldurulur, aksi halde
   * undefined. Bu ASLA uydurulmaz; sadece API böyle bir alan döndürdüyse
   * set edilir. */
  reasoning?: string;
  /** İsteği GERÇEKTEN karşılayan modelin slug'ı (örn. openrouter/auto
   * yönlendirmesinde OpenRouter'ın seçtiği model). API bu alanı
   * döndürmediyse undefined kalır — asla uydurulmaz, o durumda çağrı
   * tarafı seçili model etiketine düşer. */
  servedModel?: string;
}

function extractReasoning(message: JsonRecord): string | undefined {
  const candidates = [
    message.reasoning_content,
    message.reasoning,
    message.thinking,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  return undefined;
}

/**
 * Akış (SSE) yanıtını okur ve içerik/reasoning parçalarını birleştirir.
 * Akış kullanmamızın sebebi: PixRouter önünde bir proxy/CDN (ör. ~100 sn'de
 * kesen ağ geçitleri) varsa, uzun düşünen modelde hiç bayt gelmeyen normal
 * (non-stream) istek 10 dk dolmadan koparılır. Akışta sunucu sürekli veri
 * (veya keep-alive) gönderdiği için bağlantı açık kalır.
 */
async function readChatStream(response: Response): Promise<PixRouterResult> {
  const reader = response.body?.getReader();
  if (!reader) throw new PixRouterError("PixRouter akış gövdesi alınamadı.", "empty");
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let reasoning = "";
  let servedModel: string | undefined;

  const handleLine = (line: string): boolean => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return false;
    const payload = trimmed.slice(5).trim();
    if (!payload) return false;
    if (payload === "[DONE]") return true;
    let json: unknown;
    try {
      json = JSON.parse(payload);
    } catch {
      return false;
    }
    const apiError = extractError(json);
    if (apiError) throw new PixRouterError(`PixRouter hata döndürdü: ${apiError}`, "api");
    // OpenAI uyumlu akışlarda her chunk'ın tepesinde `model` alanı olur.
    // openrouter/auto gibi yönlendirmelerde bu alan, isteği gerçekten
    // karşılayan modelin slug'ıdır (istenen "openrouter/auto" değil).
    if (!servedModel && isRecord(json) && typeof json.model === "string" && json.model.trim()) {
      servedModel = json.model.trim();
    }
    const choices = isRecord(json) && Array.isArray(json.choices) ? json.choices : [];
    const first = isRecord(choices[0]) ? choices[0] : null;
    const delta = first && isRecord(first.delta) ? first.delta : null;
    if (delta) {
      if (typeof delta.content === "string") content += delta.content;
      for (const key of ["reasoning_content", "reasoning", "thinking"]) {
        const v = delta[key];
        if (typeof v === "string") reasoning += v;
      }
    }
    return false;
  };

  let finished = false;
  while (!finished) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (handleLine(line)) {
        finished = true;
        break;
      }
    }
  }
  if (!finished && buffer) handleLine(buffer);
  if (!content.trim()) throw new PixRouterError("PixRouter boş yanıt döndürdü.", "empty");
  return { content: content.trim(), reasoning: reasoning.trim() || undefined, servedModel };
}

async function callOnce(
  apiKey: string,
  model: string,
  messages: ChatMessage[],
  maxTokens: number,
  temperature: number | undefined,
  deadlineAt: number,
  requestReasoning: boolean,
  /** Yoksayılır; her istek sabit 10 dk (PIXROUTER_TIMEOUT_MS). */
  perRequestTimeoutMs?: number,
): Promise<PixRouterResult> {
  const budgets = getTokenBudgets(maxTokens);
  const requestTimeoutMs = perRequestTimeoutMs ?? getRequestTimeoutMs();
  let lastBudgetError: Error | null = null;

  for (const budget of budgets) {
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) {
      throw (
        lastBudgetError ??
        new PixRouterError(
          "PixRouter için ayrılan toplam süre bütçesi doldu.",
          "timeout",
        )
      );
    }

    const controller = new AbortController();
    // remaining > 0 garantili; en az 1 sn bırak ki anında abort olmasın
    const effectiveTimeout = Math.max(
      1_000,
      Math.min(requestTimeoutMs, remaining),
    );
    const timeoutId = setTimeout(() => controller.abort(), effectiveTimeout);
    try {
      const response = await fetch(`${PIXROUTER_BASE_URL}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        signal: controller.signal,
        dispatcher: PIXROUTER_DISPATCHER,
        body: JSON.stringify({
          model,
          messages,
          max_tokens: budget,
          stream: true,
          ...(temperature === undefined ? {} : { temperature }),
          // New API / OpenAI-uyumlu reasoning modelleri için: model reasoning
          // desteklemiyorsa bu alan sağlayıcı tarafından sessizce yoksayılır.
          ...(requestReasoning ? { reasoning: { enabled: true } } : {}),
        }),
      } as RequestInit);

      if (
        response.ok &&
        (response.headers.get("content-type") ?? "").includes("text/event-stream")
      ) {
        return await readChatStream(response);
      }

      const raw = await response.text();
      let data: unknown = null;
      try {
        data = raw ? JSON.parse(raw) : null;
      } catch {
        // Aşağıdaki HTTP hata mesajı ham gövdeyi gösterecek.
      }

      if (!response.ok) {
        const detail = extractError(data) ?? raw.slice(0, 400);
        if (
          shouldRetryWithSmallerBudget(response.status, detail) &&
          budget !== budgets[budgets.length - 1]
        ) {
          lastBudgetError = new PixRouterError(
            `PixRouter API hatası (${response.status}): ${detail}`,
            "http",
            response.status,
          );
          continue;
        }
        throw new PixRouterError(
          `PixRouter API hatası (${response.status}): ${detail}`,
          "http",
          response.status,
        );
      }
      const apiError = extractError(data);
      if (apiError)
        throw new PixRouterError(`PixRouter hata döndürdü: ${apiError}`, "api");

      const choices =
        isRecord(data) && Array.isArray(data.choices) ? data.choices : [];
      const first = isRecord(choices[0]) ? choices[0] : null;
      const message = first && isRecord(first.message) ? first.message : null;
      let content =
        message && typeof message.content === "string" ? message.content : "";
      if (message && Array.isArray(message.content)) {
        content = message.content
          .map((part) =>
            isRecord(part) && typeof part.text === "string" ? part.text : "",
          )
          .join("");
      }
      if (!content.trim())
        throw new PixRouterError("PixRouter boş yanıt döndürdü.", "empty");
      // Akışsız (JSON) cevapta da tepedeki `model` alanı, yönlendirme varsa
      // gerçekten hizmet veren modeli taşır.
      const servedModel =
        isRecord(data) && typeof data.model === "string" && data.model.trim()
          ? data.model.trim()
          : undefined;
      return {
        content: content.trim(),
        reasoning: message ? extractReasoning(message) : undefined,
        servedModel,
      };
    } catch (error) {
      const isAbortError =
        isUndiciTimeout(error) ||
        (error instanceof Error &&
        (error.name === "AbortError" ||
          error.message.toLowerCase().includes("abort") ||
          error.message.toLowerCase().includes("timeout") ||
          (error as { code?: string }).code === "ERR_HTTP_REQUEST_TIMEOUT"));
      if (isAbortError) {
        throw new PixRouterError(
          `PixRouter isteği zamanaşımına uğradı (${(effectiveTimeout / 1000).toFixed(0)} sn).`,
          "timeout",
        );
      }
      if (error instanceof PixRouterError) throw error;
      throw new PixRouterError(
        error instanceof Error ? error.message : String(error),
        "http",
      );
    } finally {
      clearTimeout(timeoutId);
    }
  }

  throw (
    lastBudgetError ??
    new PixRouterError(
      "PixRouter uygun token bütçesiyle yanıt veremedi.",
      "http",
    )
  );
}

let keyRotationIndex = 0;

export interface PixRouterGenerateOptions {
  model?: string;
  maxTokens?: number;
  temperature?: number;
  /** Bu tek çağrı için toplam süre bütçesini (ms) override eder — ör. kısa
   * sınıflandırma istekleri (tek kelime cevap) tam bütçeyi hak etmez. */
  totalTimeoutMs?: number;
  /** Tek bir HTTP denemesinin üst süresi (ms). Varsayılan PIXROUTER_TIMEOUT_MS
   * (30sn). MentionAI gibi uzun cevaplar için totalTimeoutMs ile birlikte
   * yükseltilmeli; aksi halde 120sn total olsa bile istek 30sn'de kesilir. */
  requestTimeoutMs?: number;
  /** OpenAI uyumlu vision isteği için user mesajının çok parçalı içeriği. */
  userContent?: PixRouterContentPart[];
  /** true ise, sağlayıcı destekliyorsa reasoning/thinking çıktısını da iste
   * (New API / OpenAI-uyumlu sağlayıcılarda genelde `reasoning: {enabled:true}`
   * veya `reasoning_effort` gibi bir alanla açılır). Desteklemeyen modellerde
   * bu alan yoksayılır ve reasoning boş döner — asla uydurulmaz. */
  requestReasoning?: boolean;
}

export async function generateWithPixRouter(
  systemPrompt: string,
  userPrompt: string,
  options: PixRouterGenerateOptions = {},
): Promise<PixRouterResult> {
  const keys = getConfiguredKeys();
  if (keys.length === 0) {
    throw new PixRouterError(
      "PIXROUTER_API_KEY (veya PIXROUTER_API_KEY_1.._3) tanımlanmalı.",
      "config",
    );
  }

  const model = options.model ?? getActiveModel("groq");
  const startIndex = keyRotationIndex++ % keys.length;
  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: options.userContent ?? userPrompt },
  ];
  const deadlineAt =
    Date.now() + getTotalTimeoutMs();
  let lastError: unknown;

  for (let offset = 0; offset < keys.length; offset++) {
    if (Date.now() >= deadlineAt) break;
    const { key, label } = keys[(startIndex + offset) % keys.length];
    try {
      return await callOnce(
        key,
        model,
        messages,
        options.maxTokens ?? getMaxTokensCap(),
        options.temperature,
        deadlineAt,
        options.requestReasoning ?? false,
        getRequestTimeoutMs(),
      );
    } catch (error) {
      lastError = error;
      const detail = error instanceof Error ? error.message : String(error);
      // Zamanaşımı/ağ hatası: diğer anahtarları denemek muhtemelen aynı
      // sonucu verir (aynı upstream), süre bütçesini boşuna tüketmemek için
      // hemen vazgeç. Anahtara özgü hatalarda (401/403/429) rotasyona devam.
      const keepTrying = isKeySpecificError(error);
      console.warn(
        `pixrouter (${label}) patladı: ${detail}${keepTrying ? "; sonrakine geçiyorum." : "; vazgeçtim (zamanaşımı/ağ)."}`,
      );
      if (!keepTrying) break;
    }
  }

  // Tüm anahtarlar başarısız oldu (ya da süre bütçesi doldu). Genel/anlamsız
  // bir mesaj yerine SON denenen anahtarın gerçek hata detayını taşıyoruz ki
  // hem loglarda hem de kullanıcıya dönen mesajda asıl sebep (401/429/model
  // bulunamadı/zamanaşımı vb.) görünür olsun.
  if (lastError instanceof PixRouterError) {
    throw new PixRouterError(
      `PixRouter isteği başarısız oldu (${keys.length} anahtar denendi): ${lastError.message}`,
      lastError.kind,
      lastError.status,
    );
  }
  if (lastError instanceof Error) {
    throw new PixRouterError(
      `PixRouter isteği başarısız oldu (${keys.length} anahtar denendi): ${lastError.message}`,
      "http",
    );
  }
  throw new PixRouterError(
    `PixRouter isteği başarısız oldu (${keys.length} anahtar denendi), detay alınamadı.`,
    "http",
  );
}

export async function generateWithPixRouterForCode(
  systemPrompt: string,
  userPrompt: string,
  model: string,
): Promise<string> {
  const result = await generateWithPixRouter(systemPrompt, userPrompt, {
    model,
    maxTokens: getMaxTokensCap(),
  });
  return result.content;
}

// ---------------------------------------------------------------------------
// GÖRSEL ÜRETİMİ (OpenAI uyumlu POST /v1/images/generations)
// !çiz akışında Cloudflare Workers AI başarısız olursa fallback olarak
// kullanılır (bkz. utils/imageGen.ts). Model !görsel <model> ile owner
// tarafından değiştirilir (bkz. utils/imageModelSettings.ts).
// ---------------------------------------------------------------------------

const DEFAULT_IMAGE_TOTAL_TIMEOUT_MS = PIXROUTER_TIMEOUT_MS;
// Önce api.pixrouter.com, ağ seviyesinde (DNS/bağlantı) hata olursa chat için
// zaten çalışan pixrouter.com/v1 adresi denenir. PIXROUTER_IMAGE_URL env'i ile
// ilk adres override edilebilir.
function getImageUrls(): string[] {
  const urls = [
    process.env.PIXROUTER_IMAGE_URL?.trim() ||
      "https://api.pixrouter.com/v1/images/generations",
    `${PIXROUTER_BASE_URL}/images/generations`,
  ];
  return urls.filter((u, i) => urls.indexOf(u) === i);
}

/** undici'nin "fetch failed" mesajının arkasındaki gerçek sebebi (ENOTFOUND vb.) çıkarır. */
function describeFetchError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = (error as { cause?: unknown }).cause;
  if (cause && typeof cause === "object") {
    const c = cause as { code?: string; message?: string; hostname?: string };
    const parts = [c.code, c.message, c.hostname].filter(Boolean);
    if (parts.length > 0) return `${error.message} (${parts.join(" - ")})`;
  }
  return error.message;
}

export interface PixRouterImageResult {
  buffer: Buffer;
  extension: string;
  model: string;
}

export interface PixRouterImageOptions {
  size?: string;
  /** Tüm anahtarlar dahil toplam süre bütçesi (ms). */
  totalTimeoutMs?: number;
}

function detectImageExtension(buffer: Buffer, contentType?: string): string {
  if (buffer.length >= 4 && buffer.readUInt32BE(0) === 0x89504e47) return "png";
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8) return "jpg";
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

async function imageCallOnce(
  url: string,
  apiKey: string,
  model: string,
  prompt: string,
  size: string,
  deadlineAt: number,
): Promise<PixRouterImageResult> {
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) {
    throw new PixRouterError(
      "PixRouter için ayrılan toplam süre bütçesi doldu.",
      "timeout",
    );
  }
  const controller = new AbortController();
  const timeoutMs = Math.max(1_000, remaining);
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      signal: controller.signal,
      dispatcher: PIXROUTER_DISPATCHER,
      body: JSON.stringify({ model, prompt, n: 1, size }),
    } as RequestInit);

    const raw = await response.text();
    let data: unknown = null;
    try {
      data = raw ? JSON.parse(raw) : null;
    } catch {
      // aşağıdaki hata mesajı ham gövdeyi gösterecek
    }

    if (!response.ok) {
      const detail = extractError(data) ?? raw.slice(0, 400);
      throw new PixRouterError(
        `PixRouter görsel API hatası (${response.status}): ${detail}`,
        "http",
        response.status,
      );
    }
    const apiError = extractError(data);
    if (apiError) {
      throw new PixRouterError(`PixRouter hata döndürdü: ${apiError}`, "api");
    }

    const items = isRecord(data) && Array.isArray(data.data) ? data.data : [];
    const first = isRecord(items[0]) ? items[0] : null;
    const b64 =
      first && typeof first.b64_json === "string" ? first.b64_json.trim() : "";
    const imageUrl = first && typeof first.url === "string" ? first.url.trim() : "";

    if (b64) {
      const buffer = Buffer.from(b64.replace(/^data:[^;]+;base64,/, ""), "base64");
      if (buffer.length === 0) {
        throw new PixRouterError("PixRouter boş görsel döndürdü.", "empty");
      }
      return { buffer, extension: detectImageExtension(buffer), model };
    }

    if (imageUrl) {
      const imgRes = await fetch(imageUrl, { signal: controller.signal, dispatcher: PIXROUTER_DISPATCHER } as RequestInit);
      if (!imgRes.ok) {
        throw new PixRouterError(
          `PixRouter görsel URL'si indirilemedi (${imgRes.status}).`,
          "http",
          imgRes.status,
        );
      }
      const buffer = Buffer.from(await imgRes.arrayBuffer());
      if (buffer.length === 0) {
        throw new PixRouterError("PixRouter boş görsel döndürdü.", "empty");
      }
      return {
        buffer,
        extension: detectImageExtension(
          buffer,
          imgRes.headers.get("content-type") ?? undefined,
        ),
        model,
      };
    }

    throw new PixRouterError(
      "PixRouter beklenen görsel verisini döndürmedi.",
      "empty",
    );
  } catch (error) {
    if (error instanceof PixRouterError) throw error;
    const isAbortError =
      isUndiciTimeout(error) ||
      (error instanceof Error &&
        (error.name === "AbortError" ||
          error.message.toLowerCase().includes("abort")));
    if (isAbortError) {
      throw new PixRouterError(
        `PixRouter görsel isteği zamanaşımına uğradı (${(timeoutMs / 1000).toFixed(0)} sn).`,
        "timeout",
      );
    }
    throw new PixRouterError(describeFetchError(error), "http");
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function generateImageWithPixRouter(
  prompt: string,
  model: string,
  options: PixRouterImageOptions = {},
): Promise<PixRouterImageResult> {
  const keys = getConfiguredKeys();
  if (keys.length === 0) {
    throw new PixRouterError(
      "PIXROUTER_API_KEY (veya PIXROUTER_API_KEY_1.._3) tanımlanmalı.",
      "config",
    );
  }

  const size = options.size ?? "1024x1024";
  const deadlineAt =
    Date.now() +
    DEFAULT_IMAGE_TOTAL_TIMEOUT_MS;
  const startIndex = keyRotationIndex++ % keys.length;
  let lastError: unknown;

  for (let offset = 0; offset < keys.length; offset++) {
    if (Date.now() >= deadlineAt) break;
    const { key, label } = keys[(startIndex + offset) % keys.length];
    try {
      let urlError: unknown;
      for (const url of getImageUrls()) {
        try {
          return await imageCallOnce(url, key, model, prompt, size, deadlineAt);
        } catch (error) {
          urlError = error;
          // Sadece ağ seviyesi hatada (HTTP durumu yok, zamanaşımı değil) diğer adresi dene.
          const networkFailure =
            error instanceof PixRouterError &&
            error.kind === "http" &&
            error.status === undefined;
          console.warn(
            `pixrouter görsel adresi patladı (${url}): ${error instanceof Error ? error.message : String(error)}`,
          );
          if (!networkFailure) throw error;
        }
      }
      throw urlError;
    } catch (error) {
      lastError = error;
      const keepTrying = isKeySpecificError(error);
      console.warn(
        `pixrouter görsel isteği patladı (${label}): ${error instanceof Error ? error.message : String(error)}${keepTrying ? "; sonrakine geçiyorum." : "; vazgeçtim."}`,
      );
      if (!keepTrying) break;
    }
  }

  if (lastError instanceof PixRouterError) throw lastError;
  throw new PixRouterError(
    lastError instanceof Error
      ? lastError.message
      : "PixRouter görsel isteği başarısız oldu.",
    "http",
  );
}
