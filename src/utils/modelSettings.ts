// src/utils/modelSettings.ts
// !modeller komutu için: hangi AI sağlayıcısının hangi modeli kullandığını
// (Gemini / Groq / OpenRouter) tutan basit, JSON dosyasına kalıcı yazan
// bir ayar deposu. DB'ye YENİ bir tablo eklemek yerine bilinçli olarak düz
// bir JSON dosyası kullanıyoruz (data/model-settings.json) — az sayıda,
// nadiren değişen ve tek bir owner tarafından ayarlanan bir ayar için bu
// yeterli ve DB migrasyonu gerektirmiyor.
//
// Kullanıcı hiçbir zaman değiştirmezse dosya hiç oluşmaz ve tüm sağlayıcılar
// koddaki (mevcut/orijinal) varsayılan modelleriyle çalışmaya devam eder.

import fs from "node:fs";
import path from "node:path";
import { EMOJIS } from "./emojis.js";

export type ModelGroup = "gemini" | "groq" | "openrouter";

export interface ModelOption {
  /** API'ye gönderilen gerçek model adı/ID'si. */
  value: string;
  /** !modeller menüsünde gösterilen okunaklı isim. */
  label: string;
}

export interface ModelGroupInfo {
  label: string;
  emoji: string;
  /** Bu sağlayıcının orijinal/koddaki varsayılan modeli (kullanıcı hiç değiştirmezse bu kullanılır). */
  defaultModel: string;
  options: ModelOption[];
}

