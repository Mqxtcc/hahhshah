// src/utils/aimlapi.ts
// AIML API (https://aimlapi.com) üzerinden model erişimi — OpenAI ile uyumlu
// /chat/completions şeması kullanır. Şu an için yalnızca Claude Fable 5.1
// modelini destekliyoruz (bkz. utils/modelSettings.ts MODEL_GROUPS.aimlapi).
//
// Gerekli .env anahtarı: AIMLAPI_API

import { getActiveModel } from "./modelSettings.js";

const AIMLAPI_URL = "https://api.aimlapi.com/v1/chat/completions";
const DEFAULT_MODEL = "claude-fable-5-1";
const MAX_TOKENS_PER_CALL = 16_384;
const REQUEST_TIMEOUT_MS = 120_000;

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

type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

function getApiKey(): string | undefined {
  return process.env.AIMLAPI_API?.trim() || undefined;
}

async function callOnce(apiKey: string, messages: ChatMessage[], model: string): Promise<string> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(AIMLAPI_URL, {
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
      throw new Error(`AIML API hatası (${res.status}): ${body.slice(0, 300)}`);
    }

    const data: unknown = await res.json();

    if (isRecord(data) && isRecord(data.error)) {
      const msg =
        typeof data.error.message === "string" ? data.error.message : JSON.stringify(data.error).slice(0, 300);
      throw new Error(`AIML API hata döndürdü: ${msg}`);
    }

    const choice = isRecord(data) && Array.isArray(data.choices) && isRecord(data.choices[0])
      ? data.choices[0]
      : undefined;
    const message = choice && isRecord(choice.message) ? choice.message : undefined;

    let text = "";
    if (message && typeof message.content === "string") {
      text = message.content;
    } else if (message && Array.isArray(message.content)) {
      text = message.content
        .map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : ""))
        .join("");
    }

    if (!text.trim()) {
      throw new Error("AIML API boş bir yanıt döndürdü.");
    }

    return text;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`Timeout (${REQUEST_TIMEOUT_MS / 1000}sn) — model çok uzun sürdü.`);
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * AIML API üzerinden seçili modele (varsayılan/owner tarafından ayarlanan
 * Claude Fable 5.1) istek atar. Anahtar .env'de AIMLAPI_API olarak
 * tanımlanmalı.
 */
export async function generateWithAimlapi(
  systemPrompt: string,
  userPrompt: string,
  modelOverride?: string,
): Promise<string> {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error("AIMLAPI_API tanımlı değil — AIML API atlanıyor.");
  }

  const model = modelOverride ?? DEFAULT_MODEL;
  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];

  try {
    return await callOnce(apiKey, messages, model);
  } catch (err) {
    if (err instanceof RateLimitError || err instanceof KeyDeniedError) {
      console.warn("aiml api patladı:", err.message);
    }
    throw err;
  }
}
