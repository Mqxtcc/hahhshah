// Manus AI API entegrasyonu (!agent komutu için).
//
// Akış: task.create ile bir görev başlatılır (asenkron çalışır) -> task.detail
// ile durum ("running" | "stopped" | "waiting" | "error") periyodik olarak
// kontrol edilir -> tamamlandığında task.listMessages ile son assistant
// mesajı okunup kullanıcıya dönülür.
//
// API anahtarı .env üzerinden MANUS_API_KEY değişkeninden okunur, koda asla
// yazılmaz.
//
// SAĞLAMLIK NOTLARI (bkz. commit geçmişi): ilk sürümde (a) geçici ağ/429/5xx
// hatalarında hiç yeniden deneme yoktu, (b) 5 dakika boyunca kullanıcıya HİÇ
// ilerleme bilgisi gitmiyordu (bu yüzden "hiç cevap vermiyor" gibi
// görünüyordu), (c) aynı kullanıcı komutu üst üste yazarsa paralel görevler
// birbirine karışabiliyordu. Üçü de burada ve agent.ts'te ele alındı.

const MANUS_BASE_URL = "https://api.manus.ai/v2";
const POLL_INTERVAL_MS = 4_000;
const REQUEST_TIMEOUT_MS = 20_000;

// Manus görevleri araştırma/otomasyon adımlarına göre 4 dakikadan uzun sürebilir.
// Varsayılan sınır 30 dakikadır; istenirse .env üzerinden değiştirilebilir.
// MANUS_MAX_WAIT_MS=0 verilirse görev tamamlanana kadar beklenir (API bağlantısı
// koptuğunda tek isteğin zaman aşımı yine REQUEST_TIMEOUT_MS ile sınırlıdır).
const DEFAULT_MAX_WAIT_MS = 30 * 60_000;
const MAX_WAIT_MS = (() => {
  const raw = process.env.MANUS_MAX_WAIT_MS?.trim();
  if (raw === "0") return 0;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed >= 60_000 ? parsed : DEFAULT_MAX_WAIT_MS;
})();
const MAX_RETRIES = 3;

export class ManusError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManusError";
  }
}