export const MODEL_GROUPS: Record<ModelGroup, ModelGroupInfo> = {
  gemini: {
    label: "Gemini",
    emoji: "✨",
    defaultModel: "gemini-3.5-flash",
    options: [
      { value: "gemini-3.5-flash", label: "Gemini 3.5 Flash" },
      { value: "gemini-3.6-flash", label: "Gemini 3.6 Flash" },
      { value: "gemini-3.5-flash-lite", label: "Gemini 3.5 Flash Lite" },
      { value: "gemini-3.1-flash-lite", label: "Gemini 3.1 Flash Lite" },
    ],
  },
  groq: {
    label: "Groq ve Diğerleri",
    emoji: EMOJIS.general,
    defaultModel: "openai/gpt-oss-120b",
    // NOT: Bu kategori artık tek sağlayıcı değil — Groq'un kendi modellerinin
    // yanında, aynı OpenAI-uyumlu şemayı konuşan başka ÜCRETSİZ sağlayıcıların
    // modelleri de burada. "sağlayıcı:model" önekli olanlar Groq'a değil o
    // sağlayıcıya gider (bkz. utils/groq.ts resolveProvider()). Gerekli .env
    // anahtarları:
    //   - Groq modelleri     -> GROQ_API_KEY_1     (zaten mevcut)
    //   - Cerebras modelleri -> CEREBRAS_API_KEY_1  (ücretsiz key: cloud.cerebras.ai)
    //   - NVIDIA modelleri   -> NVIDIA_API_KEY_1    (ücretsiz key: build.nvidia.com,
    //                                                 kredi kartı istemiyor)
    //
    // Mistral ve SambaNova buradan kaldırıldı: ikisi de artık gerçekten
    // ücretsiz bir katman sunmuyor (ücretli/kredi kartlı plan gerekiyor).
    // GitHub Models de 30 Temmuz 2026'da tamamen kapatıldı, yerine NVIDIA
    // NIM bağlandı.
    //
    // Groq'un tüm katalog listesinden yalnızca genel amaçlı, metin tabanlı
    // sohbet/üretim modelleri seçildi. Şunlar bilinçli olarak DIŞARIDA
    // bırakıldı çünkü bu botun kullandığı sohbet tamamlama (chat completion)
    // akışına uygun değiller:
    //   - meta-llama/llama-prompt-guard-2-22m / -86m  (sınıflandırıcı, sohbet üretmiyor)
    //   - openai/gpt-oss-safeguard-20b                (moderasyon/güvenlik modeli)
    //   - whisper-large-v3 / whisper-large-v3-turbo    (ses -> metin, chat değil)
    //   - canopylabs/orpheus-v1-english / -arabic-saudi (metin -> ses/TTS)
    options: [
      // --- Groq ---
      { value: "openai/gpt-oss-120b", label: "GPT-OSS 120B (Groq)" },
      { value: "openai/gpt-oss-20b", label: "GPT-OSS 20B (Groq)" },
      { value: "groq/compound", label: "Groq Compound" },
      { value: "groq/compound-mini", label: "Groq Compound Mini" },
      { value: "qwen/qwen3.8-27b", label: "Qwen 3.8 27B (Groq)" },
      // --- Cerebras: docs.cerebras.ai kataloğuna göre sadece "(Public)"
      // etiketli — yani ekstra kurulum gerektirmeyen, public endpoint'te
      // gerçekten çalışan modeller. Llama 4 Scout/Maverick, Llama 3.3 70B,
      // Llama 3.1 8B ve eski Qwen 3 32B/235B artık bu public listede değil
      // (dedicated/enterprise endpoint'e taşınmış veya kaldırılmış) — bu
      // yüzden hepsi çıkarıldı.
      { value: "cerebras:gpt-oss-120b", label: "GPT-OSS 120B (Cerebras)" },
      { value: "cerebras:gemma-4-31b", label: "Gemma 4 31B (Cerebras)" },
      { value: "cerebras:qwen-3.8-27b", label: "Qwen 3.8 27B (Cerebras)" },
      // --- NVIDIA NIM (ücretsiz, kredi kartı gerekmez) — sadece
      // build.nvidia.com kataloğunda "Free Endpoint" etiketi TEYİT EDİLMİŞ
      // modeller. Kimi K3 (2.8T) ve DeepSeek V4 Pro (550B sınıfı) sürekli
      // zaman aşımına uğradığı için (60 sn'lik istek limiti — bkz.
      // utils/groq.ts REQUEST_TIMEOUT_MS) çok büyük/yavaş modellerden
      // kaçınıldı, bu yüzden Nemotron 3 Ultra (550B) da aynı sebeple
      // listeye alınmadı. TTS/çeviri/güvenlik/OCR/embedding gibi sohbet-dışı
      // modeller ve DiffusionGemma gibi standart chat completion akışına
      // uymayan (diffusion tabanlı) modeller de bilinçli olarak dışarıda
      // bırakıldı.
      { value: "nvidia:openai/gpt-oss-20b", label: "GPT-OSS 20B (NVIDIA)" },
      { value: "nvidia:moonshotai/kimi-k3", label: "Kimi K3 (NVIDIA)" },
      { value: "nvidia:google/gemma-4-31b-it", label: "Gemma 4 31B (NVIDIA)" },
      { value: "openrouter:google/gemma-4-26b-a4b-it:free", label: "Gemma 4 26B (OpenRouter)" },
      { value: "gemini:gemini-3.1-flash-lite", label: "Gemini 3.1 Flash Lite" },
      // PixRouter / New API — OpenAI uyumlu gateway.
      { value: "pixrouter:gpt-4o-mini", label: "GPT-4o Mini (PixRouter)" },
      { value: "pixrouter:gpt-4o", label: "ChatGPT 4o" },
      // --- OpenRouter (ücretsiz) — "openrouter:" öneki Groq'a değil
      // OpenRouter'a gider. Anahtar: OP_KOD_1..6.
      { value: "openrouter:deepseek/deepseek-v4-flash-0731:free", label: "DeepSeek V4 Flash Free (OpenRouter)" },
      { value: "openrouter:z-ai/glm-5.2:free", label: "GLM 5.2 Free (OpenRouter)" },
      { value: "pixrouter:openai/gpt-oss-20b", label: "gpt oss 20b pix" },
    ],
  },
  openrouter: {
    label: "OpenRouter (kod araçları)",
    emoji: "🧩",
    // Kod yazma ve agentic yazılım geliştirme için varsayılan model.
    defaultModel: "openrouter:nvidia/nemotron-3-ultra-550b-a55b:free",
    options: [
      // OpenRouter API kataloğundaki 2026-09 ücretsiz modelleri.
      // Embedding ve content-safety gibi chat completion akışına uygun
      // olmayan modeller bilinçli olarak dışarıda bırakıldı.
      { value: "nex-agi/nex-n2.5-mini:free", label: "Nex-N2.5 Mini — kod ajanı" },
      { value: "nvidia:moonshotai/kimi-k3", label: "Kimi K3 (NVIDIA)" },
      { value: "nex-agi/nex-n2.5-pro:free", label: "Nex-N2.5 Pro — kod ajanı" },
      { value: "inclusionai/ling-3.0-flash-sante:free", label: "Ling 3.0 Flash Sante" },
      { value: "inclusionai/ling-3.0-flash-fin:free", label: "Ling 3.0 Flash Fin" },
      { value: "dots-studio/dots-3-note-preview:free", label: "Dots3-Note Preview" },
      { value: "liquid/lfm-2.5-2.6b:free", label: "LFM 2.5 2.6B" },
      { value: "nvidia/nemotron-3.5-lightning:free", label: "Nemotron 3.5 Lightning — hızlı kod" },
      { value: "poolside/laguna-s-2.1:free", label: "Laguna S 2.1 — kod ajanı" },
      { value: "poolside/laguna-xs-2.1:free", label: "Laguna XS 2.1 — hızlı kod ajanı" },
      { value: "cohere/north-mini-code:free", label: "North Mini Code" },
      { value: "nvidia/nemotron-3-ultra-550b-a55b:free", label: "Nemotron 3 Ultra — reasoning" },
      { value: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free", label: "Nemotron 3 Nano Omni — reasoning" },
      { value: "google/gemma-4-26b-a4b-it:free", label: "Gemma 4 26B (Google)" },
      { value: "google/gemma-4-31b-it:free", label: "Gemma 4 31B (Google)" },
      { value: "nvidia/nemotron-3-super-120b-a12b:free", label: "Nemotron 3 Super — kod/agent" },
      // Doğrudan Groq — groq: öneki kod yönlendiricisinde Groq'a gider.
      { value: "groq:openai/gpt-oss-120b", label: "GPT-OSS 120B (Groq)" },
      { value: "groq:qwen/qwen3.6-27b", label: "Qwen 3.6 27B (Groq)" },
      { value: "groq:qwen/qwen3.8-27b", label: "Qwen 3.8 27B (Groq)" },
      // Gemini kod araçları için ayrı seçim; genel Gemini ayarını etkilemez.
      { value: "gemini:gemini-3.5-flash", label: "Gemini 3.5 Flash (kod)" },
      { value: "gemini:gemini-3.1-pro-preview", label: "Gemini 3.1 Pro (kod)" },
      { value: "gemini:gemini-3.6-flash", label: "Gemini 3.6 Flash (kod)" },
      // Doğrudan AIML API — aimlapi: öneki kod yönlendiricisinde AIML API'ye
      // gider (bkz. utils/codeModel.ts, utils/aimlapi.ts). Anahtar: AIMLAPI_API.
      { value: "aimlapi:claude-fable-5-1", label: "Claude Fable 5.1 (AIML API)" },
      // PixRouter üzerinden kod üretimi için OpenAI uyumlu model.
      { value: "pixrouter:openrouter/pareto-code", label: "Claude 4.5 Sonnet" },
      { value: "pixrouter:openrouter/auto", label: "Openrouter, Auto" },
    ],
  },};

const DATA_FILE = path.resolve(process.cwd(), "data/model-settings.json");

type StoredSettings = Partial<Record<ModelGroup, string>>;

let cache: StoredSettings | null = null;

function isKnownGroup(value: string): value is ModelGroup {
  return value === "gemini" || value === "groq" || value === "openrouter";
}

function isValidOption(group: ModelGroup, model: string): boolean {
  return MODEL_GROUPS[group].options.some((opt) => opt.value === model);
}

function loadFromDisk(): StoredSettings {
  if (cache) return cache;
  try {
    if (!fs.existsSync(DATA_FILE)) {
      cache = {};
      return cache;
    }
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, "utf8")) as unknown;
    const result: StoredSettings = {};
    if (raw && typeof raw === "object") {
      for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
        if (isKnownGroup(key) && typeof value === "string" && isValidOption(key, value)) {
          result[key] = value;
        }
      }
    }
    cache = result;
  } catch (err) {
    console.error("model-settings.json okunamadı, varsayılanlarla devam:", err);
    cache = {};
  }
  return cache;
}

