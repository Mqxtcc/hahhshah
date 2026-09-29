import fs from "node:fs";
import path from "node:path";
import { db } from "../db/index.js";
import { OWNER_ID } from "../config.js";
import { botSettingsTable } from "../db/schema.js";
import { eq } from "../db/jsonOrm.js";
import { generateWithGroq } from "./groq.js";

const SETTING_PREFIX = "mentionai:";
const CHANNEL_SETTING_PREFIX = "mentionai:channel:";
const MODEL_SETTING_KEY = "mentionai:model";
const RULES_SETTING_KEY = "mentionai:rules";
const DEFAULT_MODEL = "gpt-4o";
const MAX_QUERY_CHARS = 180;
const MAX_SEARCH_RESULTS = 5;
const MAX_SEARCH_CONTEXT_CHARS = 6_000;
const MAX_MEMORY_MESSAGES = 12; // 6 tur (user+assistant)
const MAX_DISCORD_MESSAGE_LENGTH = 1_900;
// Diğer JSON depolarla aynı kök: process.cwd()/data (Pterodactyl'da genelde /home/container/data)
const MEMORY_FILE = path.resolve(process.cwd(), "data/mentionai-memory.json");

const SYSTEM_PROMPT = `YETENEKLER:
- Gerektiğinde arka planda otomatik olarak web (DuckDuckGo) araması yapılır ve sonuçlar sana "ARAMA SONUÇLARI" bölümünde verilir; bu bilgiyi kendi bilgin gibi kullanabilirsin. Arama yapılmadıysa veya sonuç boşsa, güncel bilgiye erişimin olmadığını söyle.
- Kullanıcının gönderdiği görselleri görebiliyorsun.
- "SON KONUŞMA GEÇMİŞİ" varsa önceki mesajları hatırla; isim, tercih ve bağlamı koru. Kullanıcı "az önce ne demiştim" derse geçmişe bak.
- doğal cevap ver; geçmişi gereksiz yere tekrar etme.`;

async function getStoredRules(): Promise<string[]> {
  const rows = await db
    .select()
    .from(botSettingsTable)
    .where(eq(botSettingsTable.key, RULES_SETTING_KEY));
  const row = rows[0];
  if (!row?.value) return [];
  try {
    const parsed: unknown = JSON.parse(row.value);
    return Array.isArray(parsed)
      ? parsed
          .filter((rule): rule is string => typeof rule === "string")
          .slice(0, 20)
      : [];
  } catch {
    return [];
  }
}

async function saveStoredRules(rules: string[]): Promise<void> {
  await db
    .insert(botSettingsTable)
    .values({
      key: RULES_SETTING_KEY,
      value: JSON.stringify(rules),
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: botSettingsTable.key,
      set: { value: JSON.stringify(rules), updatedAt: new Date() },
    });
}

export async function getMentionAiRules(): Promise<string[]> {
  return getStoredRules();
}

export async function addMentionAiRule(rule: string): Promise<string[]> {
  const normalized = rule.trim().slice(0, 500);
  if (!normalized) return getStoredRules();
  const rules = await getStoredRules();
  if (rules.length >= 20) return rules;
  if (
    !rules.some(
      (item) =>
        item.toLocaleLowerCase("tr-TR") ===
        normalized.toLocaleLowerCase("tr-TR"),
    )
  ) {
    rules.push(normalized);
    await saveStoredRules(rules);
  }
  return rules;
}

export async function removeMentionAiRule(
  rule: string,
): Promise<{ removed: boolean; rules: string[] }> {
  const normalized = rule.trim().toLocaleLowerCase("tr-TR");
  const previous = await getStoredRules();
  const rules = previous.filter(
    (item) => item.toLocaleLowerCase("tr-TR") !== normalized,
  );
  if (rules.length !== previous.length) await saveStoredRules(rules);
  return { removed: rules.length !== previous.length, rules };
}

async function getSystemPrompt(): Promise<string> {
  const rules = await getStoredRules();
  if (rules.length === 0) return SYSTEM_PROMPT;
  return `${SYSTEM_PROMPT}\n\nOWNER TARAFINDAN EKLENEN EK KURALLAR:\n${rules.map((rule, index) => `${index + 1}. ${rule}`).join("\n")}`;
}

type SearchResult = { title: string; url: string; snippet: string };
type MemoryMessage = {
  role: "user" | "assistant";
  content: string;
  timestamp: string;
};
type MemoryStore = Record<string, MemoryMessage[]>;
export type MentionAiCodeFile = {
  name: string;
  content: string;
  isTypeScript?: boolean;
};