function getApiKey(): string {
  const key = process.env.MANUS_API_KEY?.trim();
  if (!key) {
    throw new ManusError(
      "MANUS_API_KEY tanımlı değil. Botu çalıştıran ortamda .env dosyasına `MANUS_API_KEY=...` ekleyip yeniden başlat.",
    );
  }
  return key;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Geçici sayılan (yeniden denenebilir) HTTP durumları: rate limit + sunucu
// tarafı hatalar. 4xx (400/401/403/404 vb.) yeniden denenmez — bunlar
// isteğin kendisiyle ilgili kalıcı sorunlardır.
function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

class RetryableManusError extends ManusError {}

/**
 * Tek bir Manus API isteği atar. Ağ hatası / timeout / 429 / 5xx durumunda
 * üstel geri çekilmeyle (exponential backoff) MAX_RETRIES kez tekrar dener.
 * Kalıcı hatalarda (400/401/403/404 vb.) hemen ManusError fırlatır.
 */
async function manusFetch(path: string, init: RequestInit): Promise<any> {
  let lastErr: Error = new ManusError("Manus API isteği başarısız oldu.");

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const res = await fetch(`${MANUS_BASE_URL}${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          "x-manus-api-key": getApiKey(),
          ...(init.headers ?? {}),
        },
      });
      clearTimeout(timeoutId);

      const data = await res.json().catch(() => null);

      if (!res.ok || !data || data.ok === false) {
        const msg = data?.error?.message || `HTTP ${res.status}`;
        if (isRetryableStatus(res.status)) {
          throw new RetryableManusError(`Manus API hatası: ${msg}`);
        }
        // Kalıcı hata — burada döngüden tamamen çıkıyoruz.
        throw new ManusError(`Manus API hatası: ${msg}`);
      }

      return data;
    } catch (err: unknown) {
      clearTimeout(timeoutId);

      if (err instanceof ManusError && !(err instanceof RetryableManusError)) {
        throw err; // Kalıcı hata, yeniden denemeden çık.
      }

      const isAbort = err instanceof Error && err.name === "AbortError";
      lastErr = isAbort
        ? new ManusError("Manus API isteği zaman aşımına uğradı.")
        : err instanceof Error
          ? err
          : new ManusError(String(err));

      if (attempt >= MAX_RETRIES) throw lastErr;
      await sleep(Math.min(2_000 * 2 ** attempt, 10_000));
    }
  }

  throw lastErr;
}

interface CreateTaskResult {
  taskId: string;
  taskUrl?: string;
}

// 🆕 YENİ ÖZELLİK: Discord mesajına eklenen dosyaları Manus'a gönderme.
//
// Manus task.create, message.content içinde metnin yanına "file" tipinde
// content-part kabul ediyor (bkz. Manus API v2 docs — ContentPart.File):
//   - file_url: Manus'un doğrudan indireceği herkese açık bir URL (≤ 20 MB)
//   - file_id : file.upload ile önceden yüklenmiş bir dosyanın ID'si (≤ 512 MB)
// Discord CDN ekleri zaten public https URL'ler olduğu için ≤20MB'lık
// dosyalarda file_url ile direkt gönderiliyor, daha büyük dosyalarda ise
// file.upload akışıyla önce Manus'a yükleniyor.
const INLINE_FILE_URL_MAX_BYTES = 20 * 1024 * 1024; // Manus file_url sınırı
export const MAX_UPLOADABLE_ATTACHMENT_BYTES = 512 * 1024 * 1024; // file.upload sınırı

export interface TaskAttachmentInput {
  url: string;
  filename: string;
  contentType?: string;
  sizeBytes?: number;
}

interface FileContentPart {
  type: "file";
  file_id?: string;
  file_url?: string;
  filename?: string;
  mime_type?: string;
}

/**
 * Büyük dosyaları (>20MB) Manus'a file.upload akışıyla yükler: önce bir
 * presigned upload_url alınır, dosya Discord CDN'den indirilip bu URL'e PUT
 * edilir, sonra file.id döner. 20MB altındaki dosyalar için bu adıma hiç
 * gerek yok — file_url ile doğrudan gönderilir (aşağıdaki buildFileContentPart).
 */
async function uploadLargeFileToManus(attachment: TaskAttachmentInput): Promise<string> {
  const created = await manusFetch("/file.upload", {
    method: "POST",
    body: JSON.stringify({ filename: attachment.filename }),
  });
  const fileId = created?.file?.id;
  const uploadUrl = created?.upload_url;
  if (typeof fileId !== "string" || !fileId || typeof uploadUrl !== "string" || !uploadUrl) {
    throw new ManusError(`Manus dosya yükleme kaydı oluşturulamadı: ${attachment.filename}`);
  }

  // Discord CDN'den dosyayı indirip Manus'un presigned S3 URL'sine PUT ediyoruz.
  // upload_url 3 dakika içinde dolduğu için bu adım hemen ardından yapılır.
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 60_000);
  try {
    const sourceRes = await fetch(attachment.url, { signal: controller.signal });
    if (!sourceRes.ok) {
      throw new ManusError(`Discord ekindeki dosya indirilemedi: ${attachment.filename}`);
    }
    const bytes = await sourceRes.arrayBuffer();
    const putRes = await fetch(uploadUrl, {
      method: "PUT",
      body: bytes,
      signal: controller.signal,
      headers: attachment.contentType ? { "Content-Type": attachment.contentType } : undefined,
    });
    if (!putRes.ok) {
      throw new ManusError(`Dosya Manus'a yüklenemedi (HTTP ${putRes.status}): ${attachment.filename}`);
    }
  } finally {
    clearTimeout(timeoutId);
  }

  return fileId;
}

/** ≤20MB dosyalar için file_url content-part'ı doğrudan oluşturur (yükleme gerekmez). */
function buildInlineFileContentPart(attachment: TaskAttachmentInput): FileContentPart {
  return {
    type: "file",
    file_url: attachment.url,
    filename: attachment.filename,
    ...(attachment.contentType ? { mime_type: attachment.contentType } : {}),
  };
}

async function buildFileContentParts(attachments: TaskAttachmentInput[]): Promise<FileContentPart[]> {
  const parts: FileContentPart[] = [];
  for (const attachment of attachments) {
    const knownTooBig =
      typeof attachment.sizeBytes === "number" && attachment.sizeBytes > INLINE_FILE_URL_MAX_BYTES;
    if (!knownTooBig) {
      parts.push(buildInlineFileContentPart(attachment));
      continue;
    }
    // >20MB: file_url Manus tarafında reddedilir, file.upload akışı gerekli.
    const fileId = await uploadLargeFileToManus(attachment);
    parts.push({ type: "file", file_id: fileId, filename: attachment.filename });
  }
  return parts;
}

