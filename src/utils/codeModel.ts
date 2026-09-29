// src/utils/codeModel.ts
// !kod-yaz / !kod-duzelt / !kod-analiz / !kod-test için ortak model seçici.
//
// Ana model: OpenRouter üzerinden MiniMax M3 (free) — bkz. utils/openrouter.ts
// Yanıt alınamazsa (anahtar yok, rate limit, ağ hatası vb.): Gemini'ye düşer
// — bkz. utils/gemini.ts. Böylece bu dört komut için tek bir davranış
// tanımlanmış olur; hangi modelin cevap verdiği çağıran tarafa (embed'de
// göstermek için) `model` alanıyla döner.
//
// generateCodeText(), buna ek olarak bir "beklenen dil" doğrulaması yapar:
// model, örneğin TypeScript istendiğinde düz JavaScript döndürürse (gerçekte
// yaşanmış bir hata), bu bariz uyumsuzluk yakalanır ve TEK SEFERLİK bir
// düzeltme denemesiyle modele "bu yanlış dildeydi, sadece X dilinde yeniden
// yaz" diyerek tekrar sorulur. Kusursuz bir dil tespiti değildir (imkansız),
// sadece somut/bariz karışıklıkları yakalamayı hedefler — bkz. utils/langs.ts.

import { generateWithGemini } from "./gemini.js";
import { generateWithOpenRouter } from "./openrouter.js";
import { generateWithGroq } from "./groq.js";
import { generateWithAimlapi } from "./aimlapi.js";
import { generateWithPixRouter } from "./pixrouter.js";
import { extractFirstCodeBlock } from "./codeFiles.js";
import { validateLanguage } from "./langs.js";
import { getActiveModel, MODEL_GROUPS } from "./modelSettings.js";

export interface CodeModelResult {
  text: string;
  model: string;
}

// Model etiketi artık sabit değil — !modeller ile hangi OpenRouter/Gemini
// modeli seçiliyse (bkz. utils/modelSettings.ts) embed'de o gösterilir.
function labelFor(group: "openrouter" | "gemini", model: string): string {
  const option = MODEL_GROUPS[group].options.find((opt) => opt.value === model);
  return option?.label ?? model;
}

// "Kod modeli" (!modeller > Kod Araçları menüsü) artık sadece OpenRouter
// modelleri değil, Gemini 3.5/3.6 Flash gibi Gemini modellerini de
// seçenek olarak sunabiliyor — bkz. utils/modelSettings.ts'teki
// "gemini:<model>" önekli seçenekler. groq grubundaki cerebras:/nvidia:
// önek sistemiyle aynı yaklaşım.
const GEMINI_PREFIX = "gemini:";
const GROQ_PREFIX = "groq:";
const NVIDIA_PREFIX = "nvidia:";
const AIMLAPI_PREFIX = "aimlapi:";
const PIXROUTER_PREFIX = "pixrouter:";
function geminiOverrideFor(codeModelValue: string): string | null {
  return codeModelValue.startsWith(GEMINI_PREFIX) ? codeModelValue.slice(GEMINI_PREFIX.length) : null;
}

export interface GenerateForCodeOptions {
  /** PixRouter'a özel: tek kelimelik sınıflandırma gibi hafif istekler için
   * daha kısa token/süre bütçesi kullanmayı sağlar (bkz. detectAutoLangKey). */
  maxTokens?: number;
  pixrouterTotalTimeoutMs?: number;
}