function settingKey(guildId: string): string {
  return `${SETTING_PREFIX}${guildId}`;
}

function channelSettingKey(guildId: string): string {
  return `${CHANNEL_SETTING_PREFIX}${guildId}`;
}

function memoryKey(guildId: string, userId: string): string {
  return `${guildId}:${userId}`;
}

/** Bellek kaynağı: önce RAM, disk yedek. Her process restart'ta diskten yüklenir. */
let memoryStoreCache: MemoryStore | null = null;

function loadMemoryStoreFromDisk(): MemoryStore {
  try {
    if (!fs.existsSync(MEMORY_FILE)) return {};
    const raw = fs.readFileSync(MEMORY_FILE, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return {};
    return parsed as MemoryStore;
  } catch (error) {
    console.warn("mentionai hafızası okunamadı:", error);
    return {};
  }
}

function getMemoryStore(): MemoryStore {
  if (!memoryStoreCache) memoryStoreCache = loadMemoryStoreFromDisk();
  return memoryStoreCache;
}

function writeMemoryStore(store: MemoryStore): void {
  memoryStoreCache = store;
  try {
    fs.mkdirSync(path.dirname(MEMORY_FILE), { recursive: true });
    const temporaryFile = `${MEMORY_FILE}.tmp`;
    fs.writeFileSync(temporaryFile, JSON.stringify(store, null, 2), "utf8");
    fs.renameSync(temporaryFile, MEMORY_FILE);
  } catch (error) {
    console.warn(
      `mentionai hafızası yazılamadı (${MEMORY_FILE}):`,
      error instanceof Error ? error.message : error,
    );
  }
}

function getMemory(guildId: string, userId: string): MemoryMessage[] {
  const value = getMemoryStore()[memoryKey(guildId, userId)];
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (item): item is MemoryMessage =>
        Boolean(item) &&
        (item.role === "user" || item.role === "assistant") &&
        typeof item.content === "string" &&
        item.content.trim().length > 0,
    )
    .slice(-MAX_MEMORY_MESSAGES);
}

// Konuşma belleği anahtar sayısı üst sınırı — guildId:userId çiftleri süresiz
// birikmesin diye en eski (son mesajı en eski olan) anahtarlar budanır.
const MAX_MEMORY_KEYS = 1_000;

function pruneMemoryStore(store: MemoryStore): void {
  const keys = Object.keys(store);
  if (keys.length <= MAX_MEMORY_KEYS) return;
  const byRecency = keys
    .map((key) => {
      const messages = store[key];
      const last = Array.isArray(messages) ? messages[messages.length - 1] : undefined;
      const ts = last && typeof last.timestamp === "string" ? Date.parse(last.timestamp) : 0;
      return { key, ts: Number.isNaN(ts) ? 0 : ts };
    })
    .sort((a, b) => b.ts - a.ts);
  for (const { key } of byRecency.slice(MAX_MEMORY_KEYS)) delete store[key];
}

function saveMemory(
  guildId: string,
  userId: string,
  userContent: string,
  assistantContent: string,
): void {
  const store = getMemoryStore();
  const key = memoryKey(guildId, userId);
  const previous = getMemory(guildId, userId);
  const next: MemoryMessage[] = [
    ...previous,
    {
      role: "user" as const,
      content: userContent.slice(0, 4_000),
      timestamp: new Date().toISOString(),
    },
    {
      role: "assistant" as const,
      content: assistantContent.slice(0, 4_000),
      timestamp: new Date().toISOString(),
    },
  ].slice(-MAX_MEMORY_MESSAGES);
  store[key] = next;
  pruneMemoryStore(store);
  writeMemoryStore(store);
}

function formatMemory(messages: MemoryMessage[]): string {
  if (messages.length === 0) return "";
  const lines = messages.map(
    (item) =>
      `${item.role === "user" ? "Kullanıcı" : "Asistan"}: ${item.content}`,
  );
  return `\n\nSON KONUŞMA GEÇMİŞİ (bu kullanıcıyla; devam ettir, çelişme):\n${lines.join("\n")}`;
}

const MAX_REASONING_CHARS = 1_500;

/** Modelin gerçek reasoning metnini Discord'un "-# " küçük yazı (subtext)
 * biçimine çevirir. Discord subtext satır satır çalışır, bu yüzden her
 * satırın başına "-# " eklenir. Aşırı uzun reasoning'i kısaltır. */