async function createTask(prompt: string, attachments: TaskAttachmentInput[] = []): Promise<CreateTaskResult> {
  const fileParts = attachments.length > 0 ? await buildFileContentParts(attachments) : [];
  const content =
    fileParts.length > 0 ? [{ type: "text", text: prompt }, ...fileParts] : prompt;

  const data = await manusFetch("/task.create", {
    method: "POST",
    body: JSON.stringify({
      message: { content },
      hide_in_task_list: true,
    }),
  });
  // 🛠️ BUG FIX: task_id doğrulanmıyordu. API beklenmedik/boş bir cevap
  // dönerse (data.task_id eksik), bu sessizce sonraki her istekte
  // "task_id=undefined" olarak geçiyor ve anlaşılmaz 4xx hatalarına yol
  // açıyordu. Artık burada net bir hata fırlatılıyor.
  if (typeof data.task_id !== "string" || !data.task_id) {
    throw new ManusError("Manus görevi oluşturuldu ama API geçerli bir task_id döndürmedi.");
  }
  let taskUrl: string | undefined;
  if (typeof data.task_url === "string") {
    try {
      const parsed = new URL(data.task_url);
      if (parsed.protocol === "https:") taskUrl = parsed.toString();
    } catch {
      // Geçersiz/eksik URL owner DM'ine aktarılmaz.
    }
  }
  // URL yalnızca owner-only callback'e verilir; kanal çıktısına taşınmaz.
  return { taskId: data.task_id, taskUrl };
}

type TaskStatus = "running" | "stopped" | "waiting" | "error";

interface TaskProgress {
  status: TaskStatus;
  brief?: string;
  description?: string;
  waitingDescription?: string;
  waitingType?: string;
}

async function getTaskProgress(taskId: string): Promise<TaskProgress> {
  // Manus dokümantasyonu ilerleme ve durum için task.listMessages içindeki
  // status_update event'lerini polling etmeyi öneriyor. task.detail yalnızca
  // özet metadata verir ve ara ilerleme bilgisini taşımaz.
  const data = await manusFetch(
    `/task.listMessages?task_id=${encodeURIComponent(taskId)}&order=desc&limit=50`,
    { method: "GET" },
  );
  const messages: any[] = Array.isArray(data.messages) ? data.messages : [];
  const statusEvent = messages.find((msg) => msg?.status_update?.agent_status);
  if (statusEvent) {
    const update = statusEvent.status_update;
    return {
      status: update.agent_status as TaskStatus,
      brief: update.brief ? String(update.brief) : undefined,
      description: update.description ? String(update.description) : undefined,
      waitingDescription: update.status_detail?.waiting_description
        ? String(update.status_detail.waiting_description)
        : undefined,
      waitingType: update.status_detail?.waiting_for_event_type
        ? String(update.status_detail.waiting_for_event_type)
        : undefined,
    };
  }

  // İlk birkaç saniyede status_update gelmezse eski durum endpoint'ini
  // fallback olarak kullan; bu durumda da görev yanlışlıkla hata sayılmaz.
  const detail = await manusFetch(`/task.detail?task_id=${encodeURIComponent(taskId)}`, { method: "GET" });
  return { status: (detail.task?.status ?? "error") as TaskStatus };
}

export interface ManusAttachment {
  filename: string;
  url: string;
  contentType?: string;
}

interface AssistantMessageResult {
  content: string;
  attachments: ManusAttachment[];
}

async function getLastAssistantMessage(taskId: string): Promise<AssistantMessageResult | null> {
  const data = await manusFetch(
    `/task.listMessages?task_id=${encodeURIComponent(taskId)}&order=desc&limit=20`,
    { method: "GET" },
  );
  const messages: any[] = Array.isArray(data.messages) ? data.messages : [];
  for (const msg of messages) {
    if (msg?.assistant_message?.content || msg?.assistant_message?.attachments?.length) {
      const rawAttachments: any[] = Array.isArray(msg.assistant_message.attachments)
        ? msg.assistant_message.attachments
        : [];
      const attachments: ManusAttachment[] = rawAttachments
        .filter((a) => a?.url)
        .map((a) => ({
          filename: String(a.filename || "dosya"),
          url: String(a.url),
          contentType: a.content_type ? String(a.content_type) : undefined,
        }));
      return { content: String(msg.assistant_message.content || ""), attachments };
    }
  }
  return null;
}

export interface RunAgentResult {
  answer: string;
  attachments: ManusAttachment[];
}

/**
 * Bir Manus görevi oluşturur, tamamlanmasını bekler ve son asistan cevabını
 * döner. Görev "waiting" durumuna geçerse (ör. ek onay/soru gerekiyorsa)
 * bunu da bir hata olarak işaretleriz — Discord komutu tek seferlik bir
 * cevap beklediği için interaktif akışı desteklemiyoruz.
 *
 * onProgress: her poll turunda (durum "running" iken) çağrılır — çağıran
 * taraf bunu kullanarak kullanıcıya "hâlâ çalışıyor" gibi bir ilerleme
 * mesajı gösterebilir (ölü/asılı kalmış gibi görünmesin diye).
 */
export const MAX_DOWNLOADABLE_ATTACHMENT_BYTES = 8 * 1024 * 1024; // Discord'un varsayılan dosya limiti