export async function generateForCode(
  systemPrompt: string,
  userPrompt: string,
  opts: GenerateForCodeOptions = {},
): Promise<CodeModelResult> {
  const selected = getActiveModel("openrouter");
  const geminiOverride = geminiOverrideFor(selected);

  if (selected.startsWith(GROQ_PREFIX)) {
    const text = await generateWithGroq(systemPrompt, userPrompt, { model: selected.slice(GROQ_PREFIX.length), maxTokens: 16_384 });
    return { text, model: `${labelFor("openrouter", selected)} (Groq)` };
  }

  if (selected.startsWith(NVIDIA_PREFIX)) {
    try {
      const text = await generateWithGroq(systemPrompt, userPrompt, {
        model: selected,
        maxTokens: 16_384,
      });
      return { text, model: `${labelFor("openrouter", selected)} (NVIDIA)` };
    } catch (err) {
      console.warn("nvidia kod modeli patladı, openrouter'a düşüyorum:", err instanceof Error ? err.message : err);
      const fallbackModel = MODEL_GROUPS.openrouter.defaultModel;
      const text = await generateWithOpenRouter(systemPrompt, userPrompt, fallbackModel);
      return { text, model: `${labelFor("openrouter", fallbackModel)} (fallback)` };
    }
  }

  // Seçili "kod modeli" AIML API üzerinden Claude Fable 5.1 ise doğrudan
  // AIML API'yi çağır (bkz. utils/aimlapi.ts, anahtar: AIMLAPI_API). Sadece
  // istek başarısız olursa (anahtar yok, rate limit, ağ hatası vb.)
  // OpenRouter'ın gerçek varsayılan modeline düşülür.
  if (selected.startsWith(AIMLAPI_PREFIX)) {
    try {
      const text = await generateWithAimlapi(systemPrompt, userPrompt, selected.slice(AIMLAPI_PREFIX.length));
      return { text, model: `${labelFor("openrouter", selected)} (AIML API)` };
    } catch (err) {
      console.warn(`aiml kod modeli patladı, openrouter'a düşüyorum:`, err instanceof Error ? err.message : err);
      const fallbackModel = MODEL_GROUPS.openrouter.defaultModel;
      const text = await generateWithOpenRouter(systemPrompt, userPrompt, fallbackModel);
      return { text, model: `${labelFor("openrouter", fallbackModel)} (fallback)` };
    }
  }

  if (selected.startsWith(PIXROUTER_PREFIX)) {
    try {
      const result = await generateWithPixRouter(systemPrompt, userPrompt, {
        model: selected.slice(PIXROUTER_PREFIX.length),
        maxTokens: opts.maxTokens ?? 32_768,
      });
      // openrouter/auto gibi yönlendirmelerde API, isteği gerçekten karşılayan
      // modelin slug'ını (servedModel) döner — embed'de kodu yazan ASIL model
      // görünsün diye o kullanılır. Ağ geçidi bu alanı iletmediyse seçili
      // model etiketine düşülür; asla uydurma model adı yazılmaz.
      const servedModel = result.servedModel;
      return {
        text: result.content,
        model: servedModel
          ? `${servedModel} (PixRouter)`
          : `${labelFor("openrouter", selected)} (PixRouter)`,
      };
    } catch (pixrouterErr) {
      const pixrouterDetail = pixrouterErr instanceof Error ? pixrouterErr.message : String(pixrouterErr);
      console.warn("pixrouter kod modeli patladı, openrouter'a düşüyorum:", pixrouterDetail);
      const fallbackModel = MODEL_GROUPS.openrouter.defaultModel;
      try {
        const text = await generateWithOpenRouter(systemPrompt, userPrompt, fallbackModel);
        return { text, model: `${labelFor("openrouter", fallbackModel)} (fallback)` };
      } catch (fallbackErr) {
        // Fallback de başarısız olursa PixRouter'ın asıl hatasını KAYBETMEDEN
        // ikisini birden fırlat — eskiden burada sadece fallback'in (alakasız
        // görünebilen) hatası kullanıcıya ulaşıyor, PixRouter'ın gerçek sebebi
        // sadece console.warn'da kalıyordu.
        const fallbackDetail = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
        throw new Error(`PixRouter başarısız (${pixrouterDetail}); OpenRouter fallback de başarısız (${fallbackDetail}).`);
      }
    }
  }

  // Seçili "kod modeli" bir Gemini modeliyse (ör. Gemini 3.6 Flash),
  // OpenRouter'a hiç gitmeden doğrudan Gemini'yi çağır. Sadece Gemini
  // isteğinin kendisi başarısız olursa (kota, ağ hatası vb.) OpenRouter'ın
  // GERÇEK varsayılan modeline (MiniMax M3) düşülür — "gemini:..." değeri
  // asla OpenRouter'a model adı olarak gönderilmez.
  if (geminiOverride) {
    try {
      const text = await generateWithGemini(systemPrompt, userPrompt, geminiOverride);
      return { text, model: labelFor("openrouter", selected) };
    } catch (err) {
      console.warn(`${geminiOverride} kod modeli patladı, openrouter'a düşüyorum:`, err instanceof Error ? err.message : err);
      const fallbackModel = MODEL_GROUPS.openrouter.defaultModel;
      const text = await generateWithOpenRouter(systemPrompt, userPrompt, fallbackModel);
      return { text, model: `${labelFor("openrouter", fallbackModel)} (fallback)` };
    }
  }

  try {
    const text = await generateWithOpenRouter(systemPrompt, userPrompt);
    return { text, model: `${labelFor("openrouter", selected)} (OpenRouter)` };
  } catch (err) {
    console.warn("openrouter patladı, gemini'ye düşüyorum:", err instanceof Error ? err.message : err);
    const text = await generateWithGemini(systemPrompt, userPrompt);
    return { text, model: `${labelFor("gemini", getActiveModel("gemini"))} (fallback)` };
  }
}

