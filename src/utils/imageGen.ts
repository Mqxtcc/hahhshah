import { generateCloudflareImage } from "./cloudflareAi.js";
import { generateImageWithPixRouter } from "./pixrouter.js";
import { getPixRouterImageModel } from "./imageModelSettings.js";

// Görsel üretim zinciri (prompt zenginleştirme ciz.ts'te enrichDrawPrompt ile
// zaten yapılıyor: 1 = Groq analiz + prompt):
//   2) Cloudflare Workers AI
//   3) Cloudflare başarısız olursa -> PixRouter (!görsel ile seçilen model,
//      varsayılan firefly-image-5)

export type ImageProvider = "cloudflare" | "pixrouter";

export interface GeneratedImage {
  buffer: Buffer;
  extension: string;
  provider: ImageProvider;
  model: string;
  /** PixRouter'a düşüldüyse Cloudflare'in neden başarısız olduğu. */
  fallbackReason?: string;
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function generateImage(prompt: string): Promise<GeneratedImage> {
  let cloudflareError: unknown;
  try {
    const result = await generateCloudflareImage(prompt);
    return { ...result, provider: "cloudflare" };
  } catch (err) {
    cloudflareError = err;
    console.warn("çiz: cloudflare patladı, pixrouter deneniyor:", msg(err));
  }

  const pixModel = getPixRouterImageModel();
  try {
    const result = await generateImageWithPixRouter(prompt, pixModel);
    return {
      ...result,
      provider: "pixrouter",
      fallbackReason: msg(cloudflareError),
    };
  } catch (pixError) {
    console.error("çiz: pixrouter da patladı:", msg(pixError));
    throw new Error(
      `Cloudflare: ${msg(cloudflareError)}\nPixRouter (${pixModel}): ${msg(pixError)}`,
    );
  }
}