function formatAsDiscordSubtext(reasoning: string): string {
  const trimmed = reasoning.trim();
  const truncated =
    trimmed.length > MAX_REASONING_CHARS
      ? `${trimmed.slice(0, MAX_REASONING_CHARS).trimEnd()}…`
      : trimmed;
  return truncated
    .split("\n")
    .map((line) => (line.trim() ? `-# ${line.trim()}` : "-# \u200b"))
    .join("\n");
}

function removeUnwantedEmojis(content: string): string {
  return content
    .replace(/\p{Extended_Pictographic}/gu, "")
    .replace(/\uFE0F/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

export function splitMentionAiResponse(content: string): string[] {
  const normalized = content.trim();
  if (!normalized) return ["AI bir cevap üretemedi, tekrar dene."];
  const chunks: string[] = [];
  let remaining = normalized;
  while (remaining.length > MAX_DISCORD_MESSAGE_LENGTH) {
    let cut = remaining.lastIndexOf("\n", MAX_DISCORD_MESSAGE_LENGTH);
    if (cut < 900) cut = remaining.lastIndexOf(" ", MAX_DISCORD_MESSAGE_LENGTH);
    if (cut < 900) cut = MAX_DISCORD_MESSAGE_LENGTH;
    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

const CODE_EXTENSIONS: Record<string, string> = {
  py: "py",
  python: "py",
  js: "js",
  javascript: "js",
  ts: "ts",
  typescript: "ts",
  tsx: "tsx",
  jsx: "jsx",
  json: "json",
  html: "html",
  css: "css",
  sql: "sql",
  bash: "sh",
  sh: "sh",
  shell: "sh",
  java: "java",
  c: "c",
  cpp: "cpp",
  csharp: "cs",
  cs: "cs",
  go: "go",
  rust: "rs",
  rs: "rs",
  php: "php",
  rb: "rb",
  ruby: "rb",
  yaml: "yml",
  yml: "yml",
  xml: "xml",
};

export function extractMentionAiCodeFiles(content: string): {
  text: string;
  files: MentionAiCodeFile[];
} {
  const files: MentionAiCodeFile[] = [];
  let index = 0;
  const text = content
    .replace(
      /```([\w#+.-]+)\s*\n([\s\S]*?)```/g,
      (_match, language: string, code: string) => {
        const requestedExtension =
          CODE_EXTENSIONS[language.trim().toLowerCase()] ?? "txt";
        const extension = ["ts", "tsx"].includes(requestedExtension)
          ? "txt"
          : requestedExtension;
        index += 1;
        files.push({
          name: `mentionai-code-${index}.${extension}`,
          content: code.replace(/^\n|\n$/g, ""),
          isTypeScript: ["ts", "tsx", "typescript"].includes(
            language.trim().toLowerCase(),
          ),
        });
        return "";
      },
    )
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { text, files };
}

export const mentionAiEnabled = new Set<string>();
/** guildId → channelId. Kanal kısıtı yoksa key yoktur. */
export const mentionAiChannel = new Map<string, string>();
let mentionAiModel = DEFAULT_MODEL;
let loaded = false;
let loadingPromise: Promise<void> | null = null;

async function loadMentionAiSettings(): Promise<void> {
  const rows = await db.select().from(botSettingsTable);
  mentionAiEnabled.clear();
  mentionAiChannel.clear();
  for (const row of rows) {
    if (row.key === MODEL_SETTING_KEY && row.value.trim()) {
      mentionAiModel = row.value.trim();
    } else if (row.key.startsWith(CHANNEL_SETTING_PREFIX)) {
      const guildId = row.key.slice(CHANNEL_SETTING_PREFIX.length);
      const channelId = row.value.trim();
      if (guildId && channelId) mentionAiChannel.set(guildId, channelId);
    } else if (
      row.key.startsWith(SETTING_PREFIX) &&
      !row.key.startsWith(CHANNEL_SETTING_PREFIX) &&
      row.key !== MODEL_SETTING_KEY &&
      row.key !== RULES_SETTING_KEY &&
      row.value === "1"
    ) {
      mentionAiEnabled.add(row.key.slice(SETTING_PREFIX.length));
    }
  }
  loaded = true;
}

export async function ensureMentionAiLoaded(): Promise<void> {
  if (loaded) return;
  if (!loadingPromise)
    loadingPromise = loadMentionAiSettings().finally(() => {
      loadingPromise = null;
    });
  await loadingPromise;
}

export function isMentionAiEnabled(guildId: string): boolean {
  return mentionAiEnabled.has(guildId);
}

/** Belirtilmiş kanal kısıtı varsa o kanalın ID'sini döner, yoksa null. */
export function getMentionAiChannel(guildId: string): string | null {
  return mentionAiChannel.get(guildId) ?? null;
}

/**
 * MentionAI bu kanalda çalışabilir mi?
 * - Sistem kapalıysa hayır
 * - Kanal kısıtı yoksa her kanalda evet
 * - Kanal kısıtı varsa yalnızca o kanalda evet
 */
export function isMentionAiAllowedInChannel(
  guildId: string,
  channelId: string,
): boolean {
  if (!isMentionAiEnabled(guildId)) return false;
  const restricted = mentionAiChannel.get(guildId);
  if (!restricted) return true;
  return restricted === channelId;
}

/** MentionAI sohbet modeli. `!mentionai model` ile bağımsız seçilebilir. */
export function getMentionAiModel(): string {
  return mentionAiModel;
}

export async function setMentionAiModel(model: string): Promise<void> {
  const input = model.trim().slice(0, 160);
  const separator = input.indexOf(":");
  const rawProvider = separator > 0 ? input.slice(0, separator).toLocaleLowerCase("en-US") : "";
  const provider = rawProvider === "pix" ? "pixrouter" : rawProvider;
  const modelName = separator > 0 ? input.slice(separator + 1).trim() : "";
  if (!modelName || !["pixrouter", "gemini", "openrouter"].includes(provider)) {
    throw new Error("Kullanım: pix:model, gemini:model veya openrouter:model");
  }
  const normalized = `${provider}:${modelName}`;
  await db
    .insert(botSettingsTable)
    .values({ key: MODEL_SETTING_KEY, value: normalized })
    .onConflictDoUpdate({
      target: botSettingsTable.key,
      set: { value: normalized, updatedAt: new Date() },
    });
  // DB yazımı başarılıysa belleği güncelle (DB-önce; bkz. afk/store.ts).
  mentionAiModel = normalized;
}

export async function setMentionAiEnabled(
  guildId: string,
  enabled: boolean,
): Promise<void> {
  await db
    .insert(botSettingsTable)
    .values({ key: settingKey(guildId), value: enabled ? "1" : "0" })
    .onConflictDoUpdate({
      target: botSettingsTable.key,
      set: { value: enabled ? "1" : "0", updatedAt: new Date() },
    });
  // DB yazımı başarılıysa belleği güncelle (DB-önce; bkz. afk/store.ts).
  if (enabled) mentionAiEnabled.add(guildId);
  else mentionAiEnabled.delete(guildId);
}

/**
 * Kanal kısıtını ayarlar veya kaldırır (toggle).
 * - channelId verilirse o kanala kısıtlar
 * - null verilirse kısıtı kaldırır (tüm kanallar)
 * Aynı kanal tekrar verilirse de kaldırır (toggle).
 */
export async function setMentionAiChannel(
  guildId: string,
  channelId: string | null,
): Promise<{ channelId: string | null; toggledOff: boolean }> {
  const current = mentionAiChannel.get(guildId) ?? null;
  let next: string | null = channelId;
  let toggledOff = false;
  if (channelId && current === channelId) {
    next = null;
    toggledOff = true;
  }

  if (next) {
    await db
      .insert(botSettingsTable)
      .values({ key: channelSettingKey(guildId), value: next })
      .onConflictDoUpdate({
        target: botSettingsTable.key,
        set: { value: next, updatedAt: new Date() },
      });
  } else {
    await db
      .delete(botSettingsTable)
      .where(eq(botSettingsTable.key, channelSettingKey(guildId)));
  }
  // DB yazımı başarılıysa belleği güncelle (DB-önce; bkz. afk/store.ts).
  if (next) mentionAiChannel.set(guildId, next);
  else mentionAiChannel.delete(guildId);

  return { channelId: next, toggledOff };
}

function decodeHtml(value: string): string {
  return value
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

async function searchDuckDuckGo(query: string): Promise<SearchResult[]> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query.slice(0, MAX_QUERY_CHARS))}`;
  const response = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7",
    },
  });
  if (!response.ok) {
    console.warn(
      `mentionai araması patladı: status=${response.status}`,
    );
    return [];
  }
  const html = await response.text();
  const results: SearchResult[] = [];
  const pattern =
    /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  for (const match of html.matchAll(pattern)) {
    const urlValue = decodeURIComponent(match[1]).replace(/&amp;/g, "&");
    const redirect = urlValue.match(/uddg=([^&]+)/)?.[1];
    results.push({
      title: decodeHtml(match[2]),
      url: redirect ? decodeURIComponent(redirect) : urlValue,
      snippet: decodeHtml(match[3]),
    });
    if (results.length >= MAX_SEARCH_RESULTS) break;
  }
  if (results.length === 0) {
    console.warn(
      `mentionai arama sonuçsuz döndü (html: ${html.length})`,
    );
  }
  return results;
}

function shouldSearch(text: string): boolean {
  // \b Türkçe karakterlerde güvenilir değil; boşluk/baş-son sınırları kullan.
  return /(?:^|[\s,.:;!?])(ara|araştır|arastir|güncel|guncel|bugün|bugun|son dakika|haber|fiyat|kur|döviz|doviz|dolar|euro|altın|altin|borsa|hava|kimdir|nedir|ne zaman|kaynak|latest|news|search|price|weather|exchange rate)(?:\s|$|[!?.])/i.test(
    ` ${text} `,
  );
}

function formatSearchContext(results: SearchResult[]): string {
  if (!results.length) return "[DuckDuckGo araması sonuç vermedi.]";
  return results
    .map(
      (item, index) =>
        `${index + 1}. ${item.title}\nURL: ${item.url}\nÖzet: ${item.snippet}`,
    )
    .join("\n\n")
    .slice(0, MAX_SEARCH_CONTEXT_CHARS);
}

/** Model content içine sızmış thinking / -# satırlarını temizler. */
function stripReasoningArtifacts(content: string): string {
  let text = content
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<\/?think>/gi, "")
    .replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, "")
    .replace(/```(?:thinking|reasoning)[\s\S]*?```/gi, "");
  // Discord subtext satırları (-# ...) — model veya eski format sızıntısı
  text = text
    .split("\n")
    .filter((line) => !/^\s*-#\s/.test(line))
    .join("\n");
  return text.replace(/\n{3,}/g, "\n\n").trim();
}

export async function answerMentionAi(input: {
  guildId: string;
  userId: string;
  username?: string;
  prompt: string;
  repliedMessage?: string;
  imageUrls?: string[];
}): Promise<string> {
  const cleanPrompt = input.prompt.trim().slice(0, 4_000);
  const imageUrls = (input.imageUrls ?? []).slice(0, 4);
  if (!cleanPrompt && imageUrls.length === 0) return "Bir soru veya konu yaz.";
  const effectiveUserPrompt =
    cleanPrompt || "Bu görsele bak ve doğal bir şekilde ne düşündüğünü söyle.";
  const memory = getMemory(input.guildId, input.userId);
  let searchContext = "";
  if (shouldSearch(effectiveUserPrompt)) {
    try {
      searchContext = `\n\nDUCKDUCKGO ARAMA SONUÇLARI (yalnızca gerektiğinde kullan):\n${formatSearchContext(await searchDuckDuckGo(effectiveUserPrompt))}`;
    } catch (error) {
      console.warn("mentionai araması patladı:", error);
    }
  }
  const replyContext = input.repliedMessage
    ? `\n\nYANITLANAN BOT MESAJI:\n${input.repliedMessage.slice(0, 3_000)}`
    : "";
  try {
    const userIdentity = `\n\nMESAJI YAZAN KULLANICI:\n- Kullanıcı adı: ${input.username ?? "bilinmiyor"}\n- Discord kullanıcı ID'si: ${input.userId}\n- Bot sahibi mi: ${input.userId === OWNER_ID ? "Evet" : "Hayır"}`;
    // Vision: paylaşılan groq.ts'ye dokunmadan URL'leri metne ekle.
    const visionNote =
      imageUrls.length > 0
        ? `\n\nEKLENEN GÖRSELLER (URL):\n${imageUrls.map((u, i) => `${i + 1}. ${u}`).join("\n")}`
        : "";
    const effectivePrompt = `${userIdentity}${formatMemory(memory)}\n\n${effectiveUserPrompt}${replyContext}${searchContext}${visionNote}`;

    // Sohbet: MentionAI'ye özel model. `!mentionai model` ile seçilir.
    const raw = await generateWithGroq(
      await getSystemPrompt(),
      effectivePrompt,
      {
        model: getMentionAiModel(),
        maxTokens: 9_024,
        temperature: 0.55,
      },
    );
    const content = removeUnwantedEmojis(stripReasoningArtifacts(raw.trim()));
    saveMemory(input.guildId, input.userId, effectiveUserPrompt, content);
    return content;
  } catch (error) {
    if (
      error instanceof Error &&
      /API_KEY|tanımlı değil|tanimli degil/i.test(error.message)
    )
      return error.message.slice(0, 500);
    throw error;
  }
}

export function mentionAiErrorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message.slice(0, 500)
    : String(error).slice(0, 500);
}