export interface CodeGenOptions extends GenerateForCodeOptions {
  /** Kanonik dil anahtarı (bkz. utils/langs.ts LangInfo.key). Verilmezse doğrulama atlanır. */
  expectedLangKey?: string | null;
  /** Hata mesajında/düzeltme isteminde kullanılacak insan-okunur dil adı. */
  expectedLabel?: string;
  /** İlk kod bloğunu bulmayı hızlandırmak için markdown fence adı (ör. "typescript"). */
  fence?: string;
}

export interface CodeGenResult extends CodeModelResult {
  /** Beklenen dille bariz bir uyumsuzluk yakalanıp ikinci bir deneme yapıldıysa true. */
  retried: boolean;
}

/**
 * generateForCode()'u sarar ve isteğe bağlı olarak çıktının beklenen dilde
 * olup olmadığını denetler. Uyumsuzluk bulunursa modele TEK SEFER daha,
 * hatayı açıkça belirten güçlendirilmiş bir istekle sorar. İkinci deneme de
 * uyuşmasa bile onu (en iyi çaba olarak) döner — sonsuz döngüye girilmez.
 */
export async function generateCodeText(
  systemPrompt: string,
  userPrompt: string,
  opts: CodeGenOptions = {},
): Promise<CodeGenResult> {
  const forwardedOpts: GenerateForCodeOptions = { maxTokens: opts.maxTokens, pixrouterTotalTimeoutMs: opts.pixrouterTotalTimeoutMs };
  const first = await generateForCode(systemPrompt, userPrompt, forwardedOpts);

  if (!opts.expectedLangKey) {
    return { ...first, retried: false };
  }

  const firstBlock = extractFirstCodeBlock(first.text, opts.fence);
  if (!firstBlock || validateLanguage(firstBlock, opts.expectedLangKey)) {
    return { ...first, retried: false };
  }

  const label = opts.expectedLabel ?? opts.expectedLangKey;
  console.warn(`üretilen kod ${label} gibi durmuyor, düzeltmeyi deniyorum...`);

  const correctionPrompt =
    `${userPrompt}\n\n` +
    `⚠️ ÖNEMLİ DÜZELTME: Önceki cevabın "${label}" dilinde DEĞİLDİ — yanlış dilde ya da yanlış söz dizimiyle ` +
    `yazılmıştı. Bu sefer KESİNLİKLE ve SADECE "${label}" dilinin gerçek söz dizimini kullanarak (gerekiyorsa tip ` +
    `anotasyonları, o dile özgü anahtar kelimeler, standart kütüphane çağrıları vb. dahil) baştan yaz. Başka bir ` +
    `dile ASLA geçme, bu bir hatadır.`;

  const second = await generateForCode(systemPrompt, correctionPrompt, forwardedOpts);
  return { ...second, retried: true };
}