function atomicWriteSync(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content, "utf8");
  fs.renameSync(tmp, file);
}

function persist(settings: StoredSettings): void {
  try {
    // Atomik yazma (jsonOrm.atomicWriteSync ile aynı desen): kill ortasında
    // bozuk JSON kalmaz, dosya ya eski ya yeni haliyle durur.
    atomicWriteSync(DATA_FILE, JSON.stringify(settings, null, 2));
  } catch (err) {
    console.error("model-settings.json yazılamadı:", err);
    throw err;
  }
}

/** O anda aktif olan modeli döner (owner ayarlamadıysa koddaki varsayılan). */
export function getActiveModel(group: ModelGroup): string {
  const settings = loadFromDisk();
  return settings[group] ?? MODEL_GROUPS[group].defaultModel;
}

/** Owner tarafından ayarlanmış (varsayılandan farklı) bir model var mı? */
export function hasOverride(group: ModelGroup): boolean {
  return loadFromDisk()[group] !== undefined;
}

/** Bir sağlayıcı için aktif modeli değiştirir ve JSON dosyasına kalıcı yazar. */
export function setActiveModel(group: ModelGroup, model: string): void {
  if (!isValidOption(group, model)) {
    throw new Error(`Geçersiz model: ${group} için "${model}" desteklenmiyor.`);
  }
  const settings = { ...loadFromDisk() };
  settings[group] = model;
  persist(settings);
  cache = settings;
}

/** Bir sağlayıcıyı koddaki orijinal varsayılan modele geri döndürür. */
export function resetActiveModel(group: ModelGroup): void {
  const settings = { ...loadFromDisk() };
  delete settings[group];
  persist(settings);
  cache = settings;
}