/**
 * Manus'un döndürdüğü bir dosya URL'sini indirip Buffer olarak döner.
 * Dosya MAX_DOWNLOADABLE_ATTACHMENT_BYTES'tan büyükse veya indirme
 * başarısız olursa null döner — çağıran taraf bunu "eklenemedi" olarak
 * ele almalı, tüm görevi düşürmemeli.
 */
export async function downloadManusAttachment(attachment: ManusAttachment): Promise<Buffer | null> {
  // 🛠️ BUG FIX: eskiden attachment.url hiç doğrulanmadan fetch ediliyordu.
  // Metin içi linkler için zaten var olan https-only kontrolü (safeHttpsUrl)
  // dosya eklerine uygulanmıyordu — beklenmedik/bozuk bir API yanıtı iç ağ
  // adresine veya file:// gibi şemalara işaret ederse SSRF riski doğuruyordu.
  let parsed: URL;
  try {
    parsed = new URL(attachment.url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(attachment.url, { signal: controller.signal });
    if (!res.ok) return null;

    const contentLength = res.headers.get("content-length");
    if (contentLength && Number(contentLength) > MAX_DOWNLOADABLE_ATTACHMENT_BYTES) return null;

    const arrayBuffer = await res.arrayBuffer();
    if (arrayBuffer.byteLength > MAX_DOWNLOADABLE_ATTACHMENT_BYTES) return null;

    return Buffer.from(arrayBuffer);
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function runAgentTask(
  prompt: string,
  onProgress?: (elapsedMs: number, progress?: string) => void,
  onWaiting?: (detail: string, type?: string) => void | Promise<void>,
  onTaskCreated?: (taskUrl: string) => void | Promise<void>,
  attachments: TaskAttachmentInput[] = [],
): Promise<RunAgentResult> {
  const { taskId, taskUrl } = await createTask(prompt, attachments);
  if (taskUrl) await onTaskCreated?.(taskUrl);

  const startedAt = Date.now();
  const hasDeadline = MAX_WAIT_MS > 0;
  let lastWaitingNotice = "";
  // 🛠️ BUG FIX: "waiting" durumunda geçen süre deadline'dan düşülür. Eskiden
  // owner'ın Manus sohbetinde onay vermesini beklerken de sayaç işliyordu;
  // owner DM'i geç görürse görev GERÇEKTEN çalışmıyor olmasına rağmen "zaman
  // aşımına uğradı" hatasıyla düşüyordu. Artık yalnızca aktif çalışma süresi
  // (running) deadline'a sayılıyor.
  let waitingAccumulatedMs = 0;
  while (!hasDeadline || Date.now() - startedAt - waitingAccumulatedMs < MAX_WAIT_MS) {
    await sleep(POLL_INTERVAL_MS);
    const elapsed = Date.now() - startedAt - waitingAccumulatedMs;

    let progress: TaskProgress;
    try {
      progress = await getTaskProgress(taskId);
    } catch (err) {
      // task.detail geçici olarak başarısız oldu (retry'lar tükendi) —
      // görevi tamamen iptal etmek yerine bir sonraki tur tekrar deneriz,
      // MAX_WAIT_MS dolana kadar. Tek bir kontrol hatası tüm görevi
      // düşürmesin.
      onProgress?.(elapsed, "Manus API durum kontrolü geçici olarak başarısız oldu; yeniden denenecek.");
      continue;
    }

    const status = progress.status;
    const progressText = progress.brief || progress.description;
    if (status === "error") {
      throw new ManusError("Manus görevi bir hatayla sonuçlandı.");
    }
    if (status === "waiting") {
      waitingAccumulatedMs += POLL_INTERVAL_MS;
      const waitingDetail = progress.waitingDescription || progress.description || "Manus kullanıcı onayı veya ek bilgi bekliyor.";
      const waitingKey = `${progress.waitingType || "waiting"}:${waitingDetail}`;
      if (waitingKey !== lastWaitingNotice) {
        lastWaitingNotice = waitingKey;
        await onWaiting?.(waitingDetail, progress.waitingType);
      }
      onProgress?.(elapsed, `Onay/bilgi bekleniyor: ${waitingDetail}`);
      continue;
    }
    if (status === "stopped") {
      const result = await getLastAssistantMessage(taskId);
      if (!result || (!result.content && result.attachments.length === 0)) {
        throw new ManusError("Manus görevi tamamlandı ama bir cevap bulunamadı.");
      }
      return { answer: result.content, attachments: result.attachments };
    }

    // "running" ise son status_update özetini de Discord'a yansıt.
    onProgress?.(elapsed, progressText);
  }

  throw new ManusError(
    `Manus görevi zaman aşımına uğradı (${Math.round(MAX_WAIT_MS / 60_000)} dakika). ` +
      "Daha uzun görevler için MANUS_MAX_WAIT_MS değerini artırabilir veya 0 yapabilirsin.",
  );
}
